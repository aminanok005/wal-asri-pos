// Package postgres is the order module's PostgreSQL persistence driver.
//
// ── IT IS NO LONGER A SKELETON ────────────────────────────────────────────────
//
// This file previously returned `ErrNotImplemented` from all six methods, because
// `sqlc` is HELD (SKILL.md §3.2/§3.4) and `db/migrations/` was empty. Both reasons
// are now resolved: the schema exists in `db/migrations/0001_orders.sql`, and the
// queries below are hand-written rather than generated.
//
// Hand-written is not a retreat from sqlc. sqlc generates from named queries in
// `db/queries/`, and this service's queries are hand-written until that directory
// exists; when sqlc is unheld these statements move there and this file keeps the
// mapping code. The important property is unchanged either way, and it is the one
// that matters: the SQL is close enough to the schema to be reviewed against it.
//
// ── WHAT THE SCHEMA ENFORCES, SO THIS FILE NEEDS TO ───────────────────────────
//
// The database re-derives every money invariant (see the migration's header). This
// driver does not re-implement those rules — a second Go implementation would be a
// fifth copy of the VAT formula, and the whole point of the CHECKs is that they are
// the copy nobody can forget. So this file's job is narrower and harder to get
// right than doing the maths would be:
//
//	WRITE THE SERVER'S FIGURES, NOT THE CLIENT'S.
//
// The usecase has already re-priced the order authoritatively and stored the result
// in `Totals`. Those are the values written here. If the client's claimed figures
// were written instead, the CHECKs would pass — they are internally consistent, just
// wrong for this branch's rate — and the tamper would become durable.
package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	identity "wal-asri-pos/services/api-backend/internal/identity/domain"
	money "wal-asri-pos/services/api-backend/internal/money/domain"
	order "wal-asri-pos/services/api-backend/internal/order/domain"
	orderuc "wal-asri-pos/services/api-backend/internal/order/usecase"
	sync "wal-asri-pos/services/api-backend/internal/sync/domain"
)

// ErrDuplicateOrder is returned when an order id is already present.
//
// A named error because the ingest path is documented as DEPENDING on this: a retry
// that arrives after the idempotency record was lost reaches Append a second time,
// and refusing is what stops it becoming a second order. The caller distinguishes it
// from a genuine failure by `errors.Is`.
var ErrDuplicateOrder = errors.New("postgres: the order already exists")

// ─────────────────────────────────────────────────────────────────────────────
// OrderRepository
// ─────────────────────────────────────────────────────────────────────────────

// OrderRepository persists orders.
type OrderRepository struct{ pool *pgxpool.Pool }

// NewOrderRepository wires the repository.
func NewOrderRepository(pool *pgxpool.Pool) *OrderRepository { return &OrderRepository{pool: pool} }

var _ orderuc.OrderRepository = (*OrderRepository)(nil)

// Append writes one order and its lines.
//
// ── ONE TRANSACTION, AND IT IS NOT A BATCHING CONVENIENCE ────────────────────
//
// The header and its lines go in together or not at all. An order with no lines is
// a receipt for an amount nobody can itemise, and it would pass every CHECK in the
// schema — the arithmetic constraints are all on the header's own columns — so
// nothing downstream would notice. The only thing standing between that and the
// ledger is this transaction.
//
// The order of writes also matters: the header first, because `order_lines.order_id`
// references it. Inserting lines first would fail on the foreign key.
//
// The `id` is the CLIENT-GENERATED UUIDv7 and is never replaced. A server-assigned
// id cannot be produced by an offline terminal, so checkout would block without a
// network — and it would leave every offline sale unaddressable until sync, which is
// exactly when a manager needs to find it.
//
// The duplicate refusal comes from the PRIMARY KEY, not from a prior SELECT. A
// read-then-write would race two concurrent retries of the same submission and let
// both through; the unique index is the only thing that closes that window.
func (r *OrderRepository) Append(ctx context.Context, o order.Order) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: beginning the order append: %w", err)
	}
	// Rollback after a successful Commit is a no-op, so this needs no success flag.
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	_, err = tx.Exec(ctx, `
		INSERT INTO orders (
			id, branch_id, terminal_id, staff_user_id, dining_table_id, customer_id,
			type, status, source,
			subtotal_satang, discount_satang, taxable_satang, tax_satang,
			service_charge_satang, rounding_adjustment_satang, total_satang,
			vat_rate_bp, notes, status_at, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9,
			$10, $11, $12, $13,
			$14, $15, $16,
			$17, $18, $19, $20, $21
		)`,
		o.ID, o.BranchID, o.TerminalID, o.StaffUserID, o.DiningTableID, o.CustomerID,
		string(o.Type), string(o.Status), string(o.Source),
		// THE SERVER'S FIGURES. See the package note: writing the client's claimed
		// numbers here would satisfy every CHECK and make a tamper durable.
		int64(o.Totals.SubtotalSatang),
		int64(o.Totals.DiscountSatang),
		int64(o.Totals.NetSatang()),
		int64(o.Totals.TaxSatang()),
		int64(o.Totals.ServiceChargeSatang),
		// The signed column. Passed as a plain int64 including a negative: the
		// schema deliberately has no >= 0 guard here.
		int64(o.Totals.RoundingAdjustmentSatang),
		int64(o.Totals.TotalSatang),
		int64(o.Totals.TaxSplit.RateBp),
		o.Notes, o.StatusAt, o.CreatedAt, o.UpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: order %s", ErrDuplicateOrder, o.ID)
		}
		return fmt.Errorf("postgres: inserting order %s: %w", o.ID, err)
	}

	for _, l := range o.Lines {
		_, err = tx.Exec(ctx, `
			INSERT INTO order_lines (
				id, order_id, product_variant_id, quantity,
				unit_price_satang, line_discount_satang, line_tax_satang,
				line_total_satang, sequence, notes, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			l.ID, l.OrderID, l.ProductVariantID,
			// NUMERIC(12,3) as a string: pgx would send a float64 for a Go float,
			// and the quantity is EXACT by contract (three fractional digits), so it
			// crosses the wire as the decimal string the money kernel produced.
			l.Quantity.String(),
			int64(l.UnitPriceSatang),
			int64(l.DiscountSatang),
			// line_tax_satang is a CONSTANT 0. See the schema: VAT is rounded once
			// per order, so a per-line figure would be a second, differently rounded
			// copy of money the total already contains.
			order.LineTaxIsAlwaysZero,
			int64(l.LineTotalSatang),
			l.Sequence, l.Notes, l.CreatedAt,
		)
		if err != nil {
			if isUniqueViolation(err) {
				return fmt.Errorf("%w: line %s", ErrDuplicateOrder, l.ID)
			}
			return fmt.Errorf("postgres: inserting line %s of order %s: %w", l.ID, o.ID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: order %s", ErrDuplicateOrder, o.ID)
		}
		return fmt.Errorf("postgres: committing order %s: %w", o.ID, err)
	}
	return nil
}

// Get returns one order with its lines.
//
// Read-only counterpart to Append, used by reconciliation and by the tests that need
// to prove what was actually stored rather than what was intended.
func (r *OrderRepository) Get(ctx context.Context, id identity.UUIDv7) (order.Order, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, branch_id, terminal_id, staff_user_id, dining_table_id, customer_id,
		       type, status, source,
		       subtotal_satang, discount_satang, taxable_satang, tax_satang,
		       service_charge_satang, rounding_adjustment_satang, total_satang,
		       vat_rate_bp, notes, status_at, created_at, updated_at
		  FROM orders
		 WHERE id = $1`, id)

	o, err := scanOrder(row)
	if err != nil {
		return order.Order{}, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT id, order_id, product_variant_id, quantity,
		       unit_price_satang, line_discount_satang, line_tax_satang,
		       line_total_satang, sequence, notes, created_at
		  FROM order_lines
		 WHERE order_id = $1
		 ORDER BY sequence, created_at`, id)
	if err != nil {
		return order.Order{}, fmt.Errorf("postgres: reading the lines of order %s: %w", id, err)
	}
	defer rows.Close()

	for rows.Next() {
		l, err := scanLine(rows)
		if err != nil {
			return order.Order{}, err
		}
		o.Lines = append(o.Lines, l)
	}
	return o, rows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// BranchRateSource
// ─────────────────────────────────────────────────────────────────────────────

// BranchRate reads the branch's VAT rate.
type BranchRate struct{ pool *pgxpool.Pool }

// NewBranchRate wires the rate source.
func NewBranchRate(pool *pgxpool.Pool) *BranchRate { return &BranchRate{pool: pool} }

var _ orderuc.BranchRateSource = (*BranchRate)(nil)

// VATRateBp reads the branch's rate in basis points.
//
// NOT cached across requests, and the reason is specific rather than general
// caution: the server re-prices every incoming order at the branch's CURRENT rate,
// and that comparison against the terminal's rate is the entire stale-terminal
// detection. A cached rate would let a terminal and a server that both believe in a
// superseded rate agree with each other — the one case where re-validation cannot
// catch anything, because both sides are wrong in the same direction.
//
// An UNRATED branch is an error, not a default. Falling back to the 7% standard
// would let a misconfigured deployment produce confidently wrong tax for every
// branch nobody rated.
func (b *BranchRate) VATRateBp(ctx context.Context, branchID identity.UUIDv7) (money.BasisPoints, error) {
	var bp int64
	err := b.pool.QueryRow(ctx, `SELECT vat_rate_bp FROM branches WHERE id = $1`, branchID).Scan(&bp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf(
				"postgres: branch %s does not exist, so its orders cannot be priced; a branch must be "+
					"rated before it can take a sale", branchID)
		}
		return 0, fmt.Errorf("postgres: reading the VAT rate of branch %s: %w", branchID, err)
	}
	return money.BasisPoints(bp), nil
}

// EnsureBranch inserts a branch if absent, at the given rate.
//
// Idempotent and used by wiring and tests. NOT used on the ingest path: an order's
// branch must already exist, because a sale arriving for an unknown branch is a
// misconfiguration worth surfacing rather than papering over with a default rate.
func EnsureBranch(ctx context.Context, pool *pgxpool.Pool, id identity.UUIDv7, name string, bp money.BasisPoints) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO branches (id, name, vat_rate_bp)
		VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET vat_rate_bp = EXCLUDED.vat_rate_bp, name = EXCLUDED.name`,
		id, name, int64(bp))
	if err != nil {
		return fmt.Errorf("postgres: ensuring branch %s: %w", id, err)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// IdempotencyStore
// ─────────────────────────────────────────────────────────────────────────────

// IdempotencyStore persists submission outcomes.
type IdempotencyStore struct{ pool *pgxpool.Pool }

// NewIdempotencyStore wires the store.
func NewIdempotencyStore(pool *pgxpool.Pool) *IdempotencyStore {
	return &IdempotencyStore{pool: pool}
}

var (
	_ orderuc.IdempotencyStore = (*IdempotencyStore)(nil)
	_ syncBatchIdempotency     = (*IdempotencyStore)(nil)
)

// syncBatchIdempotency is the sync module's port, restated here.
//
// Declared locally rather than imported so this adapter file has no dependency on
// either application layer's package name; both ports are satisfied because their
// method sets are identical.
type syncBatchIdempotency interface {
	Lookup(ctx context.Context, key sync.IdempotencyKey) (*sync.IdempotencyRecord, error)
	Save(ctx context.Context, rec sync.IdempotencyRecord) error
}

// Lookup returns the record stored under key, or nil when there is none.
//
// The `expires_at > now()` predicate is in the QUERY, not in Go. Doing it in Go
// would mean fetching rows that must then be discarded, and — the reason that
// matters — an expired row would still occupy the primary key, so a reused key
// would collide on INSERT instead of being treated as absent.
func (s *IdempotencyStore) Lookup(ctx context.Context, key sync.IdempotencyKey) (*sync.IdempotencyRecord, error) {
	if !key.IsWellFormed() {
		// A key that cannot match a derived digest would report "no duplicate
		// found" forever, which silently defeats the whole mechanism. Better to
		// refuse loudly at the boundary.
		return nil, fmt.Errorf("postgres: %q is not a well-formed idempotency key", key)
	}

	var (
		entityID  identity.UUIDv7
		state     sync.OutboxState
		response  string
		createdAt time.Time
		expiresAt time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT entity_id, state, response, created_at, expires_at
		  FROM idempotency_keys
		 WHERE key_hash = $1 AND expires_at > now()`, key).
		Scan(&entityID, &state, &response, &createdAt, &expiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("postgres: looking up idempotency key %s: %w", key, err)
	}

	return &sync.IdempotencyRecord{
		Key:       key,
		EntityID:  entityID,
		State:     state,
		Response:  response,
		CreatedAt: createdAt.UTC(),
		ExpiresAt: expiresAt.UTC(),
	}, nil
}

// Save stores the record for one key.
//
// `ON CONFLICT (key_hash) DO NOTHING`, and the caller must check the command tag to
// learn whether it won.
//
// The alternative — read, then write — has a race that this table exists to prevent:
// two concurrent retries of the same submission both miss the lookup and both insert,
// and the second overwrites the response every later replay depends on. The unique
// index is the only thing that closes that window.
func (s *IdempotencyStore) Save(ctx context.Context, rec sync.IdempotencyRecord) error {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO idempotency_keys (key_hash, entity_id, entity_type, state, response, created_at, expires_at)
		VALUES ($1, $2, 'order', $3, $4, $5, $6)
		ON CONFLICT (key_hash) DO NOTHING`,
		rec.Key.String(), rec.EntityID, rec.State, rec.Response, rec.CreatedAt, rec.ExpiresAt)
	if err != nil {
		return fmt.Errorf("postgres: saving idempotency key %s: %w", rec.Key, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf(
			"postgres: a live idempotency record already exists for key %s; the FIRST writer's response "+
				"is the one every later replay returns, so this one was discarded", rec.Key)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// OutboxLedger
// ─────────────────────────────────────────────────────────────────────────────

// OutboxLedger is the server-side ledger.
//
// Its vocabulary is PENDING / IN_FLIGHT / ACKNOWLEDGED / CONFLICT_HELD —
// deliberately NOT the terminal's local sync_outbox values. See the migration's
// header on why they are two different aggregates.
type OutboxLedger struct{ pool *pgxpool.Pool }

// NewOutboxLedger wires the ledger.
func NewOutboxLedger(pool *pgxpool.Pool) *OutboxLedger { return &OutboxLedger{pool: pool} }

var _ orderuc.OutboxLedger = (*OutboxLedger)(nil)

// Append records a newly accepted item.
func (l *OutboxLedger) Append(ctx context.Context, item sync.SyncOutboxItem) error {
	var keyHash *string
	if !item.IdempotencyKey.IsZero() {
		k := item.IdempotencyKey.String()
		keyHash = &k
	}

	_, err := l.pool.Exec(ctx, `
		INSERT INTO sync_outbox_items (
			id, entity_id, entity_type, action, terminal_id,
			idempotency_key_hash, state, attempt_count, last_error,
			created_at, due_at, processed_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		ON CONFLICT (id) DO NOTHING`,
		item.ID, item.EntityID, item.EntityType, string(item.Action), item.TerminalID,
		keyHash, string(item.State), item.AttemptCount, item.LastError,
		item.CreatedAt.UTC(), item.DueAt.UTC(), item.ProcessedAt,
	)
	if err != nil {
		return fmt.Errorf("postgres: recording outbox item %s: %w", item.ID, err)
	}
	return nil
}

// TransitionTo moves one item's state.
//
// The `state IN ('PENDING','IN_FLIGHT')` guard is a COMPARE-AND-SET: it makes the
// update conditional on the row still being non-terminal, so two workers claiming
// the same item cannot both succeed and a terminal state cannot be overwritten.
//
// RowsAffected() == 0 is therefore a MEANINGFUL answer, not a failure: it says the
// row was already terminal, which is the expected outcome when a retried delivery
// arrives after the original was acknowledged. Reporting that as an error would make
// the retry loop forever against a queue it has already drained — the exact failure
// the idempotency store exists to prevent, reintroduced one layer up.
func (l *OutboxLedger) TransitionTo(ctx context.Context, id identity.UUIDv7, to sync.OutboxState, at time.Time) error {
	if !sync.IsKnownState(to) {
		return fmt.Errorf("postgres: %q is not one of the four lifecycle states", to)
	}

	tag, err := l.pool.Exec(ctx, `
		UPDATE sync_outbox_items
		   SET state = $2,
		       processed_at = CASE WHEN $2 IN ('ACKNOWLEDGED', 'CONFLICT_HELD') THEN $3 ELSE processed_at END
		 WHERE id = $1 AND state IN ('PENDING', 'IN_FLIGHT')`,
		id, string(to), at.UTC())
	if err != nil {
		return fmt.Errorf("postgres: moving outbox item %s to %s: %w", id, to, err)
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	return nil
}

// isUniqueViolation reports whether err is a Postgres unique-constraint failure.
//
// Checked via the SQLSTATE rather than by matching the message text: the message is
// localised and has changed between major versions, so matching it works until it
// does not, and then it fails on a DUPLICATE ORDER — the one error in this package
// whose whole purpose is to be recognised.
func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23505"
	}
	return false
}
