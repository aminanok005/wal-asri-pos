// Package usecase holds the catalog's application logic — the interactors that
// orchestrate a use case and talk to the outside world ONLY through ports it
// declares itself.
//
// ── WHY THE PORTS ARE DECLARED HERE AND NOT IN adapter/ ───────────────────────
//
// Dependency inversion. A use case that imported its repository interface from
// `adapter/postgres` would need Postgres to compile its own tests, and the arrow
// would point from the application inward to the infrastructure — which is the
// direction Clean Architecture exists to prevent.
//
// So `CatalogRepository` is declared HERE, in the use case package, and
// `adapter/postgres` implements it. The interface is owned by the side that
// consumes it. internal/architecture/layers_test.go enforces that the arrow never
// gets reversed.
//
// ── WHAT AN INTERACTOR IS AND IS NOT ──────────────────────────────────────────
//
// It orchestrates: fetch, decide, assemble. It does NOT decide business rules —
// those live in `domain`, where they are testable without a database and are the
// only copy of the rules that counts. A use case that recomputes a VAT split or
// re-implements a sellability check has created a second implementation of an
// accounting rule, which is the drift this whole service is arranged to prevent.
package usecase

import (
	"context"
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"

	"wal-asri-pos/services/api-backend/internal/catalog/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

// CatalogRepository reads catalogue rows from the authoritative store.
//
// Every method is branch-scoped. That is not an oversight in the signature — the
// contract is explicit that reads are scoped by `branch_id` "because catalog and
// pricing are branch-specific (each branch has its own price list and VAT rate)",
// and a repository method without a branch would be an unscoped read waiting to
// be called.
//
// The `since` parameter implements the incremental pull. Passing nil means a full
// snapshot; passing a timestamp returns only rows changed strictly after it. The
// `domain.CatalogQuery.ChangedAfter` rule is the authority on the boundary, and an
// implementation MUST use it rather than re-deciding `>` vs `>=` in SQL.
type CatalogRepository interface {
	// Categories returns categories for a branch changed strictly after since.
	Categories(ctx context.Context, branchID identity.UUIDv7, since *time.Time) ([]Category, error)
	// Products returns products for a branch changed strictly after since.
	Products(ctx context.Context, branchID identity.UUIDv7, since *time.Time) ([]Product, error)
	// Variants returns variants whose PRODUCT is in the branch, changed strictly
	// after since.
	Variants(ctx context.Context, branchID identity.UUIDv7, since *time.Time) ([]ProductVariant, error)
	// PriceListEntries returns price entries for the branch's variants, changed
	// strictly after since.
	PriceListEntries(ctx context.Context, branchID identity.UUIDv7, since *time.Time) ([]PriceListEntry, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Row types
// ─────────────────────────────────────────────────────────────────────────────

// The repository returns the domain types themselves rather than its own row
// structs.
//
// That is a deliberate simplification of the usual Clean Architecture pattern,
// where a repository maps between its storage row type and a domain type. The
// reason it is safe here: the domain types in `catalog/domain` carry no behaviour
// that depends on how they were loaded, and a Postgres `BIGINT` maps to Go int64
// and a `UUID` to a `[16]byte` without ambiguity. Adding a parallel set of row
// structs would be three more types per entity to keep in step, with nothing
// checking that they agree.
//
// The mapping that DOES need care is `numeric`/`decimal` — Postgres's exact-decimal
// type — and that is handled in the adapter, not here.

// Category is a menu grouping row.
type Category = domain.Category

// Product is a sellable concept row.
type Product = domain.Product

// ProductVariant is a sellable SKU row.
type ProductVariant = domain.ProductVariant

// PriceListEntry is one variant's price under one price list.
type PriceListEntry = domain.PriceListEntry

// Snapshot is an assembled catalogue snapshot.
type Snapshot = domain.CatalogSnapshot

// Query is a validated GET /catalog request.
type Query = domain.CatalogQuery

// ─────────────────────────────────────────────────────────────────────────────
// The interactor
// ─────────────────────────────────────────────────────────────────────────────

// GetCatalog is the sync-down interactor behind `GET /catalog`.
//
// It is the read that REPLACES a network call on the sell path. ARCHITECTURE-DEMO.md
// §4: once cached, "the UI reads only from local SQLite and never blocks on the
// network". So this runs on a schedule and on first sync, never during a sale, and
// its whole job is to hand back a correct, resumable snapshot.
//
// It computes NO business rules. Filtering by active-ness is already resolved by the
// query object, sellability is already a domain type, and the cursor is already
// built. What is left is orchestration — fetch four collections, assemble, stamp
// the cursor — and orchestration is exactly what a use case is for.
type GetCatalog struct {
	repo CatalogRepository
	// clock supplies "now" for the snapshot's pulled_at, which becomes the cursor
	// the client resumes from. Injected so the cursor is reproducible in a test;
	// calling time.Now() directly would make every assertion on the cursor a
	// tolerance comparison, which is how a sync bug hides.
	clock func() time.Time
}

// NewGetCatalog wires the interactor.
func NewGetCatalog(repo CatalogRepository, clock func() time.Time) *GetCatalog {
	return &GetCatalog{repo: repo, clock: clock}
}

// Execute assembles one snapshot.
//
// The `pulled_at` is taken ONCE, before any read, and used for the cursor. That
// ordering is load-bearing and easy to get backwards: if the clock were read after
// the queries, a row written during the pull would have `updated_at` between the
// last query and the cursor, and would be skipped by the next pull — a silent,
// permanent hole in a terminal's cached menu.
//
// So: stamp first, then read. Rows written after the stamp are picked up next time,
// which duplicates at worst and loses nothing.
func (g *GetCatalog) Execute(ctx context.Context, q Query) (Snapshot, error) {
	pulledAt := g.clock().UTC()

	categories, err := g.repo.Categories(ctx, q.BranchID, q.Since)
	if err != nil {
		return Snapshot{}, fmt.Errorf("catalog: reading categories for branch %s: %w", q.BranchID, err)
	}
	products, err := g.repo.Products(ctx, q.BranchID, q.Since)
	if err != nil {
		return Snapshot{}, fmt.Errorf("catalog: reading products for branch %s: %w", q.BranchID, err)
	}
	variants, err := g.repo.Variants(ctx, q.BranchID, q.Since)
	if err != nil {
		return Snapshot{}, fmt.Errorf("catalog: reading variants for branch %s: %w", q.BranchID, err)
	}
	prices, err := g.repo.PriceListEntries(ctx, q.BranchID, q.Since)
	if err != nil {
		return Snapshot{}, fmt.Errorf("catalog: reading price list entries for branch %s: %w", q.BranchID, err)
	}

	snapshot := Snapshot{
		BranchID:         q.BranchID,
		Categories:       categories,
		Products:         products,
		Variants:         variants,
		PriceListEntries: prices,
		Cursor:           domain.NewSyncCursor(pulledAt),
		PulledAt:         pulledAt,
	}

	// `include_inactive` is applied HERE, after assembly, rather than in the
	// repository. Two reasons, and the second is the important one:
	//
	//   1. A variant's sellability depends on its PRODUCT's `is_active`, so
	//      filtering variants in SQL would need a join per variant and would
	//      duplicate the domain rule in query text.
	//   2. If the repository filtered, an incremental pull with
	//      `include_inactive=false` would silently DROP a row from the delta
	//      without telling the terminal to delete it. The client's cache would keep
	//      a product the server no longer offers. Filtering the RESPONSE is safe;
	//      filtering the DELTA is not — a retraction has to be transmitted.
	//
	// So the full delta is always fetched, and this only shapes what is returned.
	if !q.IncludeInactive {
		snapshot.Categories = activeOnly(snapshot.Categories)
		snapshot.Products = activeOnly(snapshot.Products)
		snapshot.Variants = activeOnly(snapshot.Variants)
	}

	return snapshot, nil
}

// activeOnly drops rows whose `is_active` is false.
//
// The contract: "`is_active` is a boolean and is the single source of truth for
// 'available to sell'. Omit or set false to receive only sellable items."
//
// Note it drops the ROW rather than emitting a tombstone. That is correct for a
// FULL snapshot, and the reason `include_inactive` cannot be used to build a
// delta is documented above.
func activeOnly[T interface{ Active() bool }](in []T) []T {
	out := make([]T, 0, len(in))
	for _, row := range in {
		if row.Active() {
			out = append(out, row)
		}
	}
	return out
}
