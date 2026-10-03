//! SQLCipher key management — where the key comes from, and nowhere else.
//!
//! The key is the one piece of state that decides whether the terminal's sales
//! are readable by anything at all, so its source is deliberate and small:
//!
//! 1. `WAL_ASRI_DB_KEY` environment variable, if set. A 64-hex-character string
//!    is decoded to 32 bytes. This is the CI and the test path: a runner has no
//!    app config dir to write to, and a fixed test value keeps the keyfile path
//!    unexercised so the encryption proof is about the *file*, not the *key*.
//! 2. Otherwise, a random 32-byte key is generated once and written to a
//!    `0600` file in Tauri's app config directory. The file is the key: it is
//!    read back on every open, and deleting it deletes the ability to read the
//!    database. That is the offline-safe trade the plan asks for — no OS
//!    keychain, no D-Bus, nothing that fails headless.
//!
//! The key is **never** logged, never embedded in a payload, and never written
//! anywhere but this file. A key that appears in a log is a key that appears in
//! a support archive.

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use getrandom::getrandom;

/// 32 bytes, as the SQLCipher `PRAGMA key` expects them: hex-encoded.
const KEY_BYTES: usize = 32;
const KEY_HEX_LEN: usize = KEY_BYTES * 2;

/// A resolved database key plus the path of the file that backs it.
pub struct DbKey {
  hex: String,
  db_path: PathBuf,
}

impl DbKey {
  /// Resolve the key from the environment or the key file, generating one if
  /// neither exists yet.
  ///
  /// `app_config_dir` is the directory Tauri would use for the app's config;
  /// it is passed in so this module stays free of `std::env::home_dir` and
  /// stays testable on a machine with no home directory.
  pub fn resolve(app_config_dir: PathBuf) -> Self {
    if let Ok(raw) = std::env::var("WAL_ASRI_DB_KEY") {
      let hex = normalise_hex(&raw).unwrap_or_else(|| {
        panic!(
          "WAL_ASRI_DB_KEY must be exactly {KEY_HEX_LEN} hex characters, got {}",
          raw.len()
        )
      });
      return DbKey {
        hex,
        db_path: app_config_dir.join("wal_asri_pos.db"),
      };
    }

    fs::create_dir_all(&app_config_dir).expect("failed to create app config dir");
    let key_path = app_config_dir.join("wal_asri_pos.db.key");
    let db_path = app_config_dir.join("wal_asri_pos.db");

    let hex = if key_path.exists() {
      let bytes = fs::read(&key_path).expect("failed to read key file");
      if bytes.len() != KEY_BYTES {
        panic!(
          "key file {} holds {} bytes, expected {KEY_BYTES}",
          key_path.display(),
          bytes.len()
        )
      }
      encode_hex(&bytes)
    } else {
      let bytes = random_bytes();
      let hex = encode_hex(&bytes);
      write_key_file(&key_path, &bytes);
      hex
    };

    DbKey { hex, db_path }
  }

  /// The hex string handed to `PRAGMA key = '...'`.
  pub fn as_hex(&self) -> &str {
    &self.hex
  }

  /// Path to the database file this key opens.
  pub fn db_path(&self) -> PathBuf {
    self.db_path.clone()
  }
}

/// Accept `0x`-prefixed or whitespace-trimmed hex; reject anything else.
fn normalise_hex(raw: &str) -> Option<String> {
  let trimmed = raw.trim();
  let stripped = trimmed.strip_prefix("0x").unwrap_or(trimmed);
  if stripped.len() != KEY_HEX_LEN {
    return None;
  }
  if !stripped.bytes().all(|b| b.is_ascii_hexdigit()) {
    return None;
  }
  Some(stripped.to_ascii_lowercase())
}

/// 32 cryptographically-random bytes. Panics only if the OS has no entropy
/// source at all, which on a live terminal means the machine is broken.
fn random_bytes() -> [u8; KEY_BYTES] {
  let mut bytes = [0u8; KEY_BYTES];
  getrandom(&mut bytes).expect("failed to generate database key");
  bytes
}

/// Encode bytes as lowercase hex, without pulling in a crate.
fn encode_hex(bytes: &[u8]) -> String {
  const TABLE: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(bytes.len() * 2);
  for &b in bytes {
    out.push(TABLE[(b >> 4) as usize] as char);
    out.push(TABLE[(b & 0xf) as usize] as char);
  }
  out
}

/// Write the key file with `0600` permissions: readable only by the owner.
///
/// A `0644` key file would put the terminal's sales on the same footing as any
/// other user's home directory, which is not what "encrypted" means here.
fn write_key_file(path: &PathBuf, bytes: &[u8]) {
  let mut file = fs::File::create(path).expect("failed to create key file");
  file.write_all(bytes).expect("failed to write key file");

  let mut perms = file.metadata().unwrap().permissions();
  perms.set_mode(0o600);
  fs::set_permissions(path, perms).expect("failed to set key file permissions");
}

// `io` is used only by the unused-import guard below; kept explicit so a reader
// sees the one dependency this module pulls in beyond `std::fs`.
#[allow(unused_imports)]
use io::Error;