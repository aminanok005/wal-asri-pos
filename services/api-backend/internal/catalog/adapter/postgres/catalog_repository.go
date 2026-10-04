// Package postgres holds the catalogue's SQL driver. It is a documented SKELETON,
// and the honesty here is the point.
//
// ── WHY THIS IS EMPTY ─────────────────────────────────────────────────────────
//
// Two independent blockers, and they are different in kind:
//
//  1. `sqlc` is HELD. SKILL.md §3.2 says so and §3.4 says why: `sqlc` and `goose`
//     belong to the same unblockable backend step as `grit`, and the standing
//     instruction is not to substitute another tool for any of them.
//
//  2. There is no schema to generate against. `db/migrations/` is empty. The data
//     model is described in docs/02-design/DOMAIN.md, but a prose table list is
//     not a migration, and writing `CREATE TABLE` here would be inventing a
//     storage contract nobody has ratified — in the one layer where a wrong
//     guess is hardest to unwind.
//
// So this file pins the SHAPE: the four methods `usecase.CatalogRepository`
// requires, the SQL each must run, and the two rules an implementation must not
// get wrong. When `sqlc` arrives, the queries move to `db/queries/catalog.sql` and
// this file becomes generated code plus these constraints as documentation.
//
// ── THE TWO RULES AN IMPLEMENTATION MUST NOT GET WRONG ────────────────────────
//
//  1. THE `since` FILTER IS STRICTLY GREATER-THAN. `updated_at > $since`, never
//     `>=`. With `>=`, a terminal re-issuing a pull after a dropped response
//     replays the last row forever and its `last_seen_id` never advances. The
//     domain owns the rule (`CatalogQuery.ChangedAfter`) and this layer must
//     implement it rather than re-decide it.
//
//  2. EVERY READ IS BRANCH-SCOPED, INCLUDING THE VARIANT JOIN. A variant has no
//     `branch_id` of its own — its branch comes through `products`. An unscoped
//     variant read is a cross-tenant data leak, and the contract is explicit that
//     the server "never trusts a client-asserted branch id".
package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	catalog "wal-asri-pos/services/api-backend/internal/catalog/domain"
	cataloguc "wal-asri-pos/services/api-backend/internal/catalog/usecase"
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
)

// ErrNotImplemented is returned by every method here.
//
// Named rather than returning nil, because a driver that returns an empty slice
// looks like "this branch has no catalogue" — a condition the system would
// happily serve as a full snapshot and cache on a terminal forever.
var ErrNotImplemented = errors.New(
	"catalog/postgres: not implemented. sqlc is HELD (SKILL.md §3.2/§3.4) and db/migrations " +
		"is empty, so there is no schema to generate against. This driver must not be wired into " +
		"the composition root until both are resolved")

// CatalogRepository is the Postgres implementation of usecase.CatalogRepository.
//
// It exists as a type so the interface assertion is checked at compile time and
// so the composition root's wiring is a one-line change when the body lands.
type CatalogRepository struct{}

// InterfaceCheck fails to compile if the port and this type drift apart. The
// assertion is the point: adding a method to the port without implementing it here
// must break the build, not surface as a nil-pointer panic on first sync.
var _ cataloguc.CatalogRepository = (*CatalogRepository)(nil)

// Categories reads a branch's categories, optionally only those changed after
// `since`.
//
//	SELECT id, branch_id, name_th, name_en, parent_id, sequence,
//	       is_active, version, created_at, updated_at
//	  FROM categories
//	 WHERE branch_id = $1
//	   AND ($2::timestamptz IS NULL OR updated_at > $2)   -- STRICTLY greater
//	 ORDER BY sequence, id
//
// The ORDER BY is deterministic: `sequence` alone is not unique, and without the
// `id` tiebreak two pulls of the same data can return rows in different orders,
// which makes a diff-based terminal reconcile flap.
//
// The `($2::timestamptz IS NULL OR ...)` form is deliberate: one prepared
// statement serves both the full snapshot and the delta, so the parameter is never
// built by string concatenation — which is how a timestamp becomes an injection
// vector.
func (r *CatalogRepository) Categories(_ context.Context, _ identity.UUIDv7, _ *time.Time) ([]cataloguc.Category, error) {
	return nil, ErrNotImplemented
}

// Products reads a branch's products. Same WHERE and ORDER BY shape as
// Categories, with `ORDER BY name_th, id`.
//
// A product references a category, so ordering by category sequence would need a
// join that excludes uncategorised products — and `category_id` is nullable, so
// excluding them would be a bug, not a choice.
func (r *CatalogRepository) Products(_ context.Context, _ identity.UUIDv7, _ *time.Time) ([]cataloguc.Product, error) {
	return nil, ErrNotImplemented
}

// Variants reads the variants whose PRODUCT belongs to the branch.
//
//	SELECT v.id, v.product_id, v.sku, v.barcode, v.name_th, v.name_en,
//	       v.size, v.image_url, v.is_active, v.version, v.created_at, v.updated_at
//	  FROM product_variants v
//	  JOIN products p ON p.id = v.product_id
//	 WHERE p.branch_id = $1
//	   AND ($2::timestamptz IS NULL OR v.updated_at > $2)
//	 ORDER BY v.id
//
// THE JOIN IS THE WHOLE POINT of the branch filter here. A variant carries no
// branch column, so `WHERE v.branch_id` does not exist to write; scoping it any
// other way is either a cross-tenant leak or an unindexed scan.
//
// Ordering by `v.id` is not arbitrary: UUIDv7 sorts chronologically, so this is
// creation order across devices with no coordination — the same property that
// makes the id usable as a primary key on an offline device (SKILL.md §2.2).
func (r *CatalogRepository) Variants(_ context.Context, _ identity.UUIDv7, _ *time.Time) ([]cataloguc.ProductVariant, error) {
	return nil, ErrNotImplemented
}

// PriceListEntries reads the price entries in force for a branch's variants.
//
//	SELECT e.id, e.price_list_id, e.product_variant_id,
//	       e.unit_price_satang, e.currency_code, e.version,
//	       e.created_at, e.updated_at
//	  FROM price_list_entries e
//	  JOIN product_variants v ON v.id = e.product_variant_id
//	  JOIN products p        ON p.id = v.product_id
//	  JOIN price_lists  l    ON l.id = e.price_list_id
//	 WHERE p.branch_id = $1
//	   AND ($2::timestamptz IS NULL OR e.updated_at > $2)
//	 ORDER BY e.id
//
// The `price_lists` join is required for correctness, not for filtering: a variant
// may legitimately appear in several price lists (standard and promotional), and
// the client resolves which is active for the branch. Returning entries from a
// DIFFERENT branch's price list would let a terminal price an item from another
// shop's list.
//
// `unit_price_satang` is a `bigint` on the wire and in the column. It is VAT-INCLUSIVE
// — see the long note on `catalog.PriceListEntry` — and the extraction happens once
// per ORDER in `internal/order/domain`. This driver must never compute tax.
func (r *CatalogRepository) PriceListEntries(_ context.Context, _ identity.UUIDv7, _ *time.Time) ([]cataloguc.PriceListEntry, error) {
	return nil, ErrNotImplemented
}

// Scanning money and quantities, for whoever writes this file next.
//
// Two column types need a conversion the standard `database/sql` scanners do not
// provide, and both are money-shaped mistakes waiting to happen:
//
//   - `unit_price_satang bigint` → `money.Satang` (int64). Direct, but note the
//     `MaxSafeSatang` ceiling: a value above 2^53-1 would lose precision as a
//     JSON number on the client, so `money.SatangOf` refuses it rather than
//     truncating.
//   - `quantity numeric(10,3)` → `money.Quantity` (milli-units). Postgres's
//     `numeric` scans into `[]byte` as TEXT and must be parsed with
//     `money.ParseQuantity`, which is strict. Scanning it into a float64 and
//     multiplying is the exact error this entire service is arranged to prevent:
//     `numeric` exists in the schema precisely because quantities are exact
//     decimals and a float would reintroduce `3 * 0.1 = 0.30000000000000004`.
//
// There is deliberately no `Scan` method on `money.Satang` or `money.Quantity` in
// their own packages: implementing it would mean `database/sql` imports inside
// `domain/`, which internal/architecture/layers_test.go forbids. The conversion
// belongs here, in the layer that is allowed to know about both.
func scanNote() string {
	return fmt.Sprintf(
		"numeric columns are scanned as text and parsed with money.ParseQuantity; "+
			"bigint satang are scanned as int64 and bounded by money.MaxSafeSatang (%d)", maxSafeSatang)
}

// maxSafeSatang is quoted in the note above. Declared here rather than importing
// the constant so this skeleton compiles without pulling the money kernel into a
// package that does not yet use it.
const maxSafeSatang = 1<<53 - 1

// VerifyCatalogDomainIsImportable is a compile-time check that the domain and
// usecase types this driver must produce are the ones the port declares.
//
// Without it, the `var _ cataloguc.CatalogRepository` assertion above would still
// pass while a rename to the domain types left the driver returning the wrong
// thing. It costs one line and it keeps the skeleton's shape honest.
var _ = catalog.ProductVariant{}
