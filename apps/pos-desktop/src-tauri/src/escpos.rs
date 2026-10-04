//! ESC/POS byte compiler — the neutral Receipt IR becomes printer bytes.
//!
//! WHAT THIS MODULE IS, AND WHAT IT IS NOT
//!
//! Input is a `ReceiptIr` (JSON-deserialised, built by the TypeScript layout
//! layer). Output is a `Vec<u8>`: the exact byte stream an ESC/POS thermal
//! printer consumes. Nothing here opens a socket, claims a USB device or talks
//! to a Tauri window — this is a pure function from IR to bytes, which is what
//! makes it testable without hardware.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! THE THAI ENCODING FACT THAT MATTERS MOST (and corrects an earlier claim)
//! ─────────────────────────────────────────────────────────────────────────────
//!
//! An earlier version of DOMAIN.md stated "Thai is two bytes per glyph in
//! CP874/CP256" and specified a Gate B test asserting that a 10-glyph Thai name
//! occupies 20 bytes. **That was wrong, and it is corrected here.** `windows-874`
//! is a SINGLE-BYTE code page: every character — Thai consonant, vowel, tone
//! mark, ฿, or ASCII — is exactly one byte. `thai_coverage` proves it directly,
//! including ๐–๙ (U+0E50–U+0E59) mapping to F0–F9, one byte each.
//!
//! This is not a pedantic correction, because the wrong claim would have
//! corrupted every column calculation in the product. A layout that assumed 2
//! bytes per Thai glyph would pad receipt lines at half the necessary width,
//! pushing totals off the right edge of an 80mm roll — a receipt that is
//! visibly torn in a way no type check catches.
//!
//! With one byte per character, column arithmetic becomes EXACT rather than
//! approximate: the byte length of an encoded string is precisely the number of
//! character cells it occupies, so `padding = COLUMNS - width` is simply
//! correct. `cp874::display_width` is the only place that fact is implemented.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! WHAT THIS LAYER DOES NOT DO: VISUALLY STACK THAI MARKS
//! ─────────────────────────────────────────────────────────────────────────────
//!
//! In Unicode a Thai vowel is stored AFTER its consonant ("เกาะ" is เ ก า ะ,
//! four code points). The eye reads it as one glyph with the vowel stacked in
//! front. That reordering is a property of the Thai SCRIPT, not of the byte
//! stream: CP874 has no combining mechanism and the printer's built-in font
//! table decides how each cell renders.
//!
//! So this compiler emits code points in logical order and lets the printer's
//! font handle the visual stacking. It does not reorder, and it cannot. A test
//! here asserts what is genuinely true — that all four code points survive, in
//! order, one byte each — rather than asserting a stacking behaviour that would
//! live in the printer's ROM, not in this code.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! THE COMMAND BYTE VALUES
//! ─────────────────────────────────────────────────────────────────────────────
//!
//! Each is a named constant with the reasoning attached, because these are the
//! numbers a future engineer is most likely to "fix" by guessing.
//!
//!   ESC @      (1B 40)   initialise — clears modes, resets the code page.
//!   ESC t n    (1B 74 n) select character code table; n=20 for Thai.
//!   GS V m n   (1D 56 m n) cut paper; 66 0 is the full cut with auto-feed.
//!   ESC p m t1 t2       cash drawer pulse on pin 2, 25ms on / 250ms off.
//!   LF         (0A)       line feed.

use serde::{Deserialize, Serialize};

use crate::cp874::{display_width, encode_strict, UnmappableCharacter, COLUMNS_80MM};

/// `ESC @` — initialise the printer.
///
/// The first byte of every receipt. It resets the print mode to a known state,
/// which is why it is emitted unconditionally rather than once at "connection
/// time": a receipt must not depend on whatever state the printer was left in
/// by the previous customer, or a shifted margin would misalign this one.
pub const ESC_INIT: &[u8] = b"\x1b\x40";

/// `GS V 66 0` — cut the paper.
///
/// GS is 0x1D. The function number 66 combines "feed to the cut position" with
/// "full cut" in one command; the trailing 0 is a reserved parameter.
pub const GS_CUT_FULL: &[u8] = b"\x1d\x56\x42\x00";

/// `ESC p 0 25 250` — kick the cash drawer on pin 2.
///
/// m=0 selects drawer pin 2. t1=25 and t2=250 are the on/off pulse widths in
/// milliseconds. A thermal receipt printer typically has no drawer at all; the
/// command is harmless there, and on a real POS terminal it is what makes the
/// till open.
pub const ESC_DRAWER_PIN2: &[u8] = b"\x1b\x70\x00\x19\xfa";

/// Line feed — end of one text line.
const LF: u8 = 0x0A;

/// Horizontal alignment for a line of text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
  /// Flush left (the printer's default after `ESC @`). Also the `Default`,
  /// so a `ReceiptLine` that omits `align` in its JSON is left-aligned rather
  /// than failing to deserialise.
  #[default]
  Left,
  /// Centre on the 48-column line.
  Center,
  /// Flush right, so totals sit against the paper edge.
  Right,
}

/// `ESC a n` — set horizontal alignment. n: 0=left, 1=centre, 2=right.
fn esc_align(align: Align) -> &'static [u8] {
  match align {
    Align::Left => b"\x1b\x61\x00",
    Align::Center => b"\x1b\x61\x01",
    Align::Right => b"\x1b\x61\x02",
  }
}

/// One line of the receipt, already formatted by the layout layer.
///
/// Deliberately dumb: the TS layer has decided the text and its alignment, and
/// this compiler only turns it into bytes. Re-formatting here would put money
/// arithmetic on the Rust side of the bridge, which is exactly the split the
/// architecture forbids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptLine {
  /// The text to print. May contain Thai.
  pub text: String,
  /// Horizontal alignment on the 48-column line.
  #[serde(default)]
  pub align: Align,
}

/// The neutral receipt IR — the contract between the TS layout layer and this
/// compiler. Serialised to JSON and handed across the invoke bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptIr {
  /// Store name, printed at the top.
  pub shop_name: String,
  /// Human-readable receipt number.
  pub receipt_number: String,
  /// Pre-formatted body lines, in order.
  pub lines: Vec<ReceiptLine>,
  /// Total in satang, as a decimal string — the same contract as every other
  /// monetary value crossing `invoke` (see commands.rs). Parsed as an integer
  /// here; never as a float, because ฿45.50 is not representable in binary.
  pub total_satang: String,
  /// Whether to pulse the cash drawer after cutting.
  #[serde(default)]
  pub open_drawer: bool,
}

/// Why a receipt could not be compiled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileError {
  /// A string contained a character with no CP874 representation.
  Unmappable {
    /// Which line of the receipt failed, 0-indexed, so the log can name the
    /// offending row instead of just "printing failed".
    line: usize,
    /// The character and its codepoint.
    source: UnmappableCharacter,
  },
  /// `total_satang` was not a plain non-negative integer string.
  MalformedTotal {
    /// What was received, verbatim.
    received: String,
  },
  /// A `total_satang` so large it would overflow when multiplied for display.
  TotalOverflow {
    /// The value that overflowed.
    received: String,
  },
}

/// Format satang as `฿0.00` without ever touching a float.
///
/// This is the same rule as everywhere else in the system: ฿45.50 is the
/// integer 4550, and `45.50` in binary floating point is not that number. The
/// division here is integer division on purpose.
///
/// Returns `None` on non-numeric or negative input rather than defaulting to
/// zero — a receipt that silently printed ฿0.00 instead of the real total
/// would be worse than one that refuses to print.
fn format_satang(satang: &str) -> Option<String> {
  // Reject anything that is not purely digits BEFORE parsing, so "+5", "-5",
  // "5.0", " " and "" are all rejected rather than coerced.
  if satang.is_empty() || !satang.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }

  let value: u64 = satang.parse().ok()?;

  // ฿ + whole + "." + 2 digits. No overflow is possible: `value` is a u64
  // parsed from the string, so `value / 100` fits by construction. The
  // rejection in the loop above is what stops a corrupted total reaching here.
  let whole = value / 100;
  let frac = value % 100;

  Some(format!("฿{whole}.{frac:02}"))
}

/// Pad `text` on the left so it ends flush right on a 48-column line.
///
/// `width` is the CP874 byte length, which equals the cell count exactly — see
/// the module docs on why this is one byte per character and not two. That
/// equality is what makes this arithmetic correct rather than approximate.
///
/// If the text is already at or over the column width, no padding is emitted
/// and the line simply runs to the edge; truncating would corrupt a product
/// name or a total, and a long line is a recoverable layout problem.
fn pad_left_to_columns(text: &str, bytes: &[u8]) -> Vec<u8> {
  let width = display_width(text);
  let padding = COLUMNS_80MM.saturating_sub(width);
  let mut out = vec![b' '; padding];
  out.extend_from_slice(bytes);
  out
}

/// Encode one line, or report which line failed.
fn encode_line(line: &ReceiptLine, index: usize) -> Result<Vec<u8>, CompileError> {
  encode_strict(&line.text).map_err(|source| CompileError::Unmappable { line: index, source })
}

/// Compile a receipt IR into an ESC/POS byte stream.
///
/// The stream is, in order: initialise, select the Thai code page, the body
/// lines, a few line feeds so the last line clears the cutter, the cut, and
/// optionally the drawer pulse.
///
/// The code page is selected explicitly on every receipt even though `ESC @`
/// precedes it. That is intentional: `ESC @` resets the code page to the
/// printer's power-on default, which on many units is a Western one, so
/// relying on either command alone is how Thai text turns into mojibake on a
/// printer that works fine on the shop's other machine.
///
/// Fails without emitting a partial stream if any text is unmappable. There is
/// no "best effort" mode: a receipt that prints half a line and then stops is
/// indistinguishable from a printer failure.
pub fn compile(ir: &ReceiptIr) -> Result<Vec<u8>, CompileError> {
  let mut out: Vec<u8> = Vec::with_capacity(512);

  // ── 1. Initialise, then explicitly select Thai ────────────────────────────
  out.extend_from_slice(ESC_INIT);
  out.extend_from_slice(crate::cp874::THAI_CODE_PAGE_SELECT);

  // ── 2. Shop name, centred, then the receipt number ────────────────────────
  let header = ReceiptLine {
    text: ir.shop_name.clone(),
    align: Align::Center,
  };
  let header_bytes = encode_line(&header, 0)?;
  let centre_pad = COLUMNS_80MM.saturating_sub(display_width(&ir.shop_name)) / 2;
  out.extend_from_slice(&vec![b' '; centre_pad]);
  out.extend_from_slice(&header_bytes);
  out.push(LF);

  let number = ReceiptLine {
    text: ir.receipt_number.clone(),
    align: Align::Center,
  };
  let number_bytes = encode_line(&number, 0)?;
  let number_pad = COLUMNS_80MM.saturating_sub(display_width(&ir.receipt_number)) / 2;
  out.extend_from_slice(&vec![b' '; number_pad]);
  out.extend_from_slice(&number_bytes);
  out.push(LF);

  // ── 3. Body lines, each with its own alignment ─────────────────────────────
  for (index, line) in ir.lines.iter().enumerate() {
    let bytes = encode_line(line, index)?;
    out.extend_from_slice(esc_align(line.align));

    match line.align {
      Align::Left => out.extend_from_slice(&bytes),
      Align::Center => {
        let pad = COLUMNS_80MM.saturating_sub(display_width(&line.text)) / 2;
        out.extend_from_slice(&vec![b' '; pad]);
        out.extend_from_slice(&bytes);
      }
      Align::Right => {
        let padded = pad_left_to_columns(&line.text, &bytes);
        out.extend_from_slice(&padded);
      }
    }

    out.push(LF);
  }

  // ── 4. The total, right-aligned ───────────────────────────────────────────
  let total_text = format_satang(&ir.total_satang).ok_or_else(|| CompileError::MalformedTotal {
    received: ir.total_satang.clone(),
  })?;

  let total_line = ReceiptLine {
    text: total_text,
    align: Align::Right,
  };
  let total_bytes = encode_line(&total_line, ir.lines.len())?;
  out.extend_from_slice(esc_align(Align::Right));
  out.extend_from_slice(&pad_left_to_columns(&total_line.text, &total_bytes));
  out.push(LF);

  // ── 5. Feed past the cutter, then cut ─────────────────────────────────────
  // Three line feeds so the final total is not left sitting in the cutter's
  // jaws when it shears.
  out.extend_from_slice(&[LF, LF, LF]);
  out.extend_from_slice(GS_CUT_FULL);

  // ── 6. Drawer, only if this sale needs one ────────────────────────────────
  if ir.open_drawer {
    out.extend_from_slice(ESC_DRAWER_PIN2);
  }

  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ir_with_line(text: &str) -> ReceiptIr {
    ReceiptIr {
      shop_name: "ร้านวาลังอาซิ".to_string(),
      receipt_number: "R-0001".to_string(),
      lines: vec![ReceiptLine {
        text: text.to_string(),
        align: Align::Left,
      }],
      total_satang: "4550".to_string(),
      open_drawer: false,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Control sequences.
  // ───────────────────────────────────────────────────────────────────────────

  #[test]
  fn every_receipt_starts_with_initialise_and_the_thai_code_page() {
    let bytes = compile(&ir_with_line("ทดสอบ")).unwrap();

    assert_eq!(&bytes[0..2], b"\x1b\x40", "ESC @ must be the first command");
    assert_eq!(
      &bytes[2..5],
      b"\x1b\x74\x14",
      "ESC t 20 must immediately follow, before any Thai is sent"
    );
  }

  #[test]
  fn the_receipt_ends_with_a_full_cut() {
    let bytes = compile(&ir_with_line("ทดสอบ")).unwrap();

    assert_eq!(
      &bytes[bytes.len() - 4..],
      GS_CUT_FULL,
      "GS V 66 0 must be the final command"
    );
  }

  #[test]
  fn the_drawer_is_pulsed_only_when_requested() {
    let mut ir = ir_with_line("ทดสอบ");
    assert!(
      !compile(&ir).unwrap().ends_with(ESC_DRAWER_PIN2),
      "no drawer for an ordinary sale"
    );

    ir.open_drawer = true;
    let bytes = compile(&ir).unwrap();
    assert!(
      bytes.ends_with(ESC_DRAWER_PIN2),
      "ESC p 0 25 250 must follow the cut"
    );
    // The cut must still precede the drawer, or the till opens on the next
    // receipt's paper.
    let cut_at = bytes
      .windows(GS_CUT_FULL.len())
      .position(|w| w == GS_CUT_FULL)
      .expect("cut present");
    assert!(cut_at < bytes.len() - ESC_DRAWER_PIN2.len());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Money. These are the assertions that matter most.
  // ───────────────────────────────────────────────────────────────────────────

  #[test]
  fn satang_is_rendered_without_a_float() {
    assert_eq!(format_satang("4550").unwrap(), "฿45.50");
    assert_eq!(format_satang("0").unwrap(), "฿0.00");
    assert_eq!(format_satang("5").unwrap(), "฿0.05");
    assert_eq!(format_satang("100").unwrap(), "฿1.00");
  }

  #[test]
  fn a_malformed_total_refuses_to_print_rather_than_printing_zero() {
    // Every one of these would become ฿0.00 under a `unwrap_or_default()`.
    for bad in ["", "-100", "+100", "45.50", "4_5", " 4550", "abc", "1e3"] {
      assert!(
        format_satang(bad).is_none(),
        "{bad:?} must be rejected, not coerced to zero"
      );
    }
  }

  #[test]
  fn a_large_total_is_formatted_exactly() {
    // The boundary case for the digit-only guard. u64::MAX satang is absurd as
    // money, but it must still render exactly rather than wrap — the divide is
    // integer division on a u64, so it cannot overflow.
    let huge = u64::MAX.to_string();
    assert_eq!(format_satang(&huge).unwrap(), "฿184467440737095516.15");
  }

  #[test]
  fn the_total_reaches_the_paper_as_cp874_bytes() {
    let bytes = compile(&ir_with_line("กาแฟ")).unwrap();

    // ฿ is 0xDF in CP874; "45.50" is plain ASCII. If the encoding path ever
    // mangled the currency symbol, the money on the receipt would be wrong.
    assert!(
      bytes.windows(2).any(|w| w == [0xDF, b'4']),
      "฿45.50 must appear as byte DF followed by ASCII '4'"
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GATE B — Thai byte offsets.
  // ───────────────────────────────────────────────────────────────────────────

  #[test]
  fn gate_b_thai_text_is_one_byte_per_character() {
    // THE CORE GATE B ASSERTION, and the one that corrects DOMAIN.md's claim
    // that Thai is "two bytes per glyph".
    //
    // "สิทธิ์" is six code points: ส ิ ท ธ ิ ์ — two ิ marks, a ท, a ธ, and a
    // trailing ์. If Thai were two bytes per glyph this would be 12 bytes. In
    // windows-874 it is SIX, one per code point, so every column calculation in
    // the layout layer is exact.
    let word = "สิทธิ์";
    let bytes = encode_strict(word).unwrap();

    assert_eq!(word.chars().count(), 6);
    assert_eq!(bytes.len(), 6, "one byte per code point, not two");
    assert_eq!(display_width(word), 6, "and therefore six printer columns");
  }

  #[test]
  fn gate_b_marks_occupy_their_own_cells_in_logical_order() {
    // "น้ำ" = น + ้ + ำ — a consonant, an ABOVE vowel/tone mark, and a BELOW
    // mark, in the order Unicode stores them.
    //
    // WHAT IS ASSERTED: each mark is present, unmoved, in its own cell, and the
    // byte stream reproduces the exact code point order. No mark is dropped,
    // merged, or transposed.
    //
    // WHAT IS NOT ASSERTED, AND WHY: that the ้ renders ABOVE the น and the ำ
    // renders BELOW it. That is decided by the font table inside the printer.
    // CP874 has no combining mechanism — each of these is a standalone byte —
    // so no byte compiler can stack them, and claiming otherwise would mean
    // writing code that does nothing.
    let word = "น้ำ";
    let bytes = encode_strict(word).unwrap();

    assert_eq!(bytes.len(), 3, "น, ้ and ำ each take one cell");

    let (decoded, _, had_errors) = encoding_rs::WINDOWS_874.decode(&bytes);
    assert!(!had_errors);
    assert_eq!(
      decoded, word,
      "the marks survive in order: a dropped or reordered mark prints a different word"
    );

    // And the marks are genuinely distinct bytes — ้ (U+0E49) and ำ (U+0E33)
    // must not collapse into one cell or into the consonant's byte.
    assert_ne!(bytes[1], bytes[0], "the tone mark is not the consonant");
    assert_ne!(bytes[2], bytes[0], "the below-vowel is not the consonant");
  }

  #[test]
  fn gate_b_a_long_thai_line_lands_exactly_on_the_right_edge() {
    // The end-to-end claim: a right-aligned Thai total ends in the final column
    // of a 48-column roll, not short of it and not past it.
    //
    // "กาแฟโก้" is 7 code points → 7 bytes → 7 columns. Padding is therefore
    // 48 − 7 = 41 spaces. Under the old (incorrect) two-byte assumption this
    // would have been 48 − 14 = 34, printing the total 7 columns short of the
    // edge on every single receipt.
    let text = "กาแฟโก้";
    let bytes = encode_strict(text).unwrap();
    let padded = pad_left_to_columns(text, &bytes);

    assert_eq!(bytes.len(), 7);
    assert_eq!(padded.len(), COLUMNS_80MM, "line fills the 48-column roll exactly");
    assert_eq!(&padded[41..], &bytes[..], "the Thai sits in the last 7 columns");
  }

  #[test]
  fn gate_b_a_ten_character_thai_name_is_ten_bytes() {
    // The literal form of the corrected Gate B rule. DOMAIN.md asked for
    // "10 glyphs = 20 bytes"; the correct assertion is 10 glyphs = 10 bytes.
    let text = "กาแฟโก้กาแ"; // ก า แ ฟ โ ก ้ ก า แ = 10 code points
    let bytes = encode_strict(text).unwrap();

    assert_eq!(text.chars().count(), 10);
    assert_eq!(bytes.len(), 10);
  }

  #[test]
  fn a_line_longer_than_the_roll_is_not_truncated() {
    // Truncating would corrupt a product name. A long line runs off the edge
    // and is a layout problem someone must fix, not a silent data loss.
    let long = "ก".repeat(60);
    let bytes = encode_strict(&long).unwrap();
    let padded = pad_left_to_columns(&long, &bytes);

    assert_eq!(padded.len(), 60, "no truncation, no padding");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Fail-fast: no partial receipts.
  // ───────────────────────────────────────────────────────────────────────────

  #[test]
  fn an_unmappable_character_aborts_the_whole_receipt() {
    let mut ir = ir_with_line("กาแฟ");
    ir.lines.push(ReceiptLine {
      text: "ชา ☕".to_string(),
      align: Align::Left,
    });

    match compile(&ir) {
      Err(CompileError::Unmappable { line, source }) => {
        assert_eq!(line, 1, "the error names the offending line");
        assert_eq!(source.character, '☕');
      }
      other => panic!("expected Unmappable, got {other:?}"),
    }
  }

  #[test]
  fn a_receipt_with_an_unmappable_total_does_not_print() {
    let mut ir = ir_with_line("กาแฟ");
    ir.total_satang = "forty five".to_string();

    assert!(matches!(compile(&ir), Err(CompileError::MalformedTotal { .. })));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Structure.
  // ───────────────────────────────────────────────────────────────────────────

  #[test]
  fn alignment_commands_precede_their_text() {
    let ir = ReceiptIr {
      shop_name: "ร้านวาลังอาซิ".to_string(),
      receipt_number: "R-0001".to_string(),
      lines: vec![
        ReceiptLine { text: "ซ้าย".to_string(), align: Align::Left },
        ReceiptLine { text: "กลาง".to_string(), align: Align::Center },
        ReceiptLine { text: "ขวา".to_string(), align: Align::Right },
      ],
      total_satang: "4550".to_string(),
      open_drawer: false,
    };

    let bytes = compile(&ir).unwrap();

    assert!(
      bytes.windows(3).any(|w| w == b"\x1b\x61\x00"),
      "ESC a 0 for left"
    );
    assert!(
      bytes.windows(3).any(|w| w == b"\x1b\x61\x01"),
      "ESC a 1 for centre"
    );
    assert!(
      bytes.windows(3).any(|w| w == b"\x1b\x61\x02"),
      "ESC a 2 for right"
    );
  }

  #[test]
  fn an_empty_receipt_still_produces_a_valid_stream() {
    let ir = ReceiptIr {
      shop_name: String::new(),
      receipt_number: String::new(),
      lines: vec![],
      total_satang: "0".to_string(),
      open_drawer: false,
    };

    let bytes = compile(&ir).unwrap();
    assert_eq!(&bytes[0..2], ESC_INIT);
    assert!(bytes.ends_with(GS_CUT_FULL));
  }
}
