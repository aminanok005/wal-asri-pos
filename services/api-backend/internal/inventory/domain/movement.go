package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// StockMovement — the ledger row, and the ONLY sign convention in this module
// ─────────────────────────────────────────────────────────────────────────────
//
// A movement is APPEND-ONLY and it records a DELTA, never a balance. Those two
// properties together are what "stock is a ledger of movements, never an
// overwritten number" means in practice:
//
//	sum(movements.quantity_milli for one article) == stock_balances.on_hand_milli
//
// Because the quantity is a delta rather than a running total, replaying the same
// movement twice cannot corrupt the answer — it would have to be applied twice to
// do that, and the primary key stops that (see NewSaleDeduction).
//

// MovementType is why stock moved.
//
// DOMAIN.md's `stock_movement_type`, all ten values, verbatim:
//
//	sale | refund | waste | purchase | adjustment_in | adjustment_out |
//	transfer_* | count_correction | combo_component
//
// Only MovementSale is produced by this service today. The other nine are
// declared rather than omitted so the vocabulary has exactly one definition, and
// so a future migration adds no `CHECK` alternative: an enum narrowed to today's
// reachable values is a second place for the vocabulary to fork, which is what
// `order_status`'s eight-rung ladder documents at length
// (internal/order/domain/order.go).
type MovementType string

const (
	// MovementSale is stock consumed by a sale. NEGATIVE by rule.
	MovementSale MovementType = "sale"
	// MovementRefund is stock returned by a refund. Not produced yet: a refund is a
	// separate document (DOMAIN.md, "Corrections are refund/void documents") and no
	// code path in this service creates one.
	MovementRefund MovementType = "refund"
	// MovementWaste is stock written off. Requires an adjustment and an approver.
	MovementWaste MovementType = "waste"
	// MovementPurchase is stock received from a supplier.
	MovementPurchase MovementType = "purchase"
	// MovementAdjustmentIn and MovementAdjustmentOut are counted corrections.
	MovementAdjustmentIn  MovementType = "adjustment_in"
	MovementAdjustmentOut MovementType = "adjustment_out"
	// MovementTransferIn and MovementTransferOut move stock between branches.
	MovementTransferIn  MovementType = "transfer_in"
	MovementTransferOut MovementType = "transfer_out"
	// MovementCountCorrection fixes a balance after a physical count.
	MovementCountCorrection MovementType = "count_correction"
	// MovementComboComponent is stock consumed by a component of a combo.
	MovementComboComponent MovementType = "combo_component"
)

// IsValid reports whether t is one of the ten known types.
func (t MovementType) IsValid() bool {
	switch t {
	case MovementSale, MovementRefund, MovementWaste, MovementPurchase,
		MovementAdjustmentIn, MovementAdjustmentOut,
		MovementTransferIn, MovementTransferOut,
		MovementCountCorrection, MovementComboComponent:
		return true
	}
	return false
}

// IsOutflow reports whether this movement necessarily reduces the balance.
//
// Only `sale` is guaranteed negative, and that is enforced by the schema
// (`stock_movements_sale_is_an_outflow`). The rest are signed by nature: an
// `adjustment_in` restocks a shelf and an `adjustment_out` takes from it, so a
// rule claiming they are one or the other would be wrong for half the vocabulary.
func (t MovementType) IsOutflow() bool { return t == MovementSale }

// StockMovement is one append-only ledger row.
type StockMovement struct {
	// ID is the movement's identity.
	//
	// For a `sale` this IS the order line's id — see NewSaleDeduction, which is
	// where that rule is enforced and the reason is written down.
	ID identity.UUIDv7

	InventoryItemID identity.UUIDv7
	BranchID        identity.UUIDv7
	Type            MovementType

	// QuantityMilli is the SIGNED DELTA TO on_hand, in MILLI-UNITS.
	//
	// Negative removes stock from the shelf; positive adds it. It is the delta and
	// NOT the resulting balance, which is the choice that makes the ledger
	// self-checking: the sum equals the balance, so a disagreement between the two
	// is detectable rather than invisible.
	QuantityMilli money.Quantity

	// ReferenceOrderLineID is the line that caused this movement, for a `sale`.
	ReferenceOrderLineID *identity.UUIDv7

	// Source records what produced the movement. `"sync_ingest"` is the only value
	// written today, and it exists so a future movement from a stock count, a
	// purchase receipt or a transfer can be told apart in a reconciliation without
	// inferring it from the type.
	Source string

	CreatedAt time.Time
	CreatedBy *identity.UUIDv7
}

// Validate checks a movement on the way in.
func (m StockMovement) Validate() error {
	if m.ID.IsZero() {
		return fmt.Errorf("inventory: a movement needs an id; for a sale it is the order line's id")
	}
	if m.InventoryItemID.IsZero() {
		return fmt.Errorf("inventory: movement %s has no article; a movement changes some shelf", m.ID)
	}
	if m.BranchID.IsZero() {
		return fmt.Errorf("inventory: movement %s has no branch", m.ID)
	}
	if !m.Type.IsValid() {
		return fmt.Errorf(
			"inventory: movement %s has type %q, which is not one of the ten stock_movement_type values", m.ID, m.Type)
	}
	if m.QuantityMilli.IsZero() {
		return fmt.Errorf(
			"inventory: movement %s is zero; a ledger row that changes nothing is noise that later "+
				"has to be explained, and the sum it contributes is 0", m.ID)
	}
	if m.Type.IsOutflow() && !m.QuantityMilli.IsNegative() {
		return fmt.Errorf(
			"inventory: movement %s is a %s of %s, but a %s must remove stock; stock left the shelf "+
				"and came back in the same row", m.ID, m.Type, m.QuantityMilli, m.Type)
	}
	return nil
}

// Deduction is a movement that has NOT YET been persisted.
//
// It is a distinct type rather than a `StockMovement` because the two have
// different honesty requirements. A `StockMovement` in the database is a fact
// that happened. A `Deduction` is an intention produced by the use case, which
// may still fail to apply. Keeping them apart means there is no way to hand an
// adapter a "movement" that was never written and no way for one to read back a
// movement as though it were merely proposed.
//
// It is also the ONLY type the deduction use case constructs, which is what
// guarantees that only the sign convention NewSaleDeduction knows can reach the
// ledger through this path.
type Deduction struct {
	Movement StockMovement
}

// NewSaleDeduction builds the deduction for one sold order line.
//
// ── THE ONE PLACE THE SIGN IS DECIDED ─────────────────────────────────────────
//
// `delta = -quantity`. One sold item consumes stock, so the shelf loses exactly
// what the receipt says was taken, and the arithmetic is a negation of the
// quantity the TERMINAL computed rather than a fresh calculation — which is the
// point, and it is why this function takes the line's quantity instead of
// re-deriving it.
//
// Re-deriving would be the more "authoritative" thing to do and would be wrong
// here. The server already re-prices the order and refuses a mismatch
// (IngestOrder.Execute, steps 2 and 3), so by the time a deduction exists the
// quantities are agreed. Computing a second answer from a recipe that this service
// cannot even see (there is no Recipe in the contract) would introduce a
// discrepancy with no way to adjudicate it.
//
// ── WHY THE MOVEMENT ID IS THE ORDER LINE'S ID ────────────────────────────────
//
// Three reasons, in order of how much each matters:
//
//  1. THE SERVER MUST NOT MINT IT. `internal/identity/domain/uuidv7.go` has no
//     generator, deliberately: "the server may NEVER mint an id for a record the
//     client created." A sale movement is caused by a record the client created,
//     offline, and its id is already in the payload.
//
//  2. IT MAKES DOUBLE-DEDUCTION IMPOSSIBLE RATHER THAN UNLIKELY. The ledger's
//     primary key is this id, so a terminal that retries the batch that carried
//     this line — the normal case, since it cannot distinguish a lost response
//     from a crash — hits SQLSTATE 23505 and the adapter turns it into a no-op.
//     A server-generated id would have made that guarantee depend on the
//     idempotency store instead, which is precisely the window
//     `IngestOrder.Execute` documents as unsafe.
//
//  3. THE HISTORY IS READABLE. `stock_movements.reference_order_line_id` then
//     points at a row that exists in `order_lines`, so an operator asking "why is
//     the flour at -0.750?" gets an actual receipt rather than a server sequence
//     to cross-reference.
//
// The schema enforces the same rule (`stock_movements_id_is_the_order_line`), so a
// future caller cannot bypass this constructor and invent an id for a sale.
func NewSaleDeduction(item InventoryItem, orderLineID identity.UUIDv7, quantity money.Quantity, now time.Time) (Deduction, error) {
	if item.ID.IsZero() {
		return Deduction{}, fmt.Errorf("inventory: cannot deduct against an article with no id")
	}
	if orderLineID.IsZero() {
		return Deduction{}, fmt.Errorf(
			"inventory: article %s cannot be deducted without an order line; the line's id is the "+
				"movement's id, and that is what makes a retry a no-op instead of a second deduction", item.ID)
	}
	if quantity.IsZero() {
		return Deduction{}, fmt.Errorf(
			"inventory: order line %s has a quantity of zero; deducting it would append a ledger row "+
				"that changes nothing", orderLineID)
	}

	// The negation is the arithmetic. money.Quantity has no Negate method because
	// the only negation in this module is this one, and a general one would invite
	// the sign error this function exists to make impossible.
	//
	// The magnitude cannot exceed maxQuantityMilli (it came from a Quantity), so
	// the negation cannot leave decimal(12,3) — but the range check is still made
	// rather than assumed, because the alternative is a silently out-of-range
	// ledger row that the schema CHECK would refuse at COMMIT with a constraint
	// name and no context.
	consumed, err := money.NewQuantityFromMilli(-quantity.Milli())
	if err != nil {
		return Deduction{}, fmt.Errorf(
			"inventory: order line %s consumes %s of article %s, which cannot be recorded as a delta: %w",
			orderLineID, quantity, item.ID, err)
	}

	lineID := orderLineID
	return Deduction{Movement: StockMovement{
		ID:                   orderLineID,
		InventoryItemID:      item.ID,
		BranchID:             item.BranchID,
		Type:                 MovementSale,
		QuantityMilli:        consumed,
		ReferenceOrderLineID: &lineID,
		Source:               "sync_ingest",
		CreatedAt:            now.UTC(),
	}}, nil
}
