//go:build integration

// Integration tests for the inventory module's PostgreSQL persistence layer.
//
// ── WHY A BUILD TAG ───────────────────────────────────────────────────────────
//
// Same reason as internal/order/adapter/postgres/integration_test.go: these need a
// LIVE database, and a fake that reproduces the schema's CHECK constraints is a
// copy of them — which is the one thing the schema exists to avoid.
//
//	go test -tags integration ./internal/inventory/adapter/postgres/
//
// The connection string comes from WASRI_TEST_DATABASE_URL; without it these SKIP.
// (Note that .github/workflows/verify.yml treats any SKIP as a hard failure, which
// is right: a gate that quietly stops proving anything is worse than a red one.)
//
// Set up with:
//
//	./dev/wasri compose up -d postgres
//	export WASRI_TEST_DATABASE_URL='postgres://wasri_user:walasri_local_dev_pw@127.0.0.1:5433/walasri_db?sslmode=disable'
//
// NOTE THE PORT. 5433 is THIS project's. 5432 belongs to the sibling project
// `pos-walasri` and pointing these tests at it would write to someone else's
// database. See dev/DEV-SETUP.md.
//
// ── WHAT ONLY A LIVE DATABASE CAN PROVE ───────────────────────────────────────
//
// Four of the properties this change rests on are invisible to a unit test, and
// each has a test here that a fake would pass:
//
//  1. The columns really are BIGINT and a milli-unit count really does survive the
//     round trip. A Go struct holds int64 whatever the column type is.
//  2. `sum(quantity_milli) == on_hand_milli` — the ledger identity that makes the
//     whole design coherent. This is the single most important assertion below.
//  3. A NEGATIVE balance COMMITS. A fake that never talks to a CHECK constraint
//     will happily report success for a row Postgres would have refused.
//  4. The SQL `+=` loses nothing under concurrency, which is the entire reason the
//     balance is not read-modify-written.
package postgres_test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	inventorypostgres "wal-asri-pos/services/api-backend/internal/inventory/adapter/postgres"
	inventory "wal-asri-pos/services/api-backend/internal/inventory/domain"
	inventoryuc "wal-asri-pos/services/api-backend/internal/inventory/usecase"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	orderpostgres "wal-asri-pos/services/api-backend/internal/order/adapter/postgres"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures and helpers
//
// These are package-private to THIS suite. The order suite has its own copies,
// deliberately: sharing test helpers across packages means exporting them for the
// sake of a test, which makes them look like production API.
// ─────────────────────────────────────────────────────────────────────────────

// testSuiteLockKey serialises this suite against the order integration suite.
//
// `go test` runs packages in parallel and both truncate at the start of every test.
// Without this the two interleave and each blames the other for missing rows.
//
// ⚠️ MUST DIFFER from `orderpostgres.Migrate`'s own advisory lock. This suite calls
// Migrate, which takes that lock on another connection of the same pool; reusing the
// key would make the test wait on a lock its own pool already holds.
const testSuiteLockKey int64 = 0x77616c62_0002 // "walb" + 2

// testPool opens a pool, migrates, locks out the other suite, and truncates.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("WASRI_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("WASRI_TEST_DATABASE_URL is unset; skipping the live-Postgres suite")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("opening the pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("pinging the database: %v", err)
	}
	if err := orderpostgres.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrating: %v", err)
	}
	acquireSuiteLock(t, pool)
	resetTables(t, pool)
	return pool
}

// acquireSuiteLock holds the cross-package test lock for one test's duration.
//
// Session-scoped, so it is released by closing the connection rather than at COMMIT:
// a test runs many transactions and a transaction-scoped lock would be released
// almost immediately.
func acquireSuiteLock(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquiring a connection to take the test-suite lock: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, testSuiteLockKey); err != nil {
		conn.Release()
		t.Fatalf("taking the test-suite advisory lock: %v", err)
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, testSuiteLockKey)
		conn.Release()
	})
}

// resetTables empties every table a test writes.
//
// `branches CASCADE` reaches all three inventory tables, because each references it,
// so naming them here would be redundant.
func resetTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	const q = `TRUNCATE TABLE stock_balances, stock_movements, inventory_items,
	           order_lines, orders, idempotency_keys, sync_outbox_items, branches
	           RESTART IDENTITY CASCADE`
	if _, err := pool.Exec(context.Background(), q); err != nil {
		t.Fatalf("truncating the transactional tables: %v", err)
	}
	// schema_migrations is deliberately NOT truncated: that would make Migrate
	// re-apply 0001 and 0002 over existing tables.
}

func uid(n int) identity.UUIDv7 {
	ms := uint64(fixtureEpoch.Add(time.Duration(n) * time.Millisecond).UnixMilli())
	u, err := identity.ParseUUIDv7(fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff))
	if err != nil {
		panic("bad fixture UUID: " + err.Error())
	}
	return u
}

// fixtureEpoch is a FIXED instant, unlike the order suite's ingest test which must
// use a live clock. Nothing here depends on wall-clock time: there is no idempotency
// window in this module, so a hardcoded epoch cannot expire.
var fixtureEpoch = time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC)

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("counting rows with %q: %v", sql, err)
	}
	return n
}

// ── fixtures ──────────────────────────────────────────────────────────────────

var (
	testBranch = uid(1)
	testItem   = uid(2)
	testItem2  = uid(3)
	testSource = uid(200)
)

// seedBranch creates the branch every inventory row hangs off.
func seedBranch(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if err := orderpostgres.EnsureBranch(context.Background(), pool, testBranch, "Siam", money.DefaultVATRateBp); err != nil {
		t.Fatalf("seeding the branch: %v", err)
	}
}

// seedItem inserts one tracked article, returning it.
//
// `itemID` is a UUIDv7 and `variantN` an int, and keeping them distinguishable in
// the signature is not fussiness: an `int` itemID compiles happily against a caller's
// UUIDv7 only if the types agree, and a signature that types both as int makes
// `itemID` unusable as a UUIDv7 at all.
func seedItem(t *testing.T, pool *pgxpool.Pool, itemID identity.UUIDv7, variantN int, name, unit string) inventory.InventoryItem {
	t.Helper()
	variant := uid(variantN)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO inventory_items (id, branch_id, product_variant_id, sku, name_th, unit, track_stock, is_raw)
		VALUES ($1, $2, $3, $4, $5, $6, true, false)`,
		itemID, testBranch, variant, "ING-"+name, name, unit,
	); err != nil {
		t.Fatalf("seeding inventory item %s: %v", itemID, err)
	}
	return inventory.InventoryItem{
		ID: itemID, BranchID: testBranch, ProductVariantID: &variant,
		SKU: "ING-" + name, NameTH: name, Unit: unit, TrackStock: true,
	}
}

// newDeduct wires the interactor over the real store.
func newDeduct(pool *pgxpool.Pool) *inventoryuc.DeductSale {
	store := inventorypostgres.NewStockStore(pool)
	return inventoryuc.NewDeductSale(inventoryuc.DeductSaleDeps{
		Items: store,
		Store: store,
		Now:   func() time.Time { return fixtureEpoch },
	})
}

// deductOne sells qty of one tracked item and returns the warnings.
func deductOne(t *testing.T, pool *pgxpool.Pool, item inventory.InventoryItem, lineN int, qty string) []inventoryuc.StockWarning {
	t.Helper()
	warnings, err := newDeduct(pool).Execute(context.Background(), inventoryuc.SaleRequest{
		BranchID: testBranch,
		Lines: []inventoryuc.SaleLine{{
			OrderLineID:      uid(lineN),
			ProductVariantID: *item.ProductVariantID,
			Quantity:         money.MustParseQuantity(qty),
		}},
	})
	if err != nil {
		t.Fatalf("deducting %s of %s: %v", qty, item.NameTH, err)
	}
	return warnings
}

// ─────────────────────────────────────────────────────────────────────────────
// The milli-unit round trip
// ─────────────────────────────────────────────────────────────────────────────

// TestStockStore_DeductsMilliUnitsAndLandsTheLedgerSum is the central integration
// assertion: the deduction is exact AND the ledger sums to the balance.
//
// Both halves matter. The first is "0.250 kg becomes -250" — the property the
// BIGINT milli-unit representation exists for, and one a Go unit test can only ever
// assume. The second is the identity the whole design rests on:
//
//	sum(stock_movements.quantity_milli) == stock_balances.on_hand_milli
//
// Without it, `stock_balances` is just a number that a bug can move independently
// of history — which is precisely the "overwritten number" ARCHITECTURE-DEMO.md §9
// forbids.
func TestStockStore_DeductsMilliUnitsAndLandsTheLedgerSum(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	beans := seedItem(t, pool, testItem, 101, "แป้ง", "kg")
	milk := seedItem(t, pool, testItem2, 102, "นม", "ml")

	// Start both shelves in stock so this measures the DEDUCTION rather than the
	// oversell policy, which has its own test below.
	store := inventorypostgres.NewStockStore(pool)
	ctx := context.Background()
	for _, seed := range []struct {
		itemID identity.UUIDv7
		milli  int64
	}{{beans.ID, 5000}, {milk.ID, 20000}} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO stock_balances (inventory_item_id, branch_id, on_hand_milli)
			VALUES ($1, $2, $3)`, seed.itemID, testBranch, seed.milli); err != nil {
			t.Fatalf("seeding the balance of %s: %v", seed.itemID, err)
		}
	}

	deductOne(t, pool, beans, 300, "0.250")
	deductOne(t, pool, milk, 301, "1.500")

	beansBalance, err := store.Balance(ctx, beans.ID)
	if err != nil {
		t.Fatalf("reading the beans balance: %v", err)
	}
	if got := beansBalance.OnHand.Milli(); got != 5000-250 {
		t.Errorf("beans are at %d milli-units, want %d (5000 - 250)", got, 5000-250)
	}
	if got := beansBalance.OnHand.String(); got != "4.750" {
		t.Errorf("the beans balance renders as %q, want \"4.750\"", got)
	}

	milkBalance, err := store.Balance(ctx, milk.ID)
	if err != nil {
		t.Fatalf("reading the milk balance: %v", err)
	}
	if got := milkBalance.OnHand.Milli(); got != 20000-1500 {
		t.Errorf("milk is at %d milli-units, want %d (20000 - 1500)", got, 20000-1500)
	}

	// THE LEDGER IDENTITY, asserted against the database for both articles.
	//
	// `4750 + 5000` on the left is the seeded opening balance plus the movement, so
	// the ledger sums to the balance even though the opening figure was seeded
	// rather than itself recorded as a movement. That is a fixture convenience and
	// it is worth being explicit about: the identity holds for movements, and the
	// seeded opening is the one figure here that no ledger row explains.
	for _, tc := range []struct {
		item   inventory.InventoryItem
		seeded int64
	}{{beans, 5000}, {milk, 20000}} {
		sum, err := store.LedgerSum(ctx, tc.item.ID)
		if err != nil {
			t.Fatalf("summing the ledger of %s: %v", tc.item.NameTH, err)
		}
		balance, err := store.Balance(ctx, tc.item.ID)
		if err != nil {
			t.Fatalf("reading the balance of %s: %v", tc.item.NameTH, err)
		}
		want := balance.OnHand.Milli() - tc.seeded
		if sum != want {
			t.Errorf("%s: the ledger sums to %d milli-units, want %d; sum(quantity_milli) must equal "+
				"the movements that produced the balance, or the projection has drifted from its history",
				tc.item.NameTH, sum, want)
		}
	}

	// And the column really is BIGINT: this is the check a Go unit test cannot make.
	var dataType string
	if err := pool.QueryRow(ctx, `
		SELECT data_type FROM information_schema.columns
		 WHERE table_name = 'stock_balances' AND column_name = 'on_hand_milli'`).Scan(&dataType); err != nil {
		t.Fatalf("reading the column type: %v", err)
	}
	if dataType != "bigint" {
		t.Errorf("stock_balances.on_hand_milli is %q in the database, want \"bigint\"", dataType)
	}
}

// TestStockStore_LossyQuantitiesSurviveTheRoundTripExactly is the floating-point
// proof, at the only layer that can make it.
//
// 0.1 and 0.2 are the canonical examples: 0.1 + 0.2 is 0.30000000000000004 in binary
// floating point. A balance at -0.30000000000000004 would be refused by the schema's
// decimal(12,3) bound at COMMIT, with a constraint name and no context.
func TestStockStore_LossyQuantitiesSurviveTheRoundTripExactly(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 103, "vanilla", "ml")

	deductOne(t, pool, item, 310, "0.1")
	deductOne(t, pool, item, 311, "0.2")

	balance, err := inventorypostgres.NewStockStore(pool).Balance(context.Background(), item.ID)
	if err != nil {
		t.Fatalf("reading the balance: %v", err)
	}
	if got := balance.OnHand.Milli(); got != -300 {
		t.Errorf("after selling 0.1 and 0.2 the balance is %d milli-units, want exactly -300", got)
	}
	if got := balance.OnHand.String(); got != "-0.300" {
		t.Errorf("the balance renders as %q, want \"-0.300\" and never \"-0.30000000000000004\"", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The negative-stock policy, against a database that could have refused it
// ─────────────────────────────────────────────────────────────────────────────

// TestStockStore_CommitsANegativeBalanceAndReportsOversold is THE policy test.
//
// This is the one assertion a fake could not make. A Go struct will happily hold
// -750; the question is whether POSTGRES accepts the row. If someone had left a
// `CHECK (on_hand_milli >= 0)` in the migration, this test would fail at COMMIT and
// the offline oversell would be unrepresentable — the one fact an operator needs,
// after a sale that already happened, with the money taken and the receipt printed.
//
// Three layers have already committed to negative being legal: the contract's
// `StockBalance.on_hand`, the terminal's 0003_stock_balances.sql, and
// ARCHITECTURE-DEMO.md §9. This asserts the server agrees.
func TestStockStore_CommitsANegativeBalanceAndReportsOversold(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 104, "กาแฟ", "kg")
	store := inventorypostgres.NewStockStore(pool)
	ctx := context.Background()

	// An article that has never been counted has NO balance row, so this is also
	// the "first sale of a new item" case: the UPSERT creates the row AT the
	// negative figure.
	warnings := deductOne(t, pool, item, 320, "0.750")

	balance, err := store.Balance(ctx, item.ID)
	if err != nil {
		t.Fatalf("reading the balance: %v", err)
	}
	if got := balance.OnHand.Milli(); got != -750 {
		t.Errorf("on_hand_milli is %d, want -750; the row must COMMIT with a negative balance", got)
	}
	if got := balance.OnHand.String(); got != "-0.750" {
		t.Errorf("the balance renders as %q, want \"-0.750\"", got)
	}
	if !balance.IsOversold() {
		t.Error("IsOversold() is false for a balance of -0.750")
	}

	if len(warnings) != 1 {
		t.Fatalf("got %d warnings, want exactly 1; the deduction must REPORT rather than refuse", len(warnings))
	}
	w := warnings[0]
	if w.OnHandMilli != -750 {
		t.Errorf("the warning reports %d milli-units, want -750", w.OnHandMilli)
	}
	if w.Unit != "kg" {
		t.Errorf("the warning carries unit %q, want kg", w.Unit)
	}

	// And the ledger records the same fact, so the shortage is explainable rather
	// than merely visible.
	sum, err := store.LedgerSum(ctx, item.ID)
	if err != nil {
		t.Fatalf("summing the ledger: %v", err)
	}
	if sum != -750 {
		t.Errorf("the ledger sums to %d milli-units, want -750", sum)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM stock_balances WHERE inventory_item_id = $1`, item.ID); n != 1 {
		t.Errorf("%d balance rows exist for the item, want 1", n)
	}
}

// TestStockStore_KeepsCommittingOnceAlreadyNegative: once a shelf is negative it
// does not start refusing, and it does not recover by itself.
func TestStockStore_KeepsCommittingOnceAlreadyNegative(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 105, "เมล็ด", "kg")
	store := inventorypostgres.NewStockStore(pool)
	ctx := context.Background()

	for i, qty := range []string{"0.250", "0.500", "0.125"} {
		if warnings := deductOne(t, pool, item, 330+i, qty); len(warnings) != 1 {
			t.Errorf("selling %s produced %d warnings, want 1; a shelf already at zero must keep warning",
				qty, len(warnings))
		}
	}

	balance, err := store.Balance(ctx, item.ID)
	if err != nil {
		t.Fatalf("reading the balance: %v", err)
	}
	if got := balance.OnHand.Milli(); got != -875 {
		t.Errorf("on_hand_milli is %d, want -875 (250 + 500 + 125)", got)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM stock_movements WHERE inventory_item_id = $1`, item.ID); n != 3 {
		t.Errorf("%d movements recorded, want 3", n)
	}
}

// TestStockStore_TheDatabaseRefusesAPositiveSaleMovement asserts the OTHER half of
// the sign rule: a `sale` may never restock a shelf.
//
// This is the schema's `stock_movements_sale_is_an_outflow`, checked the way the
// order suite checks a CHECK violation — by asserting WHICH constraint refused it,
// not merely that something did, so a failure names the rule rather than "an error".
func TestStockStore_TheDatabaseRefusesAPositiveSaleMovement(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 106, "นมสด", "ml")
	lineID := uid(340)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO stock_movements (id, inventory_item_id, branch_id, type, quantity_milli, reference_order_line_id, source)
		VALUES ($1, $2, $3, 'sale', 500, $1, 'test')`,
		lineID, item.ID, testBranch)
	if err == nil {
		t.Fatal("the database accepted a POSITIVE sale movement; stock left the shelf and came back in one row")
	}
	if !strings.Contains(err.Error(), "stock_movements_sale_is_an_outflow") {
		t.Errorf("the failure does not name the rule that refused it; got: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM stock_movements`); n != 0 {
		t.Errorf("%d movements were stored despite the refusal", n)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency, and the ledger's append-only property
// ─────────────────────────────────────────────────────────────────────────────

// TestStockStore_ARepeatedDeductionForTheSameLineIsANoOp: the retry guarantee,
// against a real PRIMARY KEY.
//
// A terminal cannot distinguish a lost response from a crash, so it sends the same
// batch again as a matter of course. Because a movement's id is its order line's id,
// the second attempt collides and nothing moves.
func TestStockStore_ARepeatedDeductionForTheSameLineIsANoOp(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 107, "ชา", "ml")
	store := inventorypostgres.NewStockStore(pool)
	ctx := context.Background()

	for attempt := 0; attempt < 4; attempt++ {
		if warnings := deductOne(t, pool, item, 350, "0.250"); len(warnings) != 1 {
			t.Fatalf("attempt %d produced %d warnings, want 1", attempt, len(warnings))
		}
	}

	balance, err := store.Balance(ctx, item.ID)
	if err != nil {
		t.Fatalf("reading the balance: %v", err)
	}
	if got := balance.OnHand.Milli(); got != -250 {
		t.Errorf("after four identical deductions the balance is %d milli-units, want -250; a retry "+
			"must not deduct twice", got)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM stock_movements`); n != 1 {
		t.Errorf("%d movement rows exist, want 1", n)
	}
}

// TestStockStore_TheLedgerRefusesAnUpdateOrADelete proves the append-only triggers
// against the database rather than trusting the file.
//
// "Stock is a ledger of movements, never an overwritten number" is a rule a
// convention cannot hold, so it is a trigger — and a trigger nobody has fired at
// is a trigger that might not compile.
func TestStockStore_TheLedgerRefusesAnUpdateOrADelete(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 108, "กาแฟ", "kg")
	deductOne(t, pool, item, 360, "0.250")
	ctx := context.Background()

	if _, err := pool.Exec(ctx,
		`UPDATE stock_movements SET quantity_milli = 0 WHERE inventory_item_id = $1`, item.ID); err == nil {
		t.Error("the database accepted an UPDATE to a stock movement; a ledger whose rows can be " +
			"rewritten is not a ledger, and a correction must be a new count_correction movement")
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM stock_movements WHERE inventory_item_id = $1`, item.ID); err == nil {
		t.Error("the database accepted a DELETE from stock_movements")
	}

	// And the refusal must have left the history intact.
	sum, err := inventorypostgres.NewStockStore(pool).LedgerSum(ctx, item.ID)
	if err != nil {
		t.Fatalf("summing the ledger: %v", err)
	}
	if sum != -250 {
		t.Errorf("the ledger sums to %d milli-units after a refused UPDATE and DELETE, want -250", sum)
	}
}

// TestStockStore_ConcurrentDeductionsOnOneItemBothLand is the reason the balance is
// updated with a SQL `+=` rather than a read-modify-write.
//
// A read-modify-write loses this race SILENTLY: both transactions read 5000, both
// compute 4750, both write 4750, and 250 milli-units of stock vanishes with nothing
// anywhere recording that it did. A single-threaded test cannot see it, which is why
// this runs two deductions concurrently against one article and checks the total.
//
// Without a lock this is a race, so it is asserted on the SUM rather than on any
// intermediate state: whatever order the two land in, the ledger and the balance
// must both reflect both of them.
func TestStockStore_ConcurrentDeductionsOnOneItemBothLand(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 109, "ถั่ว", "kg")
	store := inventorypostgres.NewStockStore(pool)
	ctx := context.Background()

	const goroutines = 8
	const perGoroutine = 5

	// Seed an opening balance so the deductions are not all negative and the test
	// exercises a real `+=` rather than a series of inserts.
	if _, err := pool.Exec(ctx, `
		INSERT INTO stock_balances (inventory_item_id, branch_id, on_hand_milli)
		VALUES ($1, $2, 100000)`, item.ID, testBranch); err != nil {
		t.Fatalf("seeding the opening balance: %v", err)
	}

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for n := 0; n < perGoroutine; n++ {
				// A distinct order line per deduction, so these are genuinely
				// different sales rather than retries of one.
				lineID := uid(1000 + g*100 + n)
				if _, err := store.ApplyDeductions(ctx, []inventory.Deduction{{
					Movement: inventory.StockMovement{
						ID:                   lineID,
						InventoryItemID:      item.ID,
						BranchID:             testBranch,
						Type:                 inventory.MovementSale,
						QuantityMilli:        money.MustParseQuantity("-0.010"),
						ReferenceOrderLineID: &lineID,
						Source:               "sync_ingest",
						CreatedAt:            fixtureEpoch,
					},
				}}); err != nil {
					t.Errorf("goroutine %d iteration %d: %v", g, n, err)
					return
				}
			}
		}(g)
	}
	wg.Wait()

	const total = goroutines * perGoroutine
	want := int64(100000 - total*10)

	balance, err := store.Balance(ctx, item.ID)
	if err != nil {
		t.Fatalf("reading the balance: %v", err)
	}
	if got := balance.OnHand.Milli(); got != want {
		t.Errorf("on_hand_milli is %d, want %d; %d concurrent deductions of 10 milli-units each "+
			"must all land. A read-modify-write loses this race silently.", got, want, total)
	}

	sum, err := store.LedgerSum(ctx, item.ID)
	if err != nil {
		t.Fatalf("summing the ledger: %v", err)
	}
	if want := -int64(total * 10); sum != want {
		t.Errorf("the ledger sums to %d milli-units, want %d", sum, want)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM stock_movements`); n != total {
		t.Errorf("%d movements recorded, want %d", n, total)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The skip path, against a real catalogued/untracked distinction
// ─────────────────────────────────────────────────────────────────────────────

// TestStockStore_AnUntrackedVariantWritesNothing: `track_stock = false` must leave
// no trace at all — not a zero row, not a movement.
//
// A zero balance for a garnish would be a fiction (nobody counted it) and a negative
// one after it was sold would be a lie.
func TestStockStore_AnUntrackedVariantWritesNothing(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)

	variant := uid(110)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO inventory_items (id, branch_id, product_variant_id, name_th, unit, track_stock, is_raw)
		VALUES ($1, $2, $3, 'ใบมินต์', 'pcs', false, false)`,
		testItem, testBranch, variant); err != nil {
		t.Fatalf("seeding an untracked item: %v", err)
	}

	warnings, err := newDeduct(pool).Execute(context.Background(), inventoryuc.SaleRequest{
		BranchID: testBranch,
		Lines: []inventoryuc.SaleLine{{
			OrderLineID: uid(370), ProductVariantID: variant, Quantity: money.MustParseQuantity("5"),
		}},
	})
	if err != nil {
		t.Fatalf("selling an untracked variant failed: %v. It is a NORMAL case, not an error", err)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none", warnings)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM stock_balances`); n != 0 {
		t.Errorf("%d balance rows exist for an untracked item, want 0", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM stock_movements`); n != 0 {
		t.Errorf("%d movement rows exist for an untracked item, want 0", n)
	}
}

// TestStockStore_TheLookupIsBranchScoped: two branches of one shop stock different
// things, and a lookup that ignored the branch would deduct Branch A's flour
// because Branch B sold a latte.
func TestStockStore_TheLookupIsBranchScoped(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)

	otherBranch := uid(500)
	if err := orderpostgres.EnsureBranch(context.Background(), pool, otherBranch, "Chiang Mai", money.DefaultVATRateBp); err != nil {
		t.Fatalf("seeding the second branch: %v", err)
	}
	item := seedItem(t, pool, testItem, 111, "แป้ง", "kg")

	store := inventorypostgres.NewStockStore(pool)
	ctx := context.Background()

	if _, tracked, err := store.TrackedItemFor(ctx, testBranch, *item.ProductVariantID); err != nil || !tracked {
		t.Fatalf("the item is not found in its own branch: tracked = %v, err = %v", tracked, err)
	}
	// The same VARIANT, looked up from a branch that does not stock it.
	if _, tracked, err := store.TrackedItemFor(ctx, otherBranch, *item.ProductVariantID); err != nil {
		t.Fatalf("the lookup errored: %v", err)
	} else if tracked {
		t.Error("a variant of one branch resolved to an article of another; balances are per branch")
	}
}

// TestStockStore_TheDatabaseRefusesARawIngredientClaimingAVariant pins the
// contract's rule in words — "`null` when `is_raw` is true" — against the database
// that has to hold it.
func TestStockStore_TheDatabaseRefusesARawIngredientClaimingAVariant(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO inventory_items (id, branch_id, product_variant_id, name_th, unit, track_stock, is_raw)
		VALUES ($1, $2, $3, 'ข้าว', 'kg', true, true)`,
		testItem, testBranch, uid(120))
	if err == nil {
		t.Fatal("the database accepted a raw ingredient claiming a product variant; an ingredient is " +
			"consumed only through a recipe and has no direct sale")
	}
	if !strings.Contains(err.Error(), "inventory_items_raw_has_no_variant") {
		t.Errorf("the failure does not name the rule that refused it; got: %v", err)
	}
}

// TestStockStore_TheDatabaseRefusesABlankUnit: a quantity with no unit cannot be
// converted, reconciled, or read by an operator.
func TestStockStore_TheDatabaseRefusesABlankUnit(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)

	if _, err := pool.Exec(context.Background(), `
		INSERT INTO inventory_items (id, branch_id, name_th, unit, track_stock, is_raw)
		VALUES ($1, $2, 'ของไม่มีหน่วย', '   ', true, false)`,
		testItem, testBranch); err == nil {
		t.Fatal("the database accepted an article with a blank unit")
	}
}

// TestStockStore_TheDatabaseRefusesABalanceOutsideDecimal_12_3: a balance beyond the
// contract's `Quantity` range could not be put on the wire, so storing it would
// create a row the contract cannot describe.
func TestStockStore_TheDatabaseRefusesABalanceOutsideDecimal_12_3(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 121, "ของเยอะ", "kg")

	_, err := pool.Exec(context.Background(), `
		INSERT INTO stock_balances (inventory_item_id, branch_id, on_hand_milli)
		VALUES ($1, $2, 1000000000000)`, item.ID, testBranch)
	if err == nil {
		t.Fatal("the database accepted a balance of 1,000,000,000.000, outside decimal(12,3); " +
			"it could not be represented on the wire and money.maxQuantityMilli would refuse it")
	}
}

// TestStockStore_OneVariantMapsToAtMostOneArticlePerBranch: the lookup a deduction
// performs must have exactly one answer.
//
// Two articles claiming the same variant would make it ambiguous, and an ambiguous
// deduction silently picks a shelf — the shop believes it has flour when the empty
// one is flour.
func TestStockStore_OneVariantMapsToAtMostOneArticlePerBranch(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	variant := uid(130)

	// The FIRST article must be accepted — it is the only one, and the unique index
	// must not refuse a lone row. Asserting that explicitly is what stops this test
	// from passing for the wrong reason (a broken index that refuses everything).
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO inventory_items (id, branch_id, product_variant_id, name_th, unit, track_stock, is_raw)
		VALUES ($1, $2, $3, 'ของ', 'pcs', true, false)`,
		uid(131), testBranch, variant); err != nil {
		t.Fatalf("the first article for a variant was refused: %v", err)
	}

	// The SECOND must not be.
	_, err := pool.Exec(context.Background(), `
		INSERT INTO inventory_items (id, branch_id, product_variant_id, name_th, unit, track_stock, is_raw)
		VALUES ($1, $2, $3, 'ของซ้ำ', 'pcs', true, false)`,
		uid(132), testBranch, variant)
	if err == nil {
		t.Fatal("the database accepted a second article for the same variant; the deduction's lookup " +
			"would be ambiguous and could silently deduct the wrong shelf")
	}
	if !strings.Contains(err.Error(), "idx_inventory_items_variant") {
		t.Errorf("the failure does not name the index that refused it; got: %v", err)
	}
	if n := countRows(t, pool,
		`SELECT count(*) FROM inventory_items WHERE product_variant_id = $1`, variant); n != 1 {
		t.Errorf("%d articles exist for the variant, want 1", n)
	}
}

// TestStockStore_AStillReportsTheWarningOnARetry is a REGRESSION test for a defect
// this suite caught, and the reasoning is kept because the fix is easy to
// "simplify" away again.
//
// The bug: ApplyDeductions returned balances only for the articles it had just
// APPENDED a movement for. On a retry nothing is appended, so it returned nothing, so
// the interactor produced no warning. The oversold article warned on the first attempt
// and silently did not warn on the second — and the second response is the one the
// terminal keeps, because that is the one that arrived.
//
// So retrying, which is the SAFEST thing a terminal can do, was the thing that lost
// the operator's warning. A café overselling flour would see the alert once and then
// never again. The fix is that every article a sale CONSUMED gets its balance
// reported, whether or not this particular attempt was the one that moved it.
func TestStockStore_AStillReportsTheWarningOnARetry(t *testing.T) {
	pool := testPool(t)
	seedBranch(t, pool)
	item := seedItem(t, pool, testItem, 122, "ผงกาแฟ", "kg")

	for attempt := 0; attempt < 3; attempt++ {
		warnings := deductOne(t, pool, item, 390, "0.750")
		if len(warnings) != 1 {
			t.Fatalf("attempt %d produced %d warnings, want 1; a retry must report the same "+
				"shortage as the original, or the operator is warned once and then never again",
				attempt, len(warnings))
		}
		if got := warnings[0].OnHandMilli; got != -750 {
			t.Errorf("attempt %d warns at %d milli-units, want -750", attempt, got)
		}
	}

	// And the balance must not have drifted across the retries.
	balance, err := inventorypostgres.NewStockStore(pool).Balance(context.Background(), item.ID)
	if err != nil {
		t.Fatalf("reading the balance: %v", err)
	}
	if got := balance.OnHand.Milli(); got != -750 {
		t.Errorf("after three attempts the balance is %d milli-units, want -750", got)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM stock_movements`); n != 1 {
		t.Errorf("%d movements recorded after three identical attempts, want 1", n)
	}
}
