// Package postgres implements the recipe module's ports over PostgreSQL.
package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	inventoryuc "wal-asri-pos/services/api-backend/internal/inventory/usecase"
	recipe "wal-asri-pos/services/api-backend/internal/recipe/domain"
	recipeuc "wal-asri-pos/services/api-backend/internal/recipe/usecase"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// RecipeStore implements recipeuc.RecipeReader, recipeuc.RecipeLookup,
// and inventoryuc.RecipeLookup.
type RecipeStore struct {
	pool *pgxpool.Pool
}

// NewRecipeStore creates a new RecipeStore.
func NewRecipeStore(pool *pgxpool.Pool) *RecipeStore {
	return &RecipeStore{pool: pool}
}

// Interface checks
var _ recipeuc.RecipeReader = (*RecipeStore)(nil)
var _ inventoryuc.RecipeLookup = (*RecipeStore)(nil)

// ActiveRecipesForBranch returns all active recipes and their components for a branch.
func (s *RecipeStore) ActiveRecipesForBranch(
	ctx context.Context,
	branchID identity.UUIDv7,
) ([]recipeuc.RecipeWithComponents, error) {
	const q = `
		SELECT
			r.id, r.branch_id, r.product_id, r.is_active, r.version,
			r.created_at, r.updated_at,
			rc.id, rc.recipe_id, rc.inventory_item_id, rc.quantity_milli,
			rc.version, rc.created_at, rc.updated_at
		FROM recipes r
		JOIN recipe_components rc ON rc.recipe_id = r.id
		WHERE r.branch_id = $1
		  AND r.is_active = true
		ORDER BY r.product_id, rc.inventory_item_id
	`

	rows, err := s.pool.Query(ctx, q, branchID)
	if err != nil {
		return nil, fmt.Errorf("recipe: querying active recipes: %w", err)
	}
	defer rows.Close()

	recipeMap := make(map[identity.UUIDv7]*recipeuc.RecipeWithComponents)
	order := []identity.UUIDv7{}

	for rows.Next() {
		var (
			rID, rBranch, rProduct identity.UUIDv7
			rActive                bool
			rVersion               int64
			rCreated, rUpdated     time.Time
			cID, cRecipe, cItem    identity.UUIDv7
			cQtyMilli              int64
			cVersion               int64
			cCreated, cUpdated     time.Time
		)

		if err := rows.Scan(
			&rID, &rBranch, &rProduct, &rActive, &rVersion,
			&rCreated, &rUpdated,
			&cID, &cRecipe, &cItem, &cQtyMilli,
			&cVersion, &cCreated, &cUpdated,
		); err != nil {
			return nil, fmt.Errorf("recipe: scanning recipe row: %w", err)
		}

		rwc, exists := recipeMap[rID]
		if !exists {
			rwc = &recipeuc.RecipeWithComponents{
				Recipe: recipe.Recipe{
					ID:        rID,
					BranchID:  rBranch,
					ProductID: rProduct,
					IsActive:  rActive,
					Version:   recipe.Version(rVersion),
					CreatedAt: rCreated,
					UpdatedAt: rUpdated,
				},
			}
			recipeMap[rID] = rwc
			order = append(order, rID)
		}

		qty, err := money.NewQuantityFromMilli(cQtyMilli)
		if err != nil {
			return nil, fmt.Errorf("recipe: parsing quantity %d: %w", cQtyMilli, err)
		}

		rwc.Components = append(rwc.Components, recipe.RecipeComponent{
			ID:               cID,
			RecipeID:         cRecipe,
			InventoryItemID:  cItem,
			QuantityMilli:    qty,
			Version:          recipe.Version(cVersion),
			CreatedAt:        cCreated,
			UpdatedAt:        cUpdated,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("recipe: iterating recipes: %w", err)
	}

	out := make([]recipeuc.RecipeWithComponents, 0, len(order))
	for _, id := range order {
		out = append(out, *recipeMap[id])
	}
	return out, nil
}

// RecipeComponentsFor implements inventoryuc.RecipeLookup.
//
// It returns the recipe components in the inventory module's vocabulary
// (just inventory_item_id and quantity_milli). This allows the inventory
// module's DeductSale interactor to compute recipe deductions without
// importing the recipe module's usecase.
func (s *RecipeStore) RecipeComponentsFor(
	ctx context.Context,
	branchID, productVariantID identity.UUIDv7,
) ([]inventoryuc.RecipeComponent, bool, error) {
	const q = `
		SELECT
			rc.inventory_item_id, rc.quantity_milli
		FROM recipe_components rc
		JOIN recipes r ON r.id = rc.recipe_id
		WHERE r.branch_id = $1
		  AND r.product_id = (
			SELECT product_id FROM product_variants WHERE id = $2
		  )
		  AND r.is_active = true
		ORDER BY rc.inventory_item_id
	`

	rows, err := s.pool.Query(ctx, q, branchID, productVariantID)
	if err != nil {
		return nil, false, nil
	}
	defer rows.Close()

	var components []inventoryuc.RecipeComponent
	for rows.Next() {
		var (
			itemID   identity.UUIDv7
			qtyMilli int64
		)

		if err := rows.Scan(&itemID, &qtyMilli); err != nil {
			return nil, false, fmt.Errorf("recipe: scanning component: %w", err)
		}

		qty, err := money.NewQuantityFromMilli(qtyMilli)
		if err != nil {
			return nil, false, fmt.Errorf("recipe: parsing quantity %d: %w", qtyMilli, err)
		}

		components = append(components, inventoryuc.RecipeComponent{
			InventoryItemID: itemID,
			QuantityMilli:   qty,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("recipe: iterating components: %w", err)
	}

	if len(components) == 0 {
		return nil, false, nil
	}
	return components, true, nil
}