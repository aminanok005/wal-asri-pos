package domain

import "fmt"

// ─────────────────────────────────────────────────────────────────────────────
// VAT — Thailand, INCLUSIVE pricing
// ─────────────────────────────────────────────────────────────────────────────
//
// This file is the Go copy of the accounting rule ratified in
// docs/02-design/DOMAIN.md §"Money and tax rules" (2026-10-04) and already
// implemented on the terminal in
// apps/pos-desktop/src/features/sales/domain/tax.ts.
//
// The server is AUTHORITATIVE. SKILL.md §2.3: "Server Domain
// (`internal/{feature}/domain/`): Authoritative Go domain logic. Re-validates
// all client data on ingest." An order is priced on the terminal in SATANG and
// arrives here already carrying a tax figure. The server does not trust it: it
// recomputes the split from the branch's own `vat_rate_bp` and refuses the
// order if the client's number disagrees. That is the whole reason this file
// exists as a separate, independently testable encoding rather than a
// re-import of the client's value.
//
// ── WHY "INCLUSIVE" REVERSES THE DIRECTION OF THE MATHS ───────────────────────
//
// A Thai café puts ฿45.50 on the menu board. That is what the customer pays,
// and ฿2.98 of it is VAT. The tax is therefore ALREADY INSIDE the amount — it
// is not added at the till. So it is not computed forward from a net
// (`net × 7%`); it is EXTRACTED from a known gross:
//
//	net = round_half_up( gross × 10000 / (10000 + vat_rate_bp) )
//	tax = gross − net
//
// The direction is not a style preference. Forward VAT on the same sale gives
// 4550 × 700 / 10000 = 318.5 → 319 — ฿3.19 instead of ฿2.98. A different amount
// of money, wrong on every single sale, and the ภ.พ.30 return is filed on it.
//
// And because the tax sits inside the price, 7% VAT is worth 7/107 = 6.542% of
// an inclusive price, not 7%. ฿10,000 contains ฿654.21 of VAT, not ฿700.
//
// ── WHY ROUNDING HAPPENS EXACTLY ONCE, ON THE ORDER ───────────────────────────
//
// The division above is the only place a fraction can appear, so it is the only
// place a rounding decision is made — and it is made on the order total.
//
// Rounding per line rounds once per line: up to seven times on a seven-line
// order, and the sum of those separately-rounded parts is NOT the VAT actually
// owed on the receipt. The daily sales-tax return is filed on receipt totals, so
// the figure the shop declares has to be the figure the receipt shows. One
// rounding point, one figure, one number to audit.
//
// This is why OrderLine carries no tax of its own — see internal/order/domain.
//

// BasisPointsPerWhole is 10000 bp = 100%. It is also the scale used by
// `vat_rate_bp` in the data model, so 700 means exactly 7.00%.
const BasisPointsPerWhole int64 = 10_000

// DefaultVATRateBp is the Thai standard rate, 7% = 700 bp.
const DefaultVATRateBp BasisPoints = 700

// BasisPoints is a VAT rate as integer basis points: 700 = 7.00%.
//
// An integer, never a float percentage, so 7 percent is exactly 700 and not
// 6.999999999. 0 is a legitimate zero-rated state and produces exactly zero tax.
type BasisPoints int64

// IsValid reports whether bp is a usable VAT rate.
//
// `0` is allowed: zero-rated is a real state, not an error.
//
// `10000` (100%) is REFUSED. It is the value a text field receives when someone
// types `100` meaning 100%, and it would make the net zero — the entire price
// declared as tax. Rejecting it at the door is the point; unvalidated it
// produces a silent, absurd receipt. `10000` is also an illegal basis-point
// value by definition, since a rate of 100% has no place in a VAT-exclusive
// decomposition.
func (bp BasisPoints) IsValid() bool {
	return bp >= 0 && bp < BasisPoints(BasisPointsPerWhole)
}

// String renders the rate for logs ("700" = 7.00%).
func (bp BasisPoints) String() string { return fmt.Sprintf("%d", int64(bp)) }

// VATError is returned for input the tax path refuses outright.
//
// These are not "bad request, try again" conditions in the ordinary sense. Each
// one is a value that would otherwise produce a plausible-looking but wrong
// receipt, so they are surfaced rather than coerced. A negative gross is a
// refund typed as a sale; a 10000 bp rate is someone typing `100`; both are
// caught at the domain edge instead of becoming an unbalanced document.
type VATError struct {
	Reason string
}

func (e *VATError) Error() string { return "money kernel: " + e.Reason }

func vatErrf(format string, args ...any) *VATError {
	return &VATError{Reason: fmt.Sprintf(format, args...)}
}

// TaxSplit is the result of decomposing one VAT-INCLUSIVE gross amount.
//
// The two halves are returned together, from one function, so a caller cannot
// take one and recompute the other a second and inconsistent way. That is
// exactly how a receipt and a tax report come to disagree.
type TaxSplit struct {
	// Gross is MONEY — the amount charged, VAT included. What the customer pays.
	Gross Satang
	// Net is MONEY — the VAT-exclusive portion contained in Gross.
	//
	// Named `net` here, `taxable_satang` in the database and `taxable` in the
	// TypeScript `TaxSplit`. HANDOVER.md §11 records that the column name now
	// holds the net value and reads oddly under inclusive pricing; the rename to
	// `net_satang` is an open decision nobody has ratified, so the schema name
	// is unchanged and this Go name follows the money, not the column.
	Net Satang
	// Tax is MONEY — the VAT contained in Gross. Derived by subtraction, never
	// by a second independent division.
	Tax Satang
	// RateBp is the basis-point rate actually used.
	RateBp BasisPoints
}

// Reconciles reports whether Net + Tax == Gross exactly.
//
// It is true by construction, and the method exists so a test can assert the
// property directly rather than trusting that the arithmetic underneath still
// does what it did when it was written.
func (s TaxSplit) Reconciles() bool { return s.Net.Add(s.Tax) == s.Gross }

// SplitInclusiveVAT decomposes a VAT-INCLUSIVE gross amount into net and tax,
// once, with round-half-up.
//
//	net = round_half_up( gross × 10000 / (10000 + rateBp) )
//	tax = gross − net
//
// Round-half-up is chosen deliberately: a half-satang resolves upward, the
// commercial convention. It is computed entirely in int64 — `DivRoundHalfUp`
// divides integers, and no float is constructed anywhere on this path.
//
// Worked example at 7% on ฿45.50:
//
//	gross = 4550                                  (฿45.50)
//	net   = round_half_up(4550 × 10000 / 10700)   = round_half_up(4252.336) = 4252
//	tax   = 4550 − 4252                            = 298   (฿2.98, not ฿3.19)
//
// Errors, all of them refused rather than silently repaired:
//   - gross < 0. A refund entered as −฿45.50 is bad input, not a ฿0.00 sale.
//     Returning {0, 0} would launder it into a zero-value order that only
//     surfaces much later as a rejected document.
//   - rateBp outside 0..9999. See BasisPoints.IsValid.
//
// A zero rate is handled explicitly rather than by arithmetic, so the intent is
// visible and the division is not relied upon: a zero-rated gross IS its own
// net, and its tax is exactly zero.
func SplitInclusiveVAT(gross Satang, rateBp BasisPoints) (TaxSplit, error) {
	if !rateBp.IsValid() {
		return TaxSplit{}, vatErrf(
			"VAT rate must be 0..%d basis points, received %d "+
				"(700 bp = 7%%; %d would mean the whole price is tax, and is the value "+
				"a text field receives when someone types 100 meaning 100%%)",
			BasisPointsPerWhole-1, rateBp, BasisPointsPerWhole)
	}
	if gross < 0 {
		return TaxSplit{}, vatErrf("a VAT-inclusive amount must not be negative, received %d satang", gross)
	}

	net := gross
	if rateBp != 0 {
		// gross × 10000, guarded. gross is capped at MaxSafeSatang (2^53-1), and
		// 2^53-1 × 10000 is about 9.0e19, which is past math.MaxInt64 (9.2e18).
		// So the multiply is checked rather than assumed. The bound below is
		// ฿9.2 trillion — no single transaction approaches it, and a value that
		// large is far more likely to be a unit bug than a real sale.
		scaled, err := MulNonNegativeChecked(int64(gross), BasisPointsPerWhole)
		if err != nil {
			return TaxSplit{}, vatErrf("cannot scale %d satang by %d for VAT extraction: %v",
				gross, BasisPointsPerWhole, err)
		}
		rounded, err := DivRoundHalfUp(scaled, BasisPointsPerWhole+int64(rateBp))
		if err != nil {
			return TaxSplit{}, vatErrf("cannot extract VAT from %d satang at %d bp: %v",
				gross, rateBp, err)
		}
		net = Satang(rounded)
	}

	// By subtraction, not by a second division. Rounding the tax independently
	// would let net + tax miss the gross by a satang, and a receipt whose parts
	// do not sum to its total is worse than one with a differently-rounded
	// satang. This makes the identity hold BY CONSTRUCTION.
	tax := gross.Sub(net)

	split := TaxSplit{Gross: gross, Net: net, Tax: tax, RateBp: rateBp}
	if !split.Reconciles() {
		// Unreachable with the arithmetic above. It is here because this is the
		// one property the entire tax report depends on, and the TypeScript
		// original carries the identical guard for the identical reason.
		return TaxSplit{}, vatErrf("inclusive split does not reconcile: net %d + tax %d != gross %d",
			net, tax, gross)
	}
	return split, nil
}
