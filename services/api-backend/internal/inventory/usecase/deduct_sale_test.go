package usecase

import (
	"context"
	"fmt"
	"testing"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	inventory "wal-asri-pos/services/api-backend/internal/inventory/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

var now = time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC)

func uid(n int) identity.UUIDv7 {
	ms := uint64(now.Add(time.Duration(n) * time.Millisecond).UnixMilli())
	u, err := identity.ParseUUIDv7(fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff))
	if err != nil {
		panic("bad test fixture: " + err.Error())
	}
	return u
}

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
//
// These hold the REAL port contract, the way
// internal/order/adapter/memory does: the store applies the same += arithmetic and
// the same "a movement that already exists is skipped" rule the Postgres adapter
// does, so a test that passes here is testing the rules the driver must enforce.
// ─────────────────────────────────────────────────────────────────────────────

// fakeItems resolves variants against a fixed table.
type fakeItems struct {
	byVariant map[identity.UUIDv7]inventory.InventoryItem
	// untracked variants resolve successfully to an item with track_stock = false,
	// which is the garnish case. A variant absent from byVariant entirely is the
	// "no inventory article yet" case. Both must be skipped, and they are
	// distinguished here so a test can exercise each.
	err error
	// calls counts resolutions, so a test can assert an untracked line does not
	// cause a write.
	calls int
}

func (f *fakeItems) TrackedItemFor(_ context.Context, _ identity.UUIDv7, variantID identity.UUIDv7) (inventory.InventoryItem, bool, error) {
	f.calls++
	if f.err != nil {
		return inventory.InventoryItem{}, false, f.err
	}
	item, ok := f.byVariant[variantID]
	return item, ok, nil
}

// fakeStore applies deductions exactly as the Postgres adapter does.
type fakeStore struct {
	// byItem is the current balance per article, in milli-units.
	byItem map[identity.UUIDv7]int64

	applied []inventory.Deduction
	// appliedIDs is the ledger. A movement whose id is already present is SKIPPED,
	// mirroring `INSERT ... ON CONFLICT (id) DO NOTHING`.
	appliedIDs map[identity.UUIDv7]bool
	// totalMilli is the sum of every applied movement — the ledger's own figure.
	// The integration suite asserts the same identity against a live database.
	totalMilli int64
	// appends counts movements actually appended; a duplicate does not increment.
	appends int
	// calls counts transactions opened.
	calls int

	err error
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		byItem:     map[identity.UUIDv7]int64{},
		appliedIDs: map[identity.UUIDv7]bool{},
	}
}

func (s *fakeStore) ApplyDeductions(_ context.Context, deductions []inventory.Deduction) ([]inventory.StockBalance, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}

	// One transaction: a failure halfway through would roll all of it back. The
	// fake models the success path only, so a mid-loop error cannot be injected —
	// the point of the fake is the arithmetic and the skip rule, not the rollback.
	touched := map[identity.UUIDv7]bool{}
	for _, d := range deductions {
		if s.appliedIDs[d.Movement.ID] {
			continue // ON CONFLICT DO NOTHING
		}
		s.appliedIDs[d.Movement.ID] = true
		s.appends++
		s.totalMilli += d.Movement.QuantityMilli.Milli()
		s.byItem[d.Movement.InventoryItemID] += d.Movement.QuantityMilli.Milli()
		touched[d.Movement.InventoryItemID] = true
	}

	out := make([]inventory.StockBalance, 0, len(touched))
	for itemID := range touched {
		q, err := money.NewQuantityFromMilli(s.byItem[itemID])
		if err != nil {
			return nil, err
		}
		out = append(out, inventory.StockBalance{
			ID: uid(900), InventoryItemID: itemID, BranchID: uid(2),
			OnHand: q, Reserved: money.MustParseQuantity("0"), Version: 1,
		})
	}
	return out, nil
}

// balanceOf reads the fake's current figure for an article.
func (s *fakeStore) balanceOf(itemID identity.UUIDv7) int64 { return s.byItem[itemID] }

// ReverseForVoid is a no-op for the fake store.
func (s *fakeStore) ReverseForVoid(ctx context.Context, branchID identity.UUIDv7, orderID identity.UUIDv7) error {
	return nil
}

// AdjustStock is a no-op for the fake store.
func (s *fakeStore) AdjustStock(_ context.Context, req inventory.AdjustStockRequest) (inventory.AdjustStockResult, error) {
	return inventory.AdjustStockResult{AuditLogID: req.AuditLogID, Applied: true}, nil
}

// ReconcileBalances is a no-op for the fake store.
func (s *fakeStore) ReconcileBalances(_ context.Context, branchID identity.UUIDv7) (inventory.ReconcileResult, error) {
	return inventory.ReconcileResult{BranchID: branchID, CorrectedCount: 0, Items: []inventory.ReconcileItem{}}, nil
}

// GetAudit retrieves an audit record by its ID (fake implementation).
func (s *fakeStore) GetAudit(_ context.Context, id identity.UUIDv7) (inventory.AuditLog, error) {
	return inventory.AuditLog{}, fmt.Errorf("fake: audit not found")
}

var _ ItemLookup = (*fakeItems)(nil)
var _ StockStore = (*fakeStore)(nil)

// ── fixtures ──────────────────────────────────────────────────────────────────

// variantOf reads the variant pointer off an article.
//
// `ProductVariantID` is `*identity.UUIDv7`, so a fixture cannot name it inline as
// a map key. This helper is why a map literal below reads
// `{variantOf(beans): beans, …}` instead of a dereference at every call site —
// and note that the naive `variantOf(beans)` indexes the 16-BYTE ARRAY
// under the pointer and yields a `byte`. That mistake compiles far enough to be
// alarming and is the reason this helper exists.
func variantOf(item inventory.InventoryItem) identity.UUIDv7 {
	if item.ProductVariantID == nil {
		panic("test fixture: " + item.ID.String() + " has no variant")
	}
	return *item.ProductVariantID
}

// item builds a tracked article for a variant.
func item(itemN, variantN int, unit string) inventory.InventoryItem {
	variant := uid(variantN)
	return inventory.InventoryItem{
		ID: uid(itemN), BranchID: uid(2), ProductVariantID: &variant,
		SKU: "ING-001", NameTH: "แป้ง", Unit: unit, TrackStock: true,
	}
}

// line builds a sold line.
func line(lineN, variantN int, qty string) SaleLine {
	return SaleLine{
		OrderLineID:      uid(lineN),
		ProductVariantID: uid(variantN),
		Quantity:         money.MustParseQuantity(qty),
	}
}

func newDeduct(items ItemLookup, store StockStore) *DeductSale {
	return NewDeductSale(DeductSaleDeps{Items: items, Store: store, Now: func() time.Time { return now }})
}

// ─────────────────────────────────────────────────────────────────────────────
// The deduction itself
// ─────────────────────────────────────────────────────────────────────────────

// TestDeductSale_DeductsTheRealLineQuantitiesInMilliUnits is the headline
// arithmetic: 0.250 kg of beans and 1.500 of something else move their shelves by
// exactly -250 and -1500.
//
// The fractions are the point. 0.250 and 0.300 are the values that a float would
// render as 0.25 and 0.30000000000000004, and the schema's decimal(12,3) bound
// would refuse the second at COMMIT with a constraint name and no context.
func TestDeductSale_DeductsTheRealLineQuantitiesInMilliUnits(t *testing.T) {
	beans := item(1, 101, "kg")
	milk := item(2, 102, "ml")

	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{
		variantOf(beans): beans,
		variantOf(milk):  milk,
	}}
	store := newFakeStore()
	// Stock already on the shelf, so this test measures the DEDUCTION rather than
	// the oversell policy. The policy has its own tests below, and a fixture that
	// started at zero would trip it here and obscure the arithmetic being pinned.
	store.byItem[beans.ID] = 5000 // 5.000 kg
	store.byItem[milk.ID] = 20000 // 20.000 ml

	warnings, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2),
		Lines: []SaleLine{
			line(10, 101, "0.250"), // 0.250 kg of beans
			line(11, 102, "1.500"), // 1.500 ml of milk
		},
	})
	if err != nil {
		t.Fatalf("executing the deduction: %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none; both shelves remain in stock", warnings)
	}

	if got := store.balanceOf(beans.ID); got != 5000-250 {
		t.Errorf("beans are at %d milli-units, want %d (5000 - 250)", got, 5000-250)
	}
	if got := store.balanceOf(milk.ID); got != 20000-1500 {
		t.Errorf("milk is at %d milli-units, want %d (20000 - 1500)", got, 20000-1500)
	}
	if store.appends != 2 {
		t.Errorf("appended %d movements, want 2", store.appends)
	}
}

// TestDeductSale_UsesTheOrderLinesOwnQuantity: the deduction is driven by the
// quantity that ARRIVED, not by a second calculation.
//
// The server re-prices money because it knows the branch's VAT rate. It has no
// equivalent authority over recipe consumption — the contract defines no Recipe —
// so inventing a second figure would create a discrepancy with no way to
// adjudicate it.
func TestDeductSale_UsesTheOrderLinesOwnQuantity(t *testing.T) {
	beans := item(1, 101, "kg")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{variantOf(beans): beans}}
	store := newFakeStore()

	// 0.005 of a garnish is the value that a float cannot hold exactly.
	if _, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2),
		Lines:    []SaleLine{line(10, 101, "0.005")},
	}); err != nil {
		t.Fatalf("executing the deduction: %v", err)
	}

	if got := store.balanceOf(beans.ID); got != -5 {
		t.Errorf("beans are at %d milli-units, want -5 (0.005 exactly)", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The skip decision
// ─────────────────────────────────────────────────────────────────────────────

// TestDeductSale_SkipsAVariantWithNoTrackedItem covers BOTH ways a variant can
// resolve to nothing, because they are different situations that must both be
// skipped and neither may become an error.
func TestDeductSale_SkipsAVariantWithNoTrackedItem(t *testing.T) {
	beans := item(1, 101, "kg")

	// track_stock = false: a garnish that is never counted.
	garnishVariant := uid(102)
	garnish := inventory.InventoryItem{
		ID: uid(2), BranchID: uid(2), ProductVariantID: &garnishVariant,
		NameTH: "ใบมินต์", Unit: "pcs", TrackStock: false,
	}
	// Absent entirely: a new menu item whose inventory article nobody has created.
	unknownVariant := uid(103)

	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{
		variantOf(beans):   beans,
		variantOf(garnish): garnish,
	}}
	store := newFakeStore()
	store.byItem[beans.ID] = 5000 // 5.000 kg, so only the tracked line's arithmetic is measured

	warnings, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2),
		Lines: []SaleLine{
			line(10, 101, "0.250"), // tracked
			line(11, 102, "5"),     // track_stock = false
			// The variant is named directly rather than through line(), so it is
			// visibly the SAME id the lookup table deliberately omits.
			{OrderLineID: uid(12), ProductVariantID: unknownVariant, Quantity: money.MustParseQuantity("3")},
		},
	})
	if err != nil {
		t.Fatalf("a sale with untracked lines failed: %v. An untracked variant is a NORMAL case; "+
			"refusing the sale would mean a café cannot sell a new item until its stock-keeping is done", err)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none", warnings)
	}

	if got := store.balanceOf(beans.ID); got != 4750 {
		t.Errorf("beans are at %d milli-units, want 4750; the tracked line must still deduct", got)
	}
	if got := store.balanceOf(garnish.ID); got != 0 {
		t.Errorf("the untracked garnish is at %d, want 0; track_stock = false must not be tracked at zero", got)
	}
	if store.appends != 1 {
		t.Errorf("appended %d movements, want 1; only the tracked line may write", store.appends)
	}
}

// TestDeductSale_AnOrderWithNoTrackedLinesOpensNoTransaction: an order whose
// every line is untracked has genuinely nothing to deduct.
//
// Writing a zero row for each would be a fiction, and the distinction between
// "nothing to do" and "wrote something that changed nothing" is worth a test.
func TestDeductSale_AnOrderWithNoTrackedLinesOpensNoTransaction(t *testing.T) {
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{}}
	store := newFakeStore()

	warnings, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2),
		Lines:    []SaleLine{line(10, 101, "1"), line(11, 102, "1")},
	})
	if err != nil {
		t.Fatalf("executing: %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none", warnings)
	}
	if store.calls != 0 {
		t.Errorf("opened %d transactions, want 0; there was nothing to deduct", store.calls)
	}
}

// TestDeductSale_AFailedLookupIsNotASkip is the failure that would silently lose
// stock.
//
// "Cannot find out" and "nothing to deduct" are separate return values precisely
// so a dropped database connection cannot be mistaken for "this variant is not
// tracked". Confusing them would acknowledge sales whose stock was never
// deducted — the exact silent-gap failure this service refuses elsewhere.
func TestDeductSale_AFailedLookupIsNotASkip(t *testing.T) {
	beans := item(1, 101, "kg")
	items := &fakeItems{
		byVariant: map[identity.UUIDv7]inventory.InventoryItem{variantOf(beans): beans},
		err:       fmt.Errorf("dial tcp 127.0.0.1:5433: connection refused"),
	}
	store := newFakeStore()

	_, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2), Lines: []SaleLine{line(10, 101, "1")},
	})
	if err == nil {
		t.Fatal("a failed lookup was swallowed; the caller would believe stock was deducted when it was not")
	}
	if store.calls != 0 {
		t.Errorf("opened %d write transactions after a failed lookup, want 0", store.calls)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The negative policy — the ratified decision, asserted at the layer that makes it
// ─────────────────────────────────────────────────────────────────────────────

// TestDeductSale_ANewItemStartsAtZeroAndMayGoNegative: an article that has never
// been counted has no balance row, so its first deduction creates one AT the
// negative figure.
//
// This is the offline oversell, arriving as the very first sale of an article. The
// write COMMITS and a warning is returned. It is emphatically not an error: the
// flour is gone, the customer has paid, and the receipt is printed.
func TestDeductSale_ANewItemStartsAtZeroAndMayGoNegative(t *testing.T) {
	beans := item(1, 101, "kg")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{variantOf(beans): beans}}
	store := newFakeStore()

	warnings, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2), Lines: []SaleLine{line(10, 101, "0.750")},
	})
	if err != nil {
		t.Fatalf("an oversell FAILED the deduction: %v. A negative balance must commit; the sale "+
			"already happened and refusing the record only hides the shortage", err)
	}

	if got := store.balanceOf(beans.ID); got != -750 {
		t.Errorf("beans are at %d milli-units, want -750", got)
	}
	if len(warnings) != 1 {
		t.Fatalf("got %d warnings, want exactly 1: %v", len(warnings), warnings)
	}

	w := warnings[0]
	if !w.Oversold() {
		t.Errorf("the warning reports on_hand %d, which does not report itself as oversold", w.OnHandMilli)
	}
	if w.OnHandMilli != -750 {
		t.Errorf("the warning reports on_hand %d milli-units, want -750", w.OnHandMilli)
	}
	if w.InventoryItemID.Compare(beans.ID) != 0 {
		t.Errorf("the warning names article %s, want %s", w.InventoryItemID, beans.ID)
	}
	if w.Unit != "kg" {
		t.Errorf("the warning carries unit %q, want kg; an operator reading \"-0.750\" needs the unit", w.Unit)
	}
	if w.NameTH == "" {
		t.Error("the warning carries no article name; an operator cannot act on an id")
	}
}

// TestDeductSale_StaysNegativeAcrossFurtherSales: once oversold, it does not
// recover by itself and does not start failing.
//
// The order line ids DIFFER on each call, deliberately. Reusing one would be a
// RETRY of the same line, which the ledger correctly treats as a no-op — the
// guarantee the idempotency test pins. Three separate sales are three separate
// lines, and this test would be measuring the wrong thing if they shared an id.
func TestDeductSale_StaysNegativeAcrossFurtherSales(t *testing.T) {
	beans := item(1, 101, "kg")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{variantOf(beans): beans}}
	store := newFakeStore()
	deduct := newDeduct(items, store)

	for i, qty := range []string{"0.250", "0.500", "0.125"} {
		warnings, err := deduct.Execute(context.Background(), SaleRequest{
			BranchID: uid(2), Lines: []SaleLine{line(30+i, 101, qty)},
		})
		if err != nil {
			t.Fatalf("selling %s failed while already oversold: %v", qty, err)
		}
		if len(warnings) != 1 {
			t.Errorf("selling %s produced %d warnings, want 1; a shelf already at zero must keep warning", qty, len(warnings))
		}
	}

	if got := store.balanceOf(beans.ID); got != -875 {
		t.Errorf("beans are at %d milli-units, want -875 (250 + 500 + 125)", got)
	}
}

// TestDeductSale_NoWarningWhenTheShelfIsStillInStock: the warning must not fire
// on every sale, or it is noise an operator learns to ignore.
func TestDeductSale_NoWarningWhenTheShelfIsStillInStock(t *testing.T) {
	beans := item(1, 101, "kg")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{variantOf(beans): beans}}
	store := newFakeStore()
	store.byItem[beans.ID] = 5000 // 5.000 kg already on the shelf

	warnings, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2), Lines: []SaleLine{line(10, 101, "0.250")},
	})
	if err != nil {
		t.Fatalf("executing: %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none; 4.750 kg remains", warnings)
	}
	if got := store.balanceOf(beans.ID); got != 4750 {
		t.Errorf("beans are at %d milli-units, want 4750", got)
	}
}

// TestDeductSale_WarnsOnlyForArticlesThatWentNegative: an order touching three
// articles warns about one of them.
func TestDeductSale_WarnsOnlyForArticlesThatWentNegative(t *testing.T) {
	beans := item(1, 101, "kg") // will go negative
	milk := item(2, 102, "ml")  // stays positive
	sugar := item(3, 103, "kg") // will go exactly to zero
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{
		variantOf(beans): beans, variantOf(milk): milk, variantOf(sugar): sugar,
	}}
	store := newFakeStore()
	store.byItem[milk.ID] = 10000
	store.byItem[sugar.ID] = 250

	warnings, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2),
		Lines: []SaleLine{
			line(10, 101, "0.250"), //    0 -   250 = -250  -> oversold
			line(11, 102, "1.500"), // 10000 -  1500 = 8500 -> in stock
			line(12, 103, "0.250"), //  250 -   250 =    0 -> exactly empty, NOT oversold
		},
	})
	if err != nil {
		t.Fatalf("executing: %v", err)
	}

	if len(warnings) != 1 {
		t.Fatalf("got %d warnings (%v), want exactly 1; exactly zero is not negative", len(warnings), warnings)
	}
	if warnings[0].InventoryItemID.Compare(beans.ID) != 0 {
		t.Errorf("the warning names %s, want the beans %s", warnings[0].InventoryItemID, beans.ID)
	}

	// Exactly zero must NOT warn. `IsOversold` is `on_hand < 0`, not `<= 0`.
	if got := store.balanceOf(sugar.ID); got != 0 {
		t.Errorf("sugar is at %d milli-units, want exactly 0", got)
	}
}

// TestDeductSale_DeduplicatesOneWarningPerItem: a customer ordering two oat
// lattes is two order lines against ONE article, so an undeduplicated warning
// would make an operator read one shortage as two.
func TestDeductSale_DeduplicatesOneWarningPerItem(t *testing.T) {
	beans := item(1, 101, "kg")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{variantOf(beans): beans}}
	store := newFakeStore()

	warnings, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2),
		Lines: []SaleLine{
			line(10, 101, "0.250"),
			line(11, 101, "0.250"),
			line(12, 101, "0.250"),
		},
	})
	if err != nil {
		t.Fatalf("executing: %v", err)
	}

	if got := store.balanceOf(beans.ID); got != -750 {
		t.Errorf("beans are at %d milli-units, want -750; all three lines must deduct", got)
	}
	if len(warnings) != 1 {
		t.Errorf("got %d warnings, want exactly 1 for the single article: %v", len(warnings), warnings)
	}
}

// TestDeductSale_OrdersWarningsDeterministically: the list is sorted by article id
// so a test — and a terminal rendering — sees the same order every time.
func TestDeductSale_OrdersWarningsDeterministically(t *testing.T) {
	first := item(1, 101, "kg")
	second := item(2, 102, "kg")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{
		variantOf(first): first, variantOf(second): second,
	}}

	for run := 0; run < 12; run++ {
		store := newFakeStore()
		warnings, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
			BranchID: uid(2),
			Lines:    []SaleLine{line(10, 102, "1"), line(11, 101, "1")},
		})
		if err != nil {
			t.Fatalf("executing: %v", err)
		}
		if len(warnings) != 2 {
			t.Fatalf("got %d warnings, want 2", len(warnings))
		}
		// id(1) sorts before id(2) because the fixtures are millisecond-ordered.
		if warnings[0].InventoryItemID.Compare(warnings[1].InventoryItemID) >= 0 {
			t.Fatalf("run %d: warnings are not sorted by article id: %s then %s",
				run, warnings[0].InventoryItemID, warnings[1].InventoryItemID)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

// TestDeductSale_ReapplyingTheSameLinesDeductsOnce: the movement's id is the
// order line's id, so a terminal retrying the batch that carried those lines hits
// the ledger's primary key and the second attempt is a no-op.
//
// This is the NORMAL case, not an edge case: a terminal cannot distinguish a lost
// response from a crash, so it sends the same batch again.
func TestDeductSale_ReapplyingTheSameLinesDeductsOnce(t *testing.T) {
	beans := item(1, 101, "kg")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{variantOf(beans): beans}}
	store := newFakeStore()
	deduct := newDeduct(items, store)

	req := SaleRequest{BranchID: uid(2), Lines: []SaleLine{line(10, 101, "0.250")}}

	if _, err := deduct.Execute(context.Background(), req); err != nil {
		t.Fatalf("the first apply failed: %v", err)
	}
	for retry := 0; retry < 3; retry++ {
		if _, err := deduct.Execute(context.Background(), req); err != nil {
			t.Fatalf("retry %d failed: %v", retry, err)
		}
	}

	if got := store.balanceOf(beans.ID); got != -250 {
		t.Errorf("beans are at %d milli-units after four applies, want -250; a retry must not deduct twice", got)
	}
	if store.appends != 1 {
		t.Errorf("appended %d movements, want 1", store.appends)
	}
}

// TestDeductSale_AFailedApplyIsNotSwallowed: if the store cannot commit, the
// caller must NOT be told the sale succeeded with stock intact.
func TestDeductSale_AFailedApplyIsNotSwallowed(t *testing.T) {
	beans := item(1, 101, "kg")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{variantOf(beans): beans}}
	store := newFakeStore()
	store.err = fmt.Errorf("deadlock detected")

	if _, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2), Lines: []SaleLine{line(10, 101, "1")},
	}); err == nil {
		t.Fatal("a failed apply returned success; the caller would acknowledge a sale whose stock was never deducted")
	}
}

// TestDeductSale_OneTransactionForTheWholeOrder: the movement and its balance move
// together, so a partially-applied order is not representable.
func TestDeductSale_OneTransactionForTheWholeOrder(t *testing.T) {
	beans := item(1, 101, "kg")
	milk := item(2, 102, "ml")
	items := &fakeItems{byVariant: map[identity.UUIDv7]inventory.InventoryItem{
		variantOf(beans): beans, variantOf(milk): milk,
	}}
	store := newFakeStore()

	if _, err := newDeduct(items, store).Execute(context.Background(), SaleRequest{
		BranchID: uid(2),
		Lines:    []SaleLine{line(10, 101, "0.250"), line(11, 102, "0.500")},
	}); err != nil {
		t.Fatalf("executing: %v", err)
	}

	if store.calls != 1 {
		t.Errorf("opened %d transactions for a two-line order, want exactly 1", store.calls)
	}
}
