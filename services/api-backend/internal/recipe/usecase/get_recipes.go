// Package usecase holds the recipe module's application logic — the interactor
// that returns the active recipes and their components for a branch.
//
// ── LAYER RULE ────────────────────────────────────────────────────────────────
//
// This package may import `internal/recipe/domain` and shared kernels. It must
// NOT import `internal/recipe/adapter` or another module's `usecase/` or
// `adapter/`. The constraint is tested by internal/architecture/layers_test.go.
package usecase

import (
	"context"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	recipe "wal-asri-pos/services/api-backend/internal/recipe/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

// RecipeReader reads the active recipes and their components for a branch.
type RecipeReader interface {
	// ActiveRecipesForBranch returns all active recipes and their components
	// for a branch. The slice is ordered by recipe product_id for stability.
	ActiveRecipesForBranch(ctx context.Context, branchID identity.UUIDv7) ([]RecipeWithComponents, error)
}

// RecipeWithComponents is a recipe with its components, for the wire.
type RecipeWithComponents struct {
	Recipe     recipe.Recipe
	Components []recipe.RecipeComponent
}

// ─────────────────────────────────────────────────────────────────────────────
// Query and Result
// ─────────────────────────────────────────────────────────────────────────────

// Query is the input to GetRecipes.
type Query struct {
	BranchID identity.UUIDv7
	Since    *time.Time
	Cursor   string
	Limit    int32
}

// NewQuery validates and builds a Query.
func NewQuery(branchID identity.UUIDv7, since *time.Time, cursor string, limit int32) (Query, error) {
	if branchID.IsZero() {
		return Query{}, &ValidationError{Reason: "branch_id is required"}
	}
	if limit < 0 {
		return Query{}, &ValidationError{Reason: "limit must be non-negative"}
	}
	if limit == 0 {
		limit = DefaultPageSize
	}
	if limit > MaxPageSize {
		return Query{}, &ValidationError{Reason: "limit exceeds maximum"}
	}
	return Query{
		BranchID: branchID,
		Since:    since,
		Cursor:   cursor,
		Limit:    limit,
	}, nil
}

const (
	DefaultPageSize = 200
	MaxPageSize     = 500
)

// ValidationError is a client-correctable error.
type ValidationError struct {
	Reason string
}

func (e *ValidationError) Error() string { return "recipe: " + e.Reason }

// Snapshot is the result of GetRecipes.
type Snapshot struct {
	BranchID  identity.UUIDv7
	Recipes   []RecipeWithComponents
	Cursor    time.Time
	PulledAt  time.Time
	NextCursor *time.Time
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactor
// ─────────────────────────────────────────────────────────────────────────────

// GetRecipes returns the active recipes and their components for a branch.
type GetRecipes struct {
	reader RecipeReader
	now    func() time.Time
}

// GetRecipesDeps is the constructor's argument bundle.
type GetRecipesDeps struct {
	Reader RecipeReader
	Now    func() time.Time
}

// NewGetRecipes wires the interactor.
func NewGetRecipes(d GetRecipesDeps) *GetRecipes {
	nowFn := d.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &GetRecipes{reader: d.Reader, now: nowFn}
}

// Execute returns the recipes snapshot for a branch.
func (g *GetRecipes) Execute(ctx context.Context, q Query) (Snapshot, error) {
	recipes, err := g.reader.ActiveRecipesForBranch(ctx, q.BranchID)
	if err != nil {
		return Snapshot{}, err
	}

	// Apply cursor filtering if provided.
	// The cursor is the pulled_at of a previous response. We filter recipes
	// where updated_at > cursor.
	filtered := recipes
	if q.Cursor != "" {
		cursorTime, err := time.Parse(time.RFC3339, q.Cursor)
		if err != nil {
			return Snapshot{}, &ValidationError{Reason: "invalid cursor format"}
		}
		filtered = filterByCursor(filtered, cursorTime)
	}

	// Apply limit.
	if len(filtered) > int(q.Limit) {
		filtered = filtered[:q.Limit]
	}

	pulledAt := g.now().UTC()
	cursor := pulledAt

	var nextCursor *time.Time
	if len(filtered) == int(q.Limit) {
		// There might be more. The next cursor is the updated_at of the last
		// item returned, so the next pull starts from there.
		last := filtered[len(filtered)-1]
		next := last.Recipe.UpdatedAt
		nextCursor = &next
	}

	return Snapshot{
		BranchID:   q.BranchID,
		Recipes:    filtered,
		Cursor:     cursor,
		PulledAt:   pulledAt,
		NextCursor: nextCursor,
	}, nil
}

// filterByCursor returns recipes where recipe.updated_at > cursor.
// Also includes recipes where any component.updated_at > cursor.
func filterByCursor(recipes []RecipeWithComponents, cursor time.Time) []RecipeWithComponents {
	var out []RecipeWithComponents
	for _, rwc := range recipes {
		if rwc.Recipe.UpdatedAt.After(cursor) {
			out = append(out, rwc)
			continue
		}
		for _, c := range rwc.Components {
			if c.UpdatedAt.After(cursor) {
				out = append(out, rwc)
				break
			}
		}
	}
	return out
}