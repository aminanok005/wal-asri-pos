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
//! ── WHY THERE IS NO HTTP IN THIS FILE ───────────────────────────────────────
//! `ARCHITECTURE-DEMO.md` plans this worker as "drain outbox → POST /sync/push",
//! but the crate has no HTTP client dependency and the push contract is not
//! settled. So delivery is a parameter, not a hard-coded call: [`drain_tick`]
//! takes the transport as a closure. The part that could corrupt a ledger if it
//! were wrong — the state machine — is exercised against real SQLite, while no
//! URL, auth header or request body is invented here to be wrong later.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::Serialize;
use tauri::Manager;

use crate::AppState;

/// Attempts after which an event stops being retried.
///
/// Not a business rule — it is the point where continuing to retry starts
/// delaying the rows queued behind this one. With [`retry_later`]'s backoff,
/// 8 attempts span a useful window without an operator having to prune the
/// table by hand.
pub const MAX_ATTEMPTS: i64 = 8;

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
  /// The JSON body, exactly as checkout wrote it.
  pub payload: String,
  /// `attempt_count` AFTER this claim, so the first delivery reports 1 and a
  /// test can assert the counter without re-reading the row.
  pub attempt_count: i64,
}

/// Outcome of one delivery attempt, reported back to [`drain_tick`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryOutcome {
  /// 2xx — the server durably accepted it.
  Accepted,
  /// Will succeed on retry: timeout, 5xx, connection refused.
  Transient,
  /// Will never succeed on retry: 4xx validation, unparseable payload.
  Permanent,
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

  let candidates: Vec<(i64, String, String, String, i64)> = {
    let mut stmt = tx.prepare(
      "SELECT sequence, id, idempotency_key, payload, attempt_count
         FROM sync_outbox
        WHERE status = 'pending' AND next_attempt_at <= ?1
        ORDER BY sequence
        LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![now, limit], |row| {
      Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
    })?;
    rows.collect::<Result<Vec<_>, _>>()?
  };

  let mut claimed = Vec::with_capacity(candidates.len());

  for (sequence, id, idempotency_key, payload, attempt_count) in candidates {
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

/// `in_flight` → `pending`, scheduled to be retried at `next_attempt_at`.
///
/// Used for a [`DeliveryOutcome::Transient`] result. The row KEEPS its
/// incremented `attempt_count`, so backoff and the [`MAX_ATTEMPTS`] ceiling
/// still see the true history — a retry that reset the counter would retry
/// forever.
pub fn retry_later(
  conn: &mut Connection,
  sequence: i64,
  next_attempt_at: &str,
) -> Result<bool, rusqlite::Error> {
  let changed = conn.execute(
    "UPDATE sync_outbox
        SET status = 'pending', next_attempt_at = ?2
      WHERE sequence = ?1 AND status = 'in_flight'",
    params![sequence, next_attempt_at],
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

/// One full drain cycle: claim → deliver → settle each row.
///
/// The transport is a closure so the state machine is testable without a
/// socket, and so an eventual HTTP client is a plug rather than a rewrite.
///
/// Rows settle INDEPENDENTLY: one `Permanent` rejection must not stop the rows
/// behind it, or a single malformed payload would wedge the entire queue. Each
/// settlement is best-effort (`let _ =`) because a failed UPDATE on row N must
/// not abandon rows N+1… — the next tick re-reads whatever is still
/// `in_flight`.
///
/// Returns the events that were claimed, which is what makes a tick observable.
pub fn drain_tick<F>(
  conn: &mut Connection,
  limit: i64,
  now: &str,
  deliver: &mut F,
) -> Result<Vec<ClaimedEvent>, rusqlite::Error>
where
  F: FnMut(&ClaimedEvent) -> DeliveryOutcome,
{
  let claimed = claim_ready(conn, limit, now)?;

  for event in &claimed {
    match deliver(event) {
      DeliveryOutcome::Accepted => {
        let _ = mark_done(conn, event.sequence, now);
      }
      DeliveryOutcome::Transient => {
        // One minute past `now`, so the row is NOT re-claimed by this same tick.
        // A graduated schedule belongs to the transport's retry policy; what the
        // state machine owes the schema is only that a transient failure returns
        // the row to `pending` with a FUTURE `next_attempt_at`.
        let _ = retry_later(conn, event.sequence, &add_minute(now));
      }
      DeliveryOutcome::Permanent => {
        let _ = fail_permanent(conn, event.sequence, "rejected by server as non-retryable");
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
  mut deliver: impl FnMut(&ClaimedEvent) -> DeliveryOutcome + Send + 'static,
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

/// Move an ISO-8601 `...Z` instant forward by exactly one minute.
///
/// Textual rather than `chrono`, for the same reason as [`now_iso`]: this code
/// base has one time format on purpose. It only understands the `HH:MM:SSZ`
/// suffix the outbox writes, and returns the input unchanged if the shape is
/// not what it expects — a retry time that failed to move is visible in the
/// next scan, whereas a panic here would take down the drain loop.
fn add_minute(now: &str) -> String {
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

  let (Ok(mut hour), Ok(mut minute), Ok(second)) = (
    hour_text.parse::<u32>(),
    minute_text.parse::<u32>(),
    second_text.trim_end_matches('Z').parse::<u32>(),
  ) else {
    return now.to_string();
  };

  if minute >= 60 || hour >= 24 {
    return now.to_string();
  }

  minute += 1;
  if minute == 60 {
    minute = 0;
    hour += 1;
  }

  // Rolling past midnight must advance the DATE as well as the clock, or a
  // retry scheduled at 23:59 comes back as 00:00 THE SAME DAY — a `next_attempt_at`
  // in the past, so the row is re-claimed immediately and backoff collapses
  // exactly at the moment the terminal is most likely to be left overnight.
  if hour == 24 {
    return match parse_date(prefix) {
      Some((year, month, day)) => {
        let (next_year, next_month, next_day) = next_day(year, month, day);
        format!("{next_year:04}-{next_month:02}-{next_day:02}T00:00:{second:02}Z")
      }
      None => now.to_string(),
    };
  }

  format!("{prefix}{hour:02}:{minute:02}:{second:02}Z")
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

    assert!(retry_later(&mut c, seq, "2026-10-05T12:01:00Z").expect("retry"));

    assert_eq!(status_of(&c, seq), "pending");
    // If this reset to 0 the row would be retried forever — the entire point of
    // MAX_ATTEMPTS is defeated by a counter that forgets.
    assert_eq!(attempts_of(&c, seq), 1, "the attempt must be remembered");

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

  #[test]
  fn drain_tick_settles_each_row_by_its_outcome_independently() {
    let mut c = conn();
    let accepted = enqueue(&c, "ok", "key-ok", "2026-10-05T11:00:00Z");
    let transient = enqueue(&c, "flaky", "key-flaky", "2026-10-05T11:00:00Z");
    let permanent = enqueue(&c, "bad", "key-bad", "2026-10-05T11:00:00Z");

    let mut seen: Vec<String> = Vec::new();
    let claimed = {
      let mut deliver = |event: &ClaimedEvent| {
        seen.push(event.idempotency_key.clone());
        match event.id.as_str() {
          "ok" => DeliveryOutcome::Accepted,
          "flaky" => DeliveryOutcome::Transient,
          _ => DeliveryOutcome::Permanent,
        }
      };
      drain_tick(&mut c, 10, NOW, &mut deliver).expect("tick")
    };

    assert_eq!(claimed.len(), 3);
    // All three were delivered — a Permanent rejection on `bad` must not have
    // stopped the rows behind it.
    assert_eq!(seen.len(), 3);

    assert_eq!(status_of(&c, accepted), "done");
    assert_eq!(status_of(&c, transient), "pending", "retryable");
    assert_eq!(status_of(&c, permanent), "failed_permanent");

    // The retried row is scheduled for the FUTURE, so the next tick claims
    // nothing and the transient row waits its turn.
    assert!(drain_tick(&mut c, 10, NOW, &mut |_: &ClaimedEvent| {
      DeliveryOutcome::Accepted
    })
    .expect("second tick")
    .is_empty());
  }

  #[test]
  fn drain_tick_leaves_the_queue_empty_once_every_row_is_settled() {
    let mut c = conn();
    enqueue(&c, "evt-1", "key-1", "2026-10-05T11:00:00Z");

    let first = drain_tick(&mut c, 10, NOW, &mut |_: &ClaimedEvent| {
      DeliveryOutcome::Accepted
    })
    .expect("tick");
    let second = drain_tick(&mut c, 10, NOW, &mut |_: &ClaimedEvent| {
      DeliveryOutcome::Accepted
    })
    .expect("tick");

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
  fn add_minute_crosses_the_hour_and_leaves_a_bad_shape_alone() {
    assert_eq!(add_minute("2026-10-05T12:00:00Z"), "2026-10-05T12:01:00Z");
    assert_eq!(add_minute("2026-10-05T12:59:00Z"), "2026-10-05T13:00:00Z");
    assert_eq!(add_minute("2026-10-05T23:59:00Z"), "2026-10-06T00:00:00Z");
    // Midnight rollover crosses the MONTH correctly too — 2028 is a leap year
    // so 28 Feb → 29 Feb, while 2100 is NOT and must go 28 Feb → 1 Mar.
    assert_eq!(add_minute("2028-02-28T23:59:00Z"), "2028-02-29T00:00:00Z");
    assert_eq!(add_minute("2100-02-28T23:59:00Z"), "2100-03-01T00:00:00Z");
    // A timestamp that is not the outbox's format is passed through rather than
    // panicking inside the drain loop.
    assert_eq!(add_minute("not-a-timestamp"), "not-a-timestamp");
    assert_eq!(add_minute(""), "");
  }
}
