//! Terminal identity validation — UUIDv7 gate before any network call.
//!
//! This is the POLICY LAYER for client-asserted identities. It exists because:
//!
//! 1. `WAL_ASRI_TERMINAL_ID` and `WAL_ASRI_BRANCH_ID` are client-asserted — the
//!    server has NO terminal registry in this revision. A malformed ID is not a
//!    server bug; it is a DEPLOYMENT CONFIGURATION BUG.
//!
//! 2. The drain runs every 15s. An invalid ID causes EVERY batch to be Refused
//!    (HTTP 400). The drain treats Refused as RETRYABLE (sync_http.rs:248-250),
//!    so the same bad ID is sent again, forever — the queue never drains.
//!
//! 3. The fix is FAIL FAST at STARTUP, not at the first push. The terminal must
//!    refuse to start the drain if the identity is invalid, and log the VARIABLE
//!    name so the operator knows which .env / systemd unit to fix.
//!
//! 4. Validation is SHARED with `get_terminal_identity` command (commands.rs)
//!    so the UI and the drain agree on what "valid" means. One copy of the rule.

use std::env;

/// Validated terminal identity, safe to use in envelope and headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedTerminalIdentity {
    pub terminal_id: String,
    pub branch_id: String,
}

/// Errors from identity validation — named by VARIABLE, not value.
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("{var} is not set; configure this terminal's identity in the launch environment")]
    Missing { var: &'static str },

    #[error("{var} must be a UUIDv7 (e.g. 0192f6c4-7c1e-7a3f-9b2d-4e6f8a1b2c3d); got {value:?}")]
    InvalidFormat { var: &'static str, value: String },
}

/// Load and validate both identities from environment.
///
/// Called ONCE at startup in `start_sync_drain`. If this fails, the drain
/// does not start and the error is logged with the variable name.
pub fn load_and_validate() -> Result<ValidatedTerminalIdentity, IdentityError> {
    let terminal_id = validate_one("WAL_ASRI_TERMINAL_ID", env::var("WAL_ASRI_TERMINAL_ID"))?;
    let branch_id = validate_one("WAL_ASRI_BRANCH_ID", env::var("WAL_ASRI_BRANCH_ID"))?;
    Ok(ValidatedTerminalIdentity { terminal_id, branch_id })
}

/// Load and validate from provided values (for testing and command reuse).
pub fn load_and_validate_from_values(
    terminal_id: Option<&str>,
    branch_id: Option<&str>,
) -> Result<ValidatedTerminalIdentity, IdentityError> {
    let terminal_id = validate_value("WAL_ASRI_TERMINAL_ID", terminal_id)?;
    let branch_id = validate_value("WAL_ASRI_BRANCH_ID", branch_id)?;
    Ok(ValidatedTerminalIdentity { terminal_id, branch_id })
}

fn validate_one(var: &'static str, value: Result<String, env::VarError>) -> Result<String, IdentityError> {
    let value = value
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .ok_or(IdentityError::Missing { var })?;

    if !is_uuid_v7(&value) {
        return Err(IdentityError::InvalidFormat { var, value });
    }
    Ok(value)
}

fn validate_value(var: &'static str, value: Option<&str>) -> Result<String, IdentityError> {
    let value = value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(IdentityError::Missing { var })?
        .to_owned();

    if !is_uuid_v7(&value) {
        return Err(IdentityError::InvalidFormat { var, value });
    }
    Ok(value)
}

/// UUIDv7 shape check: 8-4-4-4-12, hex, version nibble '7', variant nibble 8/9/a/b.
/// Mirrors `is_uuid_v7` in commands.rs and Go's `identity.ParseUUIDv7`.
/// Single-byte scanner loop — no regex, no allocation, exact character-by-character.
pub fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        match i {
            // Hyphen positions: 8, 13, 18, 23 (0-indexed)
            8 | 13 | 18 | 23 => {
                if *b != b'-' {
                    return false;
                }
            }
            // Version nibble at index 14 (the '7' in UUIDv7)
            14 => {
                if *b != b'7' {
                    return false;
                }
            }
            // Variant nibble at index 19 (RFC 9562 variant 10xx = 8/9/a/b)
            19 => {
                if !matches!(b, b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
                    return false;
                }
            }
            // All other positions must be hex digits
            _ => {
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    const VALID_TERMINAL: &str = "01a12114-8a57-7059-b37d-846d70a3d482";
    const VALID_BRANCH: &str = "01a12114-8a57-7057-86c4-391860945134";

    #[test]
    fn valid_ids_pass() {
        let id = load_and_validate_from_values(Some(VALID_TERMINAL), Some(VALID_BRANCH))
            .expect("valid ids");
        assert_eq!(id.terminal_id, VALID_TERMINAL);
        assert_eq!(id.branch_id, VALID_BRANCH);
    }

    #[test]
    fn missing_terminal_names_variable() {
        let err = load_and_validate_from_values(None, Some(VALID_BRANCH))
            .expect_err("missing terminal");
        assert!(matches!(err, IdentityError::Missing { var } if var == "WAL_ASRI_TERMINAL_ID"));
    }

    #[test]
    fn blank_terminal_is_missing() {
        let err = load_and_validate_from_values(Some("   "), Some(VALID_BRANCH))
            .expect_err("blank terminal");
        assert!(matches!(err, IdentityError::Missing { .. }));
    }

    #[test]
    fn uuidv4_rejected() {
        let err = load_and_validate_from_values(
            Some("550e8400-e29b-41d4-a716-446655440000"),
            Some(VALID_BRANCH),
        ).expect_err("uuidv4");
        assert!(matches!(err, IdentityError::InvalidFormat { var, .. } if var == "WAL_ASRI_TERMINAL_ID"));
    }

    #[test]
    fn wrong_version_nibble_rejected() {
        let err = load_and_validate_from_values(
            Some("01a12114-8a57-4059-b37d-846d70a3d482"),
            Some(VALID_BRANCH),
        ).expect_err("version nibble");
        assert!(matches!(err, IdentityError::InvalidFormat { var, .. } if var == "WAL_ASRI_TERMINAL_ID"));
    }

    #[test]
    fn wrong_variant_nibble_rejected() {
        let err = load_and_validate_from_values(
            Some("01a12114-8a57-7059-0b7d-846d70a3d482"),
            Some(VALID_BRANCH),
        ).expect_err("variant nibble");
        assert!(matches!(err, IdentityError::InvalidFormat { var, .. } if var == "WAL_ASRI_TERMINAL_ID"));
    }

    #[test]
    fn uppercase_variant_accepted() {
        let id = load_and_validate_from_values(
            Some("01a12114-8a57-7059-Bb7d-846d70a3d482"),
            Some(VALID_BRANCH),
        ).expect("uppercase variant");
        assert_eq!(id.terminal_id, "01a12114-8a57-7059-Bb7d-846d70a3d482");
    }

    #[test]
    fn wrong_length_rejected() {
        let err = load_and_validate_from_values(
            Some("01a12114-8a57-7059-b37d"),
            Some(VALID_BRANCH),
        ).expect_err("wrong length");
        assert!(matches!(err, IdentityError::InvalidFormat { .. }));
    }

    #[test]
    fn non_hex_rejected() {
        let err = load_and_validate_from_values(
            Some("01a12114-8a57-7059-b37d-846d70a3d48g"),
            Some(VALID_BRANCH),
        ).expect_err("non-hex");
        assert!(matches!(err, IdentityError::InvalidFormat { .. }));
    }

    #[test]
    fn load_from_values_valid() {
        let id = load_and_validate_from_values(Some(VALID_TERMINAL), Some(VALID_BRANCH))
            .expect("valid values");
        assert_eq!(id.terminal_id, VALID_TERMINAL);
        assert_eq!(id.branch_id, VALID_BRANCH);
    }

    #[test]
    fn load_from_values_missing() {
        let err = load_and_validate_from_values(None, Some(VALID_BRANCH))
            .expect_err("missing terminal");
        assert!(matches!(err, IdentityError::Missing { var } if var == "WAL_ASRI_TERMINAL_ID"));
    }

    #[test]
    fn load_from_values_blank() {
        let err = load_and_validate_from_values(Some("   "), Some(VALID_BRANCH))
            .expect_err("blank terminal");
        assert!(matches!(err, IdentityError::Missing { .. }));
    }

    #[test]
    fn is_uuid_v7_direct_valid() {
        assert!(is_uuid_v7("01a12114-8a57-7059-b37d-846d70a3d482"));
        assert!(is_uuid_v7("0192f6c4-7c1e-7a3f-9b2d-4e6f8a1b2c3d"));
    }

    #[test]
    fn is_uuid_v7_direct_invalid_version() {
        assert!(!is_uuid_v7("01a12114-8a57-4059-b37d-846d70a3d482")); // version 4
        assert!(!is_uuid_v7("01a12114-8a57-1059-b37d-846d70a3d482")); // version 1
    }

    #[test]
    fn is_uuid_v7_direct_invalid_variant() {
        assert!(!is_uuid_v7("01a12114-8a57-7059-0b7d-846d70a3d482")); // variant 0
        assert!(!is_uuid_v7("01a12114-8a57-7059-cb7d-846d70a3d482")); // variant c
    }

    #[test]
    fn is_uuid_v7_direct_wrong_hyphens() {
        assert!(!is_uuid_v7("01a121148a577059b37d846d70a3d482")); // no hyphens
        assert!(!is_uuid_v7("01a12114_8a57_7059_b37d_846d70a3d482")); // underscores
    }
}