package domain

import (
	"fmt"
	"testing"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

var base = time.Date(2026, 10, 2, 9, 15, 0, 0, time.UTC)

func idAt(n int) identity.UUIDv7 {
	u, err := identity.ParseUUIDv7(uuidFor(base.Add(time.Duration(n) * time.Millisecond)))
	if err != nil {
		panic("test fixture is not a valid UUIDv7: " + err.Error())
	}
	return u
}

func uuidFor(ts time.Time) string {
	ms := uint64(ts.UTC().UnixMilli())
	return fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff)
}

// orderFixture builds a priced order from the given lines.
func orderFixture(t *testing.T, n int, lines []OrderLine, discount money.Satang, rateBp money.BasisPoints) Order {
	t.Helper()
	o, err := NewOrder(idAt(n), idAt(n+1), idAt(n+2), OrderTypeTakeaway, OrderSourcePosDesktop,
		lines, discount, 0, 0, rateBp, base)
	if err != nil {
		t.Fatalf("NewOrder returned an unexpected error: %v", err)
	}
	return o
}

// ─────────────────────────────────────────────────────────────────────────────
// The single-rounding rule
// ─────────────────────────────────────────────────────────────────────────────

// TestComputeTotals_WorkedExampleFromDomainDoc is the ฿45.50 case, and the reason
// this module exists.
func TestComputeTotals_WorkedExampleFromDomainDoc(t *testing.T) {
	// One line, one unit at ฿45.50, no discount, 7% VAT.
	o := orderFixture(t, 200, []OrderLine{{
		ID:               idAt(210),
		OrderID:          idAt(200),
		ProductVariantID: idAt(211),
		Quantity:         money.MustParseQuantity("1"),
		UnitPriceSatang:  money.MustSatang(4550),
		LineTotalSatang:  money.MustSatang(4550),
		Sequence:         1,
	}}, 0, money.DefaultVATRateBp)

	// DOMAIN.md: gross ฿45.50 contains ฿2.98 of VAT, and the total the customer
	// pays is ฿45.50 — NOT ฿48.48.
	if o.Totals.TotalSatang != 4550 {
		t.Errorf("total = %d satang (฿%.2f), want 4550 (฿45.50). "+
			"A total above the gross means VAT was ADDED to an inclusive price and the "+
			"customer is being billed twice", o.Totals.TotalSatang, float64(o.Totals.TotalSatang)/100)
	}
	if o.Totals.TaxSatang() != 298 {
		t.Errorf("tax = %d satang, want 298 (฿2.98, extracted from the gross)", o.Totals.TaxSatang())
	}
	if o.Totals.NetSatang() != 4252 {
		t.Errorf("net = %d satang, want 4252 (฿42.52)", o.Totals.NetSatang())
	}

	// The identity that must always hold: net + tax == total, for an order with no
	// service charge and no cash rounding.
	if got := o.Totals.NetSatang().Add(o.Totals.TaxSatang()); got != o.Totals.TotalSatang {
		t.Errorf("net %d + tax %d = %d, want the total %d",
			o.Totals.NetSatang(), o.Totals.TaxSatang(), got, o.Totals.TotalSatang)
	}
}

// TestComputeTotals_VatIsExtractedOncePerOrderNotOncePerLine is the rule with a
// price attached to getting it wrong.
//
// Seven lines of ฿45.50 is ฿318.50 of goods. Rounding the VAT per line and
// summing gives 7 x 298 = 2086 satang. Extracting once on the order total gives
// round_half_up(31850 * 10000 / 10700) = 29766, so tax = 31850 - 29766 = 2084.
//
// The per-line figure is 2 satang HIGH. The ภ.พ.30 return is filed on receipt
// totals, so the shop would over-declare VAT on every seven-line order. One
// rounding point, one figure, one number to audit.
func TestComputeTotals_VatIsExtractedOncePerOrderNotOncePerLine(t *testing.T) {
	const lines, unitPrice = 7, 4550

	var orderLines []OrderLine
	orderID := idAt(300)
	for i := 0; i < lines; i++ {
		orderLines = append(orderLines, OrderLine{
			ID:               idAt(301 + i),
			OrderID:          orderID,
			ProductVariantID: idAt(320 + i),
			Quantity:         money.MustParseQuantity("1"),
			UnitPriceSatang:  money.MustSatang(unitPrice),
			LineTotalSatang:  money.MustSatang(unitPrice),
			Sequence:         int32(i + 1),
		})
	}

	o := orderFixture(t, 300, orderLines, 0, money.DefaultVATRateBp)

	// Order-level extraction: one division.
	wantTax := money.MustSatang(2084)
	if o.Totals.TaxSatang() != wantTax {
		t.Errorf("order tax = %d satang, want %d — extraction must happen once on the order total",
			o.Totals.TaxSatang(), wantTax)
	}

	// Per-line extraction summed: the wrong figure, asserted so the difference is
	// explicit rather than folklore.
	perLineTax := money.Satang(0)
	for i := 0; i < lines; i++ {
		s, err := money.SplitInclusiveVAT(money.Satang(unitPrice), money.DefaultVATRateBp)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		perLineTax = perLineTax.Add(s.Tax)
	}
	if perLineTax == o.Totals.TaxSatang() {
		t.Fatal("per-line and per-order taxes are equal; re-derive this test before trusting it")
	}
	t.Logf("per-order tax %d satang vs per-line sum %d satang — per-line overstates by %d satang",
		o.Totals.TaxSatang(), perLineTax, perLineTax-o.Totals.TaxSatang())

	if o.Totals.TotalSatang != 31850 {
		t.Errorf("total = %d, want 31850 (7 x ฿45.50, the amount charged)", o.Totals.TotalSatang)
	}
}

// TestOrderLine_CarriesNoTaxOfItsOwn states the rule structurally: the per-line
// tax field is a CONSTANT, so no code path in this package can produce a non-zero
// value for it.
func TestOrderLine_CarriesNoTaxOfItsOwn(t *testing.T) {
	if LineTaxIsAlwaysZero != 0 {
		t.Fatalf("LineTaxIsAlwaysZero = %d, want 0", LineTaxIsAlwaysZero)
	}

	// DOMAIN.md's own worked example is why the terminal's SQL constrains
	// `local_order_lines.line_tax_satang` to 0. Two copies of a tax figure disagree
	// by a satang sometimes, and a receipt that disagrees with its own order total
	// is not acceptable on a tax document.
	o := orderFixture(t, 400, []OrderLine{{
		ID:               idAt(401),
		OrderID:          idAt(400),
		ProductVariantID: idAt(402),
		Quantity:         money.MustParseQuantity("1"),
		UnitPriceSatang:  money.MustSatang(4550),
		LineTotalSatang:  money.MustSatang(4550),
	}}, 0, money.DefaultVATRateBp)

	if got := o.Totals.TaxSatang(); got != 298 {
		t.Errorf("order tax = %d, want 298", got)
	}
	if LineTaxIsAlwaysZero != o.Totals.TaxSatang() {
		t.Logf("line tax stays %d while the order tax is %d — that asymmetry is the point: "+
			"one rounding point, one figure", LineTaxIsAlwaysZero, o.Totals.TaxSatang())
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Line arithmetic — decimal quantity x integer satang
// ─────────────────────────────────────────────────────────────────────────────

func TestOrderLine_TotalSatangRoundsHalfUpOnce(t *testing.T) {
	tests := []struct {
		name     string
		quantity string
		price    int64
		want     int64
		why      string
	}{
		{"one unit, whole price", "1", 4550, 4550, "no fraction arises"},
		{"one and a half units", "1.5", 4550, 6825, "1.5 x 4550 is exact in satang"},
		{"three decimal places, exact", "2.500", 4550, 11375, "the contract's Quantity example"},
		{"a fraction that must round up", "0.005", 4550, 23, "22.75 satang rounds half-up to 23"},
		{"a fraction that must round down", "0.005", 4549, 23, "22.745 satang rounds to 23"},
		{"thousandths that do not reach a satang", "0.001", 100, 0, "0.1 satang rounds to 0"},
		{"thousandths that reach one satang", "0.010", 100, 1, "exactly 1 satang"},
		{"a negative quantity is a reversed line", "-1", 4550, -4550, "a correction, not a refund document"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			l := OrderLine{
				ID:               idAt(500),
				OrderID:          idAt(501),
				ProductVariantID: idAt(502),
				Quantity:         money.MustParseQuantity(tc.quantity),
				UnitPriceSatang:  money.MustSatang(tc.price),
			}
			got, err := l.TotalSatang()
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if int64(got) != tc.want {
				t.Errorf("TotalSatang() for %s x %d = %d, want %d. %s",
					tc.quantity, tc.price, got, tc.want, tc.why)
			}
		})
	}
}

func TestOrderLine_RefusesANegativeUnitPrice(t *testing.T) {
	// A negative price is a different kind of error from a negative quantity and
	// must not be reinterpreted as one.
	l := OrderLine{
		ID: idAt(510), OrderID: idAt(511), ProductVariantID: idAt(512),
		Quantity: money.MustParseQuantity("1"), UnitPriceSatang: money.MustSatang(-4550),
	}
	if _, err := l.TotalSatang(); err == nil {
		t.Error("a negative unit price must be refused; it is not a reversed line")
	}
}

// TestOrderLine_ValidateCatchesATamperedTotal is the ingest-time guard.
//
// The line arrives from an offline terminal carrying its own `line_total_satang`.
// The server recomputes it: `decimal(10,3)` quantity times a satang price, rounded
// once, is fully determined. A mismatch means the terminal's arithmetic disagrees
// with the server's, and must not reach a receipt.
func TestOrderLine_ValidateCatchesATamperedTotal(t *testing.T) {
	line := OrderLine{
		ID: idAt(520), OrderID: idAt(521), ProductVariantID: idAt(522),
		Quantity: money.MustParseQuantity("1.5"), UnitPriceSatang: money.MustSatang(4550),
		LineTotalSatang: money.MustSatang(6826), // one satang too many
	}
	if err := line.Validate(); err == nil {
		t.Error("a stored line total that disagrees with quantity x price must be refused")
	}

	line.LineTotalSatang = money.MustSatang(6825)
	if err := line.Validate(); err != nil {
		t.Errorf("the correct line total was refused: %v", err)
	}
}

func TestSubtotalSatang_FailsWholeOnOneBadLine(t *testing.T) {
	// There is no "skip the bad line" path: a subtotal that silently omits a line
	// produces a receipt short by that line.
	_, err := SubtotalSatang([]OrderLine{
		{ID: idAt(530), OrderID: idAt(531), ProductVariantID: idAt(532),
			Quantity: money.MustParseQuantity("1"), UnitPriceSatang: money.MustSatang(4550)},
		{ID: idAt(533), OrderID: idAt(534), ProductVariantID: idAt(535),
			Quantity: money.MustParseQuantity("1"), UnitPriceSatang: money.MustSatang(4550),
			DiscountSatang: money.MustSatang(9999)},
	})
	if err == nil {
		t.Fatal("a line whose discount exceeds its total must fail the whole sum")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The SQL CHECK constraints, re-derived in Go
// ─────────────────────────────────────────────────────────────────────────────

// TestTotals_ValidateMirrorsEverySqlCheckConstraint is the Go half of the
// cross-language guard.
//
// `migrations.test.ts` exists so the terminal's TypeScript and the terminal's SQL
// cannot drift. This is the same guard for the server: it feeds perturbed totals
// through every identity the SQL CHECKs enforce and requires each to be refused.
//
// The four CHECKs, from DOMAIN.md:
//
//	discount_satang <= subtotal_satang
//	total_satang    = subtotal_satang - discount_satang + service_charge_satang + rounding_adjustment_satang
//	taxable_satang + tax_satang = total_satang - service_charge_satang - rounding_adjustment_satang
//	tax_satang      = gross - round_half_up(gross * 10000 / (10000 + vat_rate_bp))
func TestTotals_ValidateMirrorsEverySqlCheckConstraint(t *testing.T) {
	valid := func(t *testing.T) Totals {
		t.Helper()
		totals, err := ComputeTotals(mustSatang(4550), mustSatang(0), 0, 0, money.DefaultVATRateBp)
		if err != nil {
			t.Fatalf("the baseline total should be valid, got: %v", err)
		}
		return totals
	}

	if err := valid(t).Validate(); err != nil {
		t.Fatalf("a freshly computed total must satisfy every CHECK: %v", err)
	}

	tests := []struct {
		name    string
		perturb func(Totals) Totals
		want    string
	}{
		{
			name: "discount above subtotal",
			perturb: func(t Totals) Totals {
				t.DiscountSatang = t.SubtotalSatang + 1
				return t
			},
			want: "discount",
		},
		{
			name: "gross that is not subtotal minus discount",
			perturb: func(t Totals) Totals {
				t.GrossSatang = t.GrossSatang + 1
				return t
			},
			want: "gross",
		},
		{
			name: "total that is not gross plus the extras",
			perturb: func(t Totals) Totals {
				t.TotalSatang = t.TotalSatang + 1
				return t
			},
			want: "total",
		},
		{
			name: "tax taken from a different gross than the order's",
			perturb: func(t Totals) Totals {
				t.TaxSplit.Gross = t.TaxSplit.Gross + 100
				return t
			},
			want: "gross",
		},
		{
			name: "net and tax that do not sum to the chargeable amount",
			perturb: func(t Totals) Totals {
				t.TaxSplit.Tax = t.TaxSplit.Tax + 1
				return t
			},
			want: "net",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			perturbed := tc.perturb(valid(t))
			err := perturbed.Validate()
			if err == nil {
				t.Fatalf("a totals struct that violates a CHECK was accepted: %+v", perturbed)
			}
			if !contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q, so it would not help anyone diagnose the "+
					"same failure at COMMIT", err, tc.want)
			}
		})
	}
}

// TestComputeTotals_RefusesInputTheDatabaseWouldReject keeps the failure at the
// domain edge with a useful message, instead of at COMMIT with a constraint name.
func TestComputeTotals_RefusesInputTheDatabaseWouldReject(t *testing.T) {
	tests := []struct {
		name        string
		subtotal    int64
		discount    int64
		serviceChg  int64
		rounding    int64
		wantErrPart string
	}{
		{"discount larger than the subtotal", 1000, 1001, 0, 0, "exceeds the subtotal"},
		{"a negative subtotal is a lost sign, not a return", -1000, 0, 0, 0, "negative"},
		{"a negative discount", 1000, -1, 0, 0, "negative"},
		{"a negative service charge", 1000, 0, -1, 0, "negative"},
		// Rounding down is NOT an error. ฿10.00 rounds to ฿9.98 because the drawer
		// has no ฿0.01, and refusing that would force the cashier to misreport the
		// direction. What is refused is a rounding that makes the SALE negative:
		// total = 1000 + 0 + (-1001) = -1, against CHECK (total_satang >= 0).
		{"a rounding adjustment that drives the total below zero", 1000, 0, 0, -1001, "negative"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ComputeTotals(mustSatang(tc.subtotal), mustSatang(tc.discount),
				mustSatang(tc.serviceChg), mustSatang(tc.rounding), money.DefaultVATRateBp)
			if err == nil {
				t.Fatalf("input was accepted; the SQL CHECK for it would have rejected the row at COMMIT")
			}
			if !contains(err.Error(), tc.wantErrPart) {
				t.Errorf("error %q does not mention %q", err, tc.wantErrPart)
			}
		})
	}
}

// TestComputeTotals_RefusesAnUnusableVatRate refuses a 100% rate at the door,
// with the same reasoning as the money kernel: it is the value a text field
// receives when someone types `100` meaning 100%, and it would declare the entire
// price to be tax.
func TestComputeTotals_RefusesAnUnusableVatRate(t *testing.T) {
	for _, rate := range []money.BasisPoints{10000, 10001, -700} {
		if _, err := ComputeTotals(mustSatang(4550), 0, 0, 0, rate); err == nil {
			t.Errorf("VAT rate %s bp was accepted; the resulting receipt would be absurd", rate)
		}
	}
	// Zero-rated is a real state and must be accepted.
	totals, err := ComputeTotals(mustSatang(4550), 0, 0, 0, 0)
	if err != nil {
		t.Fatalf("a zero VAT rate must be accepted, got: %v", err)
	}
	if totals.TaxSatang() != 0 {
		t.Errorf("tax at 0 bp = %d, want 0", totals.TaxSatang())
	}
}

// TestComputeTotals_AppliesDiscountBeforeTax confirms the direction: a customer
// given a discount is not charged VAT on it.
func TestComputeTotals_AppliesDiscountBeforeTax(t *testing.T) {
	// ฿100.00 of goods, ฿20.00 off => ฿80.00 charged, VAT extracted from ฿80.00.
	discounted, err := ComputeTotals(mustSatang(10000), mustSatang(2000), 0, 0, money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if discounted.TotalSatang != 8000 {
		t.Errorf("total = %d, want 8000 (฿80.00)", discounted.TotalSatang)
	}
	wantTax, err := money.SplitInclusiveVAT(money.MustSatang(8000), money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if discounted.TaxSatang() != wantTax.Tax {
		t.Errorf("tax = %d, want %d — VAT must be extracted from the DISCOUNTED amount",
			discounted.TaxSatang(), wantTax.Tax)
	}

	// The wrong alternative, asserted for contrast: extracting from the full
	// ฿100.00 keeps the VAT on a price that was never charged.
	undiscountedTax, err := money.SplitInclusiveVAT(money.MustSatang(10000), money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if discounted.TaxSatang() == undiscountedTax.Tax {
		t.Fatal("discounted and undiscounted taxes are equal; re-derive this test")
	}
	if discounted.TaxSatang() > undiscountedTax.Tax {
		t.Error("a discount increased the VAT, which cannot be right")
	}
}

// TestComputeTotals_ServiceChargeAndRoundingAreOutsideTheVatBase covers the two
// fields that are added to the total but not taxed.
func TestComputeTotals_ServiceChargeAndRoundingAreOutsideTheVatBase(t *testing.T) {
	base_, err := ComputeTotals(mustSatang(10000), 0, 0, 0, money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	withExtras, err := ComputeTotals(mustSatang(10000), 0, mustSatang(500), mustSatang(1), money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Neither is consideration for goods, so neither carries VAT.
	if withExtras.TaxSatang() != base_.TaxSatang() {
		t.Errorf("tax changed from %d to %d when a service charge and cash rounding were added; "+
			"neither is consideration for goods", base_.TaxSatang(), withExtras.TaxSatang())
	}
	if withExtras.TotalSatang != base_.TotalSatang+501 {
		t.Errorf("total = %d, want %d (gross + 500 service charge + 1 rounding)",
			withExtras.TotalSatang, base_.TotalSatang+501)
	}
	// net + tax == gross
	netPlusTax := withExtras.NetSatang().Add(withExtras.TaxSatang())
	if netPlusTax != withExtras.GrossSatang {
		t.Errorf("net %d + tax %d = %d, want gross %d",
			withExtras.NetSatang(), withExtras.TaxSatang(), netPlusTax, withExtras.GrossSatang)
	}
}

// TestComputeTotals_RoundingDownIsAcceptedAndLeavesTheVatBaseAlone is the test
// for the signed-rounding change, and it exists because "the sign is now allowed"
// is not the claim worth making. The claim is that rounding DOWN is accepted AND
// leaves the money arithmetic intact — which is only true because the VAT
// decomposition is pinned to gross rather than to the total.
//
// ฿45.53 is the motivating case: baht coins end in 5 satang, so the drawer
// cannot make it exactly and the total rounds down to ฿45.50.
func TestComputeTotals_RoundingDownIsAcceptedAndLeavesTheVatBaseAlone(t *testing.T) {
	const subtotal = 4553 // ฿45.53, not payable from a drawer of coins ending in 5

	exact, err := ComputeTotals(mustSatang(subtotal), 0, 0, 0, money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// ฿45.53 -> ฿45.50 is 3 satang DOWN. This must be accepted.
	roundedDown, err := ComputeTotals(mustSatang(subtotal), 0, 0, mustSatang(-3), money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("rounding down was refused: %v", err)
	}

	// total = gross + service_charge + rounding_adjustment
	if want := mustSatang(subtotal - 3); roundedDown.TotalSatang != want {
		t.Errorf("total = %d, want %d (gross %d + rounding -3)", roundedDown.TotalSatang, want, subtotal)
	}

	// The decomposition is untouched: rounding is a settlement of the tender, not
	// consideration for goods, so it does not change what is declared to Revenue.
	if roundedDown.NetSatang() != exact.NetSatang() || roundedDown.TaxSatang() != exact.TaxSatang() {
		t.Errorf("VAT base moved when the total was rounded down: net %d->%d, tax %d->%d",
			exact.NetSatang(), roundedDown.NetSatang(), exact.TaxSatang(), roundedDown.TaxSatang())
	}

	// taxable + tax == gross, and gross is the SAME on both. This is the identity
	// that used to be written as `net + tax == total - service - rounding`, which
	// silently stops holding the moment rounding is negative.
	if got := roundedDown.NetSatang().Add(roundedDown.TaxSatang()); got != roundedDown.GrossSatang {
		t.Errorf("net %d + tax %d = %d, want gross %d",
			roundedDown.NetSatang(), roundedDown.TaxSatang(), got, roundedDown.GrossSatang)
	}
}

// TestComputeTotals_RoundingUpAndDownBothHold covers both directions of the
// signed field against the same gross, so the symmetry is asserted rather than
// assumed. Cash rounding is the one place where the adjustment's SIGN is chosen
// by the denominations in the drawer, and both outcomes are ordinary.
func TestComputeTotals_RoundingUpAndDownBothHold(t *testing.T) {
	for _, rounding := range []int64{-5, -3, -1, 0, 1, 2, 5} {
		totals, err := ComputeTotals(mustSatang(4553), 0, 0, mustSatang(rounding), money.DefaultVATRateBp)
		if err != nil {
			t.Errorf("rounding %+d was refused: %v", rounding, err)
			continue
		}
		if want := mustSatang(4553 + rounding); totals.TotalSatang != want {
			t.Errorf("rounding %+d: total = %d, want %d", rounding, totals.TotalSatang, want)
		}
		if got := totals.NetSatang().Add(totals.TaxSatang()); got != totals.GrossSatang {
			t.Errorf("rounding %+d: net %d + tax %d = %d, want gross %d",
				rounding, totals.NetSatang(), totals.TaxSatang(), got, totals.GrossSatang)
		}
		if err := totals.Validate(); err != nil {
			t.Errorf("rounding %+d produced totals that fail their own Validate: %v", rounding, err)
		}
	}
}

// TestComputeTotals_ValidateRejectsANegativeTotal pins the one bound signed
// rounding does have, on the EXPORTED Validate rather than only in ComputeTotals.
//
// Validate is what the sync ingest path runs against a terminal's claimed totals,
// so a bound enforced only inside ComputeTotals would not protect the server from
// a client that reports a negative sale.
func TestComputeTotals_ValidateRejectsANegativeTotal(t *testing.T) {
	totals := Totals{
		SubtotalSatang:           1000,
		DiscountSatang:           0,
		GrossSatang:              1000,
		ServiceChargeSatang:      0,
		RoundingAdjustmentSatang: -1001,
		TotalSatang:              -1,
	}
	err := totals.Validate()
	if err == nil {
		t.Fatal("a negative total was accepted by Validate; CHECK (total_satang >= 0) would reject it at COMMIT")
	}
	if !contains(err.Error(), "negative") {
		t.Errorf("error %q does not mention the negative total", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The status ladder
// ─────────────────────────────────────────────────────────────────────────────

func TestOrderStatus_VocabularyMatchesTheTerminalsSqlCheck(t *testing.T) {
	// If this server accepts a status the terminal's CHECK rejects, every order in
	// that state fails to sync. And vice versa.
	want := []OrderStatus{
		StatusDraft, StatusSubmitted, StatusInPreparation, StatusReady,
		StatusServed, StatusCompleted, StatusVoidRequested, StatusVoided,
	}
	if len(ladderRank) != len(want) {
		t.Errorf("the ladder has %d rungs, want %d — a new status needs to be added to the "+
			"terminal's SQL CHECK and its ORDER_STATUSES set in the same change",
			len(ladderRank), len(want))
	}
	for _, s := range want {
		if !s.IsValid() {
			t.Errorf("%q is in the expected vocabulary but IsValid() says no", s)
		}
	}
	for _, bogus := range []OrderStatus{"", "cancelled", "paid", "DRAFT", "in_prep"} {
		if bogus.IsValid() {
			t.Errorf("%q was accepted; it is not in the terminal's CHECK constraint", bogus)
		}
	}
}

func TestOrderStatus_LadderOnlyMovesForward(t *testing.T) {
	forward := []struct{ from, to OrderStatus }{
		{StatusDraft, StatusSubmitted},
		{StatusSubmitted, StatusInPreparation},
		{StatusInPreparation, StatusReady},
		{StatusReady, StatusServed},
		{StatusServed, StatusCompleted},
		{StatusCompleted, StatusVoidRequested},
		{StatusVoidRequested, StatusVoided},
		// A declined void request returns the order to completed — the ONLY rung a
		// void request may return to, because a void request is raised against a
		// completed sale.
		{StatusVoidRequested, StatusCompleted},
		// Abandoning a never-submitted draft needs no supervisor, so it voids
		// directly rather than via a request.
		{StatusDraft, StatusVoided},
	}
	for _, tc := range forward {
		if !tc.from.CanTransitionTo(tc.to) {
			t.Errorf("%q -> %q should be permitted", tc.from, tc.to)
		}
	}

	backward := []struct {
		from, to OrderStatus
		why      string
	}{
		{StatusCompleted, StatusReady, "an order is never rewound; a correction is a refund or void document"},
		{StatusServed, StatusInPreparation, "same"},
		{StatusDraft, StatusDraft, "not even a no-op self-transition is a transition"},
		{StatusVoided, StatusCompleted, "a voided order is terminal"},
		{StatusVoided, StatusDraft, "a voided order is terminal"},
		{StatusCompleted, StatusVoided, "a void must be REQUESTED and approved; skipping the request " +
			"means no supervisor ever saw it"},
		{StatusVoidRequested, StatusReady, "a void request resolves to approved (-> voided) or " +
			"rejected (-> completed), never to an arbitrary rung"},
		{StatusVoidRequested, StatusServed, "same: a void request has exactly two outcomes"},
		{StatusVoidRequested, StatusDraft, "same"},
	}
	for _, tc := range backward {
		if tc.from.CanTransitionTo(tc.to) {
			t.Errorf("%q -> %q must be refused. %s", tc.from, tc.to, tc.why)
		}
		if err := tc.from.ValidateTransition(tc.to); err == nil {
			t.Errorf("ValidateTransition(%q, %q) returned nil; it must explain the refusal", tc.from, tc.to)
		}
	}
}

func TestOrder_TransitionDoesNotMutateTheReceiver(t *testing.T) {
	// An append-only ladder whose transition function can leave the order
	// half-advanced is not append-only.
	o := orderFixture(t, 700, []OrderLine{{
		ID: idAt(701), OrderID: idAt(700), ProductVariantID: idAt(702),
		Quantity: money.MustParseQuantity("1"), UnitPriceSatang: money.MustSatang(4550),
		LineTotalSatang: money.MustSatang(4550),
	}}, 0, money.DefaultVATRateBp)

	moved, err := o.Transition(StatusSubmitted, base.Add(time.Minute))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if o.Status != StatusDraft {
		t.Errorf("the original order changed to %q; Transition must not mutate its receiver", o.Status)
	}
	if moved.Status != StatusSubmitted {
		t.Errorf("the new order is %q, want submitted", moved.Status)
	}
	if !moved.StatusAt.Equal(base.Add(time.Minute)) {
		t.Errorf("status_at = %s, want the supplied instant %s", moved.StatusAt, base.Add(time.Minute))
	}

	// A refused transition returns the zero Order and an error, never a partially
	// advanced one.
	refused, err := moved.Transition(StatusDraft, base.Add(2*time.Minute))
	if err == nil {
		t.Fatal("a backward transition was permitted")
	}
	if refused.ID.Compare(moved.ID) == 0 {
		t.Error("a refused transition returned the original order rather than the zero value")
	}
	if !refused.ID.IsZero() {
		t.Error("a refused transition must return the zero Order so a caller cannot mistake it for a result")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate validation — the server's ingest-time job
// ─────────────────────────────────────────────────────────────────────────────

func TestOrder_ValidateRejectsAnOrphanLine(t *testing.T) {
	o := orderFixture(t, 800, []OrderLine{{
		ID: idAt(801), OrderID: idAt(899), ProductVariantID: idAt(802), // wrong order
		Quantity: money.MustParseQuantity("1"), UnitPriceSatang: money.MustSatang(4550),
		LineTotalSatang: money.MustSatang(4550),
	}}, 0, money.DefaultVATRateBp)

	if err := o.Validate(); err == nil {
		t.Fatal("a line claiming a different order_id must be refused")
	}
}

func TestOrder_ValidateRefusesABranchlessOrder(t *testing.T) {
	o := orderFixture(t, 810, []OrderLine{{
		ID: idAt(811), OrderID: idAt(810), ProductVariantID: idAt(812),
		Quantity: money.MustParseQuantity("1"), UnitPriceSatang: money.MustSatang(4550),
		LineTotalSatang: money.MustSatang(4550),
	}}, 0, money.DefaultVATRateBp)

	o.BranchID = identity.Zero
	if err := o.Validate(); err == nil {
		t.Fatal("an order with no branch must be refused; the branch a sale happened in is recorded, not derived")
	}
}

func TestOrder_ValidateCatchesAStaleTotalFromAnOfflineTerminal(t *testing.T) {
	// The realistic ingest failure: a terminal that last synced before the branch
	// changed VAT rate prices at 7%, the server is at 10%, and the client's claimed
	// tax no longer matches. It must be caught here rather than filed.
	o := orderFixture(t, 820, []OrderLine{{
		ID: idAt(821), OrderID: idAt(820), ProductVariantID: idAt(822),
		Quantity: money.MustParseQuantity("1"), UnitPriceSatang: money.MustSatang(4550),
		LineTotalSatang: money.MustSatang(4550),
	}}, 0, money.DefaultVATRateBp)

	if err := o.Validate(); err != nil {
		t.Fatalf("the baseline order should validate: %v", err)
	}

	// Perturb the tax as a terminal running an older rate would have.
	o.Totals.TaxSplit.Tax = o.Totals.TaxSplit.Tax + 11
	if err := o.Validate(); err == nil {
		t.Fatal("an order whose tax does not reconcile with its gross must be refused on ingest")
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func mustSatang(v int64) money.Satang { return money.MustSatang(v) }

func contains(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

// TestOrderSource_VocabularyMatchesTheContractAndTheSchema guards a drift that
// actually happened.
//
// The Go domain said `terminal`, `mobile`, `back_office`. Both
// contracts/openapi.yaml (`OrderSource`) and the terminal's own `0001_init.sql`
// CHECK said `pos_desktop`, `pos_mobile`, `admin`. This service would have written
// values its own schema rejected on the very first insert.
//
// It survived because nothing compared them: the constants were referenced only from
// tests, and the Postgres driver was a skeleton, so no round trip could surface the
// disagreement. This test is here so a fourth vocabulary cannot appear quietly.
func TestOrderSource_VocabularyMatchesTheContractAndTheSchema(t *testing.T) {
	want := []OrderSource{
		OrderSourcePosDesktop,
		OrderSourcePosMobile,
		OrderSourceAdmin,
	}
	if len(want) != 3 {
		t.Fatalf("the expected source vocabulary has %d entries, want 3 — a new source needs the "+
			"contract's enum and the terminal's SQL CHECK updated in the same change", len(want))
	}
	for _, s := range want {
		if !s.IsValid() {
			t.Errorf("%q is in the expected vocabulary but IsValid() says no", s)
		}
	}
	// The values themselves, not just their count — a rename that keeps the count
	// would pass a count-only assertion.
	for _, tc := range []struct {
		got  OrderSource
		want string
	}{
		{OrderSourcePosDesktop, "pos_desktop"},
		{OrderSourcePosMobile, "pos_mobile"},
		{OrderSourceAdmin, "admin"},
	} {
		if string(tc.got) != tc.want {
			t.Errorf("source = %q, want %q; this string is a column value and must match "+
				"contracts/openapi.yaml and 0001_init.sql exactly", tc.got, tc.want)
		}
	}
	// The values that were wrong before, so a reintroduction is caught.
	for _, stale := range []OrderSource{"terminal", "mobile", "back_office", "", "POS_DESKTOP"} {
		if stale.IsValid() {
			t.Errorf("%q was accepted; it is not in the contract's enum", stale)
		}
	}
}
