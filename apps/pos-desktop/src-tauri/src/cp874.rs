//! Strict CP874 (windows-874) encoding — the one place a receipt string becomes
//! printer bytes.
//!
//! WHY A DEDICATE MODULE
//!
//! Two things need to turn Thai text into bytes: the coverage test that proves
//! the code page *can* express our characters, and the byte compiler that
//! actually prints them. If each held its own copy of the encoding call, they
//! would drift — and the dangerous direction is the compiler quietly becoming
//! more permissive than the test that vouched for it. So there is exactly one
//! `encode_strict`, and both callers share it.
//!
//! WHY "STRICT" IS THE ONLY CORRECT BEHAVIOUR HERE
//!
//! `Encoding::encode()` substitutes unmappable characters with an HTML numeric
//! character reference — a coffee emoji becomes the eight literal ASCII bytes
//! `&#9749;` — and returns those bytes in the output. That is eight columns of
//! garbage in the middle of a customer's line items. It does set a `had_errors`
//! flag, but the flag arrives after the mangled bytes are already in the
//! caller's buffer, so correctness becomes "did every call site remember to
//! check?", which is a question no type system answers.
//!
//! Strict encoding removes the question: on an unmappable character, return
//! `Err` and print nothing. A receipt that does not appear is a visible,
//! recoverable annoyance. A receipt with corrupt totals is neither.

use encoding_rs::{EncoderResult, WINDOWS_874};
use serde::{Deserialize, Serialize};

/// The exact code page the printer is switched into before any text is sent.
///
/// `ESC t 20` is the Thai code-page selector. It is model-dependent: the byte
/// value for "Thai" is a per-printer constant, not a universal, so it lives
/// here as one named constant rather than as a literal buried in the byte
/// stream. If a target printer disagrees, this is the single line to change —
/// and the Gate B tests assert against these constants, so a change is visible.
pub const THAI_CODE_PAGE_SELECT: &[u8] = b"\x1b\x74\x14";

/// Why a string could not be printed.
///
/// Carries the offending character so the caller can log *which* menu item
/// needs fixing, rather than just "printing failed".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnmappableCharacter {
  /// The character with no CP874 representation.
  pub character: char,
  /// U+XXXX, for a log line that survives copy-paste.
  pub codepoint: String,
}

/// Encode UTF-8 to CP874, refusing anything that cannot be represented.
///
/// Returns `Err` — never a lossy encoding. See the module docs for why.
///
/// The `*_without_replacement` methods exist only on `Encoder`, not on
/// `Encoding`, because the strict contract is inherently streaming: the encoder
/// reports `OutputFull` when the buffer fills and expects the caller to feed
/// back the unconsumed tail. That is why there is a loop below rather than a
/// one-line call.
///
/// A fresh `Encoder` per call is deliberate. The crate documents an `Encoder`
/// as single-use once its stream ends, so one per string avoids leaking state
/// between two customers' receipts.
pub fn encode_strict(text: &str) -> Result<Vec<u8>, UnmappableCharacter> {
  let mut encoder = WINDOWS_874.new_encoder();
  let mut out: Vec<u8> = Vec::with_capacity(text.len());
  let mut remaining = text;

  loop {
    // `last = true` marks the end of the stream, so `InputEmpty` means
    // "finished" rather than "call me again with more input".
    let (result, read) =
      encoder.encode_from_utf8_to_vec_without_replacement(remaining, &mut out, true);

    // Advance by what was actually consumed BEFORE matching the result: on
    // `OutputFull` the tail is unconsumed and must be re-fed, and doing this
    // first is what keeps that path from silently dropping text.
    remaining = &remaining[read..];

    match result {
      EncoderResult::InputEmpty => return Ok(out),
      EncoderResult::OutputFull => out.reserve(text.len() + 8),
      EncoderResult::Unmappable(character) => {
        return Err(UnmappableCharacter {
          character,
          codepoint: format!("U+{:04X}", character as u32),
        })
      }
    }
  }
}

/// The printable width of an 80mm receipt, in character cells.
///
/// DERIVED, NOT GUESSED: an 80mm roll has a 72mm printable width. At 203 dpi
/// one dot is 0.125mm, so Font A's 12-dot character cell is 1.5mm, and
/// 72 / 1.5 = 48 columns.
///
/// This is the number column arithmetic must use, because ESC/POS moves the
/// print head in character cells and knows nothing about Unicode.
pub const COLUMNS_80MM: usize = 48;

/// The display width of a string in printer character cells.
///
/// WHY THIS EQUALS THE CP874 BYTE COUNT
///
/// In a single-byte code page every character — Thai, ASCII, ฿ — occupies
/// exactly one byte and therefore exactly one cell. That is the whole reason
/// the layout layer can count bytes instead of guessing at character widths.
///
/// NOTE ON WHAT THIS DOES *NOT* DO: see the Thai reordering note in
/// `escpos.rs`. Byte width is settled; visual stacking of marks is the
/// printer's font, not this function's job.
pub fn display_width(text: &str) -> usize {
  encode_strict(text).map(|b| b.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
  use super::{display_width, encode_strict, COLUMNS_80MM};

  #[test]
  fn a_plain_ascii_string_encodes_to_itself() {
    assert_eq!(encode_strict("OK").unwrap(), b"OK");
  }

  #[test]
  fn thai_and_ascii_occupy_one_column_each() {
    // Four Thai code points, one column each — the fact the whole layout layer
    // depends on.
    assert_eq!(display_width("เกาะ"), 4);
    assert_eq!(display_width("น้ำ"), 3);
    assert_eq!(display_width("TOTAL 45.50"), 11);
  }

  #[test]
  fn the_baht_sign_is_the_byte_df() {
    // Locked to the real CP874 value. An earlier draft of this file assumed
    // 0xA0, which is a Windows-1252 code point — a test that passes for the
    // wrong reason is worse than no test, so the exact value is asserted.
    assert_eq!(encode_strict("฿").unwrap(), vec![0xDF]);
  }

  #[test]
  fn an_unmappable_character_names_itself() {
    let err = encode_strict("ชา ☕").unwrap_err();
    assert_eq!(err.character, '☕');
    assert_eq!(err.codepoint, "U+2615");
  }

  #[test]
  fn an_empty_string_is_zero_columns() {
    assert_eq!(display_width(""), 0);
  }

  #[test]
  fn the_column_count_is_forty_eight() {
    assert_eq!(COLUMNS_80MM, 48);
  }
}
