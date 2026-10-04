/**
 * Cash rounding — rounding a total to a coin the drawer can actually dispense.
 *
 * LAYER: domain. Pure TypeScript. No React, no Tauri, no SQL, no `Intl`, and
 * above all **no float**. Every amount is integer satang (`bigint`).
 *
 * ── WHY THIS IS A DOMAIN RULE AND NOT A DISPLAY DETAIL ────────────────────────
 *
 * Thai coins do not come in satang. The drawer holds ฿1, ฿5, ฿10, ฿25, ฿50 and
 * ฿100 notes and 25- and 50-satang coins, so a total of ฿45.52 **cannot be paid
 * exactly** — the customer hands over ฿50 and the cashier must give change, and
 * if the drawer cannot make that change the whole transaction stalls. Rounding
 * the total to a payable figure is therefore a pricing decision made *before*
 * payment, not an afterthought at the till.
 *
 * ── WHY THE ADJUSTMENT IS SIGNED ──────────────────────────────────────────────
 *
 * Round-to-nearest moves in BOTH directions: ฿45.63 rounds *up* to ฿45.75
 * (+12 satang) and ฿45.52 rounds *down* to ฿45.50 (−2 satang). The adjustment
 * is the signed difference between what the customer owed and what they are
 * charged.
 *
 * ⚠️ THIS IS IN TENSION WITH THE SHIPPED SCHEMA. `migrations/0001_init.sql:188`
 * declares:
 *
 *     rounding_adjustment_satang INTEGER NOT NULL
 *       CHECK (typeof(...) = 'integer' AND rounding_adjustment_satang >= 0)
 *
 * That CHECK rejects any rounding that rounds *down*, so a ฿45.52 cash sale
 * rounds in this module to a negative adjustment and then FAILS TO COMMIT.
 *
 * This module is written to the correct arithmetic rather than bent to fit the
 * constraint, because the alternative — a "round" function that can only ever
 * round up — would quietly overcharge every customer whose total falls in the
 * lower half of each interval, and the error would be invisible and legal-
 * looking. Fixing storage is a schema migration (0002) and a product decision
 * about who absorbs the difference; see the handover note. **Until that
 * migration exists, only totals that round UP can actually be committed.**
 *
 * ── WHY DIGITAL PAYMENT IS NEVER ROUNDED ─────────────────────────────────────
 *
 * A QR / PromptPay transfer moves an exact amount. There is no drawer, no
 * change, and no coin to dispense: ฿45.52 is a perfectly payable total, and
 * rounding it to ฿45.50 means the customer has underpaid by 2 satang. So the
 * adjustment for a digital method is `0n` — not a rounding convenience, but a
 * correctness requirement of the rail.
 *
 * @see ../../payments/domain/money.ts — the satang value object used throughout
 * @see ./tax.ts — VAT is extracted BEFORE this runs, from the unrounded total
 */

import { Money } from '../../payments/domain/money';

/** Satang — a whole number of satang. ฿1 = 100 satang. */
export type Satang = bigint;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class RoundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundingError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The coin steps a Thai till can actually dispense, in satang.
 *
 * 25 and 50 are the coin denominations; 100 (฿1) and 500 (฿5) are included
 * because branches that carry only notes round to the nearest baht instead. All
 * are exact divisors of 100 satang, which is what keeps the arithmetic in this
 * module exact — a step that is not a divisor of ฿1 would force rounding at the
 * satang level and reintroduce a fractional baht.
 */
export const THAI_CASH_STEPS: readonly Satang[] = [25n, 50n, 100n, 500n];

/** The most common step: the 25-satang coin. */
export const DEFAULT_CASH_STEP: Satang = 25n;

/**
 * How the customer is paying.
 *
 * `Cash` is the only method that rounds. Everything else settles an exact
 * amount electronically.
 */
export type PaymentMethod = 'cash' | 'qr' | 'promptpay' | 'card' | 'transfer';

/**
 * Whether a payment method participates in cash rounding.
 *
 * A single predicate rather than a scattered `method === 'cash'` at each call
 * site: the rule "digital is never rounded" is the kind of rule that must hold
 * in exactly one place, because the day someone adds `e_wallet` and forgets to
 * update the other branch, the system starts short-paying a customer without
 * any error anywhere.
 */
export function isRoundableMethod(method: PaymentMethod): boolean {
  return method === 'cash';
}

// ─────────────────────────────────────────────────────────────────────────────
// The rounding primitive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Round `total` to the nearest multiple of `step`, half away from zero.
 *
 * EXACT INTEGER ARITHMETICS, NO FLOAT. This is the whole point of the module:
 *
 *     rounded = ((total * 2 + step) / (step * 2)) * step     // for total >= 0
 *
 * In `bigint` every division truncates, so the added `step` performs the
 * round-half-UP step without a float ever appearing. Writing this as
 * `Math.round(total / step) * step` would be a latent bug: `total / step` is a
 * float division, and at ฿9,000,000.00 (9e8 satang) the quotient exceeds
 * 2^53 and `Math.round` starts returning values that are not multiples of the
 * step at all.
 *
 * Half-away-from-zero matches `money.ts`'s `divideRoundHalfUp`, so the whole
 * codebase rounds the same way in the same direction. Consistency matters more
 * than the specific tie-break: a tie broken one way in the cart and the other
 * way at the till is a reconciliation bug.
 *
 * @throws {RoundingError} if `total` is negative or `step` is not a positive
 *         divisor of ฿1.
 */
export function roundToNearestCoin(total: Satang, step: Satang = DEFAULT_CASH_STEP): Satang {
  assertUsableStep(step);

  if (total < 0n) {
    throw new RoundingError(`cannot round a negative total, received ${total}`);
  }

  // Round half UP on the magnitude. `total` is non-negative here, so there is
  // no sign to restore and the arithmetic stays readable.
  const quotient = (total * 2n + step) / (step * 2n);
  return quotient * step;
}

/**
 * Reject a step the drawer could never actually pay out.
 *
 * A step is usable when it is either a whole number of baht (payable in notes —
 * 100n, 500n, 1000n) or an exact fraction of one baht (payable in coin —
 * 25n, 50n). Anything else, such as 30n, would leave the customer holding a
 * total that no combination of Thai notes and coins can produce: ฿45.63 has no
 * exact ฿45.60 in circulation. Refused at the door rather than producing a
 * figure that looks rounded but is not payable.
 *
 * NOTE ON THE WHOLE-BAHT CASE: an earlier version of this check demanded
 * `100 % step === 0`, which was right for coins but silently rejected every
 * whole-baht step — ฿1, ฿5 — because 500 does not divide 100. That would have
 * quietly ruled out rounding to the nearest ฿5, which is a normal thing for a
 * till to do.
 */
function assertUsableStep(step: Satang): void {
  if (step <= 0n) {
    throw new RoundingError(`cash step must be positive, received ${step}`);
  }

  const dividesOneBaht = 100n % step === 0n;
  const isWholeBaht = step % 100n === 0n;

  if (!dividesOneBaht && !isWholeBaht) {
    throw new RoundingError(
      `cash step ${step} is neither a whole number of baht nor an exact fraction of ฿1; ` +
        'the rounded total would not be payable in Thai notes or coins',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The adjustment
// ─────────────────────────────────────────────────────────────────────────────

/** The outcome of applying cash rounding to a total. */
export interface CashRounding {
  /** MONEY — Satang. What the total was before rounding. */
  readonly original: Satang;
  /** MONEY — Satang. What is actually charged. Always payable in coin. */
  readonly payable: Satang;
  /**
   * MONEY — Satang. `payable − original`. **Signed**: positive when the total
   * rounded up, negative when it rounded down, `0n` when nothing changed.
   *
   * This is the value stored in `rounding_adjustment_satang`.
   */
  readonly adjustment: Satang;
  /** The coin step that was applied, for display on the receipt. */
  readonly step: Satang;
}

/**
 * Round a total for payment and report the signed adjustment.
 *
 * DIGITAL METHODS PASS THROUGH UNTOUCHED. `method` of `qr` / `promptpay` /
 * `card` / `transfer` returns the original total with `adjustment: 0n`, because
 * those rails move an exact amount and there is no drawer to fill.
 *
 * @throws {RoundingError} on a negative total or an unusable step.
 */
export function applyCashRounding(
  total: Satang,
  method: PaymentMethod,
  step: Satang = DEFAULT_CASH_STEP,
): CashRounding {
  if (total < 0n) {
    throw new RoundingError(`cannot round a negative total, received ${total}`);
  }

  if (!isRoundableMethod(method)) {
    // Still validated, so a nonsense step is a loud error even on a path that
    // does not round. Silence here would let an invalid configuration reach the
    // next cash sale and surface then.
    assertUsableStep(step);
    return Object.freeze({ original: total, payable: total, adjustment: 0n, step });
  }

  const payable = roundToNearestCoin(total, step);
  const adjustment = payable - total;

  return Object.freeze({ original: total, payable, adjustment, step });
}

// ─────────────────────────────────────────────────────────────────────────────
// Satang-passthrough signature
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The adjustment alone, for the boundary where satang are plain `bigint`.
 *
 * The TS ↔ Rust bridge carries money as decimal strings for safety
 * (see `tauriOfflineOrders.ts`), so the value crossing `invoke` is computed
 * here and stringified by the adapter — never re-parsed into a `number`.
 *
 * @see applyCashRounding for the full result.
 */
export function roundingAdjustmentSatang(
  total: Satang,
  method: PaymentMethod,
  step: Satang = DEFAULT_CASH_STEP,
): Satang {
  return applyCashRounding(total, method, step).adjustment;
}

/**
 * The same rule expressed through `Money`, for callers that hold a value
 * object rather than a bare satang count.
 *
 * A thin delegation, not a second implementation: the arithmetic lives in
 * `roundToNearestCoin` alone, so the `Money` path and the `bigint` path cannot
 * drift into disagreeing about what ฿45.52 rounds to.
 */
export function applyCashRoundingToMoney(
  total: Money,
  method: PaymentMethod,
  step: Satang = DEFAULT_CASH_STEP,
): { readonly payable: Money; readonly adjustment: Money } {
  const result = applyCashRounding(total.satang, method, step);

  return Object.freeze({
    payable: Money.fromSatang(result.payable),
    adjustment: Money.fromSatang(result.adjustment),
  });
}
