package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Order status — an APPEND-ONLY ladder
// ─────────────────────────────────────────────────────────────────────────────
//
// The vocabulary here is NOT invented. It is the one the terminal already
// enforces in two places that must agree:
//
//	apps/pos-desktop/src-tauri/migrations/0001_init.sql:153
//	  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
//	    ('draft','submitted','in_preparation','ready','served','completed',
//	     'void_requested','voided'))
//
//	apps/pos-desktop/src/features/sales/infrastructure/tauriOfflineOrders.ts:152
//	  const ORDER_STATUSES = new Set<OfflineOrderStatus>([ ...the same eight... ])
//
// That is a third encoding of this ladder (after the two above: a SQL CHECK and a
// TS set) so it is worth stating where it came from — a server that disagrees
// with its own clients about a status vocabulary cannot ingest anything they send.
//
// ── WHY THE LADDER ONLY GOES FORWARD ─────────────────────────────────────────
//
// ARCHITECTURE-DEMO.md §9, "Conflict rules": "Orders: append-only, never edited,
// so no conflict. Corrections are refund/void documents."
//
// An order is a record of a sale that happened. It does not get updated to reflect
// a different sale; a mistake is corrected by voiding the order and issuing a
// refund or a replacement. That is what makes order sync conflict-free: there is
// no edit for two devices to disagree about, so there is nothing to reconcile and
// no `CONFLICT_HELD` outcome for an order — only for a price or a stock balance.
//

// OrderStatus is one rung of the order ladder.
type OrderStatus string

// The ladder, in order. Exactly the eight values the terminal's SQL CHECK and TS
// set permit — no more, no fewer.
const (
	StatusDraft         OrderStatus = "draft"
	StatusSubmitted     OrderStatus = "submitted"
	StatusInPreparation OrderStatus = "in_preparation"
	StatusReady         OrderStatus = "ready"
	StatusServed        OrderStatus = "served"
	StatusCompleted     OrderStatus = "completed"
	StatusVoidRequested OrderStatus = "void_requested"
	StatusVoided        OrderStatus = "voided"
)

// ladderRank gives each rung its position. A rung missing from this map is not a
// status this server knows, and every entry point rejects it.
var ladderRank = map[OrderStatus]int{
	StatusDraft:         0,
	StatusSubmitted:     1,
	StatusInPreparation: 2,
	StatusReady:         3,
	StatusServed:        4,
	StatusCompleted:     5,

	// The void branch. It is a branch, not a continuation: `void_requested` may
	// become `voided` or return to the ladder, and once `voided` the order is
	// terminal.
	StatusVoidRequested: 6,
	StatusVoided:        7,
}

// IsValid reports whether s is one of the eight known rungs.
func (s OrderStatus) IsValid() bool {
	_, ok := ladderRank[s]
	return ok
}

// CanTransitionTo reports whether an order may move from s to next.
//
// The rules, and the reasoning behind the two that are not obvious:
//
//  1. Rungs advance strictly forward along the main ladder. `draft` cannot rewind
//     to nothing, and `completed` cannot go back to `ready`. Orders are
//     append-only: a sale that happened is not rewritten.
//
//  2. `draft` may go DIRECTLY to `voided`. A draft was never submitted, so there is
//     nothing a supervisor needs to approve — cancelling an unsent order is not a
//     void of a sale, it is abandoning one.
//
//  3. `completed` may NOT go directly to `voided`. It must pass through
//     `void_requested` first, because DOMAIN.md models a void as a separate
//     append-only document with a supervisor decision, and a direct jump would
//     void a completed sale with nobody having approved it. This is the single
//     most important rule in this method.
//
//  4. `void_requested` resolves to EXACTLY ONE of two states: `voided`
//     (approved) or `completed` (rejected). Not an arbitrary rung. A void request
//     is raised against a completed sale, so those are the only two outcomes that
//     mean anything; anything else would let a void request silently demote an
//     order.
//
//  5. `voided` is terminal. A voided order is corrected with a refund document,
//     never by moving the order again.
func (s OrderStatus) CanTransitionTo(next OrderStatus) bool {
	from, ok := ladderRank[s]
	if !ok {
		return false
	}
	to, ok := ladderRank[next]
	if !ok {
		return false
	}

	switch s {
	case StatusVoided:
		// Rule 5: terminal.
		return false

	case StatusVoidRequested:
		// Rule 4: resolves to approved or rejected, nothing else.
		return next == StatusVoided || next == StatusCompleted

	case StatusDraft:
		// Rule 2 plus the ordinary forward moves, plus raising a void request.
		return to > from || next == StatusVoided

	default:
		// Rule 1 plus rule 3: forward, or raise a void request — but never straight
		// to voided. The explicit guard on StatusVoided is what enforces rule 3,
		// because `voided` sits later in the ladder than every main rung and would
		// otherwise be reachable by the ordinary "forward" clause alone.
		if next == StatusVoided {
			return false
		}
		return to > from || next == StatusVoidRequested
	}
}

// ValidateTransition returns a descriptive error, or nil when the move is legal.
//
// A method rather than a bare bool because the interesting failures need saying
// WHY, and a sync conflict that arrives as `false` gets logged as "invalid" and
// investigated by someone who has to re-derive all of this to learn that an order
// cannot rewind.
func (s OrderStatus) ValidateTransition(next OrderStatus) error {
	if !s.IsValid() {
		return fmt.Errorf("order: %q is not a known order status", s)
	}
	if !next.IsValid() {
		return fmt.Errorf("order: %q is not a known order status", next)
	}
	if s.CanTransitionTo(next) {
		return nil
	}
	switch {
	case s == StatusVoided:
		return fmt.Errorf(
			"order: a voided order is terminal and cannot become %q; "+
				"correct it with a refund document, not by moving the order (ARCHITECTURE-DEMO.md §9)", next)
	case s == StatusVoidRequested:
		return fmt.Errorf(
			"order: a void request resolves to voided (approved) or completed (rejected), not to %q", next)
	case s == StatusDraft && next == StatusVoided:
		return fmt.Errorf("order: an unrecognised transition %q -> %q", s, next)
	default:
		if next == StatusVoided {
			return fmt.Errorf(
				"order: %q cannot become voided directly; a void must be requested (void_requested) "+
					"and approved, so the supervisor decision is recorded (DOMAIN.md, VoidRequest)", s)
		}
		return fmt.Errorf(
			"order: %q cannot advance to %q; the ladder is append-only and orders are never "+
				"rewound (ARCHITECTURE-DEMO.md §9)", s, next)
	}
}

// OrderType distinguishes a dine-in sale from a takeaway.
//
// DOMAIN.md names the column `order_type` without enumerating it, so this
// constant set is deliberately limited to the one distinction the rest of the
// system actually branches on. Widening it is a decision for whoever owns the
// order model, not a guess made here.
type OrderType string

const (
	// OrderTypeDineIn is a sale consumed on the premises.
	OrderTypeDineIn OrderType = "dine_in"
	// OrderTypeTakeaway is a sale taken away.
	OrderTypeTakeaway OrderType = "takeaway"
)

// OrderSource records how the order entered the system.
//
// The reason this is a distinct axis from OrderType: an order created OFFLINE on a
// terminal and synced later is still a takeaway taken at the counter. Sync
// provenance and fulfilment are different questions, and collapsing them into one
// enum loses the ability to say "this came in over sync, arrived late, and needs
// reviewing" — which is precisely the population the sync conflict queue exists
// to find.
type OrderSource string

// ── THE VOCABULARY IS THE CONTRACT'S, AND IT USED NOT TO BE ────────────────────
//
// These three values were `terminal`, `mobile` and `back_office`. Both
// contracts/openapi.yaml (`OrderSource`) and the terminal's own
// `0001_init.sql` CHECK said `pos_desktop`, `pos_mobile` and `admin`, and this Go
// service would have written values its own schema rejected on the first insert.
//
// It drifted because nothing had ever compared them: the constants were referenced
// only from tests, and the Postgres driver was a skeleton returning
// ErrNotImplemented, so no round trip could surface the disagreement.
//
// The contract wins, because it is the declared Single Source of Truth and the
// terminal's CHECK is already deployed on real devices — renaming the other way
// would fork a vocabulary that two other layers have committed to. `IsValid` and the
// test below now pin it, so a fourth vocabulary cannot appear quietly.
const (
	// OrderSourcePosDesktop is created on the desktop POS terminal. Normal case.
	OrderSourcePosDesktop OrderSource = "pos_desktop"
	// OrderSourcePosMobile is created on the mobile/tablet client.
	OrderSourcePosMobile OrderSource = "pos_mobile"
	// OrderSourceAdmin is entered by staff at the back office.
	OrderSourceAdmin OrderSource = "admin"
)

// knownOrderSources is the closed set, matching the contract's enum.
var knownOrderSources = map[OrderSource]bool{
	OrderSourcePosDesktop: true,
	OrderSourcePosMobile:  true,
	OrderSourceAdmin:      true,
}

// IsValid reports whether s is one of the three sources in the contract's enum.
//
// Closed on purpose. An unrecognised source is a client sending something the
// contract does not describe, and storing it would put an ungroupable value in an
// end-of-shift report that groups by source.
func (s OrderSource) IsValid() bool { return knownOrderSources[s] }

// Order is the order aggregate.
//
// The header holds the priced `Totals` and the status ladder; the lines are the
// detail. Both are needed to interpret either — a total without lines cannot be
// audited, and lines without the header's rate cannot be re-priced.
type Order struct {
	ID identity.UUIDv7

	// BranchID is NOT NULL and ALWAYS recorded, even though it can be derived
	// from the terminal. Recorded rather than derived because the branch a sale
	// happened in is a fact about the sale, and a terminal that has since been
	// reassigned must not rewrite the history of what it sold.
	BranchID identity.UUIDv7

	TerminalID identity.UUIDv7
	// StaffUserID is the operator. Nil for a kiosk or an unauthenticated terminal.
	StaffUserID *identity.UUIDv7
	// DiningTableID is nil for a takeaway.
	DiningTableID *identity.UUIDv7
	CustomerID    *identity.UUIDv7

	Type   OrderType
	Status OrderStatus
	Source OrderSource

	// Totals is the priced header, produced by ComputeTotals and never adjusted
	// by hand afterwards.
	Totals Totals

	// Lines are the order detail, in receipt order.
	Lines []OrderLine

	// StatusAt is when the status last changed.
	StatusAt time.Time
	Notes    string

	CreatedAt time.Time
	UpdatedAt time.Time
}

// NewOrder builds a priced order and proves it internally consistent.
//
// This is the ONLY way an Order should come into existence in this process, and it
// prices from the lines rather than accepting a total from the caller. A
// constructor that took `total_satang` as a parameter would be one parameter away
// from being the bug this whole module prevents.
func NewOrder(
	id, branchID, terminalID identity.UUIDv7,
	orderType OrderType,
	source OrderSource,
	lines []OrderLine,
	discount, serviceCharge, roundingAdjustment money.Satang,
	vatRateBp money.BasisPoints,
	now time.Time,
) (Order, error) {
	subtotal, err := SubtotalSatang(lines)
	if err != nil {
		return Order{}, err
	}
	totals, err := ComputeTotals(subtotal, discount, serviceCharge, roundingAdjustment, vatRateBp)
	if err != nil {
		return Order{}, fmt.Errorf("order %s: %w", id, err)
	}

	o := Order{
		ID:         id,
		BranchID:   branchID,
		TerminalID: terminalID,
		Type:       orderType,
		Status:     StatusDraft,
		Source:     source,
		Totals:     totals,
		Lines:      lines,
		StatusAt:   now.UTC(),
		CreatedAt:  now.UTC(),
		UpdatedAt:  now.UTC(),
	}
	return o, nil
}

// Validate re-derives everything and proves the stored figures agree.
//
// This is the server's ingest-time obligation. SKILL.md §2.3: "Server Domain
// (`internal/{feature}/domain/`): Authoritative Go domain logic. Re-validates all
// client data on ingest."
//
// An order arrives from an offline terminal carrying its own pricing. The server
// re-prices it from the lines, at ITS OWN `vat_rate_bp` for the branch, and
// refuses a mismatch. A terminal that disagrees about VAT — because it used a
// stale rate, or the branch changed rate after the terminal last synced — is
// caught here rather than becoming a receipt the shop cannot file.
func (o Order) Validate() error {
	if o.ID.IsZero() {
		return fmt.Errorf("order: the id is required and must be a client-generated UUIDv7")
	}
	if o.BranchID.IsZero() {
		return fmt.Errorf("order %s: branch_id is not optional; the branch a sale happened in is recorded, not derived", o.ID)
	}
	if !o.Status.IsValid() {
		return fmt.Errorf("order %s: %q is not a known order status", o.ID, o.Status)
	}

	for _, l := range o.Lines {
		if l.OrderID.Compare(o.ID) != 0 {
			return fmt.Errorf(
				"order %s: line %s claims order_id %s, which is a different order; "+
					"an orphan line is a data error, not a line of this order", o.ID, l.ID, l.OrderID)
		}
		if err := l.Validate(); err != nil {
			return err
		}
	}

	subtotal, err := SubtotalSatang(o.Lines)
	if err != nil {
		return err
	}
	if subtotal != o.Totals.SubtotalSatang {
		return fmt.Errorf(
			"order %s: stored subtotal is %d satang but the lines sum to %d",
			o.ID, o.Totals.SubtotalSatang, subtotal)
	}

	if err := o.Totals.Validate(); err != nil {
		return fmt.Errorf("order %s: %w", o.ID, err)
	}
	return nil
}

// CanTransitionTo reports whether this order may move to next.
func (o Order) CanTransitionTo(next OrderStatus) bool { return o.Status.CanTransitionTo(next) }

// Transition advances the order's status and returns the new order.
//
// The original is NOT modified and no error mutates a receiver: an append-only
// ladder whose transition function can leave the order half-advanced is not
// append-only.
//
// `now` is a parameter rather than a call to time.Now() so the transition is
// deterministic and testable — an order's status_at must be reproducible in a
// test that asserts it.
func (o Order) Transition(next OrderStatus, now time.Time) (Order, error) {
	if err := o.Status.ValidateTransition(next); err != nil {
		return Order{}, fmt.Errorf("order %s: %w", o.ID, err)
	}
	moved := o
	moved.Status = next
	moved.StatusAt = now.UTC()
	moved.UpdatedAt = now.UTC()
	return moved, nil
}
