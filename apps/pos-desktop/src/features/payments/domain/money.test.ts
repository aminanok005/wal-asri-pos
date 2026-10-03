import { describe, expect, it } from 'bun:test';
import { Money, MoneyError, SATANG_PER_UNIT } from './money';

describe('construction', () => {
  it('parses decimal strings exactly', () => {
    expect(Money.fromString('100.50').satang).toBe(10050n);
    expect(Money.fromString('100.5').satang).toBe(10050n);
    expect(Money.fromString('100').satang).toBe(10000n);
    expect(Money.fromString('0.01').satang).toBe(1n);
    expect(Money.fromString('-0.01').satang).toBe(-1n);
    expect(Money.fromString('+12.34').satang).toBe(1234n);
    expect(Money.fromString('100.').satang).toBe(10000n);
  });

  it('rejects more than two decimal places rather than rounding silently', () => {
    expect(() => Money.fromString('1.005')).toThrow(MoneyError);
    expect(() => Money.fromString('abc')).toThrow(MoneyError);
    expect(() => Money.fromString('1e5')).toThrow(MoneyError);
    expect(() => Money.fromString('1,000')).toThrow(MoneyError);
    expect(() => Money.fromString('')).toThrow(MoneyError);
  });

  it('fromNumber accepts exact values', () => {
    expect(Money.fromNumber(100.5).satang).toBe(10050n);
    expect(Money.fromNumber(0.5).satang).toBe(50n);
  });

  it('fromNumber refuses float drift instead of hiding it', () => {
    // The canonical float failure: 0.1 + 0.2.
    expect(() => Money.fromNumber(0.1 + 0.2)).toThrow(MoneyError);
    expect(() => Money.fromNumber(1.005)).toThrow(MoneyError);
    expect(() => Money.fromNumber(NaN)).toThrow(MoneyError);
    expect(() => Money.fromNumber(Infinity)).toThrow(MoneyError);
  });

  it('fromSatang requires a bigint', () => {
    expect(() => Money.fromSatang(100 as unknown as bigint)).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = Money.fromSatang(4550n);
    const b = Money.fromSatang(1234n);
    expect(a.add(b).satang).toBe(5784n);
    expect(a.subtract(b).satang).toBe(3316n);
  });

  it('multiplies by an integer factor without drift', () => {
    // The 3 x 0.1 case, in satang. Exact.
    expect(Money.fromSatang(10n).multiply(3n).satang).toBe(30n);
    expect(Money.fromSatang(4550n).multiply(3n).satang).toBe(13650n);
  });

  it('multiplies by a ratio, rounding half away from zero', () => {
    // 0.5 * 1.5 satang = 0.75 -> 1
    expect(Money.fromSatang(1n).multiplyRatio(3n, 2n).satang).toBe(2n);
    // negative stays negative
    expect(Money.fromSatang(-1n).multiplyRatio(3n, 2n).satang).toBe(-2n);
  });

  it('divides with half-away-from-zero rounding', () => {
    expect(Money.fromSatang(100n).divide(3n).satang).toBe(33n);
    // exact 1.5 -> 2 (half away from zero)
    expect(Money.fromSatang(3n).divide(2n).satang).toBe(2n);
    expect(Money.fromSatang(-3n).divide(2n).satang).toBe(-2n);
  });

  it('refuses division by zero', () => {
    expect(() => Money.fromSatang(100n).divide(0n)).toThrow(MoneyError);
    expect(() => Money.fromSatang(100n).multiplyRatio(1n, 0n)).toThrow(MoneyError);
  });

  it('negate and abs', () => {
    expect(Money.fromSatang(50n).negate().satang).toBe(-50n);
    expect(Money.fromSatang(-50n).abs().satang).toBe(50n);
  });
});

describe('allocate', () => {
  it('conserves the total exactly (the property that matters)', () => {
    const total = Money.fromSatang(100n);
    const shares = total.allocate([1n, 1n, 1n]);
    expect(Money.sum(shares).satang).toBe(100n);
    expect(shares.map((s) => s.satang)).toEqual([34n, 33n, 33n]);
  });

  it('allocates proportionally to weights', () => {
    const shares = Money.fromSatang(1000n).allocate([3n, 1n]);
    expect(shares.map((s) => s.satang)).toEqual([750n, 250n]);
  });

  it('never loses a satang across awkward splits', () => {
    for (const total of [1n, 7n, 10n, 99n, 100n, 101n, 12345n]) {
      const money = Money.fromSatang(total);
      for (const n of [2, 3, 7]) {
        const shares = money.allocateEvenly(BigInt(n));
        expect(Money.sum(shares).satang).toBe(total);
      }
    }
  });

  it('distributes the remainder to the largest fractional part', () => {
    // 10 satang across weights 1,1,1 -> base 3.33 each, extra to index 0.
    const shares = Money.fromSatang(10n).allocate([1n, 1n, 1n]);
    expect(shares.map((s) => s.satang)).toEqual([4n, 3n, 3n]);
    expect(Money.sum(shares).satang).toBe(10n);
  });

  it('handles negative totals symmetrically', () => {
    const shares = Money.fromSatang(-100n).allocate([1n, 1n, 1n]);
    expect(Money.sum(shares).satang).toBe(-100n);
    expect(shares.map((s) => s.satang)).toEqual([-34n, -33n, -33n]);
  });

  it('rejects invalid weights', () => {
    expect(() => Money.fromSatang(100n).allocate([])).toThrow(MoneyError);
    expect(() => Money.fromSatang(100n).allocate([0n, 0n])).toThrow(MoneyError);
    expect(() => Money.fromSatang(100n).allocate([1n, -1n])).toThrow(MoneyError);
    expect(() => Money.fromSatang(100n).allocateEvenly(0n)).toThrow(MoneyError);
  });
});

describe('comparison', () => {
  it('compares and sums', () => {
    const a = Money.fromSatang(100n);
    const b = Money.fromSatang(200n);
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(Money.fromSatang(100n))).toBe(0);
    expect(a.equals(Money.fromSatang(100n))).toBe(true);
    expect(Money.sum([a, b]).satang).toBe(300n);
  });

  it('predicates', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.fromSatang(-1n).isNegative()).toBe(true);
    expect(Money.fromSatang(1n).isPositive()).toBe(true);
  });
});

describe('conversion', () => {
  it('formats canonically with two fraction digits', () => {
    expect(Money.fromSatang(10050n).toString()).toBe('100.50');
    expect(Money.fromSatang(5n).toString()).toBe('0.05');
    expect(Money.zero().toString()).toBe('0.00');
    expect(Money.fromSatang(-4550n).toString()).toBe('-45.50');
    expect(Money.fromSatang(1n).toString()).toBe('0.01');
  });

  it('round-trips string -> satang -> string', () => {
    for (const text of ['0.00', '0.01', '9.99', '100.50', '1234.56', '-45.50']) {
      expect(Money.fromString(text).toString()).toBe(text);
    }
  });

  it('serialises to JSON as a string, never a float', () => {
    const json = JSON.stringify({ amount: Money.fromString('45.50') });
    expect(json).toBe('{"amount":"45.50"}');
  });

  it('exposes satang as a safe number for transport', () => {
    expect(Money.fromSatang(10050n).toSatangNumber()).toBe(10050);
    expect(Money.fromSatang(1n).toSatangNumber()).toBe(1);
  });

  it('refuses to lose precision beyond safe integer range', () => {
    expect(() => Money.fromSatang(BigInt(Number.MAX_SAFE_INTEGER) + 2n).toSatangNumber()).toThrow(
      MoneyError,
    );
  });

  it('computes basis points for percentages', () => {
    const cost = Money.fromString('30.00');
    const price = Money.fromString('100.00');
    // 30% -> 3000 bp
    expect(cost.basisPointsOf(price)).toBe(3000n);
    // Food cost example: cost 33.33 of price 100.00 -> 3333 bp
    expect(Money.fromString('33.33').basisPointsOf(price)).toBe(3333n);
    expect(() => cost.basisPointsOf(Money.zero())).toThrow(MoneyError);
  });
});

describe('immutability', () => {
  it('never mutates the receiver', () => {
    const original = Money.fromSatang(100n);
    original.add(Money.fromSatang(50n));
    original.multiply(3n);
    original.negate();
    expect(original.satang).toBe(100n);
  });

  it('exposes satang as readonly at runtime', () => {
    const m = Money.fromSatang(100n);
    expect(() => {
      (m as unknown as { satang: bigint }).satang = 999n;
    }).toThrow();
  });
});

describe('constants', () => {
  it('exposes 100 satang per unit', () => {
    expect(SATANG_PER_UNIT).toBe(100n);
    expect(Money.fromSatang(SATANG_PER_UNIT).toString()).toBe('1.00');
  });
});
