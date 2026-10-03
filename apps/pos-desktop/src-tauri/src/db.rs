//! Opening the terminal's local database, and keeping its key.
//!
//! ── What lives here ──────────────────────────────────────────────────────────
//! Exactly two responsibilities, both irreducibly native:
//!
//!   1. Finding (or first-run generating) the SQLCipher key.
//!   2. Opening the encrypted file and applying the connection-level pragmas.
//!
//! No business logic (SKILL.md §2.3). This module does not know what an order is,
//! what a satang means beyond "pass it through", or what the tax rate is. It is
//! the adapter; the TypeScript domain decides what to write through it.
//!
//! ── Why the connection pragmas live HERE and not in the migration ────────────
//! `PRAGMA foreign_keys = ON` is a **no-op inside a transaction**, and wrapping
//! each migration file in a transaction is the correct design (an interrupted
//! migration must not leave a half-built schema). SQLite applies foreign-key
//! pragmas per transaction, so the check at `migrations/0001_init.sql:92` never
//! took effect and foreign-key enforcement has been silently OFF. Setting it per
//! connection, once, at open time is the only place it is guaranteed to bind.
//!
//! `PRAGMA synchronous = FULL` is the other one that matters. A POS terminal is
//! powered off mid-shift as a matter of course; at the default `NORMAL`, a power
//! cut can lose the last commits — and those commits are money already taken from
//! a customer. FULL fsyncs on every commit.
//!
//! ── Why the key is a random key, not a passphrase ────────────────────────────
//! SQLCipher accepts either. A passphrase runs PBKDF2 (256,000 iterations by
//! default) on every open, which buys nothing here: the input is already 32 bytes
//! of OS randomness, so there is no low-entropy guess for the KDF to slow down.
//! We use the raw-key form `PRAGMA key = "x'<64 hex chars>'"`, skipping the KDF.
//! Consequence to know: no salt or iteration count is stored, so a future
//! passphrase-based key would be a *different* key, not a re-derivation.
//!
//! ── Honest limits of storing the key beside the database ────────────────────
//! The key file sits in the same `0700` directory as the `.db`. That defeats the
//! realistic threat — someone who steals the database file alone — and keeps the
//! terminal working offline with no daemon, no D-Bus and no OS keychain (which
//! Linux desktops frequently lack, and which CI certainly does not). It does NOT
//! defend against an attacker who already has the OS account: they can read both
//! files. A real deployment should take the key from the keychain or a secret
//! manager and leave only `WAL_ASRI_DB_KEY` in place.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use tauri::{AppHandle, Manager};

/// Bytes in a SQLCipher key. 32 is AES-256's key size.
pub const KEY_BYTES: usize = 32;

/// Environment variable that overrides the on-disk key file.
pub const KEY_ENV: &str = "WAL_ASRI_DB_KEY";

/// The database file name, inside `app_data_dir()`.
pub const DB_FILE_NAME: &str = "wal_asri_pos.db";

/// Anything that can go wrong between "app launched" and "connection open".
#[derive(Debug)]
pub enum DbError {
  /// No app data directory (headless test, or a platform without one).
  NoAppDataDir,
  /// The key could not be read, generated, or written.
  Key(String),
  /// The database file could not be opened, or the key did not fit it.
  Open(String),
}

impl std::fmt::Display for DbError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      DbError::NoAppDataDir => write!(f, "no application data directory is available"),
      DbError::Key(why) => write!(f, "sqlcipher key unavailable: {why}"),
      DbError::Open(why) => write!(f, "local database unavailable: {why}"),
    }
  }
}

impl std::error::Error for DbError {}

/// Which of the two SQLCipher key forms a given key is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyMaterial {
  /// Exactly `KEY_BYTES` of entropy. Used as `x'<hex>'`, skipping PBKDF2.
  Raw(Vec<u8>),
  /// Arbitrary text. Used as a quoted passphrase, running PBKDF2.
  Passphrase(String),
}

impl KeyMaterial {
  /// The literal to splice into `PRAGMA key = …`.
  ///
  /// Passphrases are SQL string-literal escaped. Not belt-and-braces: an
  /// unescaped passphrase is an injection point in a statement that runs before
  /// any validation exists.
  pub fn pragma_literal(&self) -> String {
    match self {
      KeyMaterial::Raw(bytes) => format!("\"x'{}'\"", to_hex(bytes)),
      KeyMaterial::Passphrase(text) => format!("'{}'", text.replace('\'', "''")),
    }
  }
}

fn to_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode exactly 64 hex characters into 32 bytes. `None` for anything else,
/// which is how the caller decides whether an override is a raw key.
fn hex_to_bytes(input: &str) -> Option<Vec<u8>> {
  if input.len() != KEY_BYTES * 2 || !input.chars().all(|c| c.is_ascii_hexdigit()) {
    return None;
  }
  (0..KEY_BYTES)
    .map(|i| u8::from_str_radix(&input[i * 2..i * 2 + 2], 16).ok())
    .collect()
}

/// Classify a key string: 64 hex characters is a raw key, anything else is a
/// passphrase.
fn classify_key_material(input: &str) -> KeyMaterial {
  let trimmed = input.trim();
  match hex_to_bytes(trimmed) {
    Some(bytes) => KeyMaterial::Raw(bytes),
    None => KeyMaterial::Passphrase(trimmed.to_owned()),
  }
}

/// The app data directory: where the database, its key, and both live.
pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, DbError> {
  app
    .path()
    .app_data_dir()
    .map_err(|e| DbError::Key(format!("app_data_dir: {e}")))
}

/// `wal_asri_pos.db.key`, beside the database.
fn key_file_path(dir: &Path) -> PathBuf {
  dir.join(format!("{DB_FILE_NAME}.key"))
}

/// Resolve the key: environment override first, then the key file, generating
/// one on first run.
pub fn resolve_key(app: &AppHandle) -> Result<KeyMaterial, DbError> {
  if let Ok(from_env) = std::env::var(KEY_ENV) {
    if !from_env.trim().is_empty() {
      log::warn!("using SQLCipher key from {KEY_ENV}; the key file is not read this session");
      return Ok(classify_key_material(&from_env));
    }
  }

  let dir = app_data_dir(app)?;
  let path = key_file_path(&dir);

  match fs::read(&path) {
    Ok(bytes) if bytes.len() == KEY_BYTES => Ok(KeyMaterial::Raw(bytes)),
    Ok(bytes) => Err(DbError::Key(format!(
      "{} holds {} bytes, expected {KEY_BYTES}; refusing to open the database with a key of the \
       wrong length",
      path.display(),
      bytes.len()
    ))),
    Err(_) => {
      fs::create_dir_all(&dir).map_err(|e| DbError::Key(e.to_string()))?;
      harden_dir(&dir)?;
      let mut key = vec![0u8; KEY_BYTES];
      getrandom::fill(&mut key).map_err(|e| DbError::Key(e.to_string()))?;
      fs::write(&path, &key).map_err(|e| DbError::Key(e.to_string()))?;
      harden_file(&path)?;
      log::info!("generated a new {KEY_BYTES}-byte SQLCipher key at {}", path.display());
      Ok(KeyMaterial::Raw(key))
    }
  }
}

/// `0700` on the directory. Applied to an existing directory too, so a
/// world-readable one left by an earlier version is tightened on next launch.
fn harden_dir(dir: &Path) -> Result<(), DbError> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
      .map_err(|e| DbError::Key(e.to_string()))?;
  }
  Ok(())
}

/// `0600` on the key file.
fn harden_file(path: &Path) -> Result<(), DbError> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
      .map_err(|e| DbError::Key(e.to_string()))?;
  }
  Ok(())
}

/// Open (creating if absent) the encrypted terminal database, fully migrated.
///
/// The one entry point every other module uses. The connection returned is
/// already keyed, already enforcing foreign keys, and already at
/// `synchronous = FULL` — none of which a caller can forget, because there is no
/// other way in.
pub fn open_database(app: &AppHandle) -> Result<Connection, DbError> {
  let dir = app_data_dir(app)?;
  fs::create_dir_all(&dir).map_err(|e| DbError::Open(e.to_string()))?;
  harden_dir(&dir)?;

  let path = dir.join(DB_FILE_NAME);
  let key = resolve_key(app)?;

  // Under `app_data_dir()` rather than the working directory: a terminal
  // launched from a desktop entry, a terminal emulator, or a systemd unit all
  // have different working directories, and a database that lands in a
  // different place depending on how the app was started is a database that
  // silently disappears between shifts.
  //
  // NO_MUTEX because the connection is handed out behind a `Mutex` already, and
  // rusqlite's own mutex would be a second, unobservable lock. CREATE because a
  // terminal in airplane mode on a fresh machine must make its own database.
  let mut conn = Connection::open_with_flags(
    &path,
    OpenFlags::SQLITE_OPEN_READ_WRITE
      | OpenFlags::SQLITE_OPEN_CREATE
      | OpenFlags::SQLITE_OPEN_NO_MUTEX,
  )
  .map_err(|e| DbError::Open(format!("{}: {e}", path.display())))?;

  // MUST be the first statement on the connection: SQLCipher refuses a key set
  // after the database has been read. rusqlite's open path runs no user SQL, so
  // this is first.
  //
  // A wrong key does not fail HERE — SQLCipher stores it and only reports "file
  // is not a database" on the first read, which `apply_pragmas` immediately is.
  // That is why the message below is about a rejected key and the one after is
  // about a corrupt file; they are the same user mistake with different causes.
  conn
    .execute_batch(&format!("PRAGMA key = {};", key.pragma_literal()))
    .map_err(|e| DbError::Open(format!("sqlcipher rejected the key: {e}")))?;

  apply_pragmas(&conn)?;
  crate::migrate::migrate(&mut conn).map_err(|e| DbError::Open(e.to_string()))?;

  log::info!("local database open at {}", path.display());
  Ok(conn)
}

/// Connection-level pragmas. See the module docs for why each one is here.
fn apply_pragmas(conn: &Connection) -> Result<(), DbError> {
  // WAL: the database survives a power cut mid-write, and a read can proceed
  // while a write is in flight.
  conn
    .pragma_update(None, "journal_mode", "WAL")
    .map_err(|e| DbError::Open(format!("journal_mode: {e}")))?;

  // The money rule. A checkout that returned "committed" to the cashier is a
  // sale that happened; losing it to a power cut is not recoverable.
  conn
    .pragma_update(None, "synchronous", "FULL")
    .map_err(|e| DbError::Open(format!("synchronous: {e}")))?;

  // The fix for migrations/0001_init.sql:92. Per connection, never in a migration.
  conn
    .pragma_update(None, "foreign_keys", "ON")
    .map_err(|e| DbError::Open(format!("foreign_keys: {e}")))?;

  // Wait rather than fail if the file is momentarily locked. A single terminal
  // should never contend with itself, so hitting this means something else holds
  // the file — worth waiting a few seconds for, not worth losing a sale over.
  conn
    .busy_timeout(std::time::Duration::from_secs(5))
    .map_err(|e| DbError::Open(format!("busy_timeout: {e}")))?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_raw_key_becomes_the_x_quoted_literal_that_skips_pbkdf2() {
    let key = KeyMaterial::Raw(vec![0xab; KEY_BYTES]);
    assert_eq!(key.pragma_literal(), format!("\"x'{}'\"", "ab".repeat(KEY_BYTES)));
  }

  #[test]
  fn a_passphrase_is_quoted_as_a_sql_string_literal() {
    assert_eq!(KeyMaterial::Passphrase("hunter2".into()).pragma_literal(), "'hunter2'");
  }

  #[test]
  fn a_passphrase_containing_a_quote_is_escaped_not_interpolated() {
    // The injection case: unescaped, `'; DROP TABLE local_orders; --` closes
    // the literal and runs as SQL, before any validation exists.
    assert_eq!(
      KeyMaterial::Passphrase("'; DROP TABLE local_orders; --".into()).pragma_literal(),
      "'''; DROP TABLE local_orders; --'"
    );
  }

  #[test]
  fn exactly_64_hex_characters_classify_as_a_raw_key() {
    assert!(matches!(
      classify_key_material(&"a".repeat(64)),
      KeyMaterial::Raw(_)
    ));
  }

  #[test]
  fn a_wrong_length_hex_string_is_a_passphrase_not_a_truncated_raw_key() {
    // 63 hex chars is one byte short. Treating it as a raw key would silently
    // open the database with a key that is not the key.
    assert!(matches!(
      classify_key_material(&"a".repeat(63)),
      KeyMaterial::Passphrase(_)
    ));
  }

  #[test]
  fn surrounding_whitespace_does_not_change_the_classification() {
    assert!(matches!(
      classify_key_material(&format!("  {}  \n", "f0".repeat(32))),
      KeyMaterial::Raw(_)
    ));
  }

  #[test]
  fn hex_to_bytes_rejects_wrong_lengths_and_non_hex() {
    assert_eq!(hex_to_bytes(&"00".repeat(32)).map(|b| b.len()), Some(KEY_BYTES));
    assert!(hex_to_bytes(&"00".repeat(31)).is_none());
    assert!(hex_to_bytes(&"zz".repeat(32)).is_none());
  }

  /// THE ENCRYPTION PROOF.
  ///
  /// A SQLite file begins with the literal ASCII `SQLite format 3`. SQLCipher
  /// replaces that header with random bytes, so the header alone distinguishes an
  /// encrypted file from a plaintext one — no key, no guessing. If this test
  /// ever fails, the terminal is writing every customer order in the clear, and
  /// every comment in `offlineOrders.ts` calling this database "SQLCipher-encrypted"
  /// is a lie.
  ///
  /// It is deliberately a round-trip through the filesystem rather than a check
  /// on a compiled symbol list: a feature flag being present in `Cargo.toml`
  /// proves nothing about what `libsqlite3-sys` was actually built with.
  #[test]
  fn a_written_database_has_no_plaintext_sqlite_header() {
    let path = std::env::temp_dir().join(format!("wasri-cipher-proof-{}.db", std::process::id()));
    let _ = fs::remove_file(&path);

    {
      let conn = Connection::open(&path).expect("create the database file");
      conn
        .execute_batch(&format!("PRAGMA key = {};", KeyMaterial::Raw(vec![0x42; KEY_BYTES]).pragma_literal()))
        .expect("apply the key");
      conn
        .execute_batch("CREATE TABLE proof (a INTEGER); INSERT INTO proof VALUES (1);")
        .expect("write a row");
    }

    let bytes = fs::read(&path).expect("read the database file back");
    assert!(
      bytes.len() > 15,
      "a SQLCipher database is still a real file; {} bytes is too small to be one",
      bytes.len()
    );
    assert_ne!(
      &bytes[..15],
      b"SQLite format 3",
      "the file starts with a plaintext SQLite header: SQLCipher is NOT compiled in, and \
       every order written by this terminal is readable without the key"
    );

    let _ = fs::remove_file(&path);
  }

  /// The flip side: a file written with one key must not open with another.
  /// Without this, the header check above would also pass for a build where the
  /// key is accepted and then ignored.
  #[test]
  fn a_key_is_actually_required_to_read_the_database() {
    let path = std::env::temp_dir().join(format!("wasri-cipher-keyproof-{}.db", std::process::id()));
    let _ = fs::remove_file(&path);

    {
      let conn = Connection::open(&path).expect("create the database file");
      conn
        .execute_batch(&format!("PRAGMA key = {};", KeyMaterial::Raw(vec![0x42; KEY_BYTES]).pragma_literal()))
        .expect("apply the key");
      conn.execute_batch("CREATE TABLE proof (a INTEGER);").expect("write schema");
    }

    // Right key: opens.
    let opened = Connection::open(&path)
      .and_then(|c| {
        c.execute_batch(&format!("PRAGMA key = {};", KeyMaterial::Raw(vec![0x42; KEY_BYTES]).pragma_literal()))?;
        c.query_row("SELECT COUNT(*) FROM proof", [], |r| r.get::<_, i64>(0))
      });
    assert!(opened.is_ok(), "the correct key must open the database");

    // Wrong key: must not.
    let refused = Connection::open(&path).and_then(|c| {
      c.execute_batch(&format!("PRAGMA key = {};", KeyMaterial::Raw(vec![0x43; KEY_BYTES]).pragma_literal()))?;
      c.query_row("SELECT COUNT(*) FROM proof", [], |r| r.get::<_, i64>(0))
    });
    assert!(
      refused.is_err(),
      "a wrong key opened the database: the key is being accepted and ignored, which is worse \
       than no encryption because it looks like it works"
    );

    let _ = fs::remove_file(&path);
  }
}