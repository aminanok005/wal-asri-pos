import { describe, expect, it } from 'bun:test';
import { Money } from '../../payments/domain/money';
import {
  BASIS_POINTS_PER_WHOLE,
  DEFAULT_VAT_RATE_BP,
  TaxError,
  isValidVatRateBp,
  netFromInclusive,
  splitInclusive,
  splitInclusiveTax,
  taxFromInclusive,
} from './tax';

const VAT_7 = 700n;
const VAT_0 = 0n;

describe('rate validation', () => {
  it('accepts 0 (zero-rated) and rejects 10000 (whole price is tax)', () => {
    expect(isValidVatRateBp(VAT_0)).toBe(true);
    expect(isValidVatRateBp(700n)).toBe(true);
    expect(isValidVatRateBp(9999n)).toBe(true);
    expect(isValidVatRateBp(10_000n)).toBe(false);
    expect(isValidVatRateBp(-1n)).toBe(false);
  });

  it('uses 10000 basis points per whole', () => {
    expect(BASIS_POINTS_PER_WHOLE).toBe(10_000n);
    expect(DEFAULT_VAT_RATE_BP).toBe(700n);
  });

  it('throws on an out-of-range rate rather than returning nonsense', () => {
    expect(() => taxFromInclusive(Money.fromSatang(4550n), -1n)).toThrow(TaxError);
    expect(() => taxFromInclusive(Money.fromSatang(4550n), 10_000n)).toThrow(TaxError);
  });

  it('throws on a negative amount', () => {
    expect(() => taxFromInclusive(Money.fromSatang(-1n), VAT_7)).toThrow(TaxError);
  });
});

describe('VAT-INCLUSIVE extraction — the direction matters', () => {
  it('extracts ฿2.98 from a ฿45.50 sale, NOT the ฿3.19 that forward VAT would give', () => {
    // The whole point of inclusive pricing. Forward VAT would give
    // 4550 * 700 / 10000 = 318.5 → 319 (฿3.19), which is a DIFFERENT amount of
    // money. Inclusive extraction gives:
    //   net = round_half_up(4550 * 10000 / 10700) = round_half_up(4252.336) = 4252
    //   tax = 4550 - 4252 = 298  (฿2.98)
    const gross = Money.fromString('45.50');

    expect(netFromInclusive(gross, VAT_7).satang).toBe(4252n);
    expect(taxFromInclusive(gross, VAT_7).satang).toBe(298n);
    expect(taxFromInclusive(gross, VAT_7).toString()).toBe('2.98');
  });

  it('is zero-rated at 0 bp and does not divide by an empty denominator', () => {
    const gross = Money.fromString('45.50');
    expect(taxFromInclusive(gross, VAT_0).satang).toBe(0n);
    expect(netFromInclusive(gross, VAT_0).satang).toBe(4550n);
  });

  it('net + tax === gross for many amounts (the invariant everything relies on)', () => {
    for (const satang of [0n, 1n, 5n, 10n, 100n, 4550n, 10_000n, 999_999n]) {
      const gross = Money.fromSatang(satang);
      const { net, tax } = splitInclusive(gross, VAT_7);
      expect(net.add(tax).satang).toBe(gross.satang);
    }
  });

  it('rounds the net half-UP', () => {
    // A "tie" is a gross whose net lands EXACTLY on .5 satang, so the rounding
    // direction is the only thing that decides the answer:
    //
    //     net_exact = gross * 10000 / (10000 + vat_rate_bp)
    //
    // At the standard 700 bp this CANNOT happen. The condition is
    //     gross * 10000 ≡ (10000 + 700) / 2 = 5350  (mod 10700)
    // and a congruence g*x ≡ c (mod m) is solvable only when gcd(x, m) | c.
    // Here gcd(10000, 10700) = 100, and 100 does not divide 5350 — so at 7% the
    // fraction is never exactly a half, for ANY gross. An earlier version of
    // this test scanned 1..20000 for such a gross, found none, and then passed
    // silently on `if (tie !== null)`. It proved nothing.
    //
    // The tie is reachable at 2000 bp instead: gcd(10000, 12000) = 2000, and
    // 2000 | 6000, so the congruence has solutions — every gross ≡ 3 (mod 6).
    // These are therefore real, hand-checkable fixtures, not a search result.
    const TIE_BP = 2_000n;

    // gross 9 → 9 * 10000 / 12000 = 7.5 exactly.
    //   half-UP  → net 8, tax 1   (what the domain must do)
    //   half-DOWN→ net 7, tax 2
    // The two differ, so this assertion actually discriminates.
    const tie = netFromInclusive(Money.fromSatang(9n), TIE_BP);
    expect(tie.satang).toBe(8n);

    // Pin the arithmetic that makes it a tie, so a future edit to the fixture
    // cannot quietly turn this back into a non-tie that passes either way.
    const exactNumerator = 9n * 10_000n;
    const denominator = 10_000n + TIE_BP;
    expect(exactNumerator % denominator).toBe(denominator / 2n);

    // A second tie, far enough away to catch a formula that only works for
    // small values: gross 21 → 17.5 exactly → net 18.
    expect(netFromInclusive(Money.fromSatang(21n), TIE_BP).satang).toBe(18n);

    // Just below and above the tie, where rounding is unambiguous. This proves
    // the half-UP result above is genuinely caused by the tie and not by a
    // general upward bias.
    //   gross 8  → 6.666… → 7  (down, but exact value is above 6)
    //   gross 10 → 8.333… → 8  (down)
    expect(netFromInclusive(Money.fromSatang(8n), TIE_BP).satang).toBe(7n);
    expect(netFromInclusive(Money.fromSatang(10n), TIE_BP).satang).toBe(8n);
  });

  it('rounds to NEAREST, not always up, across many amounts and rates', () => {
    // The counterpart to the tie test. Round-to-nearest never goes BELOW the
    // floor (it rounds the fraction away), so the meaningful discrimination is
    // between two behaviours that both look plausible:
    //
    //   round-to-nearest → result is the floor for fraction < 0.5, ceiling above
    //   ceil (always up)   → result is the ceiling for EVERY fraction
    //
    // A `ceil` implementation would still satisfy the invariant net + tax ===
    // gross, and would still get every non-tie in the other tests right, because
    // for a small fraction ceil and nearest coincide. Only this test separates
    // them: it requires some amounts to stay at the floor.
    let stayedAtFloor = 0;
    let roundedUpToCeiling = 0;

    for (const bp of [100n, 700n, 1_000n, 2_000n]) {
      for (let gross = 1n; gross < 400n; gross += 1n) {
        const denominator = 10_000n + bp;
        const numerator = gross * 10_000n;
        const floor = numerator / denominator;
        const remainder = numerator % denominator;
        const expected = (numerator + denominator / 2n) / denominator;

        const net = netFromInclusive(Money.fromSatang(gross), bp);
        expect(net.satang).toBe(expected);

        // Classify by the exact fraction, never by the rounded result, so the
        // counts below are a property of the fixtures rather than a restatement
        // of the assertion above.
        if (remainder * 2n < denominator) {
          expect(net.satang).toBe(floor); // fraction < 0.5, must NOT round up
          stayedAtFloor += 1;
        } else {
          expect(net.satang).toBe(floor + 1n); // fraction >= 0.5, must round up
          roundedUpToCeiling += 1;
        }
      }
    }

    // Sanity on the fixture itself: both classes really occur, so the loop is
    // genuinely testing rounding rather than a monotonic formula.
    expect(stayedAtFloor).toBeGreaterThan(0);
    expect(roundedUpToCeiling).toBeGreaterThan(0);
  });

  it('never returns a negative tax', () => {
    for (const satang of [0n, 1n, 7n, 99n, 4550n]) {
      expect(taxFromInclusive(Money.fromSatang(satang), VAT_7).isNegative()).toBe(false);
    }
  });

  it('extracts the inclusive share, which is bp/(10000+bp) and NOT bp/10000', () => {
    // This is the subtlety that makes inclusive pricing harder than it looks.
    // On a VAT-INCLUSIVE gross, 7% VAT is worth 7/107 = 6.542% of the price,
    // not 7%. Getting this wrong over-states the tax on every sale.
    const { net, tax, gross } = splitInclusive(Money.fromSatang(1_000_000n), VAT_7);

    expect(net.add(tax).satang).toBe(gross.satang);
    expect(tax.satang).toBeLessThan(gross.satang);
    expect(net.satang).toBeGreaterThan(0n);

    // ฿10,000 gross contains ฿654.21 of VAT (934,579 net satang).
    expect(tax.satang).toBe(65_421n);
    expect(net.satang).toBe(934_579n);

    // Forward VAT on the same gross would wrongly give ~฿700.
    expect(tax.satang).toBeLessThan(70_000n);
  });
});

describe('splitInclusive', () => {
  it('returns both halves and the rate used', () => {
    const gross = Money.fromString('45.50');
    const split = splitInclusive(gross, VAT_7);

    expect(split.gross.equals(gross)).toBe(true);
    expect(split.net.satang).toBe(4252n);
    expect(split.tax.satang).toBe(298n);
    expect(split.vatRateBp).toBe(VAT_7);
  });

  it('is frozen so a caller cannot corrupt a breakdown in flight', () => {
    expect(Object.isFrozen(splitInclusive(Money.fromSatang(4550n), VAT_7))).toBe(true);
  });

  it('reconciles at a range of VAT rates', () => {
    for (const bp of [0n, 50n, 100n, 700n, 1_500n, 9_999n]) {
      const gross = Money.fromString('1,234.56'.replace(/,/g, ''));
      const { net, tax } = splitInclusive(gross, bp);
      expect(net.add(tax).satang).toBe(gross.satang);
    }
  });
});
/**
 * The plain-`bigint` boundary signature (`splitInclusiveTax`).
 *
 * The ESC/POS receipt blueprint consumes VAT as bare satang so the layout
 * builder can hand numbers straight to a Tauri invoke payload. That adapter has
 * to be genuinely equivalent to the `Money` path — same figures, same guards —
 * or the receipt and the database would disagree about the same sale.
 *
 * The equivalence assertions below are the point of this block. A second,
 * independently-written copy of the extraction formula would satisfy every
 * individual test here and still drift; only asserting "the wrapper agrees with
 * splitInclusive" makes the delegation a checked property rather than a comment.
 */
describe('splitInclusiveTax — the plain-satang boundary signature', () => {
  it('matches splitInclusive exactly across amounts and rates', () => {
    const amounts = [0n, 1n, 2n, 5n, 10n, 107n, 1000n, 4550n, 9999n, 100_000n, 1_234_567n];
    const rates = [0n, 100n, 700n, 1_000n, 2_000n, 9_999n];

    for (const gross of amounts) {
      for (const rate of rates) {
        const viaMoney = splitInclusive(Money.fromSatang(gross), rate);
        const viaSatang = splitInclusiveTax(gross, rate);

        expect(viaSatang.taxable).toBe(viaMoney.net.satang);
        expect(viaSatang.tax).toBe(viaMoney.tax.satang);
      }
    }
  });

  it('still reconciles: taxable + tax === gross, always', () => {
    for (const gross of [0n, 1n, 7n, 99n, 4550n, 99_999n]) {
      for (const rate of [0n, 100n, 700n, 1_000n]) {
        const { taxable, tax } = splitInclusiveTax(gross, rate);
        expect(taxable + tax).toBe(gross);
      }
    }
  });

  it('reproduces the headline ฿45.50 worked example', () => {
    // net ฿42.52 + tax ฿2.98 = ฿45.50 charged. The forward-VAT answer (tax ฿3.19)
    // is a different amount of money, so this asserts the direction too.
    expect(splitInclusiveTax(4550n, 700n)).toEqual({ taxable: 4252n, tax: 298n });
  });

  it('returns a FROZEN result, so a receipt builder cannot corrupt it in flight', () => {
    const split = splitInclusiveTax(4550n, 700n);
    expect(Object.isFrozen(split)).toBe(true);
  });

  it('refuses a negative gross instead of laundering it to a zero-value sale', () => {
    // A refund entered as negative is bad input, not a ฿0.00 sale. Returning
    // `{0n, 0n}` here would produce a receipt whose parts do not explain
    // themselves, and would only surface later as a COMMIT rejection.
    expect(() => splitInclusiveTax(-4550n, 700n)).toThrow(TaxError);
    expect(() => splitInclusiveTax(-1n, 700n)).toThrow(TaxError);

    // Zero itself is legitimate (a zero-value or fully-discounted order) and
    // must NOT throw — only negatives are refused.
    expect(splitInclusiveTax(0n, 700n)).toEqual({ taxable: 0n, tax: 0n });
  });

  it('refuses a 10000 bp rate, which would halve the price instead of zeroing it', () => {
    // The value a text field receives when someone types `100` meaning 100%.
    // Without validation this computes net ≈ half the price, which is worse than
    // an obvious refusal.
    expect(() => splitInclusiveTax(4550n, 10_000n)).toThrow(TaxError);
    expect(() => splitInclusiveTax(4550n, -1n)).toThrow(TaxError);
  });

  it('refuses a non-bigint, so satang never arrive as a JS number', () => {
    // 4550 (number) would otherwise be accepted by `bigint` coercion at the
    // boundary and silently enter the money path as a float-capable value.
    expect(() => splitInclusiveTax(4550 as unknown as bigint, 700n)).toThrow();
    expect(() => splitInclusiveTax(4550n, 700 as unknown as bigint)).toThrow();
  });

  it('treats a 0 bp rate as zero-rated rather than dividing by an empty denominator', () => {
    expect(splitInclusiveTax(4550n, 0n)).toEqual({ taxable: 4550n, tax: 0n });
  });
});
