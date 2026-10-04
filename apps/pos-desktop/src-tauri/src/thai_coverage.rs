//! Thai character coverage for the receipt printer's code page.
//!
//! WHY THIS TEST EXISTS, AND WHY IT COMES FIRST
//!
//! An ESC/POS thermal printer speaks a 1980s single-byte code page, not UTF-8.
//! Every Thai glyph on a receipt is therefore a MAPPING, and a mapping can fail.
//! `encoding_rs`'s default `Encoding::encode()` substitutes an unmappable
//! character with an HTML numeric character reference (`&#9749;` — eight
//! literal ASCII bytes) and hands those bytes back in the output. On paper
//! that is garbage in the middle of a customer's line items.
//!
//! So this module answers one question before any receipt is ever compiled:
//! **can every character a Thai shop actually uses be encoded at all?**
//!
//! `windows-874` is a pre-Unicode code page from the Windows 3.1 era. Thai
//! digits (๐–๙, U+0E50–U+0E59) were standardised into Unicode long after it was
//! frozen, so they were the most likely thing to be missing. The answer turned
//! out to be that they ARE present — one byte each, F0–F9 — which is the fact
//! `thai_digits_occupy_one_byte_each` now locks in. Had they been missing, the
//! answer would NOT have been "substitute something": the menu, the receipt
//! template, or the printer's code page would have had to change, with a human
//! deciding which.
//!
//! All encoding goes through `cp874::encode_strict`, the same function the byte
//! compiler calls. There is no second implementation here to drift out of sync
//! with the one that actually prints.

#[cfg(test)]
use crate::cp874::encode_strict;

#[cfg(test)]
mod tests {
  use super::encode_strict;

  // ───────────────────────────────────────────────────────────────────────────
  // 1. The headline question: THAI DIGITS.
  // ───────────────────────────────────────────────────────────────────────────

  #[test]
  fn thai_digits_zero_through_nine_are_encodable() {
    // ๐ ๑ ๒ ๓ ๔ ๕ ๖ ๗ ๘ ๙  — U+0E50..U+0E59.
    //
    // These post-date the code page, so they were the highest-risk characters
    // in the entire set. They are present.
    let digits: String = (0x0E50..=0x0E59).map(|c| char::from_u32(c).unwrap()).collect();
    assert_eq!(digits, "๐๑๒๓๔๕๖๗๘๙");

    let bytes = encode_strict(&digits).expect("Thai digits must be encodable in windows-874");

    assert_eq!(bytes.len(), 10, "ten Thai digits, one byte each");
  }

  #[test]
  fn thai_digits_occupy_one_byte_each() {
    // The exact CP874 values, so a future encoding upgrade that changed them
    // would fail here rather than quietly re-shaping every receipt.
    //
    // This is also the fact that CONTRADICTS the old note in DOMAIN.md saying
    // Thai is "two bytes per glyph". It is not — see the module docs in
    // `escpos.rs` for why a single-byte code page makes column arithmetic
    // exact rather than approximate.
    let expected: Vec<u8> = (0xF0..=0xF9).collect();

    let digits: String = (0x0E50..=0x0E59).map(|c| char::from_u32(c).unwrap()).collect();
    let bytes = encode_strict(&digits).expect("Thai digits must be encodable");

    assert_eq!(bytes, expected, "๐–๙ map to F0–F9, one byte apiece");
  }

  #[test]
  fn thai_currency_symbol_is_encodable() {
    // ฿ U+0E3F. Appears on every one of these receipts.
    assert!(encode_strict("฿").is_ok());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Consonants, vowels and tone marks — including the tricky ones.
  // ───────────────────────────────────────────────────────────────────────────

  #[test]
  fn basic_thai_consonants_are_encodable() {
    for word in ["ก", "ข", "ค", "ง", "ร", "ล", "ว", "ส", "อ", "ท", "น", "ม"] {
      assert!(
        encode_strict(word).is_ok(),
        "consonant {word:?} (U+{:04X}) must be encodable",
        word.chars().next().unwrap() as u32
      );
    }
  }

  #[test]
  fn thai_vowels_are_encodable() {
    for vowel in ["ะ", "ั", "า", "ำ", "ิ", "ี", "ึ", "ื", "ุ", "ู", "เ", "แ", "โ", "ใ", "ไ", "็", "์"] {
      assert!(encode_strict(vowel).is_ok(), "vowel {vowel:?} must be encodable");
    }
  }

  #[test]
  fn thai_tone_marks_are_encodable() {
    for tone in ["่", "้", "๊", "๋"] {
      assert!(encode_strict(tone).is_ok(), "tone mark {tone:?} must be encodable");
    }
  }

  #[test]
  fn stacked_vowels_encode_in_logical_order_and_round_trip() {
    // The order that makes Thai hard. In Unicode, a vowel is written AFTER the
    // consonant it modifies, so "เกาะ" is stored as เ ก า ะ — four separate
    // code points, four separate bytes, four separate printer cells.
    //
    // WHAT IS ASSERTED HERE IS THE HONEST CLAIM. It is tempting to write a
    // test called "marks are visually stacked above the consonant", but this
    // layer does not stack anything: CP874 has no combining mechanism, and
    // each mark occupies its own cell. Whether the glyph renders above, below
    // or beside its consonant is decided by the FONT TABLE BAKED INTO THE
    // PRINTER, which no byte compiler can influence. Asserting stacking here
    // would be asserting something this code does not do.
    //
    // What IS true, and what protects the receipt, is that the code points
    // survive in order with nothing dropped or transposed — because a
    // reordering bug here would print a different word, not a uglier one.
    let word = "เกาะ";

    let bytes = encode_strict(word).expect("stacked vowels must be encodable");
    assert_eq!(word.chars().count(), 4, "เ ก า ะ is four code points");
    assert_eq!(bytes.len(), 4, "and four CP874 bytes");

    // Reading the bytes back must reproduce the word exactly, in order.
    let (decoded, _, had_errors) = encoding_rs::WINDOWS_874.decode(&bytes);
    assert!(!had_errors, "round trip must not report errors");
    assert_eq!(decoded, word, "byte order must reproduce the Thai reading order");
  }

  #[test]
  fn a_real_product_name_with_stacked_vowels_round_trips() {
    // "กาแฟโก้" has a stacked โ + ค + ้ and a tone mark on the final consonant —
    // both of the cases that break naive handling.
    let name = "กาแฟโก้";
    let bytes = encode_strict(name).expect("a real product name must encode");
    let (decoded, _, had_errors) = encoding_rs::WINDOWS_874.decode(&bytes);
    assert!(!had_errors);
    assert_eq!(decoded, name);
  }

  #[test]
  fn a_word_with_a_below_vowel_and_a_tone_mark_round_trips() {
    // "น้ำ" = น + ้ (above) + ำ (below). The two mark classes in one word.
    let word = "น้ำ";
    let bytes = encode_strict(word).expect("น้ำ must encode");
    assert_eq!(bytes.len(), 3);
    let (decoded, _, had_errors) = encoding_rs::WINDOWS_874.decode(&bytes);
    assert!(!had_errors);
    assert_eq!(decoded, word);
  }

  #[test]
  fn a_word_ending_in_thanthakhat_and_sara_i_round_trips() {
    // "สิทธิ์" = ส + ิ + ท + ธ + ิ + ์ — ends on ์ (thanthakhat), the mark that
    // commonly gets dropped by naive text handling. Six code points, six bytes,
    // all six still present in order.
    let word = "สิทธิ์";
    let bytes = encode_strict(word).expect("สิทธิ์ must encode");

    assert_eq!(word.chars().count(), 6);
    assert_eq!(bytes.len(), 6, "no mark is dropped or merged");

    let (decoded, _, had_errors) = encoding_rs::WINDOWS_874.decode(&bytes);
    assert!(!had_errors);
    assert_eq!(decoded, word, "including the trailing ์");
  }

  #[test]
  fn two_word_product_name_round_trips() {
    // The shape an actual menu row has: "กาแฟโก้ 2 แก้ว" — with the Latin
    // digit 2 mixed into Thai text, which is how most Thai menus are written.
    let name = "กาแฟโก้ 2 แก้ว";
    let bytes = encode_strict(name).expect("mixed Thai/ASCII must encode");
    let (decoded, _, had_errors) = encoding_rs::WINDOWS_874.decode(&bytes);
    assert!(!had_errors);
    assert_eq!(decoded, name);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Fail-fast behaviour — the whole point of strict encoding.
  // ───────────────────────────────────────────────────────────────────────────

  #[test]
  fn unmappable_characters_are_reported_not_substituted() {
    // Emoji are certainly not in a 1990s Thai code page. This is the failure
    // this module exists to make visible: encode_strict returns Err rather
    // than bytes containing a substitution at all.
    let err = encode_strict("ชา ☕").expect_err("a coffee emoji is not in windows-874");
    assert_eq!(err.character, '☕');
  }

  #[test]
  fn the_default_encoder_would_have_written_replacement_bytes() {
    // Documents exactly why `without_replacement` is used everywhere instead of
    // the ergonomic `Encoding::encode()`.
    //
    // CORRECTION TO AN EARLIER ASSUMPTION IN THIS FILE: the substitution is
    // NOT a single `?`. encoding_rs writes an HTML numeric character
    // reference — the coffee emoji becomes the eight literal ASCII characters
    // `&#9749;`. On an 80mm receipt that is eight columns of noise in the
    // middle of a customer's line items.
    //
    // Note also that `encode()` DOES set `had_errors`. The hazard is therefore
    // not "it lies to you" — it is that the mangled bytes are already sitting
    // in the returned buffer by the time you check the flag. Strict encoding
    // removes the possibility by never producing them.
    let (bytes, _, had_errors) = encoding_rs::WINDOWS_874.encode("ชา ☕");

    assert!(had_errors, "the default encode() does report errors after all");

    // ช = AA, า = D2, space = 20, then the substitution payload.
    let expected = b"\xAA\xD2\x20&#9749;";
    assert_eq!(
      bytes.as_ref(),
      expected,
      "the emoji was expanded into a literal HTML numeric reference"
    );
  }

  #[test]
  fn pure_ascii_is_unchanged_by_the_code_page() {
    // Prices and receipt numbers are ASCII. They must pass through untouched,
    // or the money on the receipt is affected by the Thai encoding path.
    let ascii = "TOTAL 1234.50 THB";
    let bytes = encode_strict(ascii).expect("ASCII must always encode");
    assert_eq!(bytes, ascii.as_bytes());
  }

  #[test]
  fn the_baht_amount_survives_encoding_unchanged() {
    // ฿45.50 — the worked example from DOMAIN.md. ฿ is one byte; the rest is
    // ASCII. If the total on a customer receipt ever differs, it starts here.
    let bytes = encode_strict("฿45.50").expect("a baht amount must encode");
    assert_eq!(bytes.len(), 6, "฿ plus five ASCII characters");
  }
}
