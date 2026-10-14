// Package http adapts the recipe use case to the wire.
package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	recipe "wal-asri-pos/services/api-backend/internal/recipe/domain"
	recipeuc "wal-asri-pos/services/api-backend/internal/recipe/usecase"
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
)

// BasePath is the contract's server URL: `- url: /api/v1`.
const BasePath = "/api/v1"

// Handler serves the recipe endpoints.
type Handler struct {
	getRecipes *recipeuc.GetRecipes
	now        func() time.Time
}

// NewHandler wires the adapter.
func NewHandler(getRecipes *recipeuc.GetRecipes, now func() time.Time) *Handler {
	return &Handler{getRecipes: getRecipes, now: now}
}

// Route registers the handler's routes on a mux.
func (h *Handler) Route(mux *http.ServeMux) {
	mux.HandleFunc("GET "+BasePath+"/catalog/recipes", h.GetRecipes)
}

// ─────────────────────────────────────────────────────────────────────────────
// Error envelope
// ─────────────────────────────────────────────────────────────────────────────

type errorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func (h *Handler) writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Code: code, Message: message})
}

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
// GET /catalog/recipes
// ─────────────────────────────────────────────────────────────────────────────

// GetRecipes serves `GET /catalog/recipes`.
func (h *Handler) GetRecipes(w http.ResponseWriter, r *http.Request) {
	// If the use case is nil (DATABASE_URL not set), refuse with 503.
	if h.getRecipes == nil {
		h.writeError(w, http.StatusServiceUnavailable, "persistence_unwired",
			"recipes: no database is configured; set DATABASE_URL to enable this endpoint")
		return
	}

	q, err := parseRecipesQuery(r)
	if err != nil {
		var qe *queryError
		if errors.As(err, &qe) {
			h.writeError(w, http.StatusBadRequest, qe.code, qe.message)
			return
		}
		h.writeError(w, http.StatusBadRequest, errBadRequest, err.Error())
		return
	}

	snapshot, err := h.getRecipes.Execute(r.Context(), q)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, errInternal, "the recipes could not be read")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(toRecipesResponse(snapshot))
}

type queryError struct {
	code    string
	message string
}

func (e *queryError) Error() string { return e.message }

func parseRecipesQuery(r *http.Request) (recipeuc.Query, error) {
	v := r.URL.Query()

	rawBranch := v.Get("branch_id")
	if rawBranch == "" {
		return recipeuc.Query{}, &queryError{errBadRequest, "branch_id is required; recipes are branch-specific"}
	}
	branchID, err := identity.ParseUUIDv7(rawBranch)
	if err != nil {
		return recipeuc.Query{}, &queryError{errInvalidBranchID, "branch_id must be a client-generated UUIDv7"}
	}

	var since *time.Time
	if rawSince := v.Get("since"); rawSince != "" {
		parsed, err := time.Parse(time.RFC3339, rawSince)
		if err != nil {
			return recipeuc.Query{}, &queryError{errInvalidSinceParam, "since must be an RFC 3339 timestamp, e.g. 2026-10-02T09:15:00Z"}
		}
		utc := parsed.UTC()
		since = &utc
	}

	limit := int32(0)
	if raw := v.Get("limit"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 32)
		if err != nil {
			return recipeuc.Query{}, &queryError{errBadRequest, "limit must be an integer"}
		}
		limit = int32(parsed)
	}

	cursor := v.Get("cursor")

	return recipeuc.NewQuery(branchID, since, cursor, limit)
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire DTOs
// ─────────────────────────────────────────────────────────────────────────────

type recipeBody struct {
	ID        string `json:"id"`
	BranchID  string `json:"branch_id"`
	ProductID string `json:"product_id"`
	IsActive  bool   `json:"is_active"`
	Version   int64  `json:"version"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

func toRecipeBody(r recipe.Recipe) recipeBody {
	b := recipeBody{
		ID:        r.ID.String(),
		BranchID:  r.BranchID.String(),
		ProductID: r.ProductID.String(),
		IsActive:  r.IsActive,
		Version:   int64(r.Version),
		UpdatedAt: r.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if !r.CreatedAt.IsZero() {
		b.CreatedAt = r.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	return b
}

type recipeComponentBody struct {
	ID               string `json:"id"`
	RecipeID         string `json:"recipe_id"`
	InventoryItemID  string `json:"inventory_item_id"`
	Quantity         string `json:"quantity"`
	Version          int64  `json:"version"`
	CreatedAt        string `json:"created_at,omitempty"`
	UpdatedAt        string `json:"updated_at"`
}

func toComponentBody(c recipe.RecipeComponent) recipeComponentBody {
	b := recipeComponentBody{
		ID:               c.ID.String(),
		RecipeID:         c.RecipeID.String(),
		InventoryItemID:  c.InventoryItemID.String(),
		Quantity:         c.QuantityMilli.String(), // decimal string, e.g. "0.018"
		Version:          int64(c.Version),
		UpdatedAt:        c.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if !c.CreatedAt.IsZero() {
		b.CreatedAt = c.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	return b
}

type recipesResponseBody struct {
	BranchID  string                 `json:"branch_id"`
	Recipes   []recipeBody           `json:"recipes"`
	Components []recipeComponentBody `json:"components"`
	Cursor    string                 `json:"cursor"`
	PulledAt  string                 `json:"pulled_at"`
	NextCursor *string               `json:"next_cursor"`
}

func toRecipesResponse(s recipeuc.Snapshot) recipesResponseBody {
	body := recipesResponseBody{
		BranchID: s.BranchID.String(),
		Recipes:  make([]recipeBody, 0, len(s.Recipes)),
		Components: make([]recipeComponentBody, 0),
		Cursor:   s.Cursor.String(),
		PulledAt: s.PulledAt.UTC().Format(time.RFC3339Nano),
	}

	for _, rwc := range s.Recipes {
		body.Recipes = append(body.Recipes, toRecipeBody(rwc.Recipe))
		for _, c := range rwc.Components {
			body.Components = append(body.Components, toComponentBody(c))
		}
	}

	if s.NextCursor != nil {
		next := s.NextCursor.UTC().Format(time.RFC3339Nano)
		body.NextCursor = &next
	}

	return body
}