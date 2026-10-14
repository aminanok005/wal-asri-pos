// Package domain holds the recipe module's business rules in pure Go.
//
// ── LAYER RULE ────────────────────────────────────────────────────────────────
//
// Nothing here may import a database driver, an HTTP framework, `context`, or
// another module's `usecase/` or `adapter/`. It imports exactly two shared
// kernels — `internal/money/domain` for `Quantity` and `internal/identity/domain`
// for keys — and the constraint is tested, not merely intended: see
// internal/architecture/layers_test.go.
package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// Version is the optimistic-concurrency counter.
//
// contracts/openapi.yaml, `Version`: "Optimistic-concurrency counter. The server
// increments it on every write. A client performing a conditional write sends the
// `version` it read; a mismatch is a conflict, never a silent overwrite."
type Version int64

// Next returns the version after a server-side write.
func (v Version) Next() Version { return v + 1 }

// Recipe is the formula for a product's ingredient consumption.
//
// One product has at most one active recipe. A recipe has one or more
// components, each naming a raw ingredient (inventory item with is_raw = true)
// and the quantity consumed per ONE unit of the finished product.
type Recipe struct {
	ID        identity.UUIDv7
	BranchID  identity.UUIDv7
	ProductID identity.UUIDv7
	IsActive  bool
	Version   Version
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Active reports whether this recipe is used for ingredient deduction.
func (r Recipe) Active() bool { return r.IsActive }

// Validate checks a recipe on the way in.
func (r Recipe) Validate() error {
	if r.ID.IsZero() {
		return fmt.Errorf("recipe: an id is required; it is client-generated so a branch can record one offline")
	}
	if r.BranchID.IsZero() {
		return fmt.Errorf("recipe: article %s has no branch; recipes are per branch", r.ID)
	}
	if r.ProductID.IsZero() {
		return fmt.Errorf("recipe: %s has no product; a recipe belongs to exactly one product", r.ID)
	}
	return nil
}

// RecipeComponent is one ingredient in a recipe.
//
// quantity_milli is the amount consumed per ONE unit of the finished product.
// E.g., 0.018 kg coffee beans per shot = 18 milli-units.
type RecipeComponent struct {
	ID               identity.UUIDv7
	RecipeID         identity.UUIDv7
	InventoryItemID  identity.UUIDv7
	QuantityMilli    money.Quantity
	Version          Version
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// Validate checks a component on the way in.
func (c RecipeComponent) Validate() error {
	if c.ID.IsZero() {
		return fmt.Errorf("recipe_component: an id is required; it is client-generated")
	}
	if c.RecipeID.IsZero() {
		return fmt.Errorf("recipe_component: %s has no recipe", c.ID)
	}
	if c.InventoryItemID.IsZero() {
		return fmt.Errorf("recipe_component: %s has no inventory item", c.ID)
	}
	if c.QuantityMilli.IsZero() || c.QuantityMilli.IsNegative() {
		return fmt.Errorf(
			"recipe_component: %s has quantity %s; must be positive milli-units",
			c.ID, c.QuantityMilli)
	}
	// Upper bound matches the database CHECK and the contract's Quantity pattern.
	if c.QuantityMilli.Milli() > 999999999999 {
		return fmt.Errorf(
			"recipe_component: %s quantity %s exceeds decimal(12,3)", c.ID, c.QuantityMilli)
	}
	return nil
}

// DeductionForSale computes the stock deduction for one recipe component
// given the quantity of finished product sold.
//
// The deduction is: quantity_sold * component_quantity_per_unit.
// Both quantities are in milli-units, so the multiplication is exact integer
// arithmetic with no floating point.
//
// The result is the signed delta to apply to the ingredient's on_hand balance
// (negative, because stock is consumed).
func (c RecipeComponent) DeductionForSale(
	quantitySold money.Quantity,
	orderLineID identity.UUIDv7,
	now time.Time,
) (Deduction, error) {
	if quantitySold.IsZero() || quantitySold.IsNegative() {
		return Deduction{}, fmt.Errorf(
			"recipe: quantity sold %s must be positive", quantitySold)
	}

	// Multiply: milli-units * milli-units = micro-units, then divide by 1000.
	// But the contract's Quantity is decimal(12,3) — 3 decimal places.
	// So component_quantity_milli is already scaled by 1000.
	// quantity_sold is also scaled by 1000.
	// The product is scaled by 1,000,000. We need to divide by 1000 to get back
	// to milli-units.
	//
	// Example: component = 0.018 kg = 18 milli-units. quantity_sold = 2 = 2000 milli-units.
	// 18 * 2000 = 36000. 36000 / 1000 = 36 milli-units = 0.036 kg. Correct.
	totalMilli := (c.QuantityMilli.Milli() * quantitySold.Milli()) / 1000

	if totalMilli > 999999999999 || totalMilli < -999999999999 {
		return Deduction{}, fmt.Errorf(
			"recipe: deduction %d milli-units exceeds decimal(12,3)", totalMilli)
	}

	consumed, err := money.NewQuantityFromMilli(-totalMilli)
	if err != nil {
		return Deduction{}, fmt.Errorf("recipe: building deduction: %w", err)
	}

	return Deduction{
		InventoryItemID: c.InventoryItemID,
		OrderLineID:     orderLineID,
		QuantityMilli:   consumed,
		CreatedAt:       now.UTC(),
	}, nil
}

// Deduction is a stock movement intent produced by a recipe component.
//
// It is a distinct type from inventory.domain.Deduction because the recipe
// module owns the multiplication logic, and the inventory module owns the
// ledger append. Keeping them separate means the inventory module never
// re-computes the recipe arithmetic.
type Deduction struct {
	InventoryItemID identity.UUIDv7
	OrderLineID     identity.UUIDv7
	QuantityMilli   money.Quantity // negative (consumption)
	CreatedAt       time.Time
}

// Validate checks a deduction on the way to the ledger.
func (d Deduction) Validate() error {
	if d.InventoryItemID.IsZero() {
		return fmt.Errorf("recipe: deduction has no inventory item")
	}
	if d.OrderLineID.IsZero() {
		return fmt.Errorf("recipe: deduction has no order line id")
	}
	if d.QuantityMilli.IsZero() || !d.QuantityMilli.IsNegative() {
		return fmt.Errorf("recipe: deduction %s must be negative (consumption)", d.QuantityMilli)
	}
	return nil
}

// ToInventoryDeduction converts to the inventory module's deduction type.
//
// This is the seam between the recipe module (which knows the multiplication)
// and the inventory module (which owns the ledger).
func (d Deduction) ToInventoryDeduction(itemID identity.UUIDv7) Deduction {
	// The inventory item ID should already match, but we accept it as an
	// argument to make the conversion explicit and auditable.
	return Deduction{
		InventoryItemID: itemID,
		OrderLineID:     d.OrderLineID,
		QuantityMilli:   d.QuantityMilli,
		CreatedAt:       d.CreatedAt,
	}
}