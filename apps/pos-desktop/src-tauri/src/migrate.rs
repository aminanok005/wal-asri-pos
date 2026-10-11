//! Forward-only schema migration, keyed on `PRAGMA user_version`.
//!
//! ── Why a hand-rolled runner ────────────────────────────────────────────────
//! The terminal used `tauri-plugin-sql`, which kept its own bookkeeping table,
//! `_sqlx_migrations`. That plugin is gone (SKILL.md §2.2 needs a real
//! transaction, which its JS API cannot express), so the bookkeeping went with
//! it — and `migrations/0001_init.sql:486-493` says so in as many words.
//!
//! `PRAGMA user_version` was always reserved for exactly this: the comment there
//! calls it "free for APP-LEVEL checks only". It is a single integer stored in
//! the database header, it is transactional, and it costs one `pragma_update`.
//! Two lines of bookkeeping for what the plugin spent a whole table on.
//!
//! ── Each migration runs inside one transaction ──────────────────────────────
//! An interrupted `CREATE INDEX` must not leave a table behind. So the whole file
//! is one transaction: it either applies completely or not at all. That is also
//! why `PRAGMA foreign_keys = ON` inside a migration file is a no-op — see
//! `src/db.rs` for where it actually has to be set.
//!
//! ── There are no down migrations, and there will not be ──────────────────────
//! A shipped terminal has already taken real money. "Un-applying" a migration
//! cannot restore the data it destroyed. Corrections are new files that
//! transform forward. This matches the policy at `0001_init.sql:11-20`.

use rusqlite::Connection;

/// Every migration, in ascending version order: `(version, description, sql)`.
///
/// Listed explicitly rather than globbed, so the order is visible in source and
/// a renamed file cannot silently reorder the schema. Embedded with
/// `include_str!`, so the bytes are compiled into the binary — a terminal in
/// airplane mode on a machine with no source tree can still create its database.
pub const MIGRATIONS: &[(i64, &str, &str)] = &[
    (
        1,
        "init — local_orders, local_order_lines, sync_outbox",
        include_str!("../migrations/0001_init.sql"),
    ),
    (
        2,
        "signed rounding — allow a negative rounding_adjustment_satang",
        include_str!("../migrations/0002_signed_rounding.sql"),
    ),
    (
        3,
        "stock balances — the terminal's local StockBalance cache, in milli-units",
        include_str!("../migrations/0003_stock_balances.sql"),
    ),
    (
        4,
        "local recipes — the terminal's local Recipe cache, in milli-units",
        include_str!("../migrations/0004_local_recipes.sql"),
    ),
];

/// The highest migration this build knows about. Used to refuse a database
/// written by a NEWER terminal, which is a downgrade the current code cannot
/// reason about.
pub const LATEST_VERSION: i64 = 4;

/// Read the schema version recorded in the database header.
pub fn current_version(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
}

/// Apply every migration this build has that the database does not.
///
/// Idempotent: a second call on an up-to-date database applies nothing and
/// returns the unchanged version.
pub fn migrate(conn: &mut Connection) -> Result<i64, MigrationError> {
    let mut version = current_version(conn)?;

    let latest = LATEST_VERSION;
    if version > latest {
        return Err(MigrationError::FromNewerBinary {
            found: version,
            supported: latest,
        });
    }

    for (target, description, sql) in MIGRATIONS {
        if *target <= version {
            continue;
        }

        // One transaction per file. `Transaction` rolls back when dropped without a
        // commit, so an error part-way through a `CREATE TABLE` leaves no trace.
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // Set the version INSIDE the transaction, so it rolls back with the schema
        // it describes. `user_version` lives in the database header and is
        // transactional, unlike `foreign_keys`.
        tx.pragma_update(None, "user_version", *target)?;
        tx.commit()?;

        log::info!("applied migration {target} ({description})");
        version = *target;
    }

    Ok(version)
}

/// Why a migration could not be brought up to date.
#[derive(Debug)]
pub enum MigrationError {
    /// The database was written by a terminal newer than this build.
    FromNewerBinary { found: i64, supported: i64 },
    /// SQLite refused something in a migration file.
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationError::FromNewerBinary { found, supported } => write!(
                f,
                "database schema is version {found}, but this build only knows up to {supported}; it was \
         written by a newer terminal. Refusing to run against it rather than corrupting it."
            ),
            MigrationError::Sqlite(e) => write!(f, "migration failed: {e}"),
        }
    }
}

impl std::error::Error for MigrationError {}

impl From<rusqlite::Error> for MigrationError {
    fn from(e: rusqlite::Error) -> Self {
        MigrationError::Sqlite(e)
    }
}

/// Apply migrations inside a transaction the caller already owns.
///
/// `Connection::transaction` is not re-entrant, so a migration run from inside
/// another transaction needs the inner work inlined rather than nested.
pub fn migrate_within(tx: &rusqlite::Transaction<'_>) -> Result<i64, MigrationError> {
    let mut version = tx.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;

    for (target, description, sql) in MIGRATIONS {
        if *target <= version {
            continue;
        }
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", *target)?;
        log::info!("applied migration {target} ({description})");
        version = *target;
    }

    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory() -> Connection {
        // Under `bundled-sqlcipher` a `:memory:` database needs no key.
        Connection::open_in_memory().expect("open in-memory database")
    }

    #[test]
    fn a_fresh_database_starts_at_version_zero() {
        assert_eq!(current_version(&in_memory()).unwrap(), 0);
    }

    #[test]
    fn migrating_an_empty_database_brings_it_to_the_latest_version() {
        let mut conn = in_memory();
        let version = migrate(&mut conn).expect("migrate a fresh database");

        assert_eq!(version, LATEST_VERSION);
        assert_eq!(current_version(&conn).unwrap(), LATEST_VERSION);
    }

    #[test]
    fn migrating_twice_applies_nothing_the_second_time() {
        let mut conn = in_memory();
        migrate(&mut conn).expect("first migration");

        // Idempotency is what makes a terminal safe to launch twice, or to recover
        // from a crash between opening the file and finishing startup.
        let second = migrate(&mut conn).expect("second migration");
        assert_eq!(second, LATEST_VERSION);
        assert_eq!(current_version(&conn).unwrap(), LATEST_VERSION);
    }

    #[test]
    fn migration_creates_every_table_the_offline_sell_path_needs() {
        let mut conn = in_memory();
        migrate(&mut conn).expect("migrate");

        for table in [
            "local_orders",
            "local_order_lines",
            "sync_outbox",
            // The offline stock cache. Without it a terminal cannot answer a stock
            // question with the network unplugged, which is the normal condition of a
            // branch with a bad router.
            "stock_balances",
            "local_recipes",
            "local_recipe_components",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap_or_else(|e| panic!("table {table} missing: {e}"));
            assert_eq!(found, 1, "expected table {table} to exist after migration");
        }
    }

    #[test]
    fn migration_creates_the_indexes_the_history_and_drain_queries_need() {
        let mut conn = in_memory();
        migrate(&mut conn).expect("migrate");

        for index in [
            "idx_local_orders_created_at",
            "idx_local_orders_status",
            "idx_local_orders_sync_state",
            "idx_local_order_lines_order_id",
            "idx_sync_outbox_drain",
            "idx_stock_balances_stale",
            "idx_local_recipes_variant",
            "idx_local_recipes_stale",
            "idx_local_recipe_components_recipe",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [index],
                    |row| row.get(0),
                )
                .unwrap_or_else(|e| panic!("index {index} missing: {e}"));
            assert_eq!(found, 1, "expected index {index} to exist after migration");
        }
    }

    #[test]
    fn a_database_from_a_newer_terminal_is_refused_rather_than_used() {
        let mut conn = in_memory();
        conn.pragma_update(None, "user_version", LATEST_VERSION + 1)
            .unwrap();

        // Running this build's migrations against a schema written by a future
        // terminal is how a checkout starts writing columns that do not exist.
        let error = migrate(&mut conn).expect_err("a newer schema must be refused");
        assert!(
            error.to_string().contains("newer terminal"),
            "expected a downgraded-schema message, got: {error}"
        );
    }
}
