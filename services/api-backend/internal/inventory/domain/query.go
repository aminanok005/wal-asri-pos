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
package domain

import (
	"fmt"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
)

// ─────────────────────────────────────────────────────────────────────────────
// The balances query and the incremental-pull contract
// ─────────────────────────────────────────────────────────────────────────────
//
// GET /inventory/balances is a read-only snapshot of current stock levels.
//
// Two mechanics therefore have to be exactly right:
//
//   - the SYNC CURSOR, which is `updated_at` rather than an offset. The contract:
//     `cursor` is "Equal to the `pulled_at` of this response."
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
// ── PAGINATION ─────────────────────────────────────────────────────────────────
//
// The endpoint supports cursor-based pagination via the `cursor` and `limit`
// parameters. The cursor is an opaque token returned as `next_cursor` in the
// previous response. When present, the query resumes from that position.
//
// The `limit` parameter is capped at MaxPageSize. A client asking for everything
// gets a page rather than the whole branch.

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

// BalancesQuery is GET /inventory/balances' request, as a validated value.
//
// Validated rather than merely parsed, so the limit and the branch scope are
// checked before a use case or an adapter sees them.
type BalancesQuery struct {
	// BranchID is required. Stock is branch-scoped, so there is no sensible
	// default — the contract marks the parameter `required: true`.
	BranchID identity.UUIDv7

	// Since is the incremental-pull cursor. Nil means a FULL snapshot, which is
	// what a terminal that has never synced sends.
	Since *time.Time

	// Cursor is an opaque pagination cursor from a previous `next_cursor`.
	Cursor string

	// Limit is the page size.
	Limit int32

	// ItemIDs is an optional filter to restrict the response to specific
	// inventory items. When empty, all tracked items in the branch are returned.
	ItemIDs []identity.UUIDv7
}

// NewBalancesQuery applies the contract's defaults and validates the result.
func NewBalancesQuery(
	branchID identity.UUIDv7,
	since *time.Time,
	cursor string,
	limit int32,
	itemIDs []identity.UUIDv7,
) (BalancesQuery, error) {
	q := BalancesQuery{
		BranchID: branchID,
		Since:    since,
		Cursor:   cursor,
		Limit:    limit,
		ItemIDs:  itemIDs,
	}
	if q.Limit == 0 {
		q.Limit = DefaultPageSize
	}
	if q.Limit < MinPageSize || q.Limit > MaxPageSize {
		return BalancesQuery{}, fmt.Errorf(
			"inventory: limit %d is out of range; the contract allows %d..%d",
			q.Limit, MinPageSize, MaxPageSize)
	}
	return q, nil
}

// IsIncremental reports whether this pull asks for a delta rather than a full
// snapshot.
func (q BalancesQuery) IsIncremental() bool { return q.Since != nil }

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
func (q BalancesQuery) ChangedAfter(updatedAt time.Time) bool {
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

// BalancesSnapshot is one pull's result: the balances plus the cursor to resume from.
//
// Mirrors the contract's `InventoryBalancesResponse` required fields exactly —
// `branch_id`, `balances`, `cursor`, `pulled_at` — with `next_cursor` nil-able.
type BalancesSnapshot struct {
	BranchID  identity.UUIDv7
	Balances  []StockBalance

	// Cursor resumes this pull. Equal to PulledAt.
	Cursor SyncCursor
	// PulledAt is server time this snapshot was taken, RFC 3339 UTC.
	PulledAt time.Time

	// NextCursor is non-nil only when the response is PARTIAL. Nil means the pull
	// is complete and the terminal's cache is whole.
	//
	// This is an opaque string that the client sends back as `cursor`. The format
	// is an implementation detail — here it encodes the boundary as
	// "updated_at|inventory_item_id" for stable pagination across concurrent
	// inserts.
	NextCursor *string
}

// IsPartial reports whether more pages remain.
func (s BalancesSnapshot) IsPartial() bool { return s.NextCursor != nil }