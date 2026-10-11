/**
 * Tauri adapter: hand a mapped stock snapshot to the native `stock_balances`
 * cache.
 *
 * LAYER: infrastructure. This is the invoke EDGE — the one place in the
 * inventory feature allowed to know `@tauri-apps/api` exists.
 *
 * ── DIVISION OF LABOUR ACROSS THE THREE FILES ─────────────────────────────────
 *
 *   * `stockBalanceSync.ts` (mapping edge): cloud row → payload. Parses every
 *     quantity through `Quantity`, enforces branch scope, and freezes a payload
 *     whose quantities are strings this build has already proven it can read
 *     back exactly.
 *   * THIS FILE (invoke edge): sends that payload verbatim under the
 *     `balances` key the Rust command declares, and reads the command's
 *     summary back. It performs NO quantity arithmetic — there is none to
 *     perform — and it does not re-parse the quantities, because
 *     `parse_milli_quantity` in Rust refuses anything malformed regardless of
 *     what this layer believes. Two validators agreeing is not a second
 *     guarantee; it is one guarantee described twice.
 *   * `src-tauri/src/stock_balances.rs`: parses the strings into i64
 *     milli-units and UPSERTs the whole batch in one transaction.
 *
 * The string rule — quantities cross `invoke` as exact decimal strings and
 * never as JSON numbers — is argued where it is enforced: at the mapping edge
 * (`stockBalanceSync.ts`) and on the Rust side (`stock_balances.rs`). It is
 * restated here only as a constraint on THIS file's code: nothing below may
 * ever pass a `number` where a quantity belongs, which the
 * `StockBalanceSyncPayload` type already makes a compile error.
 *
 * ── WHY THE RESULT IS CHECKED AND THE PAYLOAD IS NOT ──────────────────────────
 *
 * `invoke<T>` ASSERTS `T`; Tauri returns whatever the command produced,
 * deserialised and unchecked. A bad PAYLOAD is unreachable — the mapping edge
 * built it from validated values — and would be caught by Rust's
 * `deny_unknown_fields` and parser anyway. A bad RESULT is different: the
 * caller computes with `inserted` and `updated` (did this pull land? how much
 * moved?), and a `undefined` there becomes a silent `NaN` in a sync report.
 * So the summary is validated here, at the boundary, once.
 *
 * @see ./stockBalanceSync.ts — the mapping edge that produces the payload
 * @see ../../../../src-tauri/src/stock_balances.rs — the Rust side of this wire
 * @see ../../../../src-tauri/src/commands.rs — the `apply_stock_balances` shim
 */

import { invoke } from '@tauri-apps/api/core';

import type { StockBalanceSyncPayload } from './stockBalanceSync';

/**
 * What the command reports back: `StockBalanceWriteResult` in
 * `src-tauri/src/stock_balances.rs`, serialised camelCase.
 */
export interface StockBalanceWriteSummary {
  /** Rows inserted — a `(branch_id, inventory_item_id)` key seen for the first time. */
  readonly inserted: number;
  /** Rows updated — a newer snapshot replaced an older one. */
  readonly updated: number;
}

/**
 * A rejection raised while reading the native side's answer.
 *
 * Distinct from `StockBalanceSyncError` on purpose: that error names a row and
 * a field of a snapshot being MAPPED, and its message is shaped
 * `balances[i].field: reason`. This one is about the shape of a command
 * RESULT — there is no row to name, and pretending there is would make the
 * message read like a mapping failure when the write already happened.
 */
export class StockBalanceWriteError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'StockBalanceWriteError';
  }
}

/**
 * Write one pulled snapshot into the local cache through the native command.
 *
 * The payload arrives from `toStockBalanceSyncPayloads` — already validated,
 * already frozen, quantities already canonical decimal strings — and is handed
 * to `invoke` unchanged under the argument name `balances`, which is what the
 * Rust command declares. An EMPTY array is a legitimate no-op (a branch that
 * tracks no inventory items yet) and is sent as-is rather than short-circuited:
 * letting the command answer `{inserted: 0, updated: 0}` keeps one code path,
 * and the transaction it opens writes nothing anyway.
 *
 * The command is validate-all-then-one-transaction on the Rust side, so a
 * single malformed row leaves the cache untouched and this call rejects with
 * `CommandError` (`kind: "invalidPayload"` or `"storage"`) from the native
 * layer — no partial batch, no cursor to advance past unwritten rows.
 */
export async function applyStockBalances(
  payloads: readonly StockBalanceSyncPayload[],
): Promise<StockBalanceWriteSummary> {
  const raw: unknown = await invoke('apply_stock_balances', {
    balances: payloads,
  });

  return writeSummaryFromWire(raw);
}

/**
 * Validate the command's result shape.
 *
 * Exported and pure so it is testable WITHOUT a Tauri runtime — the same
 * reason `toWireInput` is separate from `saveOfflineOrder` in the sales
 * feature. `invoke` cannot be called in a plain `bun test`, and mocking it
 * would test the mock.
 *
 * Counts must be safe non-negative integers: they are row counts produced by
 * Rust's `usize`, so a float, a negative, `NaN`, or anything past 2^53 means
 * the thing on the other end of the bridge is not the command this build
 * expects, and a caller adding them into a sync report must not learn that as
 * a quietly wrong number.
 */
export function writeSummaryFromWire(raw: unknown): StockBalanceWriteSummary {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StockBalanceWriteError(
      `apply_stock_balances must return an object, received ${
        raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw
      }`,
    );
  }

  const wire = raw as Record<string, unknown>;
  return Object.freeze({
    inserted: rowcount('inserted', wire.inserted),
    updated: rowcount('updated', wire.updated),
  });
}

/**
 * Read one row count, refusing anything that is not a safe non-negative
 * integer. The field name is repeated in the error because a caller seeing
 * this needs to know WHICH half of the summary is broken.
 */
function rowcount(field: string, raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new StockBalanceWriteError(
      `apply_stock_balances must return a non-negative integer for \`${field}\`, ` +
        `received ${JSON.stringify(raw) ?? typeof raw}. A float or missing count here ` +
        'would become a silent NaN in whatever sync report reads it.',
    );
  }
  return raw;
}
