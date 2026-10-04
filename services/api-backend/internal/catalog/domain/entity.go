// Package domain holds the catalog's business rules in pure Go.
//
// ── LAYER RULE ────────────────────────────────────────────────────────────────
//
// Nothing in this package may import a database driver, an HTTP framework, or
// anything from another module's `usecase/` or `adapter/`. It imports exactly
// two things, both shared kernels: `internal/money/domain` for the price type
// and `internal/identity/domain` for the key type. That constraint is not a
// convention here, it is tested — see internal/architecture/layers_test.go,
// which is the Go counterpart of the terminal's `layers.test.ts`.
//
// ── IDENTIFIERS ARE `identity.UUIDv7`, NOT PER-ENTITY WRAPPER TYPES ────────────
//
// A deliberate trade. The alternative — `type ProductID identity.UUIDv7` plus a
// wrapper per entity, each re-exposing String/Compare/Time/JSON — is about 150
// lines of boilerplate that buys almost nothing, because every value is built by
// naming struct fields (`Product{ID: id, ...}`), where the field name already
// states the type. It would also break comparison against a value that arrived
// through a generic map or a JSON decode, forcing a conversion at exactly the
// boundary where a mistake would be most expensive. Field names carry the
// meaning; `UUIDv7` carries the validation.
//
// ── WHY THERE IS NO `quantity`, NO `stock`, AND NO `promotion` HERE ────────────
//
// Those belong to `inventory` and to the promotion rules that the contract does
// not yet define. A catalogue knows what a thing costs and whether it may be
// sold. It does not know how much of it is on the shelf — `StockBalance` is
// derived server-side from a movement ledger, per the contract — and it does not
// know what discount applies, because the contract is explicit that a promotion
// never modifies a list price.
package domain

import (
	"fmt"
	"time"

	// Both shared kernels live in a directory named `domain`, so their package
	// name is `domain` too — which means every consumer MUST alias them. The
	// aliases below are the meaningful names and are used consistently across the
	// service. Importing them as `domain.UUIDv7` would collide with the enclosing
	// package's own name and read as if it referred to this package.
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// Version is the optimistic-concurrency counter.
//
// contracts/openapi.yaml, `Version`: "Optimistic-concurrency counter. The server
// increments it on every write. A client performing a conditional write sends the
// `version` it read; a mismatch is a conflict, never a silent overwrite."
//
// Every primary entity carries one, so a client applies one rule everywhere
// instead of learning a different comparison per entity.
type Version int64

// Next returns the version this entity would carry after a server-side write.
//
// A server write, specifically. The client never advances this — see
// ServerWinsPrice below for why a client-originated price change is refused
// rather than merged.
func (v Version) Next() Version { return v + 1 }

// CurrencyCode is an ISO 4217 code, `^[A-Z]{3}$`.
//
// The contract is clear that it is "Read from the owning `Branch`, never asserted
// by the client", which is why there is no parser here that would let a payload
// choose a currency. The only way to obtain one is to read it off a
// PriceListEntry that the server stored.
type CurrencyCode string

// THB is the Thai baht. A named constant rather than a bare literal so a typo
// cannot compile.
const THB CurrencyCode = "THB"

// IsValid reports whether c matches the contract's `^[A-Z]{3}$`.
func (c CurrencyCode) IsValid() bool {
	if len(c) != 3 {
		return false
	}
	for _, r := range c {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

// Category is a menu grouping, hierarchical through ParentID.
//
// Sequence is the manual sort order WITHIN the parent, lower first. It is a
// display concern, not a pricing one, so it carries no money.
type Category struct {
	ID       identity.UUIDv7
	BranchID identity.UUIDv7
	NameTH   string
	NameEN   string
	// ParentID is nil for a root category. Beverage → Coffee → Espresso.
	ParentID *identity.UUIDv7
	Sequence int32
	// IsActive is "shown to staff", which the contract explicitly distinguishes
	// from "has sellable items". A category can be visible and empty.
	IsActive  bool
	Version   Version
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Active reports whether the category is shown to staff.
//
// A method rather than a bare field read so the sync-down filter can be written
// once, generically, over every catalogue entity. A Go interface method cannot
// share a name with a field, hence `Active` and not `IsActive`.
func (c Category) Active() bool { return c.IsActive }

// Product is a sellable concept — "Iced Latte" — not a SKU.
//
// Prices do not live here. A product with several sizes has several variants,
// each with its own price, so a price on the product would be ambiguous the
// moment there was more than one size.
type Product struct {
	ID         identity.UUIDv7
	BranchID   identity.UUIDv7
	CategoryID *identity.UUIDv7
	NameTH     string
	NameEN     string
	// IsActive retires the product from the menu. Historical orders still
	// reference it — orders are append-only, so a retired product must remain
	// resolvable forever. That is why this is a boolean and not a delete.
	IsActive bool
	// IsCombo means the product is assembled from other variants via
	// ComboComponent, and selling it also consumes their stock.
	IsCombo bool
	// RecipeID points at the recipe driving ingredient consumption; nil for a
	// product with no tracked recipe.
	RecipeID  *identity.UUIDv7
	ImageURL  string
	Version   Version
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Active reports whether the product is sellable.
//
// See Category.Active for why the method is not named IsActive.
func (p Product) Active() bool { return p.IsActive }

// ProductVariant is a concrete sellable SKU — "Iced Latte, 12 oz".
//
// This is the row that carries a price and a stock balance. Two variants of one
// product are two different things to buy, at two different prices.
type ProductVariant struct {
	ID        identity.UUIDv7
	ProductID identity.UUIDv7
	// SKU is unique per branch, not globally — two branches may legitimately
	// stock the same SKU code for different products.
	SKU string
	// Barcode is additive and pending approval (the contract marks it
	// D-BARCODE). Optional and nullable so its absence never breaks
	// deserialisation.
	Barcode  *string
	NameTH   string
	NameEN   string
	Size     string
	ImageURL string
	// IsActive can be false while the parent Product stays active — a seasonal
	// size is retired without the whole product leaving the menu. This is why
	// sellability is a JOIN over two rows and not a single flag; see
	// Sellability below.
	IsActive  bool
	Version   Version
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Active reports whether the variant is sellable.
//
// See Category.Active for why the method is not named IsActive. Note that a TRUE
// here is necessary but NOT sufficient: see Sellable.IsSellable, which also
// requires the parent product to be active.
func (v ProductVariant) Active() bool { return v.IsActive }

// PriceList is a named set of prices with an effective window.
//
// Version is load-bearing here in a way it is not on most entities: the contract
// makes catalog and prices LAST-WRITE-WINS BY VERSION — "a client may not
// originate a price change". The catalogue is server-owned data that terminals
// cache; a terminal that could originate a price change could sell at the wrong
// price while offline and the server would have no way to tell.
type PriceList struct {
	ID       identity.UUIDv7
	BranchID identity.UUIDv7
	Name     string
	Version  Version
	// EffectiveFrom and EffectiveTo bound the window. EffectiveTo is nil for an
	// open-ended list.
	EffectiveFrom time.Time
	EffectiveTo   *time.Time
	IsActive      bool
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// IsEffectiveAt reports whether the list applies at instant t.
//
// Half-open, [from, to): EffectiveTo is exclusive. A list ending and the next
// beginning at the same instant then has exactly one match, instead of two
// overlapping ones and an arbitrary tie-break.
func (p PriceList) IsEffectiveAt(t time.Time) bool {
	if t.Before(p.EffectiveFrom) {
		return false
	}
	return p.EffectiveTo == nil || t.Before(*p.EffectiveTo)
}

// PriceListEntry is the price of ONE variant under ONE price list.
//
// The contract states plainly: "This is the only place a sell price appears in
// the contract." If a second place grows one, two sources of truth for a price
// will disagree and the till will charge whichever it read first.
//
// ── THE MOST IMPORTANT COMMENT IN THIS FILE ───────────────────────────────────
//
// The contract describes `unit_price_satang` as "Price for one unit, before tax
// and before discount".
//
// **"Before tax" does NOT mean "excluding VAT."** It means the tax has not yet
// been SEPARATED OUT of the amount — it is still inside it. Every price in this
// system is VAT-INCLUSIVE: ฿45.50 on the menu is what the customer pays and ฿2.98
// of it is tax, because that is the actual Thai retail convention this product
// implements (docs/02-design/DOMAIN.md §"VAT is INCLUSIVE").
//
// Reading "before tax" as "before adding tax" would put forward VAT in the
// checkout path, which yields ฿3.19 instead of ฿2.98 on that same sale — a
// different amount of money on every single transaction, filed on the ภ.พ.30
// return. The extraction happens once per order, in `order/domain`, via
// `money.SplitInclusiveVAT`.
//
// "And before discount" is equally literal: the figure here is the list price.
// A promotion is a SEPARATE resolved amount applied at checkout and never
// rewrites this value — "the list price stays comparable across periods".
type PriceListEntry struct {
	ID             identity.UUIDv7
	PriceListID    identity.UUIDv7
	ProductVariant identity.UUIDv7
	// UnitPriceSatang is MONEY — integer satang, VAT-inclusive. ฿45.50 is 4550.
	UnitPriceSatang money.Satang
	CurrencyCode    CurrencyCode
	Version         Version
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Valid reports whether the entry is internally consistent.
//
// A zero price is NOT an error — a giveaway item and a staff meal are both real
// — but a MISSING currency is, because an entry with no currency cannot be
// reconciled against any ledger.
func (e PriceListEntry) Valid() error {
	if !e.CurrencyCode.IsValid() {
		return fmt.Errorf("catalog: price list entry %s has currency %q, want three upper-case letters",
			e.ID, e.CurrencyCode)
	}
	return nil
}

// ServerWinsPrice resolves two versions of one price-list entry into the one the
// server keeps.
//
// The contract, on GET /catalog: "**Server wins on price.** Catalog and prices
// are last-write-wins by `version` — a client may not originate a price change."
//
// So the reconciliation is not a merge and not a "pick the larger timestamp" —
// it is a total order on `version`, with the server's own row as the tie-break
// when the versions match. A tie is not an error and must not be surfaced as
// one: two terminals replaying the same outbox can legitimately present the same
// version twice, and refusing that would make the sync loop unable to make
// progress.
func ServerWinsPrice(current, incoming PriceListEntry) PriceListEntry {
	switch {
	case incoming.Version > current.Version:
		return incoming
	case incoming.Version < current.Version:
		return current
	default:
		return current
	}
}
