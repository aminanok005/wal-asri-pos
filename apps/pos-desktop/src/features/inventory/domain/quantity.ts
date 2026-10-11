/**
 * Quantity — an exact decimal held as an integer count of MILLI-units.
 *
 * LAYER: domain. Pure TypeScript, zero imports: no React, no Tauri, no SQL, no
 * HTTP. It is the sibling of `payments/domain/money.ts` and obeys the same rule
 * for the same reason — with one difference that makes it its own class rather
 * than a reuse of `Money`.
 *
 * ── WHY NOT `Money` ──────────────────────────────────────────────────────────
 *
 * `Money` is satang: **unsigned**, two fraction digits, and the satang is the
 * *currency's* minor unit. A quantity is none of those things.
 *
 *   * A quantity is SIGNED. The contract's `Quantity` pattern is
 *     `^-?\d+(\.\d{1,3})?$` and its own documentation says why: "a balance may go
 *     negative when an offline terminal oversells stock". `Money` refuses a sign
 *     everywhere except `SignedSatang`, so a stock balance has no honest
 *     representation inside it.
 *   * A quantity has THREE fraction digits, because `on_hand` is
 *     `decimal(12,3)` in the data model: a balance can be `2.500` kg of flour.
 *     `Money.MAX_FRACTION_DIGITS` is 2, and raising it would silently admit
 *     satang values that no balance should ever hold.
 *   * A quantity is not money. Nothing here may be added to a satang amount, and
 *     the only conversions out are `toDecimalString` (transport) and
 *     `toMilliNumber` (a SQLite binding, range-checked). There is deliberately
 *     no `toNumber()` returning "units as a float" — that is precisely the
 *     value this class exists to prevent.
 *
 * ── WHY MILLI-UNITS, AND WHY AN INTEGER AT ALL ───────────────────────────────
 *
 * `2.500` is not representable in binary floating point, but neither is `0.1`.
 * The problem is not the decimal point, it is that a *ratio* of decimal places
 * meets an IEEE-754 double, and `2.500 * 1000 === 2500` holds only by luck of
 * rounding. Milli-units (`bigint`, exact) removes the arithmetic from the float
 * domain entirely: `2500n / 1000n` is exactly `2n`, and rendering back is
 * integer division plus a zero-padded remainder.
 *
 * The scale is fixed at 1000 because the contract fixes it: `Quantity` allows at
 * most three fraction digits. A fourth digit is not a value this system can
 * represent, so it is rejected rather than rounded — silently truncating a
 * stock count is how a shop sells flour it does not have.
 *
 * ── THE STRING RULE AT THIS BOUNDARY ─────────────────────────────────────────
 *
 * `fromWire` accepts a `string` and NOTHING else. It rejects `number`,
 * `bigint`, and `null` outright, before the grammar is even consulted. A JSON
 * number reaching this class means something upstream already lost the exact
 * value, and accepting it would launder the loss into a value that looks
 * authoritative. The wire carries a string; the wire gets a string.
 *
 * @see ../domain/README.md — "stock is a ledger", the rule this feeds
 * @see contracts/openapi.yaml — schema `Quantity`, the grammar enforced here
 */

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class QuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuantityError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Milli-units per whole unit (1 unit = 1000 milli-units). Fixed by `decimal(12,3)`. */
export const MILLI_PER_UNIT = 1000n;

/** Fraction digits this system can represent. More is unrepresentable, not rounded. */
export const MAX_FRACTION_DIGITS = 3;

/**
 * The wire grammar for a quantity: `^-?(0|[1-9][0-9]*)(\.[0-9]{1,3})?$`.
 *
 * A **tightening of the contract**, deliberately. `contracts/openapi.yaml`
 * schema `Quantity` states `^-?\d+(\.\d{1,3})?$`, and this rejects three shapes
 * that pattern permits. Each is a second spelling of a value we already have,
 * which is exactly how two terminals end up disagreeing about the same shelf:
 *
 *   * `"07"` — a leading zero. It parses, and it is precisely what a
 *     zero-padded formatter emits, so it is a bug worth reporting rather than
 *     absorbing. It matches the reasoning already recorded for `"04550"` satang
 *     in `payments/domain/money.ts`.
 *   * `"-0"` — a sign on zero. Rejected for the same reason: `"-0"` and `"0"`
 *     are one value with two spellings.
 *   * `"-07"` — both of the above at once.
 *
 * A leading `+` is absent from the contract pattern and is likewise refused
 * here. Everything else — a decimal point with no digits (`"2."`), no integer
 * part (`".5"`), an exponent (`"2.5e3"`), whitespace, and more than three
 * fraction digits — is refused too.
 *
 * ### Why signed zero needs its own look-ahead
 *
 * The negative branch of the body would happily accept `-0`, `-0.0` and
 * `-0.000`, because the body only constrains the digit run and the fraction, not
 * what they add up to. So the leading look-ahead refuses exactly "a minus sign
 * followed by nothing but zeros", while still allowing `-0.001` — which is a real
 * negative quantity and must parse. The alternative, checking the parsed value
 * for zero and then deciding it was invalid, would reject `-0.000` only by
 * accident of where the check sat, and would leave the *pattern* — the thing the
 * Rust parser and any future reader consult — quietly wrong.
 */
export const QUANTITY_PATTERN = /^(?!-0(?:\.0{1,3})?$)-?(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/;

/**
 * How large a milli-value may be before it can no longer be bound to a SQLite
 * INTEGER without loss. `2^63 - 1`.
 *
 * SQLite stores an INTEGER as at most 64 bits. A balance above this is not a
 * real stock figure — it is a parsing bug that survived three checks.
 */
export const MAX_MILLI = 9_223_372_036_854_775_807n;

// ─────────────────────────────────────────────────────────────────────────────
// The value object
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An exact decimal quantity, stored as an integer count of milli-units.
 *
 * Immutable and frozen: a `Quantity` handed to a view cannot be edited, so the
 * only way to change one is to compute a new one through `add`/`subtract`.
 */
export class Quantity {
  /** Exact count of milli-units. `2.500 kg` is `2500n`. */
  readonly milli: bigint;

  private constructor(milli: bigint) {
    this.milli = milli;
    Object.freeze(this);
  }

  // ── Construction ───────────────────────────────────────────────────────────

  /** Zero, the additive identity. */
  static zero(): Quantity {
    return new Quantity(0n);
  }

  /**
   * Build from an exact milli-count. The range check is real, not decorative:
   * above `MAX_MILLI` the value cannot be stored, and a silent wrap at COMMIT is
   * the failure mode it exists to prevent.
   */
  static fromMilli(milli: bigint): Quantity {
    if (typeof milli !== 'bigint') {
      throw new QuantityError(
        `milli-units must be a bigint; received ${typeof milli}. Convert at the wire, never here.`,
      );
    }
    if (milli > MAX_MILLI || milli < -MAX_MILLI) {
      throw new QuantityError(
        `quantity ${milli} milli-units exceeds the SQLite INTEGER range (±${MAX_MILLI})`,
      );
    }
    return new Quantity(milli);
  }

  /**
   * Parse the contract's `Quantity` string into an exact value.
   *
   * A **string and nothing else**. `fromWire` rejects a JSON `number` before
   * testing the grammar, because a number here means precision was already lost
   * upstream and re-wrapping it would disguise that as a clean value.
   *
   * The parse is pure integer string surgery: split on the point, keep the sign,
   * and pad the fraction to three digits. No `parseFloat`, no `Number`, no
   * exponent.
   */
  static fromWire(field: string, raw: unknown): Quantity {
    if (typeof raw !== 'string') {
      throw new QuantityError(
        `${field}: a quantity must cross the bridge as a STRING, received ${typeof raw}. ` +
          'A JSON number is a double in JavaScript, and 2.500 is not representable as one.',
      );
    }
    if (!QUANTITY_PATTERN.test(raw)) {
      // Signed zero is singled out because it is the one rejected shape a caller
      // is most likely to hit by accident — a formatter that emits `-0.000` for a
      // quantity that rounded to zero. A generic "not a valid Quantity" would
      // send someone hunting the grammar when the fix is one line in their own
      // code. The leading-zero case gets the same treatment for the same reason.
      if (/^-0(?:\.0{1,3})?$/.test(raw)) {
        throw new QuantityError(
          `${field}: ${JSON.stringify(raw)} is negative zero, a second spelling of zero. ` +
            'Send "0.000" instead.',
        );
      }
      if (/^-?0[0-9]/.test(raw)) {
        throw new QuantityError(
          `${field}: ${JSON.stringify(raw)} has a leading zero. Send the canonical decimal form.`,
        );
      }
      throw new QuantityError(
        `${field}: ${JSON.stringify(raw)} is not a valid Quantity. Expected ` +
          '^-?(0|[1-9][0-9]*)(\\.[0-9]{1,3})?$ — canonical digits, at most three ' +
          'fraction places, no sign on zero and no leading zero.',
      );
    }

    const negative = raw.startsWith('-');
    const digits = negative ? raw.slice(1) : raw;
    const point = digits.indexOf('.');

    // Both halves are digit runs already validated by the pattern, so `BigInt`
    // here is a re-typing of an exact base-ten integer, not a parse of a float.
    const whole = point === -1 ? BigInt(digits) : BigInt(digits.slice(0, point));
    // `'2' → '000'`, `'2.5' → '500'`, `'2.50' → '500'`. Right-padded, so
    // `'2.50'` and `'2.5'` are the SAME value with two spellings — which the
    // canonical `toDecimalString` output deliberately does not produce.
    const fraction = (point === -1 ? '' : digits.slice(point + 1)).padEnd(MAX_FRACTION_DIGITS, '0');

    const milli = whole * MILLI_PER_UNIT + BigInt(fraction);
    return new Quantity(negative ? -milli : milli);
  }

  // ── Arithmetic ─────────────────────────────────────────────────────────────

  add(other: Quantity): Quantity {
    return Quantity.fromMilli(this.milli + other.milli);
  }

  subtract(other: Quantity): Quantity {
    return Quantity.fromMilli(this.milli - other.milli);
  }

  static sum(quantities: readonly Quantity[]): Quantity {
    return quantities.reduce((total, q) => total.add(q), Quantity.zero());
  }

  // ── Comparison ─────────────────────────────────────────────────────────────

  equals(other: Quantity): boolean {
    return this.milli === other.milli;
  }

  compare(other: Quantity): -1 | 0 | 1 {
    if (this.milli < other.milli) return -1;
    if (this.milli > other.milli) return 1;
    return 0;
  }

  isZero(): boolean {
    return this.milli === 0n;
  }

  isNegative(): boolean {
    return this.milli < 0n;
  }

  isPositive(): boolean {
    return this.milli > 0n;
  }

  /**
   * Available-to-sell, the one derived figure this feature needs.
   *
   * The contract defines it as `on_hand - reserved` on `StockBalance`. It is
   * computed here rather than stored, so it cannot drift away from the two
   * columns it is derived from — a stored "available" column is a third number
   * to reconcile and the first one to go stale.
   *
   * Signed on purpose: an oversold item has a negative available figure, and
   * hiding the sign is how a cashier is shown stock that is not there.
   */
  availableToSell(reserved: Quantity): Quantity {
    return this.subtract(reserved);
  }

  // ── Conversion ─────────────────────────────────────────────────────────────

  /**
   * The canonical wire string, always with exactly three fraction digits:
   * `2500n → "2.500"`, `-125n → "-0.125"`, `0n → "0.000"`.
   *
   * `toFixed(3)` is explicitly NOT used — it goes through a double, which is the
   * entire reason this class exists. Integer division plus a zero-padded
   * remainder produces the same string with no rounding step available to get
   * wrong.
   *
   * This is the ONLY form a quantity may take on the wire or in JSON, and it is
   * the exact inverse of `fromWire` for every accepted input.
   */
  toDecimalString(): string {
    const negative = this.milli < 0n;
    const magnitude = negative ? -this.milli : this.milli;
    const whole = magnitude / MILLI_PER_UNIT;
    const fraction = (magnitude % MILLI_PER_UNIT).toString().padStart(MAX_FRACTION_DIGITS, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  /**
   * The milli-count as a JSON `number`, for binding to a SQLite INTEGER.
   *
   * Range-checked against `Number.MAX_SAFE_INTEGER` and refused beyond it. This
   * is NOT the value this feature does arithmetic on — it exists so the
   * millisecond-free, decimal-free integer column has something to bind, and it
   * is safe for every balance a shop can physically hold.
   */
  toMilliNumber(): number {
    if (this.milli > BigInt(Number.MAX_SAFE_INTEGER) || this.milli < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new QuantityError(
        `quantity ${this.milli} milli-units exceeds the safe integer range; use toDecimalString() for transport`,
      );
    }
    return Number(this.milli);
  }

  /** JSON representation — the decimal string, never a float. */
  toJSON(): string {
    return this.toDecimalString();
  }
}

export default Quantity;