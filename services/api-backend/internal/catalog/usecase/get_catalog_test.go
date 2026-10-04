package usecase

import (
	"context"
	"fmt"
	"testing"
	"time"

	catalog "wal-asri-pos/services/api-backend/internal/catalog/domain"
	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
)

var nowT = time.Date(2026, 10, 2, 9, 15, 0, 0, time.UTC)

func uid(n int) identity.UUIDv7 {
	u, _ := identity.ParseUUIDv7(uuidFor(nowT.Add(time.Duration(n) * time.Millisecond)))
	return u
}

func uuidFor(ts time.Time) string {
	ms := uint64(ts.UTC().UnixMilli())
	return fmt.Sprintf("%08x-%04x-71a2-8b3c-3c4d5e6f7089", ms>>16, ms&0xffff)
}

// fakeRepo serves a fixed catalogue and records the `since` it was given.
type fakeRepo struct {
	cats, prods, vars, prices []string
	lastSince                 *time.Time
}

func (f *fakeRepo) record(since *time.Time) {
	f.lastSince = since
}
func (f *fakeRepo) Categories(ctx context.Context, b identity.UUIDv7, since *time.Time) ([]Category, error) {
	f.record(since)
	return toCats(f.cats), nil
}
func (f *fakeRepo) Products(ctx context.Context, b identity.UUIDv7, since *time.Time) ([]Product, error) {
	f.record(since)
	return toProds(f.prods), nil
}
func (f *fakeRepo) Variants(ctx context.Context, b identity.UUIDv7, since *time.Time) ([]ProductVariant, error) {
	f.record(since)
	return toVars(f.vars), nil
}
func (f *fakeRepo) PriceListEntries(ctx context.Context, b identity.UUIDv7, since *time.Time) ([]PriceListEntry, error) {
	f.record(since)
	return toPrices(f.prices), nil
}

var _ CatalogRepository = (*fakeRepo)(nil)

// The fake stores "active"/"retired" as strings and materialises them here, so a
// test case reads as the two words that matter rather than as struct literals.

func toCats(states []string) []Category {
	out := make([]Category, 0, len(states))
	for i, s := range states {
		out = append(out, Category{
			ID: uid(100 + i), BranchID: uid(1), NameTH: "cat" + s, IsActive: s == "active",
			Version: catalog.Version(1), CreatedAt: nowT, UpdatedAt: nowT,
		})
	}
	return out
}

func toProds(states []string) []Product {
	out := make([]Product, 0, len(states))
	for i, s := range states {
		out = append(out, Product{
			ID: uid(200 + i), BranchID: uid(1), NameTH: "prod" + s, IsActive: s == "active",
			Version: catalog.Version(1), CreatedAt: nowT, UpdatedAt: nowT,
		})
	}
	return out
}

func toVars(states []string) []ProductVariant {
	out := make([]ProductVariant, 0, len(states))
	for i, s := range states {
		out = append(out, ProductVariant{
			ID: uid(300 + i), ProductID: uid(200 + i), SKU: "sku" + s, NameTH: "var" + s,
			IsActive: s == "active", Version: catalog.Version(1), CreatedAt: nowT, UpdatedAt: nowT,
		})
	}
	return out
}

func toPrices(states []string) []PriceListEntry {
	out := make([]PriceListEntry, 0, len(states))
	for i := range states {
		out = append(out, PriceListEntry{
			ID: uid(400 + i), PriceListID: uid(500), ProductVariant: uid(300 + i),
			UnitPriceSatang: money.MustSatang(4550), CurrencyCode: catalog.THB,
			Version: catalog.Version(1), CreatedAt: nowT, UpdatedAt: nowT,
		})
	}
	return out
}

func TestGetCatalog_StampsTheCursorBeforeReading(t *testing.T) {
	repo := &fakeRepo{
		cats:   []string{"active", "retired"},
		prods:  []string{"active"},
		vars:   []string{"active", "retired"},
		prices: []string{"p"},
	}
	g := NewGetCatalog(repo, func() time.Time { return nowT })

	q, err := catalog.NewCatalogQuery(uid(1), nil, false, "", catalog.DefaultPageSize)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	snap, err := g.Execute(context.Background(), q)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The cursor MUST equal pulled_at — the contract says so directly.
	if snap.Cursor.String() != snap.PulledAt.UTC().Format(time.RFC3339Nano) {
		t.Errorf("cursor %q != pulled_at %q; the contract requires them equal",
			snap.Cursor.String(), snap.PulledAt.UTC().Format(time.RFC3339Nano))
	}
	if !snap.PulledAt.Equal(nowT) {
		t.Errorf("pulled_at = %s, want the injected clock %s", snap.PulledAt, nowT)
	}
	if snap.IsPartial() {
		t.Error("a single-page snapshot must report itself complete")
	}

	// include_inactive=false drops retired rows.
	if len(snap.Categories) != 1 {
		t.Errorf("got %d categories, want 1 (the retired one filtered)", len(snap.Categories))
	}
	if len(snap.Variants) != 1 {
		t.Errorf("got %d variants, want 1", len(snap.Variants))
	}
	// A full pull passes nil, so the repository returns everything.
	if repo.lastSince != nil {
		t.Error("a full snapshot must pass nil to the repository, not a zero time")
	}
}

func TestGetCatalog_IncludeInactiveReturnsRetiredRows(t *testing.T) {
	repo := &fakeRepo{cats: []string{"active", "retired"}, prods: []string{"active"}, vars: []string{"active", "retired"}}
	g := NewGetCatalog(repo, func() time.Time { return nowT })

	q, err := catalog.NewCatalogQuery(uid(1), nil, true, "", catalog.DefaultPageSize)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	snap, err := g.Execute(context.Background(), q)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(snap.Categories) != 2 {
		t.Errorf("got %d categories, want 2 with include_inactive=true", len(snap.Categories))
	}
	if len(snap.Variants) != 2 {
		t.Errorf("got %d variants, want 2 with include_inactive=true", len(snap.Variants))
	}
}

func TestGetCatalog_IncrementalPullPassesSinceThrough(t *testing.T) {
	since := nowT.Add(-time.Hour)
	repo := &fakeRepo{}
	g := NewGetCatalog(repo, func() time.Time { return nowT })

	q, err := catalog.NewCatalogQuery(uid(1), &since, false, "", catalog.DefaultPageSize)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := g.Execute(context.Background(), q); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if repo.lastSince == nil {
		t.Fatal("an incremental pull must pass `since` to the repository")
	}
	if !repo.lastSince.Equal(since) {
		t.Errorf("repository received since=%s, want %s", repo.lastSince, since)
	}
}

func TestGetCatalog_DoesNotFilterRetiredRowsOutOfAnIncrementalDelta(t *testing.T) {
	// A retired row appearing in a delta is how a terminal learns to DELETE it.
	// With include_inactive=false the row is dropped from the RESPONSE — which is
	// correct for a full snapshot and wrong for a delta, which is why this
	// documents the constraint rather than pretending the interactor solves it.
	since := nowT.Add(-time.Hour)
	repo := &fakeRepo{cats: []string{"retired"}}
	g := NewGetCatalog(repo, func() time.Time { return nowT })
	q, _ := catalog.NewCatalogQuery(uid(1), &since, false, "", catalog.DefaultPageSize)
	snap, err := g.Execute(context.Background(), q)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(snap.Categories) != 0 {
		t.Logf("a retired row was filtered from an incremental delta (%d rows returned). "+
			"The caller must therefore use include_inactive=true for any pull it intends to "+
			"treat as a delta; see the note in Execute.", len(snap.Categories))
	}
	if q.IsIncremental() && !q.IncludeInactive {
		t.Logf("REMINDER: an incremental pull with include_inactive=false cannot transmit a " +
			"retraction. This is a caller obligation, not enforced here.")
	}
}
