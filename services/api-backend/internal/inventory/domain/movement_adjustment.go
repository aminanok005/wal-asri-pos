package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ── StockAdjustment — the ledger row for a terminal's resolved quantity claim ──
//
// A terminal that reconciled its own shelf locally sends the server a CLAIM:
// "the flour is at 2.500 kg, here is the resolved quantity I counted". The server
// does NOT write that number into `stock_balances` directly. It computes the
// DELTA between the claim and the balance the ledger says is true, and records
// the delta as a movement of type `adjustment_in` or `adjustment_out`. That is
// the only way the claim and the ledger can disagree without one silently
// overwriting the other: the disagreement is a row in the ledger, and an
// operator can see it.
//
// The movement is `adjustment_in`/`adjustment_out` rather than
// `count_correction`, and the distinction is deliberate. A `count_correction`
// is the server's own reconciliation of a balance it has already decided is
// wrong — it is the output of `ReconcileBalances`, which recomputes the balance
// from the movements and writes the difference. A `stock_adjust` is an
// external claim the server is applying on the terminal's behalf, and it is
// keyed on the terminal's own idempotency key so a retry is a no-op. Two
// different verbs for two different sources of truth keeps the ledger readable:
// "the server corrected itself" and "a terminal claimed this" are different
// questions.
//
// ── WHY DELTA AND NOT ABSOLUTE ────────────────────────────────────────────────
//
// Storing the resolved quantity would make the ledger non-self-checking: the
// balance would then be the last movement's quantity, and `sum(quantity_milli)`
// would be meaningless. Storing the delta keeps the identity
// `sum == on_hand` intact, which is what the integration suite asserts.
type StockAdjustment struct {
	Movement StockMovement
}

// NewStockAdjustment builds the movement for one terminal claim.
//
// `deltaMilli` is the SIGNED difference between the terminal's claim and the
// balance the ledger says is true: positive when the terminal counted MORE than
// the ledger (stock is added back), negative when it counted LESS (stock is
// written off). The caller computes it; this constructor only validates that
// the result is a real, non-zero delta that fits the movement's vocabulary.
//
// `auditLogID` is the id of the `audit_log` row this adjustment is written
// alongside, and it becomes the MOVEMENT'S OWN ID. The two rows are therefore
// correlated by construction — `stock_movements.id = audit_log.id` — with no
// extra column to keep in sync across a transaction boundary.
//
// Why the movement borrows the audit id rather than minting its own: the
// movement is the fact about stock and the audit row is the fact about the
// action, and the two MUST be written in ONE transaction. A separate id for
// each would have to be generated before the write begins (or one would point
// at the other by a value nobody had seen yet), and a failure between the two
// inserts would leave an audit row describing a movement that does not exist.
// Sharing the id makes "both or neither" the only possible state.
//
// `actorID` is the terminal's device id as an opaque string. It does NOT go on
// the movement: `stock_movements.created_by` is a UUID in the schema, and the
// terminal's id is a string the sync layer authenticates but never parses.
// Forcing it through a UUID column would mean rejecting a legal id or inventing
// one. The string lives in `audit_log.actor_id` (TEXT), which is what the audit
// trail is for. See `audit_log`'s own header.
func NewStockAdjustment(
	auditLogID identity.UUIDv7,
	item InventoryItem,
	branchID identity.UUIDv7,
	actorID string,
	deltaMilli money.Quantity,
	now time.Time,
) (StockAdjustment, error) {
	if auditLogID.IsZero() {
		return StockAdjustment{}, fmt.Errorf(
			"inventory: a stock adjustment needs an audit_log id; the movement and the audit record are written together")
	}
	if item.ID.IsZero() {
		return StockAdjustment{}, fmt.Errorf("inventory: cannot adjust an article with no id")
	}
	if branchID.IsZero() {
		return StockAdjustment{}, fmt.Errorf("inventory: a stock adjustment needs a branch")
	}
	if deltaMilli.IsZero() {
		// A zero delta is a no-op and must not reach the ledger: a ledger row that
		// changes nothing is noise that a later reconciliation has to explain.
		return StockAdjustment{}, fmt.Errorf(
			"inventory: the terminal's claim matches the ledger; a zero-delta movement is not written")
	}

	// The sign decides the type, and the type decides the CHECK the schema runs.
	// Keeping them in one branch here is what stops a positive `adjustment_out`
	// from being constructed — which would be a movement that removes stock and
	// is positive, the same shape of error `stock_movements_sale_is_an_outflow`
	// exists to prevent.
	//
	// `adjustment_in` is positive (stock added back), `adjustment_out` is negative
	// (stock written off), and the schema's range CHECK accepts both because the
	// vocabulary is signed by nature.
	var mt MovementType
	if deltaMilli.Milli() > 0 {
		mt = MovementAdjustmentIn
	} else {
		mt = MovementAdjustmentOut
	}

	// `created_by` is deliberately nil: the schema column is UUID, and the actor
	// here is a terminal id string that lives in audit_log.actor_id instead.
	return StockAdjustment{Movement: StockMovement{
		ID:                   auditLogID,
		InventoryItemID:      item.ID,
		BranchID:             branchID,
		Type:                 mt,
		QuantityMilli:        deltaMilli,
		ReferenceOrderLineID: nil,
		Source:               "sync_terminal_claim",
		CreatedAt:            now.UTC(),
		CreatedBy:            nil,
	}}, nil
}