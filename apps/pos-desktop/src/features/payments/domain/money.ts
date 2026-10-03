/**
 * Money — integer satang value object.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `3 * 0.1 === 0.30000000000000004`. A POS that loses a fraction of a satang on
 * every line item will not reconcile at end of shift. Every monetary value in
 * this codebase is therefore an **integer number of satang** (฿45.50 = 4550),
 * wrapped so that a raw number can never be mistaken for an amount.
 *
 * ฿1 = 100 satang. The internal type is `bigint`; `number` is accepted only at
 * the explicit conversion boundaries below, and is validated.
 *
 * ── Rules ──────────────────────────────────────────────────────────────────
 * • Pure TypeScript. No framework, no library, no import of any kind.
 *   This module is the innermost layer: it may not import React, Tauri, SQL,
 *   or anything from the outside world. That constraint is the point.
 * • Immutable. Every operation returns a new `Money`.
 * • `fromNumber` is a *checked* boundary, not a convenience. It throws when the
 *   argument cannot be represented exactly. Prefer `fromString`.
 * • No silent rounding. `toNumber` and ratios round **half away from zero**,
 *   which is the standard for money, and never silently.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** satang per major currency unit (฿1 = 100 satang) */
export const SATANG_PER_UNIT = 100n;

/** Decimal places supported. Anything more is a unit-conversion bug, not a rounding choice. */
export const MAX_FRACTION_DIGITS = 2;

/** 1% expressed in basis points — used for Food Cost % and VAT rates. */
export const BASIS_POINTS_PER_PERCENT = 100n;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exact decimal division, rounding half away from zero.
 *
 * Half-up (not banker's rounding) is the commercial convention for money:
 * 0.005 satang rounds to 0.01, not to 0.00. Ties are resolved toward the
 * larger magnitude, so the result is symmetric about zero.
 */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new MoneyError('division by zero');
  }

  const isNegative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  // remainder/d >= 1/2  ⇔  2*remainder >= d
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;

  return isNegative ? -rounded : rounded;
}

/**
 * Render a JS number as its exact shortest decimal string.
 *
 * `String(0.1 + 0.2)` yields "0.30000000000000004" — the binary artifact is
 * *visible* in the decimal form. That is what makes this safe: the error
 * becomes something `fromString` can reject instead of silently propagating.
 * Exponential notation ("1e-7") is expanded so small magnitudes still parse.
 */
function numberToDecimalString(value: number): string {
  const raw = String(value);
  if (!/e/i.test(raw)) return raw;

  const parts = raw.split(/e/i);
  // `noUncheckedIndexedAccess` is on repo-wide, so destructuring `split` would
  // type these as `string | undefined`. Named lookups with explicit fallbacks
  // keep the guard visible instead of hiding it behind a non-null assertion.
  const mantissa = parts[0] ?? '0';
  const exponent = Number(parts[1] ?? '0');
  const negative = mantissa.startsWith('-');
  const digits = negative ? mantissa.slice(1) : mantissa;
  const digitParts = digits.split('.');
  const whole = digitParts[0] ?? '0';
  const fraction = digitParts[1] ?? '';

  let shiftedWhole: string;
  let shiftedFraction: string;

  if (exponent >= 0) {
    shiftedWhole = whole + fraction.padEnd(exponent, '0');
    shiftedFraction = '';
  } else {
    const borrow = -exponent;
    if (borrow >= whole.length) {
      shiftedWhole = '0';
      shiftedFraction = '0'.repeat(borrow - whole.length) + whole + fraction;
    } else {
      shiftedWhole = whole.slice(0, whole.length - borrow);
      shiftedFraction = whole.slice(whole.length - borrow) + fraction;
    }
  }

  const body = `${shiftedWhole || '0'}${shiftedFraction ? `.${shiftedFraction}` : ''}`;
  return negative ? `-${body}` : body;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

export class Money {
  /** The value in satang. The single source of truth for this object. */
  readonly satang: bigint;

  private constructor(satang: bigint) {
    this.satang = satang;
    // `readonly` is erased at runtime — TypeScript would not stop a stray
    // `money.satang = 0n` from a `any` cast or plain JS. Freezing makes the
    // immutability guarantee real, not advisory: a value object that can be
    // mutated after construction is a corruption source.
    Object.freeze(this);
  }

  // ── Construction ──────────────────────────────────────────────────────────

  /** Zero. */
  static zero(): Money {
    return new Money(0n);
  }

  /** Primary constructor — already an exact satang count. */
  static fromSatang(satang: bigint): Money {
    if (typeof satang !== 'bigint') {
      throw new MoneyError(`fromSatang expects a bigint, received ${typeof satang}`);
    }
    return new Money(satang);
  }

  /**
   * Parse a decimal string exactly: "100.50" → 10050 satang.
   *
   * This is the preferred boundary for user input and config values. No float
   * is involved anywhere in the conversion.
   *
   * Accepts an optional sign, digits, and up to two fraction digits:
   *   "100"  "100.5"  "100.50"  "100."  "-0.01"  "+12.34"
   * Rejects exponents, thousands separators, and >2 fraction digits.
   */
  static fromString(value: string): Money {
    if (typeof value !== 'string') {
      throw new MoneyError(`fromString expects a string, received ${typeof value}`);
    }

    const trimmed = value.trim();
    const match = /^([+-]?)(\d+)(?:\.(\d{0,2}))?$/.exec(trimmed);
    if (!match) {
      throw new MoneyError(
        `invalid money string ${JSON.stringify(value)} ` +
          '(expected digits with at most 2 decimal places, e.g. "100.50")',
      );
    }

    const sign = match[1] === '-' ? -1n : 1n;
    // The regex guarantees groups 1-3 exist; these fallbacks satisfy
    // noUncheckedIndexedAccess without a non-null assertion.
    const whole = BigInt(match[2] ?? '0');
    const fraction = (match[3] ?? '').padEnd(2, '0');

    return new Money(sign * (whole * SATANG_PER_UNIT + BigInt(fraction)));
  }

  /**
   * Convert a JS number — a **checked** boundary.
   *
   * Throws when the number cannot be represented exactly in satang, which
   * happens whenever binary floating point has drifted. Concretely:
   *
   *   Money.fromNumber(100.5)     → 10050n   ✅ exact
   *   Money.fromNumber(0.1 + 0.2) → throws   ❌ "0.30000000000000004"
   *   Money.fromNumber(1.005)     → throws   ❌ three decimal places
   *
   * That rejection is intentional. A silent "fix" here would reintroduce the
   * float error this type exists to prevent. Use `fromString` for literals.
   */
  static fromNumber(value: number): Money {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new MoneyError(`fromNumber expects a finite number, received ${String(value)}`);
    }
    return Money.fromString(numberToDecimalString(value));
  }

  // ── Arithmetic ────────────────────────────────────────────────────────────

  add(other: Money): Money {
    return new Money(this.satang + other.satang);
  }

  subtract(other: Money): Money {
    return new Money(this.satang - other.satang);
  }

  /** Multiply by a whole factor, e.g. 3 × unit price. Exact, never rounds. */
  multiply(factor: bigint): Money {
    if (typeof factor !== 'bigint') {
      throw new MoneyError(`multiply expects a bigint factor, received ${typeof factor}`);
    }
    return new Money(this.satang * factor);
  }

  /**
   * Multiply by an exact ratio, rounding half away from zero.
   *
   * For integer ratios prefer `multiply` — this is for genuine fractions such
   * as a unit conversion (250g → 0.25kg) or a tax rate.
   */
  multiplyRatio(numerator: bigint, denominator: bigint): Money {
    return new Money(divideRoundHalfUp(this.satang * numerator, denominator));
  }

  /** Divide by a whole divisor, rounding half away from zero. */
  divide(divisor: bigint): Money {
    if (typeof divisor !== 'bigint') {
      throw new MoneyError(`divide expects a bigint divisor, received ${typeof divisor}`);
    }
    if (divisor === 0n) {
      throw new MoneyError('division by zero');
    }
    return new Money(divideRoundHalfUp(this.satang, divisor));
  }

  negate(): Money {
    return new Money(-this.satang);
  }

  abs(): Money {
    return this.satang < 0n ? new Money(-this.satang) : this;
  }

  // ── Allocation ────────────────────────────────────────────────────────────
  //
  // The core problem: splitting an amount proportionally usually leaves a
  // remainder. Naively flooring every share loses satang; naively giving the
  // remainder to the first share biases it. `allocate` uses the largest-
  // remainder method, so the shares are as fair as integers allow AND the sum
  // is still exact.

  /**
   * Split proportionally to `weights`, distributing the remainder by largest
   * fractional part. **The returned amounts always sum exactly to this.**
   *
   *   Money.fromSatang(100n).allocate([1n, 1n, 1n])
   *     → [34n, 33n, 33n]   (sum 100, extra satang to the first, ties by index)
   *
   * @param weights non-negative weights; at least one must be > 0
   */
  allocate(weights: readonly bigint[]): Money[] {
    if (weights.length === 0) {
      throw new MoneyError('allocate requires at least one weight');
    }
    if (weights.some((w) => w < 0n)) {
      throw new MoneyError('allocate weights must be non-negative');
    }

    let totalWeight = 0n;
    for (const weight of weights) {
      totalWeight += weight;
    }
    if (totalWeight === 0n) {
      throw new MoneyError('allocate requires at least one non-zero weight');
    }

    // Work on the magnitude throughout. Computing shares directly from a
    // negative total would truncate toward zero (an odd asymmetry: -33.33
    // floors to -33, not -34) and the leftover would come out negative.
    // Splitting the magnitude and re-applying the sign at the end keeps the
    // method symmetric: allocate(x) === allocate(-x).map(negate).
    const isNegative = this.satang < 0n;
    const magnitude = isNegative ? -this.satang : this.satang;

    // Floor each share of the magnitude, tracking the fractional remainder.
    const shares: bigint[] = [];
    const remainders: { index: number; numerator: bigint }[] = [];

    weights.forEach((weight, index) => {
      const numerator = magnitude * weight;
      shares.push(numerator / totalWeight);
      const remainder = numerator % totalWeight;
      if (remainder !== 0n) {
        remainders.push({ index, numerator: remainder });
      }
    });

    remainders.sort((a, b) => {
      if (a.numerator === b.numerator) return a.index - b.index;
      return a.numerator > b.numerator ? -1 : 1;
    });

    const leftover = magnitude - shares.reduce((sum, share) => sum + share, 0n);

    // Hand the leftover out one satang at a time, largest fractional part
    // first. Ties break by ascending index, so the split is deterministic.
    let handedOut = 0n;
    for (const { index } of remainders) {
      if (handedOut === leftover) break;
      const current = shares[index];
      if (current === undefined) continue;
      shares[index] = current + 1n;
      handedOut += 1n;
    }

    // Invariant: no satang created or destroyed by the split. If this fires,
    // returning a wrong split would silently corrupt a financial total.
    const allocated = shares.reduce((sum, share) => sum + share, 0n);
    if (allocated !== magnitude) {
      throw new MoneyError(
        `allocate invariant violated: shares sum to ${allocated}, expected ${magnitude}`,
      );
    }

    return shares.map((share) => new Money(isNegative ? -share : share));
  }

  /**
   * Split into `count` equal parts, remainder satang going to the earliest
   * shares. The sum is always exactly this amount.
   */
  allocateEvenly(count: bigint): Money[] {
    if (count <= 0n) {
      throw new MoneyError('allocateEvenly requires a positive count');
    }
    return this.allocate(new Array<bigint>(Number(count)).fill(1n));
  }

  // ── Comparison ────────────────────────────────────────────────────────────

  equals(other: Money): boolean {
    return this.satang === other.satang;
  }

  compare(other: Money): -1 | 0 | 1 {
    if (this.satang < other.satang) return -1;
    if (this.satang > other.satang) return 1;
    return 0;
  }

  isZero(): boolean {
    return this.satang === 0n;
  }

  isNegative(): boolean {
    return this.satang < 0n;
  }

  isPositive(): boolean {
    return this.satang > 0n;
  }

  static sum(amounts: readonly Money[]): Money {
    return amounts.reduce((total, amount) => total.add(amount), Money.zero());
  }

  // ── Conversion ────────────────────────────────────────────────────────────

  /** Canonical decimal string: 10050n → "100.50". Always two fraction digits. */
  toString(): string {
    const negative = this.satang < 0n;
    const magnitude = negative ? -this.satang : this.satang;
    const whole = magnitude / SATANG_PER_UNIT;
    const fraction = (magnitude % SATANG_PER_UNIT).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  /**
   * The satang count as a JS number, for JSON transport and DB binding.
   * Throws beyond `Number.MAX_SAFE_INTEGER` — a value that large is a data
   * error, and silently losing precision on money is unacceptable.
   */
  toSatangNumber(): number {
    if (this.satang > BigInt(Number.MAX_SAFE_INTEGER) || this.satang < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new MoneyError(
        `satang value ${this.satang} exceeds safe integer range; use toString() for transport`,
      );
    }
    return Number(this.satang);
  }

  /**
   * The amount as a plain number of currency units: 10050n → 100.5.
   *
   * ⚠️ For **display only**. A value like 0.1 + 0.2 rendered here is exactly
   * the error this class exists to prevent — format for display with
   * `toString()` and keep arithmetic in satang.
   */
  toNumber(): number {
    return Number(this.toString());
  }

  /**
   * `this` as a percentage of `whole`, in basis points: 30% → 3000n.
   * Rounds half away from zero. Throws when `whole` is zero.
   *
   * This is the Food Cost % / VAT-rate primitive.
   */
  basisPointsOf(whole: Money): bigint {
    if (whole.satang === 0n) {
      throw new MoneyError('cannot express a percentage of zero');
    }
    return divideRoundHalfUp(this.satang * 10_000n, whole.satang);
  }

  /** `part` as a percentage of `whole` where `part` is not itself a Money. */
  static basisPointsOf(part: Money, whole: Money): bigint {
    return part.basisPointsOf(whole);
  }

  /** JSON representation — the decimal string, never a float. */
  toJSON(): string {
    return this.toString();
  }
}

export default Money;
