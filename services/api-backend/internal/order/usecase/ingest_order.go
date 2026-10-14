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
	"strings"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	inventoryuc "wal-asri-pos/services/api-backend/internal/inventory/usecase"
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
	Append(ctx context.Context, o order.Order) error
	Get(ctx context.Context, id identity.UUIDv7) (order.Order, error)
	UpdateStatus(ctx context.Context, id identity.UUIDv7, from, to order.OrderStatus, at time.Time) error
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
// The stock port
// ─────────────────────────────────────────────────────────────────────────────
//
// Declared HERE, in the order module's own vocabulary, rather than imported from
// `internal/inventory/usecase` — which this package may not do.
// internal/architecture/layers_test.go forbids one module's application layer from
// depending on another's, and the rule is what lets both modules be tested without
// the other.
//
// The types below therefore speak only `identity` and `money` — the two shared
// kernels — and know nothing about inventory items, movements or balances.
// `internal/order/adapter/inventory` implements this port over the real inventory
// interactor; tests implement it over a fake.

// StockLedger consumes stock for an accepted sale.
//
// ── WHY THIS IS A PORT AND NOT A DIRECT CALL ──────────────────────────────────
//
// Two reasons, and the second is the one that matters.
//
//  1. Inversion. This package's tests must run without a database, and a use case
//     that reached for a Postgres driver would need one.
//
//  2. THE ACKNOWLEDGEMENT IS A PROMISE. Once a terminal receives a 200 it clears
//     its outbox row, and the sale is never sent again. So an acknowledgement means
//     "this sale is fully recorded" — and if stock were deducted somewhere the
//     acknowledgement does not cover, the server would be making a promise it
//     cannot keep. Keeping the deduction behind a port the interactor MUST call is
//     what makes "an ACK implies a committed deduction" a property of this code
//     rather than a convention someone can route around.
type StockLedger interface {
	// DeductForSale consumes stock for every tracked line of an accepted order and
	// returns a warning per article that went below zero.
	DeductForSale(ctx context.Context, sale SaleStock) ([]StockWarning, error)
	// ReverseForVoid credits stock back for an order being voided.
	ReverseForVoid(ctx context.Context, sale SaleStock) error
}

// RecipeLookup resolves a sold product variant to its recipe components.
//
// It is a READ-ONLY port, separate from ItemLookup, so a sale that has no
// recipe is a normal skip rather than an error. The recipe module implements
// this port over the recipes and recipe_components tables.
type RecipeLookup interface {
	// RecipeComponentsFor returns the active recipe components for a sold
	// product variant, or (nil, false) if the variant has no active recipe.
	//
	// The boolean is false when NO recipe deduction applies, which is a NORMAL
	// case (most products have no recipe).
	//
	// An error is reserved for the store genuinely being unavailable.
	RecipeComponentsFor(ctx context.Context, branchID, productVariantID identity.UUIDv7) ([]inventoryuc.RecipeComponent, bool, error)
}

// SaleStock is one accepted order's worth of stock to consume, in this module's
// vocabulary.
type SaleStock struct {
	BranchID identity.UUIDv7

	// OrderID is carried for error messages and for the reader's benefit; the
	// deduction identifies itself per LINE, via OrderLineID. Nothing is keyed on
	// the order, because nothing in the ledger is.
	OrderID identity.UUIDv7

	Lines []SaleStockLine
}

// SaleStockLine is one sold line.
//
// Quantity is `money.Quantity` — the exact milli-unit count the terminal priced
// with, which is also the quantity that gets deducted. See the seam adapter's
// package note for why nothing converts it on the way across.
type SaleStockLine struct {
	// OrderLineID is what makes the deduction idempotent: it becomes the stock
	// movement's primary key, so a terminal retrying the batch that carried this
	// line collides with itself and deducts nothing a second time.
	OrderLineID      identity.UUIDv7
	ProductVariantID identity.UUIDv7
	Quantity         money.Quantity
}

// StockWarning is one article that went below zero.
//
// REPORTED, NOT ENFORCED — that is the whole of the policy. OnHandMilli is SIGNED
// and negative for the article that was oversold.
type StockWarning struct {
	InventoryItemID identity.UUIDv7
	// NameTH and Unit are carried so a warning is actionable rather than an id. An
	// operator reading "-750" cannot reorder flour; one reading "-0.750 kg of
	// แป้ง" can.
	NameTH string
	Unit   string
	// OnHandMilli is the committed balance in milli-units, NEGATIVE when oversold.
	//
	// Named `...Milli` and typed as a raw int64 because this reaches the wire inside
	// the acknowledgement. A `money.Quantity` would marshal as the decimal string
	// "-0.750" under a field called `on_hand`, which is a different wire shape from
	// the one the contract defines for StockBalance — and the acknowledgement is not
	// the place to introduce a second spelling of the same value.
	OnHandMilli int64
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
	stock   StockLedger
	recipes RecipeLookup
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
	Stock   StockLedger
	Recipes RecipeLookup
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
		stock:   d.Stock,
		recipes: d.Recipes,
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
	// StockWarnings names every article whose committed balance went below zero.
	//
	// The sale is NOT refused for any of them — see StockLedger. These travel in the
	// acknowledgement so a terminal can show "we are short" without the operator
	// having to open a database.
	//
	// Nil in the overwhelmingly common case, and the acknowledgement omits the field
	// entirely when it is empty rather than emitting `"stock_alerts":[]`.
	StockWarnings []StockWarning
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
//  4. COMMIT AND RECORD. Append the order, DEDUCT ITS STOCK, move the outbox item
//     to ACKNOWLEDGED, and store the idempotency record with the response.
//
// Step 4's ordering is the design, and both halves of it matter:
//
//   - the STOCK DEDUCTION happens BEFORE the idempotency record is written, so an
//     acknowledgement — the only thing that makes a terminal drop its outbox row —
//     can only exist once the stock has actually moved. An ACK is a promise that the
//     sale is fully recorded, and a promise about stock that was not kept is the
//     exact failure this service refuses everywhere else.
//
//   - the idempotency record is written LAST, so a crash anywhere earlier leaves a
//     duplicate to be RE-APPLIED rather than a result to be silently lost.
//     At-least-once on the write is safe because the append is idempotent on the
//     client-generated primary key, and the stock movement's id is the order line's
//     id — so re-applying deducts nothing twice.
//
// A sale that goes below zero on some article is NOT a failure at this layer: the
// deduction commits the negative balance and returns a warning, because the sale
// really happened. See StockLedger.
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
		return Result{
			OrderID:  prior.EntityID,
			State:    prior.State,
			Response: prior.Response,
		}, ErrDuplicateSubmission

	case sync.DecisionProceedAfterExpiry:
	}

	// ── VOID INGEST ───────────────────────────────────────────────────────────
	//
	// Handle void requests and approvals. If the payload carries StatusVoidRequested
	// or StatusVoided, we transition the existing order and reverse its stock.
	if req.Order.Status == order.StatusVoidRequested || req.Order.Status == order.StatusVoided {
		return i.processVoid(ctx, req, key, now)
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

	// ── Step 4: commit, deduct, then record ──────────────────────────────────
	if err := i.orders.Append(ctx, priced); err != nil {
		return Result{}, fmt.Errorf("order %s: appending: %w", priced.ID, err)
	}

	// The stock deduction, and it happens HERE — after the order is durable and
	// before anything tells the terminal the sale is settled.
	warnings, err := i.deductStock(ctx, priced)
	if err != nil {
		return Result{}, err
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
		// processed_at is set because the item is appended ALREADY TERMINAL, not
		// transitioned into that state. Without it the ledger row contradicts itself:
		// the schema CHECKs `(state IN ('ACKNOWLEDGED','CONFLICT_HELD')) =
		// (processed_at IS NOT NULL)`, and a terminal state with a NULL processed_at
		// is a row claiming it finished without saying when.
		ProcessedAt: &now,
	}
	if err := i.outbox.Append(ctx, item); err != nil {
		return Result{}, fmt.Errorf("order %s: recording the outbox item: %w", priced.ID, err)
	}

	result := Result{
		OrderID:       priced.ID,
		State:         sync.StateAcknowledged,
		Totals:        authoritative,
		StockWarnings: warnings,
	}
	result.Response = renderAcknowledged(priced, authoritative, warnings)

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

// deductStock consumes stock for a committed order and returns any shortage.
//
// A METHOD rather than a few inline lines, because the line-to-line mapping is the
// part worth naming once: the deduction is driven by the LINES THAT ACTUALLY
// ARRIVED, not by the order header and not by a re-derivation. Those quantities are
// already agreed — steps 2 and 3 re-priced the order and refused any mismatch — so
// the server has no better figure than the terminal does, and inventing one would
// mean two answers to "how much flour did this latte use" with no way to adjudicate.
//
// The order carries no `BranchID`-scoped stock context of its own beyond the branch,
// so the branch is passed explicitly rather than read off a line.
func (i *IngestOrder) deductStock(ctx context.Context, o order.Order) ([]StockWarning, error) {
	// AN UNWIRED LEDGER IS A CONFIGURATION ERROR, and it is checked here rather than
	// left to a nil-pointer panic three frames deeper.
	//
	// The panic would be loud too, so this is not about noise — it is about WHERE
	// the failure points. A segfault at ingest_order.go:526 during a shift says
	// "something is wrong in the ingest path"; this error says "Stock was not wired
	// into the composition root", which is a one-line fix.
	//
	// It is checked per call rather than in the constructor because the constructor
	// cannot distinguish a nil port from an interface holding a nil pointer, and
	// because failing at the point of use keeps the requirement attached to the one
	// place that cannot work without it.
	if i.stock == nil {
		return nil, fmt.Errorf(
			"order %s: the order is committed but no stock ledger is wired into the ingest pipeline. "+
				"StockLedger is required: without it the server would acknowledge sales whose stock it "+
				"never recorded. Wire one in cmd/api/main.go — the real Postgres store when "+
				"%s is set, or a refusing placeholder when it is not", o.ID, "DATABASE_URL")
	}

	lines := make([]SaleStockLine, 0, len(o.Lines))
	for _, l := range o.Lines {
		lines = append(lines, SaleStockLine{
			OrderLineID:      l.ID,
			ProductVariantID: l.ProductVariantID,
			Quantity:         l.Quantity,
		})
	}

	warnings, err := i.stock.DeductForSale(ctx, SaleStock{
		BranchID: o.BranchID,
		OrderID:  o.ID,
		Lines:    lines,
	})
	if err != nil {
		return nil, fmt.Errorf(
			"order %s: the order is committed but its stock could not be deducted (%v). The "+
				"submission fails so the terminal retries; the retry is a no-op for any deduction "+
				"that already landed, because a stock movement's id is its order line's id",
			o.ID, err)
	}
	return warnings, nil
}

// holdForConflict stores an order whose terminal-side figures disagree with the
// server's, and moves it to CONFLICT_HELD.
//
// It is a separate method because "refuse and drop" and "hold and inspect" are very
// different outcomes for a sale that genuinely happened on a device. The order is
// stored — the money is real and the customer has paid — but it is not applied to
// the authoritative ledger until someone decides.
//
// ── WHY NO STOCK IS DEDUCTED HERE, EXPLICITLY ─────────────────────────────────
//
// This is the one path through Execute that does NOT call deductStock, and it is a
// decision rather than an oversight.
//
// `CONFLICT_HELD` means the order is stored and INSPECTABLE but deliberately NOT
// APPLIED — the ledger row itself says so, and the terminal is told to stop retrying.
// The stock movement ledger records facts that were APPLIED; appending a movement
// for an order nobody has applied would make `stock_movements` a record of
// submissions rather than of things that happened, and the balance would then
// disagree with the orders that were actually settled.
//
// THE OPEN OBLIGATION, STATED SO IT IS NOT FORGOTTEN: resolving a held order —
// approving it, or voiding it — must deduct or credit stock at that point. That
// resolution path does not exist yet; `OrderStatus.Transition` moves the status but
// nothing consumes stock. Until it does, a held order's ingredients stay on the
// shelf, which UNDER-deducts rather than over-deducts: the safe direction to be
// wrong in, and visible to whoever reconciles the conflict.
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
		// Set for the same reason as the ACKNOWLEDGED item above: appended already
		// terminal, so the ledger requires the timestamp of that decision.
		ProcessedAt: &now,
	}
	if err := i.outbox.Append(ctx, item); err != nil {
		return Result{}, fmt.Errorf("order %s: recording the held outbox item: %w", priced.ID, err)
	}

	result := Result{OrderID: priced.ID, State: sync.StateConflictHeld, Totals: authoritative}
	// No stock_warnings: a held order is not applied, so it consumes nothing. See
	// this method's note on why that is a decision rather than an omission.
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

func (i *IngestOrder) processVoid(
	ctx context.Context,
	req IngestRequest,
	key sync.IdempotencyKey,
	now time.Time,
) (Result, error) {
	existing, err := i.orders.Get(ctx, req.Order.ID)
	if err != nil {
		return Result{}, fmt.Errorf("order %s: fetching for void: %w", req.Order.ID, err)
	}

	newStatus := req.Order.Status
	if err := existing.Status.ValidateTransition(newStatus); err != nil {
		return Result{}, &ValidationError{Reason: "invalid void transition: " + err.Error(), Err: err}
	}

	if err := i.orders.UpdateStatus(ctx, existing.ID, existing.Status, newStatus, now); err != nil {
		return Result{}, fmt.Errorf("order %s: updating status to %s: %w", existing.ID, newStatus, err)
	}

	if newStatus == order.StatusVoided {
		lines := make([]SaleStockLine, 0, len(existing.Lines))
		for _, l := range existing.Lines {
			lines = append(lines, SaleStockLine{
				OrderLineID:      l.ID,
				ProductVariantID: l.ProductVariantID,
				Quantity:         l.Quantity,
			})
		}
		if err := i.stock.ReverseForVoid(ctx, SaleStock{
			BranchID: existing.BranchID,
			OrderID:  existing.ID,
			Lines:    lines,
		}); err != nil {
			return Result{}, fmt.Errorf("order %s: reversing stock: %w", existing.ID, err)
		}
	}

	resp := fmt.Sprintf(`{"order_id":"%s","status":"%s"}`, existing.ID, newStatus)
	rec, err := sync.NewIdempotencyRecord(key, existing.ID, sync.StateAcknowledged, resp, now)
	if err != nil {
		return Result{}, err
	}
	if err := i.idem.Save(ctx, rec); err != nil {
		return Result{}, err
	}

	return Result{OrderID: existing.ID, State: sync.StateAcknowledged, Response: resp}, nil
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
//
// ── WHY `stock_alerts` IS OMITTED RATHER THAN EMITTED EMPTY ───────────────────
//
// The overwhelmingly common case is a sale that consumed stock normally, and then
// the field would be `"stock_alerts":[]` on every single acknowledgement — noise
// every client has to parse and every reader has to look past to find the field
// that matters. Omitting it entirely means "nothing went below zero" is the
// ABSENCE of a key, which is unambiguous and costs nothing to detect.
//
// This also keeps the pre-existing acknowledgement BYTE-IDENTICAL for every sale
// that did not oversell. That response is stored for 24 hours and replayed
// verbatim on a retry, so its shape is a compatibility promise rather than an
// implementation detail — and the tests at ingest_order_test.go assert on it.
func renderAcknowledged(o order.Order, totals order.Totals, warnings []StockWarning) string {
	base := fmt.Sprintf(
		`{"order_id":"%s","branch_id":"%s","status":"%s","total_satang":"%s","taxable_satang":"%s","tax_satang":"%s","vat_rate_bp":%d`,
		o.ID, o.BranchID, o.Status,
		totals.TotalSatang.String(), totals.NetSatang().String(), totals.TaxSatang().String(),
		totals.TaxSplit.RateBp)

	if len(warnings) == 0 {
		return base + "}"
	}

	var b strings.Builder
	b.WriteString(base)
	b.WriteString(`,"stock_alerts":[`)
	for i, w := range warnings {
		if i > 0 {
			b.WriteByte(',')
		}
		// `on_hand_milli` is a plain integer, NOT a quoted decimal string and not a
		// `*_satang` field: it is a milli-unit count, and the contract carries
		// quantities as decimal STRINGS only for the `Quantity` schema on the wire's
		// own endpoints. This acknowledgement is not that schema, and inventing a
		// second spelling of a quantity here would be the exact drift the money
		// guards exist to prevent.
		fmt.Fprintf(&b,
			`{"inventory_item_id":"%s","name_th":%s,"unit":%s,"on_hand_milli":%d}`,
			w.InventoryItemID, jsonString(w.NameTH), jsonString(w.Unit), w.OnHandMilli)
	}
	b.WriteString("]}")
	return b.String()
}

// jsonString renders a Go string as a JSON string literal.
//
// Hand-rolled rather than pulled from `encoding/json` because the only values that
// reach it are an article's Thai name and its unit — neither of which may contain a
// quote or a backslash in practice, but "in practice" is not a guarantee, and an
// unescaped quote in a name would produce a stored response that no client can
// parse. Ten lines is cheaper than a permanently-latent malformed ACK.
//
// Control characters are escaped rather than passed through, because a raw newline
// inside a JSON string literal is invalid JSON even though it is a perfectly legal
// character in a Thai product name pasted from a supplier's spreadsheet.
func jsonString(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
				continue
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
