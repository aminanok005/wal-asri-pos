/**
 * getFirstLetter tests.
 *
 * The rule under test: a Thai name often starts with a leading vowel (เ แ โ ใ ไ),
 * which is not a consonant — so the thumbnail skips it and shows the first
 * consonant instead. A cashier seeing "เ" in a 48px circle learns nothing.
 */

import { describe, expect, it } from 'bun:test';
import { getFirstLetter } from './getFirstLetter';

describe('getFirstLetter', () => {
  it('skips a leading Thai vowel and returns the first consonant', () => {
    expect(getFirstLetter('ไก่')).toBe('ก'); // ไ + ก
    expect(getFirstLetter('แป้ง')).toBe('ป'); // แ + ป
    expect(getFirstLetter('เค้ก')).toBe('ค'); // เ + ค
    expect(getFirstLetter('โอเลตรอน')).toBe('อ'); // โ + อ
    expect(getFirstLetter('เมาท์')).toBe('ม'); // เ + ม
  });

  it('returns the first consonant when there is no leading vowel', () => {
    expect(getFirstLetter('กาแฟลาเต้')).toBe('ก');
    expect(getFirstLetter('มอคค่า')).toBe('ม');
    expect(getFirstLetter('ชาไทย')).toBe('ช');
    // น้ำเปล่า — the tone mark and vowel are combining marks that follow the
    // consonant, so the answer is น and never a bare mark.
    expect(getFirstLetter('น้ำเปล่า')).toBe('น');
  });

  it('returns the first letter of a Latin name', () => {
    expect(getFirstLetter('coffee')).toBe('c');
    expect(getFirstLetter('Latte')).toBe('L');
  });

  it('falls back to "?" when there is no letter to show', () => {
    expect(getFirstLetter('')).toBe('?');
    // All leading vowels: no consonant anywhere, so nothing legible exists.
    expect(getFirstLetter('เแโใไ')).toBe('?');
  });
});