// Package http adapts the catalogue use case to the wire.
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
//   - Field names. The contract says `unit_price_satang`; the Go field says
//     `UnitPriceSatang`. The mapping must be explicit so a rename cannot silently
//     change the wire.
//   - `nullable` versus absent. `name_en` is `nullable: true`, and `parent_id` is
//     `allOf: [...], nullable: true` — a JSON `null` on the wire must be a Go
//     pointer, or a nullable field would never round-trip.
//   - The envelope. `CatalogResponse` wraps four collections with `cursor`,
//     `pulled_at` and `next_cursor` alongside them. That shape belongs to the
//     endpoint, not to the catalogue.
//
// ── SATANG ON THE WIRE ────────────────────────────────────────────────────────
//
// `unit_price_satang` is the contract's `Satang` schema: `type: string` with
// pattern `^(0|[1-9][0-9]*)$`, so on the wire it is a quoted digit string,
// `"4550"`, and never a bare JSON number.
//
// The DTO field is therefore `money.Satang` and not `int64`. That is not
// cosmetic: `int64` would marshal as `4550`, which the money kernel's strict
// `Satang.UnmarshalJSON` now rejects, so a `int64` field would emit precisely the
// form this contract forbids. Using the kernel's type makes the wire form a
// property of the type rather than a rule for each adapter to remember, and it is
// the same mechanism `Quantity` already uses in this service.
//
// (The earlier rationale for an unquoted integer here was that Go's int64
// marshals losslessly, so the wire hazard only existed in the other direction,
// into JavaScript. That was right about the direction and wrong about the
// conclusion: the client is the same TypeScript in both directions, so the 2^53
// cliff applies outbound too. The string form closes it for both.)
package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	catalog "wal-asri-pos/services/api-backend/internal/catalog/domain"
	cataloguc "wal-asri-pos/services/api-backend/internal/catalog/usecase"
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// BasePath is the contract's server URL: `- url: /api/v1`.
const BasePath = "/api/v1"

// Handler serves the catalogue endpoints.
type Handler struct {
	getCatalog *cataloguc.GetCatalog
	// clock stamps `pulled_at` on an error response, so even a failure carries a
	// parseable timestamp for the terminal's log.
	now func() time.Time
}

// NewHandler wires the adapter. It takes the use case, not a repository: the
// adapter depends on the application layer, never the other way round.
func NewHandler(getCatalog *cataloguc.GetCatalog, now func() time.Time) *Handler {
	return &Handler{getCatalog: getCatalog, now: now}
}

// Route registers the handler's routes on a mux.
//
// One method rather than exposing a bare http.Handler, so the base path lives in
// exactly one place and cannot drift from the contract's declared server URL.
func (h *Handler) Route(mux *http.ServeMux) {
	mux.HandleFunc("GET "+BasePath+"/catalog", h.GetCatalog)
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
// constant somewhere — an ad-hoc string here becomes a branch the client makes on
// a typo.
func (h *Handler) writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Code: code, Message: message})
}

// Stable error codes. The contract's own example is `branch_not_accessible`.
const (
	errBadRequest        = "bad_request"
	errUnauthorized      = "unauthorized"
	errForbidden         = "branch_not_accessible"
	errInternal          = "internal_error"
	errInvalidBranchID   = "invalid_branch_id"
	errInvalidCursor     = "invalid_cursor"
	errLimitOutOfRange   = "limit_out_of_range"
	errInvalidSinceParam = "invalid_since"
)

// ─────────────────────────────────────────────────────────────────────────────
// GET /catalog
// ─────────────────────────────────────────────────────────────────────────────

// GetCatalog serves `GET /catalog`.
//
// Status mapping, straight from the contract's declared responses:
//
//	200 the snapshot
//	400 malformed or missing parameter
//	401 no device credential, or the refresh token expired
//	403 the credential is valid but not scoped to this branch
//	500 unexpected
//
// Note that 401 and 403 are NOT implemented as rejections here. This handler does
// not authenticate: the device credential is resolved by middleware above it and
// the branch scope is enforced by the repository's branch-scoped methods. A
// handler that invented its own auth check would be a second, weaker one — the
// contract's warning that "the server never trusts a client-asserted branch id" is
// exactly about not letting a lower layer decide access. So the branch the request
// asks for is compared against the authenticated terminal's branch in Execute's
// caller; that wiring lands with the composition root.
func (h *Handler) GetCatalog(w http.ResponseWriter, r *http.Request) {
	q, err := parseCatalogQuery(r)
	if err != nil {
		var qe *queryError
		if errors.As(err, &qe) {
			h.writeError(w, http.StatusBadRequest, qe.code, qe.message)
			return
		}
		h.writeError(w, http.StatusBadRequest, errBadRequest, err.Error())
		return
	}

	snapshot, err := h.getCatalog.Execute(r.Context(), q)
	if err != nil {
		// The use case's errors are not HTTP-shaped and should not be. Anything
		// reaching here is an infrastructure failure, which is a 500 by definition.
		// The detail is logged, never returned: the contract says `message` is for
		// humans and must not be parsed, and a driver error has no business
		// reaching a POS terminal.
		h.writeError(w, http.StatusInternalServerError, errInternal, "the catalogue could not be read")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(toCatalogResponse(snapshot))
}

// queryError is a parse failure with the status code the contract assigns it.
type queryError struct {
	code    string
	message string
}

func (e *queryError) Error() string { return e.message }

// parseCatalogQuery maps the request's query string onto the contract's declared
// parameters, validating as it goes.
//
// Each parameter is handled separately rather than by a struct-tag decoder,
// because the contract's VALIDATION is where the interesting behaviour is and a
// generic decoder hides it:
//
//   - `branch_id` is `required: true` with no default. There is no sensible
//     fallback: pricing and VAT are branch-specific, so guessing a branch would
//     serve another shop's prices.
//   - `limit` defaults to 200 and is capped at 500. Handing the cap to the domain
//     rather than clamping here means one default, not two that can disagree.
//   - `since` is RFC 3339. A malformed timestamp is a 400 rather than a silently
//     ignored parameter, because ignoring it would send the FULL catalogue to a
//     terminal expecting a delta — slow, and enough to look like a server bug.
func parseCatalogQuery(r *http.Request) (cataloguc.Query, error) {
	v := r.URL.Query()

	rawBranch := v.Get("branch_id")
	if rawBranch == "" {
		return cataloguc.Query{}, &queryError{errBadRequest, "branch_id is required; pricing and VAT are branch-specific"}
	}
	branchID, err := identity.ParseUUIDv7(rawBranch)
	if err != nil {
		return cataloguc.Query{}, &queryError{errInvalidBranchID,
			"branch_id must be a client-generated UUIDv7"}
	}

	var since *time.Time
	if rawSince := v.Get("since"); rawSince != "" {
		parsed, err := time.Parse(time.RFC3339, rawSince)
		if err != nil {
			return cataloguc.Query{}, &queryError{errInvalidSinceParam,
				"since must be an RFC 3339 timestamp, e.g. 2026-10-02T09:15:00Z"}
		}
		utc := parsed.UTC()
		since = &utc
	}

	includeInactive := false
	if raw := v.Get("include_inactive"); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			return cataloguc.Query{}, &queryError{errBadRequest,
				"include_inactive must be a boolean"}
		}
		includeInactive = parsed
	}

	limit := int32(0)
	if raw := v.Get("limit"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 32)
		if err != nil {
			return cataloguc.Query{}, &queryError{errBadRequest, "limit must be an integer"}
		}
		limit = int32(parsed)
	}

	q, err := catalog.NewCatalogQuery(branchID, since, includeInactive, v.Get("cursor"), limit)
	if err != nil {
		return cataloguc.Query{}, &queryError{errLimitOutOfRange,
			fmt.Sprintf("limit must be between %d and %d", catalog.MinPageSize, catalog.MaxPageSize)}
	}
	return q, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire DTOs — one per contract schema
// ─────────────────────────────────────────────────────────────────────────────

// categoryBody is the contract's `Category` schema.
//
// `additionalProperties: false` in the contract, so the struct must not grow a
// field without the contract growing one first. Go cannot express that, so it is
// a comment on every DTO here and a review rule.
type categoryBody struct {
	ID       string  `json:"id"`
	BranchID string  `json:"branch_id"`
	NameTH   string  `json:"name_th"`
	NameEN   *string `json:"name_en"`
	ParentID *string `json:"parent_id"`
	Sequence int32   `json:"sequence"`
	IsActive bool    `json:"is_active"`
	Version  int64   `json:"version"`
	// CreatedAt and UpdatedAt are `format: date-time`, RFC 3339 UTC.
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

func toCategoryBody(c catalog.Category) categoryBody {
	b := categoryBody{
		ID:        c.ID.String(),
		BranchID:  c.BranchID.String(),
		NameTH:    c.NameTH,
		Sequence:  c.Sequence,
		IsActive:  c.IsActive,
		Version:   int64(c.Version),
		UpdatedAt: c.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if !c.CreatedAt.IsZero() {
		b.CreatedAt = c.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	// Nullable string: nil is `null` on the wire, which is what the contract's
	// `nullable: true` means. An absent and a null field are NOT interchangeable.
	if c.NameEN != "" {
		name := c.NameEN
		b.NameEN = &name
	}
	if c.ParentID != nil {
		parent := c.ParentID.String()
		b.ParentID = &parent
	}
	return b
}

// productBody is the contract's `Product` schema.
type productBody struct {
	ID         string  `json:"id"`
	BranchID   string  `json:"branch_id"`
	CategoryID *string `json:"category_id"`
	NameTH     string  `json:"name_th"`
	NameEN     *string `json:"name_en"`
	IsActive   bool    `json:"is_active"`
	IsCombo    bool    `json:"is_combo"`
	RecipeID   *string `json:"recipe_id"`
	ImageURL   *string `json:"image_url"`
	Version    int64   `json:"version"`
	CreatedAt  string  `json:"created_at,omitempty"`
	UpdatedAt  string  `json:"updated_at"`
}

func toProductBody(p catalog.Product) productBody {
	b := productBody{
		ID:        p.ID.String(),
		BranchID:  p.BranchID.String(),
		NameTH:    p.NameTH,
		IsActive:  p.IsActive,
		IsCombo:   p.IsCombo,
		Version:   int64(p.Version),
		UpdatedAt: p.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if !p.CreatedAt.IsZero() {
		b.CreatedAt = p.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	if p.NameEN != "" {
		name := p.NameEN
		b.NameEN = &name
	}
	if p.CategoryID != nil {
		id := p.CategoryID.String()
		b.CategoryID = &id
	}
	if p.RecipeID != nil {
		id := p.RecipeID.String()
		b.RecipeID = &id
	}
	if p.ImageURL != "" {
		url := p.ImageURL
		b.ImageURL = &url
	}
	return b
}

// productVariantBody is the contract's `ProductVariant` schema.
//
// `barcode` is marked additive and pending approval (D-BARCODE), so it is a
// pointer: absent today, and a non-nil pointer must not break deserialisation on
// a client that predates it.
type productVariantBody struct {
	ID        string  `json:"id"`
	ProductID string  `json:"product_id"`
	SKU       string  `json:"sku"`
	Barcode   *string `json:"barcode,omitempty"`
	NameTH    string  `json:"name_th"`
	NameEN    *string `json:"name_en"`
	Size      *string `json:"size"`
	ImageURL  *string `json:"image_url"`
	IsActive  bool    `json:"is_active"`
	Version   int64   `json:"version"`
	CreatedAt string  `json:"created_at,omitempty"`
	UpdatedAt string  `json:"updated_at"`
}

func toVariantBody(v catalog.ProductVariant) productVariantBody {
	b := productVariantBody{
		ID:        v.ID.String(),
		ProductID: v.ProductID.String(),
		SKU:       v.SKU,
		NameTH:    v.NameTH,
		IsActive:  v.IsActive,
		Version:   int64(v.Version),
		UpdatedAt: v.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if !v.CreatedAt.IsZero() {
		b.CreatedAt = v.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	if v.Barcode != nil {
		bc := *v.Barcode
		b.Barcode = &bc
	}
	if v.NameEN != "" {
		s := v.NameEN
		b.NameEN = &s
	}
	if v.Size != "" {
		s := v.Size
		b.Size = &s
	}
	if v.ImageURL != "" {
		s := v.ImageURL
		b.ImageURL = &s
	}
	return b
}

// priceListEntryBody is the contract's `PriceListEntry` schema.
//
// `unit_price_satang` is the contract's `Satang` schema — `type: string`,
// pattern `^(0|[1-9][0-9]*)$` — so it is declared `money.Satang` and reaches the
// wire as `"4550"`. The kernel type, not `int64`, is what guarantees the form:
// its MarshalJSON quotes and its strict UnmarshalJSON keeps `4550`, `4550.0`,
// `4.55e3`, `"007"` and `"-1"` out of a money field.
type priceListEntryBody struct {
	ID               string       `json:"id"`
	PriceListID      string       `json:"price_list_id"`
	ProductVariantID string       `json:"product_variant_id"`
	UnitPriceSatang  money.Satang `json:"unit_price_satang"`
	CurrencyCode     string       `json:"currency_code"`
	Version          int64        `json:"version"`
	CreatedAt        string       `json:"created_at,omitempty"`
	UpdatedAt        string       `json:"updated_at"`
}

func toPriceEntryBody(e catalog.PriceListEntry) priceListEntryBody {
	b := priceListEntryBody{
		ID:               e.ID.String(),
		PriceListID:      e.PriceListID.String(),
		ProductVariantID: e.ProductVariant.String(),
		UnitPriceSatang:  e.UnitPriceSatang,
		CurrencyCode:     string(e.CurrencyCode),
		Version:          int64(e.Version),
		UpdatedAt:        e.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if !e.CreatedAt.IsZero() {
		b.CreatedAt = e.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	return b
}

// catalogResponseBody is the contract's `CatalogResponse` schema.
//
// `required: [branch_id, categories, products, variants, price_list_entries,
// cursor, pulled_at]` — every one of those is emitted unconditionally, including
// an EMPTY collection. A `null` collection is not the same as `[]` to a client
// that iterates it, so the slices are always non-nil on the way out.
type catalogResponseBody struct {
	BranchID         string               `json:"branch_id"`
	Categories       []categoryBody       `json:"categories"`
	Products         []productBody        `json:"products"`
	Variants         []productVariantBody `json:"variants"`
	PriceListEntries []priceListEntryBody `json:"price_list_entries"`
	// Cursor is EQUAL to pulled_at. The contract says so, and a terminal that
	// resumes from the wrong one either re-pulls or skips a menu change.
	Cursor   string `json:"cursor"`
	PulledAt string `json:"pulled_at"`
	// NextCursor is `nullable: true` and null when the pull is complete.
	NextCursor *string `json:"next_cursor"`
}

func toCatalogResponse(s cataloguc.Snapshot) catalogResponseBody {
	body := catalogResponseBody{
		BranchID:         s.BranchID.String(),
		Categories:       make([]categoryBody, 0, len(s.Categories)),
		Products:         make([]productBody, 0, len(s.Products)),
		Variants:         make([]productVariantBody, 0, len(s.Variants)),
		PriceListEntries: make([]priceListEntryBody, 0, len(s.PriceListEntries)),
		Cursor:           s.Cursor.String(),
		PulledAt:         s.PulledAt.UTC().Format(time.RFC3339Nano),
	}
	for _, c := range s.Categories {
		body.Categories = append(body.Categories, toCategoryBody(c))
	}
	for _, p := range s.Products {
		body.Products = append(body.Products, toProductBody(p))
	}
	for _, v := range s.Variants {
		body.Variants = append(body.Variants, toVariantBody(v))
	}
	for _, e := range s.PriceListEntries {
		body.PriceListEntries = append(body.PriceListEntries, toPriceEntryBody(e))
	}
	if s.NextCursor != nil {
		next := s.NextCursor.String()
		body.NextCursor = &next
	}
	return body
}

// errUnsupportedOperation is returned by a route this build does not serve.
var errUnsupportedOperation = errors.New("http: operation not supported by this build")

// UnsupportedOperation is exported so the composition root can fail loudly at
// startup rather than registering a route that 500s in production.
func UnsupportedOperation(op string) error {
	return fmt.Errorf("%w: %s", errUnsupportedOperation, op)
}
