import { describe, expect, it } from 'bun:test';

import {
  MilliUnitsError,
  MILLI_PER_UNIT,
  milliToDecimalString,
  parseUnitsInput,
  unitsToMilli,
} from './milliUnits';

/**
 * milliUnits tests.
 *
 * LAYER: domain. These are the guard rails on the ONE conversion a manager's
 * keystroke passes through on its way to a stock balance. The cases are chosen
 * for the exact ways a decimal-to-integer multiply goes wrong: floating-point
 * drift, values too large for a double, negatives, and NaN.
 */
describe('unitsToMilli', () => {
  it('converts a whole unit to 1000 milli', () => {
    expect(unitsToMilli(1)).toBe(1000);
    expect(unitsToMilli(0)).toBe(0);
  });

  it('converts a simple decimal exactly', () => {
    expect(unitsToMilli(2.5)).toBe(2500);
    expect(unitsToMilli(0.125)).toBe(125);
  });

  it('is the scale factor', () => {
    expect(MILLI_PER_UNIT).toBe(1000);
  });

  /**
   * THE floating-point case that motivates the whole module. `0.1 + 0.2` is
   * `0.30000000000000004` in a double, so `(0.1 + 0.2) * 1000` is
   * `300.00000000000006` — which `Math.trunc` would drop to 300 by luck and
   * which a different value would drop to 299. `Math.round` makes it 300 on
   * purpose. This is the test that would fail the day someone replaces the
   * `Math.round` with a truncation or a bare multiply.
   */
  it('rounds the 0.1 + 0.2 float drift to the nearest milli-unit', () => {
    const drifted = 0.1 + 0.2; // 0.30000000000000004
    expect(unitsToMilli(drifted)).toBe(300);
  });

  it('handles a large but safe value without float error', () => {
    // 999999.999 is within decimal(12,3) and within the double safe range.
    expect(unitsToMilli(999999.999)).toBe(999999999);
  });

  it('rejects a negative count', () => {
    expect(() => unitsToMilli(-1)).toThrow(MilliUnitsError);
    expect(() => unitsToMilli(-0.001)).toThrow(MilliUnitsError);
  });

  it('rejects NaN', () => {
    expect(() => unitsToMilli(Number.NaN)).toThrow(MilliUnitsError);
  });

  it('rejects Infinity', () => {
    expect(() => unitsToMilli(Number.POSITIVE_INFINITY)).toThrow(MilliUnitsError);
  });
});

describe('parseUnitsInput', () => {
  it('accepts a plain number', () => {
    expect(parseUnitsInput('2.5')).toEqual({ ok: true, units: 2.5 });
  });

  it('refuses an empty box as zero', () => {
    const result = parseUnitsInput('   ');
    expect(result.ok).toBe(false);
  });

  it('refuses non-numeric text', () => {
    const result = parseUnitsInput('abc');
    expect(result.ok).toBe(false);
  });

  it('refuses a negative', () => {
    const result = parseUnitsInput('-1');
    expect(result.ok).toBe(false);
  });
});

describe('milliToDecimalString', () => {
  it('renders with exactly three fraction digits', () => {
    expect(milliToDecimalString(2500)).toBe('2.500');
    expect(milliToDecimalString(0)).toBe('0.000');
    expect(milliToDecimalString(125)).toBe('0.125');
  });

  it('renders a negative', () => {
    expect(milliToDecimalString(-125)).toBe('-0.125');
  });

  it('is the inverse of unitsToMilli for accepted inputs', () => {
    for (const units of [0, 0.125, 2.5, 999999.999]) {
      expect(milliToDecimalString(unitsToMilli(units))).toBe(units.toFixed(3));
    }
  });

  it('refuses a non-integer milli count', () => {
    expect(() => milliToDecimalString(2.5)).toThrow(MilliUnitsError);
  });
});
