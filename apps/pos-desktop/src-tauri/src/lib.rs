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
//!   - [`commands`]: the two commands the frontend may call, and nothing else.
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
// Proves the receipt printer's code page can encode the Thai this POS actually
// uses — especially ๐–๙, which post-date windows-874 and were the likeliest
// unmappable characters. See the module for why this runs before any receipt.
pub mod thai_coverage;

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
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .setup(|app| {
      // Opened here rather than lazily on first command, so the database exists
      // before the frontend can issue a query against it and so a bad key or a
      // corrupt file is reported at launch instead of at the first sale.
      let conn = db::open_database(app.handle()).map_err(std::io::Error::other)?;
      app.manage(Mutex::new(conn));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::save_offline_order,
      commands::list_recent_orders,
      printer_commands::print_receipt,
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}