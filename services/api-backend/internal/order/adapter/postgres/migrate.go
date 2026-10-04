package postgres

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	migrations "wal-asri-pos/services/api-backend/db/migrations"
)

// ─────────────────────────────────────────────────────────────────────────────
// The migration runner
// ─────────────────────────────────────────────────────────────────────────────

// schemaMigrations is the applied-version ledger.
//
// Not goose's table and not `db/migrations`' own: this service owns its schema, so
// it owns the record of what it has applied. A table that a future goose adoption
// would have to migrate away from is a migration in itself.
//
// `version` is the numeric prefix of the filename, so `0002_x.sql` is version 2.
// The filename is kept alongside it because a version number alone cannot explain
// what a row did, and a schema table that cannot explain itself is a schema table
// nobody trusts in an incident.
const schemaMigrationsDDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER     PRIMARY KEY,
  filename    TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`

// migrationLockKey is an arbitrary but FIXED key for the Postgres advisory lock that
// serialises migrations across instances.
//
// Advisory rather than a table lock because two versions of this binary starting at
// once must not both try to CREATE TABLE branches — one would fail on a duplicate
// object and take the deploy with it. A fixed key means they queue instead.
//
// pg_advisory_lock is session-scoped, so it is taken on a single acquired
// connection and released by closing it. A transaction-scoped variant would release
// at COMMIT, which is too early: the point is to hold the lock across the whole
// migration run, not each statement.
const migrationLockKey int64 = 0x77616c62_0001 // "walb" + 1, arbitrary and stable

// Migrate applies every embedded migration that has not been applied yet.
//
// Each file runs in its OWN transaction together with the INSERT that records it.
// That pairing is the guarantee: a migration either applied and is recorded, or
// neither happened. A single transaction around the whole run would be simpler and
// wrong — Postgres has transactional DDL, so one bad statement anywhere would roll
// back migrations that had already succeeded on a live database, leaving the ledger
// claiming versions the schema does not have.
//
// Idempotent: running it against an up-to-date database applies nothing.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("postgres: acquiring a connection to migrate: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
		return fmt.Errorf("postgres: taking the migration advisory lock: %w", err)
	}
	// Explicitly unlocked rather than left to the session ending, so the behaviour
	// does not depend on pool internals.
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrationLockKey)
	}()

	if _, err := conn.Exec(ctx, schemaMigrationsDDL); err != nil {
		return fmt.Errorf("postgres: creating schema_migrations: %w", err)
	}

	applied, err := appliedVersions(ctx, conn.Conn())
	if err != nil {
		return err
	}

	// ── THE LEDGER AND THE SCHEMA MUST AGREE ─────────────────────────────────
	//
	// If a table this migration creates already exists while the ledger has no row
	// for it, then the schema was put in place by something other than this runner:
	// psql by hand, an older tool, a restored backup.
	//
	// Left alone, the symptom is `trigger "orders_money_immutable" already exists`
	// (SQLSTATE 42710) partway through the file, which names a trigger nobody
	// mentioned and says nothing about the actual cause. A DBA who ran the .sql
	// directly — entirely reasonably, it is a plain .sql file — would have no way to
	// get from that message to "the ledger does not know about your schema".
	//
	// Every migration runs in its own transaction, so this state cannot be produced
	// by Migrate itself failing halfway. It can only come from outside, which is why
	// it is worth detecting rather than tolerating.
	if err := assertLedgerMatchesSchema(ctx, conn.Conn(), applied); err != nil {
		return err
	}

	pending, err := pendingMigrations(applied)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		return nil
	}

	for _, m := range pending {
		if err := applyOne(ctx, conn.Conn(), m); err != nil {
			return err
		}
	}
	return nil
}

// appliedVersions reads the ledger.
func appliedVersions(ctx context.Context, conn *pgx.Conn) (map[int]string, error) {
	rows, err := conn.Query(ctx, `SELECT version, filename FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("postgres: reading schema_migrations: %w", err)
	}
	defer rows.Close()

	out := make(map[int]string)
	for rows.Next() {
		var v int
		var name string
		if err := rows.Scan(&v, &name); err != nil {
			return nil, fmt.Errorf("postgres: scanning schema_migrations: %w", err)
		}
		out[v] = name
	}
	return out, rows.Err()
}

// sentinelTables are the tables a migration is expected to create.
//
// Only the FIRST migration's tables are listed, because that is where the diagnosis
// matters: if `orders` exists and nothing is recorded, someone installed a schema
// out of band. Checking every later migration's tables as well would be more
// thorough and would multiply the queries for no extra diagnostic value.
var sentinelTables = []string{"orders", "order_lines", "idempotency_keys", "sync_outbox_items"}

// assertLedgerMatchesSchema fails when the schema is present but unrecorded.
//
// The remedy is stated in the error because "your database is in a state this tool
// did not create" is not actionable on its own. Dropping the objects is safe here
// ONLY because nothing but this service writes them and the append-only triggers
// mean an order already in there is real — so the message says to check for real
// data first rather than telling someone to DROP TABLE on a database that might
// hold a shift's sales.
func assertLedgerMatchesSchema(ctx context.Context, conn *pgx.Conn, applied map[int]string) error {
	if len(applied) > 0 {
		return nil
	}

	var existing []string
	for _, table := range sentinelTables {
		var present bool
		err := conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables
			                 WHERE table_schema = current_schema() AND table_name = $1)`,
			table).Scan(&present)
		if err != nil {
			return fmt.Errorf("postgres: checking whether %s exists: %w", table, err)
		}
		if present {
			existing = append(existing, table)
		}
	}
	if len(existing) == 0 {
		return nil
	}

	return fmt.Errorf(
		"postgres: the schema is already installed (%s) but schema_migrations is EMPTY, so this "+
			"runner believes it has never run. The schema was created outside this tool — most likely "+
			"by applying db/migrations/*.sql with psql, or from a restored backup.\n"+
			"This is refused rather than worked around: 'trigger already exists' halfway through a "+
			"migration names a trigger nobody mentioned and hides the real cause.\n"+
			"Resolve it by checking whether the existing tables hold real orders first (they are "+
			"append-only, so anything there was a sale that happened). If they hold nothing, drop them "+
			"and let this runner recreate them from scratch; if they hold real data, record the applied "+
			"version by hand instead of dropping anything.",
		strings.Join(existing, ", "))
}

// migration is one embedded .sql file.
type migration struct {
	version  int
	filename string
	body     string
}

// pendingMigrations returns the migrations not yet applied, in apply order.
//
// The lexical filename sort is the apply order, and it is also the VALIDATION: a
// file whose name does not start with a number is rejected rather than sorted to a
// position. A migration tool that silently applies files in an order nobody chose
// is how a schema ends up with a column that references a table that does not exist
// yet.
func pendingMigrations(applied map[int]string) ([]migration, error) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return nil, fmt.Errorf("postgres: reading the embedded migrations: %w", err)
	}

	var all []migration
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(e.Name(), "_")
		if !ok {
			return nil, fmt.Errorf(
				"postgres: migration %q does not start with a version prefix like 0001_; "+
					"the filename order IS the apply order, so an unversioned file has no defined position",
				e.Name())
		}
		v, err := strconv.Atoi(prefix)
		if err != nil {
			return nil, fmt.Errorf("postgres: migration %q has a non-numeric version prefix %q", e.Name(), prefix)
		}
		body, err := migrations.FS.ReadFile(e.Name())
		if err != nil {
			return nil, fmt.Errorf("postgres: reading migration %q: %w", e.Name(), err)
		}
		all = append(all, migration{version: v, filename: e.Name(), body: string(body)})
	}

	sort.Slice(all, func(i, j int) bool { return all[i].filename < all[j].filename })

	var pending []migration
	for _, m := range all {
		if _, done := applied[m.version]; done {
			continue
		}
		pending = append(pending, m)
	}
	return pending, nil
}

// applyOne runs one migration and records it, in one transaction.
func applyOne(ctx context.Context, conn *pgx.Conn, m migration) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: beginning %s: %w", m.filename, err)
	}
	// Rollback on the error path only. A committed migration must not be undone by
	// a deferred rollback that has nothing to roll back.
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	if _, err := tx.Exec(ctx, m.body); err != nil {
		return fmt.Errorf("postgres: applying %s: %w", m.filename, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)`, m.version, m.filename); err != nil {
		return fmt.Errorf("postgres: recording %s: %w", m.filename, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: committing %s: %w", m.filename, err)
	}
	return nil
}
