//! The terminal's LOCAL outbox drain — claim, complete, release.
//!
//! WHAT THIS MODULE IS ────────────────────────────────────────────────────────
//! `sync_outbox` (0001_init.sql) is the write-ahead log of everything this
//! terminal promised to send upstream. Checkout writes the order and its outbox
//! event in ONE transaction, so the event exists exactly when the sale does.
//! This module is the state machine that walks those rows forward:
//!
//!   pending ──claim_ready──▶ in_flight ──mark_done──▶ done
//!                              │
//!                              ├──retry_later────▶ pending          (transient)
//!                              └──fail_permanent─▶ failed_permanent
//!
//! ── THE TWO VOCABULARIES ARE NOT THE SAME, AND MIXING THEM IS THE BUG ────────
//! There are two outbox state machines in this repo and they deliberately use
//! DIFFERENT words:
//!
//!   * THIS table (terminal): `pending | in_flight | done | failed_permanent`
//!     — lowercase, pinned by a CHECK at 0001_init.sql:403. It answers
//!     *"has my terminal handed this to the network?"*
//!   * The SERVER's (`internal/sync/domain/outbox.go`):
//!     `PENDING | IN_FLIGHT | ACKNOWLEDGED | CONFLICT_HELD` — UPPERCASE. It
//!     answers *"has the server durably accepted it?"*
//!
//! A row can be `done` here and still `IN_FLIGHT` there, because a 2xx the
//! terminal never received is indistinguishable from a crash. Every statement
//! below uses the lowercase terminal vocabulary: writing `IN_FLIGHT` here would
//! violate the CHECK outright and fail at runtime.
//!
//! ── WHY THE IDEMPOTENCY KEY IS NOT HASHED HERE ──────────────────────────────
//! Each claimed event carries its `idempotency_key` verbatim. It is NOT a
//! SHA-256 digest, despite the server column being named `idempotency_key_hash`.
//! `services/api-backend/README.md` is explicit:
//!
//!   > Keys are stored **hashed** (SHA-256 over branch ‖ key).
//!
//! ...and that hashing is done by the SERVER, on ingest. The terminal's job is
//! to send the raw key it stored. Hashing here as well would send a hash of a
//! hash: the server's `SHA-256(branch ‖ key)` would never match what it received,
//! so every replay would look like a brand-new event and the duplicate-order
//! interceptor would stop working silently. The terminal-side guarantee is
//! already covered by `idempotency_key TEXT NOT NULL UNIQUE`.
//!
//! ── WHERE THE BATCH ACTUALLY GOES ───────────────────────────────────────────
//! The transport is a closure, so this module holds no HTTP client and the state
//! machine is testable against a real migrated database with no socket. The
//! implementation that speaks `POST /api/v1/sync/push` lives in
//! [`crate::sync_http`]; wiring the two together happens in the composition root.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::Serialize;
use tauri::Manager;

use crate::AppState;

/// Backoff parameters for the exponential retry delay.
///
/// The delay is `BASE * 2^(attempt_count - 1)`, capped at `CEILING`:
/// 30s, 60s, 120s, 240s, 300s, 300s, … for attempts 1, 2, 3, 4, 5, 6, ….
///
/// The ceiling caps how long a row WAITS, never how many times it is TRIED:
/// recoverable failures retry indefinitely. Only a per-command `Rejected`
/// ends a row, and that is a decision about the sale, not about the network.
pub const BACKOFF_BASE_SECONDS: i64 = 30;
pub const BACKOFF_CEILING_SECONDS: i64 = 300;

/// How long to wait before the delivery AFTER `attempt_count`.
///
/// This is the per-ROW half of the retry schedule: callers pass the row's own
/// `attempt_count`, never a batch-wide constant. Two rows drained in the same
/// tick therefore get two different delays — a row that has already failed
/// three times waits longer than its neighbour that failed once.
///
/// Overflow-safe without any checked-math ceremony: `30 * 2^4` is already 480,
/// past the 300s ceiling, so every attempt from the fifth onward is the ceiling
/// and the exponent is never computed. Evaluating `2^attempt_count` first and
/// clamping after would overflow `i64` on a row that has been retrying for a
/// few weeks — and an overflow in the drain would panic, not degrade.
pub fn backoff_seconds(attempt_count: i64) -> i64 {
  // A row that has never been delivered (0), or has just failed its first
  // attempt (1), waits the base delay. Never zero: re-claiming instantly would
  // spin a row that cannot have become deliverable in zero elapsed time.
  if attempt_count <= 1 {
    return BACKOFF_BASE_SECONDS;
  }
  if attempt_count >= 5 {
    return BACKOFF_CEILING_SECONDS;
  }
  // attempt_count is 2..=4 here, so the shift is at most 3 and cannot overflow.
  let delay = BACKOFF_BASE_SECONDS << (attempt_count - 1);
  delay.min(BACKOFF_CEILING_SECONDS)
}

/// The instant THIS row should be retried, in the schema's ISO-8601 `...Z`.
///
/// `now` is a parameter rather than a second clock read so that the schedule is
/// testable at a fixed instant, and so a drain reuses the `now` it was already
/// given instead of reading a slightly later clock mid-tick.
pub fn exponential_backoff_next_attempt(now: &str, attempt_count: i64) -> String {
  add_seconds(now, backoff_seconds(attempt_count))
}

/// One event the drain has claimed from the outbox.
///
/// The pairing of `payload` with `idempotency_key` IS the binding the transport
/// needs: the key travels with the bytes it belongs to, so a retry of this same
/// delivery presents the same key and the server returns the ORIGINAL response
/// instead of recomputing one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaimedEvent {
  /// `sync_outbox.sequence` — the strict local drain order. Order deliveries by
  /// this; `id` is the aggregate-facing identifier.
  pub sequence: i64,
  /// `sync_outbox.id` — client-generated UUIDv7.
  pub id: String,
  /// The RAW replay key. Send it as-is — see the module header.
  pub idempotency_key: String,
  /// The closed vocabularies `contracts/openapi.yaml` requires on every
  /// command. Carried through unchanged: re-deriving them here would be a
  /// second copy of a `CHECK` constraint the schema already enforces, and the
  /// two copies would drift the first time a vocabulary gained a value.
  pub aggregate_type: String,
  pub aggregate_id: String,
  pub event_type: String,
  pub action: String,
  /// The JSON body, exactly as checkout wrote it.
  pub payload: String,
  /// `attempt_count` AFTER this claim, so the first delivery reports 1 and a
  /// test can assert the counter without re-reading the row.
  pub attempt_count: i64,
}

/// What the server did with ONE command.
///
/// `contracts/openapi.yaml` defines exactly three, and the middle one is the
/// trap: `Duplicate` is a SUCCESS, not a failure. It means this event's
/// idempotency key was already applied — the normal outcome of a retry after a
/// response lost in flight. Treating it as a failure makes the terminal retry a
/// command the server already has, forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandOutcome {
  /// Newly applied.
  Applied,
  /// Already applied under this idempotency key. Counts as done.
  Duplicate,
  /// PERMANENT refusal. Retrying it unchanged will fail identically.
  Rejected,
}

/// One per-command result, correlated back to the event by `id`.
///
/// Correlation is by `id` and never by array index: the contract states the
/// results are "positional-by-`id`", because a terminal drains concurrently and
/// index `n` of the request is not guaranteed to come back at index `n`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
  /// The `sync_outbox.id` this result belongs to.
  pub event_id: String,
  pub outcome: CommandOutcome,
  /// The server's `error_message`, present only for `Rejected`. Shown to a
  /// shift lead — never parsed, per the contract's own note on `message`.
  pub error: Option<String>,
}

/// The result of pushing one batch.
///
/// NOT one outcome per command: `200` does not mean the batch was applied, it
/// means the ENVELOPE was well-formed. A single `Rejected` command inside a
/// successful batch is the case this type exists to keep visible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchOutcome {
  /// 2xx. Per-command results. An event missing from `results` is NOT assumed
  /// to have succeeded — see [`drain_tick`].
  Processed(Vec<CommandResult>),
  /// The batch may well have been applied but we cannot prove it: a timeout, a
  /// connection reset, a 5xx, or a response we could not read. Retry the
  /// INTACT batch — the idempotency key is what makes that safe.
  Retryable { reason: String },
  /// The server refused the envelope itself (4xx: no Idempotency-Key, no
  /// terminal, unparseable body). Nothing was applied.
  ///
  /// Retried anyway rather than failed permanently: a malformed envelope is
  /// this CLIENT's bug, and a client bug fixed by the next app update must not
  /// be able to strand a shift's real sales in `failed_permanent`.
  Refused { reason: String },
}

/// Atomically advance every READY row from `pending` to `in_flight`.
///
/// "Ready" is `status = 'pending' AND next_attempt_at <= now`, ordered by
/// `sequence` — the exact scan the schema documents at 0001_init.sql:432,
/// served by `idx_sync_outbox_drain`.
///
/// CLAIM IS A CAS, NOT A READ-THEN-WRITE ──────────────────────────────────────
/// The SELECT finds candidates; each then becomes an UPDATE guarded by
/// `AND status = 'pending'`. If another drain already took the row,
/// `rows_affected` is 0 and it drops out of the result. Two overlapping drains
/// can therefore run without either delivering the same event twice — the
/// guard, not the SELECT, is what provides that.
///
/// All of it in one transaction, so the claimed set is consistent and a crash
/// between claim and commit leaves rows `pending` (claim lost, safe to retry)
/// rather than `in_flight` and abandoned (claim stuck, never retried).
///
/// `limit` caps the batch so a busy tick cannot monopolise the connection
/// mutex that every command shares.
pub fn claim_ready(
  conn: &mut Connection,
  limit: i64,
  now: &str,
) -> Result<Vec<ClaimedEvent>, rusqlite::Error> {
  let tx = conn.transaction()?;

  let candidates: Vec<(i64, String, String, String, String, String, String, String, i64)> = {
    let mut stmt = tx.prepare(
      "SELECT sequence, id, idempotency_key, payload,
              aggregate_type, aggregate_id, event_type, action,
              attempt_count
         FROM sync_outbox
        WHERE status = 'pending' AND next_attempt_at <= ?1
        ORDER BY sequence
        LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![now, limit], |row| {
      Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
      ))
    })?;
    rows.collect::<Result<Vec<_>, _>>()?
  };

  let mut claimed = Vec::with_capacity(candidates.len());

  for (sequence, id, idempotency_key, payload, aggregate_type, aggregate_id, event_type, action, attempt_count) in candidates {
    let taken = tx.execute(
      "UPDATE sync_outbox
          SET status = 'in_flight', attempt_count = attempt_count + 1
        WHERE sequence = ?1 AND status = 'pending'",
      params![sequence],
    )?;

    if taken == 1 {
      claimed.push(ClaimedEvent {
        sequence,
        id,
        idempotency_key,
        payload,
        aggregate_type,
        aggregate_id,
        event_type,
        action,
        // +1 because the UPDATE above just bumped the column: this is the
        // attempt number of the delivery the caller is about to make.
        attempt_count: attempt_count + 1,
      });
    }
  }

  tx.commit()?;
  Ok(claimed)
}

/// `in_flight` → `done`, stamped with the instant the server confirmed it.
///
/// Returns `false` when the row was not `in_flight`, so a duplicate completion
/// becomes a no-op rather than an error — the caller may retry a completion it
/// never saw acknowledged.
///
/// `processed_at` is set here and nowhere else: the schema carries
/// `CHECK (status <> 'done' OR processed_at IS NOT NULL)`, so SQLite itself
/// refuses to mark a row done without the timestamp.
pub fn mark_done(
  conn: &mut Connection,
  sequence: i64,
  now: &str,
) -> Result<bool, rusqlite::Error> {
  let changed = conn.execute(
    "UPDATE sync_outbox
        SET status = 'done', processed_at = ?2, last_error = NULL
      WHERE sequence = ?1 AND status = 'in_flight'",
    params![sequence, now],
  )?;
  Ok(changed == 1)
}

/// `in_flight` → `pending`, scheduled to be retried at `next_attempt_at`, with
/// the reason recorded in `last_error`.
///
/// Used for [`BatchOutcome::Retryable`], [`BatchOutcome::Refused`], and for a
/// command the server returned no result for. The row KEEPS its incremented
/// `attempt_count`, so [`backoff_seconds`] still sees the true history — a
/// retry that reset the counter would retry forever at the base delay.
///
/// `last_error` is what a shift lead reads when an event will not drain. A row
/// that silently returns to `pending` looks identical to one that is merely
/// waiting its turn.
pub fn retry_later(
  conn: &mut Connection,
  sequence: i64,
  next_attempt_at: &str,
  reason: &str,
) -> Result<bool, rusqlite::Error> {
  let changed = conn.execute(
    "UPDATE sync_outbox
        SET status = 'pending', next_attempt_at = ?2, last_error = ?3
      WHERE sequence = ?1 AND status = 'in_flight'",
    params![sequence, next_attempt_at, reason],
  )?;
  Ok(changed == 1)
}

/// `in_flight` → `failed_permanent`, recording why.
///
/// Terminal for this row: nothing retries it again, but it is NOT deleted —
/// losing it would lose the record that a sale never reached the server, which
/// is exactly what an operator needs to see.
pub fn fail_permanent(
  conn: &mut Connection,
  sequence: i64,
  error: &str,
) -> Result<bool, rusqlite::Error> {
  let changed = conn.execute(
    "UPDATE sync_outbox
        SET status = 'failed_permanent', last_error = ?2
      WHERE sequence = ?1 AND status = 'in_flight'",
    params![sequence, error],
  )?;
  Ok(changed == 1)
}

/// Read one row's status, for tests and diagnostics.
#[cfg(test)]
fn status_of(conn: &Connection, sequence: i64) -> String {
  conn
    .query_row(
      "SELECT status FROM sync_outbox WHERE sequence = ?1",
      params![sequence],
      |row| row.get(0),
    )
    .expect("row exists")
}

/// Read one row's `attempt_count`.
#[cfg(test)]
fn attempts_of(conn: &Connection, sequence: i64) -> i64 {
  conn
    .query_row(
      "SELECT attempt_count FROM sync_outbox WHERE sequence = ?1",
      params![sequence],
      |row| row.get(0),
    )
    .expect("row exists")
}

/// Read one row's `last_error`.
#[cfg(test)]
fn last_error_of(conn: &Connection, sequence: i64) -> Option<String> {
  conn
    .query_row(
      "SELECT last_error FROM sync_outbox WHERE sequence = ?1",
      params![sequence],
      |row| row.get(0),
    )
    .expect("row exists")
}

/// Read one row's scheduled `next_attempt_at` — the backoff schedule, as stored.
///
/// Asserting on the COLUMN rather than on a recomputed string is what makes
/// these tests about the drain's decision: the value compared here is the one
/// the next `claim_ready` scan will actually obey.
#[cfg(test)]
fn next_attempt_of(conn: &Connection, sequence: i64) -> String {
  conn
    .query_row(
      "SELECT next_attempt_at FROM sync_outbox WHERE sequence = ?1",
      params![sequence],
      |row| row.get(0),
    )
    .expect("row exists")
}

/// One full drain cycle: claim → push the batch → settle each row.
///
/// This is the ACK / ROLLBACK decision point, and it is deliberately NOT
/// "200 means delete".
///
/// ── WHY A ROW IS MARKED `done` AND NEVER DELETED ────────────────────────────
/// `200` means the ENVELOPE was well-formed, not that every command was
/// applied — `internal/order/adapter/http/sync_handler.go` says so in its own
/// package doc: "Some commands may still have been REJECTED, and the caller
/// must read `results[].outcome` to find out." A batch of 10 orders where one
/// is malformed answers 200. Deleting the batch on the status code alone would
/// erase that one real sale with no record that it ever existed.
///
/// So the terminal's `done` state is the server's PROOF that the event landed
/// — the `0001_init.sql` comment says exactly that, and adds
/// `CHECK (status <> 'done' OR processed_at IS NOT NULL)` so a row cannot be
/// marked done without the timestamp that proves when. Pruning acknowledged
/// rows is a separate retention decision that an operator makes from the
/// evidence this state preserves; it is not something a status code may do on
/// the terminal's behalf.
///
/// ── THE THREE ARROWS ────────────────────────────────────────────────────────
/// * `applied` / `duplicate` → `done`
/// * `rejected`              → `failed_permanent` (the server will never take it)
/// * retryable / refused     → `pending`, with the reason in `last_error`
///
/// And the case with no arrow: **a command the server did not mention**. It is
/// retried, not assumed successful — the response was 2xx, which proves only
/// that the envelope parsed. Assuming the rest landed is how a terminal loses
/// an order it was told nothing about.
///
/// Rows settle INDEPENDENTLY. One `rejected` must not hold up the orders behind
/// it, or a single malformed event wedges a whole shift's queue — the exact
/// failure the contract's per-command outcome exists to prevent.
///
/// The transport is a closure so the state machine is testable without a
/// socket, and so the HTTP client is a plug rather than a rewrite.
pub fn drain_tick<F>(
  conn: &mut Connection,
  limit: i64,
  now: &str,
  deliver: &mut F,
) -> Result<Vec<ClaimedEvent>, rusqlite::Error>
where
  F: FnMut(&[ClaimedEvent]) -> BatchOutcome,
{
  let claimed = claim_ready(conn, limit, now)?;

  if claimed.is_empty() {
    return Ok(claimed);
  }

  // NOT computed once per batch: the delay belongs to each ROW, and a row's
  // `attempt_count` is its own history. One batch can hold a row on its first
  // attempt beside a row that has already been refused the network six times,
  // and scheduling both with a single timestamp gives the exhausted row a fresh
  // 30s every tick — the backoff never climbs for exactly the rows that need it.
  // So the delay is derived per row, at each `retry_later` call site below.

  match deliver(&claimed) {
    BatchOutcome::Processed(results) => {
      for event in &claimed {
        match results.iter().find(|result| result.event_id == event.id) {
          // `duplicate` is a SUCCESS. It is the expected answer when a previous
          // response was lost, and marking it anything else retries forever.
          Some(result) if matches!(result.outcome, CommandOutcome::Applied | CommandOutcome::Duplicate) => {
            mark_done(conn, event.sequence, now)?;
          }
          Some(result) => {
            fail_permanent(
              conn,
              event.sequence,
              result.error.as_deref().unwrap_or("rejected by server"),
            )?;
          }
          // Silence from the server about a command that was sent is not proof
          // of anything. Retry it.
          None => {
            log::warn!(
              target: "sync_outbox",
              "no result for outbox event {}; scheduling a retry", event.id
            );
            let next_attempt_at = exponential_backoff_next_attempt(now, event.attempt_count);
            retry_later(conn, event.sequence, &next_attempt_at, "server returned no result for this command")?;
          }
        }
      }
    }

    // Both retry: the batch is intact and nothing was applied, so retrying the
    // same events with the same idempotency keys is the correct and safe move.
    BatchOutcome::Retryable { reason } | BatchOutcome::Refused { reason } => {
      log::warn!(target: "sync_outbox", "outbox batch not delivered: {reason}");
      for event in &claimed {
        // Each row waits in proportion to its OWN history, so a batch-wide
        // constant cannot keep re-hammering the server for the rows that have
        // been failing longest.
        let next_attempt_at = exponential_backoff_next_attempt(now, event.attempt_count);
        retry_later(conn, event.sequence, &next_attempt_at, &reason)?;
      }
    }
  }

  Ok(claimed)
}

/// Spawn the background drain on Tauri's async runtime.
///
/// This is the crate's only `async` entry point; everything else uses
/// `spawn_blocking` because rusqlite is synchronous. The whole loop runs inside
/// ONE blocking closure for a specific reason: `deliver` is a `FnMut` that must
/// survive every iteration, and a closure moved into `spawn_blocking` can only
/// be moved once. Awaiting that single long-lived blocking task from an async
/// outer task is what satisfies both — the async task owns the lifecycle, the
/// blocking thread owns the loop.
///
/// The connection mutex is held ONLY inside the inner scope and released before
/// `sleep`. Holding it across the sleep would block every checkout command for
/// the length of the interval — a cashier would be locked out of the till while
/// an idle drain slept.
///
/// A failed tick logs and continues: a transient storage error must not kill
/// the task, because nothing restarts it and the outbox would stop draining
/// silently for the rest of the shift.
pub fn spawn_drain(
  app: tauri::AppHandle,
  interval: std::time::Duration,
  limit: i64,
  mut deliver: impl FnMut(&[ClaimedEvent]) -> BatchOutcome + Send + 'static,
) -> tauri::async_runtime::JoinHandle<()> {
  tauri::async_runtime::spawn(async move {
    let worker = tauri::async_runtime::spawn_blocking(move || loop {
      {
        // Scope: both bindings below are dropped at the end of this block, so
        // the connection mutex is NEVER held across the sleep that follows.
        let state = app.state::<AppState>();
        let mut conn = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let now = now_iso();
        if let Err(error) = drain_tick(&mut conn, limit, &now, &mut deliver) {
          log::error!(target: "sync_outbox", "outbox drain tick failed: {error}");
        }
      }

      std::thread::sleep(interval);
    });

    // `let _ =`: the loop only returns if the blocking task panics, and an
    // unhandled JoinError here would take the outer task down with it.
    let _ = worker.await;
  })
}

/// The current instant as ISO-8601 UTC — the schema's only timestamp format.
///
/// Written by hand rather than pulled from `chrono`: this is the sole clock
/// read in the crate (checkout takes its `created_at` from the frontend), and
/// adding a datetime dependency for one `now` would bring a second time
/// representation into a schema whose comments argue at length that TEXT in
/// ISO-8601 UTC with a literal `Z` is the ONE representation, chosen because
/// lexicographic order equals chronological order.
///
/// Falls back to the epoch on a clock that predates 1970, which cannot happen
/// on a POS terminal but must not panic if it ever does.
pub fn now_iso() -> String {
  let since_epoch = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);

  let days = (since_epoch / 86_400) as i64;
  let seconds_of_day = since_epoch % 86_400;
  let (year, month, day) = civil_from_days(days);

  format!(
    "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z",
    hour = seconds_of_day / 3600,
    minute = (seconds_of_day % 3600) / 60,
    second = seconds_of_day % 60,
  )
}

/// Days-since-epoch → (year, month, day). Howard Hinnant's `civil_from_days`.
///
/// The standard proleptic-Gregorian conversion: shift the epoch to
/// 0000-03-01 so leap day lands at the END of the year, then solve eras of
/// 400/100/4 years in integer arithmetic with no branches on the calendar.
/// Written out rather than guessed at — a wrong leap-year rule here would date
/// every outbox row incorrectly and nothing would fail.
fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
  let shifted = days_since_epoch + 719_468; // days from 0000-03-01
  let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
  let day_of_era = (shifted - era * 146_097) as u64;
  let year_of_era =
    (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
  let year = year_of_era as i64 + era * 400;
  let day_of_year = (day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100)) as i64;
  let month_prime = (5 * day_of_year + 2) / 153;
  let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
  let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 };
  // Months 1-2 belong to the NEXT year under the March-epoch shift.
  (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Move an ISO-8601 `...Z` instant forward by `seconds`.
///
/// The general form the backoff needs, generalised from the one-minute step it
/// used to be: the delays are 30s, 60s, 120s, 240s and 300s, and a ladder of
/// per-magnitude branches would be a second place for the schedule to go wrong.
/// One function serves every magnitude, including the minute rollover.
///
/// Textual rather than `chrono`, for the same reason as [`now_iso`]: this code
/// base has one time format on purpose. It only understands the `HH:MM:SSZ`
/// suffix the outbox writes, and returns the input unchanged if the shape is
/// not what it expects — a retry time that failed to move is visible in the
/// next scan, whereas a panic here would take down the drain loop.
fn add_seconds(now: &str, seconds: i64) -> String {
  // `"2026-10-05T12:00:00Z"`: the `HH:MM:SSZ` suffix is 9 bytes, so `index` is
  // the position AFTER the `T` — the split must leave the `T` on the prefix side.
  let Some(index) = now.len().checked_sub(9) else {
    return now.to_string();
  };

  let separator = b'T';
  if !now.ends_with('Z') || now.as_bytes().get(index.wrapping_sub(1)) != Some(&separator) {
    return now.to_string();
  }

  // `get` rather than slicing, so a malformed or multi-byte input yields the
  // input instead of panicking inside the drain loop.
  let (Some(prefix), Some(suffix)) = (now.get(..index), now.get(index..)) else {
    return now.to_string();
  };

  let mut parts = suffix.split(':');
  let (Some(hour_text), Some(minute_text), Some(second_text)) =
    (parts.next(), parts.next(), parts.next())
  else {
    return now.to_string();
  };

  let (Ok(hour), Ok(minute), Ok(second)) = (
    hour_text.parse::<i64>(),
    minute_text.parse::<i64>(),
    second_text.trim_end_matches('Z').parse::<i64>(),
  ) else {
    return now.to_string();
  };

  if hour >= 24 || minute >= 60 || second >= 60 {
    return now.to_string();
  }

  // Collapse the clock to one count of seconds, add, then let the carry walk it
  // back apart. One code path serves 30s, 60s and the 300s ceiling alike.
  let total = hour * 3600 + minute * 60 + second + seconds;
  // `div_euclid`/`rem_euclid` keep the remainder in `0..86_400` even when
  // `seconds` is negative, so this can never format a negative hour.
  let whole_days = total.div_euclid(86_400);
  let rest = total.rem_euclid(86_400);
  let (out_hour, out_minute, out_second) = (rest / 3600, (rest % 3600) / 60, rest % 60);

  // Rolling past midnight must advance the DATE as well as the clock, or a
  // retry scheduled at 23:59 comes back as 00:00 THE SAME DAY — a
  // `next_attempt_at` in the past, so the row is re-claimed immediately and
  // backoff collapses exactly at the moment the terminal is most likely to be
  // left overnight.
  if whole_days > 0 {
    let Some((year, month, day)) = parse_date(prefix) else {
      return now.to_string();
    };
    let (mut year, mut month, mut day) = (year, month, day);
    for _ in 0..whole_days {
      let next = next_day(year, month, day);
      year = next.0;
      month = next.1;
      day = next.2;
    }
    return format!(
      "{year:04}-{month:02}-{day:02}T{out_hour:02}:{out_minute:02}:{out_second:02}Z"
    );
  }

  format!("{prefix}{out_hour:02}:{out_minute:02}:{out_second:02}Z")
}

/// `"2026-10-05T"` → `(2026, 10, 5)`, or `None` if the prefix is not that shape.
///
/// The trailing `T` is stripped because `prefix` is everything BEFORE the
/// clock, which includes the date-time separator.
fn parse_date(prefix: &str) -> Option<(i64, i64, i64)> {
  let date = prefix.strip_suffix('T').unwrap_or(prefix);
  let bytes = date.as_bytes();
  if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
    return None;
  }
  Some((
    date[0..4].parse().ok()?,
    date[5..7].parse().ok()?,
    date[8..10].parse().ok()?,
  ))
}

/// The calendar day after `(year, month, day)`.
///
/// Round-trips through [`civil_from_days`] and [`days_from_civil`], which keeps
/// leap-year handling in ONE place rather than writing a second, subtly
/// different month-length table here.
fn next_day(year: i64, month: i64, day: i64) -> (i64, i64, i64) {
  civil_from_days(days_from_civil(year, month, day) + 1)
}

/// `(year, month, day)` → days since 1970-01-01. The inverse of
/// [`civil_from_days`], same Howard Hinnant formulation.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let adjusted_year = if month <= 2 { year - 1 } else { year };
  let era = if adjusted_year >= 0 { adjusted_year } else { adjusted_year - 399 } / 400;
  let year_of_era = adjusted_year - era * 400;
  let month_prime = if month > 2 { month - 3 } else { month + 9 };
  let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
  let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::migrate::migrate;

  /// A migrated in-memory database — the REAL schema, CHECKs and index included.
  fn conn() -> Connection {
    let mut c = Connection::open_in_memory().expect("open in-memory database");
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&mut c).expect("migrate");
    c
  }

  /// Queue one outbox row that satisfies every CHECK in `sync_outbox`.
  ///
  /// Returns `sequence`, which is the handle every assertion needs.
  fn enqueue(conn: &Connection, id: &str, key: &str, next_attempt_at: &str) -> i64 {
    conn
      .execute(
        "INSERT INTO sync_outbox (
           id, aggregate_type, aggregate_id, event_type, action, payload,
           idempotency_key, status, attempt_count, next_attempt_at, last_error,
           created_at, processed_at
         ) VALUES (?1, 'order', ?2, 'order_committed', 'push_order', ?3,
                   ?4, 'pending', 0, ?5, NULL, '2026-10-05T09:00:00.000Z', NULL)",
        params![id, id, format!("{{\"order_id\":\"{id}\"}}"), key, next_attempt_at],
      )
      .expect("enqueue outbox row");
    conn
      .query_row(
        "SELECT sequence FROM sync_outbox WHERE id = ?1",
        params![id],
        |row| row.get(0),
      )
      .expect("row exists")
  }

  /// A timestamp every "due now" test compares against.
  const NOW: &str = "2026-10-05T12:00:00Z";

  // ── The claim: pending → in_flight ────────────────────────────────────────

  #[test]
  fn claim_flips_pending_to_in_flight_and_increments_the_attempt() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");

    let claimed = claim_ready(&mut c, 10, NOW).expect("claim");

    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].attempt_count, 1, "first delivery is attempt 1");
    assert_eq!(status_of(&c, seq), "in_flight");
    assert_eq!(attempts_of(&c, seq), 1, "the row itself must agree");
  }

  #[test]
  fn claim_binds_the_raw_idempotency_key_to_its_own_payload() {
    let mut c = conn();
    enqueue(&c, "evt-a", "key-alpha", "2026-10-05T11:00:00Z");
    enqueue(&c, "evt-b", "key-beta", "2026-10-05T11:00:00Z");

    let claimed = claim_ready(&mut c, 10, NOW).expect("claim");

    // Each key travels with the payload it was queued beside — never swapped,
    // and never replaced by a digest. The server hashes; we transmit.
    for event in &claimed {
      let expected_id = if event.idempotency_key == "key-alpha" { "evt-a" } else { "evt-b" };
      assert_eq!(event.id, expected_id, "key must stay paired with its payload");
      assert!(
        event.payload.contains(expected_id),
        "payload must belong to {expected_id}"
      );
      assert_eq!(
        event.idempotency_key,
        if expected_id == "evt-a" { "key-alpha" } else { "key-beta" },
        "the key must arrive VERBATIM — the server computes SHA-256(branch ‖ key)"
      );
    }
  }

  #[test]
  fn an_in_flight_row_is_never_claimed_twice() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");

    let first = claim_ready(&mut c, 10, NOW).expect("first claim");
    let second = claim_ready(&mut c, 10, NOW).expect("second claim");

    assert_eq!(first.len(), 1);
    // THE CAS: the second scan sees the row but the `AND status = 'pending'`
    // guard rejects the UPDATE, so it is not handed out again. Two overlapping
    // drains therefore cannot double-deliver.
    assert!(second.is_empty(), "a claimed row must not be handed out twice");
    assert_eq!(attempts_of(&c, seq), 1, "the counter must not double-count");
  }

  #[test]
  fn rows_due_in_the_future_are_left_for_the_next_tick() {
    let mut c = conn();
    enqueue(&c, "due", "key-due", "2026-10-05T11:59:59Z");
    let later = enqueue(&c, "later", "key-later", "2026-10-05T12:30:00Z");

    let claimed = claim_ready(&mut c, 10, NOW).expect("claim");

    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, "due");
    assert_eq!(status_of(&c, later), "pending", "not yet its time");
  }

  #[test]
  fn claim_honours_its_limit_and_takes_the_oldest_first() {
    let mut c = conn();
    let oldest = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");
    enqueue(&c, "evt-2", "key-2", "2026-10-05T11:00:00Z");
    enqueue(&c, "evt-3", "key-3", "2026-10-05T11:00:00Z");

    let claimed = claim_ready(&mut c, 2, NOW).expect("claim");

    assert_eq!(claimed.len(), 2, "the batch cap must hold");
    assert_eq!(claimed[0].sequence, oldest, "strictly increasing drain order");
    assert_eq!(status_of(&c, oldest), "in_flight");
  }

  #[test]
  fn claiming_from_an_empty_outbox_is_a_no_op_not_an_error() {
    let mut c = conn();
    assert!(claim_ready(&mut c, 10, NOW).expect("claim").is_empty());
  }

  // ── Completion: in_flight → done ──────────────────────────────────────────

  #[test]
  fn mark_done_stamps_processed_at_and_keeps_the_schema_happy() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");
    claim_ready(&mut c, 10, NOW).expect("claim");

    assert!(mark_done(&mut c, seq, NOW).expect("complete"));

    let (status, processed_at): (String, String) = c
      .query_row(
        "SELECT status, processed_at FROM sync_outbox WHERE sequence = ?1",
        params![seq],
        |row| Ok((row.get(0)?, row.get(1)?)),
      )
      .expect("read row");
    assert_eq!(status, "done");
    // The schema's `CHECK (status <> 'done' OR processed_at IS NOT NULL)` would
    // have refused the UPDATE had this been left NULL.
    assert_eq!(processed_at, NOW);
  }

  #[test]
  fn completing_twice_is_a_no_op_so_a_retried_completion_is_safe() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");
    claim_ready(&mut c, 10, NOW).expect("claim");

    assert!(mark_done(&mut c, seq, NOW).expect("first"));
    assert!(!mark_done(&mut c, seq, NOW).expect("second"), "already done");
    assert_eq!(status_of(&c, seq), "done");
  }

  #[test]
  fn completing_a_row_that_was_never_claimed_is_refused() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");

    // A `pending` row must not be completable: only a claim can vouch for it.
    assert!(!mark_done(&mut c, seq, NOW).expect("refused"));
    assert_eq!(status_of(&c, seq), "pending");
  }

  // ── Retry and permanent failure ───────────────────────────────────────────

  #[test]
  fn retry_later_returns_the_row_to_pending_without_resetting_the_counter() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");
    claim_ready(&mut c, 10, NOW).expect("claim");

    assert!(retry_later(&mut c, seq, "2026-10-05T12:01:00Z", "connection reset").expect("retry"));

    assert_eq!(status_of(&c, seq), "pending");
    // If this reset to 0 the row would be retried forever at the base delay —
    // the whole point of the backoff schedule is defeated by a counter that
    // forgets.
    assert_eq!(attempts_of(&c, seq), 1, "the attempt must be remembered");

    // `last_error` is what a shift lead reads to find out why it is stuck.
    assert_eq!(last_error_of(&c, seq), Some("connection reset".to_string()));

    // And because next_attempt_at moved into the FUTURE, it is not
    // immediately re-claimed.
    assert!(claim_ready(&mut c, 10, NOW).expect("claim").is_empty());
  }

  #[test]
  fn fail_permanent_stops_the_retry_but_keeps_the_row() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");
    claim_ready(&mut c, 10, NOW).expect("claim");

    assert!(fail_permanent(&mut c, seq, "400 bad payload").expect("fail"));

    assert_eq!(status_of(&c, seq), "failed_permanent");
    let last_error: String = c
      .query_row(
        "SELECT last_error FROM sync_outbox WHERE sequence = ?1",
        params![seq],
        |row| row.get(0),
      )
      .expect("read error");
    assert_eq!(last_error, "400 bad payload");

    // Never drained again — but still present, so an operator can see that a
    // sale never reached the server.
    assert!(claim_ready(&mut c, 10, NOW).expect("claim").is_empty());
    let remaining: i64 = c
      .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
      .expect("count");
    assert_eq!(remaining, 1, "a permanently failed event must not be pruned");
  }

  // ── The whole tick ────────────────────────────────────────────────────────

  /// THE LOAD-BEARING TEST: a 200 with mixed per-command outcomes.
  ///
  /// This is the batch the Go handler describes — "the batch was well-formed and
  /// processed. Some commands may still have been REJECTED." Deleting on the
  /// status code would have thrown away `bad`, a real sale, with no record.
  /// Asserting the four statuses separately is what makes that impossible to
  /// regress into.
  #[test]
  fn drain_tick_maps_each_command_outcome_to_its_own_state() {
    let mut c = conn();
    let applied = enqueue(&c, "applied", "key-applied", "2026-10-05T11:00:00Z");
    let dup = enqueue(&c, "dup", "key-dup", "2026-10-05T11:00:00Z");
    let bad = enqueue(&c, "bad", "key-bad", "2026-10-05T11:00:00Z");
    let silent = enqueue(&c, "silent", "key-silent", "2026-10-05T11:00:00Z");

    let mut seen: Vec<String> = Vec::new();
    let claimed = {
      let mut deliver = |batch: &[ClaimedEvent]| {
        seen = batch.iter().map(|event| event.idempotency_key.clone()).collect();
        BatchOutcome::Processed(vec![
          CommandResult { event_id: "applied".into(), outcome: CommandOutcome::Applied, error: None },
          // `duplicate` — a SUCCESS, not a failure.
          CommandResult { event_id: "dup".into(), outcome: CommandOutcome::Duplicate, error: None },
          CommandResult {
            event_id: "bad".into(),
            outcome: CommandOutcome::Rejected,
            error: Some("payload is not an order".into()),
          },
          // `silent` is deliberately absent from the response.
        ])
      };
      drain_tick(&mut c, 10, NOW, &mut deliver).expect("tick")
    };

    assert_eq!(claimed.len(), 4);
    // The keys travelled with their payloads, in the order they were claimed.
    assert_eq!(seen, vec!["key-applied", "key-dup", "key-bad", "key-silent"]);

    assert_eq!(status_of(&c, applied), "done");
    assert_eq!(status_of(&c, dup), "done", "duplicate IS done");
    assert_eq!(status_of(&c, bad), "failed_permanent");
    assert_eq!(
      last_error_of(&c, bad),
      Some("payload is not an order".into()),
      "the server's reason is what a shift lead reads"
    );
    // The one the server said nothing about is retried, NOT assumed applied.
    assert_eq!(status_of(&c, silent), "pending");

    // Nothing was deleted — every row is still on disk, including the rejected
    // one. Deleting on `200` would have removed `bad` entirely.
    let remaining: i64 = c
      .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
      .expect("count");
    assert_eq!(remaining, 4, "no row may be deleted on acknowledgement");
  }

  #[test]
  fn a_done_row_carries_the_timestamp_that_proves_it_landed() {
    let mut c = conn();
    let seq = enqueue(&c, "ok", "key-ok", "2026-10-05T11:00:00Z");

    drain_tick(&mut c, 10, NOW, &mut |_: &[ClaimedEvent]| {
      BatchOutcome::Processed(vec![CommandResult {
        event_id: "ok".into(),
        outcome: CommandOutcome::Applied,
        error: None,
      }])
    })
    .expect("tick");

    let processed_at: Option<String> = c
      .query_row(
        "SELECT processed_at FROM sync_outbox WHERE sequence = ?1",
        params![seq],
        |row| row.get(0),
      )
      .expect("read");
    // The schema's `CHECK (status <> 'done' OR processed_at IS NOT NULL)` would
    // have refused the UPDATE otherwise — the proof is not optional.
    assert_eq!(processed_at.as_deref(), Some(NOW));
  }

  #[test]
  fn a_retryable_batch_returns_every_row_to_pending_with_the_reason() {
    let mut c = conn();
    let a = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");
    let b = enqueue(&c, "evt-2", "key-2", "2026-10-05T11:00:00Z");

    drain_tick(&mut c, 10, NOW, &mut |_: &[ClaimedEvent]| {
      BatchOutcome::Retryable { reason: "HTTP 500 from upstream".into() }
    })
    .expect("tick");

    // NOT stuck in `in_flight`: that is the deadlock the task warns about.
    assert_eq!(status_of(&c, a), "pending");
    assert_eq!(status_of(&c, b), "pending");
    assert_eq!(last_error_of(&c, a), Some("HTTP 500 from upstream".into()));

    // And nothing is immediately re-claimed, because next_attempt_at moved.
    assert!(drain_tick(&mut c, 10, NOW, &mut |_: &[ClaimedEvent]| {
      BatchOutcome::Processed(vec![])
    })
    .expect("second tick")
    .is_empty());
  }

  /// A 4xx envelope refusal is THIS CLIENT's bug, not the sale's fault. It
  /// retries rather than failing permanently, so a fix shipped in the next app
  /// update can still drain the shift's real sales.
  #[test]
  fn a_refused_envelope_retries_rather_than_stranding_real_sales() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");

    drain_tick(&mut c, 10, NOW, &mut |_: &[ClaimedEvent]| {
      BatchOutcome::Refused { reason: "400 idempotency_key_required".into() }
    })
    .expect("tick");

    assert_eq!(status_of(&c, seq), "pending", "must be recoverable, not failed");
    assert_eq!(last_error_of(&c, seq), Some("400 idempotency_key_required".into()));
  }

  #[test]
  fn drain_tick_leaves_the_queue_empty_once_every_row_is_accepted() {
    let mut c = conn();
    enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");

    let mut accepted = |batch: &[ClaimedEvent]| {
      BatchOutcome::Processed(
        batch
          .iter()
          .map(|event| CommandResult {
            event_id: event.id.clone(),
            outcome: CommandOutcome::Applied,
            error: None,
          })
          .collect(),
      )
    };

    let first = drain_tick(&mut c, 10, NOW, &mut accepted).expect("tick");
    let second = drain_tick(&mut c, 10, NOW, &mut accepted).expect("tick");

    assert_eq!(first.len(), 1);
    assert!(second.is_empty(), "nothing left to claim");
    let pending: i64 = c
      .query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE status = 'pending'",
        [],
        |row| row.get(0),
      )
      .expect("count");
    assert_eq!(pending, 0);
  }

  // ── Timestamps ────────────────────────────────────────────────────────────

  #[test]
  fn now_iso_is_the_exact_shape_the_schema_stores() {
    let now = now_iso();

    // TEXT in ISO-8601 UTC with a literal `Z` — the format whose lexicographic
    // order is chronological order, which is what `next_attempt_at` sorting
    // relies on.
    assert_eq!(now.len(), 20, "YYYY-MM-DDTHH:MM:SSZ, got {now}");
    assert!(now.ends_with('Z'), "must be UTC, got {now}");
    assert_eq!(now.as_bytes()[10], b'T', "date and time joined by T, got {now}");
    assert!(
      now.chars()
        .all(|ch| ch.is_ascii_digit() || matches!(ch, 'T' | 'Z' | '-' | ':')),
      "ASCII ISO-8601 only, got {now}"
    );

    // Sanity on the calendar conversion: a real date, not year 47137.
    let year: i64 = now[..4].parse().expect("year");
    assert!((2024..=2100).contains(&year), "implausible year in {now}");
  }

  #[test]
  fn civil_from_days_handles_leap_years_and_year_bounds() {
    // 1970-01-01 is day 0.
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    // 2000-02-29 — a century year that IS a leap year (divisible by 400).
    assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    // 1999-12-31 → 2000-01-01 across the boundary.
    assert_eq!(civil_from_days(10_956), (1999, 12, 31));
    assert_eq!(civil_from_days(10_957), (2000, 1, 1));
    // 2100-03-01 = 47482 days to 2100-01-01 (130 years + 32 leap days), +59.
    // 2100 is NOT a leap year — divisible by 100 but not by 400 — so February
    // has 28 days and this lands where it does. A rule inverted here would
    // date every outbox row one day off after 2100-02-28.
    assert_eq!(civil_from_days(47_482), (2100, 1, 1));
    assert_eq!(civil_from_days(47_541), (2100, 3, 1));
  }


  #[test]
  fn add_seconds_crosses_the_hour_and_leaves_a_bad_shape_alone() {
    // The 60s case is the minute rollover the backoff's second step actually
    // uses, so it keeps its own pin even though the function is general.
    let minute = |now: &str| add_seconds(now, 60);
    assert_eq!(minute("2026-10-05T12:00:00Z"), "2026-10-05T12:01:00Z");
    assert_eq!(minute("2026-10-05T12:59:00Z"), "2026-10-05T13:00:00Z");
    assert_eq!(minute("2026-10-05T23:59:00Z"), "2026-10-06T00:00:00Z");
    assert_eq!(minute("2028-02-28T23:59:00Z"), "2028-02-29T00:00:00Z");
    assert_eq!(minute("2100-02-28T23:59:00Z"), "2100-03-01T00:00:00Z");
    // Seconds carry too, not just whole minutes.
    assert_eq!(add_seconds("2026-10-05T12:00:45Z", 30), "2026-10-05T12:01:15Z");
    // A bad shape is returned untouched rather than panicking in the drain.
    assert_eq!(add_seconds("not-a-timestamp", 60), "not-a-timestamp");
    assert_eq!(add_seconds("", 60), "");
  }

  /// THE SCHEDULE ITSELF: double, then stop.
  ///
  /// Exact equality, not a tolerance. `now` is a parameter, so these are fixed
  /// instants — there is no moving wall clock left to measure against, and a
  /// ±2s window around "about 30s" is not a spec.
  #[test]
  fn backoff_seconds_doubles_and_then_stops_at_the_ceiling() {
    assert_eq!(backoff_seconds(0), 30, "never delivered: the first retry is the base delay");
    assert_eq!(backoff_seconds(1), 30);
    assert_eq!(backoff_seconds(2), 60);
    assert_eq!(backoff_seconds(3), 120);
    assert_eq!(backoff_seconds(4), 240);
    assert_eq!(backoff_seconds(5), 300, "30 * 16 is already past the ceiling");
    assert_eq!(backoff_seconds(6), 300, "and it stays there");
    assert_eq!(backoff_seconds(50), 300);
  }

  #[test]
  fn exponential_backoff_schedules_exact_instants_from_a_fixed_now() {
    // 12:00:00 plus each delay. The first retry is +30s, not +60s: the exponent
    // is `attempt_count - 1`, and the attempt that just failed was attempt 1.
    assert_eq!(
      exponential_backoff_next_attempt(NOW, 1),
      "2026-10-05T12:00:30Z"
    );
    assert_eq!(
      exponential_backoff_next_attempt(NOW, 2),
      "2026-10-05T12:01:00Z"
    );
    assert_eq!(
      exponential_backoff_next_attempt(NOW, 3),
      "2026-10-05T12:02:00Z"
    );
    assert_eq!(
      exponential_backoff_next_attempt(NOW, 4),
      "2026-10-05T12:04:00Z"
    );
    assert_eq!(
      exponential_backoff_next_attempt(NOW, 5),
      "2026-10-05T12:05:00Z",
      "the ceiling: five minutes out"
    );
    assert_eq!(
      exponential_backoff_next_attempt(NOW, 9),
      "2026-10-05T12:05:00Z",
      "still the ceiling — the schedule never runs away"
    );
  }

  /// A retry that crosses midnight must move the DATE too, or the row is
  /// scheduled into its own past and re-claimed instantly.
  #[test]
  fn the_ceiling_delay_crosses_midnight_by_moving_the_date() {
    assert_eq!(
      exponential_backoff_next_attempt("2026-10-05T23:58:00Z", 5),
      "2026-10-06T00:03:00Z"
    );
    assert_eq!(
      exponential_backoff_next_attempt("2028-02-28T23:58:00Z", 5),
      "2028-02-29T00:03:00Z",
      "leap day"
    );
  }

  /// Overflow in a drain is a PANIC, not a degraded value — so an attempt count
  /// a long-lived row could genuinely reach must land on the ceiling rather than
  /// wrap, underflow, or shift past the width of the type.
  #[test]
  fn an_absurd_attempt_count_yields_the_ceiling_and_does_not_panic() {
    assert_eq!(backoff_seconds(i64::MAX), 300);
    assert_eq!(backoff_seconds(i64::MIN), 30, "nonsense clamps to the base delay");
    assert_eq!(backoff_seconds(-5), 30);
    assert_eq!(backoff_seconds(0), 30);

    // And the full call, timestamp included, still yields a well-formed instant.
    for attempt in [i64::MAX, i64::MAX - 1, 1_000_000, 64, 5] {
      assert_eq!(
        exponential_backoff_next_attempt(NOW, attempt),
        "2026-10-05T12:05:00Z",
        "attempt {attempt} must sit at the ceiling"
      );
    }
  }

  /// THE LOAD-BEARING TEST: the delay is the ROW's, not the batch's.
  ///
  /// `stale` is driven through three real failing ticks until it is on its
  /// fourth attempt; `fresh` is queued afterwards and enters on its first. Both
  /// are then due at the same instant, so one `drain_tick` claims and settles
  /// them together — precisely the situation a batch-wide timestamp gets wrong.
  /// Scheduling a whole batch from a hard-coded attempt 1 hands the row that has
  /// already failed three times another 30s, every tick, forever.
  #[test]
  fn each_row_is_scheduled_by_its_own_attempt_count() {
    let mut c = conn();
    let stale = enqueue(&c, "evt-stale", "key-stale", "2026-10-05T11:00:00Z");

    // Three real failures: attempt 1 (+30s), 2 (+60s), 3 (+120s). Each tick
    // instant is past the previous scheduled retry, so the row really is
    // re-claimed — the counter climbs through the drain, never by being SET.
    for now in ["2026-10-05T12:00:00Z", "2026-10-05T12:01:00Z", "2026-10-05T12:03:00Z"] {
      drain_tick(&mut c, 10, now, &mut |_: &[ClaimedEvent]| {
        BatchOutcome::Retryable { reason: "connection reset".into() }
      })
      .expect("tick");
    }
    assert_eq!(attempts_of(&c, stale), 3, "three failed deliveries so far");

    // Queued only now: `fresh` enters the shared tick on its FIRST attempt while
    // `stale` enters it on its fourth.
    let fresh = enqueue(&c, "evt-fresh", "key-fresh", "2026-10-05T11:00:00Z");

    let settled = drain_tick(&mut c, 10, "2026-10-05T12:10:00Z", &mut |_: &[ClaimedEvent]| {
      BatchOutcome::Retryable { reason: "connection reset".into() }
    })
    .expect("shared tick");

    assert_eq!(settled.len(), 2, "both rows were claimed by the same tick");
    assert_eq!(attempts_of(&c, stale), 4);
    assert_eq!(attempts_of(&c, fresh), 1);

    // Same tick, same outcome, DIFFERENT schedule — because the history differs.
    assert_eq!(next_attempt_of(&c, stale), "2026-10-05T12:14:00Z", "attempt 4 waits 240s");
    assert_eq!(next_attempt_of(&c, fresh), "2026-10-05T12:10:30Z", "attempt 1 waits 30s");
  }

  /// A per-command `Rejected` is the ONLY permanent failure.
  ///
  /// The batch did not fail: the envelope was well-formed and the server refused
  /// this one command. Retrying it unchanged would fail identically forever, so
  /// the row is terminal. Transport failures, 5xx and 4xx envelopes all stay on
  /// the retry schedule instead.
  #[test]
  fn rejected_outcome_leads_to_failed_permanent() {
    let mut c = conn();
    let seq = enqueue(&c, "evt-bad", "key-bad", "2026-10-05T11:00:00Z");

    let claimed = drain_tick(&mut c, 10, NOW, &mut |events: &[ClaimedEvent]| {
      BatchOutcome::Processed(
        events
          .iter()
          .map(|event| CommandResult {
            event_id: event.id.clone(),
            outcome: CommandOutcome::Rejected,
            error: Some("unknown product sku".into()),
          })
          .collect(),
      )
    })
    .expect("tick");

    assert_eq!(claimed.len(), 1);
    assert_eq!(status_of(&c, seq), "failed_permanent");
    // The reason is kept verbatim for the shift lead — never parsed.
    assert_eq!(last_error_of(&c, seq), Some("unknown product sku".into()));
    // Terminal: no schedule, never re-claimed — but still on disk to escalate.
    assert!(claim_ready(&mut c, 10, NOW).expect("claim").is_empty());
  }
}
