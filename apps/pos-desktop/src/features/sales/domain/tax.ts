/**
 * VAT — inclusive pricing, back-calculated once per order.
 *
 * LAYER: domain. Pure TypeScript. No React, no Tauri, no SQL, no `Intl`, and
 * no float anywhere. Every amount is a `Money`, which is integer satang.
 *
 * ── WHY "INCLUSIVE" CHANGES THE DIRECTION OF THE MATHS ───────────────────────
 *
 * A Thai café or shop puts ฿45.50 on the menu board. That is the price the
 * customer pays. The VAT is **already inside it** — it is not added at the till.
 * So the tax is not computed forward (`net × 7%`), it is **extracted** from a
 * known gross:
 *
 *     net = gross × 10000 / (10000 + vat_rate_bp)
 *     tax = gross − net
 *
 * Getting the direction wrong is not a rounding detail — it is a different
 * amount of money, and it is wrong in the customer's favour or the shop's
 * every single sale. A ฿45.50 sale contains ฿2.98 of VAT, not ฿3.19.
 *
 * ── WHY THE ROUNDING HAPPENS EXACTLY ONCE ────────────────────────────────────
 *
 * The division that extracts the net is the only place a fraction appears, so
 * it is the only place a rounding decision is made, and it is made once on the
 * order total rather than once per line.
 *
 * Per-line rounding would round up to 7 times on a 7-line order, and the sum
 * of those rounded parts would not equal the VAT actually owed on the receipt.
 * The tax return (ภ.พ.30) is filed on the receipt total, so the figure the
 * shop reports has to be the figure the receipt shows — one rounding point.
 *
 * ── THE INVARIANT THAT MATTERS ───────────────────────────────────────────────
 *
 * `tax + net === gross`, always, exactly. The result is derived by subtraction,
 * so it cannot drift: whatever the rounding does, the two halves still add back
 * to the amount the customer paid. `tax.ts` is never allowed to produce a
 * breakdown that does not reconcile.
 *
 * @see ./cart.ts — `calculateTax`, which applies this to a cart
 * @see ../../payments/domain/money.ts — the satang value object used throughout
 */

import { Money } from '../../payments/domain/money';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** One whole, in basis points. 10000 bp = 100%. Matches `vat_rate_bp` in SQL. */
export const BASIS_POINTS_PER_WHOLE = 10_000n;

/** Thai standard VAT rate: 7% = 700 basis points. */
export const DEFAULT_VAT_RATE_BP = 700n;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class TaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a basis-point rate is a usable VAT rate.
 *
 * `0` is allowed and means zero-rated — a real state, not an error, and it must
 * produce `tax === 0` rather than a division by an empty denominator.
 *
 * `10000` (100%) is refused. It would mean the net is zero and the entire price
 * is tax, which is not a VAT rate any shop has; it is the value a field takes
 * when someone types `100` meaning 100%, and it should be rejected at the door
 * rather than produce a silent, absurd receipt.
 */
export function isValidVatRateBp(vatRateBp: bigint): boolean {
  return typeof vatRateBp === 'bigint' && vatRateBp >= 0n && vatRateBp < BASIS_POINTS_PER_WHOLE;
}

function assertValidRate(vatRateBp: bigint): void {
  if (typeof vatRateBp !== 'bigint') {
    throw new TaxError(`vat rate must be a bigint in basis points, received ${typeof vatRateBp}`);
  }
  if (!isValidVatRateBp(vatRateBp)) {
    throw new TaxError(
      `vat rate must be 0..9999 basis points, received ${vatRateBp} ` +
        '(700 bp = 7%; 10000 would mean the whole price is tax)',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **MONEY — Satang (int64).** The net (VAT-exclusive) value inside a
 * VAT-inclusive gross amount.
 *
 *     net = round_half_up(gross × 10000 / (10000 + vat_rate_bp))
 *
 * `Money.multiplyRatio` performs the division with round-half-away-from-zero,
 * which for the non-negative amounts on a receipt is round-half-UP. That is the
 * commercial convention: a half-satang resolves upward, so 4252.5 becomes 4253
 * rather than 4252.
 *
 * No float is involved at any point — the ratio is applied as
 * `satang * 10000 / (10000 + bp)` entirely in `bigint`.
 *
 * @throws TaxError if the rate is outside `0..9999` bp.
 */
export function netFromInclusive(gross: Money, vatRateBp: bigint): Money {
  assertValidRate(vatRateBp);

  if (gross.isNegative()) {
    throw new TaxError(`a VAT-inclusive amount must not be negative, received ${gross.satang}`);
  }

  // A zero rate means the gross IS the net. Handled explicitly rather than by
  // arithmetic so the intent is visible and the division is not relied upon.
  if (vatRateBp === 0n) {
    return gross;
  }

  return gross.multiplyRatio(BASIS_POINTS_PER_WHOLE, BASIS_POINTS_PER_WHOLE + vatRateBp);
}

/**
 * **MONEY — Satang (int64).** The VAT contained in a VAT-inclusive gross
 * amount, by subtraction.
 *
 *     tax = gross − net
 *
 * Subtraction, not a second independent division. Rounding the tax separately
 * would let `net + tax` miss the gross by a satang, and a receipt whose parts
 * do not sum to its total is worse than one with a differently-rounded satang.
 * This definition makes the identity hold by construction.
 *
 * Worked example — ฿45.50 at 7%:
 *   net = round_half_up(4550 × 10000 / 10700) = round_half_up(4252.336) = 4252
 *   tax = 4550 − 4252 = 298                       (฿2.98, not ฿3.19)
 *
 * @throws TaxError if the rate is outside `0..9999` bp, or the amount is negative.
 */
export function taxFromInclusive(gross: Money, vatRateBp: bigint): Money {
  return gross.subtract(netFromInclusive(gross, vatRateBp));
}

/**
 * Both halves of a VAT-inclusive amount, guaranteed to reconcile.
 *
 * Returns the two values together so a caller cannot take one and recompute the
 * other a second, inconsistent way — which is exactly how a receipt and a tax
 * report end up disagreeing.
 */
export interface InclusiveBreakdown {
  /** MONEY — Satang (int64). The amount paid, VAT included. */
  readonly gross: Money;
  /** MONEY — Satang (int64). The net value, VAT excluded. */
  readonly net: Money;
  /** MONEY — Satang (int64). The VAT contained in `gross`. */
  readonly tax: Money;
  /** The rate used, in basis points. */
  readonly vatRateBp: bigint;
}

/**
 * Split a VAT-inclusive gross amount into net and tax.
 *
 * `net.add(tax)` always equals `gross` and `gross` equals `net.add(tax)`, by
 * construction. A caller can rely on that without re-deriving anything.
 */
export function splitInclusive(gross: Money, vatRateBp: bigint): InclusiveBreakdown {
  const net = netFromInclusive(gross, vatRateBp);
  const tax = gross.subtract(net);

  // A guard, not a hope. If this ever fires, the extraction has been changed in
  // a way that breaks the only property the rest of the system depends on.
  if (net.add(tax).satang !== gross.satang) {
    throw new TaxError(
      `inclusive split does not reconcile: net ${net.satang} + tax ${tax.satang} != gross ${gross.satang}`,
    );
  }

  return Object.freeze({ gross, net, tax, vatRateBp });
}

/**
 * ── SATANG-PASSTHROUGH SIGNATURE ───────────────────────────────────────────────
 *
 * The declarations below expose the same VAT rule under the plain-`bigint` shape
 * the ESC/POS receipt blueprint asks for (`Satang = bigint`), WITHOUT
 * re-implementing the maths. They are a boundary adapter: `bigint` in, `bigint`
 * out, and the single source of truth stays `splitInclusive` above.
 *
 * WHY AN ADAPTER RATHER THAN A SECOND IMPLEMENTATION ────────────────────────────
 *
 * A copy of the extraction formula would be a second encoding of one accounting
 * rule, and the two would drift. The failure mode is late and expensive: the
 * domain suite stays green because it tests the first copy, the SQL `CHECK`
 * constraint is derived from the second, and checkout starts failing at COMMIT
 * by a satang with no unit test anywhere reporting a failure. Delegating makes
 * that impossible by construction — there is only one formula.
 *
 * This also preserves the guards a from-scratch version would drop:
 *   - `Money` rejects a negative gross and a non-bigint outright, so a refund
 *     typed as a negative ฿45.50 surfaces as a `TaxError` at the domain edge
 *     rather than as an unbalanced receipt. (Returning `{0n, 0n}` for any
 *     `gross <= 0n` would instead silently launder that into a zero-value sale.)
 *   - `assertValidRate` refuses a 10000 bp rate — the value a text field
 *     receives when someone types `100` meaning 100% — which would otherwise
 *     compute a net of roughly half the price instead of zero.
 *   - the reconciliation guard in `splitInclusive` still runs on every call.
 *
 * Callers that already hold a `Money` should use `splitInclusive` directly;
 * these exist for the boundary (the receipt layout builder, the Tauri invoke
 * payload) where satang are plain `bigint` on purpose, per §2.1.
 */

/** Satang — a whole number of satang. ฿1 = 100 satang. */
export type Satang = bigint;

/** A VAT rate in basis points. `700` = 7.00%. */
export type BasisPoints = bigint;

/**
 * The two halves of a VAT-inclusive amount, in plain satang.
 *
 * `taxable` is the NET value (VAT excluded) and `tax` is the VAT extracted from
 * `gross`. They always sum back to the gross that was passed in.
 */
export interface TaxSplit {
  /** MONEY — Satang. The net value, VAT excluded. */
  readonly taxable: Satang;
  /** MONEY — Satang. The VAT contained in the gross. */
  readonly tax: Satang;
}

/**
 * Extract VAT from a VAT-INCLUSIVE gross amount, once per order.
 *
 * VAT-INCLUSIVE, so the tax sits INSIDE the price: ฿45.50 contains ฿2.98 of VAT
 * at 7%, not ฿3.19. Getting the direction wrong is not a rounding detail — it is
 * a different amount of money on every single sale.
 *
 * Round-half-up, in `bigint`, with no float anywhere:
 *
 *     taxable = round_half_up(gross × 10000 / (10000 + vatRateBp))
 *     tax     = gross − taxable
 *
 * @throws {TaxError} if `gross` is negative or `vatRateBp` is not a valid rate.
 */
export function splitInclusiveTax(gross: Satang, vatRateBp: BasisPoints): TaxSplit {
  const { net, tax } = splitInclusive(Money.fromSatang(gross), vatRateBp);

  return Object.freeze({ taxable: net.satang, tax: tax.satang });
}
