/**
 * `Quantity` — the milli-unit value object, tested against the rules it claims.
 *
 * The interesting assertions here are the NEGATIVE ones. A parser that accepts
 * `"2.5"` and `"2.50"` and `"02.5"` all as one value is fine on its own; the
 * reason to refuse the second and third spellings is that a POS terminal and a
 * back office then disagree about one shelf, and nothing anywhere reports it.
 * Those rejections are therefore part of the contract, not a stylistic choice,
 * and each test below says what it costs to drop it.
 */

import { describe, expect, it } from 'bun:test';
import { Quantity, QuantityError, MILLI_PER_UNIT, QUANTITY_PATTERN } from './quantity';

/** Parse, asserting success — keeps the happy-path cases to one line each. */
function q(raw: string): Quantity {
  return Quantity.fromWire('field', raw);
}

describe('quantity — parsing the contract grammar', () => {
  it('reads a decimal quantity as an exact count of milli-units', () => {
    // THE test for this class. `2.500` is not representable as a binary double,
    // and the whole reason `Quantity` exists is that it does not have to be.
    expect(q('2.500').milli).toBe(2500n);
    expect(q('0.001').milli).toBe(1n);
    expect(q('12').milli).toBe(12_000n);
    expect(q('0').milli).toBe(0n);
    expect(q('123.456').milli).toBe(123_456n);
  });

  it('is scale-invariant: three digits is one whole unit', () => {
    expect(MILLI_PER_UNIT).toBe(1000n);
    expect(q('1.000').milli / MILLI_PER_UNIT).toBe(1n);
  });

  it('treats a trailing zero as a second spelling of one value', () => {
    // `"2.5"` and `"2.50"` are accepted and equal, because both are exact and
    // neither is a rounding. The CANONICAL form is only what we emit.
    expect(q('2.5').milli).toBe(2500n);
    expect(q('2.50').milli).toBe(2500n);
    expect(q('2.5').equals(q('2.50'))).toBe(true);
  });

  it('accepts a negative balance, because an offline terminal can oversell', () => {
    // The contract's own `Quantity` docs say so. Refusing this would make the
    // terminal unable to RECORD the oversell an operator needs to see.
    expect(q('-0.125').milli).toBe(-125n);
    expect(q('-3').milli).toBe(-3000n);
    expect(q('-0.001').isNegative()).toBe(true);
  });

  // ── The rule this whole class rests on ────────────────────────────────────

  it('never routes a quantity through a binary float', () => {
    // `0.1 + 0.2 !== 0.3` is the satang rule's proof, repeated here for a
    // quantity. The assertion that matters is the FIRST one: the domain gives
    // exactly 300. The second asserts the bug the first one is avoiding.
    const sum = q('0.1').add(q('0.2'));
    expect(sum.milli).toBe(300n);
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('is exact where a double is not, over many additions', () => {
    // A hundred additions of 0.1 in floating point land nowhere near 10. In
    // milli-units there is nowhere to be inexact.
    let total = Quantity.zero();
    for (let i = 0; i < 100; i += 1) total = total.add(q('0.1'));

    expect(total.milli).toBe(10_000n);
    expect(total.toDecimalString()).toBe('10.000');
  });
});

describe('quantity — what it refuses, and why', () => {
  it('refuses a fourth fraction digit rather than truncating it', () => {
    // `on_hand` is decimal(12,3): the server cannot store a fourth digit either,
    // so this is unrepresentable rather than a rounding decision. Silently
    // dropping the digit is how a shop sells flour it does not have.
    expect(() => q('2.5001')).toThrow(QuantityError);
    expect(() => q('2.5001')).toThrow(/three/);
  });

  it('refuses a JSON number outright, before even looking at the grammar', () => {
    // A number here means precision was already lost upstream — `2.5` is fine as
    // a double, but `"2.500"` was a string that got laundered somewhere. The
    // wire carries a string, so the wire gets a string.
    expect(() => Quantity.fromWire('onHand', 2.5)).toThrow(/must cross the bridge as a STRING/);
    expect(() => Quantity.fromWire('onHand', 2500)).toThrow(/STRING/);
    expect(() => Quantity.fromWire('onHand', 2500n)).toThrow(/STRING/);
    expect(() => Quantity.fromWire('onHand', null)).toThrow(/STRING/);
    expect(() => Quantity.fromWire('onHand', undefined)).toThrow(/STRING/);
  });

  it('refuses a leading zero, which is what a zero-padded formatter emits', () => {
    expect(() => q('07')).toThrow(/leading zero/);
    expect(() => q('02.500')).toThrow(/leading zero/);
  });

  it('refuses a sign on zero, which is a second spelling of zero', () => {
    expect(() => q('-0')).toThrow(/negative zero/);
    expect(() => q('-0.000')).toThrow(/negative zero/);
  });

  it('refuses an explicit plus, so a value has exactly one spelling', () => {
    expect(() => q('+5')).toThrow(QuantityError);
  });

  it('refuses whitespace, exponents and non-base-ten digits', () => {
    for (const bad of [' 5', '5 ', '2.5e3', '0x11A', '1,5', 'NaN', 'Infinity']) {
      expect(() => q(bad)).toThrow(QuantityError);
    }
  });

  it('refuses a bare point or a bare sign, rather than guessing what was meant', () => {
    // `"2."` is the shape a formatter emits when it loses its digits; guessing
    // `2` would hide a broken value behind a plausible one.
    for (const bad of ['2.', '.5', '-', '', '.']) {
      expect(() => q(bad)).toThrow(QuantityError);
    }
  });

  it('names the field in the rejection, so a snapshot failure is actionable', () => {
    // The mapping edge stacks a row index on top of this; both halves are needed
    // to find the offending row in a branch's whole inventory.
    expect(() => Quantity.fromWire('balances[7].onHand', '2.5001')).toThrow(
      /balances\[7\]\.onHand/,
    );
  });

  it('tightens the contract pattern on purpose, and the pattern says so', () => {
    // These three parse under the contract's `^-?\d+(\.\d{1,3})?$` and are
    // refused here. Asserted explicitly so the tightening is a documented
    // decision rather than looking like a discrepancy someone should fix.
    expect(QUANTITY_PATTERN.test('07')).toBe(false);
    expect(QUANTITY_PATTERN.test('-0')).toBe(false);
    expect(QUANTITY_PATTERN.test('2.500')).toBe(true);
  });
});

describe('quantity — conversion back to the wire', () => {
  it('emits exactly three fraction digits, always', () => {
    // The trailing zeros are load-bearing: they are what makes "2.500" and
    // "2.5" the same string, and a stored row that depends on the spelling it
    // arrived with is a row that cannot be compared.
    expect(q('2.500').toDecimalString()).toBe('2.500');
    expect(q('2.5').toDecimalString()).toBe('2.500');
    expect(q('12').toDecimalString()).toBe('12.000');
    expect(q('0.001').toDecimalString()).toBe('0.001');
    expect(q('0').toDecimalString()).toBe('0.000');
  });

  it('round-trips every accepted input exactly', () => {
    for (const raw of ['0', '1.000', '2.500', '0.001', '123.456', '-0.125', '-3.000', '12']) {
      expect(q(q(raw).toDecimalString()).equals(q(raw))).toBe(true);
    }
  });

  it('serialises to JSON as a string, never a number', () => {
    // `JSON.stringify` is how this value reaches `invoke`, so its `toJSON` is
    // the last chance to be a number. `Number` here would defeat the entire
    // class, silently.
    expect(JSON.stringify({ onHand: q('2.500') })).toBe('{"onHand":"2.500"}');
    expect(JSON.stringify(q('2.500'))).toBe('"2.500"');
  });

  it('emits a safe-integer milli count for binding, and refuses beyond it', () => {
    // The SQLite column is an INTEGER, so something number-typed has to bind.
    // Range-checked, because a silent precision loss here would defeat the type.
    expect(q('2.500').toMilliNumber()).toBe(2500);
    const huge = Quantity.fromMilli(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => huge.toMilliNumber()).toThrow(/safe integer/);
  });

  it('refuses to be built from a non-bigint or an out-of-range milli count', () => {
    expect(() => Quantity.fromMilli(2500 as unknown as bigint)).toThrow(/must be a bigint/);
    expect(() => Quantity.fromMilli(10n ** 30n)).toThrow(/SQLite INTEGER range/);
  });
});

describe('quantity — arithmetic, comparison and the derived figure', () => {
  it('adds and subtracts without leaving the exact domain', () => {
    expect(q('2.500').add(q('0.250')).milli).toBe(2750n);
    expect(q('2.500').subtract(q('0.250')).milli).toBe(2250n);
    expect(Quantity.sum([q('1.000'), q('2.500'), q('0.500')]).toDecimalString()).toBe('4.000');
    expect(Quantity.sum([]).isZero()).toBe(true);
  });

  it('is immutable: every operation returns a new value', () => {
    // Frozen, not just `readonly`: a balance handed to a view must not be
    // editable, or the version on screen stops matching the one in SQLite.
    const original = q('2.500');
    original.add(q('1.000'));

    expect(original.milli).toBe(2500n);
    expect(Object.isFrozen(original)).toBe(true);
  });

  it('compares across the sign boundary', () => {
    expect(q('-0.125').compare(q('0.125'))).toBe(-1);
    expect(q('1.000').compare(q('1.000'))).toBe(0);
    expect(q('2.000').compare(q('1.999'))).toBe(1);
    expect(q('0.001').isPositive()).toBe(true);
  });

  it('derives available-to-sell as on_hand minus reserved', () => {
    // Computed, never stored: a stored "available" column is a third number to
    // reconcile and the first to go stale.
    const onHand = q('2.500');
    const reserved = q('0.250');

    expect(onHand.availableToSell(reserved).toDecimalString()).toBe('2.250');
  });

  it('reports a negative available figure rather than clamping it to zero', () => {
    // More is reserved than is on hand. Clamping to zero would hide the
    // oversell behind "nothing available", which reads as fine.
    expect(q('1.000').availableToSell(q('1.500')).toDecimalString()).toBe('-0.500');
    expect(q('1.000').availableToSell(q('1.000')).isZero()).toBe(true);
  });
});