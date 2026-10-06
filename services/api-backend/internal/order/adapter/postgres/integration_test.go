//go:build integration

// Integration tests for the PostgreSQL persistence layer.
//
// ── WHY A BUILD TAG ───────────────────────────────────────────────────────────
//
// These tests need a LIVE database. A unit test that cannot run in CI is worse than
// no test, because it is a test that always passes; and a fake that reproduces the
// database's CHECK constraints is a copy of them, which is the one thing the schema
// exists to avoid. So these run only against a real server:
//
//	go test -tags integration ./internal/order/adapter/postgres/
//
// The connection string comes from WASRI_TEST_DATABASE_URL. Without it the tests
// SKIP rather than fail — a developer with no database should not be blocked, and CI
// (which has no database either, see verify.yml) should not go red on a suite it
// was never able to run.
//
// Set up with:
//
//	COMPOSE_PROJECT_NAME=wal-asri-pos sudo nerdctl --namespace walasri compose up -d postgres
//	export WASRI_TEST_DATABASE_URL='postgres://wasri_user:walasri_local_dev_pw@127.0.0.1:5433/walasri_db?sslmode=disable'
//
// NOTE THE PORT. 5433 is THIS project's. 5432 belongs to the sibling project
// `pos-walasri` and pointing these tests at it would write to someone else's
// database. See dev/DEV-SETUP.md.
package postgres_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	inventorypostgres "wal-asri-pos/services/api-backend/internal/inventory/adapter/postgres"
	inventoryuc "wal-asri-pos/services/api-backend/internal/inventory/usecase"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	orderinventory "wal-asri-pos/services/api-backend/internal/order/adapter/inventory"
	postgres "wal-asri-pos/services/api-backend/internal/order/adapter/postgres"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
	sync "wal-asri-pos/services/api-backend/internal/sync/domain"
)

// testPool opens a pool, migrates, and returns it.
//
// Each test starts from truncated tables, so the suite is re-runnable and no test
// inherits another's rows.
//
// ── THE ADVISORY LOCK, AND WHY IT IS NOT OPTIONAL ─────────────────────────────
//
// `go test` runs PACKAGES IN PARALLEL (default `-p = NumCPU`), and this suite now
// shares one database with the inventory suite at
// internal/inventory/adapter/postgres. Both truncate at the start of every test, and
// `resetTables` includes `branches ... CASCADE` — which now cascades into
// inventory_items, stock_movements and stock_balances too.
//
// So without a lock the two packages interleave: one suite truncates while the
// other is mid-assertion, and the failure is a missing row in a test that was
// correct a moment earlier. That is the worst kind of failure to debug, because it
// is intermittent and it blames the wrong test.
//
// The lock is taken on a SINGLE ACQUIRED CONNECTION for the whole test and released
// by closing it, because `pg_advisory_lock` is session-scoped and `pg_advisory_xact_lock`
// would release at COMMIT — which for a test that runs many transactions would mean
// holding it for almost none of them.
//
// ⚠️ THE KEY MUST NOT BE `postgres.Migrate`'s OWN LOCK. `testPool` calls Migrate,
// which takes its advisory lock (`migrationLockKey`) on a DIFFERENT connection of the
// same pool. Reusing that key here would make this test block waiting for a lock its
// own pool is already holding — a self-deadlock that hangs the suite rather than
// failing it. The key below is a different, stable, arbitrary constant.
const testSuiteLockKey int64 = 0x77616c62_0002 // "walb" + 2, distinct from Migrate's 0001

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
	if err := postgres.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrating: %v", err)
	}
	acquireSuiteLock(t, pool)
	resetTables(t, pool)
	return pool
}

// acquireSuiteLock takes the cross-package test lock for the duration of one test.
//
// NOT `context.Background()` with a timeout: a competing suite's test is usually
// milliseconds long, and a timeout here would turn "wait your turn" into a flaky
// failure. The lock is released when the connection closes, which `t.Cleanup` does.
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
	// Releasing rather than relying on the pool dropping the session: it makes the
	// lifetime explicit, so a reader can see the lock is held for exactly one test.
	t.Cleanup(func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, testSuiteLockKey)
		conn.Release()
	})
}

// resetTables empties every table a test writes, making the suite re-runnable.
//
// TRUNCATE, not DELETE: the schema refuses DELETE on orders and order_lines via the
// append-only triggers, and TRUNCATE correctly bypasses those row triggers.
//
// `branches ... CASCADE` reaches the inventory tables too — inventory_items,
// stock_movements and stock_balances all reference it — so this list deliberately
// does NOT name them. Adding them here would be redundant, and the comment exists so
// the next reader does not "fix" what is not broken.
func resetTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	const q = `TRUNCATE TABLE order_lines, orders, idempotency_keys, sync_outbox_items, branches
	           RESTART IDENTITY CASCADE`
	if _, err := pool.Exec(context.Background(), q); err != nil {
		t.Fatalf("truncating the transactional tables: %v", err)
	}
}

func uid(s string) identity.UUIDv7 {
	id, err := identity.ParseUUIDv7(s)
	if err != nil {
		panic("bad fixture UUID: " + s)
	}
	return id
}

// sync_outbox_items is cleared too: its insert is ON CONFLICT DO NOTHING, so a
// stale row makes the next run a SILENT no-op. schema_migrations is NOT cleared —
// that would make Migrate re-apply 0001 over existing tables.
//
// ─────────────────────────────────────────────────────────────────────────────
// Migration
// ─────────────────────────────────────────────────────────────────────────────

// TestMigrate_IsIdempotent: running the runner against an up-to-date database must
// apply nothing, or every deploy would re-run every CREATE and fail.
func TestMigrate_IsIdempotent(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	before := countRows(t, pool, `SELECT count(*) FROM schema_migrations`)
	for i := 0; i < 3; i++ {
		if err := postgres.Migrate(ctx, pool); err != nil {
			t.Fatalf("re-running Migrate: %v", err)
		}
	}
	after := countRows(t, pool, `SELECT count(*) FROM schema_migrations`)
	if before != after {
		t.Errorf("schema_migrations went from %d to %d rows; Migrate is not idempotent", before, after)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Append and Get
// ─────────────────────────────────────────────────────────────────────────────

// TestOrderRepository_RoundTripsAnOrderWithNegativeCashRounding is the test that
// matters most here, because signed rounding is the newest thing in the schema and
// the thing most likely to be quietly wrong.
//
// ฿45.53 is not payable from a drawer of coins ending in 5, so it rounds DOWN to
// ฿45.50: a -3 satang adjustment. It has to survive the round trip with its sign
// intact, because a driver that dropped or clamped it would store a receipt for a
// different amount than the customer paid.
func TestOrderRepository_RoundTripsAnOrderWithNegativeCashRounding(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := postgres.NewOrderRepository(pool)

	const (
		branch   = "018f3c2a-0000-7000-8000-0000000b0001"
		terminal = "018f3c2a-0000-7000-8000-0000000a0001"
		variant  = "018f3c2a-0000-7000-8000-0000000c0001"
		orderID  = "018f3c2a-0000-7000-8000-000000000901"
		lineID   = "018f3c2a-0000-7000-8001-000000000901"
	)
	if err := postgres.EnsureBranch(ctx, pool, uid(branch), "Siam", money.DefaultVATRateBp); err != nil {
		t.Fatalf("seeding the branch: %v", err)
	}

	now := time.Date(2026, 10, 4, 9, 0, 0, 0, time.UTC)
	o := order.Order{
		ID:         uid(orderID),
		BranchID:   uid(branch),
		TerminalID: uid(terminal),
		Type:       order.OrderTypeDineIn,
		Status:     order.StatusCompleted,
		Source:     order.OrderSourcePosDesktop,
		StatusAt:   now,
		CreatedAt:  now,
		UpdatedAt:  now,
		Lines: []order.OrderLine{{
			ID:               uid(lineID),
			OrderID:          uid(orderID),
			ProductVariantID: uid(variant),
			Quantity:         money.MustQuantityFromMilli(1000), // 1.000
			UnitPriceSatang:  4553,
			LineTotalSatang:  4553,
			CreatedAt:        now,
		}},
	}
	// Authoritative figures: gross 4553, net 4255, tax 298, rounding -3, total 4550.
	totals, err := order.ComputeTotals(4553, 0, 0, -3, money.DefaultVATRateBp)
	if err != nil {
		t.Fatalf("computing the totals: %v", err)
	}
	o.Totals = totals

	if err := repo.Append(ctx, o); err != nil {
		t.Fatalf("appending an order that rounds DOWN: %v", err)
	}

	got, err := repo.Get(ctx, uid(orderID))
	if err != nil {
		t.Fatalf("reading it back: %v", err)
	}

	if got.Totals.RoundingAdjustmentSatang != -3 {
		t.Errorf("rounding_adjustment_satang = %d, want -3 — the signed column lost its sign",
			got.Totals.RoundingAdjustmentSatang)
	}
	if got.Totals.TotalSatang != 4550 {
		t.Errorf("total_satang = %d, want 4550", got.Totals.TotalSatang)
	}
	if got.Totals.NetSatang() != 4255 || got.Totals.TaxSatang() != 298 {
		t.Errorf("net/tax = %d/%d, want 4255/298", got.Totals.NetSatang(), got.Totals.TaxSatang())
	}
	if got.Totals.GrossSatang != 4553 {
		t.Errorf("gross = %d, want 4553", got.Totals.GrossSatang)
	}
	if len(got.Lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(got.Lines))
	}
	if got.Lines[0].Quantity.String() != "1.000" {
		t.Errorf("quantity = %q, want \"1.000\" — NUMERIC(12,3) must survive the round trip exactly",
			got.Lines[0].Quantity.String())
	}

	// The whole point of the round trip: the stored order still satisfies every
	// invariant, which means the schema and the domain agree rather than merely
	// both existing.
	if err := got.Validate(); err != nil {
		t.Errorf("the order read back fails the domain's own Validate: %v", err)
	}
}

// TestOrderRepository_RefusesADuplicateID is the retry guard.
//
// A terminal cannot distinguish a lost response from a crash, so it retries the
// identical submission. The client-generated primary key is what stops that retry
// becoming a second order, which is a second charge for one latte.
func TestOrderRepository_RefusesADuplicateID(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := postgres.NewOrderRepository(pool)

	const (
		branch   = "018f3c2a-0000-7000-8000-0000000b0001"
		terminal = "018f3c2a-0000-7000-8000-0000000a0001"
		variant  = "018f3c2a-0000-7000-8000-0000000c0001"
		orderID  = "018f3c2a-0000-7000-8000-000000000902"
		lineID   = "018f3c2a-0000-7000-8001-000000000902"
	)
	if err := postgres.EnsureBranch(ctx, pool, uid(branch), "Siam", money.DefaultVATRateBp); err != nil {
		t.Fatalf("seeding the branch: %v", err)
	}

	now := time.Date(2026, 10, 4, 9, 0, 0, 0, time.UTC)
	o := order.Order{
		ID: uid(orderID), BranchID: uid(branch), TerminalID: uid(terminal),
		Type: order.OrderTypeDineIn, Status: order.StatusCompleted, Source: order.OrderSourcePosDesktop,
		StatusAt: now, CreatedAt: now, UpdatedAt: now,
		Lines: []order.OrderLine{{
			ID: uid(lineID), OrderID: uid(orderID), ProductVariantID: uid(variant),
			Quantity: money.MustQuantityFromMilli(1000), UnitPriceSatang: 4550, LineTotalSatang: 4550,
			CreatedAt: now,
		}},
	}
	o.Totals, _ = order.ComputeTotals(4550, 0, 0, 0, money.DefaultVATRateBp)

	if err := repo.Append(ctx, o); err != nil {
		t.Fatalf("first append: %v", err)
	}

	err := repo.Append(ctx, o)
	if err == nil {
		t.Fatal("a duplicate order id was accepted; a retried submission would become a second charge")
	}
	if !isDuplicate(err) {
		t.Errorf("error %v does not match ErrDuplicateOrder, so the caller cannot recognise it", err)
	}
}

// TestOrderRepository_TheDatabaseRefusesABalancedButWrongTotal proves the schema
// is not decorative.
//
// The figures below are internally consistent as a SUM (4550 = 4252 + 298) but
// violate `total = gross + service + rounding`. Only the CHECK can catch that, which
// is the argument for having it in SQL rather than only in Go.
//
// The assertion checks WHICH constraint refused it, not merely that something did.
// An earlier draft asserted only "err != nil" and passed for the wrong reason: the
// INSERT was failing on an unrelated missing column, so the test would have gone on
// green with the money CHECK doing nothing at all. A test that cannot fail for the
// reason it claims is not evidence.
func TestOrderRepository_TheDatabaseRefusesABalancedButWrongTotal(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := postgres.NewOrderRepository(pool)

	const (
		branch   = "018f3c2a-0000-7000-8000-0000000b0001"
		terminal = "018f3c2a-0000-7000-8000-0000000a0001"
		variant  = "018f3c2a-0000-7000-8000-0000000c0001"
		orderID  = "018f3c2a-0000-7000-8000-000000000903"
		lineID   = "018f3c2a-0000-7000-8001-000000000903"
	)
	if err := postgres.EnsureBranch(ctx, pool, uid(branch), "Siam", money.DefaultVATRateBp); err != nil {
		t.Fatalf("seeding the branch: %v", err)
	}

	now := time.Date(2026, 10, 4, 9, 0, 0, 0, time.UTC)
	o := order.Order{
		ID: uid(orderID), BranchID: uid(branch), TerminalID: uid(terminal),
		Type: order.OrderTypeDineIn, Status: order.StatusCompleted, Source: order.OrderSourcePosDesktop,
		StatusAt: now, CreatedAt: now, UpdatedAt: now,
		Lines: []order.OrderLine{{
			ID: uid(lineID), OrderID: uid(orderID), ProductVariantID: uid(variant),
			Quantity: money.MustQuantityFromMilli(1000), UnitPriceSatang: 4550, LineTotalSatang: 4550,
			CreatedAt: now,
		}},
	}
	// Hand-built and WRONG: subtotal 4550, discount 0, but the total claims 4000.
	// Nothing in Go objects — only the CHECK.
	o.Totals = order.Totals{
		SubtotalSatang: 4550, DiscountSatang: 0, GrossSatang: 4550,
		ServiceChargeSatang: 0, RoundingAdjustmentSatang: 0, TotalSatang: 4000,
		TaxSplit: money.TaxSplit{Gross: 4550, Net: 4252, Tax: 298, RateBp: money.DefaultVATRateBp},
	}

	err := repo.Append(ctx, o)
	if err == nil {
		t.Fatal("an order whose total does not satisfy gross+service+rounding was STORED; " +
			"the schema's CHECK is the only thing that can catch this")
	}
	// WHICH constraint refused it. Without this the test also passes when the INSERT
	// fails for any unrelated reason, which is how it came to pass on a missing
	// column while the money CHECK was untested.
	if !strings.Contains(err.Error(), "orders_total_is_gross_plus_extras") {
		t.Errorf("the insert failed for the wrong reason; expected the balance CHECK to refuse it, got: %v", err)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM orders WHERE id = $1`, uid(orderID)); got != 0 {
		t.Errorf("a refused order was stored anyway (count=%d)", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The full ingest pipeline, end to end against real Postgres
// ─────────────────────────────────────────────────────────────────────────────

// TestIngestOrder_PersistsToPostgresAndDeduplicatesOnRetry wires the REAL usecase to
// the REAL driver and pushes the same batch twice.
//
// It is the end-to-end claim this phase exists to make: an offline sale that
// survives authoritative re-validation is written to Postgres, acknowledged, and a
// retried push returns the original answer without creating a second order.
func TestIngestOrder_PersistsToPostgresAndDeduplicatesOnRetry(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	const (
		branch   = "018f3c2a-0000-7000-8000-0000000b0001"
		terminal = "018f3c2a-0000-7000-8000-0000000a0001"
		variant  = "018f3c2a-0000-7000-8000-0000000c0001"
		orderID  = "018f3c2a-0000-7000-8000-000000000904"
		lineID   = "018f3c2a-0000-7000-8001-000000000904"
		key      = "integration-order-key-1"
	)
	if err := postgres.EnsureBranch(ctx, pool, uid(branch), "Siam", money.DefaultVATRateBp); err != nil {
		t.Fatalf("seeding the branch: %v", err)
	}

	// The clock comes from the real world, NOT from a hardcoded date.
	//
	// This is the only fixture in this file whose timestamp has to stay correct as
	// wall-clock time passes, and the reason is that the idempotency record it
	// produces is filtered by the DATABASE's clock rather than this one.
	// `NewIdempotencyRecord` stamps `ExpiresAt = now + 24h`, while
	// `IdempotencyStore.Lookup` selects `WHERE key_hash = $1 AND expires_at > now()`
	// — and that `now()` is Postgres', not Go's.
	//
	// A hardcoded `now` therefore makes this test a time bomb. Measured against this
	// project's database on 2026-10-05: the row stored from a fixture pinned to
	// 2026-10-04T09:00:00Z came back with expires_at = 2026-10-05 09:00:00 while the
	// database's own now() was 2026-10-05 11:56:16 — 2h56m PAST expiry. So
	// `expires_at > now()` evaluated FALSE, the stored record was treated as absent,
	// the retry took the DecisionProceed path, Append hit the duplicate primary key,
	// and Execute returned a bare error that left `second.Response` empty next to a
	// populated `first.Response`.
	//
	// Truncated to the second only so the stored timestamps stay readable; the
	// 24-hour window is open by roughly a day no matter what the real clock reads.
	now := time.Now().UTC().Truncate(time.Second)
	orders := postgres.NewOrderRepository(pool)
	rates := postgres.NewBranchRate(pool)
	idem := postgres.NewIdempotencyStore(pool)
	outbox := postgres.NewOutboxLedger(pool)
	// The REAL inventory store, wired exactly as cmd/api/main.go wires it.
	//
	// This suite is about ORDERS, so it has no inventory_items row and the deduction
	// legitimately finds nothing to deduct — which is the correct outcome and is why
	// the assertions below are unaffected. What matters is that the port is a real
	// one: this is the end-to-end proof that a full ingest against live Postgres
	// still works with the deduction in the pipeline.
	stockStore := inventorypostgres.NewStockStore(pool)

	ingest := orderuc.NewIngestOrder(orderuc.IngestOrderDeps{
		Orders: orders, Rates: rates, Idem: idem, Outbox: outbox,
		Stock: orderinventory.NewStockLedger(inventoryuc.NewDeductSale(inventoryuc.DeductSaleDeps{
			Items: stockStore,
			Store: stockStore,
			Now:   func() time.Time { return now },
		})),
		Now: func() time.Time { return now },
	})

	o := order.Order{
		ID: uid(orderID), BranchID: uid(branch), TerminalID: uid(terminal),
		Type: order.OrderTypeDineIn, Status: order.StatusCompleted, Source: order.OrderSourcePosDesktop,
		StatusAt: now, CreatedAt: now, UpdatedAt: now,
		Lines: []order.OrderLine{{
			ID: uid(lineID), OrderID: uid(orderID), ProductVariantID: uid(variant),
			Quantity: money.MustQuantityFromMilli(1000), UnitPriceSatang: 4550, LineTotalSatang: 4550,
			CreatedAt: now,
		}},
	}
	o.Totals, _ = order.ComputeTotals(4550, 0, 0, 0, money.DefaultVATRateBp)

	req := orderuc.IngestRequest{IdempotencyKey: key, TerminalID: uid(terminal), Order: o}

	first, err := ingest.Execute(ctx, req)
	if err != nil {
		t.Fatalf("first ingest: %v", err)
	}
	if first.State != sync.StateAcknowledged {
		t.Errorf("state = %s, want ACKNOWLEDGED", first.State)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM orders WHERE id = $1`, uid(orderID)); got != 1 {
		t.Fatalf("the order is not in Postgres (count=%d)", got)
	}

	// THE RETRY. Same key, same payload: the customer must not be charged twice.
	second, err := ingest.Execute(ctx, req)
	if err == nil {
		t.Fatal("a duplicate submission succeeded instead of reporting ErrDuplicateSubmission; " +
			"the terminal would treat that as a fresh sale")
	}
	if second.Response != first.Response {
		t.Errorf("the retry returned a different response than the original:\n first: %s\nsecond: %s",
			first.Response, second.Response)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM orders WHERE id = $1`, uid(orderID)); got != 1 {
		t.Fatalf("the retry created a SECOND order (count=%d); the customer would pay twice", got)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM order_lines WHERE order_id = $1`, uid(orderID)); got != 1 {
		t.Errorf("line count = %d, want 1", got)
	}

	// And the stored figures are the SERVER's, re-derived at the branch's rate.
	stored, err := orders.Get(ctx, uid(orderID))
	if err != nil {
		t.Fatalf("reading the stored order: %v", err)
	}
	if stored.Totals.TaxSatang() != 298 {
		t.Errorf("stored tax = %d, want 298 — the server's figure must be the one persisted",
			stored.Totals.TaxSatang())
	}
}

// TestBranchRate_AnUnratedBranchIsAnErrorNotADefault: falling back to the 7%
// standard would let a misconfigured deployment file confidently wrong tax for every
// branch nobody rated.
func TestBranchRate_AnUnratedBranchIsAnErrorNotADefault(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	rates := postgres.NewBranchRate(pool)

	if _, err := rates.VATRateBp(ctx, uid("018f3c2a-0000-7000-8000-0000000b9999")); err == nil {
		t.Fatal("an unrated branch returned a rate; it must be an error so a sale cannot be priced at a default")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("counting rows with %q: %v", sql, err)
	}
	return n
}

func isDuplicate(err error) bool {
	return err != nil && errorsIs(err, postgres.ErrDuplicateOrder)
}

func errorsIs(err, target error) bool {
	for err != nil {
		if err == target {
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
