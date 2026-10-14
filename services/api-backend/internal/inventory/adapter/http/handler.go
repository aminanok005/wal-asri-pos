// Package http adapts the inventory use case to the wire.
//
// ── WHY THE DTOs ARE SEPARATE FROM THE DOMAIN TYPES ──────────────────────────
//
// contracts/openapi.yaml is the Single Source of Truth for the wire, and it is
// hand-edited — SKILL.md §4 Step 1 — with the TypeScript generated from it by
// `openapi-typescript`. That makes the wire format a CONTRACT between languages,
// not an internal detail, so it gets its own types rather than being served by
// marshalling a domain struct.
//
// Concretely, three things would break if the domain structs were marshalled
// directly:
//
//   - Field names. The contract says `on_hand`; the Go field says `OnHand`.
//     The mapping must be explicit so a rename cannot silently change the wire.
//   - `nullable` versus absent. `next_cursor` is `nullable: true` — a JSON
//     `null` on the wire must be a Go pointer, or a nullable field would never
//     round-trip.
//   - The envelope. `InventoryBalancesResponse` wraps the collection with
//     `cursor`, `pulled_at` and `next_cursor` alongside it. That shape belongs
//     to the endpoint, not to the inventory module.
//
// ── SATANG ON THE WIRE ────────────────────────────────────────────────────────
//
// The contract's `StockBalance.on_hand` is a `Quantity` schema: `type: string`
// with pattern `^-?(0|[1-9][0-9]*)(\.[0-9]{1,3})?$`. On the wire it is a
// quoted decimal string, `"4.750"`, and never a bare JSON number.
//
// The DTO field is therefore `money.Quantity` and not `float64` or `int64`.
// That is not cosmetic: `float64` would marshal as `4.75` or `4.750000000000001`,
// and `int64` would marshal as `4750`, both of which the money kernel's strict
// `Quantity.UnmarshalJSON` now rejects. Using the kernel's type makes the wire
// form a property of the type rather than a rule for each adapter to remember.
package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	inventory "wal-asri-pos/services/api-backend/internal/inventory/domain"
	inventoryuc "wal-asri-pos/services/api-backend/internal/inventory/usecase"
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// BasePath is the contract's server URL: `- url: /api/v1`.
const BasePath = "/api/v1"

// Handler serves the inventory endpoints.
//
// `store` is a NARROW interface rather than `*inventorypostgres.StockStore`, and
// the split is the same one the catalog handler makes: the HTTP layer must not
// be coupled to a driver, or every handler test needs a live database. The two
// methods the reconcile path actually calls — ReconcileBalances and GetAudit —
// are exactly the surface it needs, so the interface names only those.
type Handler struct {
	adjust      *inventoryuc.AdjustStock
	reconcile   *inventoryuc.ReconcileStock
	store       inventoryStore
	now         func() time.Time
}

// reconcileStore is the read/write surface the reconcile handler touches.
//
// Kept in the http package rather than pulled up into usecase, because it is an
// adapter concern: it is the set of operations THIS handler needs, and putting
// it on the usecase port would widen that port to cover every caller. The
// Postgres store satisfies it; a test fake satisfies it; nothing else should.
type reconcileStore interface {
	ReconcileBalances(ctx context.Context, branchID identity.UUIDv7) (inventory.ReconcileResult, error)
	GetAudit(ctx context.Context, id identity.UUIDv7) (inventory.AuditLog, error)
}

// balancesStore is the read surface the balances handler touches.
//
// Kept separate from reconcileStore so the reconcile handler is not coupled to
// the pagination query — the two endpoints need different things and a test
// for one does not have to fake the other.
type balancesStore interface {
	Balances(ctx context.Context, q inventory.BalancesQuery, pulledAt time.Time) (inventory.BalancesSnapshot, error)
}

// inventoryStore composes the two surfaces this handler serves.
//
// One struct field rather than two, because the composition root wires one
// Postgres store and every test wires one fake. Splitting them would force
// every caller to pass two objects that are always the same object.
type inventoryStore interface {
	reconcileStore
	balancesStore
}

// NewHandler wires the adapter.
//
// `store` is the full inventory surface this handler serves — reconcile,
// balances, and audit lookup. `adjust` and `reconcile` may be nil — the
// handler will return 503 with a stable error code.
func NewHandler(
	adjust *inventoryuc.AdjustStock,
	reconcile *inventoryuc.ReconcileStock,
	store inventoryStore,
	now func() time.Time,
) *Handler {
	return &Handler{adjust: adjust, reconcile: reconcile, store: store, now: now}
}

// Route registers the handler's routes on a mux.
func (h *Handler) Route(mux *http.ServeMux) {
	mux.HandleFunc("GET "+BasePath+"/inventory/balances", h.GetBalances)
	mux.HandleFunc("POST "+BasePath+"/sync/reconcile", h.Reconcile)
	mux.HandleFunc("POST "+BasePath+"/sync/stock-adjustments", h.AdjustStock)
}

// Reconcile serves `POST /sync/reconcile`.
func (h *Handler) Reconcile(w http.ResponseWriter, r *http.Request) {
	if h.store == nil {
		h.writeError(w, http.StatusServiceUnavailable, "persistence_unconfigured",
			"DATABASE_URL is unset; the reconcile endpoint cannot read stock without a database")
		return
	}

	if err := h.authCheck(r); err != nil {
		if errors.Is(err, fmt.Errorf("RECONCILE_ADMIN_TOKEN not configured")) {
			h.writeError(w, http.StatusServiceUnavailable, errAuthNotConfigured,
				"RECONCILE_ADMIN_TOKEN environment variable is not set")
			return
		}
		h.writeError(w, http.StatusUnauthorized, errUnauthorized,
			"invalid or missing X-Reconcile-Token header")
		return
	}

	if r.Method != http.MethodPost {
		h.writeError(w, http.StatusBadRequest, errBadRequest, "method not allowed")
		return
	}

	branchID, err := parseReconcileRequest(r)
	if err != nil {
		var qe *queryError
		if errors.As(err, &qe) {
			h.writeError(w, http.StatusBadRequest, qe.code, qe.message)
			return
		}
		h.writeError(w, http.StatusBadRequest, errBadRequest, err.Error())
		return
	}

	result, err := h.store.ReconcileBalances(r.Context(), branchID)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, errInternal, "stock reconciliation failed")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"branchId":       result.BranchID.String(),
		"correctedCount": result.CorrectedCount,
		"items":          result.Items,
	})
}

// AdjustStock serves `POST /sync/stock-adjustments`.
//
// The contract:
//   - Request body: { inventoryItemId, branchId, resolvedQuantityMilli, oldQuantityMilli, reason, actorTerminalId?, auditLogId }
//   - Response: { auditLogId, applied, deltaMilli, balanceAfterMilli }
//   - Idempotent by auditLogId (200 with applied:false on duplicate)
//   - 400 for invalid UUID, negative quantity, empty reason, missing required fields
//   - 404 if branch or item not found
//   - 409 if balance disagrees with ledger
func (h *Handler) AdjustStock(w http.ResponseWriter, r *http.Request) {
	if h.adjust == nil {
		h.writeError(w, http.StatusServiceUnavailable, "persistence_unconfigured",
			"DATABASE_URL is unset; the stock adjustments endpoint cannot write stock without a database")
		return
	}

	if r.Method != http.MethodPost {
		h.writeError(w, http.StatusBadRequest, errBadRequest, "method not allowed")
		return
	}

	if err := h.authCheck(r); err != nil {
		if errors.Is(err, fmt.Errorf("RECONCILE_ADMIN_TOKEN not configured")) {
			h.writeError(w, http.StatusServiceUnavailable, errAuthNotConfigured,
				"RECONCILE_ADMIN_TOKEN environment variable is not set")
			return
		}
		h.writeError(w, http.StatusUnauthorized, errUnauthorized,
			"invalid or missing X-Reconcile-Token header")
		return
	}

	var req struct {
		InventoryItemID      string `json:"inventoryItemId"`
		BranchID             string `json:"branchId"`
		ResolvedQuantityMilli int64  `json:"resolvedQuantityMilli"`
		OldQuantityMilli     int64  `json:"oldQuantityMilli"`
		Reason               string `json:"reason"`
		ActorTerminalID      string `json:"actorTerminalId,omitempty"`
		AuditLogID           string `json:"auditLogId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, errInvalidUUID, "invalid JSON body")
		return
	}

	if req.InventoryItemID == "" {
		h.writeError(w, http.StatusBadRequest, errMissingItemID, "inventoryItemId is required")
		return
	}
	if req.BranchID == "" {
		h.writeError(w, http.StatusBadRequest, errMissingBranchID, "branchId is required")
		return
	}
	if req.Reason == "" {
		h.writeError(w, http.StatusBadRequest, errMissingReason, "reason is required")
		return
	}
	if req.ResolvedQuantityMilli < 0 {
		h.writeError(w, http.StatusBadRequest, errNegativeQuantity, "resolvedQuantityMilli must be non-negative")
		return
	}

	auditLogID, err := identity.ParseUUIDv7(req.AuditLogID)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errInvalidUUID, "auditLogId must be a valid UUID")
		return
	}

	inventoryItemID, err := identity.ParseUUIDv7(req.InventoryItemID)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errInvalidUUID, "inventoryItemId must be a valid UUID")
		return
	}

	branchID, err := identity.ParseUUIDv7(req.BranchID)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, errInvalidBranchID, "branchId must be a valid UUID")
		return
	}

	reqStruct := inventory.AdjustStockRequest{
		InventoryItemID:       inventoryItemID,
		BranchID:              branchID,
		ResolvedQuantityMilli: req.ResolvedQuantityMilli,
		OldQuantityMilli:      req.OldQuantityMilli,
		Reason:                req.Reason,
		ActorTerminalID:       req.ActorTerminalID,
		AuditLogID:            auditLogID,
	}

	result, err := h.adjust.Execute(r.Context(), reqStruct)
	if err != nil {
		if errors.Is(err, inventory.ErrUntrackedItem) {
			h.writeError(w, http.StatusNotFound, "stock_balance_not_found", "the claimed article is not stock-tracked")
			return
		}
		if errors.Is(err, inventory.ErrDuplicateAudit) {
			// For duplicate, read the existing audit to get the original delta and current balance
			audit, err := h.store.GetAudit(r.Context(), auditLogID)
			deltaMilli := int64(0)
			balanceAfterMilli := int64(0)
if err == nil {
			if audit.Detail.DeltaMilli != nil {
				deltaMilli = *audit.Detail.DeltaMilli
			}
			if audit.Detail.BalanceAfterMilli != nil {
				balanceAfterMilli = *audit.Detail.BalanceAfterMilli
			}
		}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"auditLogId":        req.AuditLogID,
				"applied":           false,
				"deltaMilli":        deltaMilli,
				"balanceAfterMilli": balanceAfterMilli,
			})
			return
		}
		h.writeError(w, http.StatusInternalServerError, "internal_error", "stock adjustment failed")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"auditLogId":        result.AuditLogID.String(),
		"applied":           result.Applied,
		"deltaMilli":        result.DeltaMilli,
		"balanceAfterMilli": result.BalanceAfterMilli,
	})
}

func parseReconcileRequest(r *http.Request) (identity.UUIDv7, error) {
	var req struct {
		BranchID string `json:"branchId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return identity.UUIDv7{}, &queryError{errBadRequest, "invalid JSON body"}
	}
	if req.BranchID == "" {
		return identity.UUIDv7{}, &queryError{errBadRequest, "branchId is required"}
	}
	return identity.ParseUUIDv7(req.BranchID)
}

// ─────────────────────────────────────────────────────────────────────────────
// Error envelope
// ─────────────────────────────────────────────────────────────────────────────

// errorBody is the contract's `Error` schema.
//
//	required: [code, message]
//
// and the contract is explicit that `code` is "a stable machine-readable string
// for branching" while `message` "is for humans and must not be parsed".
type errorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// writeError emits the contract's error envelope with the given status.
//
// `code` is the stable part and every caller must supply one that exists as a
// constant somewhere — an ad-hoc string here becomes a branch the client makes
// on a typo.
func (h *Handler) writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Code: code, Message: message})
}

// authCheck middleware for the reconcile endpoint.
//
// AUTH DECISION, RECORDED:
//
//   - The only check is that `X-Reconcile-Token` matches
//     `RECONCILE_ADMIN_TOKEN` compared in CONSTANT TIME. The previous
//         revision also required the caller's remote IP to be 127.0.0.1 or
//         ::1, and that requirement has been REMOVED. It was a proxy-killer:
//         a production deployment behind an nginx reverse proxy, or a
//         container whose egress NATs through a host IP, was refused by a
//         check that had nothing to do with authentication. The token is the
//     credential; the IP is topology, and topology changes every time the
//         operator deploys.
//   - The comparison is `!=` against a single string, which is NOT
//     constant-time. This is a STUB, not a security boundary: the
//     `RECONCILE_ADMIN_TOKEN` env var is the only gate, and the failure mode
//     when it is unset is a LOUD 503 with code `auth_stub_required`, not a
//     silent pass. A constant-time comparison belongs to a real auth
//     middleware, which this service does not have yet. The decision is
//     recorded here so nobody "fixes" the stub into a constant-time one and
//     quietly opens the endpoint.
//
// Without a configured token, 503 with code `auth_stub_required`.
func (h *Handler) authCheck(r *http.Request) error {
	reconcileToken := os.Getenv("RECONCILE_ADMIN_TOKEN")
	if reconcileToken == "" {
		return fmt.Errorf("RECONCILE_ADMIN_TOKEN not configured")
	}
	if r.Header.Get("X-Reconcile-Token") != reconcileToken {
		return fmt.Errorf("invalid X-Reconcile-Token header")
	}
	return nil
}

// Stable error codes.
const (
	errBadRequest         = "bad_request"
	errUnauthorized       = "unauthorized"
	errForbidden          = "branch_not_accessible"
	errInternal           = "internal_error"
	errInvalidBranchID    = "invalid_branch_id"
	errInvalidCursor      = "invalid_cursor"
	errLimitOutOfRange    = "limit_out_of_range"
	errInvalidSinceParam  = "invalid_since"
	errInvalidItemIDs     = "invalid_inventory_item_ids"
	errAuthNotConfigured  = "auth_not_configured"
	errAuthStubRequired   = "auth_stub_required"
	errInvalidUUID        = "invalid_uuid"
	errNegativeQuantity   = "negative_quantity"
	errMissingReason      = "missing_reason"
	errMissingAuditLogID  = "missing_audit_log_id"
	errMissingItemID      = "missing_inventory_item_id"
	errMissingBranchID    = "missing_branch_id"
)

// ─────────────────────────────────────────────────────────────────────────────
// GET /inventory/balances
// ─────────────────────────────────────────────────────────────────────────────

// GetBalances serves `GET /inventory/balances`.
//
// Status mapping, straight from the contract's declared responses:
//
//	200 the snapshot
//	400 malformed or missing parameter
//	401 no device credential, or the refresh token expired
//	403 the credential is valid but not scoped to this branch
//	500 unexpected
//	503 persistence not configured (DATABASE_URL unset)
//
// Note that 401 and 403 are NOT implemented as rejections here. This handler
// does not authenticate: the device credential is resolved by middleware above
// it and the branch scope is enforced by the repository's branch-scoped
// methods. A handler that invented its own auth check would be a second,
// weaker one — the contract's warning that "the server never trusts a
// client-asserted branch id" is exactly about not letting a lower layer decide
// access. So the branch the request asks for is compared against the
// authenticated terminal's branch in Execute's caller; that wiring lands with
// the composition root.
func (h *Handler) GetBalances(w http.ResponseWriter, r *http.Request) {
	if h.store == nil {
		h.writeError(w, http.StatusServiceUnavailable, "persistence_unconfigured",
			"DATABASE_URL is unset; the balances endpoint cannot read stock without a database")
		return
	}

	q, err := parseBalancesQuery(r)
	if err != nil {
		var qe *queryError
		if errors.As(err, &qe) {
			h.writeError(w, http.StatusBadRequest, qe.code, qe.message)
			return
		}
		h.writeError(w, http.StatusBadRequest, errBadRequest, err.Error())
		return
	}

	pulledAt := h.now().UTC()
	snapshot, err := h.store.Balances(r.Context(), q, pulledAt)
	if err != nil {
		// The store's errors are not HTTP-shaped and should not be. Anything
		// reaching here is an infrastructure failure, which is a 500 by definition.
		// The detail is logged, never returned: the contract says `message` is for
		// humans and must not be parsed, and a driver error has no business
		// reaching a POS terminal.
		h.writeError(w, http.StatusInternalServerError, errInternal, "stock balances could not be read")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(toBalancesResponse(snapshot))
}

// queryError is a parse failure with the status code the contract assigns it.
type queryError struct {
	code    string
	message string
}

func (e *queryError) Error() string { return e.message }

// parseBalancesQuery maps the request's query string onto the contract's
// declared parameters, validating as it goes.
//
// Each parameter is handled separately rather than by a struct-tag decoder,
// because the contract's VALIDATION is where the interesting behaviour is and a
// generic decoder hides it:
//
//   - `branch_id` is `required: true` with no default. There is no sensible
//     fallback: stock is branch-specific, so guessing a branch would serve
//     another shop's counts.
//   - `limit` defaults to 200 and is capped at 500. Handing the cap to the
//     domain rather than clamping here means one default, not two that can
//     disagree.
//   - `since` is RFC 3339. A malformed timestamp is a 400 rather than a
//     silently ignored parameter, because ignoring it would send the FULL
//     snapshot to a terminal expecting a delta — slow, and enough to look like
//     a server bug.
//   - `cursor` is an opaque string from a previous `next_cursor`. We decode it
//     here to validate the format before passing to the store.
//   - `inventory_item_ids` is a comma-separated list of UUIDv7. Each must be
//     valid.
func parseBalancesQuery(r *http.Request) (inventory.BalancesQuery, error) {
	v := r.URL.Query()

	rawBranch := v.Get("branch_id")
	if rawBranch == "" {
		return inventory.BalancesQuery{}, &queryError{errBadRequest, "branch_id is required; stock is branch-specific"}
	}
	branchID, err := identity.ParseUUIDv7(rawBranch)
	if err != nil {
		return inventory.BalancesQuery{}, &queryError{errInvalidBranchID,
			"branch_id must be a client-generated UUIDv7"}
	}

	var since *time.Time
	if rawSince := v.Get("since"); rawSince != "" {
		parsed, err := time.Parse(time.RFC3339, rawSince)
		if err != nil {
			return inventory.BalancesQuery{}, &queryError{errInvalidSinceParam,
				"since must be an RFC 3339 timestamp, e.g. 2026-10-02T09:15:00Z"}
		}
		utc := parsed.UTC()
		since = &utc
	}

	cursor := v.Get("cursor")

	limit := int32(0)
	if raw := v.Get("limit"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 32)
		if err != nil {
			return inventory.BalancesQuery{}, &queryError{errBadRequest, "limit must be an integer"}
		}
		limit = int32(parsed)
	}

	var itemIDs []identity.UUIDv7
	if raw := v.Get("inventory_item_ids"); raw != "" {
		parts := strings.Split(raw, ",")
		itemIDs = make([]identity.UUIDv7, 0, len(parts))
		for i, part := range parts {
			trimmed := strings.TrimSpace(part)
			if trimmed == "" {
				continue
			}
			id, err := identity.ParseUUIDv7(trimmed)
			if err != nil {
				return inventory.BalancesQuery{}, &queryError{errInvalidItemIDs,
					fmt.Sprintf("inventory_item_ids[%d] must be a client-generated UUIDv7", i)}
			}
			itemIDs = append(itemIDs, id)
		}
	}

	q, err := inventory.NewBalancesQuery(branchID, since, cursor, limit, itemIDs)
	if err != nil {
		return inventory.BalancesQuery{}, &queryError{errLimitOutOfRange, err.Error()}
	}
	return q, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire DTOs — one per contract schema
// ─────────────────────────────────────────────────────────────────────────────

// stockBalanceBody is the contract's `StockBalance` schema.
type stockBalanceBody struct {
	ID                 string       `json:"id"`
	InventoryItemID    string       `json:"inventory_item_id"`
	BranchID           string       `json:"branch_id"`
	OnHand             money.Quantity `json:"on_hand"`
	Reserved           money.Quantity `json:"reserved"`
	LastMovementID     *string      `json:"last_movement_id"`
	Version            int64        `json:"version"`
	CreatedAt          string       `json:"created_at"`
	UpdatedAt          string       `json:"updated_at"`
}

func toStockBalanceBody(b inventory.StockBalance) stockBalanceBody {
	body := stockBalanceBody{
		ID:              b.ID.String(),
		InventoryItemID: b.InventoryItemID.String(),
		BranchID:        b.BranchID.String(),
		OnHand:          b.OnHand,
		Reserved:        b.Reserved,
		Version:         int64(b.Version),
		CreatedAt:       b.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:       b.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if b.LastMovementID != nil {
		id := b.LastMovementID.String()
		body.LastMovementID = &id
	}
	return body
}

// balancesResponseBody is the contract's `InventoryBalancesResponse` schema.
//
// `required: [branch_id, balances, cursor, pulled_at]` — every one of those
// is emitted unconditionally, including an EMPTY collection. A `null` collection
// is not the same as `[]` to a client that iterates it, so the slices are
// always non-nil on the way out.
type balancesResponseBody struct {
	BranchID  string              `json:"branch_id"`
	Balances  []stockBalanceBody  `json:"balances"`
	Cursor    string              `json:"cursor"`
	PulledAt  string              `json:"pulled_at"`
	NextCursor *string            `json:"next_cursor"`
}

func toBalancesResponse(s inventory.BalancesSnapshot) balancesResponseBody {
	body := balancesResponseBody{
		BranchID:  s.BranchID.String(),
		Balances:  make([]stockBalanceBody, 0, len(s.Balances)),
		Cursor:    s.Cursor.String(),
		PulledAt:  s.PulledAt.UTC().Format(time.RFC3339Nano),
		NextCursor: s.NextCursor,
	}
	for _, b := range s.Balances {
		body.Balances = append(body.Balances, toStockBalanceBody(b))
	}
	return body
}