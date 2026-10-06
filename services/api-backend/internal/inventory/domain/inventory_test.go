package domain

import (
	"fmt"
	"strings"
	"testing"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

var t0 = time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC)

// uuidFor builds a valid UUIDv7 n milliseconds after t0.
//
// The shape is the same one internal/order/usecase/ingest_order_test.go uses, so
// a fixture here reads the same as a fixture there.
func uuidFor(n int) identity.UUIDv7 {
	ms := uint64(t0.Add(time.Duration(n) * time.Millisecond).UnixMilli())
	u, err := identity.ParseUUIDv7(fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff))
	if err != nil {
		panic("bad test fixture: " + err.Error())
	}
	return u
}

func uid(n int) identity.UUIDv7 { return uuidFor(n) }

// milli is a shorthand for the arithmetic these tests assert on.
func milli(q money.Quantity) int64 { return q.Milli() }

// ─────────────────────────────────────────────────────────────────────────────
// NewSaleDeduction — the sign convention, which is the whole point of the module
// ─────────────────────────────────────────────────────────────────────────────

// TestNewSaleDeduction_TurnsAQuantityIntoItsNegation is the module's central
// arithmetic assertion.
//
// The brief's own example: coffee beans of 0.250 kg must be stored as an integer
// 250, and selling them must move the shelf by -250. If this test fails, either
// the quantity crossed the boundary as a decimal or the sign was dropped — and
// both produce a plausible-looking number rather than an error, which is why it
// is pinned by name.
func TestNewSaleDeduction_TurnsAQuantityIntoItsNegation(t *testing.T) {
	item := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: "kg", TrackStock: true}

	d, err := NewSaleDeduction(item, uid(10), money.MustParseQuantity("0.250"), t0)
	if err != nil {
		t.Fatalf("building the deduction: %v", err)
	}

	if got := milli(d.Movement.QuantityMilli); got != -250 {
		t.Errorf("the movement is %d milli-units, want -250 (0.250 kg consumed)", got)
	}
	if got := d.Movement.QuantityMilli.String(); got != "-0.250" {
		t.Errorf("the movement renders as %q, want \"-0.250\"", got)
	}
	if d.Movement.Type != MovementSale {
		t.Errorf("the movement type is %q, want %q", d.Movement.Type, MovementSale)
	}
}

// TestNewSaleDeduction_UsesTheTerminalsOwnQuantityAndNotAFreshCalculation
// guards a specific wrong turn.
//
// It is tempting for a server to re-derive how much stock a line consumed — that
// is what it does for MONEY, and it is right there. Here it would be wrong: the
// money rule is re-derived because the server knows the branch's VAT rate, and
// there is no server-side rule for recipe consumption this service can see (the
// contract defines no Recipe). So the quantity that arrives is the quantity used,
// and this test fails if a caller starts passing something other than the line's
// own figure.
func TestNewSaleDeduction_UsesTheTerminalsOwnQuantityAndNotAFreshCalculation(t *testing.T) {
	item := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: "kg", TrackStock: true}

	// A sale of 1.500 kg, arriving as the exact decimal string the contract's
	// `Quantity` pattern permits.
	lineQty := money.MustParseQuantity("1.500")

	d, err := NewSaleDeduction(item, uid(11), lineQty, t0)
	if err != nil {
		t.Fatalf("building the deduction: %v", err)
	}
	if got := milli(d.Movement.QuantityMilli); got != -1500 {
		t.Errorf("the movement is %d milli-units, want -1500 (1.500 kg consumed)", got)
	}
}

// TestNewSaleDeduction_TheMovementIdIsTheOrderLinesId is the idempotency claim,
// asserted directly rather than left to the integration test.
//
// The reason this matters is a retry, and a retry is the NORMAL case: a terminal
// cannot distinguish a lost response from a crash, so it sends the same batch
// again. Because the movement's primary key is the order line's id, the second
// attempt collides with the first and becomes a no-op. A server-generated id
// would have made that guarantee depend on the idempotency store — the exact
// window IngestOrder.Execute documents as unsafe.
func TestNewSaleDeduction_TheMovementIdIsTheOrderLinesId(t *testing.T) {
	item := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: "pcs", TrackStock: true}
	lineID := uid(12)

	d, err := NewSaleDeduction(item, lineID, money.MustParseQuantity("2"), t0)
	if err != nil {
		t.Fatalf("building the deduction: %v", err)
	}

	if d.Movement.ID.Compare(lineID) != 0 {
		t.Errorf("the movement id is %s, want the order line's id %s", d.Movement.ID, lineID)
	}
	if d.Movement.ReferenceOrderLineID == nil {
		t.Fatal("the movement has no reference_order_line_id; the ledger row would not be readable back to a receipt")
	}
	if d.Movement.ReferenceOrderLineID.Compare(lineID) != 0 {
		t.Errorf("reference_order_line_id is %s, want %s", d.Movement.ReferenceOrderLineID, lineID)
	}
}

// TestNewSaleDeduction_RefusesAZeroQuantity documents the one deduction that
// would be a no-op.
//
// Appending it would add a ledger row that changes nothing, and a ledger row that
// changes nothing is a row somebody has to explain during a reconciliation.
func TestNewSaleDeduction_RefusesAZeroQuantity(t *testing.T) {
	item := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: "pcs", TrackStock: true}

	_, err := NewSaleDeduction(item, uid(13), money.MustParseQuantity("0"), t0)
	if err == nil {
		t.Fatal("a zero-quantity deduction was accepted; it would append a ledger row that changes nothing")
	}
	if !strings.Contains(err.Error(), "zero") {
		t.Errorf("the error does not mention the zero quantity: %v", err)
	}
}

// TestNewSaleDeduction_RefusesToMintAMovementIdWithoutAnOrderLine is the server
// guard in its purest form.
//
// `internal/identity/domain/uuidv7.go` has no generator because the server may
// never mint an id for a record the client created. This is that rule failing
// closed: with no order line there is no client id to adopt, so there is nothing
// legitimate to write.
func TestNewSaleDeduction_RefusesToMintAMovementIdWithoutAnOrderLine(t *testing.T) {
	item := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: "pcs", TrackStock: true}

	_, err := NewSaleDeduction(item, identity.Zero, money.MustParseQuantity("1"), t0)
	if err == nil {
		t.Fatal("a deduction with no order line was accepted; the server would have had to mint a movement id")
	}
	if !strings.Contains(err.Error(), "order line") {
		t.Errorf("the error does not say an order line is required: %v", err)
	}
}

// TestNewSaleDeduction_PreservesTheMilliScaleExactlyAcrossAWideRange is the
// floating-point guard, stated as arithmetic rather than as a prohibition.
//
// 0.1 + 0.2 is the canonical example, and the failure it causes here would be a
// shelf at -0.30000000000000004 which the schema's decimal(12,3) bound refuses at
// COMMIT with a constraint name and no context.
func TestNewSaleDeduction_PreservesTheMilliScaleExactlyAcrossAWideRange(t *testing.T) {
	item := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: "kg", TrackStock: true}

	for _, tc := range []struct {
		in   string
		want int64
	}{
		{"0.1", -100},
		{"0.2", -200},
		{"0.005", -5},
		{"1", -1000},
		{"1.5", -1500},
		{"2.500", -2500},
		{"999999999.999", -999999999999},
	} {
		q := money.MustParseQuantity(tc.in)
		d, err := NewSaleDeduction(item, uid(20), q, t0)
		if err != nil {
			t.Errorf("%s: building the deduction: %v", tc.in, err)
			continue
		}
		if got := milli(d.Movement.QuantityMilli); got != tc.want {
			t.Errorf("%s: the movement is %d milli-units, want %d", tc.in, got, tc.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// StockMovement.Validate
// ─────────────────────────────────────────────────────────────────────────────

func saleMovement(itemID identity.UUIDv7, lineID identity.UUIDv7, qtyMilli int64) StockMovement {
	line := lineID
	q, err := money.NewQuantityFromMilli(qtyMilli)
	if err != nil {
		panic(err)
	}
	return StockMovement{
		ID: lineID, InventoryItemID: itemID, BranchID: uid(2),
		Type: MovementSale, QuantityMilli: q, ReferenceOrderLineID: &line, Source: "sync_ingest",
	}
}

// TestStockMovementValidate_RefusesASaleThatRestocksTheShelf pins the sign rule
// on the domain side of the same rule the schema enforces.
//
// The database has `stock_movements_sale_is_an_outflow`; this is the Go half, and
// it exists because an error here can NAME the mistake while a CHECK violation
// arriving at COMMIT only names a constraint.
func TestStockMovementValidate_RefusesASaleThatRestocksTheShelf(t *testing.T) {
	m := saleMovement(uid(1), uid(14), +500)

	err := m.Validate()
	if err == nil {
		t.Fatal("a positive sale was accepted; stock left the shelf and came back in one row")
	}
	if !strings.Contains(err.Error(), "must remove stock") {
		t.Errorf("the error does not explain the sign: %v", err)
	}
}

// TestStockMovementValidate_AcceptsANegativeSale is the other half: the rule must
// refuse a POSITIVE sale without refusing sales generally.
func TestStockMovementValidate_AcceptsANegativeSale(t *testing.T) {
	if err := saleMovement(uid(1), uid(15), -500).Validate(); err != nil {
		t.Errorf("a well-formed negative sale was refused: %v", err)
	}
}

// TestStockMovementValidate_RefusesAnUnknownType keeps the vocabulary closed.
//
// An unrecognised type is a client sending something the contract does not
// describe, and storing it would make a reconciliation ungroupable — the same
// argument `catalog.OrderSource.IsValid` makes for its own three values.
func TestStockMovementValidate_RefusesAnUnknownType(t *testing.T) {
	m := saleMovement(uid(1), uid(16), -500)
	m.Type = "shrinkage"

	err := m.Validate()
	if err == nil {
		t.Fatal("an unknown movement type was accepted")
	}
	if !strings.Contains(err.Error(), "stock_movement_type") {
		t.Errorf("the error does not name the vocabulary: %v", err)
	}
}

// TestMovementType_IsValid covers the full declared vocabulary.
//
// All ten are asserted, not just the one this service produces, because the point
// of declaring them is that the set is closed and single-sourced. A test that
// only checked `sale` would pass identically whether the other nine existed.
func TestMovementType_IsValid(t *testing.T) {
	all := []MovementType{
		MovementSale, MovementRefund, MovementWaste, MovementPurchase,
		MovementAdjustmentIn, MovementAdjustmentOut,
		MovementTransferIn, MovementTransferOut,
		MovementCountCorrection, MovementComboComponent,
	}
	if len(all) != 10 {
		t.Fatalf("DOMAIN.md declares ten stock_movement_type values and %d are defined here", len(all))
	}
	for _, m := range all {
		if !m.IsValid() {
			t.Errorf("%q is declared but IsValid rejects it", m)
		}
	}
	for _, bad := range []MovementType{"", "Sale", "SALE", "transfer", "adjustment"} {
		if bad.IsValid() {
			t.Errorf("IsValid accepted %q, which is not one of the ten", bad)
		}
	}
}

// TestMovementType_IsOutflowCoversOnlySale pins the asymmetry that the schema
// encodes with `type <> 'sale' OR ...`.
//
// A purchase and an adjustment_in are inflows and a waste is an outflow, so a
// rule claiming IsOutflow for all of them would be wrong for half the vocabulary —
// and would have to be relaxed by a migration later.
func TestMovementType_IsOutflowCoversOnlySale(t *testing.T) {
	if !MovementSale.IsOutflow() {
		t.Error("a sale is not an outflow; the schema CHECKs the opposite")
	}
	for _, inflow := range []MovementType{
		MovementPurchase, MovementAdjustmentIn, MovementTransferIn, MovementRefund,
	} {
		if inflow.IsOutflow() {
			t.Errorf("%q is reported as an outflow, but it can legitimately add stock", inflow)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// StockBalance — where negative is legal, and is the WARNING condition
// ─────────────────────────────────────────────────────────────────────────────

func balance(onHand, reserved string) StockBalance {
	return StockBalance{
		ID: uid(30), InventoryItemID: uid(1), BranchID: uid(2),
		OnHand: money.MustParseQuantity(onHand), Reserved: money.MustParseQuantity(reserved),
		Version: 1,
	}
}

// TestStockBalance_IsOversold is the ratified policy, pinned.
//
// A negative on_hand is the ONE fact an operator needs after an offline oversell,
// and refusing to record it would force the next reconciliation to be argued
// against a number the system declined to keep. The write COMMITS and this
// reports it upward.
func TestStockBalance_IsOversold(t *testing.T) {
	for _, tc := range []struct {
		onHand string
		want   bool
	}{
		{"5.000", false},
		{"0.001", false},
		{"0.000", false},
		{"-0.001", true},
		{"-0.750", true},
	} {
		b := balance(tc.onHand, "0")
		if got := b.IsOversold(); got != tc.want {
			t.Errorf("on_hand %s: IsOversold = %v, want %v", tc.onHand, got, tc.want)
		}
		if err := b.Validate(); err != nil {
			t.Errorf("on_hand %s: a signed balance was refused by Validate: %v", tc.onHand, err)
		}
	}
}

// TestStockBalanceValidate_RefusesANegativeReservation is the deliberate
// asymmetry with the line above.
//
// A negative on_hand says "we oversold, buy more". A negative reserved says "the
// arithmetic is broken, ignore it" — and it would report more available stock
// than physically exists, which is the one direction of drift that sells product
// a shop does not have (terminal 0003_stock_balances.sql).
func TestStockBalanceValidate_RefusesANegativeReservation(t *testing.T) {
	b := balance("5.000", "-1")

	err := b.Validate()
	if err == nil {
		t.Fatal("a negative reservation was accepted; it reports more available stock than exists")
	}
	if !strings.Contains(err.Error(), "reservation") {
		t.Errorf("the error does not explain the reservation: %v", err)
	}
}

// TestStockBalance_AvailableIsOnHandMinusReserved is the contract's own line:
// "Available-to-sell is `on_hand - reserved`".
func TestStockBalance_Available(t *testing.T) {
	for _, tc := range []struct {
		onHand, reserved, want string
	}{
		{"5.000", "0", "5.000"},
		{"5.000", "1.500", "3.500"},
		{"0.000", "0", "0.000"},
		// Available may be negative for the same reason on_hand may.
		{"-0.750", "0", "-0.750"},
		{"1.000", "1.500", "-0.500"},
	} {
		got, err := balance(tc.onHand, tc.reserved).Available()
		if err != nil {
			t.Errorf("on_hand %s reserved %s: %v", tc.onHand, tc.reserved, err)
			continue
		}
		if got.String() != tc.want {
			t.Errorf("on_hand %s reserved %s: available is %s, want %s", tc.onHand, tc.reserved, got, tc.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// InventoryItem.Validate
// ─────────────────────────────────────────────────────────────────────────────

// TestInventoryItemValidate_RefusesABlankUnit: a quantity with no unit cannot be
// converted, reconciled, or read by an operator.
func TestInventoryItemValidate_RefusesABlankUnit(t *testing.T) {
	for _, unit := range []string{"", "   "} {
		item := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: unit, TrackStock: true}
		err := item.Validate()
		if err == nil {
			t.Errorf("unit %q was accepted", unit)
			continue
		}
		if !strings.Contains(err.Error(), "unit") {
			t.Errorf("unit %q: the error does not name the unit: %v", unit, err)
		}
	}
}

// TestInventoryItemValidate_AcceptsTheUnitVocabularyTheContractUses: the units
// the contract's own example names. A blank check that also refused "g" or "pcs"
// would be a rule nobody asked for.
func TestInventoryItemValidate_AcceptsTheUnitVocabularyTheContractUses(t *testing.T) {
	for _, unit := range []string{"kg", "g", "ml", "pcs"} {
		item := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: unit, TrackStock: true}
		if err := item.Validate(); err != nil {
			t.Errorf("unit %q was refused: %v", unit, err)
		}
	}
}

// TestInventoryItemValidate_RawIngredientHasNoVariant enforces the contract in
// words: "`null` when `is_raw` is true (an ingredient with no direct sale)".
func TestInventoryItemValidate_RawIngredientHasNoVariant(t *testing.T) {
	variant := uid(40)

	raw := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: "kg", TrackStock: true,
		IsRaw: true, ProductVariantID: &variant}
	err := raw.Validate()
	if err == nil {
		t.Fatal("a raw ingredient claiming a product variant was accepted; it has no direct sale by definition")
	}
	if !strings.Contains(err.Error(), "recipe") {
		t.Errorf("the error does not explain why: %v", err)
	}

	// The converse must hold, or the rule would be a one-way trapdoor.
	good := InventoryItem{ID: uid(2), BranchID: uid(2), Unit: "kg", TrackStock: true,
		IsRaw: false, ProductVariantID: &variant}
	if err := good.Validate(); err != nil {
		t.Errorf("a finished good naming its variant was refused: %v", err)
	}
}

// TestInventoryItem_TrackedIsWhatMakesTheDeductionSkip: the flag exists so an
// untracked article is skipped rather than tracked at zero.
func TestInventoryItem_Tracked(t *testing.T) {
	tracked := InventoryItem{ID: uid(1), BranchID: uid(2), Unit: "pcs", TrackStock: true}
	if !tracked.Tracked() {
		t.Error("an item with track_stock = true is not tracked")
	}
	untracked := InventoryItem{ID: uid(2), BranchID: uid(2), Unit: "pcs", TrackStock: false}
	if untracked.Tracked() {
		t.Error("an item with track_stock = false is tracked; the deduction would count a garnish at zero")
	}
}

// TestVersion_NextIsTheContractDefinition: "The server increments it on every
// write."
func TestVersion_Next(t *testing.T) {
	if got := (Version(7)).Next(); got != 8 {
		t.Errorf("Version(7).Next() = %d, want 8", got)
	}
}
