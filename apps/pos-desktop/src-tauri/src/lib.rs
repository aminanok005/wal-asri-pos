//! Wal-Asri POS Desktop — Tauri 2 native core.
//!
//! This module is the **native adapter**, not the business layer. Per SKILL.md
//! §2.3 the Rust core (`src-tauri/src/`) must contain NO business rules: it
//! exposes primitives — an encrypted SQLite connection, the transactional
//! checkout, and (in a later phase) the ESC/POS printer bridge — and the
//! TypeScript domain layer in `src/features/**` decides what to do with them.
//!
//! Concretely, what lives here:
//!   - [`db`]: finding the SQLCipher key and opening the encrypted database, with
//!     the connection-level pragmas that a migration file cannot set.
//!   - [`migrate`]: forward-only schema application keyed on `PRAGMA user_version`.
//!   - [`commands`]: the three commands the frontend may call, and nothing else.
//!
//! What does NOT live here: tax rounding policy, cart arithmetic, promotion
//! eligibility, or any check that could be expressed in the domain layer. Those
//! are pure TypeScript and live under `src/features/`.
//!
//! ── Why there is no tauri-plugin-sql ─────────────────────────────────────────
//! It was here. SKILL.md §2.2 requires checkout to commit the sale and its outbox
//! event inside ONE transaction, and the plugin's frontend API (`db_execute`) is
//! a single statement per call with no transaction scope across calls — the
//! requirement is not expressible through it. Owning the driver directly
//! ([`db`]) is what makes the guarantee enforceable, and it is also why the
//! `sql:*` capabilities and the `plugins.sql.preload` config were removed: no
//! frontend-facing database API exists any more, so granting one would be dead
//! permission that implies a capability the app does not have.
//!
//! ── Why a Mutex and not a connection pool ───────────────────────────────────
//! `rusqlite` is a synchronous single-connection driver. The connection lives
//! behind one `Mutex` in Tauri's managed state, which serialises command
//! execution — and SQLite permits exactly one writer at a time regardless, so a
//! pool would buy nothing on a single-user till while adding a dependency and a
//! second, unobservable lock. Every command also runs inside
//! `spawn_blocking`, because a synchronous driver called straight from an async
//! command blocks the runtime's worker thread — on a single-threaded executor
//! that is the UI thread, which is how a 20 ms fsync becomes a visible stutter.

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

/// The managed state: the one connection to the terminal's encrypted database.
///
/// Not behind a pool, deliberately — see the module docs.
pub type AppState = Mutex<Connection>;

pub mod commands;
pub mod db;
pub mod migrate;
// The local StockBalance cache: parses a pulled snapshot's `Quantity` strings
// into exact milli-units and UPSERTs them, in one transaction, into the
// `stock_balances` table migration 0003 created. Quantities cross the Tauri
// bridge as strings for the same reason satang does — see the module header.
pub mod stock_balances;
// The local Recipe cache: exact milli-unit strings in, SQLite INTEGER columns out.
pub mod recipes;
// Strict CP874 encoding, shared by the coverage test and the byte compiler so
// the two cannot drift — the compiler must never be more permissive than the
// test that vouched for it. See src/cp874.rs.
pub mod cp874;
// ESC/POS byte compiler: ReceiptIr (JSON) -> Vec<u8>. Pure — no socket, no USB,
// no Tauri. The Thai column arithmetic it relies on is documented in the
// module header, including the correction to DOMAIN.md's "two bytes per Thai
// glyph" claim.
pub mod escpos;
// LAN printer transport (TCP) and the command that joins it to the compiler.
pub mod printer_commands;
pub mod printer_port;
// The local outbox state machine: pending → in_flight → done, plus the
// background drain that walks it. Pure SQLite state transitions — no HTTP — so
// the lifecycle is testable against a real migrated database. See the module
// header for why the key is transmitted raw and the states are lowercase.
pub mod sync_outbox;
// The HTTP transport for the drain: POST /api/v1/sync/push. Knows the wire
// format and nothing about the state machine; `sync_outbox::drain_tick` takes
// it as a closure, so the ledger logic stays testable without a socket.
pub mod sync_http;
// Terminal identity validator: UUIDv7 gate before any network call.
// Fail-fast at startup to prevent infinite HTTP 400 retry loops.
pub mod terminal_identity;
// Proves the receipt printer's code page can encode the Thai this POS actually
// uses — especially ๐–๙, which post-date windows-874 and were the likeliest
// unmappable characters. See the module for why this runs before any receipt.
pub mod thai_coverage;

/// How often the drain wakes to look for work.
///
/// 15 seconds: long enough that an idle till does no steady network chatter,
/// short enough that a shift's sales reach the back office while the manager is
/// still looking at the till.
const DRAIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// How many events one tick may claim.
///
/// Bounded because every tick holds the connection mutex that checkout also
/// needs; a backlog of a week must be drained in slices, not in one long lock.
const DRAIN_BATCH_LIMIT: i64 = 64;

/// Start the background outbox drain, IF this terminal has been told where the
/// backend is.
///
/// ── WHY IT IS OPT-IN RATHER THAN DEFAULTED ───────────────────────────────────
/// The app holds no server address, and inventing one — a localhost, a guessed
/// LAN IP, a placeholder host — would be worse than not starting at all: the
/// drain would claim rows, fail to reach a host that does not exist, and
/// reschedule them every 15 seconds for the life of the install.
///
/// So the address comes from the environment, and an unset variable means "this
/// terminal is not configured to sync yet", which is a legitimate state for a
/// shop whose server has not been deployed. Nothing is claimed, nothing is lost,
/// and the outbox waits — those rows are already durable in SQLite.
///
/// ── FAIL-FAST UUIDv7 VALIDATION ──────────────────────────────────────────────
/// `WAL_ASRI_TERMINAL_ID` and `WAL_ASRI_BRANCH_ID` are client-asserted.
/// An invalid UUIDv7 causes EVERY batch to be Refused (HTTP 400) by the server.
/// The drain treats Refused as RETRYABLE, so the same bad ID loops forever.
/// This function validates ONCE at startup and refuses to start the drain
/// if validation fails, logging the VARIABLE name for the operator to fix.
fn start_sync_drain(app: &tauri::AppHandle) {
    // 1. Validate identity BEFORE creating any HTTP client
    let identity = match crate::terminal_identity::load_and_validate() {
        Ok(id) => id,
        Err(e) => {
            log::error!(target: "sync_outbox", "drain will not start: {e}");
            return;
        }
    };

    // 2. Sync URL (optional — unset means "not configured to sync yet")
    let Ok(base_url) = std::env::var("WAL_ASRI_SYNC_URL") else {
        log::info!(target: "sync_outbox", "WAL_ASRI_SYNC_URL not set; drain idle until configured");
        return;
    };

    // 3. Create sink with VALIDATED identity
    let terminal_id = identity.terminal_id.clone();
    let branch_id = identity.branch_id.clone();
    let sink = std::sync::Arc::new(sync_http::HttpBatchSink::new(sync_http::SyncConfig::new(
        base_url.trim(),
        terminal_id.clone(), // guaranteed UUIDv7
        branch_id.clone(), // guaranteed UUIDv7
    )));

    log::info!(target: "sync_outbox", "offline outbox drain starting (terminal={})", terminal_id);

    sync_outbox::spawn_drain(
        app.clone(),
        DRAIN_INTERVAL,
        DRAIN_BATCH_LIMIT,
        move |batch| sink.push(batch),
    );
}

/// Entry point for both desktop and mobile (the `#[cfg_attr(mobile, ...)]`
/// attribute below is what the template emits; on desktop it is a no-op).
///
/// The builder chain is panic-safe: `.run(...).expect(...)` turns a setup failure
/// into a Tauri exit rather than a silent window with no database — a till that
/// opens to an error dialog the cashier cannot act on is worse than one that
/// refuses to start and leaves a log.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Logging first, so plugin-setup errors below are visible.
        //
        // Registered unconditionally. The practical difference between this and
        // `cfg!(debug_assertions)` is nil: `LevelFilter::Info` writes to stdout
        // plus the platform log, and a POS terminal that cannot be diagnosed from
        // its own logs is worse than one extra log line.
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            // Opened here rather than lazily on first command, so the database exists
            // before the frontend can issue a query against it and so a bad key or a
            // corrupt file is reported at launch instead of at the first sale.
            let conn = db::open_database(app.handle()).map_err(std::io::Error::other)?;
            app.manage(Mutex::new(conn));
            start_sync_drain(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_offline_order,
            commands::list_recent_orders,
            commands::apply_stock_balances,
            commands::apply_recipes,
            commands::request_order_void,
            commands::get_terminal_identity,
            commands::list_stock_conflicts,
            printer_commands::print_receipt,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
