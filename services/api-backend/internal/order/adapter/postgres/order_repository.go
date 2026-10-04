// Package postgres holds the order module's SQL driver. A documented SKELETON, for
// the same two reasons as the catalogue's: `sqlc` is HELD (SKILL.md §3.2/§3.4) and
// `db/migrations/` is empty, so there is no schema to generate against.
//
// What is pinned here is more valuable than the catalogue's, because the ORDER
// write path has two properties the read path does not:
//
//  1. APPEND-ONLY, enforced by the database. ARCHITECTURE-DEMO.md §9: "Orders:
//     append-only, never edited, so no conflict." That is not a convention a Go
//     caller observes — it has to be a `CHECK` or a trigger, because a service
//     bug must fail at COMMIT rather than quietly rewrite a sale.
//
//  2. THE VAT IDENTITIES, re-derived in SQL. DOMAIN.md records the terminal's
//     `0001_init.sql` as "not a passive container. It re-derives the tax and
//     refuses any row that does not match, so a bug in the cart maths fails at
//     COMMIT inside the §2.2 transaction instead of becoming an unbalanced
//     receipt."
//
//     That is worth restating as the reason this service has three copies of the
//     VAT rule (TypeScript, SQLite CHECK, this Go kernel) and must never have a
//     fourth: the SQL CHECK is what makes a wrong total impossible to STORE, not
//     merely impossible to produce through the use case.
//
// The CHECKs the order table needs, verbatim from DOMAIN.md, with gross defined as
// `subtotal_satang - discount_satang`:
//
//	CHECK (discount_satang <= subtotal_satang),
//	CHECK (total_satang = subtotal_satang - discount_satang
//	                     + service_charge_satang + rounding_adjustment_satang),
//	CHECK (taxable_satang + tax_satang
//	       = total_satang - service_charge_satang - rounding_adjustment_satang),
//	CHECK (tax_satang = gross - round_half_up(gross * 10000 / (10000 + vat_rate_bp)))
//
// Note what is ABSENT from the third: any term adding tax to the total. Under
// inclusive pricing the tax is already inside the amount charged, and including it
// would bill the customer twice — the exact failure the removed
// `taxable = subtotal - discount` identity used to allow.
package postgres

import (
	"context"
	"errors"
	"time"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
	sync "wal-asri-pos/services/api-backend/internal/sync/domain"
)

// ErrNotImplemented is returned by every method here. See the catalogue driver for
// why the same note applies.
var ErrNotImplemented = errors.New(
	"order/postgres: not implemented. sqlc is HELD (SKILL.md §3.2/§3.4) and db/migrations " +
		"is empty, so there is no schema to generate against. This driver must not be wired into " +
		"the composition root until both are resolved")

// ─────────────────────────────────────────────────────────────────────────────
// OrderRepository
// ─────────────────────────────────────────────────────────────────────────────

// OrderRepository is the Postgres implementation of usecase.OrderRepository.
type OrderRepository struct{}

// InterfaceCheck fails to compile if the port drifts from this type.
var _ orderuc.OrderRepository = (*OrderRepository)(nil)

// Append inserts one order, its lines and its outbox record.
//
// THREE statements, and they must share ONE transaction. That is not a batching
// convenience — it is the property the whole offline-first design rests on. The
// terminal writes its order and its outbox event atomically so that "no order
// without a sync record" is guaranteed (SKILL.md §2.2, ARCHITECTURE-DEMO.md §4).
// This side has the same obligation in reverse: an order that exists here with no
// idempotency record would be invisible to the deduplication that protects it.
//
//	INSERT INTO orders (
//	  id, branch_id, terminal_id, staff_user_id, dining_table_id, customer_id,
//	  type, status, source, status_at,
//	  total_satang, taxable_satang, tax_satang,
//	  discount_satang, service_charge_satang,
//	  subtotal_satang, rounding_adjustment_satang, vat_rate_bp,
//	  version, created_at, updated_at)
//	VALUES (...)
//
// Three things about that column list:
//
//   - `id` is a client-generated UUIDv7 and MUST NOT be generated here. A
//     server-assigned id cannot be produced by an offline terminal, so checkout
//     would block without a network.
//   - `vat_rate_bp` is stored WITH the order. Not looked up from the branch at
//     report time: a receipt must be re-priceable at the rate it was SOLD at, and
//     a branch that changes rate must not retroactively alter a historical
//     receipt. This is the server-side twin of the client's per-order rounding.
//   - `subtotal_satang` and `vat_rate_bp` do not exist in DOMAIN.md's `Order`
//     field list, which jumps from `discount_satang` to `taxable_satang`. They
//     are needed to re-derive the CHECKs above without re-reading the lines, and
//     their absence from the field list is worth reconciling before the migration
//     is written.
//
// The uniqueness that makes this safe to retry:
//
//	ON CONFLICT (id) DO NOTHING
//
// A retried submission reaches here twice — the terminal cannot distinguish a lost
// response from a crash — and `DO NOTHING` plus a "did I insert?" check is what
// makes the append idempotent on the client-generated primary key. It is the
// fallback for the window in `IngestOrder.Execute` where the order commits but the
// idempotency record fails to save.
//
// Lines are inserted in the same transaction, and `line_tax_satang` is written as
// a CONSTANT 0. DOMAIN.md: it "is constrained to `0`, since rounding is per order
// and a per-line figure would be a second, differently rounded copy of money the
// order total already contains".
func (r *OrderRepository) Append(_ context.Context, _ order.Order) error {
	return ErrNotImplemented
}

// ─────────────────────────────────────────────────────────────────────────────
// BranchRateSource
// ─────────────────────────────────────────────────────────────────────────────

// BranchRate is the Postgres implementation of usecase.BranchRateSource.
//
// A one-query implementation, and it is on the critical path of every ingest: the
// server re-prices every incoming order at the branch's CURRENT rate, which is the
// whole re-validation mechanism.
//
//	SELECT vat_rate_bp FROM branches WHERE id = $1
//
// The value is NOT cacheable across requests. A branch that changes rate must take
// effect on the next order, and a cached rate would let a terminal with a stale
// rate agree with a stale server — both wrong in the same direction, which is the
// one case where re-validation cannot catch it.
type BranchRate struct{}

var _ orderuc.BranchRateSource = (*BranchRate)(nil)

// VATRateBp reads the branch's VAT rate in basis points.
//
// 700 = 7.00%. Basis points rather than a float percentage so the rate is exact
// integer arithmetic and 7 percent is `700`, not `6.999999999`.
func (r *BranchRate) VATRateBp(_ context.Context, _ identity.UUIDv7) (money.BasisPoints, error) {
	return 0, ErrNotImplemented
}

// ─────────────────────────────────────────────────────────────────────────────
// IdempotencyStore
// ─────────────────────────────────────────────────────────────────────────────

// IdempotencyStore is the Postgres implementation of usecase.IdempotencyStore.
//
// The table is `idempotency_keys` (DOMAIN.md: `key_hash` "Hash of client key +
// tenant", `expires_at` "24 h window", `response jsonb`).
//
// Two implementation requirements that are not optional:
//
//  1. `key_hash` is UNIQUE. Without the constraint two concurrent submissions both
//     miss the lookup and both insert, which is the exact duplicate the mechanism
//     exists to prevent — and a unique index is the only thing that closes the race
//     between "lookup" and "save". Application-level checking cannot.
//
//  2. `Lookup` filters on `expires_at > now()`. An expired row must behave as
//     absent, or the table grows without bound and a key reused years later would
//     be refused as a duplicate of a long-dead sale.
//
//     SELECT entity_id, state, response, created_at, expires_at
//     FROM idempotency_keys
//     WHERE key_hash = $1 AND expires_at > now()
type IdempotencyStore struct{}

var _ orderuc.IdempotencyStore = (*IdempotencyStore)(nil)

func (s *IdempotencyStore) Lookup(_ context.Context, _ sync.IdempotencyKey) (*sync.IdempotencyRecord, error) {
	return nil, ErrNotImplemented
}

// Save stores the record for one key.
//
//	INSERT INTO idempotency_keys (key_hash, entity_id, state, response, expires_at, created_at)
//	VALUES (...)
//	ON CONFLICT (key_hash) DO NOTHING
//
// `DO NOTHING` for the same reason the order append uses it: a Save racing a
// concurrent Save must not overwrite the first outcome. The first writer's response
// is the one every subsequent replay returns.
func (s *IdempotencyStore) Save(_ context.Context, _ sync.IdempotencyRecord) error {
	return ErrNotImplemented
}

// ─────────────────────────────────────────────────────────────────────────────
// OutboxLedger
// ─────────────────────────────────────────────────────────────────────────────

// OutboxLedger is the Postgres implementation of usecase.OutboxLedger.
//
// This is the SERVER-side ledger and its vocabulary is PENDING / IN_FLIGHT /
// ACKNOWLEDGED / CONFLICT_HELD — deliberately NOT the terminal's local
// `sync_outbox` values (pending / in_flight / done / failed_permanent). They are
// different aggregates: the local one asks "has my terminal handed this to the
// network", this one asks "has the server durably accepted it".
//
// One more property the column needs that DOMAIN.md's `OutboxItem` field list does
// not have: the four-state CHECK, so an invalid state cannot be stored.
//
//	CHECK (status IN ('PENDING','IN_FLIGHT','ACKNOWLEDGED','CONFLICT_HELD'))
//
// And the append-only guard, mirroring the terminal's `sync_outbox_append_only`
// trigger — "what happened cannot be rewritten, only delivered or retried". The id,
// the action, the entity and the `idempotency_key` are fixed on insert; only the
// state, the attempt count and the last error may change. A trigger rather than a
// CHECK, because a CHECK cannot see the OLD row.
type OutboxLedger struct{}

var _ orderuc.OutboxLedger = (*OutboxLedger)(nil)

func (l *OutboxLedger) Append(_ context.Context, _ sync.SyncOutboxItem) error {
	return ErrNotImplemented
}

// TransitionTo moves one item's state.
//
//	UPDATE sync_outbox_items
//	   SET status = $2, processed_at = CASE WHEN $2 IN ('ACKNOWLEDGED','CONFLICT_HELD')
//	                                     THEN $3 ELSE processed_at END
//	 WHERE id = $1 AND status = ANY ('{PENDING,IN_FLIGHT}')
//
// The `status = ANY (...)` guard is a compare-and-set: it makes the update
// conditional on the row still being in a non-terminal state, so a concurrent
// transition cannot overwrite an ACKNOWLEDGED row with an IN_FLIGHT one. Without
// it, two workers claiming the same item both succeed and the state machine's
// guarantee that a terminal state is final is enforced only by Go code that two
// processes do not share.
func (l *OutboxLedger) TransitionTo(_ context.Context, _ identity.UUIDv7, _ sync.OutboxState, _ time.Time) error {
	return ErrNotImplemented
}
