// Package domain holds the inventory module's business rules in pure Go.
//
// ── LAYER RULE ────────────────────────────────────────────────────────────────
//
// Nothing here may import a database driver, an HTTP framework, `context`, or
// another module's `usecase/` or `adapter/`. It imports exactly two shared
// kernels — `internal/money/domain` for `Quantity` and `internal/identity/domain`
// for keys — and the constraint is tested, not merely intended: see
// internal/architecture/layers_test.go, which walks every module so one added
// tomorrow is checked without anyone remembering to.
package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
)

// AuditAction is what an operator or a terminal did, recorded in `audit_log`.
//
// An OPEN VOCABULARY rather than an enum, for the same reason
// `sync_outbox.entity_type` is a string: the set of actions is owned by the
// device and reporting layers, and inventing an enum here would fork it. The
// two legal values today are `stock_reconcile` (a balance realignment) and
// `stock_adjust` (a terminal's resolved quantity claim). The column is wide
// enough for both without constraining the future.
type AuditAction string

const (
	AuditStockReconcile AuditAction = "stock_reconcile"
	AuditStockAdjust    AuditAction = "stock_adjust"
)

// IsValid reports whether a is one of the known audit actions.
//
// Kept parallel to MovementType.IsValid so the vocabulary has exactly one
// definition per module, and a future migration adds no second spelling.
func (a AuditAction) IsValid() bool {
	switch a {
	case AuditStockReconcile, AuditStockAdjust:
		return true
	}
	return false
}

// AuditLog is one row of the server-side audit trail.
//
// ── WHY THIS IS A DOMAIN TYPE AND NOT A DTO ───────────────────────────────────
//
// It is the business meaning of "who did what", and the HTTP adapter maps the
// wire onto it and back. Keeping it here means the vocabulary lives in one
// place and the adapter cannot invent a new action by accident.
//
// ── APPEND-ONLY ───────────────────────────────────────────────────────────────
//
// The `audit_log` table has triggers refusing UPDATE and DELETE, so a row in
// the database cannot be amended. This type carries no methods that mutate
// it, and the adapter always INSERTs a fresh one — there is no Update on the
// port this type feeds.
//
// ── WHY actor_id IS A STRING AND NOT A UUID ───────────────────────────────────
//
// Two different actors write this table and carry different identifiers. A
// terminal claim arrives with `actorTerminalId` as an opaque string — the
// terminal's device id, which the sync layer authenticates but never parses as
// a UUID. A reconcile arrives with an operator id the reporting module may
// mint as anything. Forcing both into a UUID column would mean rejecting a
// legal terminal id or inventing a UUID for an operator nobody has. The
// column holds both without a conversion step whose only possible effect is
// an error, and the audit row's point is to record WHO, not to validate their
// identity format.
type AuditLog struct {
	ID         identity.UUIDv7
	ActorType  string
	ActorID    string
	BranchID   identity.UUIDv7
	Action     AuditAction
	EntityType string
	EntityID   identity.UUIDv7
	Detail     AuditDetail
	CreatedAt  time.Time
}

// AuditDetail is the JSONB payload of an audit row.
//
// `detail` is `jsonb` in the schema rather than a structured column, because
// the content of an audit record is a FACT ABOUT AN ACTION and the set of facts
// grows with the actions. Two reconcile rows share a shape; a future
// `stock_adjust` row will not. A free-form object is the honest shape, and
// the schema enforces that it is an object (json_type = 'object') so a row
// cannot silently hold a scalar nobody can interpret.
//
// Both fields are exported so the adapter can marshal them without a
// per-action switch.
type AuditDetail struct {
	Reason string `json:"reason,omitempty"`
	// For a reconcile: the per-article corrections.
	Corrections []AuditCorrection `json:"corrections,omitempty"`
	// For a stock_adjust: the delta the terminal claimed.
	DeltaMilli *int64 `json:"delta_milli,omitempty"`
	// For a stock_adjust: the balance after the adjustment, in milli-units.
	BalanceAfterMilli *int64 `json:"balance_after_milli,omitempty"`
}

// AuditCorrection is one article a reconcile realigned.
//
// `before` and `after` are the balance as it stood and as it was written, in
// milli-units. They are raw int64 rather than `money.Quantity` because this
// struct travels inside the audit row's `detail` JSONB, and the contract's
// `Quantity` string pattern is a wire rule — it has nothing to say about a
// value that is never on the wire.
type AuditCorrection struct {
	InventoryItemID identity.UUIDv7 `json:"inventory_item_id"`
	BeforeMilli    int64            `json:"before_quantity_milli"`
	AfterMilli     int64            `json:"after_quantity_milli"`
}

// Validate checks an audit row on the way in.
func (a AuditLog) Validate() error {
	if a.ID.IsZero() {
		return fmt.Errorf("inventory: an audit row needs an id")
	}
	if a.ActorType == "" {
		return fmt.Errorf("inventory: audit row %s has no actor_type; an audit record of nothing is not a record", a.ID)
	}
	if a.BranchID.IsZero() {
		return fmt.Errorf("inventory: audit row %s has no branch; every audit row belongs to a branch", a.ID)
	}
	if !a.Action.IsValid() {
		return fmt.Errorf("inventory: audit row %s has action %q, which is not a known audit action", a.ID, a.Action)
	}
	if a.EntityType == "" {
		return fmt.Errorf("inventory: audit row %s has no entity_type", a.ID)
	}
	if a.EntityID.IsZero() {
		return fmt.Errorf("inventory: audit row %s has no entity_id; an audit record must name what it is about", a.ID)
	}
	if a.CreatedAt.IsZero() {
		return fmt.Errorf("inventory: audit row %s has no created_at", a.ID)
	}
	return nil
}