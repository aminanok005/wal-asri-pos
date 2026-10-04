package domain

import (
	"fmt"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"

	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Sellability — the rule that needs more than one row
// ─────────────────────────────────────────────────────────────────────────────
//
// contracts/openapi.yaml settles the status vocabulary in its own preamble:
//
//	"`is_active` is a **boolean** and is the single source of truth for
//	 'available to sell'. A separate `status` field exists only on entities
//	 where DOMAIN.md defines a real state machine... Catalog entities do not
//	 have one."
//
// So there is no `SELLABLE`/`SOLD_OUT` enum to check, and adding one would be a
// second source of truth for a question `is_active` already answers.
//
// But "single source of truth" does not mean "one row". A ProductVariant is
// sellable only when the variant is active AND its parent Product is active, and
// each of those is a separate row with its own `is_active`. The contract states
// both halves explicitly:
//
//	Product.is_active      "false retires it from the menu but keeps it valid on
//	                        historical orders, which are append-only."
//	ProductVariant.is_active "A variant can be retired while its product stays
//	                        active, e.g. a seasonal size."
//
// So a terminal that reads only the variant row will happily sell a 12 oz size
// whose product was deleted from the menu last month. That check belongs in the
// server domain, and it is why a bare `variant.IsActive` is not sufficient
// anywhere in this codebase.
//

// Sellable is a variant together with the product context needed to judge it.
//
// The pair is carried explicitly rather than as a bare bool so that a caller
// which has only resolved the variant cannot accidentally treat `IsActive` on the
// variant alone as the answer — it has to finish the join.
type Sellable struct {
	Variant ProductVariant
	Product Product
}

// IsSellable reports whether this variant may be offered at the till.
//
// Both rows must be active, AND the variant must belong to the product it is
// paired with. That last check is not paranoia: the pairing is assembled by a
// lookup, and a variant whose ProductID does not match the product handed to it
// means the catalogue join went wrong — which would otherwise sell an item
// priced from the wrong product's context.
func (s Sellable) IsSellable() bool {
	return s.Variant.IsActive &&
		s.Product.IsActive &&
		s.Variant.ProductID.Compare(s.Product.ID) == 0
}

// String describes why a variant is not sellable, for an error message or a log.
// Empty means it is sellable.
func (s Sellable) UnsellableReason() string {
	switch {
	case s.Variant.ProductID.Compare(s.Product.ID) != 0:
		return fmt.Sprintf("variant %s claims product %s but was paired with product %s",
			s.Variant.ID, s.Variant.ProductID, s.Product.ID)
	case !s.Variant.IsActive:
		return fmt.Sprintf("variant %s (%s) is not active", s.Variant.ID, s.Variant.SKU)
	case !s.Product.IsActive:
		return fmt.Sprintf("product %s is not active, so its variant %s is not sellable",
			s.Product.ID, s.Variant.ID)
	default:
		return ""
	}
}

// PriceResolver answers "what does this variant cost under this price list?" for
// a set of price-list entries.
//
// The contract: "A variant may appear in more than one price list (e.g. standard
// and promotional); the client resolves which list is active for the branch." So
// resolution is by EXPLICIT list id, never by "whichever entry happens to be
// first" — a promotional and a standard entry for the same variant both exist
// legitimately, and picking arbitrarily between them is how a café charges a
// promotional price after the promotion ends.
type PriceResolver struct {
	entries []PriceListEntry
}

// NewPriceResolver indexes entries by (variant, price list).
func NewPriceResolver(entries []PriceListEntry) PriceResolver {
	return PriceResolver{entries: entries}
}

// PriceFor returns the price of variantID under priceListID.
//
// The second return is false when that variant has no entry in that list, which
// is a normal state rather than an error: a promotional list covers a subset of
// the menu. A caller that treats it as an error cannot sell the other items.
func (r PriceResolver) PriceFor(variantID, priceListID identity.UUIDv7) (money.Satang, CurrencyCode, bool) {
	for _, e := range r.entries {
		if e.ProductVariant.Compare(variantID) == 0 && e.PriceListID.Compare(priceListID) == 0 {
			return e.UnitPriceSatang, e.CurrencyCode, true
		}
	}
	return 0, "", false
}

// PricesForVariant returns every price a variant carries, across all lists.
//
// Exposed because the branch decides which list is effective, and the server has
// to be able to show all of them when reporting a price discrepancy rather than
// only the active one.
func (r PriceResolver) PricesForVariant(variantID identity.UUIDv7) []PriceListEntry {
	var out []PriceListEntry
	for _, e := range r.entries {
		if e.ProductVariant.Compare(variantID) == 0 {
			out = append(out, e)
		}
	}
	return out
}
