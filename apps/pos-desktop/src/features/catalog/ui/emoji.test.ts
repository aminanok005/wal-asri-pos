/**
 * emojiForName — the tile glyph's rules, asserted the way this repo asserts
 * every pure helper: the demo names a cashier actually sees, the ordering traps
 * that make a combo a combo and a milk tea a tea, and the determinism the
 * "same tile, same look" guarantee rests on.
 *
 * These assertions are deliberately STRICT about the demo menu — a rule
 * reordering that puts 🍔 on "สมูทตี้เบอร์เกอร์คอมโบ" is exactly the kind of
 * silent cosmetic regression this file exists to catch.
 */

import { describe, expect, it } from 'bun:test';

import { emojiForName } from './emoji';

describe('emojiForName — keyword rules over the demo menu', () => {
  it('maps the demo drinks, food and sweets to their Thai keywords', () => {
    expect(emojiForName('กาแฟลาเต้')).toBe('☕');
    expect(emojiForName('มอคค่า')).toBe('☕');
    expect(emojiForName('กาแฟร้อน')).toBe('☕');
    expect(emojiForName('ชาไทย')).toBe('🍵');
    expect(emojiForName('นมสด')).toBe('🥛');
    expect(emojiForName('น้ำเปล่า')).toBe('💧');
    expect(emojiForName('เค้กกล้วยหอม')).toBe('🍰');
    expect(emojiForName('เบเกอรี่ไก่')).toBe('🥐');
  });

  it('scores คอมโบ before the words inside it — a combo must look like one', () => {
    // The demo combo's name contains สมูทตี้ AND เบอร์เกอร์; rule order is the
    // only thing making it a 🍱 and not a 🥤 or a 🍔.
    expect(emojiForName('สมูทตี้เบอร์เกอร์คอมโบ')).toBe('🍱');
  });

  it('scores ชาก่อน นม, so a milk tea stays a tea', () => {
    expect(emojiForName('ชานม')).toBe('🍵');
  });

  it('scores เค้ก before กล้วย, so a banana cake is cake and not fruit', () => {
    expect(emojiForName('เค้กกล้วยหอม')).toBe('🍰');
  });
});

describe('emojiForName — the fallback for names no rule knows', () => {
  it('is deterministic: the same unknown name always draws the same glyph', () => {
    const name = 'เมนูลึกลับที่ไม่มีruleในระบบ';
    expect(emojiForName(name)).toBe(emojiForName(name));
  });

  it('never returns an empty glyph — an empty panel reads as a broken image', () => {
    for (const name of ['', '   ', 'x', 'ข้าวมันไก่', 'ลาเต้เย็น']) {
      expect(emojiForName(name)).not.toBe('');
    }
  });
});