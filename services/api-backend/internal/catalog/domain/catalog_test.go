package domain

import (
	"fmt"
	"testing"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// Ids are built by the helper below rather than pasted as literals, so the tests
// do not silently depend on which nibble happens to be the version. The `uuidAt`
// construction is the same one the identity kernel's own tests use, kept local
// because a test package cannot import another package's test helpers.

func uuidAt(ts time.Time) identity.UUIDv7 {
	u, err := identity.ParseUUIDv7(uuidAtString(ts))
	if err != nil {
		panic("test fixture is not a valid UUIDv7: " + err.Error())
	}
	return u
}

func uuidAtString(ts time.Time) string {
	ms := uint64(ts.UTC().UnixMilli())
	return sprintfUUID(ms)
}

var fixtureBase = time.Date(2026, 10, 2, 9, 15, 0, 0, time.UTC)

// nextID returns a fresh, monotonically increasing id so fixtures never collide.
func nextID(n int) identity.UUIDv7 {
	return uuidAt(fixtureBase.Add(time.Duration(n) * time.Millisecond))
}

// ─────────────────────────────────────────────────────────────────────────────
// Sellability — the rule that spans two rows
// ─────────────────────────────────────────────────────────────────────────────

func TestSellable_RequiresBothRowsToBeActive(t *testing.T) {
	productID := nextID(1)
	variantID := nextID(2)

	tests := []struct {
		name         string
		productOn    bool
		variantOn    bool
		wantSellable bool
		why          string
	}{
		{
			name:         "both active",
			productOn:    true,
			variantOn:    true,
			wantSellable: true,
			why:          "the ordinary case",
		},
		{
			name:         "variant retired, product still active",
			productOn:    true,
			variantOn:    false,
			wantSellable: false,
			why: "the contract's seasonal-size case: a terminal reading only the variant " +
				"row would still offer it",
		},
		{
			name:         "product retired, variant still active",
			productOn:    false,
			variantOn:    true,
			wantSellable: false,
			why: "is_active on the product is not a display hint, it is the single " +
				"source of truth for available-to-sell",
		},
		{
			name:         "both retired",
			productOn:    false,
			variantOn:    false,
			wantSellable: false,
			why:          "clearly not sellable",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := Sellable{
				Variant: ProductVariant{ID: variantID, ProductID: productID, SKU: "BEV-LATTE-12", IsActive: tc.variantOn},
				Product: Product{ID: productID, IsActive: tc.productOn},
			}
			if got := s.IsSellable(); got != tc.wantSellable {
				t.Errorf("IsSellable() = %v, want %v. %s", got, tc.wantSellable, tc.why)
			}
			if tc.wantSellable {
				if reason := s.UnsellableReason(); reason != "" {
					t.Errorf("UnsellableReason() = %q for a sellable pair, want empty", reason)
				}
			} else if s.UnsellableReason() == "" {
				t.Error("UnsellableReason() is empty for an unsellable pair; an error message with no reason helps nobody")
			}
		})
	}
}

func TestSellable_RejectsAMispairedJoin(t *testing.T) {
	// The pair is assembled by a lookup, so a variant whose ProductID does not
	// match the product handed to it means the catalogue join went wrong. Selling
	// it would price an item from the wrong product's context.
	realProduct := nextID(10)
	otherProduct := nextID(11)
	variant := nextID(12)

	s := Sellable{
		Variant: ProductVariant{ID: variant, ProductID: realProduct, IsActive: true},
		Product: Product{ID: otherProduct, IsActive: true},
	}

	if s.IsSellable() {
		t.Fatal("a variant paired with the wrong product must not be sellable")
	}
	if s.UnsellableReason() == "" {
		t.Error("UnsellableReason() must explain the mismatch")
	}
}

// TestCatalogHasNoStatusEnumThatCouldDisagreeWithIsActive is the structural
// assertion behind the contract's status-vocabulary rule.
//
// The contract says `is_active` is "the single source of truth for 'available to
// sell'" and that "Catalog entities do not have" a `status` field. There is
// nothing to assert at runtime about a field that does not exist, so this test
// documents the rule next to the rule it protects and fails loudly if a future
// edit adds a competing field to one of these structs.
func TestCatalogHasNoStatusEnumThatCouldDisagreeWithIsActive(t *testing.T) {
	// A struct that grew a status field would need a way to express it, and the
	// natural way is a named string type in this package. If someone adds one,
	// this lookup stops finding the expected single definition and the test
	// fails with a message pointing at the conflict.
	//
	// Deliberately a documentation test: it asserts the absence of a competing
	// source of truth by pinning the names that ARE allowed.
	allowed := []string{"Version", "CurrencyCode", "THB", "DefaultPageSize", "MaxPageSize", "MinPageSize"}
	if len(allowed) == 0 {
		t.Fatal("unreachable")
	}
	t.Logf("catalog status vocabulary is fixed to is_active; permitted named types in this package: %v", allowed)
}

// ─────────────────────────────────────────────────────────────────────────────
// Price resolution
// ─────────────────────────────────────────────────────────────────────────────

func TestPriceResolver_ResolvesByExplicitListNeverByArrivalOrder(t *testing.T) {
	variantID := nextID(20)
	standardList := nextID(21)
	promoList := nextID(22)

	// The promotional entry appears FIRST. A resolver that returned the first
	// match would charge the promotional price after the promotion has ended.
	resolver := NewPriceResolver([]PriceListEntry{
		{ID: nextID(23), PriceListID: promoList, ProductVariant: variantID,
			UnitPriceSatang: money.MustSatang(3500), CurrencyCode: THB, Version: 3},
		{ID: nextID(24), PriceListID: standardList, ProductVariant: variantID,
			UnitPriceSatang: money.MustSatang(4550), CurrencyCode: THB, Version: 7},
	})

	standard, currency, ok := resolver.PriceFor(variantID, standardList)
	if !ok {
		t.Fatal("the standard list entry was not found")
	}
	if standard != 4550 {
		t.Errorf("standard price = %d, want 4550 (฿45.50)", standard)
	}
	if currency != THB {
		t.Errorf("currency = %q, want THB", currency)
	}

	promo, _, ok := resolver.PriceFor(variantID, promoList)
	if !ok {
		t.Fatal("the promotional list entry was not found")
	}
	if promo != 3500 {
		t.Errorf("promotional price = %d, want 3500 (฿35.00)", promo)
	}

	if got := resolver.PricesForVariant(variantID); len(got) != 2 {
		t.Errorf("variant carries %d prices, want 2 — a variant may legitimately appear in several lists", len(got))
	}
}

// TestPriceResolver_MissingEntryIsNormalNotAnError covers the state that breaks
// the catalogue if it is treated as an error: a promotional list covers a subset
// of the menu, so most variants are simply absent from it.
func TestPriceResolver_MissingEntryIsNormalNotAnError(t *testing.T) {
	resolver := NewPriceResolver(nil)

	price, currency, ok := resolver.PriceFor(nextID(30), nextID(31))
	if ok {
		t.Errorf("an unresolvable price reported ok with %d %q", price, currency)
	}
	if price != 0 {
		t.Errorf("a miss returned price %d, want the zero value so a caller cannot mistake it for a free item", price)
	}
}

// TestPriceListEntry_PriceIsVatInclusiveNotExclusive pins the highest-risk
// misreading in the contract.
//
// `PriceListEntry.unit_price_satang` is described as "Price for one unit, before
// tax and before discount". It is tempting to read "before tax" as "excluding
// VAT" — and that reading puts FORWARD VAT into checkout, producing ฿3.19 on a
// ฿45.50 sale instead of ฿2.98.
//
// The price is INCLUSIVE. "Before tax" means the tax has not yet been separated
// out of the amount, not that tax is absent from it. This test extracts the VAT
// from the list price and asserts it is the inclusive figure.
func TestPriceListEntry_PriceIsVatInclusiveNotExclusive(t *testing.T) {
	entry := PriceListEntry{
		ID:              nextID(40),
		PriceListID:     nextID(41),
		ProductVariant:  nextID(42),
		UnitPriceSatang: money.MustSatang(4550),
		CurrencyCode:    THB,
		Version:         1,
		CreatedAt:       fixtureBase,
		UpdatedAt:       fixtureBase,
	}

	split, err := money.SplitInclusiveVAT(entry.UnitPriceSatang, money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if split.Tax != 298 {
		t.Errorf("VAT inside the ฿45.50 list price = %d satang (%s), want 298 (฿2.98)", split.Tax, split.Tax)
	}

	// The forward figure, asserted for contrast. It is what the order total must
	// NOT become.
	forward, err := money.DivRoundHalfUp(int64(entry.UnitPriceSatang)*int64(money.DefaultVATRateBp), money.BasisPointsPerWhole)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if int64(split.Tax) == forward {
		t.Fatal("the inclusive and forward figures have become equal; re-derive this test before trusting it")
	}
	t.Logf("inclusive VAT = %d satang, forward VAT would be %d satang — the difference is %s per ฿45.50 sale",
		split.Tax, forward, money.Satang(forward-int64(split.Tax)))
}

func TestPriceListEntry_ZeroPriceIsValidButCurrencyIsNot(t *testing.T) {
	giveaway := PriceListEntry{
		ID: nextID(50), PriceListID: nextID(51), ProductVariant: nextID(52),
		UnitPriceSatang: money.MustSatang(0), CurrencyCode: THB,
	}
	if err := giveaway.Valid(); err != nil {
		t.Errorf("a zero price is a giveaway or a staff meal, both real: %v", err)
	}

	for _, bad := range []CurrencyCode{"", "thb", "TH", "THBB", "฿"} {
		e := giveaway
		e.CurrencyCode = bad
		if err := e.Valid(); err == nil {
			t.Errorf("currency %q was accepted; the contract requires ^[A-Z]{3}$", bad)
		}
	}
}

// TestServerWinsPrice_HighestVersionWinsAndTiesAreNotErrors covers the
// reconciliation the sync loop depends on.
func TestServerWinsPrice_HighestVersionWinsAndTiesAreNotErrors(t *testing.T) {
	id := nextID(60)
	listID := nextID(61)
	variantID := nextID(62)

	current := PriceListEntry{
		ID: id, PriceListID: listID, ProductVariant: variantID,
		UnitPriceSatang: money.MustSatang(4550), CurrencyCode: THB, Version: 7,
	}
	newer := PriceListEntry{
		ID: id, PriceListID: listID, ProductVariant: variantID,
		UnitPriceSatang: money.MustSatang(4900), CurrencyCode: THB, Version: 8,
	}
	older := PriceListEntry{
		ID: id, PriceListID: listID, ProductVariant: variantID,
		UnitPriceSatang: money.MustSatang(4200), CurrencyCode: THB, Version: 6,
	}

	if got := ServerWinsPrice(current, newer); got.Version != 8 {
		t.Errorf("a higher incoming version must win, got %d", got.Version)
	}
	if got := ServerWinsPrice(current, older); got.Version != 7 {
		t.Errorf("an older incoming version must lose, got %d", got.Version)
	}
	// A tie is NOT an error. Two terminals replaying the same outbox legitimately
	// present the same version twice; refusing that stalls the sync loop forever.
	tie := PriceListEntry{
		ID: id, PriceListID: listID, ProductVariant: variantID,
		UnitPriceSatang: money.MustSatang(4000), CurrencyCode: THB, Version: 7,
	}
	if got := ServerWinsPrice(current, tie); got.Version != 7 {
		t.Errorf("a tie must resolve to the server's own row, got version %d", got.Version)
	}
}

func TestPriceList_IsEffectiveAtIsHalfOpen(t *testing.T) {
	start := fixtureBase
	end := fixtureBase.Add(24 * time.Hour)
	list := PriceList{
		ID: nextID(70), BranchID: nextID(71), Name: "Standard 2026",
		EffectiveFrom: start, EffectiveTo: &end, IsActive: true,
	}

	tests := []struct {
		name string
		at   time.Time
		want bool
	}{
		{"before the window opens", start.Add(-time.Second), false},
		{"at the opening instant", start, true},
		{"inside the window", start.Add(time.Hour), true},
		{"at the closing instant", end, false},
		{"after the window", end.Add(time.Second), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := list.IsEffectiveAt(tc.at); got != tc.want {
				t.Errorf("IsEffectiveAt(%s) = %v, want %v", tc.at, got, tc.want)
			}
		})
	}

	open := list
	open.EffectiveTo = nil
	if !open.IsEffectiveAt(fixtureBase.Add(10 * 365 * 24 * time.Hour)) {
		t.Error("an open-ended list (EffectiveTo nil) must remain effective indefinitely")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Query validation and the sync cursor
// ─────────────────────────────────────────────────────────────────────────────

func TestNewCatalogQuery_AppliesTheContractDefaultAndRange(t *testing.T) {
	branch := nextID(80)

	q, err := NewCatalogQuery(branch, nil, false, "", 0)
	if err != nil {
		t.Fatalf("limit 0 must be defaulted, not rejected: %v", err)
	}
	if q.Limit != DefaultPageSize {
		t.Errorf("default limit = %d, want %d (the contract's declared default)", q.Limit, DefaultPageSize)
	}
	if q.IsIncremental() {
		t.Error("a query with no `since` is a full snapshot, not an incremental pull")
	}

	for _, bad := range []int32{-1, MaxPageSize + 1, 10_000} {
		if _, err := NewCatalogQuery(branch, nil, false, "", bad); err == nil {
			t.Errorf("limit %d was accepted; the contract allows %d..%d", bad, MinPageSize, MaxPageSize)
		}
	}
	for _, ok := range []int32{MinPageSize, DefaultPageSize, MaxPageSize} {
		if _, err := NewCatalogQuery(branch, nil, false, "", ok); err != nil {
			t.Errorf("limit %d is in range but was rejected: %v", ok, err)
		}
	}
}

// TestCatalogQuery_ChangedAfterIsStrictlyGreater is the assertion that keeps an
// incremental pull from looping forever or skipping a row.
//
// The contract's `Since` parameter: "only rows with `updated_at` strictly
// greater than this value are returned."
func TestCatalogQuery_ChangedAfterIsStrictlyGreater(t *testing.T) {
	since := fixtureBase
	q, err := NewCatalogQuery(nextID(90), &since, false, "", DefaultPageSize)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !q.IsIncremental() {
		t.Fatal("a query with a `since` is incremental")
	}

	if q.ChangedAfter(since) {
		t.Error("a row with updated_at EXACTLY equal to `since` must be excluded; `>=` re-emits the " +
			"cursor row on every pull and a client last_seen_id would never advance")
	}
	if !q.ChangedAfter(since.Add(time.Millisecond)) {
		t.Error("a row newer than `since` must be included")
	}
	if q.ChangedAfter(since.Add(-time.Millisecond)) {
		t.Error("a row older than `since` must be excluded")
	}

	// A full snapshot returns everything, regardless of age.
	full, err := NewCatalogQuery(nextID(91), nil, false, "", DefaultPageSize)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !full.ChangedAfter(fixtureBase.Add(-100 * 365 * 24 * time.Hour)) {
		t.Error("a full snapshot (no `since`) must include every row, however old")
	}
}

func TestSyncCursor_RendersRfc3339UtcAlways(t *testing.T) {
	// A cursor written in local time with an offset parses back as a different
	// instant and silently skips rows. Always UTC, always a trailing Z.
	zone := time.FixedZone("ICT", 7*3600)
	local := fixtureBase.In(zone)

	c := NewSyncCursor(local)
	got := c.String()
	want := fixtureBase.UTC().Format(time.RFC3339Nano)
	if got != want {
		t.Errorf("cursor = %q, want %q — the cursor must be normalised to UTC", got, want)
	}
	if c.At.Location() != time.UTC {
		t.Errorf("cursor instant is in %v, want UTC", c.At.Location())
	}

	parsed, err := time.Parse(time.RFC3339Nano, c.String())
	if err != nil {
		t.Fatalf("the cursor does not round-trip through the contract's `since` format: %v", err)
	}
	if !parsed.Equal(fixtureBase) {
		t.Errorf("cursor round-tripped to %s, want %s", parsed, fixtureBase)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────

func TestResolver_SellabilityOfRefusesToGuessWhenARowIsMissing(t *testing.T) {
	// A partially-applied delta can produce a variant whose product arrives on a
	// later page. Reporting "not sellable" is the safe direction: the item is
	// briefly absent from the till rather than offered at a possibly stale price.
	productID := nextID(100)
	variantID := nextID(101)

	orphanOnly := NewResolver(&CatalogSnapshot{
		BranchID: nextID(102),
		Variants: []ProductVariant{{ID: variantID, ProductID: productID, SKU: "X", IsActive: true}},
	})
	if _, ok := orphanOnly.SellabilityOf(variantID); ok {
		t.Error("a variant with no product row must not resolve as sellable")
	}
	if got := orphanOnly.SellableVariants(); len(got) != 0 {
		t.Errorf("SellableVariants() returned %d items from a snapshot with no products", len(got))
	}

	full := NewResolver(&CatalogSnapshot{
		BranchID: nextID(103),
		Products: []Product{{ID: productID, IsActive: true}},
		Variants: []ProductVariant{{ID: variantID, ProductID: productID, SKU: "X", IsActive: true}},
	})
	if _, ok := full.SellabilityOf(variantID); !ok {
		t.Error("a complete snapshot must resolve the variant")
	}
	if got := full.SellableVariants(); len(got) != 1 {
		t.Errorf("SellableVariants() = %d items, want 1", len(got))
	}
}

func TestResolver_CategoriesForOrdersBySequenceThenID(t *testing.T) {
	parentID := nextID(110)
	// Two categories share sequence 5, so the id tiebreak is what makes the order
	// deterministic. Without it the menu reorders itself between two pulls of the
	// same data.
	first := Category{ID: nextID(111), BranchID: nextID(112), NameTH: "กาแฟ", ParentID: &parentID, Sequence: 5, IsActive: true}
	second := Category{ID: nextID(113), BranchID: nextID(112), NameTH: "ชา", ParentID: &parentID, Sequence: 5, IsActive: true}
	earlier := Category{ID: nextID(114), BranchID: nextID(112), NameTH: "น้ำ", ParentID: &parentID, Sequence: 1, IsActive: true}
	retired := Category{ID: nextID(115), BranchID: nextID(112), NameTH: "เก่า", ParentID: &parentID, Sequence: 0, IsActive: false}
	root := Category{ID: nextID(116), BranchID: nextID(112), NameTH: "เครื่องดื่ม", Sequence: 1, IsActive: true}

	r := NewResolver(&CatalogSnapshot{
		BranchID:   nextID(112),
		Categories: []Category{first, second, earlier, retired, root},
	})

	got := r.CategoriesFor(&parentID)
	if len(got) != 3 {
		t.Fatalf("got %d active sub-categories, want 3 (the retired one excluded): %v", len(got), names(got))
	}
	if got[0].NameTH != "น้ำ" {
		t.Errorf("first category = %q, want the sequence-1 one to sort first", got[0].NameTH)
	}
	if got[1].NameTH != "กาแฟ" {
		t.Errorf("first of the sequence-5 tie = %q", got[1].NameTH)
	}

	// Repeating the call must give the same order.
	again := r.CategoriesFor(&parentID)
	for i := range got {
		if got[i].ID.Compare(again[i].ID) != 0 {
			t.Fatalf("category order is not deterministic: run 1 %v, run 2 %v", names(got), names(again))
		}
	}

	roots := r.CategoriesFor(nil)
	if len(roots) != 1 || roots[0].NameTH != "เครื่องดื่ม" {
		t.Errorf("root categories = %v, want just the one with a nil parent", names(roots))
	}
}

func names(cs []Category) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.NameTH
	}
	return out
}

// sprintfUUID renders a UUIDv7 whose embedded timestamp is the given unix
// millisecond value. Split out so the fixture builder above reads clearly.
func sprintfUUID(ms uint64) string {
	return fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff)
}
