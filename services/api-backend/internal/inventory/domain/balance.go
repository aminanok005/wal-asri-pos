package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// StockBalance — the derived quantity, and the ONLY place negative is meaningful
// ─────────────────────────────────────────────────────────────────────────────
//
// A balance is not stored because somebody counted a shelf. It is stored because
// movements were appended, and those movements sum to it:
//
//	sum(stock_movements.quantity_milli) == stock_balances.on_hand_milli
//
// That identity is the ledger's whole reason for existing, and the integration
// suite asserts it against a live database rather than trusting this comment.
//
// ── WHY ON HAND, AND NOT "STOCK", AND NOT "QUANTITY" ───────────────────────────
//
// The name follows the contract's `StockBalance.on_hand` exactly. It reads oddly
// in a Go struct next to a `reserved` field and a `quantity` on a movement, and
// that mild awkwardness is worth keeping: "stock" is the vague word that this
// system refuses to have a field for, because a vague field name is how
// `on_hand` and `available` end up meaning the same thing in two files.
//

// StockBalance is the derived quantity of one article on hand at one branch.
type StockBalance struct {
	ID identity.UUIDv7

	// The article and the branch it belongs to. An article belongs to exactly one
	// branch, so these are redundant by construction — recorded anyway, because
	// `branch_id` is what every read is scoped by and a balance that must be JOINed
	// to reach its branch cannot be filtered by one.
	InventoryItemID identity.UUIDv7
	BranchID        identity.UUIDv7

	// OnHand is the quantity physically on the shelf, in MILLI-UNITS.
	//
	// SIGNED, deliberately. See the package header: a terminal that oversells
	// offline produces a real, already-honoured sale, and refusing to record the
	// shortage hides the one fact an operator needs. A café in a basement branch
	// selling its last 0.250 kg of beans must sync, must commit, and must leave a
	// -250 behind for someone to act on.
	OnHand money.Quantity

	// Reserved is committed to open orders but not yet deducted, in milli-units.
	//
	// BOUNDED BELOW AT ZERO, and the asymmetry with OnHand is deliberate rather
	// than inconsistent:
	//
	//	a negative on_hand  says "we already oversold; go and buy more"
	//	a negative reserved says "the arithmetic is broken; ignore it"
	//
	// Only the first is a fact about the shop. The second would report more
	// available stock than physically exists, which is "the one direction of drift
	// that sells product a shop does not have" (terminal 0003_stock_balances.sql).
	Reserved money.Quantity

	// LastMovementID is the movement that produced this balance. The contract:
	// "The `StockMovement` that produced this balance. Lets a client verify the
	// derivation." That is exactly its purpose, and it is why a client holding a
	// balance can check the ledger rather than trusting the projection.
	LastMovementID *identity.UUIDv7

	Version   Version
	CreatedAt time.Time
	UpdatedAt time.Time
}

// IsOversold reports whether the shelf is below zero.
//
// THE WARNING CONDITION, and the whole of what the ratified policy does with a
// shortage: the deduction COMMITS regardless and this reports the fact upward.
//
// A method rather than a bare field comparison because it is read in three
// places that must not drift — the usecase that decides to warn, the integration
// test that proves a negative committed, and eventually the operator UI — and
// "below zero" is not a phrase any of them should spell differently.
func (b StockBalance) IsOversold() bool { return b.OnHand.IsNegative() }

// Available is the quantity free to sell: on_hand minus reserved.
//
// The contract states it as "Available-to-sell is `on_hand - reserved`", so this
// is that line and no more.
//
// It may be negative for the same reason OnHand may, and the subtraction is done
// by the money kernel rather than by arithmetic on `.Milli()` here — `Quantity.Sub`
// is range-checked, and a raw subtraction would bypass the `decimal(12,3)` bound
// that the schema and the wire both enforce.
func (b StockBalance) Available() (money.Quantity, error) {
	available, err := b.OnHand.Sub(b.Reserved)
	if err != nil {
		return money.Quantity{}, fmt.Errorf(
			"inventory: balance %s of article %s has an available-to-sell that leaves decimal(12,3): %w",
			b.ID, b.InventoryItemID, err)
	}
	return available, nil
}

// Validate re-derives the invariants this balance must satisfy.
//
// `reserved >= 0` is the only one, and it is here rather than only in SQL for the
// reason `Totals.Validate` re-checks the order's arithmetic: this is the check a
// caller runs against a value that ARRIVED from somewhere, and a projection read
// out of the database should not be trusted merely because it was read from the
// database.
//
// Note what is absent: no `on_hand >= 0`. That absence is the ratified policy and
// is documented at length in the package header and in 0002_inventory.sql. It is
// called out once more here because this is the function someone would otherwise
// "fix".
func (b StockBalance) Validate() error {
	if b.ID.IsZero() {
		return fmt.Errorf("inventory: a balance needs an id")
	}
	if b.InventoryItemID.IsZero() {
		return fmt.Errorf("inventory: balance %s has no article; a balance belongs to something being counted", b.ID)
	}
	if b.BranchID.IsZero() {
		return fmt.Errorf("inventory: balance %s has no branch; balances are per branch", b.ID)
	}
	if b.Reserved.IsNegative() {
		return fmt.Errorf(
			"inventory: balance %s of article %s reserves %s, which is negative; a negative "+
				"reservation is not a debt, it reports more available stock than exists",
			b.ID, b.InventoryItemID, b.Reserved)
	}
	return nil
}
