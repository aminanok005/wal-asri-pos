//! The HTTP transport for the outbox drain: `POST /api/v1/sync/push`.
//!
//! WHAT THIS MODULE OWNS ──────────────────────────────────────────────────────
//! Serialising a claimed batch to the contract's `SyncPushRequest`, sending it
//! with the headers the contract requires, and TRANSLATING the reply into a
//! [`BatchOutcome`]. It holds no business rule and no state machine — that is
//! [`crate::sync_outbox`]'s job, and this module is the plug it was shaped for.
//!
//! ── WHY `ureq` AND NOT `reqwest` ────────────────────────────────────────────
//! The drain runs inside `tauri::async_runtime::spawn_blocking`, deliberately,
//! because `rusqlite` is synchronous and the connection mutex is held across the
//! tick. `ureq` is a BLOCKING client, so it matches that thread instead of
//! forcing an async runtime into a thread that must never yield it. `reqwest`
//! would have dragged tokio + hyper + a full connection pool in to push a few
//! hundred kilobytes once every few seconds.
//!
//! ── THE TWO IDEMPOTENCY KEYS, WHICH ARE NOT THE SAME THING ─────────────────
//! The contract puts `Idempotency-Key` in the HEADER for the whole drain
//! attempt ("the server must be able to refuse a duplicate batch BEFORE parsing
//! the body"), and ALSO requires an `idempotency_key` on every command in the
//! body. They serve different failures:
//!
//! * the HEADER key de-duplicates the BATCH — the response was lost, so the
//!   identical batch goes again;
//! * the COMMAND key de-duplicates the EVENT — a batch that half-succeeded is
//!   retried as a smaller batch, and the commands already applied come back
//!   `duplicate` rather than being applied twice.
//!
//! The header key is DERIVED, not generated: `batch_key` below. It must be
//! stable across retries of the same batch or the server cannot recognise the
//! replay, and it must DIFFER when the batch differs or a genuinely new batch
//! would be swallowed as a duplicate.
//!
//! ── WHY NO SHA-256 ON THE WIRE ──────────────────────────────────────────────
//! The per-command key is sent RAW. `services/api-backend/README.md`: "Keys are
//! stored **hashed** (SHA-256 over branch ‖ key)" — that hashing is the SERVER's,
//! on ingest. Hashing here would deliver a hash of a hash and the server's
//! `SHA-256(branch ‖ key)` would never match what it received.
//!
//! ── WHY AN UNKNOWN OUTCOME IS OMITTED RATHER THAN GUESSED ───────────────────
//! `drain_tick` retries any claimed event it does not find in the results. So an
//! outcome string this build does not recognise falls into that path by being
//! left out: the event is retried instead of being marked `done` on the strength
//! of a value nobody can interpret. Silently mapping unknown → `applied` is how
//! a terminal marks a sale done that the server never took.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::sync_outbox::{BatchOutcome, ClaimedEvent, CommandOutcome, CommandResult};

/// The contract's server URL prefix (`- url: /api/v1` in openapi.yaml).
const BASE_PATH: &str = "/api/v1";

/// The header carrying the BATCH replay key. Required, not optional.
const IDEMPOTENCY_KEY_HEADER: &str = "Idempotency-Key";

/// Where the backend lives and who this terminal claims to be.
#[derive(Debug, Clone)]
pub struct SyncConfig {
  /// Scheme + host + port, WITHOUT the `/api/v1` path — e.g.
  /// `http://192.168.1.50:8080`. The path is appended from [`BASE_PATH`] so the
  /// contract's prefix is written down in exactly one place.
  pub base_url: String,
  /// Client-asserted; the contract notes it is UNVERIFIED in this revision.
  pub terminal_id: String,
  /// The branch this terminal serves. Carried in the `X-Branch-Id` header so
  /// the server can scope the push to one branch's outbox without trusting
  /// the client to put it in the body.
  pub branch_id: String,
  /// Ceiling on one whole request, not per byte. A café uplink that has died
  /// silently is indistinguishable from a slow one, and a drain that blocks
  /// forever holds the connection mutex that every checkout command needs.
  pub timeout: Duration,
}

impl SyncConfig {
  /// A config with a 10-second ceiling — long enough for a congested café
  /// uplink, short enough that a dead one is noticed well inside a shift.
  pub fn new(base_url: impl Into<String>, terminal_id: impl Into<String>, branch_id: impl Into<String>) -> Self {
    Self { base_url: base_url.into(), terminal_id: terminal_id.into(), branch_id: branch_id.into(), timeout: Duration::from_secs(10) }
  }

  fn push_url(&self) -> String {
    format!("{}{}/sync/push", self.base_url.trim_end_matches('/'), BASE_PATH)
  }
}

/// The BATCH replay key, derived from the batch itself.
///
/// Stable for the same set of events, different for any other set — which is
/// exactly what the server needs to tell "the response was lost, send it again"
/// apart from "this is new work".
///
/// Derived from the `sequence` range rather than hashed, and the reason is worth
/// stating: `sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so it is
/// strictly increasing and never reused for the life of the database. A claimed
/// batch is a contiguous run of those, which makes the first/last pair plus the
/// count a collision-free identity for THIS batch — no hash dependency, and no
/// risk that a weak hash quietly tells the server that new work is a duplicate
/// of old work (which would silently drop real sales).
///
/// A partial retry claims a DIFFERENT, smaller range, so it correctly presents
/// a different batch key while its surviving commands still carry their own
/// per-event keys.
fn batch_key(terminal_id: &str, events: &[ClaimedEvent]) -> String {
  let first = events.first().map_or(0, |event| event.sequence);
  let last = events.last().map_or(0, |event| event.sequence);
  format!("{terminal_id}:{first}-{last}:{}", events.len())
}

// ─────────────────────────────────────────────────────────────────────────────
// The request body
// ─────────────────────────────────────────────────────────────────────────────

/// `SyncPushRequest`. Field names are snake_case because that is what the
/// contract declares; this crate's `camelCase` rename does not apply to it.
#[derive(Debug, Serialize)]
struct PushRequest<'a> {
  terminal_id: &'a str,
  commands: Vec<PushCommand<'a>>,
}

#[derive(Debug, Serialize)]
struct PushCommand<'a> {
  id: &'a str,
  aggregate_type: &'a str,
  aggregate_id: &'a str,
  event_type: &'a str,
  action: &'a str,
  idempotency_key: &'a str,
  /// The stored TEXT re-parsed, so it embeds as a JSON object rather than a
  /// string. `payload` is `CHECK (json_valid(payload))` in the schema, so a
  /// failure here means the row was written outside the app.
  payload: &'a serde_json::Value,
}

/// `SyncPushResponse`. Only `results` is read; `applied` / `duplicates` /
/// `rejected` / `pushed_at` are summary counters the per-command list already
/// gives precisely, and a second source for the same fact is a second thing that
/// can disagree.
#[derive(Debug, Deserialize)]
struct PushResponse {
  results: Vec<PushResult>,
}

#[derive(Debug, Deserialize)]
struct PushResult {
  id: String,
  outcome: String,
  #[serde(default)]
  error_message: Option<String>,
}

/// The contract's `Error` envelope, read only to put a stable `code` in
/// `last_error`. `message` is explicitly "for humans and must not be parsed".
#[derive(Debug, Deserialize)]
struct ErrorBody {
  code: String,
}

/// The transport [`crate::sync_outbox::drain_tick`] is handed.
pub struct HttpBatchSink {
  config: SyncConfig,
  agent: ureq::Agent,
}

impl HttpBatchSink {
  pub fn new(config: SyncConfig) -> Self {
    let agent = ureq::Agent::config_builder()
      // Without this, ureq turns a 4xx/5xx into an Err and the status code is
      // lost — but the DIFFERENCE between "the envelope was refused" and "the
      // server could not finish" is exactly what `drain_tick` branches on.
      .http_status_as_error(false)
      .timeout_global(Some(config.timeout))
      .build()
      .into();

    Self { config, agent }
  }

  /// Push one claimed batch and classify the reply.
  ///
  /// Total by construction: every failure path returns a `BatchOutcome` rather
  /// than an error, because "could not deliver" is an expected state of a
  /// café's uplink, not an exceptional one. Panicking or unwinding here would
  /// leave the claimed rows `in_flight` — the deadlock the state machine exists
  /// to prevent.
  pub fn push(&self, events: &[ClaimedEvent]) -> BatchOutcome {
    if events.is_empty() {
      return BatchOutcome::Processed(Vec::new());
    }

    // The payload TEXT must become a JSON value to embed. A row whose payload is
    // not valid JSON cannot be sent, but it also cannot be marked done, so it
    // is retried rather than dropped — and the reason is recorded so a shift
    // lead sees why it will not drain.
    let mut payloads = Vec::with_capacity(events.len());
    for event in events {
      match serde_json::from_str::<serde_json::Value>(&event.payload) {
        Ok(value) => payloads.push(value),
        Err(error) => {
          return BatchOutcome::Retryable {
            reason: format!("outbox event {} has an unparseable payload: {error}", event.id),
          };
        }
      }
    }

    let commands = events
      .iter()
      .zip(&payloads)
      .map(|(event, payload)| PushCommand {
        id: &event.id,
        aggregate_type: &event.aggregate_type,
        aggregate_id: &event.aggregate_id,
        event_type: &event.event_type,
        action: &event.action,
        idempotency_key: &event.idempotency_key,
        payload,
      })
      .collect();

    let request = PushRequest { terminal_id: &self.config.terminal_id, commands };
    let key = batch_key(&self.config.terminal_id, events);

    let mut response = match self
      .agent
      .post(&self.config.push_url())
      .header("Content-Type", "application/json")
      .header(IDEMPOTENCY_KEY_HEADER, &key)
      .header("X-Terminal-Id", &self.config.terminal_id)
      .header("X-Branch-Id", &self.config.branch_id)
      .send_json(&request)
    {
      Ok(response) => response,
      // DNS, connect, timeout, TLS — anything that means "the server may or may
      // not have seen this". Retrying is safe because of the keys.
      Err(error) => {
        return BatchOutcome::Retryable { reason: format!("could not reach the sync API: {error}") };
      }
    };

    let status = response.status().as_u16();

    if !(200..300).contains(&status) {
      let body = response.body_mut().read_to_string().unwrap_or_default();
      let code = serde_json::from_str::<ErrorBody>(&body)
        .map(|error| error.code)
        .unwrap_or_else(|_| format!("http_{status}"));
      let reason = format!("HTTP {status} {code}");

      return if (400..500).contains(&status) {
        // Our envelope was unusable. Nothing applied.
        BatchOutcome::Refused { reason }
      } else {
        BatchOutcome::Retryable { reason }
      };
    }

    let body: PushResponse = match response.body_mut().read_json() {
      Ok(body) => body,
      // A 2xx we cannot read is NOT a success we can act on. Retrying is the
      // only honest answer; marking these done would be a guess.
      Err(error) => {
        return BatchOutcome::Retryable { reason: format!("could not read the sync response: {error}") };
      }
    };

    let results: Vec<CommandResult> = body
      .results
      .into_iter()
      // An outcome this build does not recognise is DROPPED, which routes the
      // event to drain_tick's "no result for this command" path — a retry. It
      // is never quietly treated as success.
      .filter_map(|result| {
        let outcome = match result.outcome.as_str() {
          "applied" => CommandOutcome::Applied,
          "duplicate" => CommandOutcome::Duplicate,
          "rejected" => CommandOutcome::Rejected,
          unknown => {
            log::warn!(
              target: "sync_http",
              "unrecognised outcome {unknown:?} for event {}; scheduling a retry", result.id
            );
            return None;
          }
        };
        Some(CommandResult { event_id: result.id, outcome, error: result.error_message })
      })
      .collect();

    BatchOutcome::Processed(results)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{BufRead, BufReader, Read, Write};
  use std::net::TcpListener;
  use std::thread;

  /// What a fake server saw, so a test can assert the wire format.
  #[derive(Debug, Default)]
  struct Captured {
    method: String,
    path: String,
    idempotency_key: Option<String>,
    content_type: Option<String>,
    terminal_id_header: Option<String>,
    branch_id_header: Option<String>,
    body: String,
  }

  /// A one-shot HTTP server on a random loopback port.
  ///
  /// `127.0.0.1:0` rather than a fixed port so parallel test threads never
  /// collide, and loopback rather than the real API so the suite needs no
  /// running Go backend and no network.
  struct FakeServer {
    port: u16,
    handle: thread::JoinHandle<Captured>,
  }

  impl FakeServer {
    /// Answers exactly ONE request with `status` and `body`, then exits.
    fn once(status: u16, body: &str) -> Self {
      let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
      let port = listener.local_addr().expect("addr").port();
      // Owned, because the responder thread outlives this function and must be
      // `'static` — a `&str` borrowed from the caller cannot cross into it.
      let body = body.to_string();

      let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let captured = read_request(&mut stream);

        let response = format!(
          "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
          body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
        captured
      });

      // Give the accept loop a moment to reach `accept()` so the client's
      // connect is not refused by a full backlog.
      Self { port, handle }
    }

    fn url(&self) -> String {
      format!("http://127.0.0.1:{}", self.port)
    }

    /// Block until the request has been served, then return what it saw.
    fn finish(self) -> Captured {
      self.handle.join().expect("server thread")
    }
  }

  /// Read one HTTP request: headers line by line, then `Content-Length` bytes.
  fn read_request(stream: &mut std::net::TcpStream) -> Captured {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut captured = Captured::default();

    let mut request_line = String::new();
    reader.read_line(&mut request_line).expect("read request line");
    let mut parts = request_line.split_whitespace();
    captured.method = parts.next().unwrap_or_default().to_string();
    captured.path = parts.next().unwrap_or_default().to_string();

    let mut content_length = 0usize;
    loop {
      let mut line = String::new();
      if reader.read_line(&mut line).expect("read header") == 0 {
        break;
      }
      let trimmed = line.trim_end();
      if trimmed.is_empty() {
        break;
      }
      let (name, value) = trimmed.split_once(':').unwrap_or((trimmed, ""));
      match name.to_ascii_lowercase().as_str() {
        "content-length" => content_length = value.trim().parse().unwrap_or(0),
        "idempotency-key" => captured.idempotency_key = Some(value.trim().to_string()),
        "x-terminal-id" => captured.terminal_id_header = Some(value.trim().to_string()),
        "x-branch-id" => captured.branch_id_header = Some(value.trim().to_string()),
        "content-type" => captured.content_type = Some(value.trim().to_string()),
        _ => {}
      }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
      reader.read_exact(&mut body).expect("read body");
    }
    captured.body = String::from_utf8_lossy(&body).into_owned();
    captured
  }

  /// A claimed event, as `claim_ready` would hand it over.
  fn event(sequence: i64, id: &str, key: &str) -> ClaimedEvent {
    ClaimedEvent {
      sequence,
      id: id.into(),
      idempotency_key: key.into(),
      aggregate_type: "order".into(),
      aggregate_id: id.into(),
      event_type: "order_committed".into(),
      action: "push_order".into(),
      payload: format!("{{\"order_id\":\"{id}\",\"total_satang\":5250}}"),
      attempt_count: 1,
    }
  }

  // ── The derived batch key ─────────────────────────────────────────────────

  /// The server can only recognise a replay if the SAME batch produces the SAME
  /// key. A random key per attempt would make every retry a fresh batch, and a
  /// lost response would double every sale in it.
  #[test]
  fn the_batch_key_is_stable_for_the_same_batch_and_differs_for_another() {
    let first = [event(1, "a", "ka"), event(2, "b", "kb")];
    let again = [event(1, "a", "ka"), event(2, "b", "kb")];
    let different = [event(1, "a", "ka"), event(3, "c", "kc")];

    assert_eq!(batch_key("t-1", &first), batch_key("t-1", &again));
    assert_ne!(batch_key("t-1", &first), batch_key("t-1", &different));
    assert_ne!(batch_key("t-1", &first), batch_key("t-2", &first));
  }

  /// A partial retry claims a SMALLER range. It must present a different batch
  /// key — but the surviving command still carries its own per-event key, so
  /// the server returns `duplicate` for what it already has.
  #[test]
  fn a_partial_retry_gets_its_own_batch_key() {
    let whole = [event(1, "a", "ka"), event(2, "b", "kb"), event(3, "c", "kc")];
    let tail = [event(2, "b", "kb"), event(3, "c", "kc")];

    assert_ne!(batch_key("t-1", &whole), batch_key("t-1", &tail));
    // …while the per-event key is untouched.
    assert_eq!(tail[0].idempotency_key, "kb");
  }

  // ── Status classification ─────────────────────────────────────────────────

  #[test]
  fn a_200_with_applied_and_duplicate_is_a_processed_batch() {
    let server = FakeServer::once(
      200,
      r#"{"results":[{"id":"a","outcome":"applied","error_message":null},
                     {"id":"b","outcome":"duplicate","error_message":null}],
          "applied":1,"duplicates":1,"rejected":0,"pushed_at":"2026-10-05T12:00:00Z"}"#,
    );
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));

    let outcome = sink.push(&[event(1, "a", "ka"), event(2, "b", "kb")]);

    match outcome {
      BatchOutcome::Processed(results) => {
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], CommandResult { event_id: "a".into(), outcome: CommandOutcome::Applied, error: None });
        // `duplicate` is a SUCCESS — the whole point of the idempotency keys.
        assert_eq!(results[1].outcome, CommandOutcome::Duplicate);
      }
      other => panic!("expected Processed, got {other:?}"),
    }
    server.finish();
  }

  #[test]
  fn a_rejected_command_is_carried_through_with_its_reason() {
    let server = FakeServer::once(
      200,
      r#"{"results":[{"id":"a","outcome":"rejected","error_message":"payload is not an order"}],
          "applied":0,"duplicates":0,"rejected":1,"pushed_at":"2026-10-05T12:00:00Z"}"#,
    );
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));

    match sink.push(&[event(1, "a", "ka")]) {
      BatchOutcome::Processed(results) => {
        assert_eq!(results[0].outcome, CommandOutcome::Rejected);
        assert_eq!(results[0].error.as_deref(), Some("payload is not an order"));
      }
      other => panic!("expected Processed, got {other:?}"),
    }
    server.finish();
  }

  /// An outcome this build does not know is DROPPED, so `drain_tick` retries
  /// the event. Mapping it to `applied` would mark a sale done that may never
  /// have been taken.
  #[test]
  fn an_unrecognised_outcome_is_dropped_so_the_event_is_retried() {
    let server = FakeServer::once(
      200,
      r#"{"results":[{"id":"a","outcome":"quantum_superposition","error_message":null}],
          "applied":0,"duplicates":0,"rejected":0,"pushed_at":"2026-10-05T12:00:00Z"}"#,
    );
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));

    match sink.push(&[event(1, "a", "ka")]) {
      // An EMPTY result list, not one fabricated entry.
      BatchOutcome::Processed(results) => assert!(results.is_empty(), "unknown outcome must not become a result"),
      other => panic!("expected Processed, got {other:?}"),
    }
    server.finish();
  }

  #[test]
  fn a_500_is_retryable_and_carries_the_servers_stable_code() {
    let server = FakeServer::once(500, r#"{"code":"internal_error","message":"upstream down"}"#);
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));

    match sink.push(&[event(1, "a", "ka")]) {
      BatchOutcome::Retryable { reason } => {
        // `code`, not `message` — the contract says message "must not be parsed".
        assert!(reason.contains("internal_error"), "got {reason}");
      }
      other => panic!("expected Retryable, got {other:?}"),
    }
    server.finish();
  }

  #[test]
  fn a_400_is_a_refusal_not_a_retryable_failure() {
    let server = FakeServer::once(400, r#"{"code":"idempotency_key_required","message":"missing"}"#);
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));

    match sink.push(&[event(1, "a", "ka")]) {
      BatchOutcome::Refused { reason } => assert!(reason.contains("idempotency_key_required"), "got {reason}"),
      other => panic!("expected Refused, got {other:?}"),
    }
    server.finish();
  }

  /// Nobody listening at all. The row must go back to `pending` with a reason,
  /// never sit in `in_flight`.
  #[test]
  fn a_dead_endpoint_is_retryable_rather_than_a_panic() {
    // Bind then immediately drop, so the port is almost certainly closed.
    let port = {
      let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
      listener.local_addr().expect("addr").port()
    };
    let sink = HttpBatchSink::new(SyncConfig::new(format!("http://127.0.0.1:{port}"), "terminal-1", "branch-1"));

    match sink.push(&[event(1, "a", "ka")]) {
      BatchOutcome::Retryable { reason } => assert!(!reason.is_empty()),
      other => panic!("expected Retryable, got {other:?}"),
    }
  }

  /// A 2xx whose body cannot be read proves nothing. Retried, not believed.
  #[test]
  fn a_200_with_an_unreadable_body_is_retried_not_trusted() {
    let server = FakeServer::once(200, "{not json at all");
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));

    match sink.push(&[event(1, "a", "ka")]) {
      BatchOutcome::Retryable { .. } => {}
      other => panic!("expected Retryable, got {other:?}"),
    }
    server.finish();
  }

  // ── The wire format ───────────────────────────────────────────────────────

  /// The contract's REQUIRED header, on the contract's path, with the body the
  /// contract declares. Each field is asserted by name because a rename here is
  /// a silent 400 against a server that will not say which field it disliked.
  #[test]
  fn the_request_matches_the_contract_exactly() {
    let server = FakeServer::once(200, r#"{"results":[],"applied":0,"duplicates":0,"rejected":0,"pushed_at":"2026-10-05T12:00:00Z"}"#);
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-7", "branch-1"));

    sink.push(&[event(1, "a", "ka")]);
    let captured = server.finish();

    assert_eq!(captured.method, "POST");
    assert_eq!(captured.path, "/api/v1/sync/push", "the contract's base path");
    assert_eq!(
      captured.idempotency_key.as_deref(),
      Some(batch_key("terminal-7", &[event(1, "a", "ka")]).as_str()),
      "the batch key must be in the header"
    );
    assert_eq!(captured.terminal_id_header.as_deref(), Some("terminal-7"));
    assert_eq!(captured.branch_id_header.as_deref(), Some("branch-1"));
    assert!(captured.content_type.unwrap_or_default().contains("application/json"));

    let body: serde_json::Value = serde_json::from_str(&captured.body).expect("body is JSON");
    assert_eq!(body["terminal_id"], "terminal-7");

    let command = &body["commands"][0];
    assert_eq!(command["id"], "a");
    assert_eq!(command["aggregate_type"], "order");
    assert_eq!(command["aggregate_id"], "a");
    assert_eq!(command["event_type"], "order_committed");
    assert_eq!(command["action"], "push_order");
    // The RAW key, not a digest — the server hashes.
    assert_eq!(command["idempotency_key"], "ka");
    // The payload is embedded as an OBJECT, not as a string of JSON.
    assert_eq!(command["payload"]["total_satang"], 5250);
  }

  /// The contract: "Commands are applied in array order and must not be
  /// reordered… replaying a `shift_opened` after the `shift_closed` that ended
  /// it would corrupt the till's day."
  #[test]
  fn commands_are_sent_in_outbox_sequence_order() {
    let server = FakeServer::once(200, r#"{"results":[],"applied":0,"duplicates":0,"rejected":0,"pushed_at":"2026-10-05T12:00:00Z"}"#);
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));

    sink.push(&[event(1, "a", "ka"), event(2, "b", "kb"), event(3, "c", "kc")]);
    let captured = server.finish();

    let body: serde_json::Value = serde_json::from_str(&captured.body).expect("body is JSON");
    let ids: Vec<&str> = body["commands"]
      .as_array()
      .expect("commands array")
      .iter()
      .map(|command| command["id"].as_str().expect("id"))
      .collect();

    assert_eq!(ids, vec!["a", "b", "c"], "order is semantic, not incidental");
  }

  /// An empty batch must not open a socket at all.
  #[test]
  fn an_empty_batch_is_a_no_op() {
    let sink = HttpBatchSink::new(SyncConfig::new("http://127.0.0.1:1", "terminal-1", "branch-1"));
    assert_eq!(sink.push(&[]), BatchOutcome::Processed(Vec::new()));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INTEGRATION: a real migrated SQLite, a real socket, the real state machine.
  //
  // The tests above classify replies and the `sync_outbox` tests classify
  // outcomes, but neither proves the two are wired to each other. These do, and
  // they are the ones that catch "the ACK path is wired to the wrong arrow" —
  // the failure mode where every unit test still passes.
  // ───────────────────────────────────────────────────────────────────────────

  use crate::migrate::migrate;
  use rusqlite::{Connection, params};

  const NOW: &str = "2026-10-05T12:00:00Z";

  /// A migrated in-memory database — the REAL schema, CHECKs and index.
  fn db() -> Connection {
    let mut connection = Connection::open_in_memory().expect("open in-memory database");
    connection.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&mut connection).expect("migrate");
    connection
  }

  /// Queue one outbox row that satisfies every CHECK in `sync_outbox`.
  fn enqueue(conn: &Connection, id: &str, key: &str) -> i64 {
    conn
      .execute(
        "INSERT INTO sync_outbox (
           id, aggregate_type, aggregate_id, event_type, action, payload,
           idempotency_key, status, attempt_count, next_attempt_at, last_error,
           created_at, processed_at
         ) VALUES (?1, 'order', ?2, 'order_committed', 'push_order', ?3,
                   ?4, 'pending', 0, '2026-10-05T11:00:00Z', NULL, ?5, NULL)",
        params![
          id,
          id,
          format!("{{\"order_id\":\"{id}\",\"total_satang\":5250}}"),
          key,
          "2026-10-05T09:00:00Z"
        ],
      )
      .expect("enqueue");
    conn
      .query_row(
        "SELECT sequence FROM sync_outbox WHERE id = ?1",
        params![id],
        |row| row.get(0),
      )
      .expect("row exists")
  }

  fn status_of(conn: &Connection, sequence: i64) -> String {
    conn
      .query_row(
        "SELECT status FROM sync_outbox WHERE sequence = ?1",
        params![sequence],
        |row| row.get(0),
      )
      .expect("row exists")
  }

  /// Drive one real tick: claim → HTTP → settle.
  fn tick(conn: &mut Connection, sink: &HttpBatchSink) -> usize {
    crate::sync_outbox::drain_tick(conn, 10, NOW, &mut |batch| sink.push(batch))
      .expect("drain")
      .len()
  }

  #[test]
  fn a_200_that_applied_everything_leaves_every_row_done() {
    let server = FakeServer::once(
      200,
      r#"{"results":[{"id":"a","outcome":"applied"},{"id":"b","outcome":"applied"}],
          "applied":2,"duplicates":0,"rejected":0,"pushed_at":"2026-10-05T12:00:00Z"}"#,
    );
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));
    let mut conn = db();

    let a = enqueue(&conn, "a", "ka");
    let b = enqueue(&conn, "b", "kb");

    assert_eq!(tick(&mut conn, &sink), 2);
    assert_eq!(status_of(&conn, a), "done");
    assert_eq!(status_of(&conn, b), "done");
    server.finish();
  }

  /// THE regression this whole design exists to prevent.
  ///
  /// The server answered 200. One command was `rejected` — a real sale the
  /// server will never take. A terminal that read the status code as "everything
  /// landed" would have deleted that row, and the shop would never learn the
  /// order existed. So the row must still be here, visibly stuck.
  #[test]
  fn a_200_with_one_rejection_leaves_that_sale_visible_in_failed_permanent() {
    let server = FakeServer::once(
      200,
      r#"{"results":[{"id":"ok","outcome":"applied"},
                     {"id":"bad","outcome":"rejected","error_message":"payload is not an order"}],
          "applied":1,"duplicates":0,"rejected":1,"pushed_at":"2026-10-05T12:00:00Z"}"#,
    );
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));
    let mut conn = db();

    let ok = enqueue(&conn, "ok", "k-ok");
    let bad = enqueue(&conn, "bad", "k-bad");

    tick(&mut conn, &sink);

    assert_eq!(status_of(&conn, ok), "done");
    assert_eq!(status_of(&conn, bad), "failed_permanent", "visible, not deleted");

    let (rows, error): (i64, Option<String>) = conn
      .query_row("SELECT COUNT(*), MAX(last_error) FROM sync_outbox", [], |row| {
        Ok((row.get(0)?, row.get(1)?))
      })
      .expect("read");
    assert_eq!(rows, 2, "NEITHER row may be deleted on a 200");
    assert_eq!(error.as_deref(), Some("payload is not an order"));
    server.finish();
  }

  /// The deadlock the task warns about: a 500 must NOT leave anything in
  /// `in_flight`, or the queue stops draining for the rest of the shift.
  #[test]
  fn a_500_returns_every_row_to_pending_and_leaves_none_in_flight() {
    let server = FakeServer::once(500, r#"{"code":"internal_error","message":"upstream down"}"#);
    let sink = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));
    let mut conn = db();

    let a = enqueue(&conn, "a", "ka");
    let b = enqueue(&conn, "b", "kb");

    tick(&mut conn, &sink);

    assert_eq!(status_of(&conn, a), "pending");
    assert_eq!(status_of(&conn, b), "pending");

    let stuck: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE status = 'in_flight'",
        [],
        |row| row.get(0),
      )
      .expect("count");
    assert_eq!(stuck, 0, "nothing may be stranded in in_flight");
    server.finish();
  }

  #[test]
  fn a_dead_server_returns_every_row_to_pending() {
    // Bind then drop, so the port is closed but was once ours.
    let port = {
      let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
      listener.local_addr().expect("addr").port()
    };
    let sink = HttpBatchSink::new(SyncConfig::new(format!("http://127.0.0.1:{port}"), "terminal-1", "branch-1"));
    let mut conn = db();

    let a = enqueue(&conn, "a", "ka");
    tick(&mut conn, &sink);

    assert_eq!(status_of(&conn, a), "pending");
  }

  /// The retry after a failed attempt must present the SAME per-command keys, so
  /// the server answers `duplicate` instead of applying the sale twice. This is
  /// the duplicate-order interceptor doing its job end to end.
  #[test]
  fn a_retry_reuses_the_same_command_keys_so_the_server_says_duplicate() {
    // Attempt 1: the server is unreachable.
    let dead = {
      let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
      listener.local_addr().expect("addr").port()
    };
    let failing = HttpBatchSink::new(SyncConfig::new(format!("http://127.0.0.1:{dead}"), "terminal-1", "branch-1"));
    let mut conn = db();

    let a = enqueue(&conn, "a", "idem-a");
    tick(&mut conn, &failing);
    assert_eq!(status_of(&conn, a), "pending", "the first attempt failed");

    // Attempt 2: the server is up, and has ALREADY applied this key — exactly
    // the lost-response case the idempotency keys exist for.
    let server = FakeServer::once(
      200,
      r#"{"results":[{"id":"a","outcome":"duplicate"}],
          "applied":0,"duplicates":1,"rejected":0,"pushed_at":"2026-10-05T12:05:00Z"}"#,
    );
    let working = HttpBatchSink::new(SyncConfig::new(server.url(), "terminal-1", "branch-1"));

    // The row only becomes due again once `next_attempt_at` has passed, which is
    // what proves attempt 1 actually rescheduled it rather than dropping it.
    let claimed = crate::sync_outbox::drain_tick(
      &mut conn,
      10,
      "2026-10-05T12:01:00Z",
      &mut |batch| working.push(batch),
    )
    .expect("drain");

    assert_eq!(claimed.len(), 1, "the retry must reach the server");
    assert_eq!(claimed[0].idempotency_key, "idem-a", "the SAME key as attempt 1");

    // `duplicate` is a success, so the row settles as done rather than looping
    // forever against a server that already has the sale.
    assert_eq!(status_of(&conn, a), "done");

    let captured = server.finish();
    assert_eq!(
      captured.idempotency_key.as_deref(),
      Some(batch_key("terminal-1", &claimed).as_str())
    );
  }
}
