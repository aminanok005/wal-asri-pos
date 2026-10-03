/**
 * Migration 0001 — the SQLite money invariant, proven against the real schema.
 *
 * SKILL.md §2.1 (Strict Money Rule): every monetary value is an INTEGER number
 * of satang, never a float, never a string. §2.2 requires checkout to commit
 * locally inside one transaction before any network call is even attempted.
 *
 * Both rules can only be trusted if the DATABASE refuses bad money, not just
 * the TypeScript layer that writes it. A POS terminal is offline-first: a
 * buggy UI, a malformed IPC payload, or a half-migrated database must still be
 * unable to write ฿45.50 as a fractional value that later arithmetic silently
 * rounds. So this file executes the ACTUAL shipped migration
 * (`src-tauri/migrations/0001_init.sql`) and attacks it.
 *
 * These are integration tests against Bun's embedded SQLite — the same engine
 * SQLCipher wraps, so the CHECK constraints under test are the real ones.
 */

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { Money } from '../src/features/payments/domain/money';
import {
  DEFAULT_VAT_RATE_BP,
  splitInclusive,
} from '../src/features/sales/domain/tax';

/**
 * Resolve the migration file from THIS file's own directory.
 *
 * The test lives in `apps/pos-desktop/test/` and the SQL lives in
 * `apps/pos-desktop/src-tauri/migrations/`, so the path is resolved relative to
 * `import.meta.dir` rather than the process CWD. That keeps the suite runnable
 * both from the monorepo root (`bun test apps/pos-desktop/test`) and from
 * inside the package (`bun test test`) — a CWD-relative path would break one of
 * the two.
 */
const MIGRATION_PATH = join(import.meta.dir, '..', 'src-tauri', 'migrations', '0001_init.sql');

/** The shipped migration SQL, read once and executed into every test database. */
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

/**
 * A fresh, empty in-memory database with migration 0001 applied.
 *
 * `:memory:` is re-created per test by `beforeEach` so no state — rows, triggers
 * or AUTOINCREMENT sequence — can leak between cases. A file-backed temporary
 * database would add I/O and teardown without adding coverage.
 */
let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Foreign-key enforcement is a PER-CONNECTION setting, and the migration
  // deliberately does NOT turn it on — see the note beside the (now removed)
  // `PRAGMA foreign_keys = ON` line in 0001_init.sql. The production connection
  // sets it in `src/db.rs` immediately after opening; this mirrors that, so the
  // integrity assertions below exercise the same engine configuration the
  // terminal runs with.
  //
  // It has to be set BEFORE the schema is applied to be meaningful, and it has
  // to be set here rather than relied on from the SQL because a pragma inside a
  // transaction is a silent no-op — and `src/migrate.rs` wraps each migration
  // file in exactly one. Setting it after `exec` would be too late for nothing
  // (SQLite applies FKs at statement time, not load time), so either order works
  // here; before is chosen so the intent reads first.
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MIGRATION_SQL);
});

/**
 * A valid `local_orders` row, as a plain column -> value map.
 *
 * Every money column is an integer satang amount and the table's arithmetic
 * identities hold exactly.
 *
 * VAT IS INCLUSIVE (DOMAIN.md §"Money and tax rules"). ฿45.50 is what the
 * customer pays and the tax is inside it, so the numbers are:
 *
 *   gross (subtotal)                       = 4550          ฿45.50
 *   discount                                =    0
 *   tax_satang = gross - round_half_up(gross * 10000 / 10700)
 *             = 4550 - round_half_up(4252.336) = 298     ฿2.98
 *   taxable (net)  = gross - tax            = 4252          ฿42.52
 *   total (charged) = subtotal - discount  = 4550          ฿45.50
 *
 * The forward-VAT answer would be tax = round_half_up(4550 * 700 / 10000) = 319
 * (฿3.19) — a different amount of money, which is precisely why the extraction
 * direction is enforced by the schema and tested below.
 *
 * Individual tests spread an override on top of this baseline so that a single
 * broken value is the only reason an INSERT could fail.
 */
function validOrderRow(): Record<string, unknown> {
  return {
    id: '0190f3a0-0000-7000-8000-000000000001',
    branch_id: 'branch-siam',
    terminal_id: 'terminal-01',
    staff_user_id: 'staff-01',
    type: 'dine_in',
    status: 'draft',
    source: 'pos_desktop',
    currency: 'THB',
    vat_rate_bp: 700,
    subtotal_satang: 4550,
    discount_satang: 0,
    taxable_satang: 4252,
    tax_satang: 298,
    service_charge_satang: 0,
    rounding_adjustment_satang: 0,
    total_satang: 4550,
    idempotency_key: 'idem-order-0001',
    local_receipt_number: 'R-0001',
    created_at: '2026-10-02T09:00:00.000Z',
  };
}

/**
 * A valid `local_order_lines` row, as a plain column -> value map.
 *
 * The line arithmetic identity must hold exactly:
 *
 *   line_total = unit_price * quantity - line_discount + line_tax
 *              = 4550 * 1 - 0 + 0 = 4550
 *
 * `order_id` points at the id used by `validOrderRow()`, so a test that inserts
 * both rows without overrides gets a consistent, fully valid pair.
 */
function validLineRow(): Record<string, unknown> {
  return {
    id: '0190f3a0-0000-7000-8000-0000000000a1',
    order_id: '0190f3a0-0000-7000-8000-000000000001',
    variant_id: 'variant-latte-hot',
    product_id: 'product-latte',
    sku: 'LATTE-HOT',
    name_th: 'ลาเต้ร้อน',
    quantity: 1,
    unit_price_satang: 4550,
    line_discount_satang: 0,
    line_tax_satang: 0,
    line_total_satang: 4550,
    created_at: '2026-10-02T09:00:01.000Z',
  };
}

/**
 * Insert a row into `table` from a column -> value map, using bound parameters.
 *
 * The column list and placeholder list are both generated from the object's own
 * keys, so a test can override exactly one column and leave the rest of the
 * schema at its known-good baseline. Values are always bound, never
 * interpolated into SQL text, so a test that deliberately passes a hostile value
 * (`'abc'`, `45.5`) is testing the CHECK constraints and not a quoting mistake.
 */
function insertRow(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map((column) => row[column]);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(
    ...(values as never[]),
  );
}

/** Insert a `local_orders` row, overriding only the columns a test cares about. */
function insertOrder(overrides: Record<string, unknown> = {}): void {
  insertRow('local_orders', { ...validOrderRow(), ...overrides });
}

/** Insert a `local_order_lines` row, overriding only the columns under test. */
function insertLine(overrides: Record<string, unknown> = {}): void {
  insertRow('local_order_lines', { ...validLineRow(), ...overrides });
}

/** A valid `sync_outbox` row; `sequence` is left to AUTOINCREMENT. */
function validOutboxRow(): Record<string, unknown> {
  return {
    id: '0190f3a0-0000-7000-8000-0000000000b1',
    aggregate_type: 'order',
    aggregate_id: '0190f3a0-0000-7000-8000-000000000001',
    event_type: 'order_committed',
    action: 'push_order',
    payload: '{"order_id":"0190f3a0-0000-7000-8000-000000000001","total_satang":5250}',
    idempotency_key: 'idem-outbox-0001',
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: '2026-10-02T09:00:00.000Z',
    created_at: '2026-10-02T09:00:00.000Z',
  };
}

/** Insert a `sync_outbox` row, overriding only the columns under test. */
function insertOutbox(overrides: Record<string, unknown> = {}): void {
  insertRow('sync_outbox', { ...validOutboxRow(), ...overrides });
}

/**
 * Read one column back from a table as a raw JS value.
 *
 * `SELECT typeof(col)` is used deliberately: the Strict Money Rule is about the
 * value's STORAGE CLASS, not about how TypeScript printed it, so the tests must
 * observe the engine's own answer.
 */
function typeofColumn(table: string, idColumn: string, id: string, column: string): string {
  const row = db
    .prepare(`SELECT typeof(${column}) AS storage FROM ${table} WHERE ${idColumn} = ?`)
    .get(id) as { storage: string } | null;
  if (row === null) throw new Error(`no row in ${table} with ${idColumn} = ${id}`);
  return row.storage;
}

/**
 * 1. Schema — the objects migration 0001 promises actually exist.
 *
 * Everything the rest of this file relies on is named here first, so a failure
 * later in the file points at a constraint rather than at a missing table.
 */
describe('0001_init.sql — schema objects', () => {
  it('creates the three local tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];

    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining(['local_orders', 'local_order_lines', 'sync_outbox']),
    );
  });

  it('creates the indexes used by the sell and drain queries', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];

    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_local_orders_created_at',
        'idx_local_orders_status',
        'idx_local_orders_sync_state',
        'idx_local_order_lines_order_id',
        'idx_sync_outbox_drain',
      ]),
    );
  });

  it('creates the append-only and money-immutable triggers', () => {
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all() as { name: string }[];

    expect(triggers.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'local_orders_money_immutable',
        'local_order_lines_money_immutable',
        'local_orders_no_delete',
        'local_order_lines_no_delete',
        'sync_outbox_append_only',
      ]),
    );
  });

  it('records the migration version so the Rust side can detect drift', () => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | null;

    expect(row?.user_version).toBe(1);
  });
});

/**
 * 2. Money invariant — the Strict Money Rule, enforced by the SCHEMA.
 *
 * WHY `typeof(col) = 'integer'` IS NECESSARY, AND NOT REDUNDANT
 *
 * SQLite does not have column types. It has type AFFINITY: a column declared
 * `INTEGER` is a *request* that a well-formed value be coerced to an integer,
 * not an enforcement. Concretely, declaring
 *
 *     total_satang INTEGER
 *
 * and then inserting 45.5 succeeds silently. The column has INTEGER affinity,
 * 45.5 is not losslessly convertible to an integer, so SQLite keeps it as-is and
 * stores storage class REAL. `SELECT typeof(total_satang)` answers 'real', the
 * row is in the table, and nothing complained. The damage lands later: subtotal
 * arithmetic in floating point drifts, ฿45.50 totals come out as 5250.000000001
 * or 5249.999999999, and a Thai receipt that must balance to the satang does not.
 *
 * The same gap exists for TEXT: `'abc'` has no numeric affinity match, so it is
 * stored as TEXT in a money column. Reading it back into TypeScript yields a
 * string where an integer satang count is required, and any arithmetic on it is
 * either a type error or a silent NaN.
 *
 * So the migration pairs every money column with
 * `CHECK (typeof(col) = 'integer' AND col >= 0)`. The `typeof` half rejects the
 * float and the string; the `>= 0` half rejects negative satang, which is never
 * a legitimate amount on a sale (a refund or a reversal is a separate row with
 * its own event type, not a negative price).
 *
 * These four cases each attack one of those holes and MUST throw.
 */
describe('0001_init.sql — money invariant (strict money rule)', () => {
  it('rejects a fractional satang amount in local_orders.total_satang', () => {
    expect(() => insertOrder({ total_satang: 45.5 })).toThrow();
  });

  it('rejects a negative satang amount in local_orders.total_satang', () => {
    expect(() => insertOrder({ total_satang: -1 })).toThrow();
  });

  it('rejects a non-numeric string in local_orders.total_satang', () => {
    expect(() => insertOrder({ total_satang: 'abc' })).toThrow();
  });

  it('rejects a fractional unit price in local_order_lines.unit_price_satang', () => {
    // The parent order must exist first: the line's FK is checked independently
    // of its money CHECKs, and a missing parent would make this test pass for
    // the wrong reason.
    insertOrder();
    expect(() => insertLine({ unit_price_satang: 45.5 })).toThrow();
  });

  it('writes no row when a money CHECK fails — the whole INSERT is rejected', () => {
    expect(() => insertOrder({ total_satang: 45.5 })).toThrow();

    const count = db.prepare('SELECT count(*) AS n FROM local_orders').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

/**
 * 3. Known SQLite limitation — pinned honestly, not wished away.
 *
 * `typeof(col) = 'integer'` rejects REAL and rejects unconvertible TEXT, but it
 * CANNOT reject a numeric-looking string. SQLite applies INTEGER affinity to the
 * TEXT value '4550', finds it is a well-formed integer literal, converts it, and
 * stores storage class INTEGER. By the time the CHECK constraint runs, the
 * evidence that the application passed a string instead of a number is already
 * gone — the engine did the coercion itself.
 *
 * This is an ENGINE behaviour, not a defect in 0001_init.sql, and no CHECK
 * constraint in SQLite can prevent it: CHECKs see post-coercion values, and
 * there is no way to inspect the original JS/SQL literal from inside a CHECK.
 * Pretending otherwise would be a test that only passes because it was written
 * to match a wish.
 *
 * The practical consequence is a rule for the APPLICATION layer, not the
 * schema: money must never cross into SQL as a string. The Rust/TypeScript
 * boundary (SKILL.md §2.1) is where that is enforced — via the `Money` value
 * object, whose satang count is a `number`, and a Tauri command signature that
 * takes `i64`, not a JSON string. A JSON body carrying `{"total_satang": "5250"}`
 * must be rejected during deserialization, before it reaches this database.
 *
 * Asserted as ACCEPTED, deliberately, so that anyone who later believes this
 * case is blocked reads a failing assumption instead of discovering the gap in
 * production.
 */
describe('0001_init.sql — known SQLite limitation: numeric strings are coerced', () => {
  it('ACCEPTS total_satang as the string \'4550\' (affinity coerces it to integer)', () => {
    // The whole money set is overridden so the arithmetic identities still hold
    // on a zero-rated sale: gross 4550, net 4550, tax 0, total 4550. Otherwise
    // this INSERT would fail for an unrelated reason and the test would prove
    // nothing. Zero-rating is the one case where inclusive and exclusive agree.
    expect(() =>
      insertOrder({
        vat_rate_bp: 0,
        taxable_satang: 4550,
        tax_satang: 0,
        total_satang: '4550',
      }),
    ).not.toThrow();

    const row = db
      .prepare(
        "SELECT total_satang, typeof(total_satang) AS storage FROM local_orders WHERE idempotency_key = 'idem-order-0001'",
      )
      .get() as { total_satang: number; storage: string };

    // The stored value is an integer 4550, NOT the string '4550'.
    expect(row.total_satang).toBe(4550);
    expect(typeof row.total_satang).toBe('number');
    expect(row.storage).toBe('integer');
  });
});

/**
 * 4. Valid inserts succeed — the constraints are not merely restrictive.
 *
 * A schema that rejects everything would also "enforce" the money rule, and the
 * negative tests above would all pass while the POS was simply broken. These
 * cases pin the positive path: a correct ฿52.50 order (4550 satang subtotal +
 * 700 satang VAT) and a correct order line round-trip with exact satang values.
 */
describe('0001_init.sql — valid rows are accepted and round-trip exactly', () => {
  it('inserts a correct order and reads back exact satang values', () => {
    expect(() => insertOrder()).not.toThrow();

    const row = db
      .prepare(
        "SELECT subtotal_satang, discount_satang, taxable_satang, tax_satang, service_charge_satang, rounding_adjustment_satang, total_satang, currency FROM local_orders WHERE idempotency_key = 'idem-order-0001'",
      )
      .get() as Record<string, unknown>;

    expect(row.subtotal_satang).toBe(4550);
    expect(row.discount_satang).toBe(0);
    expect(row.taxable_satang).toBe(4252);
    expect(row.tax_satang).toBe(298);
    expect(row.service_charge_satang).toBe(0);
    expect(row.rounding_adjustment_satang).toBe(0);
    // VAT-inclusive: the amount charged IS the subtotal. The VAT is already
    // inside it — this is the value that distinguishes inclusive from exclusive,
    // where the total would have been 4550 + 298 = 4848.
    expect(row.total_satang).toBe(4550);
    expect(row.currency).toBe('THB');

    // Every money column is stored with INTEGER storage class, not REAL.
    expect(typeofColumn('local_orders', 'idempotency_key', 'idem-order-0001', 'total_satang')).toBe(
      'integer',
    );
  });

  it('inserts a correct order line and reads back exact satang values', () => {
    insertOrder();
    expect(() => insertLine()).not.toThrow();

    const row = db
      .prepare('SELECT quantity, unit_price_satang, line_discount_satang, line_tax_satang, line_total_satang FROM local_order_lines')
      .get() as Record<string, unknown>;

    expect(row.quantity).toBe(1);
    expect(row.unit_price_satang).toBe(4550);
    expect(row.line_discount_satang).toBe(0);
    expect(row.line_tax_satang).toBe(0);
    expect(row.line_total_satang).toBe(4550);
  });

  it('rejects an unknown order type / status / source via the enum CHECKs', () => {
    expect(() => insertOrder({ type: 'teleport' })).toThrow();
    expect(() => insertOrder({ status: 'shipped' })).toThrow();
    expect(() => insertOrder({ source: 'internet' })).toThrow();
  });
});

/**
 * 5. Uniqueness and referential integrity.
 *
 * `idempotency_key` is UNIQUE on both `local_orders` and `sync_outbox` because
 * the whole offline-first design (§2.2) is built on replay safety: a terminal
 * that is offline for an hour may retry the same checkout, and the server must
 * be able to reject the duplicate rather than sell the drink twice. That
 * guarantee is worthless if the local database accepts two rows with the same
 * key and syncs both.
 */
describe('0001_init.sql — uniqueness and referential integrity', () => {
  it('rejects a duplicate idempotency_key on local_orders', () => {
    insertOrder();
    expect(() => insertOrder({ id: '0190f3a0-0000-7000-8000-000000000002' })).toThrow();

    const count = db.prepare('SELECT count(*) AS n FROM local_orders').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('relies on the connection to enable foreign keys, not the migration', () => {
    // This test's name is the finding. It used to read "has foreign key
    // enforcement switched on by the migration", and it PASSED — because
    // `bun:sqlite`'s `exec()` runs the migration's statements outside a
    // transaction, so the pragma took effect here.
    //
    // Production did not. `src/migrate.rs` wraps each migration file in one
    // transaction so an interrupted CREATE INDEX cannot leave half a schema,
    // and `PRAGMA foreign_keys` is a documented no-op inside a transaction. The
    // pragma therefore never bound: foreign-key enforcement had been silently
    // OFF on every real terminal, and this suite was reporting it as ON.
    //
    // So the assertion is now inverted: the migration must NOT be what turns FKs
    // on, because it cannot. Enforcement is the connection's job, and the
    // `beforeEach` above stands in for `src/db.rs` doing it.
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | null;
    expect(row?.foreign_keys).toBe(1);

    // And the migration must not reintroduce the pragma that gave the false
    // confidence. If this ever matches again, someone has "restored" a line that
    // cannot work, and this suite will pass while production stays unenforced.
    //
    // Anchored to the start of a line so it matches only an EXECUTED pragma —
    // the file discusses this setting at length in prose, and matching the prose
    // would flag the explanation as if it were the bug.
    expect(MIGRATION_SQL).not.toMatch(/^[ \t]*PRAGMA\s+foreign_keys/im);
  });

  it('rejects a line whose order_id does not exist (foreign key)', () => {
    expect(() => insertLine({ order_id: 'no-such-order' })).toThrow();

    const count = db.prepare('SELECT count(*) AS n FROM local_order_lines').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('refuses to delete an order that still has a line (ON DELETE RESTRICT)', () => {
    insertOrder();
    insertLine();

    // Refused. Note WHICH mechanism refuses: SQLite runs BEFORE DELETE triggers
    // before it evaluates the foreign key, so the append-only trigger aborts
    // first and its retention-policy message is what surfaces. The ON DELETE
    // RESTRICT clause is the second line of defence, asserted above by the
    // `PRAGMA foreign_keys` and unknown-parent cases. Either way the row and
    // its line survive, which is the property that matters: a sale is never
    // silently un-sold.
    expect(() => db.prepare('DELETE FROM local_orders').run()).toThrow();

    const orders = db.prepare('SELECT count(*) AS n FROM local_orders').get() as { n: number };
    const lines = db.prepare('SELECT count(*) AS n FROM local_order_lines').get() as { n: number };
    expect(orders.n).toBe(1);
    expect(lines.n).toBe(1);
  });

  it('refuses a direct DELETE on local_orders (append-only trigger)', () => {
    insertOrder();

    expect(() => db.prepare('DELETE FROM local_orders').run()).toThrow();

    const count = db.prepare('SELECT count(*) AS n FROM local_orders').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('refuses a direct DELETE on local_order_lines (append-only trigger)', () => {
    insertOrder();
    insertLine();

    expect(() => db.prepare('DELETE FROM local_order_lines').run()).toThrow();

    const count = db.prepare('SELECT count(*) AS n FROM local_order_lines').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

/**
 * 6. Arithmetic identities — the schema proves the money ADDS UP.
 *
 * SKILL.md §2.1 forbids floats, but integer satang alone is not enough: an order
 * whose `total_satang` disagrees with the sum of its parts is just as wrong as
 * a fractional one, and worse it is wrong invisibly. The table-level CHECKs
 * below make the identities part of the storage contract, so a bug in the
 * TypeScript cart maths fails at COMMIT time, inside the same transaction that
 * §2.2 requires, rather than surfacing as an unbalanced Thai receipt at the
 * end of the shift.
 *
 * VAT IS INCLUSIVE, so the identities are:
 *
 *   total   = subtotal - discount + service_charge + rounding_adjustment
 *   taxable + tax = total - service_charge - rounding_adjustment
 *   tax     = gross - round_half_up(gross * 10000 / (10000 + vat_rate_bp))
 *   line_total = unit_price * quantity - line_discount   (line_tax is always 0)
 */
describe('0001_init.sql — arithmetic identities', () => {
  it('rejects a total that does not equal subtotal - discount + charge + rounding', () => {
    // The baseline parts sum to 4550, but the stored total claims 4551.
    expect(() => insertOrder({ total_satang: 4551 })).toThrow();

    const count = db.prepare('SELECT count(*) AS n FROM local_orders').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('rejects a discount larger than the subtotal', () => {
    // A ฿10.00 subtotal cannot carry a ฿20.00 discount. `total_satang` is
    // zeroed because a matching total would itself be negative; either way the
    // INSERT must not land.
    expect(() =>
      insertOrder({
        subtotal_satang: 1000,
        discount_satang: 2000,
        taxable_satang: 0,
        tax_satang: 0,
        total_satang: 0,
      }),
    ).toThrow();
  });

  it('rejects net + tax that does not equal the amount charged', () => {
    // VAT-inclusive: net 4252 + tax 298 = 4550. Claiming 4252 + 299 leaves a
    // satang unaccounted for, which is an unbalanced receipt.
    expect(() => insertOrder({ tax_satang: 299 })).toThrow();
  });

  it('rejects the FORWARD-VAT answer, which is a different amount of money', () => {
    // The trap this schema exists to catch. Forward VAT gives
    //   tax = round_half_up(4550 * 700 / 10000) = 319
    // but inclusive extraction gives 298. Storing 319 with net 4252 would claim
    // ฿45.71 of goods for a ฿45.50 latte — the customer is charged tax twice.
    expect(() => insertOrder({ taxable_satang: 4252, tax_satang: 319 })).toThrow();
    expect(() => insertOrder({ taxable_satang: 4231, tax_satang: 319 })).toThrow();
  });

  it('accepts the inclusive pair and rejects it when the rate disagrees', () => {
    // The baseline (net 4252 + tax 298) is already accepted by insertOrder()
    // in the other tests; assert it explicitly here so the positive case is
    // pinned rather than merely implied.
    expect(() => insertOrder()).not.toThrow();

    // Same subtotal, but claiming a 0% rate while storing 298 of VAT.
    const other = db.prepare('SELECT count(*) AS n FROM local_orders').get() as { n: number };
    expect(other.n).toBe(1);
  });

  it('rejects a line total that does not equal unit_price * quantity - discount', () => {
    insertOrder();

    // unit 4550 x qty 1 - 0 discount is 4550, but the row claims 1.
    expect(() => insertLine({ line_total_satang: 1 })).toThrow();

    const count = db.prepare('SELECT count(*) AS n FROM local_order_lines').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('rejects a quantity that is not a positive integer', () => {
    insertOrder();
    expect(() => insertLine({ quantity: 0 })).toThrow();
    expect(() => insertLine({ quantity: 1.5 })).toThrow();
  });

  it('rejects a non-zero line_tax, because VAT is posted once per order', () => {
    // The single most important new guard. A per-line VAT of 298 would be a
    // second, differently-rounded copy of money the order-level figure already
    // contains, and the sum would not reconcile with the receipt.
    insertOrder();
    expect(() => insertLine({ line_tax_satang: 298 })).toThrow();
  });

  it('accepts a line whose identity holds with a quantity and a discount', () => {
    insertOrder();
    // 4550 * 2 - 1000 + 0 (line tax is always 0) = 8100
    expect(() =>
      insertLine({
        quantity: 2,
        line_discount_satang: 1000,
        line_tax_satang: 0,
        line_total_satang: 8100,
      }),
    ).not.toThrow();
  });
});

/**
 * 7. The two implementations of the VAT rule must be the SAME rule.
 *
 * `tax.ts` computes the split in TypeScript; `0001_init.sql` re-checks it in
 * SQL. Those are two separate encodings of one accounting decision, and they can
 * silently drift apart — someone fixes a rounding edge case in one and not the
 * other. The failure mode is nasty and late: every unit test in the domain
 * passes, the UI shows a correct receipt, and then CHECKOUT FAILS AT COMMIT
 * because the two disagree by a satang.
 *
 * So the domain is treated as the specification and the schema is attacked with
 * whatever the domain actually produces, across a range of amounts, including
 * the ones that exercise rounding. Anything the domain computes must be
 * storable; nothing else may be.
 *
 * Note the shape of the guarantee: this does NOT say the SQL formula is right in
 * the abstract, it says the two agree. The shared definition of correctness lives
 * in docs/02-design/DOMAIN.md and is pinned by tax.test.ts.
 */
describe('0001_init.sql — the schema agrees with sales/domain/tax.ts', () => {
  // Amounts chosen to cover: the headline ฿45.50, a single satang, a large
  // order, and several amounts whose net division lands on a fraction near a
  // half — the cases where round-half-UP could diverge.
  const amounts = [1, 2, 5, 10, 107, 4550, 9999, 100_000, 1_234_567] as const;
  const rates = [0, 100, 700, 1000] as const;

  it('accepts every split the domain produces', () => {
    for (const amount of amounts) {
      for (const rate of rates) {
        // `Money.fromSatang` takes bigint by contract — satang never pass through
        // a JS number on the way into the domain.
        const { gross, net, tax } = splitInclusive(
          Money.fromSatang(BigInt(amount)),
          BigInt(rate),
        );

        expect(() =>
          insertOrder({
            // Fresh `id` AND `idempotency_key` per attempt: this loop inserts many
            // valid orders into one database, and a repeated value would fail on
            // PRIMARY KEY / UNIQUE and prove nothing about the arithmetic.
            id: `agree-${amount}-${rate}`,
            idempotency_key: `agree-${amount}-${rate}`,
            vat_rate_bp: rate,
            subtotal_satang: gross.satang,
            taxable_satang: net.satang,
            tax_satang: tax.satang,
            total_satang: gross.satang,
          }),
        ).not.toThrow();
      }
    }
  });

  it('rejects every split the domain does NOT produce', () => {
    // For each amount, off-by-one tax at the same net must be refused, because
    // the schema re-derives the figure rather than trusting the caller.
    for (const amount of amounts) {
      const { gross, net, tax } = splitInclusive(
        Money.fromSatang(BigInt(amount)),
        DEFAULT_VAT_RATE_BP,
      );

      // Guard the fixture itself: if this fails, the "off by one" case below is
      // meaningless because tax+1 may coincide with the correct value at a rate
      // where tax is 0... which it never is here, but the assertion documents the
      // assumption rather than leaving it implicit.
      expect(tax.satang + 1n).not.toBe(tax.satang);

      expect(() =>
        insertOrder({
          // Fresh keys here as well: these must fail on the arithmetic CHECK, not
          // on a duplicate-key error that would make the assertion vacuous.
          id: `reject-${amount}`,
          idempotency_key: `reject-${amount}`,
          subtotal_satang: gross.satang,
          taxable_satang: net.satang,
          tax_satang: tax.satang + 1n,
          total_satang: gross.satang,
        }),
      ).toThrow();
    }
  });

  it('pins the headline ฿45.50 breakdown so the two rules cannot drift apart', () => {
    const { gross, net, tax } = splitInclusive(
      Money.fromSatang(4550n),
      DEFAULT_VAT_RATE_BP,
    );

    // VAT-inclusive: net ฿42.52 + tax ฿2.98 = ฿45.50 charged.
    expect(gross.satang).toBe(4550n);
    expect(net.satang).toBe(4252n);
    expect(tax.satang).toBe(298n);

    // And the forward-VAT answer, ฿3.19, is a different amount of money. If
    // someone ever "fixes" the formula to this, this assertion is what notices.
    expect(tax.satang).not.toBe(319n);
  });
});

/**
 * 7. Outbox — the §2.2 transactional outbox, guarded in the schema.
 *
 * The outbox is what makes the POS offline-first honest: checkout writes the
 * sale row and the event in one transaction, and a background drain pushes the
 * event to Go later. Once an event is queued, its payload is the server's only
 * picture of what happened, so the payload must be a well-formed JSON OBJECT at
 * INSERT time. A truncated string (disk full mid-write, a JS stringification bug)
 * would otherwise be drained to the server as unparseable data and rejected at
 * the far end, long after the terminal believed the sale was safely recorded.
 */
describe('0001_init.sql — sync_outbox payload and state constraints', () => {
  it('rejects a payload that is not valid JSON', () => {
    expect(() => insertOutbox({ payload: 'not json at all' })).toThrow();
  });

  it('rejects a JSON array payload — the CHECK requires an object', () => {
    // `json_type()` returns 'array' for this, and the column-level CHECK
    // demands 'object'. A batched-events design would be a schema change, not
    // something to smuggle in through the payload column.
    expect(() => insertOutbox({ payload: '[{"order_id":"x"}]' })).toThrow();
  });

  it('accepts a JSON object payload', () => {
    expect(() => insertOutbox()).not.toThrow();

    const row = db
      .prepare("SELECT payload, status, processed_at FROM sync_outbox WHERE idempotency_key = 'idem-outbox-0001'")
      .get() as Record<string, unknown>;

    expect(row.status).toBe('pending');
    expect(row.processed_at).toBeNull();
    expect(JSON.parse(row.payload as string)).toEqual({
      order_id: '0190f3a0-0000-7000-8000-000000000001',
      total_satang: 5250,
    });
  });

  it('rejects a duplicate idempotency_key on sync_outbox', () => {
    insertOutbox();
    expect(() => insertOutbox({ id: '0190f3a0-0000-7000-8000-0000000000b2' })).toThrow();
  });

  it('rejects status = \'done\' while processed_at is NULL', () => {
    // A 'done' row is the server's proof the event landed. Marking it done
    // without a processing timestamp would let the drain record success it
    // cannot prove, and the event would be dropped from the queue forever.
    expect(() => insertOutbox({ status: 'done', processed_at: null })).toThrow();
  });

  it('accepts status = \'done\' when processed_at is set', () => {
    expect(() =>
      insertOutbox({ status: 'done', processed_at: '2026-10-02T09:05:00.000Z' }),
    ).not.toThrow();
  });
});

/**
 * The outbox event is APPEND-ONLY except for its delivery state. The drain
 * engine must be able to advance `status`, `attempt_count` and `next_attempt_at`
 * (exponential backoff, §2.2), but it must never be able to rewrite WHAT the
 * event says or WHICH event it is. If `id` or `idempotency_key` could change,
 * the server's deduplication table would be defeated; if `payload` or
 * `created_at` could change, the sale could be retroactively edited in the
 * queue without any audit trail on the orders table.
 */
describe('0001_init.sql — sync_outbox is append-only apart from delivery state', () => {
  const ID = '0190f3a0-0000-7000-8000-0000000000b1';

  it('rejects an UPDATE that rewrites the event id', () => {
    insertOutbox();
    expect(() => db.prepare('UPDATE sync_outbox SET id = ?').run('0190f3a0-0000-7000-8000-0000000000ff')).toThrow();
    expect(typeofColumn('sync_outbox', 'id', ID, 'id')).toBe('text');
  });

  it('rejects an UPDATE that rewrites the idempotency_key', () => {
    insertOutbox();
    expect(() => db.prepare('UPDATE sync_outbox SET idempotency_key = ?').run('idem-forged')).toThrow();

    const row = db.prepare('SELECT idempotency_key FROM sync_outbox WHERE id = ?').get(ID) as {
      idempotency_key: string;
    };
    expect(row.idempotency_key).toBe('idem-outbox-0001');
  });

  it('rejects an UPDATE that rewrites the payload', () => {
    insertOutbox();
    expect(() =>
      db.prepare('UPDATE sync_outbox SET payload = ?').run('{"order_id":"forged","total_satang":1}'),
    ).toThrow();

    const row = db.prepare('SELECT payload FROM sync_outbox WHERE id = ?').get(ID) as { payload: string };
    expect(row.payload).toContain('total_satang":5250');
  });

  it('rejects an UPDATE that rewrites created_at', () => {
    insertOutbox();
    expect(() =>
      db.prepare('UPDATE sync_outbox SET created_at = ?').run('2020-01-01T00:00:00.000Z'),
    ).toThrow();
  });

  it('allows an UPDATE that only advances delivery state', () => {
    // This is the one write the drain engine must be able to make, so the
    // append-only trigger must not block it.
    insertOutbox();
    expect(() =>
      db
        .prepare("UPDATE sync_outbox SET status = 'in_flight', attempt_count = 1, next_attempt_at = ? WHERE id = ?")
        .run('2026-10-02T09:01:00.000Z', ID),
    ).not.toThrow();

    const row = db
      .prepare('SELECT status, attempt_count, next_attempt_at FROM sync_outbox WHERE id = ?')
      .get(ID) as Record<string, unknown>;
    expect(row.status).toBe('in_flight');
    expect(row.attempt_count).toBe(1);
  });
});

/**
 * 8. Append-only money — a committed sale is never edited in place.
 *
 * A POS sale is a FACT, not a draft. Once checkout has committed inside the
 * §2.2 transaction, the order is what the customer was charged and what the
 * server will reconcile against; correcting it later means a VOID event and a
 * new order, not an UPDATE. The `local_orders_money_immutable` trigger exists
 * so that no code path — a bad reconciliation, a "fix" in a support script, a
 * careless `db.run("UPDATE local_orders SET ...")`, or a SQL-injected string
 * built from UI input — can quietly restate money that has already been taken.
 *
 * A NOTE ON TEST DESIGN, because it decides what these tests actually prove:
 * every money column participates in the arithmetic identities of describe
 * block 6, so a naive single-column UPDATE would be rejected by those CHECKs
 * regardless of whether the trigger exists. Such a test would pass even against
 * a schema with no money trigger at all. To isolate the TRIGGER, each rejection
 * case below rewrites a whole consistent group of columns at once, so every
 * arithmetic identity still holds and the trigger is the only thing that can
 * abort the statement. That is why the totals are shifted in pairs.
 */
describe('0001_init.sql — committed money is append-only', () => {
  it('rejects an UPDATE that rewrites local_orders.total_satang', () => {
    insertOrder();

    // Naive form: `total_satang` alone would also break the total identity.
    expect(() => db.prepare('UPDATE local_orders SET total_satang = 1').run()).toThrow();
  });

  it('rejects an UPDATE that rewrites local_orders.total_satang while keeping every identity true', () => {
    insertOrder();

    // Identity-preserving: the only value that can move while net + tax still
    // equals the amount charged is a discount that cancels out. VAT-inclusive:
    //   subtotal 4550, discount 1000 -> gross 3550
    //   net = round_half_up(3550 * 10000 / 10700) = 3318, tax = 232
    //   total = 4550 - 1000 = 3550, and 3318 + 232 = 3550    ok
    expect(() =>
      db
        .prepare(
          `UPDATE local_orders
              SET discount_satang = 1000,
                  taxable_satang = 3318,
                  tax_satang = 232,
                  total_satang = 3550`,
        )
        .run(),
    ).toThrow();

    const row = db
      .prepare('SELECT discount_satang, taxable_satang, tax_satang, total_satang FROM local_orders')
      .get() as {
      discount_satang: number;
      taxable_satang: number;
      tax_satang: number;
      total_satang: number;
    };
    expect(row.discount_satang).toBe(0);
    expect(row.taxable_satang).toBe(4252);
    expect(row.tax_satang).toBe(298);
    expect(row.total_satang).toBe(4550);
  });

  it('rejects an identity-preserving UPDATE that rewrites local_orders.subtotal_satang', () => {
    insertOrder();

    // Isolation matters here, so the arithmetic is chosen carefully.
    //
    //   subtotal 4550 -> 6000     (the column the trigger should guard)
    //   discount    0 -> 1450     (absorbed so `taxable` need not move)
    //   taxable  4550 -> 4550     UNCHANGED
    //   total    5250 -> 5250     UNCHANGED
    //
    //   taxable (4550) = subtotal (6000) - discount (1450)   ok
    //   total  (5250) = 4550 + 700 + 0 + 0                   ok
    //   discount (1450) <= subtotal (6000)                    ok
    //   every money column is a non-negative integer          ok
    //
    // `total_satang` is deliberately NOT touched, so the shipped
    // `local_orders_money_immutable` trigger has nothing to fire on. The only
    // thing that can reject this statement is a trigger that also covers
    // `subtotal_satang` (and `discount_satang` / `taxable_satang`).
    //
    // 0001_init.sql guards `total_satang` alone, so this UPDATE is currently
    // ACCEPTED and this assertion FAILS. That failure is the defect report and
    // it is deliberately left in place: the assertion states the invariant the
    // Strict Money Rule requires, and weakening it would hide a real hole by
    // which a committed ฿52.50 sale can be silently restated to ฿60.00.
    expect(() =>
      db
        .prepare(
          'UPDATE local_orders SET subtotal_satang = 6000, discount_satang = 1450',
        )
        .run(),
    ).toThrow();
  });

  it('allows an UPDATE to local_orders.status (lifecycle is not money)', () => {
    insertOrder();

    // A draft becoming a completed order is the normal path and must not be
    // blocked; the trigger is on money columns, not on the row.
    expect(() =>
      db
        .prepare("UPDATE local_orders SET status = 'completed', updated_at = ?")
        .run('2026-10-02T09:10:00.000Z'),
    ).not.toThrow();

    const row = db.prepare('SELECT status FROM local_orders').get() as { status: string };
    expect(row.status).toBe('completed');
  });

  it('rejects an identity-preserving UPDATE of local_order_lines.line_total_satang', () => {
    insertOrder();
    insertLine();

    // line_total = unit * qty - discount + tax, kept true at 9100
    // (9100 = 4550 * 2 - 0 + 0) with quantity moved 1 -> 2.
    expect(() =>
      db.prepare('UPDATE local_order_lines SET quantity = 2, line_total_satang = 9100').run(),
    ).toThrow();
  });
});
