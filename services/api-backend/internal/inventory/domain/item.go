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
//
// ── WHY THIS MODULE IS ABOUT A LEDGER AND NOT A NUMBER ────────────────────────
//
// The obvious shape for "how much stock is left" is a field you decrement. That
// shape is forbidden here by three documents that were written before any of this
// code existed:
//
//	contracts/openapi.yaml, StockBalance:
//	  "Derived, never written by a client. It is computed server-side from the
//	   StockMovement ledger. Stock is a ledger of movements rather than an
//	   overwritten number."
//
//	ARCHITECTURE-DEMO.md §9:
//	  "Inventory: stock is a ledger of movements, not an overwritten number;
//	   server computes the balance."
//
//	apps/pos-desktop/src/features/inventory/domain/README.md:
//	  "Stock is a ledger of movements, never an overwritten number. Writing
//	   `UPDATE products SET stock = ?` is a defect: it destroys history and makes
//	   offline sync unresolvable."
//
// So this package holds THREE things and no arithmetic on a running total: the
// article being counted, the movement that changed it, and the balance those
// movements add up to. The subtraction happens once, in NewSaleDeduction, and it
// is written down rather than implicit — `delta = -quantity` is a sign convention
// that has to be stated exactly once or it will be stated twice, with opposite
// signs.
//
// ── WHY A BALANCE MAY BE NEGATIVE ─────────────────────────────────────────────
//
// This is the rule most likely to be "fixed" by someone reading it as an
// oversight, so the reasoning is here rather than in a review comment.
//
// The POS is offline-first. That is the product. A terminal in a Thai basement
// branch loses its link constantly and must complete a sale regardless, which
// means it can sell the last of the flour before anybody knew there was none.
// When that batch syncs, the server faces a shortage that ALREADY HAPPENED —
// the flour is sold, the customer has paid, the receipt is printed.
//
// At that point a `CHECK (on_hand >= 0)` — or an equivalent refusal in Go — buys
// nothing and costs the one fact an operator needs. It does not prevent the
// oversell; it only hides the shortage, and forces the next reconciliation to be
// argued against a number the system declined to keep.
//
// Hence: the deduction commits a negative balance and reports a warning. The
// contract says so directly for this exact case — "May be negative if an offline
// terminal oversold before reconciling" — and the terminal's own
// 0003_stock_balances.sql documents the deliberate absence of the CHECK.
//
// ── WHAT THIS PACKAGE DELIBERATELY DOES NOT HAVE ──────────────────────────────
//
// No recipe. `InventoryItem.is_raw` marks an ingredient consumed "only through a
// recipe", and `docs/02-design/DOMAIN.md` defines Recipe and RecipeComponent — but
// contracts/openapi.yaml defines NEITHER, so there is no wire shape to ingest one
// through and no authoritative definition to cook against. A recipe engine built
// now would be built against DOMAIN.md alone, in a module whose wire contract is
// somebody else's to write.
//
// The consequence is stated where it bites, in usecase.DeductSale: a sold raw
// ingredient whose recipe is unknown deducts NOTHING rather than an invented
// amount. That is the safe direction — it under-deducts visibly rather than
// over-deducting silently — and it is a recorded gap, not a finished feature.
package domain

import (
	"fmt"
	"strings"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
)

// InventoryItem is a stock-keeping article.
//
// An ARTICLE, not a product: "0.250 kg of coffee beans" is stock-keeping even
// though nobody ever rings it up directly. The contract's two flags are what
// distinguish the two roles:
//
//	is_raw: false  a finished good, sold directly, `product_variant_id` set
//	is_raw: true   an ingredient, consumed through a recipe, no variant
type InventoryItem struct {
	ID       identity.UUIDv7
	BranchID identity.UUIDv7

	// ProductVariantID is the sellable thing this article counts, or nil for a raw
	// ingredient. The sale deduction resolves a sold `OrderLine.product_variant_id`
	// through this column, which is why its uniqueness per branch is a schema
	// constraint rather than a convention (see 0002_inventory.sql).
	ProductVariantID *identity.UUIDv7

	SKU    string
	NameTH string
	NameEN *string

	// Unit is a free-text measure: `kg`, `g`, `ml`, `pcs`.
	//
	// ⚠️ A STRING, AND THAT IS A KNOWN GAP, NOT AN OVERSIGHT. The contract marks
	// `unit_of_measure_id` as D-UNIT, "proposed, not approved", so nothing here
	// stops a recipe from adding 0.250 kg of flour to 0.005 g of saffron. What
	// Validate does enforce is that it is not BLANK, because a quantity with no
	// unit cannot be converted, reconciled, or even read by an operator — and a
	// blank is a bug rather than a missing decision.
	//
	// Inventing a unit-conversion table here would be ratifying D-UNIT by
	// accident, which is precisely the sort of decision HANDOVER.md §11 says to
	// leave for a human.
	Unit string

	// TrackStock decides whether a StockBalance is maintained for this article.
	//
	// It is what makes the deduction SKIP rather than count-at-zero: a garnish is
	// never counted, so recording a 0.000 balance for it would be a fiction, and a
	// negative one after it was sold would be a lie.
	TrackStock bool

	// IsRaw marks an ingredient consumed only through a recipe.
	IsRaw bool

	Version   Version
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Version is the optimistic-concurrency counter.
//
// A distinct named type rather than a bare int64 for the reason `catalog.Version`
// is: a count of something must never be passed where a money amount or a
// quantity is expected, and Go cannot enforce that on two int64s.
type Version int64

// Next returns the version after a server-side write.
func (v Version) Next() Version { return v + 1 }

// Validate checks an item on the way in.
//
// Three rules, and the third is the one worth reading twice.
//
//  1. The identity is required. A balance cannot exist without an article to
//     belong to, and an article with no id cannot be referenced by a movement.
//
//  2. THE UNIT IS REQUIRED. Not for tidiness: `2.500` with no unit is an
//     uninterpretable number. Every downstream act — a recipe's arithmetic, an
//     operator's reorder decision, a reconciliation that asks why a balance moved
//     — needs to know whether 250 means grams or millilitres.
//
//  3. A RAW INGREDIENT HAS NO VARIANT. The contract states this in words:
//     "`null` when `is_raw` is true (an ingredient with no direct sale)". It is
//     enforced in the database too (`inventory_items_raw_has_no_variant`), and
//     repeated here for the reason every money rule in this service is repeated
//     across layers: the constraint closest to the bytes is the one nobody can
//     forget, and the domain is the one that gives the error a reason.
//
// What Validate does NOT do is check that the unit is CONSISTENT across a recipe.
// That is D-UNIT, unratified, and a rule invented here would be a rule with no
// owner.
func (i InventoryItem) Validate() error {
	if i.ID.IsZero() {
		return fmt.Errorf("inventory: an article needs an id; it is client-generated so a branch can record one offline")
	}
	if i.BranchID.IsZero() {
		return fmt.Errorf(
			"inventory: article %s has no branch; balances are per branch because two branches of one shop stock different things", i.ID)
	}
	if strings.TrimSpace(i.Unit) == "" {
		return fmt.Errorf(
			"inventory: article %s has no unit; a quantity without one cannot be converted, "+
				"reconciled, or read by an operator", i.ID)
	}
	if i.IsRaw && i.ProductVariantID != nil {
		return fmt.Errorf(
			"inventory: raw ingredient %s claims product variant %s; a raw ingredient is consumed "+
				"only through a recipe and has no direct sale", i.ID, i.ProductVariantID)
	}
	return nil
}

// Tracked reports whether this article participates in stock deduction.
//
// A method rather than a bare field read so the usecase states the rule once
// instead of at every call site — and so the answer to "why did this sale deduct
// nothing?" is a single named concept rather than a compound condition.
func (i InventoryItem) Tracked() bool { return i.TrackStock }

// VariantNames reports whether this article is the stock behind a sold variant.
func (i InventoryItem) VariantNames() bool { return i.ProductVariantID != nil }
