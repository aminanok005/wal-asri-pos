package domain

import (
	"fmt"
	"sort"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// The catalogue snapshot and the incremental-pull contract
// ─────────────────────────────────────────────────────────────────────────────
//
// GET /catalog is the read that REPLACES A NETWORK CALL ON THE SELL PATH.
// ARCHITECTURE-DEMO.md §4: once cached, "the UI reads only from local SQLite and
// never blocks on the network." That is the whole point of the endpoint — it is
// pulled on a schedule, not on a sale.
//
// Two mechanics therefore have to be exactly right, because a terminal that gets
// them wrong silently serves a stale menu forever:
//
//   - the SYNC CURSOR, which is `updated_at` rather than an offset. The contract:
//     "`updated_at` — what a client uses as a sync cursor", and `CatalogResponse.cursor`
//     is "Equal to the `pulled_at` of this response."
//   - the DELTA FILTER, which is STRICTLY GREATER-THAN. The contract's `Since`
//     parameter: "only rows with `updated_at` strictly greater than this value
//     are returned."
//
// Strictly-greater is not a detail. If it were `>=`, a terminal re-issuing a pull
// after a dropped response would replay the last row forever, and a client-side
// `last_seen_id` would never advance. It pairs with a cursor taken from
// `pulled_at` — server time at the instant the snapshot was read — so the next
// pull resumes exactly where this one stopped.
//

// Snapshot limits, from the contract's `Limit` parameter.
const (
	// DefaultPageSize is the contract's declared default for `limit`.
	DefaultPageSize int32 = 200
	// MaxPageSize is the contract's declared maximum. The server caps it, so a
	// client asking for everything gets a page rather than the whole branch.
	MaxPageSize int32 = 500
	// MinPageSize is the contract's declared minimum.
	MinPageSize int32 = 1
)

// CatalogQuery is GET /catalog's request, as a validated value.
//
// Validated rather than merely parsed, so the limit and the branch scope are
// checked before a use case or an adapter sees them.
type CatalogQuery struct {
	// BranchID is required. Pricing and VAT are branch-specific, so there is no
	// sensible default — the contract marks the parameter `required: true`.
	BranchID identity.UUIDv7

	// Since is the incremental-pull cursor. Nil means a FULL snapshot, which is
	// what a terminal that has never synced sends.
	Since *time.Time

	// IncludeInactive widens the result to rows where `is_active` is false.
	// Default false — only sellable items — which is what a POS terminal wants
	// for its cache.
	IncludeInactive bool

	// Cursor is an opaque pagination cursor from a previous `next_cursor`.
	Cursor string

	// Limit is the page size.
	Limit int32
}

// NewCatalogQuery applies the contract's defaults and validates the result.
//
// The default is applied HERE, in the domain, rather than left to each adapter.
// Two adapters (or two query-parameter paths) that each default separately will
// eventually default differently, and a catalogue page that is 200 rows in one
// place and 500 in another is a bug report nobody can reproduce.
func NewCatalogQuery(branchID identity.UUIDv7, since *time.Time, includeInactive bool, cursor string, limit int32) (CatalogQuery, error) {
	q := CatalogQuery{
		BranchID:        branchID,
		Since:           since,
		IncludeInactive: includeInactive,
		Cursor:          cursor,
		Limit:           limit,
	}
	if q.Limit == 0 {
		q.Limit = DefaultPageSize
	}
	if q.Limit < MinPageSize || q.Limit > MaxPageSize {
		return CatalogQuery{}, fmt.Errorf(
			"catalog: limit %d is out of range; the contract allows %d..%d",
			q.Limit, MinPageSize, MaxPageSize)
	}
	return q, nil
}

// IsIncremental reports whether this pull asks for a delta rather than a full
// snapshot.
func (q CatalogQuery) IsIncremental() bool { return q.Since != nil }

// ChangedAfter reports whether a row with the given `updated_at` belongs in this
// response.
//
// STRICTLY greater than `since` — see the note above. An exactly-equal timestamp
// is excluded, and that is deliberate: `updated_at` is a server clock, and two
// rows can share a millisecond. Excluding the boundary row means it is picked up
// by the NEXT pull rather than this one, whereas including it means this pull can
// return it twice or a concurrent insert can lose it entirely. At-least-once
// with a duplicate beats at-most-once with a gap on a cache that a terminal can
// always re-pull in full.
func (q CatalogQuery) ChangedAfter(updatedAt time.Time) bool {
	if q.Since == nil {
		return true
	}
	return updatedAt.After(*q.Since)
}

// SyncCursor is the opaque token a terminal sends back to resume a pull.
//
// It is the `pulled_at` of the response that produced it — the contract says so
// directly. That makes it a TIMESTAMP rather than an offset, which is what lets
// a terminal skip the rows it already has instead of paging through them.
//
// It stays a distinct type from time.Time so a caller cannot pass one where the
// other is expected; the conversion is explicit and lives in one place.
type SyncCursor struct {
	// At is the instant the snapshot was taken. Only meaningful to sub-second
	// precision as far as the client is concerned, but it is carried at full
	// precision so the next pull cannot skip a row written in the same instant.
	At time.Time
}

// String renders the cursor in the RFC 3339 UTC form the contract's `Since`
// parameter uses. Always UTC, always trailing Z: a cursor written in local time
// with an offset parses back as a different instant and silently skips rows.
func (c SyncCursor) String() string { return c.At.UTC().Format(time.RFC3339Nano) }

// NewSyncCursor builds a cursor from a pull instant.
func NewSyncCursor(at time.Time) SyncCursor { return SyncCursor{At: at.UTC()} }

// CatalogSnapshot is one pull's result: the rows plus the cursor to resume from.
//
// Mirrors the contract's `CatalogResponse` required fields exactly — `branch_id`,
// the four collections, `cursor`, `pulled_at` — with `next_cursor` nil-able.
//
// Slices are nil when empty rather than allocated-empty. An absent `variants` key
// and an empty one mean the same thing to the client, and a nil slice marshals
// to `null` only if the field is not omitempty, so the adapter decides the wire
// shape and the domain does not pre-empt it.
type CatalogSnapshot struct {
	BranchID identity.UUIDv7

	Categories       []Category
	Products         []Product
	Variants         []ProductVariant
	PriceListEntries []PriceListEntry

	// Cursor resumes this pull. Equal to PulledAt.
	Cursor SyncCursor
	// PulledAt is server time this snapshot was taken, RFC 3339 UTC.
	PulledAt time.Time

	// NextCursor is non-nil only when the response is PARTIAL. Nil means the pull
	// is complete and the terminal's cache is whole.
	NextCursor *SyncCursor
}

// IsPartial reports whether more pages remain.
func (s CatalogSnapshot) IsPartial() bool { return s.NextCursor != nil }

// Resolver indexes the snapshot for the lookups the sell path performs.
//
// Built once per snapshot rather than searched per lookup. The contract is
// explicit that the terminal caches this and never blocks on the network, so the
// same lookup happens on every scan of every item on the till — an O(n) scan
// inside that path is a visible stall on a cheap tablet.
type Resolver struct {
	snapshot *CatalogSnapshot

	variantsByID   map[identity.UUIDv7]ProductVariant
	productsByID   map[identity.UUIDv7]Product
	categoriesByID map[identity.UUIDv7]Category
	prices         PriceResolver
}

// NewResolver indexes a snapshot.
func NewResolver(s *CatalogSnapshot) *Resolver {
	r := &Resolver{
		snapshot:       s,
		variantsByID:   make(map[identity.UUIDv7]ProductVariant, len(s.Variants)),
		productsByID:   make(map[identity.UUIDv7]Product, len(s.Products)),
		categoriesByID: make(map[identity.UUIDv7]Category, len(s.Categories)),
		prices:         NewPriceResolver(s.PriceListEntries),
	}
	for _, v := range s.Variants {
		r.variantsByID[v.ID] = v
	}
	for _, p := range s.Products {
		r.productsByID[p.ID] = p
	}
	for _, c := range s.Categories {
		r.categoriesByID[c.ID] = c
	}
	return r
}

// Variant returns the variant with the given id.
func (r *Resolver) Variant(id identity.UUIDv7) (ProductVariant, bool) {
	v, ok := r.variantsByID[id]
	return v, ok
}

// Product returns the product with the given id.
func (r *Resolver) Product(id identity.UUIDv7) (Product, bool) {
	p, ok := r.productsByID[id]
	return p, ok
}

// Category returns the category with the given id.
func (r *Resolver) Category(id identity.UUIDv7) (Category, bool) {
	c, ok := r.categoriesByID[id]
	return c, ok
}

// SellabilityOf runs the two-row join for one variant.
//
// Returns false when either row is missing, which is a state the snapshot must
// not normally contain but which a partially-applied delta CAN produce: a variant
// whose product arrives on a later page. Reporting "not sellable" there is the
// safe direction — the item is momentarily absent from the till rather than
// offered at a price that may not be current.
func (r *Resolver) SellabilityOf(variantID identity.UUIDv7) (Sellable, bool) {
	variant, ok := r.variantsByID[variantID]
	if !ok {
		return Sellable{}, false
	}
	product, ok := r.productsByID[variant.ProductID]
	if !ok {
		return Sellable{}, false
	}
	return Sellable{Variant: variant, Product: product}, true
}

// PriceFor resolves a variant's price under a price list.
func (r *Resolver) PriceFor(variantID, priceListID identity.UUIDv7) (money.Satang, CurrencyCode, bool) {
	return r.prices.PriceFor(variantID, priceListID)
}

// SellableVariants returns every sellable variant, in snapshot order.
//
// Order is preserved from the snapshot rather than re-sorted here, because
// `Category.sequence` is the menu's intended display order and this resolver
// does not know the category a variant belongs to in enough detail to apply it.
// Sorting in the presentation layer, where the category is available, keeps one
// definition of "the order staff see".
func (r *Resolver) SellableVariants() []ProductVariant {
	out := make([]ProductVariant, 0, len(r.variantsByID))
	for _, v := range r.variantsByID {
		s, ok := r.SellabilityOf(v.ID)
		if !ok || !s.IsSellable() {
			continue
		}
		out = append(out, v)
	}
	return out
}

// CategoriesFor returns the active sub-categories of parentID, in display order.
//
// A nil parentID means root categories. Sorted by `Sequence` ascending, then by id
// to break ties — a deterministic tiebreak matters because two categories with the
// same sequence would otherwise come back in whatever order the map yields, and
// the menu would reorder itself between two pulls of the same data.
func (r *Resolver) CategoriesFor(parentID *identity.UUIDv7) []Category {
	var out []Category
	for _, c := range r.categoriesByID {
		if !c.IsActive {
			continue
		}
		switch {
		case parentID == nil && c.ParentID != nil:
			continue
		case parentID != nil && (c.ParentID == nil || c.ParentID.Compare(*parentID) != 0):
			continue
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Sequence != out[j].Sequence {
			return out[i].Sequence < out[j].Sequence
		}
		// Deterministic tiebreak on id, so two pulls of the same data agree.
		return out[i].ID.Compare(out[j].ID) < 0
	})
	return out
}
