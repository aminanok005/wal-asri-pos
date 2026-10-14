package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
	sync "wal-asri-pos/services/api-backend/internal/sync/domain"
)

var now = time.Date(2026, 10, 2, 9, 15, 0, 0, time.UTC)

func uid(n int) identity.UUIDv7 {
	u, err := identity.ParseUUIDv7(uuidFor(now.Add(time.Duration(n) * time.Millisecond)))
	if err != nil {
		panic("bad test fixture: " + err.Error())
	}
	return u
}

func uuidFor(ts time.Time) string {
	ms := uint64(ts.UTC().UnixMilli())
	return fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff)
}

// ── fakes ────────────────────────────────────────────────────────────────────

type fakeOrders struct {
	appended []order.Order
	err      error
}

func (f *fakeOrders) Append(_ context.Context, o order.Order) error {
	if f.err != nil {
		return f.err
	}
	for _, existing := range f.appended {
		if existing.ID.Compare(o.ID) == 0 {
			return fmt.Errorf("order %s already exists; append-only", o.ID)
		}
	}
	f.appended = append(f.appended, o)
	return nil
}

func (f *fakeOrders) Get(_ context.Context, id identity.UUIDv7) (order.Order, error) {
	for _, o := range f.appended {
		if o.ID.Compare(id) == 0 {
			return o, nil
		}
	}
	return order.Order{}, fmt.Errorf("order %s not found", id)
}

func (f *fakeOrders) UpdateStatus(_ context.Context, id identity.UUIDv7, _, to order.OrderStatus, _ time.Time) error {
	for i, o := range f.appended {
		if o.ID.Compare(id) == 0 {
			f.appended[i].Status = to
			return nil
		}
	}
	return fmt.Errorf("order %s not found", id)
}

type fakeRates struct {
	bp    money.BasisPoints
	err   error
	calls int
}

func (f *fakeRates) VATRateBp(_ context.Context, _ identity.UUIDv7) (money.BasisPoints, error) {
	f.calls++
	return f.bp, f.err
}

type fakeIdem struct {
	records map[string]sync.IdempotencyRecord
	saveErr error
}

func newFakeIdem() *fakeIdem {
	return &fakeIdem{records: map[string]sync.IdempotencyRecord{}}
}

func (f *fakeIdem) Lookup(_ context.Context, k sync.IdempotencyKey) (*sync.IdempotencyRecord, error) {
	rec, ok := f.records[string(k)]
	if !ok {
		return nil, nil
	}
	return &rec, nil
}

func (f *fakeIdem) Save(_ context.Context, rec sync.IdempotencyRecord) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.records[string(rec.Key)] = rec
	return nil
}

type fakeOutbox struct {
	items    []sync.SyncOutboxItem
	transits []sync.OutboxState
}

func (f *fakeOutbox) Append(_ context.Context, it sync.SyncOutboxItem) error {
	f.items = append(f.items, it)
	return nil
}

func (f *fakeOutbox) TransitionTo(_ context.Context, _ identity.UUIDv7, to sync.OutboxState, _ time.Time) error {
	f.transits = append(f.transits, to)
	return nil
}

// fakeStock records what the deduction was asked to consume.
//
// It exists because StockLedger is a REQUIRED port, and a required port makes every
// existing test a test of a pipeline with a nil hole in it. That is the trade the
// port makes deliberately: a nil ledger panics at the call site instead of
// silently skipping stock, and the panic is a louder failure than a shelf that
// quietly drifts.
//
// By default it records the sale and returns NO warnings, which is the normal case
// and keeps every pre-existing test's expectations untouched.
type fakeStock struct {
	sales    []SaleStock
	calls    int
	warnings []StockWarning
	err      error
}

func (f *fakeStock) DeductForSale(_ context.Context, sale SaleStock) ([]StockWarning, error) {
	f.calls++
	f.sales = append(f.sales, sale)
	if f.err != nil {
		return nil, f.err
	}
	return f.warnings, nil
}

func (f *fakeStock) ReverseForVoid(_ context.Context, _ SaleStock) error {
	return f.err
}

var _ StockLedger = (*fakeStock)(nil)

// ── fixtures ─────────────────────────────────────────────────────────────────

// terminalOrder builds a ฿45.50 takeaway exactly as a terminal would send it,
// priced at rateBp.
func terminalOrder(rateBp money.BasisPoints, n int) order.Order {
	branch := uid(1)
	line := order.OrderLine{
		ID:               uid(n),
		OrderID:          uid(n + 1),
		ProductVariantID: uid(n + 2),
		Quantity:         money.MustParseQuantity("1"),
		UnitPriceSatang:  money.MustSatang(4550),
		LineTotalSatang:  money.MustSatang(4550),
		Sequence:         1,
		CreatedAt:        now,
	}
	o, err := order.NewOrder(uid(n+1), branch, uid(n+3), order.OrderTypeTakeaway,
		order.OrderSourcePosDesktop, []order.OrderLine{line}, 0, 0, 0, rateBp, now)
	if err != nil {
		panic("bad order fixture: " + err.Error())
	}
	return o
}

func newIngest(repo *fakeOrders, rates *fakeRates, idem *fakeIdem, out *fakeOutbox) *IngestOrder {
	return newIngestWithStock(repo, rates, idem, out, &fakeStock{})
}

// newIngestWithStock is the constructor for tests that need to inspect or fail the
// stock deduction. Every other test goes through newIngest so the default fake is
// the one under test, not an accident of each call site.
func newIngestWithStock(
	repo *fakeOrders, rates *fakeRates, idem *fakeIdem, out *fakeOutbox, stock StockLedger,
) *IngestOrder {
	return NewIngestOrder(IngestOrderDeps{
		Orders: repo, Rates: rates, Idem: idem, Outbox: out, Stock: stock,
		Now: func() time.Time { return now },
	})
}

// ─────────────────────────────────────────────────────────────────────────────

func TestIngestOrder_AcceptsAWellFormedOrder(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	i := newIngest(repo, rates, idem, out)

	res, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-1",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 100),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.State != sync.StateAcknowledged {
		t.Errorf("state = %s, want ACKNOWLEDGED", res.State)
	}
	if res.Totals.TotalSatang != 4550 {
		t.Errorf("total = %d satang, want 4550 (฿45.50)", res.Totals.TotalSatang)
	}
	if res.Totals.TaxSatang() != 298 {
		t.Errorf("tax = %d satang, want 298 (฿2.98)", res.Totals.TaxSatang())
	}
	if len(repo.appended) != 1 {
		t.Errorf("appended %d orders, want 1", len(repo.appended))
	}
	if len(idem.records) != 1 {
		t.Errorf("stored %d idempotency records, want 1", len(idem.records))
	}
	if res.Response == "" {
		t.Error("the stored response must not be empty; it is replayed verbatim on a duplicate")
	}
	// The rate must be read from the branch, never taken from the request.
	if rates.calls == 0 {
		t.Error("the branch's own VAT rate was never read")
	}
}

// TestIngestOrder_TheStoredResponseUsesStringSatang pins the wire form of the
// bytes this usecase persists.
//
// Those bytes are the whole record of what the server decided, and they are
// replayed verbatim on a duplicate for 24 hours. contracts/openapi.yaml types
// `Satang` as `type: string` with pattern `^(0|[1-9][0-9]*)$`, so a bare integer
// here means a retry hands the terminal a differently-shaped money field than the
// original response did — which surfaces as a customer's total, not as a parse
// error at the point of disagreement.
func TestIngestOrder_TheStoredResponseUsesStringSatang(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	i := newIngest(repo, rates, idem, out)

	res, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-1",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 100),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for _, want := range []string{`"total_satang":"4550"`, `"taxable_satang":"4252"`, `"tax_satang":"298"`} {
		if !strings.Contains(res.Response, want) {
			t.Errorf("the stored response is missing %s; got: %s", want, res.Response)
		}
	}
	for _, forbidden := range []string{`"total_satang":4550`, `"taxable_satang":4252`, `"tax_satang":298`} {
		if strings.Contains(res.Response, forbidden) {
			t.Errorf("a bare JSON number leaked into a Satang field (%s); got: %s", forbidden, res.Response)
		}
	}
}

func TestIngestOrder_AStaleTerminalRateIsHeldNotCorrected(t *testing.T) {
	// The realistic failure: a terminal last synced before the branch changed VAT
	// rate. The sale really happened and the customer really paid, so dropping it
	// loses money — but silently correcting it produces a receipt that disagrees
	// with the ledger. It is HELD.
	repo := &fakeOrders{}
	rates := &fakeRates{bp: 1000} // the branch is now at 10%
	idem, out := newFakeIdem(), &fakeOutbox{}
	i := newIngest(repo, rates, idem, out)

	res, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-stale",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 200), // terminal still prices at 7%
	})
	if err != nil {
		t.Fatalf("a held order is not an error; it is a state: %v", err)
	}

	if res.State != sync.StateConflictHeld {
		t.Fatalf("state = %s, want CONFLICT_HELD", res.State)
	}
	if len(repo.appended) != 1 {
		t.Errorf("a held order must still be STORED — the money is real; appended %d", len(repo.appended))
	}
	if len(out.items) != 1 || out.items[0].State != sync.StateConflictHeld {
		t.Errorf("the outbox item should record CONFLICT_HELD: %+v", out.items)
	}
	if out.items[0].LastError == "" {
		t.Error("a held item must say WHY it was held; an operator cannot triage a bare state")
	}
	// The hold reason must carry the branch's rate and BOTH sets of figures. It
	// cannot name the rate the terminal used, because the server never learns it —
	// the terminal sends figures, not a rate. Stating the figures is what lets an
	// operator work out what happened.
	reason := out.items[0].LastError
	for _, want := range []string{"1000 bp", "tax 298", "tax 414", "held for review"} {
		if !strings.Contains(reason, want) {
			t.Errorf("the hold reason should mention %q, got %q", want, reason)
		}
	}
	// The server's figures are authoritative even though the order is held.
	if res.Totals.TotalSatang != 4550 {
		t.Errorf("total = %d, want the authoritative 4550", res.Totals.TotalSatang)
	}
	if res.Totals.TaxSatang() != 414 {
		t.Errorf("tax at 10%% = %d satang, want 414", res.Totals.TaxSatang())
	}
}

func TestIngestOrder_ADuplicateReplaysTheOriginalResponseAndDoesNotReprocess(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	i := newIngest(repo, rates, idem, out)

	req := IngestRequest{
		IdempotencyKey: "order-key-dup",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 300),
	}

	first, err := i.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("the first submission failed: %v", err)
	}
	callsAfterFirst := rates.calls

	second, err := i.Execute(context.Background(), req)
	if !errors.Is(err, ErrDuplicateSubmission) {
		t.Fatalf("the second submission returned %v, want ErrDuplicateSubmission", err)
	}
	if second.Response != first.Response {
		t.Errorf("the replay returned a different response:\n first: %s\nsecond: %s", first.Response, second.Response)
	}
	if len(repo.appended) != 1 {
		t.Fatalf("a duplicate created %d orders; exactly one must exist", len(repo.appended))
	}
	if rates.calls != callsAfterFirst {
		t.Errorf("a duplicate re-read the branch rate (%d -> %d); the stored response must be "+
			"replayed without re-running any business logic", callsAfterFirst, rates.calls)
	}
	if len(out.items) != 1 {
		t.Errorf("a duplicate appended a second outbox item: %d", len(out.items))
	}
}

// TestIngestOrder_ADuplicateIsNotAnErrorTheTerminalShouldRetry is the point of
// the whole mechanism: the terminal cannot distinguish a lost response from a
// crash, so it retries, and that retry must be a successful no-op.
func TestIngestOrder_ADuplicateIsNotAnErrorTheTerminalShouldRetry(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	i := newIngest(repo, rates, idem, out)
	req := IngestRequest{IdempotencyKey: "k", TerminalID: uid(9), Order: terminalOrder(700, 400)}

	if _, err := i.Execute(context.Background(), req); err != nil {
		t.Fatalf("first submission failed: %v", err)
	}

	res, err := i.Execute(context.Background(), req)
	if !errors.Is(err, ErrDuplicateSubmission) {
		t.Fatalf("want ErrDuplicateSubmission so the adapter can answer 200 with the stored body")
	}
	if res.OrderID != uid(401) {
		t.Errorf("the replay must point at the ORIGINAL order, got %s", res.OrderID)
	}
	if len(repo.appended) != 1 {
		t.Error("exactly one order must exist after a duplicate")
	}
}

func TestIngestOrder_AnExpiredKeyDoesNotBlockANewSale(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	i := newIngest(repo, rates, idem, out)

	// Seed a record that expired an hour ago.
	key, err := sync.DeriveIdempotencyKey(uid(1).String(), "reused-key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	old, err := sync.NewIdempotencyRecord(key, uid(500), sync.StateAcknowledged, "{}", now.Add(-25*time.Hour))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	idem.records[string(key)] = old

	res, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "reused-key", TerminalID: uid(9), Order: terminalOrder(700, 600),
	})
	if err != nil {
		t.Fatalf("a key older than the window must not refuse a genuine new sale: %v", err)
	}
	if res.State != sync.StateAcknowledged {
		t.Errorf("state = %s, want ACKNOWLEDGED", res.State)
	}
	if len(repo.appended) != 1 {
		t.Errorf("appended %d orders, want 1", len(repo.appended))
	}
}

func TestIngestOrder_RefusesAMissingIdempotencyKey(t *testing.T) {
	// A missing key can never become present by retrying, so this is a validation
	// failure rather than a transient one.
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	i := newIngest(repo, rates, idem, out)

	_, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "", TerminalID: uid(9), Order: terminalOrder(700, 700),
	})
	if err == nil {
		t.Fatal("a submission with no idempotency key must be refused")
	}
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Errorf("error type is %T, want *ValidationError so the adapter can answer 400", err)
	}
	if !errors.Is(err, ErrValidationFailed) {
		t.Error("the error must unwrap to ErrValidationFailed")
	}
	if len(repo.appended) != 0 {
		t.Error("nothing may be appended when the key is missing")
	}
}

func TestIngestOrder_RefusesAnOrderWhoseLinesDoNotPrice(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	i := newIngest(repo, rates, idem, out)

	bad := terminalOrder(700, 800)
	bad.Lines[0].LineTotalSatang = money.MustSatang(9999) // does not equal quantity x price

	_, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "k-bad-line", TerminalID: uid(9), Order: bad,
	})
	if err == nil {
		t.Fatal("a tampered line total must be refused on ingest")
	}
	if len(repo.appended) != 0 {
		t.Error("a submission that fails validation must not be stored")
	}
}

// TestIngestOrder_AFailedIdempotencySaveReportsThatTheOrderIsCommitted matters
// because the operator's first question will be "did the sale land?".
func TestIngestOrder_AFailedIdempotencySaveReportsThatTheOrderIsCommitted(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	idem.saveErr = errors.New("connection reset")
	i := newIngest(repo, rates, idem, out)

	_, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "k-save-fail", TerminalID: uid(9), Order: terminalOrder(700, 900),
	})
	if err == nil {
		t.Fatal("a failed idempotency save must be reported")
	}
	if len(repo.appended) != 1 {
		t.Error("the order should still be committed — the failure is in the bookkeeping, not the sale")
	}
	msg := err.Error()
	if !strings.Contains(msg, "committed") || !strings.Contains(msg, "duplicate primary key") {
		t.Errorf("the error must state that the order committed and what happens on retry, got %q", msg)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The stock deduction on the acknowledgement path
// ─────────────────────────────────────────────────────────────────────────────
//
// These pin the four properties that make the deduction trustworthy rather than
// merely present: it happens, it happens at the right moment, it happens for the
// lines that actually arrived, and it does NOT happen for an order that was held.

// TestIngestOrder_DeductsTheLinesThatActuallyArrived is the mapping assertion.
//
// The deduction is driven by the order's OWN lines — the quantities the terminal
// priced with and the server already re-validated — rather than by a header field
// or a re-derivation. Getting the line id or the variant id wrong here would deduct
// the right quantity from the wrong shelf, which no test of the inventory module
// alone could catch.
func TestIngestOrder_DeductsTheLinesThatActuallyArrived(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	stock := &fakeStock{}
	i := newIngestWithStock(repo, rates, idem, out, stock)

	sent := terminalOrder(700, 100)
	res, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-1",
		TerminalID:     uid(9),
		Order:          sent,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if stock.calls != 1 {
		t.Fatalf("the stock ledger was called %d times, want 1", stock.calls)
	}
	sale := stock.sales[0]
	if len(sale.Lines) != 1 {
		t.Fatalf("deducted %d lines, want 1", len(sale.Lines))
	}

	line := sale.Lines[0]
	if line.OrderLineID.Compare(sent.Lines[0].ID) != 0 {
		t.Errorf("deducted order line %s, want %s", line.OrderLineID, sent.Lines[0].ID)
	}
	if line.ProductVariantID.Compare(sent.Lines[0].ProductVariantID) != 0 {
		t.Errorf("deducted variant %s, want %s", line.ProductVariantID, sent.Lines[0].ProductVariantID)
	}
	if line.Quantity.Milli() != sent.Lines[0].Quantity.Milli() {
		t.Errorf("deducted quantity %d milli-units, want %d",
			line.Quantity.Milli(), sent.Lines[0].Quantity.Milli())
	}
	if sale.BranchID.Compare(sent.BranchID) != 0 {
		t.Errorf("deducted against branch %s, want %s", sale.BranchID, sent.BranchID)
	}
	if sale.OrderID.Compare(res.OrderID) != 0 {
		t.Errorf("the deduction names order %s, want %s", sale.OrderID, res.OrderID)
	}
}

// TestIngestOrder_DeductsAfterTheOrderIsCommittedAndBeforeTheAcknowledgement is
// the ordering claim, and it is the load-bearing one.
//
// The order must be durable before stock moves, and the acknowledgement must be
// the LAST thing written. A terminal that receives a 200 clears its outbox row and
// never sends that sale again — so an ACK is a promise that the sale is fully
// recorded, and this test exists because that promise is only true if the
// deduction precedes the idempotency record that produces the replayed response.
func TestIngestOrder_DeductsAfterTheOrderIsCommittedAndBeforeTheAcknowledgement(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	stock := &fakeStock{}

	// Record the order count at the moment the deduction runs, so the assertion is
	// about ORDER not of sequence of calls.
	ordersAtDeduction := -1
	recordsAtDeduction := -1
	inner := &orderingStock{inner: stock}
	inner.onDeduct = func() {
		ordersAtDeduction = len(repo.appended)
		recordsAtDeduction = len(idem.records)
	}
	i := newIngestWithStock(repo, rates, idem, out, inner)

	if _, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-1",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 100),
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if ordersAtDeduction != 1 {
		t.Errorf("the order had been appended %d times when stock was deducted, want 1; stock must "+
			"never move for an order that is not yet durable", ordersAtDeduction)
	}
	if recordsAtDeduction != 0 {
		t.Errorf("%d idempotency records existed when stock was deducted, want 0; the record is what "+
			"makes the acknowledgement replayable, so it must be written AFTER the deduction "+
			"commits — otherwise a crash here acknowledges a sale whose stock never moved",
			recordsAtDeduction)
	}
}

// orderingStock is a fakeStock that reports what was true at deduction time.
type orderingStock struct {
	inner    *fakeStock
	onDeduct func()
}

func (s *orderingStock) DeductForSale(ctx context.Context, sale SaleStock) ([]StockWarning, error) {
	if s.onDeduct != nil {
		s.onDeduct()
	}
	return s.inner.DeductForSale(ctx, sale)
}

func (s *orderingStock) ReverseForVoid(ctx context.Context, sale SaleStock) error {
	return s.inner.ReverseForVoid(ctx, sale)
}

// TestIngestOrder_AFailedDeductionFailsTheSubmission is the promise this whole
// arrangement protects.
//
// The order is already committed by the time stock is deducted, so the only honest
// outcome is to fail: the terminal keeps its outbox row and retries. Acknowledging
// anyway would leave a sale the server has promised is fully recorded, with its
// stock nowhere — and the shelf would drift by exactly the amount the shop sold.
func TestIngestOrder_AFailedDeductionFailsTheSubmission(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	stock := &fakeStock{err: fmt.Errorf("dial tcp 127.0.0.1:5433: connection refused")}
	i := newIngestWithStock(repo, rates, idem, out, stock)

	_, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-1",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 100),
	})
	if err == nil {
		t.Fatal("a failed stock deduction returned success; the terminal would clear its outbox row " +
			"and the stock would never be recorded")
	}

	msg := err.Error()
	if !strings.Contains(msg, "committed") {
		t.Errorf("the error must state that the order committed, so an operator knows what state the "+
			"world is in; got %q", msg)
	}
	if !strings.Contains(msg, "retry") {
		t.Errorf("the error must say what happens on retry; got %q", msg)
	}
	// And no idempotency record, because no acknowledgement may exist for it.
	if len(idem.records) != 0 {
		t.Errorf("stored %d idempotency records after a failed deduction, want 0", len(idem.records))
	}
}

// TestIngestOrder_AHeldOrderDoesNotDeductStock is the explicit `if` in
// holdForConflict, asserted so it cannot be deleted as an oversight.
//
// CONFLICT_HELD means stored and INSPECTABLE but deliberately NOT APPLIED. The
// movement ledger records facts that were applied; appending a movement for an
// order nobody has applied would make stock_movements a record of submissions
// rather than of things that happened.
//
// The consequence is that a held order's ingredients stay on the shelf — an
// UNDER-deduction, which is the safe direction to be wrong in, and visible to
// whoever reconciles the conflict.
func TestIngestOrder_AHeldOrderDoesNotDeductStock(t *testing.T) {
	repo := &fakeOrders{}
	// The branch is now at 10% while the terminal still prices at 7% — the stale
	// terminal case, which is the realistic way an order reaches holdForConflict.
	rates := &fakeRates{bp: 1000}
	idem, out, stock := newFakeIdem(), &fakeOutbox{}, &fakeStock{}
	i := newIngestWithStock(repo, rates, idem, out, stock)

	res, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-stale",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 200),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.State != sync.StateConflictHeld {
		t.Fatalf("state = %s, want CONFLICT_HELD for this fixture", res.State)
	}

	if stock.calls != 0 {
		t.Errorf("a held order called the stock ledger %d times, want 0; a held order is NOT applied, "+
			"so it consumes nothing", stock.calls)
	}
	if len(res.StockWarnings) != 0 {
		t.Errorf("a held order reported stock warnings %v, want none", res.StockWarnings)
	}
	if strings.Contains(res.Response, "stock_alerts") {
		t.Errorf("the held response carries stock_alerts; a held order deducts nothing: %s", res.Response)
	}
}

// TestIngestOrder_StockAlertsAreOmittedWhenNothingIsOversold pins the byte
// compatibility of the acknowledgement.
//
// That response is stored for 24 hours and replayed verbatim on a retry, so its
// shape is a compatibility promise rather than an implementation detail. Emitting
// `"stock_alerts":[]` on the overwhelmingly common sale would change the bytes
// every existing terminal has already parsed.
func TestIngestOrder_StockAlertsAreOmittedWhenNothingIsOversold(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	i := newIngestWithStock(repo, rates, idem, out, &fakeStock{})

	res, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-1",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 100),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if strings.Contains(res.Response, "stock_alerts") {
		t.Errorf("the response carries stock_alerts despite nothing being oversold; the field must be "+
			"omitted so the common acknowledgement stays byte-identical: %s", res.Response)
	}
	if strings.Contains(res.Response, "[]") {
		t.Errorf("the response contains an empty array; got: %s", res.Response)
	}
}

// TestIngestOrder_AWarningIsReportedNotRefused is the ratified policy at the layer
// that decides what an acknowledgement means.
//
// A sale that takes an article below zero COMMITS and is ACKNOWLEDGED, with the
// shortage reported. Refusing it would not prevent the oversell — it happened on an
// offline terminal, the customer paid and the receipt is printed — it would only
// hide the one fact an operator needs.
func TestIngestOrder_AWarningIsReportedNotRefused(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
	stock := &fakeStock{warnings: []StockWarning{{
		InventoryItemID: uid(50), NameTH: "แป้ง", Unit: "kg", OnHandMilli: -750,
	}}}
	i := newIngestWithStock(repo, rates, idem, out, stock)

	res, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-1",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 100),
	})
	if err != nil {
		t.Fatalf("an oversold sale FAILED: %v. The shortage already happened; refusing it hides it", err)
	}
	if res.State != sync.StateAcknowledged {
		t.Errorf("state = %s, want ACKNOWLEDGED; a shortage is reported, not refused", res.State)
	}
	if len(res.StockWarnings) != 1 {
		t.Fatalf("got %d stock warnings, want 1", len(res.StockWarnings))
	}
	if res.StockWarnings[0].OnHandMilli != -750 {
		t.Errorf("the warning reports %d milli-units, want -750", res.StockWarnings[0].OnHandMilli)
	}

	// And it must reach the terminal, or an operator never learns about it.
	for _, want := range []string{
		`"stock_alerts"`, `"inventory_item_id":"` + uid(50).String() + `"`,
		`"on_hand_milli":-750`, `"unit":"kg"`,
	} {
		if !strings.Contains(res.Response, want) {
			t.Errorf("the acknowledgement is missing %s; got: %s", want, res.Response)
		}
	}
}

// TestIngestOrder_StockAlertsAreValidJSON guards the hand-rolled renderer.
//
// `renderAcknowledged` builds JSON by hand rather than through encoding/json, so a
// Thai product name containing a quote would otherwise produce a stored response
// that no client can parse — and that response is replayed verbatim for 24 hours.
func TestIngestOrder_StockAlertsAreValidJSON(t *testing.T) {
	for _, name := range []string{
		`plain`, `has "quotes"`, `back\slash`, "tab\there", "new\nline", `แป้ง`,
	} {
		repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}
		stock := &fakeStock{warnings: []StockWarning{{
			InventoryItemID: uid(50), NameTH: name, Unit: "kg", OnHandMilli: -1,
		}}}
		i := newIngestWithStock(repo, rates, idem, out, stock)

		res, err := i.Execute(context.Background(), IngestRequest{
			IdempotencyKey: "order-key-1",
			TerminalID:     uid(9),
			Order:          terminalOrder(700, 100),
		})
		if err != nil {
			t.Fatalf("name %q: unexpected error: %v", name, err)
		}
		if !json.Valid([]byte(res.Response)) {
			t.Errorf("name %q produced invalid JSON: %s", name, res.Response)
		}
	}
}

// TestIngestOrder_AnUnwiredStockLedgerIsAConfigurationErrorNotAPanic.
//
// StockLedger is a required port, and a nil one used to surface as a segfault deep
// inside deductStock. That is loud, but it points at the wrong thing: a crash at a
// line number during a shift says "the ingest path is broken", whereas the whole
// fault is one missing line in cmd/api/main.go.
//
// So the nil case is a named error that says what to do. This test exists because a
// panic-based failure is invisible to a test — the suite dies rather than reporting.
func TestIngestOrder_AnUnwiredStockLedgerIsAConfigurationErrorNotAPanic(t *testing.T) {
	repo, rates, idem, out := &fakeOrders{}, &fakeRates{bp: 700}, newFakeIdem(), &fakeOutbox{}

	// Built deliberately WITHOUT Stock, which is the mistake this guards.
	i := NewIngestOrder(IngestOrderDeps{
		Orders: repo, Rates: rates, Idem: idem, Outbox: out,
		Now: func() time.Time { return now },
	})

	_, err := i.Execute(context.Background(), IngestRequest{
		IdempotencyKey: "order-key-1",
		TerminalID:     uid(9),
		Order:          terminalOrder(700, 100),
	})
	if err == nil {
		t.Fatal("an unwired stock ledger was accepted; the order would be acknowledged with no deduction")
	}

	msg := err.Error()
	for _, want := range []string{"no stock ledger is wired", "DATABASE_URL"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the error must mention %q so the reader knows what to fix; got %q", want, msg)
		}
	}
	// No acknowledgement may exist for it.
	if len(idem.records) != 0 {
		t.Errorf("stored %d idempotency records after an unwired ledger, want 0", len(idem.records))
	}
}
