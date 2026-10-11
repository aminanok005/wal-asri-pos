/**
 * The mapping edge between the cloud's `StockBalance` and what the terminal
 * writes to its local SQLite.
 *
 * LAYER: infrastructure. This is the one place in the inventory feature allowed
 * to know `@wasri/api-types` and the Tauri wire shapes, and the one place a
 * server row is allowed to become a local row.
 *
 * ── WHAT THIS MODULE IS ACTUALLY FOR ─────────────────────────────────────────
 *
 * `GET /api/v1/inventory/balances` returns `StockBalance` objects whose
 * `on_hand` and `reserved` are `Quantity`: exact decimal STRINGS such as
 * `"2.500"`. The local table stores MILLI-UNITS as an INTEGER. Between those two
 * facts sits a conversion, and a conversion is exactly where a number quietly
 * becomes a float. So the conversion lives here, alone, and is the only place in
 * this feature allowed to turn a `Quantity` into something bindable.
 *
 * ── QUANTITIES ARE STRINGS, AND NOT BY STYLISTIC PREFERENCE ──────────────────
 *
 * Every quantity in the returned payload is a `string`, produced by
 * `Quantity.toDecimalString()`. Two independent reasons, and both must hold:
 *
 *   1. **The Tauri bridge.** `invoke` serialises through JSON, where a number is
 *      an IEEE-754 double in JavaScript. For money the failure needs 2^53
 *      satang to show up; for a quantity it shows up immediately, because
 *      `"2.500"` has no exact binary representation at all, and `0.1 + 0.2`
 *      is the same defect at a magnitude anyone will actually hit.
 *   2. **SQLite affinity.** A column declared `INTEGER` accepts the TEXT
 *      `"2500"` and coerces it silently, after which the evidence is gone. The
 *      `typeof(col) = 'integer'` CHECK in `0003_stock_balances.sql` cannot
 *      distinguish a coerced string from a real integer. Keeping the payload a
 *      string until `parse_milli_quantity` in Rust has inspected it means the
 *      decision is made by code, not by a storage class.
 *
 * ── WHY A BAD ROW IS REJECTED WITH A NAME RATHER THAN SKIPPED SILENTLY ────────
 *
 * Unlike the catalog build (`catalog/domain/catalog.ts`), which skips a bad row
 * and records why, this edge is **total-then-throw**. The reasoning is the
 * opposite, and it is deliberate:
 *
 *   * A skipped price leaves a cashier looking at a menu with one item missing,
 *     which is visible and recoverable.
 *   * A skipped stock balance leaves the terminal reporting a STALE number for
 *     an article, with nothing on screen to say so. The cashier sells flour the
 *     shop does not have, and the only trace is a row nobody thought to check.
 *
 * The whole pull is rejected instead, and the message names the field and the
 * offending value. A branch that cannot sync its stock learns that immediately,
 * rather than trading wrong figures all shift.
 *
 * @see ../domain/quantity.ts — the value object this maps to
 * @see ../../../../src-tauri/migrations/0003_stock_balances.sql — the table
 * @see ../../../../src-tauri/src/stock_balances.rs — the Rust side of this wire
 */

import type { components } from '@wasri/api-types';
import { Quantity, QuantityError } from '../domain/quantity';

// ─────────────────────────────────────────────────────────────────────────────
// Contract-derived types
//
// Imported from the GENERATED `@wasri/api-types` rather than redeclared, so this
// file cannot drift from `contracts/openapi.yaml`: change the contract,
// regenerate, and any mismatch is a compile error here rather than a runtime
// surprise in a shop.
// ─────────────────────────────────────────────────────────────────────────────

type Schema<K extends keyof components['schemas']> = components['schemas'][K];

/** A generated contract type, addressed by its schema name. */
export type StockBalance = Schema<'StockBalance'>;

/** QUANTITY on the wire: an exact decimal string (`Quantity` in the contract). */
export type WireQuantity = Schema<'Quantity'>;

/** UUIDv7 — client-generated, time-ordered. */
export type UuidV7 = Schema<'UuidV7'>;

/**
 * What the Rust side receives: `StockBalanceInput` in
 * `src-tauri/src/stock_balances.rs`.
 *
 * Every quantity is declared `string`, so a `number` cannot be substituted
 * without a compile error. That is the point of the type: the invariant is
 * checked by the compiler here, and again by `parse_milli_quantity` on the other
 * side of the bridge, rather than by a code review that might miss one.
 */
export interface StockBalanceSyncPayload {
  readonly id: string;
  readonly inventoryItemId: string;
  readonly branchId: string;
  /** QUANTITY — canonical 3-dp decimal string, e.g. `"2.500"`. Never a number. */
  readonly onHand: string;
  /** QUANTITY — canonical 3-dp decimal string, e.g. `"0.250"`. Never a number. */
  readonly reserved: string;
  readonly remoteId: string;
  readonly version: number;
  /** Server clock, RFC 3339 UTC. Doubles as the `since` cursor for the next pull. */
  readonly updatedAt: string;
  /** Terminal clock, RFC 3339 UTC — how stale the row is, judged locally. */
  readonly syncedAt: string;
}

/** A rejection raised while mapping a pulled snapshot. */
export class StockBalanceSyncError extends Error {
  /** Which row of the snapshot failed, zero-based. */
  readonly index: number;
  /** Which field of that row failed. `null` when the row failed as a whole. */
  readonly field: string | null;

  constructor(index: number, field: string | null, detail: string) {
    super(`balances[${index}]${field ? `.${field}` : ''}: ${detail}`);
    this.name = 'StockBalanceSyncError';
    this.index = index;
    this.field = field;
  }
}

/**
 * Convert one pulled `StockBalance` into the local-write payload.
 *
 * The one conversion in this feature. Both quantities go through
 * `Quantity.fromWire` and come back out through `toDecimalString`, so the value
 * that crosses `invoke` is the value the server sent, re-rendered in the single
 * canonical spelling — never re-derived by arithmetic, and never a float.
 *
 * ### Why `toDecimalString` and not the raw `on_hand`
 *
 * Re-rendering normalises the spelling. If a server sends `"2.50"` this writes
 * `"2.500"`, so the row that reaches SQLite cannot depend on which of two
 * equivalent spellings a given deployment produced. It also means the string
 * crossing the bridge is one this build has already parsed successfully — a
 * malformed value cannot reach Rust at all.
 *
 * ### Why the branch must match
 *
 * A balance is scoped to one branch. If a row's own `branch_id` disagrees with
 * the pull's, writing it would file one branch's stock under another, and the
 * sell path would then answer a question about the wrong shelf. That is refused
 * rather than reconciled.
 *
 * @param balance the server row, straight from the contract type
 * @param index   its position in the snapshot, used only to name it in errors
 * @param options `branchId` the pull was scoped to; `syncedAt` the terminal's clock
 */
export function toStockBalanceSyncPayload(
  balance: StockBalance,
  index: number,
  options: { readonly branchId: UuidV7; readonly syncedAt: string },
): StockBalanceSyncPayload {
  const { branchId, syncedAt } = options;

  if (balance.branch_id !== branchId) {
    throw new StockBalanceSyncError(
      index,
      'branchId',
      `belongs to branch ${balance.branch_id}, but the pull was scoped to ${branchId}. ` +
        'Writing it would file this article under the wrong shelf.',
    );
  }
  if (syncedAt.trim() === '') {
    throw new StockBalanceSyncError(index, 'syncedAt', 'must not be empty');
  }

  // Parsed into the value object first so the quantity is validated here, at the
  // edge, with the row and field named — and so the string that crosses `invoke`
  // is one this build has already proven it can read back exactly.
  const onHand = parseOrThrow(index, 'onHand', balance.on_hand);
  const reserved = parseOrThrow(index, 'reserved', balance.reserved);

  if (!Number.isInteger(balance.version) || balance.version < 0) {
    throw new StockBalanceSyncError(
      index,
      'version',
      `must be a non-negative integer, got ${JSON.stringify(balance.version)}. It is the ` +
        "server's optimistic-concurrency counter, and the local UPSERT compares against it.",
    );
  }

  return Object.freeze({
    id: balance.id,
    inventoryItemId: balance.inventory_item_id,
    branchId: balance.branch_id,
    onHand: onHand.toDecimalString(),
    reserved: reserved.toDecimalString(),
    remoteId: balance.id,
    version: balance.version,
    updatedAt: balance.updated_at,
    syncedAt,
  });
}

/**
 * Convert a whole pulled snapshot, or explain which row stopped it.
 *
 * Total, and deliberately so — see the module header on why this edge throws
 * where the catalog edge skips. A stock balance is not an optional extra: a
 * terminal that silently drops one reports a stale number with nothing on screen
 * to say so.
 *
 * An empty array is legitimate — a branch that tracks no inventory items yet —
 * and yields an empty payload rather than an error.
 *
 * ### Why the cursor is derived, not taken
 *
 * The cursor is `max(updated_at)` over the rows actually received, rather than
 * the server's `cursor` field being trusted blindly. The asymmetry decides it: a
 * cursor that replays a delta is harmless, because the local UPSERT is keyed on
 * `(branch_id, inventory_item_id)` and idempotent — the same rows are rewritten
 * with the same values. A cursor that SKIPS leaves stock silently stale until an
 * operator notices a cashier refused an item that was in stock. `max` is
 * monotone and therefore replay-biased, which is the safe direction to be wrong
 * in. A caller is still free to prefer the server's `cursor`; this is a default,
 * not a veto.
 *
 * @returns the payload for the `apply_stock_balances` command, plus the cursor to
 *          remember for the next incremental pull
 * @see ./tauriStockBalances.ts — the invoke edge that sends these payloads
 */
export function toStockBalanceSyncPayloads(
  balances: readonly StockBalance[],
  options: { readonly branchId: UuidV7; readonly syncedAt: string },
): { readonly payloads: readonly StockBalanceSyncPayload[]; readonly cursor: string } {
  const payloads = Object.freeze(
    // `toStockBalanceSyncPayload` re-checks the branch per row, so the snapshot
    // as a whole is validated by validating each of its rows — there is no
    // cheaper form, and a pre-pass would duplicate the rule in two places.
    balances.map((balance, index) => toStockBalanceSyncPayload(balance, index, options)),
  );

  const cursor = balances.reduce(
    (newest, balance) => (balance.updated_at > newest ? balance.updated_at : newest),
    '',
  );

  return Object.freeze({ payloads, cursor });
}

/**
 * Parse one quantity, converting a `QuantityError` into a `StockBalanceSyncError`
 * that names the row.
 *
 * The two error types are kept distinct rather than merged: `QuantityError` knows
 * the grammar and has no idea where in a snapshot the bad value sat, and the
 * caller needs both facts to act on it.
 */
function parseOrThrow(index: number, field: string, raw: unknown): Quantity {
  try {
    return Quantity.fromWire(`balances[${index}].${field}`, raw);
  } catch (error) {
    if (error instanceof QuantityError) {
      // `fromWire`'s message already carries the field label it was given, so
      // only the detail is lifted across — prefixing it twice would read badly.
      throw new StockBalanceSyncError(index, field, error.message);
    }
    throw error;
  }
}