package http_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	orderhttp "wal-asri-pos/services/api-backend/internal/order/adapter/http"
	memory "wal-asri-pos/services/api-backend/internal/order/adapter/memory"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
	syncorder "wal-asri-pos/services/api-backend/internal/sync/adapter/order"
	syncuc "wal-asri-pos/services/api-backend/internal/sync/usecase"
)

// ─────────────────────────────────────────────────────────────────────────────
// The harness
// ─────────────────────────────────────────────────────────────────────────────

// world is a fully wired drain, backed by in-memory ports.
//
// Everything below the HTTP boundary is the REAL interactor. Only the four storage
// ports are in-memory, and those hold the real invariants — a duplicate primary key
// is refused, a live idempotency record is never overwritten — so a test passing
// here is testing the rules the Postgres driver must also enforce.
type world struct {
	orders *memory.Orders
	rates  *memory.Rates
	idem   *memory.Idempotency
	outbox *memory.Outbox
	mux    *http.ServeMux
	now    time.Time
}

var (
	testBranch   = mustUUID("018f3c2a-0000-7000-8000-0000000b0001")
	testTerminal = mustUUID("018f3c2a-0000-7000-8000-0000000a0001")
	testVariant  = mustUUID("018f3c2a-0000-7000-8000-0000000c0001")
)

func mustUUID(s string) identity.UUIDv7 {
	id, err := identity.ParseUUIDv7(s)
	if err != nil {
		panic("test fixture has an invalid UUIDv7: " + s)
	}
	return id
}

func newWorld(t *testing.T, vatRateBp money.BasisPoints) *world {
	t.Helper()
	now := time.Date(2026, 10, 4, 9, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }

	orders := memory.NewOrders()
	rates := memory.NewRates()
	rates.Set(testBranch, vatRateBp)
	idem := memory.NewIdempotency(clock)
	outbox := memory.NewOutbox()

	ingest := orderuc.NewIngestOrder(orderuc.IngestOrderDeps{
		Orders: orders, Rates: rates, Idem: idem, Outbox: outbox, Now: clock,
	})
	drain := syncuc.NewDrainOutbox(syncuc.DrainDeps{
		Orders: syncorder.NewIngester(ingest),
		Idem:   idem,
		Now:    clock,
		Cursor: func(context.Context) (string, error) { return "cursor-1", nil },
	})

	mux := http.NewServeMux()
	orderhttp.NewHandler(drain, func() int64 { return now.UnixNano() }).Route(mux)

	return &world{orders: orders, rates: rates, idem: idem, outbox: outbox, mux: mux, now: now}
}

// orderID and lineID build distinct, well-formed UUIDv7s from a small counter.
func orderID(n int) string   { return fmt.Sprintf("018f3c2a-0000-7000-8000-%012d", n) }
func lineID(n int) string    { return fmt.Sprintf("018f3c2a-0000-7000-8001-%012d", n) }
func commandID(n int) string { return fmt.Sprintf("018f3c2a-0000-7000-8002-%012d", n) }

// orderPayload is the contract's Order at the priced subset, with STRING satang.
//
// `unitPrice` is the VAT-INCLUSIVE menu price, so the tax sits INSIDE the amount
// charged. The net/tax split is computed with the money kernel rather than
// hard-coded, because a fixture that hard-codes it is a fixture that silently
// becomes "wrong" the moment the VAT rule changes — and a wrong fixture here is
// indistinguishable from a server that fails to re-price, which is the exact bug
// these tests exist to catch.
func orderPayload(id string, lines int, unitPrice, discount, rounding, total int64) string {
	return orderPayloadForBranch(id, testBranch, lines, unitPrice, discount, rounding, total)
}

// orderPayloadForBranch is the fixture for a sale in a branch other than the
// default one, so a test can exercise "this branch has no configured VAT rate"
// without hand-writing a payload and risking a different wire shape.
func orderPayloadForBranch(id string, branch identity.UUIDv7, lines int, unitPrice, discount, rounding, total int64) string {
	subtotal := unitPrice * int64(lines)
	gross := money.MustSatang(subtotal - discount)
	split, err := money.SplitInclusiveVAT(gross, money.DefaultVATRateBp)
	if err != nil {
		panic("test fixture cannot be split: " + err.Error())
	}
	var b strings.Builder
	fmt.Fprintf(&b, `{"id":%q,"branch_id":%q,"terminal_id":%q,`, id, branch, testTerminal)
	fmt.Fprintf(&b, `"type":"dine_in","status":"completed","source":"pos_desktop",`)
	fmt.Fprintf(&b, `"subtotal_satang":"%d","discount_satang":"%d","taxable_satang":"%s","tax_satang":"%s",`,
		subtotal, discount, split.Net.String(), split.Tax.String())
	// SignedSatang is the ONE money field the contract types as `integer`, not
	// `string`: unquoted. Emitting "%d" here would be quoted and the money kernel
	// would refuse it — which is the correct behaviour and the reason this fixture
	// writes the number literally rather than through a shared formatter.
	fmt.Fprintf(&b, `"service_charge_satang":"0","rounding_adjustment_satang":%d,"total_satang":"%d",`, rounding, total)
	fmt.Fprintf(&b, `"vat_rate_bp":700,"created_at":"2026-10-04T09:00:00.000Z","lines":[`)
	for i := 0; i < lines; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b,
			`{"id":%q,"order_id":%q,"product_variant_id":%q,"quantity":"1","unit_price_satang":"%d",`+
				`"line_discount_satang":"0","line_total_satang":"%d","sequence":%d,"created_at":"2026-10-04T09:00:00.000Z"}`,
			lineID(i+1), id, testVariant, unitPrice, unitPrice, i+1)
	}
	b.WriteString(`]}`)
	return b.String()
}

// pushBody wraps a payload in the contract's SyncPushRequest.
func pushBody(commands ...string) string {
	return fmt.Sprintf(`{"terminal_id":%q,"commands":[%s]}`, testTerminal, strings.Join(commands, ","))
}

// command wraps a payload in the contract's SyncCommand.
func command(n int, key, payload string) string {
	return fmt.Sprintf(
		`{"id":%q,"aggregate_type":"order","aggregate_id":%q,"event_type":"order_committed",`+
			`"action":"push_order","idempotency_key":%q,"payload":%s}`,
		commandID(n), orderID(n), key, payload)
}

func (w *world) post(t *testing.T, idemKey, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, orderhttp.BasePath+"/sync/push", strings.NewReader(body))
	if idemKey != "" {
		req.Header.Set(orderhttp.IdempotencyKeyHeader, idemKey)
	}
	rec := httptest.NewRecorder()
	w.mux.ServeHTTP(rec, req)
	return rec
}

// decode reads a push response's counters and outcomes.
func decode(t *testing.T, rec *httptest.ResponseRecorder) (int, int, int, []string) {
	t.Helper()
	var resp struct {
		Results []struct {
			ID      string `json:"id"`
			Outcome string `json:"outcome"`
			Code    string `json:"error_code"`
		} `json:"results"`
		Applied    int `json:"applied"`
		Duplicates int `json:"duplicates"`
		Rejected   int `json:"rejected"`
		PushedAt   string
		Cursor     *string `json:"cursor"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not SyncPushResponse: %v\nbody: %s", err, rec.Body.String())
	}
	outcomes := make([]string, 0, len(resp.Results))
	for _, r := range resp.Results {
		outcomes = append(outcomes, r.Outcome)
	}
	return resp.Applied, resp.Duplicates, resp.Rejected, outcomes
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Success — 200 ACKNOWLEDGED
// ─────────────────────────────────────────────────────────────────────────────

// TestPushSync_AcceptsAnOfflineOrderAndAcknowledgesIt is the happy path, and the
// 200 is only meaningful if the sale was actually re-priced and stored.
func TestPushSync_AcceptsAnOfflineOrderAndAcknowledgesIt(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)

	// ฿45.50 for one latte: net 4252, tax 298, total 4550.
	payload := orderPayload(orderID(1), 1, 4550, 0, 0, 4550)

	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", payload)))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200. body: %s", rec.Code, rec.Body.String())
	}
	applied, dup, rejected, outcomes := decode(t, rec)
	if applied != 1 || dup != 0 || rejected != 0 {
		t.Errorf("applied=%d duplicates=%d rejected=%d, want 1/0/0", applied, dup, rejected)
	}
	if len(outcomes) != 1 || outcomes[0] != "applied" {
		t.Errorf("outcomes = %v, want [applied]", outcomes)
	}
	if w.orders.Count() != 1 {
		t.Errorf("stored %d orders, want 1 — a 200 that stored nothing is a lie", w.orders.Count())
	}

	// The re-priced figures are the SERVER's, and they must be the ones stored.
	stored, ok := w.orders.Get(mustUUID(orderID(1)))
	if !ok {
		t.Fatal("the order was not stored under its client-generated id")
	}
	if stored.Totals.TaxSatang() != 298 {
		t.Errorf("tax = %d, want 298 — the server must re-derive VAT, not trust the client", stored.Totals.TaxSatang())
	}
	if stored.Totals.NetSatang() != 4252 {
		t.Errorf("net = %d, want 4252", stored.Totals.NetSatang())
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Idempotency — the duplicate-order interceptor
// ─────────────────────────────────────────────────────────────────────────────

// TestPushSync_TheSameBatchTwiceStoresOneOrder is THE duplicate-order test.
//
// The scenario from the domain notes: a terminal pushes, the server commits, the
// response is lost on a NAT timeout the terminal cannot tell from a crash. The
// terminal retries the identical batch. Without the header key that retry is a
// SECOND order — a second charge for one latte.
func TestPushSync_TheSameBatchTwiceStoresOneOrder(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	body := pushBody(command(1, "evt-1", orderPayload(orderID(1), 1, 4550, 0, 0, 4550)))

	first := w.post(t, "batch-key-1", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first push: status %d, body %s", first.Code, first.Body.String())
	}
	second := w.post(t, "batch-key-1", body)

	if second.Code != http.StatusOK {
		t.Fatalf("a retry must be a SUCCESS, not an error: status %d, body %s", second.Code, second.Body.String())
	}
	if got := first.Body.String(); got != second.Body.String() {
		t.Errorf("a retry returned a different body than the original:\n first: %s\nsecond: %s", got, second.Body.String())
	}
	if n := w.orders.Count(); n != 1 {
		t.Fatalf("stored %d orders after a retried batch, want 1 — the customer was charged twice", n)
	}
	if n := w.orders.Appends(); n != 1 {
		t.Errorf("accepted %d appends, want 1", n)
	}
}

// TestPushSync_DifferentBatchKeySameCommandIsStillOneOrder covers the OTHER race:
// two workers on one terminal send DIFFERENT batches containing the SAME event.
// The batch key cannot catch that — the per-command key can, and it must.
func TestPushSync_DifferentBatchKeySameCommandIsStillOneOrder(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	cmd := command(1, "evt-1", orderPayload(orderID(1), 1, 4550, 0, 0, 4550))

	first := w.post(t, "batch-key-A", pushBody(cmd))
	if first.Code != http.StatusOK {
		t.Fatalf("first: %d %s", first.Code, first.Body.String())
	}
	_, dup, _, outcomes := decode(t, first)

	second := w.post(t, "batch-key-B", pushBody(cmd))
	if second.Code != http.StatusOK {
		t.Fatalf("second: %d %s", second.Code, second.Body.String())
	}
	applied, dup2, _, outcomes2 := decode(t, second)

	if applied != 0 || dup2 != 1 {
		t.Errorf("the overlapping batch reported applied=%d duplicates=%d, want 0/1", applied, dup2)
	}
	if len(outcomes2) != 1 || outcomes2[0] != "duplicate" {
		t.Errorf("outcomes = %v, want [duplicate]", outcomes2)
	}
	if dup != 0 {
		t.Errorf("the first batch reported %d duplicates, want 0", dup)
	}
	_ = outcomes
	if n := w.orders.Count(); n != 1 {
		t.Fatalf("stored %d orders from two overlapping batches, want 1", n)
	}
}

// TestPushSync_AMissingIdempotencyKeyIsRefused proves the header is required
// rather than defaulted. An absent key that hashed to a constant would make every
// keyless batch collide with every other.
func TestPushSync_AMissingIdempotencyKeyIsRefused(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	rec := w.post(t, "", pushBody(command(1, "evt-1", orderPayload(orderID(1), 1, 4550, 0, 0, 4550))))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if w.orders.Count() != 0 {
		t.Error("an order was stored for a request with no idempotency key")
	}
	var e orderhttpErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("error body is not the contract's Error schema: %v", err)
	}
	if e.Code != "idempotency_key_required" {
		t.Errorf("error code = %q, want idempotency_key_required", e.Code)
	}
}

type orderhttpErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// TestPushSync_AnEmptyBatchSucceeds covers two workers on one terminal racing: the
// loser sends nothing. Answering that with an error makes the terminal back off
// against a queue it has already emptied.
func TestPushSync_AnEmptyBatchSucceeds(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	rec := w.post(t, "batch-key-empty", `{"terminal_id":"`+testTerminal.String()+`","commands":[]}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("an empty batch must be a success: status %d, body %s", rec.Code, rec.Body.String())
	}
	applied, _, rejected, outcomes := decode(t, rec)
	if applied != 0 || rejected != 0 || len(outcomes) != 0 {
		t.Errorf("applied=%d rejected=%d outcomes=%v, want 0/0/[]", applied, rejected, outcomes)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 3. Authoritative re-validation
// ─────────────────────────────────────────────────────────────────────────────

// TestPushSync_RefusesATamperedTaxFigure is the anti-fraud test.
//
// The terminal claims a VAT of 1 satang on a ฿45.50 sale. The server re-prices at
// the BRANCH's rate, gets 298, and refuses. It does not correct the figure: a
// silently corrected receipt disagrees with the paper the customer is holding.
func TestPushSync_RefusesATamperedTaxFigure(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)

	payload := fmt.Sprintf(`{"id":%q,"branch_id":%q,"terminal_id":%q,`, orderID(1), testBranch, testTerminal) +
		`"type":"dine_in","status":"completed","source":"pos_desktop",` +
		`"subtotal_satang":"4550","discount_satang":"0","taxable_satang":"4549","tax_satang":"1",` +
		`"service_charge_satang":"0","rounding_adjustment_satang":"0","total_satang":"4550",` +
		`"vat_rate_bp":700,"created_at":"2026-10-04T09:00:00.000Z","lines":[` +
		fmt.Sprintf(`{"id":%q,"order_id":%q,"product_variant_id":%q,"quantity":"1","unit_price_satang":"4550",`+
			`"line_discount_satang":"0","line_total_satang":"4550","sequence":1,"created_at":"2026-10-04T09:00:00.000Z"}`,
			lineID(1), orderID(1), testVariant) + `]}`

	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", payload)))
	_, _, rejected, outcomes := decode(t, rec)

	if rejected != 1 {
		t.Fatalf("rejected = %d, want 1 — a tampered tax figure must not be acknowledged", rejected)
	}
	if len(outcomes) != 1 || outcomes[0] != "rejected" {
		t.Errorf("outcomes = %v, want [rejected]", outcomes)
	}
}

// TestPushSync_RefusesAnImbalancedTotal is the balance-check test: the submitted
// figures do not satisfy total = gross + service_charge + rounding_adjustment.
func TestPushSync_RefusesAnImbalancedTotal(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)

	// subtotal 4550, discount 0, so gross is 4550 and the total must be 4550.
	// This claims 4000 — a ฿5.50 shortfall nobody can reconcile.
	payload := fmt.Sprintf(`{"id":%q,"branch_id":%q,"terminal_id":%q,`, orderID(1), testBranch, testTerminal) +
		`"type":"dine_in","status":"completed","source":"pos_desktop",` +
		`"subtotal_satang":"4550","discount_satang":"0","taxable_satang":"4252","tax_satang":"298",` +
		`"service_charge_satang":"0","rounding_adjustment_satang":"0","total_satang":"4000",` +
		`"vat_rate_bp":700,"created_at":"2026-10-04T09:00:00.000Z","lines":[` +
		fmt.Sprintf(`{"id":%q,"order_id":%q,"product_variant_id":%q,"quantity":"1","unit_price_satang":"4550",`+
			`"line_discount_satang":"0","line_total_satang":"4550","sequence":1,"created_at":"2026-10-04T09:00:00.000Z"}`,
			lineID(1), orderID(1), testVariant) + `]}`

	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", payload)))
	_, _, rejected, _ := decode(t, rec)

	if rejected != 1 {
		t.Fatalf("an unbalanced total was not rejected. body: %s", rec.Body.String())
	}
	if w.orders.Count() != 0 {
		t.Errorf("stored %d orders, want 0", w.orders.Count())
	}
}

// TestPushSync_RefusesANegativeTotal covers the one bound signed rounding does NOT
// remove: rounding may move the amount down, but the sale may not go negative.
func TestPushSync_RefusesANegativeTotal(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1",
		orderPayload(orderID(1), 1, 4550, 0, -4600, -50))))

	_, _, rejected, _ := decode(t, rec)
	if rejected != 1 {
		t.Fatalf("a negative total must be rejected. body: %s", rec.Body.String())
	}
	if w.orders.Count() != 0 {
		t.Errorf("stored %d orders, want 0", w.orders.Count())
	}
}

// TestPushSync_AcceptsNegativeCashRounding is the ratified spec, exercised through
// the whole pipeline.
//
// ฿45.53 is not payable from a drawer of coins ending in 5, so it rounds DOWN to
// ฿45.50 — a -3 satang adjustment. The VAT decomposition is pinned to gross, so
// net + tax is unchanged by the rounding and the sale is acknowledged.
func TestPushSync_AcceptsNegativeCashRounding(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)

	payload := orderPayload(orderID(1), 1, 4553, 0, -3, 4550)

	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", payload)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200. body: %s", rec.Code, rec.Body.String())
	}
	applied, _, rejected, _ := decode(t, rec)
	if applied != 1 || rejected != 0 {
		t.Fatalf("applied=%d rejected=%d, want 1/0 — rounding down must be acknowledged", applied, rejected)
	}

	stored, ok := w.orders.Get(mustUUID(orderID(1)))
	if !ok {
		t.Fatal("the order was not stored")
	}
	if stored.Totals.RoundingAdjustmentSatang != -3 {
		t.Errorf("rounding = %d, want -3", stored.Totals.RoundingAdjustmentSatang)
	}
	if stored.Totals.TotalSatang != 4550 {
		t.Errorf("total = %d, want 4550", stored.Totals.TotalSatang)
	}
	// The decomposition is untouched by the rounding.
	if stored.Totals.NetSatang() != 4255 || stored.Totals.TaxSatang() != 298 {
		t.Errorf("net/tax = %d/%d, want 4255/298 — cash rounding must not change the VAT base",
			stored.Totals.NetSatang(), stored.Totals.TaxSatang())
	}
}

// TestPushSync_RefusesABareJSONNumberForSatang proves the contract's string
// grammar is enforced at the boundary: a client sending `4550` instead of
// `"4550"` is refused rather than guessed at.
func TestPushSync_RefusesABareJSONNumberForSatang(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	payload := fmt.Sprintf(`{"id":%q,"branch_id":%q,"terminal_id":%q,`, orderID(1), testBranch, testTerminal) +
		`"type":"dine_in","status":"completed","source":"pos_desktop",` +
		`"subtotal_satang":4550,"discount_satang":"0","taxable_satang":"4252","tax_satang":"298",` +
		`"service_charge_satang":"0","rounding_adjustment_satang":"0","total_satang":"4550",` +
		`"vat_rate_bp":700,"created_at":"2026-10-04T09:00:00.000Z","lines":[]}`

	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", payload)))
	_, _, rejected, _ := decode(t, rec)
	if rejected != 1 {
		t.Errorf("a bare JSON number in a Satang field was not rejected. body: %s", rec.Body.String())
	}
}

// TestPushSync_RefusesAPayloadWithNoLines: an order with no lines has no price.
func TestPushSync_RefusesAPayloadWithNoLines(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	payload := fmt.Sprintf(`{"id":%q,"branch_id":%q,"terminal_id":%q,"type":"dine_in","status":"completed",`+
		`"source":"pos_desktop","subtotal_satang":"0","discount_satang":"0","taxable_satang":"0",`+
		`"tax_satang":"0","service_charge_satang":"0","rounding_adjustment_satang":"0","total_satang":"0",`+
		`"vat_rate_bp":700,"created_at":"2026-10-04T09:00:00.000Z","lines":[]}`, orderID(1), testBranch, testTerminal)

	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", payload)))
	_, _, rejected, _ := decode(t, rec)
	if rejected != 1 {
		t.Errorf("an order with no lines was not rejected. body: %s", rec.Body.String())
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch semantics
// ─────────────────────────────────────────────────────────────────────────────

// TestPushSync_OneBadCommandDoesNotFailTheBatch is the rule that keeps a terminal
// draining.
//
// A terminal's outbox is in local sequence order. If one malformed event failed the
// whole request, the terminal would retry that batch forever and never deliver the
// good sales behind it. The sale is real and the money is taken.
func TestPushSync_OneBadCommandDoesNotFailTheBatch(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)

	good1 := command(1, "evt-1", orderPayload(orderID(1), 1, 4550, 0, 0, 4550))
	bad := command(2, "evt-2", `{"id":"not-a-uuid"}`)
	good2 := command(3, "evt-3", orderPayload(orderID(3), 2, 4550, 0, 0, 9100))

	rec := w.post(t, "batch-key-1", pushBody(good1, bad, good2))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — one bad command must not fail the batch. body: %s",
			rec.Code, rec.Body.String())
	}
	applied, _, rejected, outcomes := decode(t, rec)
	if applied != 2 || rejected != 1 {
		t.Errorf("applied=%d rejected=%d, want 2/1", applied, rejected)
	}
	want := []string{"applied", "rejected", "applied"}
	for i := range want {
		if outcomes[i] != want[i] {
			t.Errorf("outcomes = %v, want %v — results must stay in request order", outcomes, want)
			break
		}
	}
	if w.orders.Count() != 2 {
		t.Errorf("stored %d orders, want 2 — the good sales behind a bad event must still land", w.orders.Count())
	}
}

// TestPushSync_RejectedCommandsCarryAStableCode: `code` is what a client branches
// on, so an empty one is a branch it cannot make.
func TestPushSync_RejectedCommandsCarryAStableCode(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", `{"id":"not-a-uuid"}`)))

	var resp struct {
		Results []struct {
			Outcome      string `json:"outcome"`
			ErrorCode    string `json:"error_code"`
			ErrorMessage string `json:"error_message"`
		} `json:"results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not SyncPushResponse: %v", err)
	}
	if len(resp.Results) != 1 {
		t.Fatalf("got %d results, want 1", len(resp.Results))
	}
	if resp.Results[0].ErrorCode == "" {
		t.Error("a rejection carried no error_code; the client has nothing to branch on")
	}
	if resp.Results[0].ErrorMessage == "" {
		t.Error("a rejection carried no error_message; nobody can act on it")
	}
}

// TestPushSync_AMalformedBodyIs400: the envelope, not a command.
func TestPushSync_AMalformedBodyIs400(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)

	for name, body := range map[string]string{
		"not json":        `{`,
		"no terminal_id":  `{"commands":[]}`,
		"bad terminal_id": `{"terminal_id":"nope","commands":[]}`,
		"bad command id":  `{"terminal_id":"` + testTerminal.String() + `","commands":[{"id":"x"}]}`,
		"no command key":  `{"terminal_id":"` + testTerminal.String() + `","commands":[{"id":"` + commandID(1) + `","aggregate_id":"` + orderID(1) + `"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			rec := w.post(t, "batch-key-"+strings.ReplaceAll(name, " ", "-"), body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400. body: %s", rec.Code, rec.Body.String())
			}
			if w.orders.Count() != 0 {
				t.Errorf("stored %d orders for a malformed request, want 0", w.orders.Count())
			}
		})
	}
}

// TestPushSync_AnInfrastructureFailureAnswers500AndNotARejection is the trap this
// design exists to avoid.
//
// If an unreachable database were reported as a per-command `rejected`, the
// terminal would mark those sales `failed_permanent` and never send them again. An
// outage would silently become a day of lost sales. It must be a 500 so the batch
// is retried intact.
func TestPushSync_AnInfrastructureFailureAnswers500AndNotARejection(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	// An UNCONFIGURED branch makes `rates.VATRateBp` fail, which is the same shape
	// as an unreachable database: transient, not permanent.
	otherBranch := mustUUID("018f3c2a-0000-7000-8000-0000000b9999")

	payload := orderPayloadForBranch(orderID(1), otherBranch, 1, 4550, 0, 0, 4550)

	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", payload)))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500. body: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"outcome":"rejected"`) {
		t.Error("a transient failure was reported as a permanent rejection; the terminal would give up on a real sale")
	}
	// Nothing recorded, so the terminal's retry is processed rather than replayed.
	if w.idem.Len() != 0 {
		t.Errorf("recorded %d idempotency entries for a failed batch, want 0", w.idem.Len())
	}
}

// TestPushSync_ARetriedBatchAfterAFailureSucceeds proves the previous test's
// consequence: because nothing was recorded, a retry is really processed.
func TestPushSync_ARetriedBatchAfterAFailureSucceeds(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	otherBranch := mustUUID("018f3c2a-0000-7000-8000-0000000b9999")

	payload := orderPayloadForBranch(orderID(1), otherBranch, 1, 4550, 0, 0, 4550)
	body := pushBody(command(1, "evt-1", payload))

	if rec := w.post(t, "batch-key-1", body); rec.Code != http.StatusInternalServerError {
		t.Fatalf("first attempt: status %d, want 500", rec.Code)
	}

	// The operator rates the branch.
	w.rates.Set(otherBranch, money.DefaultVATRateBp)

	rec := w.post(t, "batch-key-1", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("the retry after a failure must succeed: status %d, body %s", rec.Code, rec.Body.String())
	}
	applied, _, _, _ := decode(t, rec)
	if applied != 1 {
		t.Errorf("applied = %d, want 1", applied)
	}
	if w.orders.Count() != 1 {
		t.Errorf("stored %d orders, want 1", w.orders.Count())
	}
}

// TestPushSync_CommandsAreAppliedInRequestOrder guards the ordering rule: a
// terminal drains its outbox by local sequence, and reordering would replay a
// `shift_opened` after the `shift_closed` that ended it.
func TestPushSync_CommandsAreAppliedInRequestOrder(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	body := pushBody(
		command(1, "evt-1", orderPayload(orderID(1), 1, 4550, 0, 0, 4550)),
		command(2, "evt-2", orderPayload(orderID(2), 1, 4550, 0, 0, 4550)),
		command(3, "evt-3", orderPayload(orderID(3), 1, 4550, 0, 0, 4550)),
	)
	rec := w.post(t, "batch-key-1", body)

	var resp struct {
		Results []struct {
			ID string `json:"id"`
		} `json:"results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not SyncPushResponse: %v", err)
	}
	for i, r := range resp.Results {
		if want := commandID(i + 1); r.ID != want {
			t.Errorf("results[%d].id = %s, want %s — order is semantic here", i, r.ID, want)
		}
	}
}

// TestPushSync_ResponseCarriesTheCursor: the terminal hands it to its next
// incremental pull so it does not re-fetch what this push covered.
func TestPushSync_ResponseCarriesTheCursor(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	rec := w.post(t, "batch-key-1", pushBody(command(1, "evt-1", orderPayload(orderID(1), 1, 4550, 0, 0, 4550))))

	if !strings.Contains(rec.Body.String(), `"cursor":"cursor-1"`) {
		t.Errorf("the response carried no cursor: %s", rec.Body.String())
	}
}

// TestPushSync_TrailingASecondDocumentIsRefused guards a silent data-loss path.
//
// `json.Decoder.Decode` reads one JSON value and stops. A body of two concatenated
// batches therefore decoded the first, ignored the second, and answered 200 — and
// the terminal, believing its whole outbox acknowledged, dropped the sales in the
// second batch. Nothing appeared in any log, because from the server's side the
// request had succeeded.
//
// Verified before the fix: status 200, one order stored, second batch silently gone.
func TestPushSync_TrailingASecondDocumentIsRefused(t *testing.T) {
	w := newWorld(t, money.DefaultVATRateBp)
	body := pushBody(command(1, "evt-1", orderPayload(orderID(1), 1, 4550, 0, 0, 4550))) +
		pushBody(command(2, "evt-2", orderPayload(orderID(2), 1, 4550, 0, 0, 4550)))

	rec := w.post(t, "batch-key-concat", body)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — a concatenated body must not be half-applied. body: %s",
			rec.Code, rec.Body.String())
	}
	if n := w.orders.Count(); n != 0 {
		t.Errorf("stored %d orders, want 0 — a refused request must apply nothing", n)
	}
	if w.idem.Len() != 0 {
		t.Errorf("recorded %d idempotency entries for a refused request, want 0", w.idem.Len())
	}
}
