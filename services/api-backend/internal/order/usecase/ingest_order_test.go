package usecase

import (
	"context"
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
	// Mirror the repository contract: refuse a second write of the same id rather
	// than overwrite, because the id is a client-generated UUIDv7 and the order is
	// a record of a sale that happened.
	for _, existing := range f.appended {
		if existing.ID.Compare(o.ID) == 0 {
			return fmt.Errorf("order %s already exists; append-only", o.ID)
		}
	}
	f.appended = append(f.appended, o)
	return nil
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
	return NewIngestOrder(IngestOrderDeps{
		Orders: repo, Rates: rates, Idem: idem, Outbox: out,
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
