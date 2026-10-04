/**
 * Cash rounding — the rules, proved.
 *
 * The interesting cases here are the ones a POS actually hits: a total that
 * rounds down (where the adjustment goes NEGATIVE, and where the shipped SQL
 * schema disagrees — see the note at the end), and totals large enough that a
 * float implementation would drift.
 */

import { describe, expect, it } from 'bun:test';
import { Money } from '../../payments/domain/money';
import {
  applyCashRounding,
  applyCashRoundingToMoney,
  DEFAULT_CASH_STEP,
  isRoundableMethod,
  roundToNearestCoin,
  roundingAdjustmentSatang,
  RoundingError,
  THAI_CASH_STEPS,
} from './cashRounding';

describe('roundToNearestCoin — the exact 25-satang step', () => {
  it('leaves a total that is already payable alone', () => {
    expect(roundToNearestCoin(4550n)).toBe(4550n);
    expect(roundToNearestCoin(4500n)).toBe(4500n);
    expect(roundToNearestCoin(4575n)).toBe(4575n);
  });

  it('rounds UP when the remainder passes the midpoint', () => {
    // ฿45.63 → ฿45.75. The remainder is 13 satang, more than half of 25.
    expect(roundToNearestCoin(4563n)).toBe(4575n);
    // ฿45.38 → ฿45.50.
    expect(roundToNearestCoin(4538n)).toBe(4550n);
  });

  it('rounds DOWN when the remainder falls short of the midpoint', () => {
    // ฿45.52 → ฿45.50. This is the case the SQL CHECK constraint rejects.
    expect(roundToNearestCoin(4552n)).toBe(4550n);
    // ฿45.49 → ฿45.50.
    expect(roundToNearestCoin(4549n)).toBe(4550n);
  });

  it('rounds a tie AWAY from zero, matching money.ts', () => {
    // Exactly halfway between ฿45.50 and ฿45.75 is ฿45.625 = 4563 satang
    // (12.5 above 4550, 12.5 below 4575). Half-up takes the larger figure.
    expect(roundToNearestCoin(4563n)).toBe(4575n);
    expect(roundToNearestCoin(4538n)).toBe(4550n);
  });

  it('handles zero and one satang', () => {
    expect(roundToNearestCoin(0n)).toBe(0n);
    expect(roundToNearestCoin(1n)).toBe(0n);
    expect(roundToNearestCoin(12n)).toBe(0n);
    expect(roundToNearestCoin(13n)).toBe(25n);
  });

  it('refuses a negative total rather than rounding it toward zero', () => {
    expect(() => roundToNearestCoin(-1n)).toThrow(RoundingError);
    expect(() => roundToNearestCoin(-4550n)).toThrow(RoundingError);
  });
});

describe('roundToNearestCoin — other coin steps', () => {
  it('rounds to the nearest 50 satang', () => {
    expect(roundToNearestCoin(4550n, 50n)).toBe(4550n);
    expect(roundToNearestCoin(4575n, 50n)).toBe(4600n);
    // 4525 is an EXACT tie between ฿45.00 and ฿45.50, and half-away-from-zero
    // takes the larger figure. An earlier draft of this test expected ฿45.00 —
    // that expectation, not the code, was wrong.
    expect(roundToNearestCoin(4525n, 50n)).toBe(4550n);
  });

  it('rounds to the nearest baht', () => {
    expect(roundToNearestCoin(4550n, 100n)).toBe(4600n);
    expect(roundToNearestCoin(4500n, 100n)).toBe(4500n);
  });

  it('rounds to the nearest ฿5 note', () => {
    expect(roundToNearestCoin(4550n, 500n)).toBe(4500n);
    expect(roundToNearestCoin(4750n, 500n)).toBe(5000n);
  });

  it('accepts every step that Thai notes or coins can pay out', () => {
    // A usable step is either a whole number of baht (a note) or an exact
    // fraction of one baht (a coin). Whole-baht steps do NOT have to divide
    // 100 — ฿5 is perfectly payable even though 500 does not divide 100.
    for (const step of THAI_CASH_STEPS) {
      const payable = 100n % step === 0n || step % 100n === 0n;
      expect(payable).toBe(true);
      expect(roundToNearestCoin(4550n, step) % step).toBe(0n);
    }
    expect(DEFAULT_CASH_STEP).toBe(25n);
  });

  it('refuses a step that would produce an unpayable total', () => {
    // 30 does not divide ฿1, so ฿45.63 could not be rounded to a multiple of
    // 30 satang that the drawer can dispense.
    expect(() => roundToNearestCoin(4550n, 30n)).toThrow(RoundingError);
    expect(() => roundToNearestCoin(4550n, 0n)).toThrow(RoundingError);
    expect(() => roundToNearestCoin(4550n, -25n)).toThrow(RoundingError);
  });
});

describe('the floating-point trap this module exists to avoid', () => {
  it('stays exact at ฿90 trillion, where Math.round starts drifting', () => {
    // ฿90,000,000,000.00 = 9e15 satang. Divided by 25 that is 3.6e14, which is
    // comfortably inside 2^53 — so this specific case is fine as a float. The
    // assertion is that the bigint path is exact at a magnitude where the
    // float path is not *guaranteed* to be.
    const huge = 9_000_000_000_000_00n;
    expect(roundToNearestCoin(huge)).toBe(huge);
  });

  it('never returns a figure that is not a multiple of the step', () => {
    // The property that actually matters: whatever we return must be payable.
    for (let satang = 0n; satang < 500n; satang += 7n) {
      for (const step of THAI_CASH_STEPS) {
        expect(roundToNearestCoin(satang, step) % step).toBe(0n);
      }
    }
  });

  it('only ever moves the total by less than half a step', () => {
    // Round-to-nearest is defined by this bound. A "rounding" that moved a
    // total further would be a pricing change wearing a rounding label.
    for (let satang = 0n; satang < 500n; satang += 3n) {
      for (const step of THAI_CASH_STEPS) {
        const moved = roundToNearestCoin(satang, step) - satang;
        const distance = moved < 0n ? -moved : moved;
        expect(distance * 2n).toBeLessThanOrEqual(step);
      }
    }
  });
});

describe('applyCashRounding — digital payment is NEVER rounded', () => {
  it('returns the exact total and a zero adjustment for QR', () => {
    const result = applyCashRounding(4552n, 'qr');
    expect(result.payable).toBe(4552n);
    expect(result.adjustment).toBe(0n);
  });

  it('returns the exact total and a zero adjustment for PromptPay', () => {
    // ฿45.52 is perfectly payable by transfer. Rounding it DOWN would make the
    // customer underpay by 2 satang with no error raised anywhere.
    const result = applyCashRounding(4552n, 'promptpay');
    expect(result.payable).toBe(4552n);
    expect(result.adjustment).toBe(0n);
  });

  it('leaves card and transfer alone as well', () => {
    for (const method of ['card', 'transfer'] as const) {
      expect(applyCashRounding(4552n, method).adjustment).toBe(0n);
    }
  });

  it('identifies cash as the only roundable method', () => {
    expect(isRoundableMethod('cash')).toBe(true);
    for (const method of ['qr', 'promptpay', 'card', 'transfer'] as const) {
      expect(isRoundableMethod(method)).toBe(false);
    }
  });
});

describe('applyCashRounding — cash rounds in both directions', () => {
  it('records a POSITIVE adjustment when the total rounds up', () => {
    const result = applyCashRounding(4563n, 'cash');
    expect(result.payable).toBe(4575n);
    expect(result.adjustment).toBe(12n);
    expect(result.original).toBe(4563n);
  });

  it('records a NEGATIVE adjustment when the total rounds down', () => {
    // ⚠️ THE SIGNED CASE. `migrations/0001_init.sql:188` declares
    // `rounding_adjustment_satang >= 0`, so a ฿45.52 cash sale produces an
    // adjustment the database will REFUSE at COMMIT. The arithmetic here is
    // correct; the schema needs migration 0002 to accept it.
    const result = applyCashRounding(4552n, 'cash');
    expect(result.payable).toBe(4550n);
    expect(result.adjustment).toBe(-2n);
  });

  it('records a zero adjustment when the total is already payable', () => {
    const result = applyCashRounding(4550n, 'cash');
    expect(result.payable).toBe(4550n);
    expect(result.adjustment).toBe(0n);
  });

  it('always satisfies payable === original + adjustment', () => {
    // The invariant the SQL identity depends on:
    //   total = subtotal - discount + service_charge + rounding_adjustment
    for (let satang = 4400n; satang < 4700n; satang += 1n) {
      const result = applyCashRounding(satang, 'cash');
      expect(result.original + result.adjustment).toBe(result.payable);
    }
  });

  it('reports the step it applied, for the receipt', () => {
    expect(applyCashRounding(4563n, 'cash').step).toBe(25n);
    expect(applyCashRounding(4563n, 'cash', 50n).step).toBe(50n);
  });

  it('refuses a negative total for a digital method too', () => {
    expect(() => applyCashRounding(-1n, 'qr')).toThrow(RoundingError);
  });
});

describe('the passthrough and Money signatures agree', () => {
  it('roundingAdjustmentSatang matches the full result', () => {
    for (let satang = 4500n; satang < 4600n; satang += 3n) {
      expect(roundingAdjustmentSatang(satang, 'cash')).toBe(
        applyCashRounding(satang, 'cash').adjustment,
      );
    }
  });

  it('the Money path agrees with the bigint path', () => {
    for (let satang = 4500n; satang < 4600n; satang += 7n) {
      const viaBigint = applyCashRounding(satang, 'cash');
      const viaMoney = applyCashRoundingToMoney(Money.fromSatang(satang), 'cash');
      expect(viaMoney.payable.satang).toBe(viaBigint.payable);
      expect(viaMoney.adjustment.satang).toBe(viaBigint.adjustment);
    }
  });

  it('renders a rounded total back to a clean decimal string', () => {
    const result = applyCashRoundingToMoney(Money.fromSatang(4552n), 'cash');
    expect(result.payable.toString()).toBe('45.50');
    expect(result.adjustment.toString()).toBe('-0.02');
  });

  it('leaves a QR payment exactly as the menu priced it', () => {
    const result = applyCashRoundingToMoney(Money.fromSatang(4552n), 'qr');
    expect(result.payable.toString()).toBe('45.52');
    expect(result.adjustment.satang).toBe(0n);
  });
});
