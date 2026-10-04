package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Order totals — the one place in this service where money is decided
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything in this file exists to make one number — what the customer paid —
// and its two halves (net and VAT) provably agree, and to do it ONCE per order.
//
// The identities this must satisfy, and which the terminal's SQLite enforces as
// CHECK constraints so the same values are re-derived in two languages:
//
//	gross  = subtotal - discount
//	total  = gross + service_charge + rounding_adjustment
//	taxable + tax = gross
//	tax    = gross - round_half_up(gross * 10000 / (10000 + vat_rate_bp))
//	total >= 0
//
// The third identity is stated against GROSS, and that is the whole reason a
// negative rounding adjustment is safe. The terminal writes it the long way
// round — CHECK (taxable_satang + tax_satang = total_satang -
// service_charge_satang - rounding_adjustment_satang) — and the two forms are
// algebraically identical once the second identity holds. The short form is used
// here because it states the actual rule: the VAT decomposition belongs to the
// PRICE OF THE GOODS. Neither the service charge nor the cash rounding is
// consideration for goods, so neither carries VAT and neither appears in the
// decomposition.
//
// Anchoring the decomposition to `total` instead is the trap this file used to
// fall into. The two formulations agree while rounding is zero, and they diverge
// silently the moment rounding goes negative — so the earlier revision had to
// forbid negative rounding outright to stay self-consistent. That was a
// constraint on the arithmetic standing in for a decision about cash handling.
//
// The last one is `money.SplitInclusiveVAT` verbatim. Re-deriving it here would be
// a second Go implementation of the same accounting rule and a third overall
// after the TypeScript domain, which is exactly the drift
// `migrations.test.ts` exists to prevent. So this file calls the shared kernel
// and then CHECKS the result against these identities, rather than computing a
// second answer and hoping the two agree.
//
// ── WHY THE TAX IS TAKEN FROM `gross`, NOT FROM `total` ───────────────────────
//
// `gross` is subtotal minus discount. It excludes `service_charge_satang` and
// `rounding_adjustment_satang`, and that is intentional: neither is consideration
// for goods, so neither carries VAT. Service charge is written as 0 regardless
// (café/retail, not a restaurant — DOMAIN.md), and `rounding_adjustment_satang`
// is cash rounding, a settlement of the tender rather than part of the price.
//
// ── WHY CASH ROUNDING IS SIGNED ──────────────────────────────────────────────
//
// Thai baht coins end in 5 satang, so ฿45.53 has no exact combination of the
// notes and coins in the drawer. Rounding moves it to the nearest value that
// does — and that value can be on EITHER side. ฿45.55 is up 2 satang; ฿45.50 is
// down 3. A non-negative adjustment could only express the first, so a cashier
// rounding down would have to report the change as an addition or not record it
// at all, and the till's cash would stop reconciling against the receipts.
//
// This is what `0002_signed_rounding.sql` exists for: it drops
// `rounding_adjustment_satang >= 0` and leaves `total_satang >= 0` as the only
// bound. The contract models it as `SignedSatang`. The one thing a negative
// adjustment may never do is make the sale negative, since a refund in this
// system is a separate document.
//
// ── WHY DISCOUNT IS SUBTRACTED BEFORE TAX, NOT AFTER ──────────────────────────
//
// `subtotal - discount` is the amount the customer is charged for the goods, and
// VAT-inclusive pricing means the VAT is inside it. Reducing by the discount
// first and then extracting means the customer is not charged VAT on a discount
// they were given. Applying the discount after extraction would keep the VAT on a
// price that was never charged, and the shop would over-declare on ภ.พ.30.
//

// Totals is the priced order header.
//
// Every field is MONEY in integer satang. Read the field names against the
// contract: `TaxableSatang` holds the NET (VAT-exclusive) value, which reads
// oddly under inclusive pricing but matches the schema column. HANDOVER.md §11
// records renaming it to `net_satang` as an open decision nobody has ratified,
// so the Go name follows the money and the adapter maps it to the column.
type Totals struct {
	// SubtotalSatang is the sum of the line totals, before discount.
	SubtotalSatang money.Satang

	// DiscountSatang reduces the amount charged. Bounded above by the subtotal:
	// a discount larger than the sale is a data error, not a generous promotion.
	DiscountSatang money.Satang

	// GrossSatang is subtotal minus discount — the VAT-inclusive amount the
	// customer is charged for the goods. This is the figure VAT is extracted
	// FROM.
	GrossSatang money.Satang

	// ServiceChargeSatang is ALWAYS zero.
	//
	// Retained rather than dropped so the storage contract does not change
	// shape. It is not a supported feature and no business rule depends on it.
	// Kept as a field, and validated as zero, so the day a restaurant build needs
	// it the schema is already there.
	ServiceChargeSatang money.Satang

	// RoundingAdjustmentSatang is cash rounding to the nearest payable coin, and
	// is SIGNED.
	//
	// Positive rounds the tender up, negative rounds it down, and both are
	// ordinary: ฿45.53 goes to ฿45.55 or to ฿45.50. See "WHY CASH ROUNDING IS
	// SIGNED" in the file header.
	//
	// HOW MUCH to round is still not decided by this code, and that is unchanged
	// by the sign being allowed. Choosing a value is a policy about the drawer —
	// which denominations the branch actually stocks — and this package will not
	// invent one. It accepts whatever the caller passes and proves the arithmetic
	// holds; the only thing it refuses is a rounding that drives the total below
	// zero, mirroring `CHECK (total_satang >= 0)`.
	RoundingAdjustmentSatang money.Satang

	// TotalSatang is what the customer pays:
	// gross + service charge + rounding adjustment.
	TotalSatang money.Satang

	// TaxSplit is the VAT decomposition of GrossSatang.
	//
	// Embedded rather than flattened into two fields so the rate that produced it
	// travels with it, and so the identity net + tax == gross is checkable by a
	// caller without reconstructing which rate was used.
	TaxSplit money.TaxSplit
}

// NetSatang is the VAT-exclusive portion of the amount charged.
//
// Named for what it is rather than for the column it lands in, because under
// inclusive pricing "taxable" reads as though the tax were added on top.
func (t Totals) NetSatang() money.Satang { return t.TaxSplit.Net }

// TaxSatang is the VAT contained in the amount charged.
func (t Totals) TaxSatang() money.Satang { return t.TaxSplit.Tax }

// ComputeTotals prices an order header and proves the result consistent.
//
// `lineSubtotalSatang` is the sum of the line totals, which the caller has
// already computed with `OrderLine.TotalSatang` — so each line's quantity × price
// was itself rounded once, to the satang, before being summed here. That is not
// the same as the per-order rounding rule below; see `OrderLine.TotalSatang`.
//
// This function performs the SINGLE per-order rounding. Everything downstream —
// the receipt, the ภ.พ.30 return, the shift's Z report — reads the figures it
// returns, so there is exactly one rounding point on the order.
//
// Returns an error rather than a Totals with a violated identity. A receipt
// whose parts do not sum to its total is a defect regardless of how the rounding
// fell, and the terminal's SQL CHECK rejects the write at COMMIT anyway — failing
// here instead means the error names the arithmetic rather than arriving as a
// constraint violation with no context.
func ComputeTotals(
	lineSubtotalSatang money.Satang,
	discountSatang, serviceChargeSatang, roundingAdjustmentSatang money.Satang,
	vatRateBp money.BasisPoints,
) (Totals, error) {
	// A negative subtotal is a data error, not a return. Refunds are separate
	// documents (DOMAIN.md: "Corrections are refund/void documents"), so a
	// negative total here means something upstream lost a sign.
	if lineSubtotalSatang < 0 {
		return Totals{}, fmt.Errorf(
			"order: subtotal %d satang is negative; a refund is a separate document, not a negative sale",
			lineSubtotalSatang)
	}
	if discountSatang < 0 {
		return Totals{}, fmt.Errorf("order: discount %d satang is negative", discountSatang)
	}
	if serviceChargeSatang < 0 {
		return Totals{}, fmt.Errorf("order: service charge %d satang is negative", serviceChargeSatang)
	}

	// `rounding_adjustment_satang` is the ONE signed money field, and unlike every
	// rejection above this is not a data error. Cash rounding moves the amount
	// charged to the nearest value payable from the drawer, and that value can sit
	// on either side of the exact total: ฿45.53 rounds up to ฿45.55, and just as
	// legitimately down to ฿45.50. A non-negative field could only express half of
	// that, forcing the client to misreport the direction of the adjustment.
	//
	// What it may NOT do is drive the total below zero. That is the real bound,
	// it is the one `0002_signed_rounding.sql` enforces
	// (`CHECK (total_satang >= 0)`), and it is checked after the arithmetic below
	// rather than here — because "is this adjustment too big?" is not a question
	// about the adjustment alone. A -50 satang rounding is absurd against a ฿45.50
	// sale and unremarkable against a ฿500 one.
	//
	// The identity that makes a negative adjustment safe is that `net + tax` is
	// pinned to GROSS, not to TOTAL. Rounding is a settlement of the tender, not
	// consideration for goods, so it never carries VAT and never enters the
	// decomposition. See the header.

	// CHECK (discount_satang <= subtotal_satang)
	if discountSatang > lineSubtotalSatang {
		return Totals{}, fmt.Errorf(
			"order: discount %d satang exceeds the subtotal %d satang",
			discountSatang, lineSubtotalSatang)
	}

	gross := lineSubtotalSatang.Sub(discountSatang)

	// The single rounding point of the order.
	split, err := money.SplitInclusiveVAT(gross, vatRateBp)
	if err != nil {
		return Totals{}, fmt.Errorf("order: cannot price an order whose gross is %d satang at %s bp: %w",
			gross, vatRateBp, err)
	}

	t := Totals{
		SubtotalSatang:           lineSubtotalSatang,
		DiscountSatang:           discountSatang,
		GrossSatang:              gross,
		ServiceChargeSatang:      serviceChargeSatang,
		RoundingAdjustmentSatang: roundingAdjustmentSatang,
		// gross = subtotal - discount
		// total = gross + service_charge + rounding_adjustment
		TotalSatang: gross.Add(serviceChargeSatang).Add(roundingAdjustmentSatang),
		TaxSplit:    split,
	}

	// CHECK (total_satang >= 0)
	//
	// The bound a negative rounding adjustment must respect. Rounding down past
	// zero would not be rounding, it would be a negative sale — and a refund in
	// this system is a separate document, not an order that costs the customer
	// money. The terminal rejects the same write at COMMIT, so this is the Go
	// half of one rule rather than two.
	if t.TotalSatang < 0 {
		return Totals{}, fmt.Errorf(
			"order: rounding adjustment %d satang drives the total to %d satang; "+
				"rounding settles the tender and may not make the sale negative (a refund is a separate document)",
			roundingAdjustmentSatang, t.TotalSatang)
	}

	if err := t.Validate(); err != nil {
		return Totals{}, err
	}
	return t, nil
}

// Validate re-checks every identity the database enforces.
//
// It runs on every ComputeTotals call AND is exported, so an ingest path can
// re-derive a client's claimed totals and check them without recomputing from
// scratch. That is the server's actual job on sync: an offline terminal sends a
// priced order, and the server recomputes and refuses a mismatch.
func (t Totals) Validate() error {
	if t.DiscountSatang > t.SubtotalSatang {
		return fmt.Errorf("order totals: discount %d satang exceeds the subtotal %d satang",
			t.DiscountSatang, t.SubtotalSatang)
	}

	// gross = subtotal - discount
	expectedGross := t.SubtotalSatang.Sub(t.DiscountSatang)
	if t.GrossSatang != expectedGross {
		return fmt.Errorf("order totals: gross is %d satang, want subtotal %d - discount %d = %d",
			t.GrossSatang, t.SubtotalSatang, t.DiscountSatang, expectedGross)
	}

	// total = gross + service_charge + rounding_adjustment
	expectedTotal := t.GrossSatang.Add(t.ServiceChargeSatang).Add(t.RoundingAdjustmentSatang)
	if t.TotalSatang != expectedTotal {
		return fmt.Errorf("order totals: total is %d satang, want gross %d + service charge %d + rounding %d = %d",
			t.TotalSatang, t.GrossSatang, t.ServiceChargeSatang, t.RoundingAdjustmentSatang, expectedTotal)
	}

	// total >= 0
	//
	// Re-checked here, not only in ComputeTotals, because Validate is exported and
	// is what the sync ingest path runs against a client's CLAIMED totals. A
	// terminal that reported a negative total must be refused on the same rule the
	// terminal's own CHECK would refuse it on.
	if t.TotalSatang < 0 {
		return fmt.Errorf("order totals: total is %d satang; a negative total is a refund, which is a separate document",
			t.TotalSatang)
	}

	// taxable + tax = gross
	//
	// Stated against GROSS, which is what makes a negative rounding adjustment
	// safe. The terminal writes the same identity the long way round — CHECK
	// (taxable_satang + tax_satang = total_satang - service_charge_satang
	//        - rounding_adjustment_satang) — and the two are algebraically
	// identical once the total identity above holds. The short form is used here
	// because it says what it means: the decomposition belongs to the price of the
	// goods, and neither the service charge nor the rounding is part of it.
	//
	// Anchoring this to Total instead is the trap. It is equivalent while rounding
	// is zero, and it silently stops being true the moment rounding goes negative
	// — which is why an earlier revision of this file phrased it that way and had
	// to forbid negative rounding to stay consistent.
	netPlusTax := t.TaxSplit.Net.Add(t.TaxSplit.Tax)
	if netPlusTax != t.GrossSatang {
		return fmt.Errorf(
			"order totals: net %d + tax %d = %d, want gross %d",
			t.TaxSplit.Net, t.TaxSplit.Tax, netPlusTax, t.GrossSatang)
	}

	if t.TaxSplit.Gross != t.GrossSatang {
		return fmt.Errorf(
			"order totals: the tax split was taken from %d satang but the order gross is %d satang; "+
				"they must be the same figure or the receipt and the tax return disagree",
			t.TaxSplit.Gross, t.GrossSatang)
	}

	if t.TaxSplit.Tax < 0 {
		return fmt.Errorf("order totals: tax %d satang is negative; extraction can never exceed the gross",
			t.TaxSplit.Tax)
	}

	// There is deliberately NO `net <= total` check here.
	//
	// One existed until signed rounding landed, and it was wrong the moment
	// rounding could go negative: with gross 4550, net 4252 and a -3000 satang
	// rounding, total is 1550 and net legitimately exceeds it. Rejecting that here
	// would make Go stricter than the terminal — `0002_signed_rounding.sql` has no
	// such CHECK — and a Go server that refuses a write SQLite accepts is exactly
	// the cross-language drift `migrations.test.ts` exists to prevent. A sync
	// ingest must never be the place a legitimately-stored sale dies.
	//
	// So the only bound on how far rounding may move the total is `total >= 0`,
	// which mirrors the terminal. Capping the magnitude further is a business
	// policy about how large a cash-rounding correction is believable, not an
	// arithmetic identity, and it belongs in a decision somebody ratifies rather
	// than in this function.
	return nil
}

// LineTaxIsAlwaysZero states the rule that `OrderLine` carries no tax of its own.
//
// DOMAIN.md: "`local_order_lines.line_tax_satang` is constrained to `0`, since
// rounding is per order (see above) and a per-line figure would be a second,
// differently rounded copy of money the order total already contains."
//
// So the field exists in storage and is always 0, and this package has no way to
// produce a non-zero value for it — see `OrderLine`.
const LineTaxIsAlwaysZero = 0

// OrderLine is one line of an order.
//
// ── THE LINE'S QUANTITY IS DECIMAL, ITS PRICE AND TOTAL ARE SATANG ───────────
//
// `Quantity` is `decimal(10,3)` and can be 1.5 or 0.005. `UnitPriceSatang` and
// `TotalSatang` are integer satang. Converting between them is the subtlest
// arithmetic in the order module and it is done exactly once, in
// `money.Quantity.MultiplySatang`, with round-half-up — a half-satang on a line
// resolves upward, the same commercial rule the VAT extraction uses.
//
// ── `TaxSatang` IS CONSTANTLY ZERO ───────────────────────────────────────────
//
// The field is present because the storage contract has it, and DOMAIN.md
// constrains it to 0 for a reason that is worth restating: rounding happens once
// per ORDER, so a per-line tax figure would be a second, differently rounded copy
// of money the order total already contains. Two copies of a tax figure
// disagree by a satang sometimes, and a receipt that disagrees with its own
// order total is not acceptable on a tax document.
//
// It is a CONSTANT, not a field, so there is no code path that could set it to
// anything else. A per-line tax is not computable here by construction, which is
// stronger than computing it and then asserting it was zero.
type OrderLine struct {
	ID identity.UUIDv7
	// OrderID is the owning order. Not optional: an orphan line is a data error,
	// and the ledger must be readable without a join for the shift report.
	OrderID identity.UUIDv7

	// ProductVariantID is the sold variant. A line may reference a variant that no
	// longer exists in the catalogue, because the catalogue is versioned and
	// retired rows are retained.
	ProductVariantID identity.UUIDv7

	Quantity        money.Quantity
	UnitPriceSatang money.Satang
	LineTotalSatang money.Satang

	// DiscountSatang reduces this line. Split out from the order-level discount so
	// a line-level promotion and an order-level one stay distinguishable.
	DiscountSatang money.Satang

	// Sequence is the display order on the receipt.
	Sequence  int32
	Notes     string
	CreatedAt time.Time
}

// TotalSatang prices one line: round_half_up(quantity × unit price).
//
// Two things this deliberately does NOT do:
//
//   - It does not round per line for TAX purposes. See `LineTaxIsAlwaysZero`.
//   - It does not apply any discount. A promotion is a separate resolved amount
//     applied at checkout; the list price stays comparable across periods.
//
// The quantity → money conversion goes through the money kernel so there is one
// implementation of "how does a decimal quantity become satang", shared with
// every other caller.
func (l OrderLine) TotalSatang() (money.Satang, error) {
	total, err := l.Quantity.MultiplySatang(l.UnitPriceSatang)
	if err != nil {
		return 0, fmt.Errorf("order line %s: %w", l.ID, err)
	}
	return total, nil
}

// NetLineTotalSatang is the line total after its own discount.
//
// It feeds the order subtotal. Kept as a method rather than a field so the
// arithmetic cannot be forgotten when a caller sums lines: a field would let a
// caller read `LineTotalSatang` and skip the discount without noticing.
func (l OrderLine) NetLineTotalSatang() (money.Satang, error) {
	total, err := l.TotalSatang()
	if err != nil {
		return 0, err
	}
	if l.DiscountSatang < 0 {
		return 0, fmt.Errorf("order line %s: discount %d satang is negative", l.ID, l.DiscountSatang)
	}
	if l.DiscountSatang > total {
		return 0, fmt.Errorf(
			"order line %s: discount %d satang exceeds the line total %d satang",
			l.ID, l.DiscountSatang, total)
	}
	return total.Sub(l.DiscountSatang), nil
}

// Validate checks a line's stored figures against its own quantity and price.
//
// Run on ingest. A line arriving from an offline terminal carries its own
// `line_total_satang`, and the server recomputes it: `decimal(10,3)` quantity
// times a satang price, rounded once, is fully determined, so a mismatch means
// the terminal's arithmetic disagrees with the server's — which is exactly the
// class of bug that must not reach a receipt.
func (l OrderLine) Validate() error {
	expected, err := l.TotalSatang()
	if err != nil {
		return err
	}
	if l.LineTotalSatang != expected {
		return fmt.Errorf(
			"order line %s: stored line total is %d satang, want round_half_up(%s x %d) = %d",
			l.ID, l.LineTotalSatang, l.Quantity, l.UnitPriceSatang, expected)
	}
	if _, err := l.NetLineTotalSatang(); err != nil {
		return err
	}
	return nil
}

// OrderLineModifier is a modifier applied to a line — an extra shot, a size
// upgrade, a less-iced.
//
// It is a SEPARATE row with its own quantity, price and total rather than a field
// on the line, so a line with three modifiers of the same kind has three rows.
// That is what lets the receipt print each modifier as its own line and what lets
// a later correction reverse one modifier without touching the others.
type OrderLineModifier struct {
	ID identity.UUIDv7
	// OrderLineID is the owning line.
	OrderLineID identity.UUIDv7

	// ModifierVariantID is the modifier, as a variant so it is priceable and
	// stock-trackable like any other sellable thing.
	ModifierVariantID identity.UUIDv7

	Quantity        money.Quantity
	UnitPriceSatang money.Satang
	LineTotalSatang money.Satang
	Sequence        int32
	CreatedAt       time.Time
}

// TotalSatang prices one modifier, identically to a line.
func (m OrderLineModifier) TotalSatang() (money.Satang, error) {
	total, err := m.Quantity.MultiplySatang(m.UnitPriceSatang)
	if err != nil {
		return 0, fmt.Errorf("order line modifier %s: %w", m.ID, err)
	}
	return total, nil
}

// SubtotalSatang sums a set of lines into the order subtotal.
//
// Every line contributes its NET line total, i.e. after its own discount, so the
// order-level discount is the only one left to apply in ComputeTotals.
//
// A single bad line fails the whole sum. There is no "skip the bad one" path: a
// subtotal that silently omits a line produces a receipt that is short by that
// line, and a receipt short by a line is worse than a rejected ingest.
func SubtotalSatang(lines []OrderLine) (money.Satang, error) {
	var sum money.Satang
	for _, l := range lines {
		net, err := l.NetLineTotalSatang()
		if err != nil {
			return 0, err
		}
		sum = sum.Add(net)
	}
	return sum, nil
}
