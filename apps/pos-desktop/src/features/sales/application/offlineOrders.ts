/**
 * The port the UI reads offline order history through.
 *
 * ── Why a port and not the database ─────────────────────────────────────────
 * The terminal's orders live in SQLCipher-encrypted SQLite, reached through
 * Tauri's `invoke` bridge. A React component that imported the Tauri API
 * directly could not be rendered in a unit test, in a design review, or in any
 * future web shell — there would be no native runtime to invoke. So the views
 * depend on the interface below and know nothing about the transport. This is
 * hexagonal architecture paying for itself on the one screen where it matters:
 * the history list is the screen a manager is most likely to open during a bug
 * report.
 *
 * LAYER: application, sitting between the domain and the native adapter. It
 * must NOT import React, `@tauri-apps/*`, or `bun:sqlite` — that restriction is
 * exactly why the interface exists, because those are the things that would
 * otherwise be poured straight into a view. The Tauri/SQLite adapter arrives
 * later and implements this same interface; so does the in-memory adapter at
 * the bottom of this file. Both are interchangeable, and neither is visible
 * from here.
 *
 * ── Why the port is this narrow ─────────────────────────────────────────────
 * A history screen needs exactly two reads: a page of recent orders and one
 * order by id. Anything else the UI will eventually want — voiding, resending,
 * reprinting a receipt — is a WRITE, and a write against an offline sale is a
 * transactional outbox event (SKILL.md §2.2), which is a different interface.
 * It is deliberately not implied here: a port that grew a `void(orderId)`
 * method would let a view reach around the transaction boundary, and the §2.2
 * guarantee would quietly become a suggestion.
 *
 * @see ../domain/cart.ts — the pure domain layer above this port
 * @see ../../../../src-tauri/migrations/0001_init.sql — the schema modelled below
 */

// ─────────────────────────────────────────────────────────────────────────────
// Imports
//
// `import type` because `Money` appears in this file only as a type: it is
// never constructed here. Under `verbatimModuleSyntax` a value import would
// emit a runtime `require` of the domain module for no reason, and this port
// has no business pulling value-level code across a layer boundary.
// ─────────────────────────────────────────────────────────────────────────────

import type { Money } from '../../payments/domain/money';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised for a bad argument handed to the port. Separate from a transport
 * failure: a `limit` of `0` is a bug in the caller and will be a bug forever,
 * whereas a SQLCipher error is the adapter's problem and may pass.
 */
export class OfflineOrdersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineOrdersError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ladders mirrored from the SQL schema
//
// These two unions are NOT an independent design decision. They restate the
// `CHECK` lists on `local_orders` in migrations/0001_init.sql:
//
//   status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
//                ('draft','submitted','in_preparation','ready','served',
//                 'completed','void_requested','voided'))
//   sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN
//                ('pending','synced','conflict','rejected'))
//
// The SQL file is the SECOND source of this ladder — the database owns it,
// because the database is what rejects a bad value at COMMIT time. These
// unions exist so TypeScript catches the mistake before the statement is ever
// built; they do not replace the CHECK.
//
// Adding a rung to one side WITHOUT adding it to the other produces a bug that
// stays invisible until a terminal meets that condition in production: the TS
// side stops compiling for a value SQLite would accept, or the SQLite side
// rejects a value the UI believes in.
//
// TODO(SCHEMA-DRIFT): add a test that READS 0001_init.sql from disk and
//   asserts that the two `IN (...)` lists match these unions exactly, member
//   for member and in order. Writing it by hand keeps the two ladders in sync
//   by discipline, which is a promise; reading the SQL would make it a check.
//   It is outstanding because it needs either a SQL parser or a deliberately
//   brittle regex, and neither should land silently — a future migration will
//   reformat those CHECK clauses and a naive parser will start failing on
//   cosmetics rather than on drift.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Order lifecycle, exactly as `local_orders.status` allows it.
 *
 * The ladder runs draft → submitted → in_preparation → ready → served →
 * completed, with void_requested → voided branching off it. Every rung is a
 * state the cashier can see and explain, which is why it is a closed set: an
 * order in a state nobody can name is an order nobody can reconcile.
 */
export type OfflineOrderStatus =
  | 'draft'
  | 'submitted'
  | 'in_preparation'
  | 'ready'
  | 'served'
  | 'completed'
  | 'void_requested'
  | 'voided';

/**
 * Delivery state of one row, exactly as `local_orders.sync_state` allows it.
 *
 * Kept separate from the status above because the two answer different
 * questions: a `completed` order can still be `pending` (sold offline, not yet
 * pushed), and conflating them would make a synced-but-voided order look like
 * a stuck one.
 */
export type SyncState = 'pending' | 'synced' | 'conflict' | 'rejected';

// ─────────────────────────────────────────────────────────────────────────────
// The summary — the projection the history screen renders
//
// Deliberately a PROJECTION and not a row type. `local_orders` carries 23
// columns; this carries 8. The omitted fifteen are either money the cashier
// did not ask to see, or columns that answer a different question — which till,
// which branch, which staff member. Those are reconciliation questions, and
// they belong to a shift report, not to a list of receipts.
//
// A projection is also a promise that this port cannot be used to quietly
// rewrite a sale: there is no setter, and the one field that could be
// re-stated (`total`) is `readonly` and immutable as a `Money`.
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the offline order history, as the history screen needs it. */
export interface OfflineOrderSummary {
  /** `local_orders.id` — a UUIDv7 as TEXT, generated on this terminal. */
  readonly id: string;
  /**
   * `local_orders.local_receipt_number`. Local and monotonic per terminal; the
   * server assigns the authoritative number at sync, so the number on the
   * printed receipt and the number in this list are the same string by design.
   */
  readonly localReceiptNumber: string;
  /** `local_orders.status`. */
  readonly status: OfflineOrderStatus;
  /** `local_orders.sync_state`. */
  readonly syncState: SyncState;
  /**
   * `local_orders.created_at` — ISO-8601 UTC text, e.g.
   * `'2026-10-02T09:00:00.000Z'`. Text and not a `Date`, because that is what
   * the column stores, and a `Date` here would be a second unit conversion
   * waiting to disagree with the one the SQL layer already made. It also
   * sorts lexicographically in chronological order, which is exactly what
   * `sortByNewestFirst` relies on below.
   */
  readonly createdAt: string;
  /** How many rows `local_order_lines` holds for this order. `0` is possible. */
  readonly lineCount: number;
  /**
   * **MONEY — Satang (int64), as a `Money`.** From `local_orders.total_satang`
   * (฿45.50 → 4550). A `Money` and never satang-as-`number`, because this is a
   * BOUNDARY, not merely a domain type: the adapter will read a SQLite INTEGER
   * out of `bun:sqlite` as a JS `number`, and the adapter's own constructor is
   * the one place allowed to convert it — exactly once, at the edge. Were this
   * field a `number`, the temptation to write `total * 1.07` in a view would be
   * irresistible, and SKILL.md §2.1 exists to forbid precisely that.
   */
  readonly total: Money;
  /** `local_orders.currency` — ISO-4217 alpha-3. `'THB'` on every Thai branch. */
  readonly currencyCode: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seam: `OfflineOrderSummary` goes out, a `Promise` comes back.
 *
 * Async even though the in-memory adapter answers immediately, and that is on
 * purpose. An interface that returned `T` today and `Promise<T>` after the
 * SQLite adapter lands would force every view, every hook and every test to be
 * rewritten at the worst possible moment — in the middle of wiring a real
 * database underneath a screen that is already in front of a shop owner.
 */
export interface OfflineOrdersRepository {
  /**
   * The most recent orders, newest first, at most `limit` of them.
   *
   * "Recent" means `local_orders.created_at DESC`, which
   * `idx_local_orders_created_at` serves directly from the index with no sort
   * step — the reason that index exists.
   *
   * @param limit - a positive whole number. `0`, a negative number, a
   *   fractional number and `NaN` are all rejected rather than clamped: a
   *   caller that computed `0` means "my page size is broken", and quietly
   *   returning an empty list would turn that bug into an empty screen that
   *   looks like a till with no sales in it.
   * @throws OfflineOrdersError when `limit` is not a positive integer.
   */
  listRecent(limit: number): Promise<readonly OfflineOrderSummary[]>;

  /**
   * One order by id, or `undefined` when this terminal has no such order.
   *
   * `undefined` rather than a throw, because "not found" is an ordinary answer
   * to a lookup made from a link or a stale cache. An id belonging to another
   * terminal is not an error condition; it is a miss.
   */
  findById(id: string): Promise<OfflineOrderSummary | undefined>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Reject a `limit` that is not a positive whole number. */
function assertPositiveInteger(limit: number): void {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new OfflineOrdersError(`limit must be a positive integer, received ${String(limit)}`);
  }
}

/**
 * Freeze a list before it leaves this module.
 *
 * Every result is a fresh, frozen array, so a caller that casts past
 * `readonly` and pushes onto it gets a `TypeError` instead of silently
 * corrupting what a later caller will read. `readonly` is erased at runtime;
 * the freeze is what makes the guarantee real rather than advisory.
 */
function freezeSummaries(orders: readonly OfflineOrderSummary[]): readonly OfflineOrderSummary[] {
  return Object.freeze([...orders]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Newest first, with a deterministic tie-break.
 *
 * ORDERING IS BY STRING, NOT BY `Date`. `created_at` is ISO-8601 UTC text with
 * a fixed-width fraction, so lexicographic order IS chronological order — the
 * same property `idx_local_orders_created_at` and the migration header both
 * depend on. Parsing to a `Date` would add a timezone, a `NaN` case and an
 * allocation per row in order to obtain a number we already know how to
 * compare.
 *
 * WHY THE `id` TIE-BREAK IS NOT OPTIONAL
 * Two orders committed inside the same millisecond is not a hypothetical: a
 * burst on a latte-and-pastry during the morning rush, or an outbox replay on a
 * terminal that just woke up, will do it routinely. `Array.prototype.sort` is
 * stable, which sounds like it settles the matter — but stability only
 * preserves the ORDER OF THE INPUT, and the input order of a SQL result set is
 * not a contract. Add a WHERE clause, switch adapters, or let SQLite choose a
 * different plan for `LIMIT 50`, and the same two rows come back the other way
 * round. The history list then reshuffles itself between two renders for a
 * reason the cashier cannot see, which reads as data loss.
 *
 * The tie-break is `id` DESCENDING, and descending because `id` is a UUIDv7:
 * inside one millisecond the time-ordered part is identical, so the monotonic
 * counter field decides, and the LARGER id is the LATER order. Descending
 * therefore points the tie-break the same way as the primary key, so the
 * newest of a tied pair is still the one shown first.
 */
export function sortByNewestFirst(
  orders: readonly OfflineOrderSummary[],
): readonly OfflineOrderSummary[] {
  const sorted = [...orders].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? 1 : -1;
  });

  return freezeSummaries(sorted);
}

// ─────────────────────────────────────────────────────────────────────────────
// The in-memory adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A test double that behaves like the SQLite adapter, without any SQLite.
 *
 * It exists so the history screen can be rendered — and these rules exercised —
 * under `bun test` on a machine with no Tauri runtime and no encrypted
 * database. It is a REAL implementation of the port rather than a mock object:
 * it validates `limit`, freezes its results and orders them, so a test that
 * passes against it is testing behaviour and not a stub's shape.
 *
 * The seed is copied and frozen at construction and every call returns another
 * copy. Without that, a caller doing `results.pop()` while building a list
 * would be editing the adapter's own state, and the NEXT call would come back
 * short. The defensive copy is the whole point of the adapter being safe to
 * hand to more than one component.
 */
export function createInMemoryOfflineOrdersRepository(
  seed: readonly OfflineOrderSummary[] = [],
): OfflineOrdersRepository {
  // Sorted once, at construction: ordering does not depend on `limit`, so it is
  // not recomputed per call. Each element is frozen too, so a summary cannot be
  // edited between calls.
  const store: readonly OfflineOrderSummary[] = sortByNewestFirst(
    seed.map((order) => Object.freeze({ ...order })),
  );

  return {
    async listRecent(limit: number): Promise<readonly OfflineOrderSummary[]> {
      assertPositiveInteger(limit);
      return freezeSummaries(store.slice(0, limit));
    },

    async findById(id: string): Promise<OfflineOrderSummary | undefined> {
      return store.find((order) => order.id === id);
    },
  };
}
