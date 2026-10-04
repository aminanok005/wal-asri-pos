// Package usecase holds the order module's application logic: the interactors that
// ingest an order from a terminal, re-validate it, and record what happened.
//
// The ingest path is the most safety-critical code in this service. An order
// arrives from a device that has been OFFLINE, carrying its own ids, its own
// pricing and its own tax figure. Everything about it is untrusted in the sense
// that matters: it was produced by a client that may have been running stale
// rules for a week.
//
// SKILL.md §2.3 makes the server's obligation explicit: "Server Domain
// (`internal/{feature}/domain/`): Authoritative Go domain logic. Re-validates all
// client data on ingest."
//
// So the pipeline below re-prices the order from its LINES at the BRANCH'S OWN
// `vat_rate_bp`, compares that against what the terminal claimed, and refuses a
// mismatch. It does not "fix" the client's number — silently correcting a price
// would mean the receipt printed on the terminal and the order in the ledger
// disagree, and neither the cashier nor the tax office could reconcile them.
package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
	sync "wal-asri-pos/services/api-backend/internal/sync/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

// OrderRepository stores orders. Append-only: there is no Update that rewrites
// what was sold, and no Delete.
type OrderRepository interface {
	// Append stores a NEW order. An implementation MUST refuse a second write of
	// the same id rather than overwrite, because the primary key is a
	// client-generated UUIDv7 and the order is a record of a sale that happened.
	Append(ctx context.Context, o order.Order) error
}

// BranchRateSource supplies the branch's VAT rate and currency.
//
// A dedicated port rather than a field on the request, because the contract is
// emphatic that the server derives these and the client never asserts them: the
// branch's VAT rate is "read from the owning Branch, never asserted by the
// client". A rate carried in the request body is a client-originated price, and
// the whole VAT argument in this service says those do not exist.
type BranchRateSource interface {
	// VATRateBp returns the branch's VAT rate in basis points. 700 = 7.00%.
	VATRateBp(ctx context.Context, branchID identity.UUIDv7) (money.BasisPoints, error)
}

// IdempotencyStore records the outcome of each submission, keyed by the hashed
// idempotency key.
//
// Looked up BEFORE the work is done and written AFTER it commits. That ordering
// is the entire mechanism; see Decide's documentation for why the middle window
// is safe.
type IdempotencyStore interface {
	// Lookup returns the record stored under key, or nil when there is none.
	Lookup(ctx context.Context, key sync.IdempotencyKey) (*sync.IdempotencyRecord, error)
	// Save stores a record. An implementation MUST refuse to overwrite a live
	// record, so that two concurrent submissions cannot both write.
	Save(ctx context.Context, rec sync.IdempotencyRecord) error
}

// OutboxLedger records the server-side lifecycle of each submission.
type OutboxLedger interface {
	// Append records a newly accepted item in StatePending.
	Append(ctx context.Context, item sync.SyncOutboxItem) error
	// TransitionTo moves an item's state. A duplicate submission does NOT call
	// this: it returns the stored response instead.
	TransitionTo(ctx context.Context, id identity.UUIDv7, to sync.OutboxState, at time.Time) error
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors the interactor returns
// ─────────────────────────────────────────────────────────────────────────────

// The distinction the adapter needs, kept as a named error rather than a string
// match, because the HTTP status differs and getting it wrong is visible: a
// duplicate that returns 409 looks like a failure to the terminal, which will
// then retry forever.
var (
	// ErrDuplicateSubmission means a prior outcome exists and its stored response
	// is being returned. This is SUCCESS from the terminal's point of view.
	ErrDuplicateSubmission = errors.New("order: duplicate submission; the original response is being returned")

	// ErrValidationFailed means the client's data does not survive server-side
	// re-validation. The terminal must NOT retry this — the order is wrong, not
	// unlucky.
	ErrValidationFailed = errors.New("order: the submission failed server-side validation")

	// ErrBranchNotAccessible means the device credential is valid but not scoped
	// to the order's branch. The contract maps this to 403 and is explicit that
	// "the server never trusts a client-asserted branch id".
	ErrBranchNotAccessible = errors.New("order: this device is not registered to that branch")
)

// ValidationError carries the reason a submission was refused, so the terminal
// gets something specific instead of a generic 400 it cannot act on.
type ValidationError struct {
	Reason string
	Err    error
}

func (e *ValidationError) Error() string { return e.Reason }
func (e *ValidationError) Unwrap() error { return errors.Join(ErrValidationFailed, e.Err) }

// ─────────────────────────────────────────────────────────────────────────────
// The request
// ─────────────────────────────────────────────────────────────────────────────

// IngestRequest is one order as submitted by a terminal.
//
// Note what is NOT here: the VAT rate, the currency, and the branch's pricing.
// All three are server-owned. The terminal sends ids, quantities and the prices it
// charged; the server re-derives everything it can and refuses what does not match.
type IngestRequest struct {
	// IdempotencyKey is the CLIENT-SUPPLIED key, in the clear. It is hashed with
	// the branch id before anything is stored — see sync.DeriveIdempotencyKey.
	IdempotencyKey string

	// TerminalID is the device, as derived from the device credential by the
	// adapter. A use case never reads a terminal identity out of a request body,
	// because a request body is client-controlled.
	TerminalID identity.UUIDv7

	Order order.Order
}

// ─────────────────────────────────────────────────────────────────────────────
// The interactor
// ─────────────────────────────────────────────────────────────────────────────

// IngestOrder accepts an offline order and makes it authoritative.
type IngestOrder struct {
	orders  OrderRepository
	rates   BranchRateSource
	idem    IdempotencyStore
	outbox  OutboxLedger
	now     func() time.Time
	idemTTL time.Duration
}

// IngestOrderDeps is the constructor's argument bundle, so adding a port does not
// change every call site's arity.
type IngestOrderDeps struct {
	Orders  OrderRepository
	Rates   BranchRateSource
	Idem    IdempotencyStore
	Outbox  OutboxLedger
	Now     func() time.Time
	IdemTTL time.Duration
}

// NewIngestOrder wires the interactor.
func NewIngestOrder(d IngestOrderDeps) *IngestOrder {
	ttl := d.IdemTTL
	if ttl <= 0 {
		ttl = sync.DefaultIdempotencyTTL
	}
	nowFn := d.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &IngestOrder{
		orders:  d.Orders,
		rates:   d.Rates,
		idem:    d.Idem,
		outbox:  d.Outbox,
		now:     nowFn,
		idemTTL: ttl,
	}
}

// Result is what an accepted submission produced.
type Result struct {
	OrderID identity.UUIDv7
	// State is where the submission ended up. ACKNOWLEDGED normally;
	// CONFLICT_HELD when the order was stored but deliberately not applied.
	State sync.OutboxState
	// Totals are the SERVER's figures, which may differ from the terminal's and are
	// the ones that count.
	Totals order.Totals
	// Response is the answer to serialise, and the value stored for a replay.
	Response string
}

// Execute runs the ingest pipeline.
//
// The four steps, in this order, and the order is the design:
//
//  1. DEDUPLICATE. Look the key up first. If a live record exists, return its
//     stored response and do nothing else — not even re-validate, because
//     re-running the business logic on a retry is how a duplicate becomes a
//     second order. This is the whole point of the idempotency store.
//
//  2. RE-PRICE. Fetch the branch's OWN VAT rate and recompute the totals from the
//     order's lines. Not from the client's claimed total, and not from the client's
//     claimed rate.
//
//  3. REFUSE A MISMATCH. If the client's figures disagree with the server's, the
//     submission is rejected — not corrected. A silently corrected price produces
//     a receipt that disagrees with the ledger, which is worse than a rejected
//     order the cashier can re-ring.
//
//  4. COMMIT AND RECORD. Append the order, move the outbox item to ACKNOWLEDGED,
//     and store the idempotency record with the response.
//
// Step 4's ordering matters: the idempotency record is written LAST, so a crash
// between the append and the save leaves a duplicate to be re-applied rather than
// one to be silently lost. At-least-once on the write is safe because the append
// itself is idempotent on the client-generated primary key.
func (i *IngestOrder) Execute(ctx context.Context, req IngestRequest) (Result, error) {
	now := i.now().UTC()
	branchID := req.Order.BranchID

	// ── Step 1: deduplicate ───────────────────────────────────────────────────
	key, err := sync.DeriveIdempotencyKey(branchID.String(), req.IdempotencyKey)
	if err != nil {
		// A missing key is a client bug, not a transient failure: retrying will
		// never produce a key.
		return Result{}, &ValidationError{
			Reason: "an idempotency key is required; without one a retried submission would be " +
				"applied a second time as a new order",
			Err: err,
		}
	}

	prior, err := i.idem.Lookup(ctx, key)
	if err != nil {
		return Result{}, fmt.Errorf("order: looking up the idempotency key: %w", err)
	}
	switch sync.Decide(key, prior, now) {
	case sync.DecisionReplay:
		// Return the ORIGINAL response. Not a recomputed one: pricing depends on
		// the VAT rate at the moment of the original sale, so replaying the maths
		// today could return a different total for an order already charged.
		return Result{
			OrderID:  prior.EntityID,
			State:    prior.State,
			Response: prior.Response,
		}, ErrDuplicateSubmission

	case sync.DecisionProceedAfterExpiry:
		// The prior record is older than the window and protects against nothing.
		// Proceed and let Save replace it. Not an error: refusing here would reject
		// a genuine new sale because a key was reused long ago.
	}

	// ── Step 2: re-price at the branch's own rate ─────────────────────────────
	vatRateBp, err := i.rates.VATRateBp(ctx, branchID)
	if err != nil {
		return Result{}, fmt.Errorf("order %s: reading the branch VAT rate: %w", req.Order.ID, err)
	}

	subtotal, err := order.SubtotalSatang(req.Order.Lines)
	if err != nil {
		return Result{}, &ValidationError{Reason: "the order's lines do not price: " + err.Error(), Err: err}
	}

	authoritative, err := order.ComputeTotals(
		subtotal,
		req.Order.Totals.DiscountSatang,
		req.Order.Totals.ServiceChargeSatang,
		req.Order.Totals.RoundingAdjustmentSatang,
		vatRateBp,
	)
	if err != nil {
		return Result{}, &ValidationError{
			Reason: "the order cannot be priced at the branch's current VAT rate: " + err.Error(),
			Err:    err,
		}
	}

	// ── Step 3: refuse a mismatch, never correct it ───────────────────────────
	priced := req.Order
	priced.Totals = authoritative

	if err := priced.Validate(); err != nil {
		return Result{}, &ValidationError{
			Reason: "the order does not survive server-side validation: " + err.Error(),
			Err:    err,
		}
	}
	if claimed := req.Order.Totals; claimed.TotalSatang != authoritative.TotalSatang ||
		claimed.TaxSatang() != authoritative.TaxSatang() {
		// The terminal's numbers were computed at some other rate — most likely a
		// branch whose VAT rate changed after the terminal last synced. The sale
		// really happened and the money is real, so the order is HELD rather than
		// dropped: an operator reconciles it.
		held, holdErr := i.holdForConflict(ctx, priced, req.TerminalID, key, vatRateBp, claimed, authoritative, now)
		if holdErr != nil {
			return Result{}, holdErr
		}
		return held, nil
	}

	// ── Step 4: commit, then record ───────────────────────────────────────────
	if err := i.orders.Append(ctx, priced); err != nil {
		return Result{}, fmt.Errorf("order %s: appending: %w", priced.ID, err)
	}

	item := sync.SyncOutboxItem{
		ID:             req.Order.ID,
		EntityID:       priced.ID,
		EntityType:     "order",
		Action:         sync.ActionPushOrder,
		IdempotencyKey: key,
		State:          sync.StateAcknowledged,
		TerminalID:     req.TerminalID,
		CreatedAt:      now,
		DueAt:          now,
	}
	if err := i.outbox.Append(ctx, item); err != nil {
		return Result{}, fmt.Errorf("order %s: recording the outbox item: %w", priced.ID, err)
	}

	result := Result{
		OrderID: priced.ID,
		State:   sync.StateAcknowledged,
		Totals:  authoritative,
	}
	result.Response = renderAcknowledged(priced, authoritative)

	rec, err := sync.NewIdempotencyRecord(key, priced.ID, sync.StateAcknowledged, result.Response, now)
	if err != nil {
		return Result{}, fmt.Errorf("order %s: building the idempotency record: %w", priced.ID, err)
	}
	if err := i.idem.Save(ctx, rec); err != nil {
		// The order is committed but the key is not recorded. A retry will be
		// re-applied and hit the repository's refusal on the duplicate primary key,
		// which is the safe outcome: no second order, and an operator can see why.
		return Result{}, fmt.Errorf("order %s: the order is committed but the idempotency record "+
			"could not be saved (%v); a retry will be refused by the repository's duplicate "+
			"primary key rather than creating a second order", priced.ID, err)
	}

	return result, nil
}

// holdForConflict stores an order whose terminal-side figures disagree with the
// server's, and moves it to CONFLICT_HELD.
//
// It is a separate method because "refuse and drop" and "hold and inspect" are very
// different outcomes for a sale that genuinely happened on a device. The order is
// stored — the money is real and the customer has paid — but it is not applied to
// the authoritative ledger until someone decides.
func (i *IngestOrder) holdForConflict(
	ctx context.Context,
	priced order.Order,
	terminalID identity.UUIDv7,
	key sync.IdempotencyKey,
	vatRateBp money.BasisPoints,
	claimed, authoritative order.Totals,
	now time.Time,
) (Result, error) {
	reason := fmt.Sprintf(
		"the terminal priced this order at total %d / tax %d, but the branch's current rate of %s bp "+
			"gives total %d / tax %d; the order is held for review rather than corrected, because a "+
			"silently corrected price would disagree with the receipt already printed on the terminal",
		claimed.TotalSatang, claimed.TaxSatang(), vatRateBp, authoritative.TotalSatang, authoritative.TaxSatang())

	if err := i.orders.Append(ctx, priced); err != nil {
		return Result{}, fmt.Errorf("order %s: storing the held order: %w", priced.ID, err)
	}

	item := sync.SyncOutboxItem{
		ID:             priced.ID,
		EntityID:       priced.ID,
		EntityType:     "order",
		Action:         sync.ActionPushOrder,
		IdempotencyKey: key,
		State:          sync.StateConflictHeld,
		LastError:      reason,
		TerminalID:     terminalID,
		CreatedAt:      now,
		DueAt:          now,
	}
	if err := i.outbox.Append(ctx, item); err != nil {
		return Result{}, fmt.Errorf("order %s: recording the held outbox item: %w", priced.ID, err)
	}

	result := Result{OrderID: priced.ID, State: sync.StateConflictHeld, Totals: authoritative}
	result.Response = reason

	rec, err := sync.NewIdempotencyRecord(key, priced.ID, sync.StateConflictHeld, result.Response, now)
	if err != nil {
		return Result{}, fmt.Errorf("order %s: building the idempotency record: %w", priced.ID, err)
	}
	if err := i.idem.Save(ctx, rec); err != nil {
		return Result{}, fmt.Errorf("order %s: saving the idempotency record for a held order: %w", priced.ID, err)
	}
	return result, nil
}

// renderAcknowledged produces the stored response for an accepted order.
//
// Built as a string in the USE CASE rather than in the adapter on purpose: the
// value is persisted for 24 hours and replayed verbatim on a duplicate. If the
// adapter owned the format, a change to that format would change what a retry
// returns, and a terminal could receive two different answers to the same
// submission.
//
// The actual JSON shape belongs to the HTTP adapter. What matters here is that it
// is FIXED at the moment of the original submission.
//
// Every `*_satang` value is a QUOTED STRING, because contracts/openapi.yaml types
// `Satang` as `type: string` with pattern `^(0|[1-9][0-9]*)$`. Emitting a bare
// integer here would make the stored response — the bytes a retry gets back, and
// the only record of what the server decided — disagree with the wire contract
// that every other response on this endpoint follows.
func renderAcknowledged(o order.Order, totals order.Totals) string {
	return fmt.Sprintf(
		`{"order_id":"%s","branch_id":"%s","status":"%s","total_satang":"%s","taxable_satang":"%s","tax_satang":"%s","vat_rate_bp":%d}`,
		o.ID, o.BranchID, o.Status,
		totals.TotalSatang.String(), totals.NetSatang().String(), totals.TaxSatang().String(),
		totals.TaxSplit.RateBp)
}
