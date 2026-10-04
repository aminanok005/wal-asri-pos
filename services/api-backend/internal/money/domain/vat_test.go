package domain

import (
	"encoding/json"
	"errors"
	"math"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────────────
// The figures below are the ones docs/02-design/DOMAIN.md ratified on
// 2026-10-04. If the Go split stops agreeing with them, the server and the
// terminal disagree about how much tax a customer owes, and neither test suite
// is looking for that — so it is asserted here by literal value, not by
// re-deriving it from the formula under test.
// ─────────────────────────────────────────────────────────────────────────────

func TestSplitInclusiveVAT_WorkedExampleFromDomainDoc(t *testing.T) {
	// DOMAIN.md: gross ฿45.50 = 4550 at 700 bp.
	//
	//   net = round_half_up(4550 x 10000 / 10700) = round_half_up(4252.336) = 4252
	//   tax = 4550 - 4252                          = 298   (฿2.98, not ฿3.19)
	split, err := SplitInclusiveVAT(MustSatang(4550), DefaultVATRateBp)
	if err != nil {
		t.Fatalf("SplitInclusiveVAT(4550, 700bp) returned an unexpected error: %v", err)
	}

	if split.Gross != 4550 {
		t.Errorf("gross = %d, want 4550 (the amount the customer pays, unchanged)", split.Gross)
	}
	if split.Net != 4252 {
		t.Errorf("net = %d, want 4252 (฿42.52)", split.Net)
	}
	if split.Tax != 298 {
		t.Errorf("tax = %d, want 298 (฿2.98)", split.Tax)
	}
	if split.RateBp != 700 {
		t.Errorf("rate = %d bp, want 700", split.RateBp)
	}
	if !split.Reconciles() {
		t.Errorf("net %d + tax %d != gross %d: the split must reconcile exactly", split.Net, split.Tax, split.Gross)
	}
}

// TestSplitInclusiveVAT_ForwardVatWouldGiveADifferentAmount pins the trap that
// makes this file exist.
//
// The direction is not a style preference. Forward VAT on ฿45.50 is
// 4550 x 700 / 10000 = 318.5 -> 319 — ฿3.19 instead of ฿2.98. That is a
// DIFFERENT AMOUNT OF MONEY, wrong on every sale, and the ภ.พ.30 return is filed
// on it. If someone ever "simplifies" this into net x rate, this test fails
// rather than the failure reaching a tax document.
func TestSplitInclusiveVAT_ForwardVatWouldGiveADifferentAmount(t *testing.T) {
	const gross, rateBp = 4550, 700

	inclusive, err := SplitInclusiveVAT(MustSatang(gross), rateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	forward, err := DivRoundHalfUp(gross*rateBp, BasisPointsPerWhole)
	if err != nil {
		t.Fatalf("unexpected error computing the forward figure: %v", err)
	}

	if int64(inclusive.Tax) == forward {
		t.Fatalf("the forward figure now equals the inclusive one (%d) — "+
			"this test's whole point is that they differ, so re-derive it before trusting it",
			forward)
	}
	if forward != 319 {
		t.Errorf("forward VAT = %d, want 319 (฿3.19) — the wrong figure, asserted for contrast", forward)
	}
	if int64(inclusive.Tax) == 319 {
		t.Errorf("inclusive tax = %d, which is the FORWARD figure — the direction has been reversed", inclusive.Tax)
	}
}

// TestSplitInclusiveVAT_VatIsSevenOfOneOhSeven asserts the second half of the
// same lesson: under inclusive pricing, 7% VAT is worth 7/107 = 6.542% of the
// price, not 7%.
//
// ฿10,000 contains ฿654.21 of VAT, not ฿700. A ฿700 figure means the extraction
// was replaced by a flat 7% of the gross, which overstates the liability.
func TestSplitInclusiveVAT_VatIsSevenOfOneOhSeven(t *testing.T) {
	split, err := SplitInclusiveVAT(MustSatang(1_000_000), DefaultVATRateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// 10000 baht gross -> 654.21 baht of VAT = 65421 satang.
	if split.Tax != 65421 {
		t.Errorf("tax on ฿10,000 = %d satang (฿%.2f), want 65421 (฿654.21) — "+
			"7%% VAT inside an inclusive price is worth 7/107, not 7%%", split.Tax, float64(split.Tax)/100)
	}
	if split.Net != 934579 {
		t.Errorf("net on ฿10,000 = %d, want 934579", split.Net)
	}
	if !split.Reconciles() {
		t.Errorf("net %d + tax %d != gross %d", split.Net, split.Tax, split.Gross)
	}
}

// TestSplitInclusiveVAT_AlwaysReconciles sweeps a range of gross amounts and
// rates, asserting the one property the daily sales-tax report depends on.
func TestSplitInclusiveVAT_AlwaysReconciles(t *testing.T) {
	grosses := []int64{0, 1, 2, 5, 9, 99, 100, 455, 4550, 4551, 999_999, 1_000_000, MaxSafeSatang / 100}
	rates := []BasisPoints{0, 100, 200, 700, 750, 1000, 2000, 5000, 9999}

	for _, g := range grosses {
		for _, r := range rates {
			split, err := SplitInclusiveVAT(Satang(g), r)
			if err != nil {
				t.Fatalf("SplitInclusiveVAT(%d, %dbp) unexpected error: %v", g, r, err)
			}
			if int64(split.Net)+int64(split.Tax) != g {
				t.Errorf("gross %d at %dbp: net %d + tax %d = %d, want %d",
					g, r, split.Net, split.Tax, int64(split.Net)+int64(split.Tax), g)
			}
			if split.Tax < 0 {
				t.Errorf("gross %d at %dbp: tax %d is negative; extraction can never take more than the gross",
					g, r, split.Tax)
			}
			if split.Net > split.Gross {
				t.Errorf("gross %d at %dbp: net %d exceeds gross %d", g, r, split.Net, split.Gross)
			}
		}
	}
}

// TestSplitInclusiveVAT_ZeroRateIsZeroRatedNotAnError covers the state the
// guard in BasisPoints.IsValid deliberately admits.
//
// Zero-rated is real — and it must produce EXACTLY zero tax, not a division by
// an empty denominator and not a panic.
func TestSplitInclusiveVAT_ZeroRateIsZeroRatedNotAnError(t *testing.T) {
	for _, gross := range []int64{0, 1, 4550, 1_000_000} {
		split, err := SplitInclusiveVAT(Satang(gross), 0)
		if err != nil {
			t.Fatalf("a zero VAT rate must be accepted, got an error for gross %d: %v", gross, err)
		}
		if split.Tax != 0 {
			t.Errorf("gross %d at 0 bp: tax = %d, want 0", gross, split.Tax)
		}
		if int64(split.Net) != gross {
			t.Errorf("gross %d at 0 bp: net = %d, want %d — a zero-rated gross IS its own net",
				gross, split.Net, gross)
		}
	}
}

// TestSplitInclusiveVAT_RefusesBadInput asserts each guard is a guard and not a
// suggestion.
//
// Every case here would otherwise produce a plausible-looking but wrong
// document. Returning a zero value instead of refusing launders the bad input
// into a zero-money order that only surfaces much later, as a rejected commit.
func TestSplitInclusiveVAT_RefusesBadInput(t *testing.T) {
	tests := []struct {
		name  string
		gross Satang
		rate  BasisPoints
		why   string
	}{
		{
			name:  "negative gross is a mistyped refund, not a zero-value sale",
			gross: MustSatang(-4550),
			rate:  DefaultVATRateBp,
			why:   "returning {0,0} would launder it into a ฿0.00 order that only fails later",
		},
		{
			name:  "10000 bp is someone typing 100 meaning 100%",
			gross: MustSatang(4550),
			rate:  10000,
			why:   "the net would be zero, declaring the entire price to be tax",
		},
		{
			name:  "a rate above 10000 bp is not a percentage at all",
			gross: MustSatang(4550),
			rate:  10001,
			why:   "the denominator goes negative and the net comes out larger than the gross",
		},
		{
			name:  "a negative rate is not zero-rated, it is a sign error",
			gross: MustSatang(4550),
			rate:  -700,
			why:   "it would inflate the net above the amount charged",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			split, err := SplitInclusiveVAT(tc.gross, tc.rate)
			if err == nil {
				t.Fatalf("SplitInclusiveVAT(%d, %dbp) was accepted, returning {%d, %d, %d}. %s",
					tc.gross, tc.rate, split.Gross, split.Net, split.Tax, tc.why)
			}
			var vatErr *VATError
			if !errors.As(err, &vatErr) {
				t.Errorf("error type is %T, want *VATError so callers can distinguish a refused rate from an internal fault", err)
			}
			if split != (TaxSplit{}) {
				t.Errorf("a refused call returned a non-zero split %+v; it must return the zero value so a caller cannot mistake it for a result", split)
			}
		})
	}
}

// TestSplitInclusiveVAT_RejectsRatesWhereTheMultiplyWouldOverflow.
//
// The extraction scales by 10000 and MaxSafeSatang is 2^53-1, so a ฿90 trillion
// gross genuinely overflows int64. The guard is what turns that into an error
// instead of a wrapped, nonsense tax figure.
func TestSplitInclusiveVAT_RejectsRatesWhereTheMultiplyWouldOverflow(t *testing.T) {
	if _, err := SplitInclusiveVAT(Satang(MaxSafeSatang), DefaultVATRateBp); err == nil {
		t.Errorf("a ฿90 trillion gross scaled by 10000 overflows int64 and must be refused, not wrapped")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Rounding
// ─────────────────────────────────────────────────────────────────────────────

// TestSplitInclusiveVAT_HalfUpResolvesUpward pins the rounding DIRECTION.
//
// A true tie is unreachable at 7%: a tie needs
// gross*10000 mod 10700 == 5350, and gcd(10000, 10700) = 100 does not divide
// 5350. HANDOVER.md §7 records that a rounding test once scanned for a tie at
// 7%, found none, and passed silently behind a conditional — so the fixture has
// to be built where a tie is actually reachable.
//
// At 20% (2000 bp) the denominator is 12000 and gcd(2000, 12000) = 2000 does
// divide 6000, so small gross amounts land exactly on .5.
func TestSplitInclusiveVAT_HalfUpResolvesUpward(t *testing.T) {
	const twentyPercent BasisPoints = 2000

	// gross 9 -> 9*10000/12000 = 7.5 exactly -> half-up -> 8.
	tie, err := SplitInclusiveVAT(MustSatang(9), twentyPercent)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tie.Net != 8 {
		t.Errorf("net = %d, want 8: 9 * 10000 / 12000 is exactly 7.5 and a half resolves UPWARD", tie.Net)
	}
	if tie.Tax != 1 {
		t.Errorf("tax = %d, want 1 (9 - 8)", tie.Tax)
	}

	// gross 3 -> exactly 2.5 -> half-up -> 3.
	//
	// This is the case that separates half-up from banker's rounding, which
	// would return 2 for an exact .5 that rounds to an even number. If someone
	// "improves" this to round-half-to-even, this assertion fails — which is the
	// intent. Half-up is the commercial convention and it is a decision.
	tie2, err := SplitInclusiveVAT(MustSatang(3), twentyPercent)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tie2.Net != 3 {
		t.Errorf("net = %d, want 3: 3 * 10000 / 12000 is exactly 2.5, half-up gives 3, "+
			"banker's rounding would give 2", tie2.Net)
	}
}

// TestSplitInclusiveVAT_TieIsUnreachableAtSevenPercent documents the trap above
// as an executable fact rather than a comment.
//
// If this test ever fails, a tie has become reachable at 7% and the 20%-based
// fixtures above are no longer the only way to exercise half-up — which is
// good news, but it must be a decision, not an accident.
func TestSplitInclusiveVAT_TieIsUnreachableAtSevenPercent(t *testing.T) {
	// A tie needs gross*10000 mod 10700 == 5350. gcd(10000, 10700) = 100, and
	// 100 does not divide 5350, so no solution exists.
	if gcd(10_000, 10_700) == 0 || 5350%gcd(10_000, 10_700) == 0 {
		t.Fatalf("gcd(10000, 10700) = %d; if it now divides 5350 a tie IS reachable at 7%% "+
			"and the 20%% fixtures above need revisiting", gcd(10_000, 10_700))
	}

	// Confirm empirically across a wide sweep as well.
	for gross := int64(1); gross <= 200_000; gross++ {
		if _, err := SplitInclusiveVAT(Satang(gross), DefaultVATRateBp); err != nil {
			t.Fatalf("unexpected error at gross %d: %v", gross, err)
		}
		scaled := gross * BasisPointsPerWhole
		den := BasisPointsPerWhole + int64(DefaultVATRateBp)
		if scaled%den*2 == den {
			t.Fatalf("found a rounding tie at 7%% with gross %d — see the note in the test name", gross)
		}
	}
}

func TestDivRoundHalfUp_RoundsTiesUpNotToEven(t *testing.T) {
	tests := []struct {
		a, b, want int64
	}{
		{7, 2, 4},   // 3.5 -> 4, not banker's 4 anyway
		{5, 2, 3},   // 2.5 -> 3, not banker's 2
		{1, 2, 1},   // 0.5 -> 1
		{3, 2, 2},   // 1.5 -> 2, not banker's 2
		{1, 3, 0},   // 0.333 -> 0
		{2, 3, 1},   // 0.667 -> 1
		{7, 3, 2},   // 2.333 -> 2
		{8, 3, 3},   // 2.667 -> 3
		{0, 7, 0},   // zero
		{10, 5, 2},  // exact
		{-5, 2, -3}, // half AWAY from zero, so the result is symmetric about it
		{5, -2, -3},
	}
	for _, tc := range tests {
		got, err := DivRoundHalfUp(tc.a, tc.b)
		if err != nil {
			t.Fatalf("DivRoundHalfUp(%d, %d) unexpected error: %v", tc.a, tc.b, err)
		}
		if got != tc.want {
			t.Errorf("DivRoundHalfUp(%d, %d) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

// TestDivRoundHalfUp_OddDenominatorDoesNotDoubleRound is the reason the helper
// uses `q, r := a/b, a%b; if 2*r >= b` instead of the shorter `(a + b/2) / b`.
//
// With an odd b, `b/2` truncates and the short form mis-rounds: 4/3 should be 1
// but (4+1)/3 is 1 (right by luck), while 8/3 should be 3 and (8+1)/3 is 3. The
// short form is wrong in general and this pins the case that shows it.
func TestDivRoundHalfUp_OddDenominatorDoesNotDoubleRound(t *testing.T) {
	for a := int64(0); a < 40; a++ {
		for b := int64(1); b < 40; b++ {
			got, err := DivRoundHalfUp(a, b)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			q, r := a/b, a%b
			want := q
			if 2*r >= b {
				want = q + 1
			}
			if got != want {
				t.Fatalf("DivRoundHalfUp(%d, %d) = %d, want %d", a, b, got, want)
			}
			// The invariant that makes this correct: the result is the nearest
			// integer to the exact quotient.
			lower := got - 1
			if a*2 < (2*lower+1)*b {
				t.Errorf("DivRoundHalfUp(%d, %d) = %d is below the nearest integer", a, b, got)
			}
			upper := got + 1
			if a*2 > (2*upper-1)*b {
				t.Errorf("DivRoundHalfUp(%d, %d) = %d is above the nearest integer", a, b, got)
			}
		}
	}
}

func TestDivRoundHalfUp_RefusesDivisionByZero(t *testing.T) {
	if _, err := DivRoundHalfUp(100, 0); err == nil {
		t.Fatal("division by zero must be refused")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Satang — the wire boundary
// ─────────────────────────────────────────────────────────────────────────────

func TestSatangOf_RefusesValuesPastTheCeiling(t *testing.T) {
	// MaxSafeSatang is 2^53-1 satang, ฿90 trillion. It began as a JSON precision
	// boundary; since the wire became a quoted digit string it is a sanity ceiling.
	// It is still enforced, because a value this large is a unit error or a
	// corrupted decode and must not reach a reconciliation that will not balance.
	if _, err := SatangOf(MaxSafeSatang); err != nil {
		t.Errorf("MaxSafeSatang (%d) must be accepted: %v", MaxSafeSatang, err)
	}
	if _, err := SatangOf(MaxSafeSatang + 1); err == nil {
		t.Error("2^53 satang is ฿90 trillion and must be refused at the door")
	}
	if _, err := SatangOf(math.MaxInt64); err == nil {
		t.Error("math.MaxInt64 satang is far past the ceiling and must be refused")
	}
}

func TestSatangJSON_RoundTripsAsAQuotedDigitString(t *testing.T) {
	type order struct {
		TotalSatang Satang `json:"total_satang"`
	}

	encoded, err := json.Marshal(order{TotalSatang: MustSatang(4550)})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The contract's wire form is `type: string`, pattern ^(0|[1-9][0-9]*)$.
	// Quoted digits, no decimal point, no currency symbol, never a bare number.
	if got, want := string(encoded), `{"total_satang":"4550"}`; got != want {
		t.Errorf("encoded %s, want %s", got, want)
	}

	var decoded order
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if decoded.TotalSatang != 4550 {
		t.Errorf("round trip produced %d, want 4550", decoded.TotalSatang)
	}
}

// TestSatangJSON_AcceptsExactlyTheContractPattern pins the accepted spellings to
// contracts/openapi.yaml's `Satang` pattern, so this test fails if the kernel and
// the contract drift apart.
func TestSatangJSON_AcceptsExactlyTheContractPattern(t *testing.T) {
	accepted := []struct {
		payload string
		want    Satang
	}{
		{`{"total_satang":"0"}`, 0},
		{`{"total_satang":"1"}`, 1},
		{`{"total_satang":"4550"}`, 4550},
		{`{"total_satang":"9007199254740991"}`, Satang(MaxSafeSatang)},
	}
	for _, tc := range accepted {
		var decoded struct {
			TotalSatang Satang `json:"total_satang"`
		}
		if err := json.Unmarshal([]byte(tc.payload), &decoded); err != nil {
			t.Errorf("%s was rejected: %v", tc.payload, err)
			continue
		}
		if decoded.TotalSatang != tc.want {
			t.Errorf("%s decoded to %d, want %d", tc.payload, decoded.TotalSatang, tc.want)
		}
	}
}

// TestSatangJSON_RefusesEverySpellingOutsideThePattern is a guard, not a decoder.
//
// encoding/json would happily accept all of these for a money field. Any of them
// is a way for a float, a sign, or a second spelling of one value to enter a
// system whose entire accounting argument is that floats never touch money — and
// not one of them is in the contract.
//
// The bare integers are the load-bearing rejections here: `4550` used to be this
// server's own wire form, so a client still sending it is the most likely real
// drift, and accepting both spellings during a migration is precisely what lets
// two clients disagree about whether a money field is a number or text.
func TestSatangJSON_RefusesEverySpellingOutsideThePattern(t *testing.T) {
	for _, payload := range []string{
		`{"total_satang":4550}`,    // bare JSON number, the old form
		`{"total_satang":0}`,       // bare JSON number, the old form
		`{"total_satang":4550.0}`,  // decimal
		`{"total_satang":4550.5}`,  // decimal, fractional
		`{"total_satang":4.55e3}`,  // exponent
		`{"total_satang":"-1"}`,    // sign: signed money is SignedSatang
		`{"total_satang":"+1"}`,    // explicit plus
		`{"total_satang":"007"}`,   // leading zeros: a second spelling of 7
		`{"total_satang":"45.50"}`, // major units, not satang
		`{"total_satang":""}`,      // empty
		`{"total_satang":" 4550"}`, // leading space
		`{"total_satang":null}`,    // a money field is never null
	} {
		var decoded struct {
			TotalSatang Satang `json:"total_satang"`
		}
		if err := json.Unmarshal([]byte(payload), &decoded); err == nil {
			t.Errorf("%s was accepted as Satang %d; the contract's Satang pattern is "+
				"^(0|[1-9][0-9]*)$ — quoted canonical digits and nothing else", payload, decoded.TotalSatang)
		}
	}
}

func TestParseSatang_RefusesNonCanonicalDigits(t *testing.T) {
	for _, s := range []string{"", "00", "007", "-1", "+1", "1.0", " 1", "1 ", "1_000", "abc"} {
		if _, err := ParseSatang(s); err == nil {
			t.Errorf("ParseSatang(%q) was accepted; only canonical digits matching ^(0|[1-9][0-9]*)$ are valid", s)
		}
	}
	for _, s := range []string{"0", "1", "9", "10", "4550", "9007199254740991"} {
		if _, err := ParseSatang(s); err != nil {
			t.Errorf("ParseSatang(%q) was rejected: %v", s, err)
		}
	}
}

func TestSatang_AddAndSub(t *testing.T) {
	// ฿45.50 - ฿5.00 - ฿0.50 = ฿40.00
	got := MustSatang(4550).Sub(MustSatang(500)).Sub(MustSatang(50))
	if got != 4000 {
		t.Errorf("got %d satang, want 4000", got)
	}
	if MustSatang(0).Add(MustSatang(0)) != 0 {
		t.Error("zero + zero must be zero")
	}
}

func TestSatang_AddAndSubPanicOnOverflowRatherThanWrap(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("overflowing satang addition must panic; a wrapped total becomes a negative receipt")
		}
	}()
	_ = Satang(math.MaxInt64).Add(Satang(1))
}

func TestSatang_StringAsMajorIsExact(t *testing.T) {
	tests := []struct {
		satang int64
		want   string
	}{
		{4550, "45.50"},
		{0, "0.00"},
		{5, "0.05"},
		{50, "0.50"},
		{100, "1.00"},
		{123456, "1234.56"},
		{-4550, "-45.50"},
	}
	for _, tc := range tests {
		if got := Satang(tc.satang).StringAsMajor(); got != tc.want {
			t.Errorf("Satang(%d).StringAsMajor() = %q, want %q", tc.satang, got, tc.want)
		}
	}
}

func TestMulChecked_DetectsOverflowInsteadOfWrapping(t *testing.T) {
	if _, err := MulChecked(math.MaxInt64, 2); err == nil {
		t.Error("math.MaxInt64 x 2 overflows and must be reported, not wrapped to -2")
	}
	got, err := MulNonNegativeChecked(2500, 4550)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 11_375_000 {
		t.Errorf("2500 x 4550 = %d, want 11375000", got)
	}
	if _, err := MulNonNegativeChecked(2500, -1); err == nil {
		t.Error("a negative multiplier must be refused; that is a different kind of error and must not be reinterpreted")
	}
}

func gcd(a, b int64) int64 {
	for b != 0 {
		a, b = b, a%b
	}
	if a < 0 {
		return -a
	}
	return a
}
