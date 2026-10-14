// Package memory holds in-memory implementations of the order module's ports.
//
// ── WHY THIS EXISTS, AND WHY IT IS NOT THE PRODUCTION STORE ───────────────────
//
// The Postgres driver in `internal/order/adapter/postgres` is a documented
// skeleton returning `ErrNotImplemented`, because `sqlc` is HELD
// (SKILL.md §3.2/§3.4) and `db/migrations/` is empty. There is no schema to
// generate against and no driver to generate it with: Go's standard library
// contains NO PostgreSQL driver, so a working `database/sql` implementation would
// require adding a dependency, which this service is not permitted to do.
//
// So the success path of the sync drain — the part that has to be PROVEN, because
// it is where duplicate orders and mispriced sales would be created — has no
// executable coverage against a real database, and that is a genuine gap rather
// than a stylistic one.
//
// These implementations close it as far as is possible without a database. They
// are a REFERENCE implementation of the ports: they hold the real invariants (a
// duplicate primary key is refused, a live idempotency record is never
// overwritten), so a test that passes here is testing the same rules the Postgres
// driver will have to enforce.
//
// They are deliberately NOT wired into `cmd/api` as the default. A server that
// accepted real sales into a map and lost them on restart is worse than one that
// answers 500, so the composition root refuses instead.
//
// Thread safety: every method takes the mutex, because the HTTP server serves
// requests concurrently and a test that exercised these ports from two goroutines
// would otherwise be testing a race rather than the rules.
package memory

import (
	"context"
	"fmt"
	stdsync "sync"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
	sync "wal-asri-pos/services/api-backend/internal/sync/domain"
	syncuc "wal-asri-pos/services/api-backend/internal/sync/usecase"
)

// ─────────────────────────────────────────────────────────────────────────────
// OrderRepository
// ─────────────────────────────────────────────────────────────────────────────

// Orders is an append-only order store.
//
// Append-only in the strict sense: there is no Update and no Delete, and Append
// REFUSES a second write of the same id rather than overwriting. That refusal is
// the property that makes a retry safe even when the idempotency record is lost —
// the exact window `IngestOrder.Execute` documents.
type Orders struct {
	mu   stdsync.Mutex
	byID map[identity.UUIDv7]order.Order
	// Appends counts every accepted write, so a test can assert a duplicate did
	// not create a second order rather than inferring it from the map length.
	appends int
}

// NewOrders builds an empty store.
func NewOrders() *Orders { return &Orders{byID: make(map[identity.UUIDv7]order.Order)} }

var _ orderuc.OrderRepository = (*Orders)(nil)

// ErrDuplicateOrder is returned when an id is written twice.
//
// A distinct error rather than a generic failure, because the Postgres driver's
// `ON CONFLICT (id) DO NOTHING` plus a "did I insert?" check surfaces exactly this
// case, and the ingest path is documented as depending on it.
var ErrDuplicateOrder = fmt.Errorf("memory: the order id already exists")

func (o *Orders) Append(_ context.Context, ord order.Order) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, exists := o.byID[ord.ID]; exists {
		return fmt.Errorf("%w: order %s", ErrDuplicateOrder, ord.ID)
	}
	o.byID[ord.ID] = ord
	o.appends++
	return nil
}

// Count returns how many orders are stored.
func (o *Orders) Count() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.byID)
}

// Appends returns how many write calls were accepted. A duplicate attempt does not
// increment it.
func (o *Orders) Appends() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.appends
}

// Get returns one stored order.
func (o *Orders) Get(_ context.Context, id identity.UUIDv7) (order.Order, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o2, ok := o.byID[id]
	if !ok {
		return order.Order{}, fmt.Errorf("memory: order %s not found", id)
	}
	return o2, nil
}

// UpdateStatus transitions one stored order's status, enforcing the FROM state.
//
// The `from` parameter is the caller's expectation, and a mismatch is an error
// rather than a silent no-op: the ingest pipeline passes the status it just
// read, so a mismatch here means two workers are racing to void the same order
// and the second one must not clobber the first.
func (o *Orders) UpdateStatus(_ context.Context, id identity.UUIDv7, from, to order.OrderStatus, _ time.Time) error {
	o.mu.Lock()
	defer o.mu.Unlock()

	x, ok := o.byID[id]
	if !ok {
		return fmt.Errorf("memory: no order %s found", id)
	}
	if x.Status != from {
		return fmt.Errorf("memory: order %s has status %s, not %s", id, x.Status, from)
	}

	x.Status = to
	o.byID[id] = x
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// BranchRateSource
// ─────────────────────────────────────────────────────────────────────────────

// Rates supplies a per-branch VAT rate.
type Rates struct {
	mu       stdsync.Mutex
	byBranch map[identity.UUIDv7]money.BasisPoints
}

// NewRates builds a rate source with no branches configured.
func NewRates() *Rates {
	return &Rates{byBranch: make(map[identity.UUIDv7]money.BasisPoints)}
}

var _ orderuc.BranchRateSource = (*Rates)(nil)

// Set configures a branch's rate.
func (r *Rates) Set(branchID identity.UUIDv7, bp money.BasisPoints) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byBranch[branchID] = bp
}

// VATRateBp returns the branch's rate.
//
// An UNCONFIGURED branch is an error rather than the default 7%: silently pricing
// a branch at the standard rate when nobody has told the server what it is would
// make a misconfigured deployment produce confidently wrong tax. A loud failure
// is the only safe answer.
func (r *Rates) VATRateBp(_ context.Context, branchID identity.UUIDv7) (money.BasisPoints, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	bp, ok := r.byBranch[branchID]
	if !ok {
		return 0, fmt.Errorf("memory: no VAT rate is configured for branch %s; a branch must be rated "+
			"before its orders can be priced", branchID)
	}
	return bp, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// IdempotencyStore
// ─────────────────────────────────────────────────────────────────────────────

// Idempotency is an in-memory idempotency store.
//
// One type satisfies BOTH `orderuc.IdempotencyStore` and `syncuc.BatchIdempotency`
// because the two ports are identical in shape. Declaring them twice in two
// application layers would be duplication for its own sake; the rule that matters
// is that the ports are DECLARED in the application layers and IMPLEMENTED in an
// adapter, which holds.
//
// It reproduces the two constraints the Postgres driver's documentation calls
// load-bearing:
//
//   - Save REFUSES to overwrite a live record, so a concurrent Save cannot replace
//     the first outcome every later replay depends on.
//   - Lookup treats an expired record as absent, so the store does not grow
//     without bound and a key reused long ago is not refused as a duplicate of a
//     dead sale.
type Idempotency struct {
	mu    stdsync.Mutex
	byKey map[sync.IdempotencyKey]sync.IdempotencyRecord
	now   func() time.Time
	// SaveConflict is returned when a live record already exists, standing in for
	// the `ON CONFLICT (key_hash) DO NOTHING` the driver documents.
	SaveConflict error
}

// NewIdempotency builds an empty store.
func NewIdempotency(now func() time.Time) *Idempotency {
	if now == nil {
		now = time.Now
	}
	return &Idempotency{
		byKey:        make(map[sync.IdempotencyKey]sync.IdempotencyRecord),
		now:          now,
		SaveConflict: fmt.Errorf("memory: a live idempotency record already exists for this key"),
	}
}

var (
	_ orderuc.IdempotencyStore = (*Idempotency)(nil)
	_ syncuc.BatchIdempotency  = (*Idempotency)(nil)
)

func (i *Idempotency) Lookup(_ context.Context, key sync.IdempotencyKey) (*sync.IdempotencyRecord, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	rec, ok := i.byKey[key]
	if !ok {
		return nil, nil
	}
	if rec.IsExpiredAt(i.now().UTC()) {
		// Expired behaves as absent. Returning it would make `Decide` see a live
		// record and replay a response for a sale that is outside every window.
		return nil, nil
	}
	copied := rec
	return &copied, nil
}

func (i *Idempotency) Save(_ context.Context, rec sync.IdempotencyRecord) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if existing, ok := i.byKey[rec.Key]; ok && !existing.IsExpiredAt(i.now().UTC()) {
		return i.SaveConflict
	}
	i.byKey[rec.Key] = rec
	return nil
}

// Len returns how many records are stored, expired ones included.
func (i *Idempotency) Len() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return len(i.byKey)
}

// ─────────────────────────────────────────────────────────────────────────────
// OutboxLedger
// ─────────────────────────────────────────────────────────────────────────────

// Outbox is an in-memory server-side ledger.
type Outbox struct {
	mu    stdsync.Mutex
	items map[identity.UUIDv7]sync.SyncOutboxItem
	order []identity.UUIDv7
}

// NewOutbox builds an empty ledger.
func NewOutbox() *Outbox { return &Outbox{items: make(map[identity.UUIDv7]sync.SyncOutboxItem)} }

var _ orderuc.OutboxLedger = (*Outbox)(nil)

func (o *Outbox) Append(_ context.Context, item sync.SyncOutboxItem) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := item.Validate(); err != nil {
		return err
	}
	if _, exists := o.items[item.ID]; exists {
		return fmt.Errorf("memory: outbox item %s already exists", item.ID)
	}
	o.items[item.ID] = item
	o.order = append(o.order, item.ID)
	return nil
}

func (o *Outbox) TransitionTo(_ context.Context, id identity.UUIDv7, to sync.OutboxState, at time.Time) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	item, ok := o.items[id]
	if !ok {
		return fmt.Errorf("memory: no outbox item %s", id)
	}
	moved, err := item.TransitionTo(to, at)
	if err != nil {
		return err
	}
	o.items[id] = moved
	return nil
}

// Get returns one ledger item.
func (o *Outbox) Get(id identity.UUIDv7) (sync.SyncOutboxItem, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	it, ok := o.items[id]
	return it, ok
}

// Count returns how many items are stored.
func (o *Outbox) Count() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.items)
}

// ─────────────────────────────────────────────────────────────────────────────
// StockLedger
// ─────────────────────────────────────────────────────────────────────────────

// Stock is an in-memory stock ledger.
//
// It reproduces the two rules the Postgres inventory adapter enforces and that the
// rest of the service depends on:
//
//   - A LINE DEDUCTS AT MOST ONCE, keyed by its order line id. Re-presenting the
//     same sale is a retry (a terminal cannot tell a lost response from a crash, so
//     it sends the same batch as a matter of course) and must not deduct twice.
//   - A NEGATIVE BALANCE COMMITS. There is no `>= 0` guard here, for the same
//     reason the schema has none: an offline oversell already happened, and the one
//     fact an operator needs is the shortage itself.
//
// And the policy rule above them: insufficient stock is NOT an error. A shortage
// produces a warning and the deduction succeeds.
type Stock struct {
	mu stdsync.Mutex
	// byItem is the current balance per inventory item, in milli-units.
	byItem map[identity.UUIDv7]int64
	// deductedLines records which order lines have been consumed, so a retry is a
	// no-op. This is the in-memory equivalent of the ledger's PRIMARY KEY.
	deductedLines map[identity.UUIDv7]bool

	// sales records every sale this ledger was asked to consume, so a test can
	// assert what the ingest pipeline actually sent.
	sales []orderuc.SaleStock
	// failWith makes every deduction fail, standing in for an unreachable database.
	failWith error
	// oversold names items that should report a warning, standing in for a shelf
	// that has genuinely run out.
	warnings []orderuc.StockWarning
}

var _ orderuc.StockLedger = (*Stock)(nil)

// NewStock builds an empty ledger.
func NewStock() *Stock {
	return &Stock{
		byItem:        make(map[identity.UUIDv7]int64),
		deductedLines: make(map[identity.UUIDv7]bool),
	}
}

// SetBalance seeds an article's balance, in milli-units.
//
// Seeds a figure directly rather than through a movement, which the real ledger
// cannot do. That is fine for a fixture: this type exists so the ingest pipeline
// can be exercised end-to-end without a database, not to model the ledger.
func (s *Stock) SetBalance(itemID identity.UUIDv7, milliUnits int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byItem[itemID] = milliUnits
}

// BalanceMilli returns an article's current balance.
func (s *Stock) BalanceMilli(itemID identity.UUIDv7) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byItem[itemID]
}

// OversoldOn makes every subsequent deduction report these warnings.
//
// A shortcut rather than a simulation: the real warnings come from comparing
// committed balances against zero, and a test asserting the ingest pipeline
// REPORTS a warning does not need the inventory module to re-derive it.
func (s *Stock) OversoldOn(warnings ...orderuc.StockWarning) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.warnings = warnings
}

// FailWith makes every deduction return this error.
func (s *Stock) FailWith(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failWith = err
}

// Sales returns every sale the ledger was asked to consume.
func (s *Stock) Sales() []orderuc.SaleStock {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]orderuc.SaleStock(nil), s.sales...)
}

// Calls returns how many deductions were attempted.
func (s *Stock) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sales)
}

// DeductForSale consumes stock for one accepted order.
//
// DEDUCTS NOTHING when the sale has no lines, and opens no work when every line has
// already been consumed — matching the real adapter's shape, so a test that passes
// here is exercising the same call pattern the driver will.
func (s *Stock) DeductForSale(ctx context.Context, sale orderuc.SaleStock) ([]orderuc.StockWarning, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sales = append(s.sales, sale)
	if s.failWith != nil {
		return nil, s.failWith
	}

	for _, line := range sale.Lines {
		// The retry guard. See the type's note.
		if s.deductedLines[line.OrderLineID] {
			continue
		}
		s.deductedLines[line.OrderLineID] = true
		s.byItem[line.ProductVariantID] -= line.Quantity.Milli()
		if s.byItem[line.ProductVariantID] < 0 {
			s.warnings = append(s.warnings, orderuc.StockWarning{InventoryItemID: line.ProductVariantID, OnHandMilli: s.byItem[line.ProductVariantID]})
		}
	}

	return append([]orderuc.StockWarning(nil), s.warnings...), nil
}

// ReverseForVoid credits stock back for an order being voided.
//
// The reversal is NOT idempotent on the order line id the way DeductForSale is,
// because a void is a deliberate operator action that the terminal sends once
// with its own idempotency key — the ingest pipeline's idempotency store covers
// it. The movement itself has no primary key here; the real ledger keys it on
// (order_id, direction) so a retry of the void command is a no-op at the store.
func (s *Stock) ReverseForVoid(ctx context.Context, sale orderuc.SaleStock) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failWith != nil {
		return s.failWith
	}

	for _, l := range sale.Lines {
		s.byItem[l.ProductVariantID] += l.Quantity.Milli()
	}
	return nil
}
