/**
 * milliUnits — the unit ⇄ milli-integer boundary for stock counts.
 *
 * LAYER: domain. Pure TypeScript, zero imports: no React, no Tauri, no SQL. It
 * is the small sibling of `inventory/domain/quantity.ts` and exists for ONE
 * reason: the reconcile UI lets a manager type a stock count in ordinary units
 * ("2.5") while the Tauri contract carries and stores an integer count of
 * milli-units ("2500"). Between the keystroke and the wire sits a multiply, and
 * a multiply by 1000 is exactly where a number quietly becomes wrong.
 *
 * ── WHY `Math.round(x * 1000)` AND NOT `x * 1000` ───────────────────────────
 * A decimal typed by a human is an IEEE-754 double, so `0.1 + 0.2` is
 * `0.30000000000000004`, and `(0.1 + 0.2) * 1000` is `300.00000000000006` —
 * which `Number.isInteger` rejects and which, truncated, would store 300 or
 * 299 depending on the day. The contract fixes the scale at 1000 (three
 * fraction digits, `decimal(12,3)`), so the ONLY honest conversion is
 * "nearest integer milli-unit", and `Math.round` is that. A fourth fraction
 * digit is not a value this system can represent, so it is rounded to the
 * nearest milli-unit rather than silently accepted as more precision than
 * exists.
 *
 * ── WHY MILLI TRAVELS AS A `number` HERE ────────────────────────────────────
 * `invoke` serialises through JSON, and a JSON number is a double; a `bigint`
 * is not JSON-serialisable and `JSON.stringify(1n)` throws. The Rust side
 * reads these fields as `i64` from a JSON number, so the wire value is a
 * plain integer `number` — every milli-unit value on the reconcile contract is
 * therefore `number`, and never a `bigint` or a decimal string. This module is
 * the single place that turns a human's decimal into that integer.
 *
 * @see ../../inventory/domain/quantity.ts — the exact bigint form used for the
 *      money/ledger path; this module deliberately stays in the JSON-number
 *      world the Tauri reconcile contract lives in.
 */

export class MilliUnitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MilliUnitsError';
  }
}

/** Milli-units per whole unit. Fixed by the contract's `decimal(12,3)`. */
export const MILLI_PER_UNIT = 1000;

/**
 * Convert a count in ordinary units to an integer count of milli-units.
 *
 * Rejects anything that is not a finite, non-negative number BEFORE rounding,
 * so `NaN`, `Infinity`, and a negative count cannot become a milli integer.
 * The non-negative rule matches the reconcile contract: a resolved stock
 * balance is a physical count and cannot be below zero at this boundary.
 *
 * `Math.round(x * 1000)` — see the file header for why the round is the point.
 */
export function unitsToMilli(units: number): number {
  if (typeof units !== 'number' || Number.isNaN(units) || !Number.isFinite(units)) {
    throw new MilliUnitsError(`ปริมาณต้องเป็นตัวเลขที่ถูกต้อง ได้รับ: ${String(units)}`);
  }
  if (units < 0) {
    throw new MilliUnitsError('ปริมาณต้องไม่ติดลบ');
  }
  return Math.round(units * MILLI_PER_UNIT);
}

/**
 * Parse the text a manager types into the "กรอกเอง" field.
 *
 * Returns a discriminated result rather than throwing, because this runs on
 * every keystroke in a controlled input and a throw there is a crash, not a
 * validation message. `Number('')` is `0`, which would silently accept an
 * empty box as zero stock — so an empty/blank value is refused explicitly.
 * A value with more than three fraction digits is not rejected outright; it is
 * accepted as input and rounded to the nearest milli-unit by `unitsToMilli`
 * when it is finally converted, matching the contract's fixed scale.
 */
export function parseUnitsInput(
  raw: string,
): { readonly ok: true; readonly units: number } | { readonly ok: false; readonly error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'กรุณากรอกปริมาณ' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'กรุณากรอกตัวเลขเท่านั้น' };
  }
  if (value < 0) {
    return { ok: false, error: 'ปริมาณต้องไม่ติดลบ' };
  }
  return { ok: true, units: value };
}

/**
 * Render an integer milli count back to the canonical decimal string, always
 * with exactly three fraction digits: `2500 → "2.500"`, `-125 → "-0.125"`.
 *
 * Pure integer arithmetic on the absolute value — no float, no `toFixed` — so
 * it is the exact inverse of `unitsToMilli` for every accepted input and
 * matches `Quantity.toDecimalString` on the money/ledger path. Display only;
 * nothing here is sent back over the wire.
 */
export function milliToDecimalString(milli: number): string {
  if (typeof milli !== 'number' || !Number.isInteger(milli)) {
    throw new MilliUnitsError(`milli ต้องเป็นจำนวนเต็ม ได้รับ: ${String(milli)}`);
  }
  const negative = milli < 0;
  const magnitude = Math.abs(milli);
  const whole = Math.floor(magnitude / MILLI_PER_UNIT);
  const fraction = (magnitude % MILLI_PER_UNIT).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
