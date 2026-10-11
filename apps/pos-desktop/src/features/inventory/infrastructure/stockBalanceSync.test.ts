/**
 * The mapping edge: a cloud `StockBalance` becoming a local write payload.
 *
 * The load-bearing assertion in this file is a NEGATIVE one — that no quantity
 * in a payload is ever a `number`. Everything else (branch scoping, error
 * naming, cursor derivation) is ordinary mapping, but the string rule is what
 * this feature exists for, and it is the thing a future refactor would break
 * first and most quietly.
 */

import { describe, expect, it } from 'bun:test';
import type { StockBalance } from './stockBalanceSync';
import {
  StockBalanceSyncError,
  toStockBalanceSyncPayload,
  toStockBalanceSyncPayloads,
} from './stockBalanceSync';

const BRANCH = '0199b1a0-0000-7000-8000-000000000001';
const OTHER_BRANCH = '0199b1a0-0000-7000-8000-0000000000ff';
const FLOUR = '0199b1a0-0000-7000-8000-0000000000f1';
const MILK = '0199b1a0-0000-7000-8000-0000000000f2';
const SYNCED_AT = '2026-10-05T09:00:00Z';
const UPDATED_AT = '2026-10-05T08:59:00Z';

/** A contract-shaped balance, with the two quantities overridable per case. */
function balance(overrides: Partial<StockBalance> = {}): StockBalance {
  return {
    id: `bal-${FLOUR}`,
    inventory_item_id: FLOUR,
    branch_id: BRANCH,
    on_hand: '2.500',
    reserved: '0.250',
    last_movement_id: null,
    version: 7,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: UPDATED_AT,
    ...overrides,
  } as StockBalance;
}

const options = { branchId: BRANCH, syncedAt: SYNCED_AT };

describe('stockBalanceSync — mapping one pulled balance', () => {
  it('carries both quantities across as canonical three-decimal strings', () => {
    const payload = toStockBalanceSyncPayload(balance(), 0, options);

    expect(payload.onHand).toBe('2.500');
    expect(payload.reserved).toBe('0.250');
  });

  // ── THE rule ──────────────────────────────────────────────────────────────

  it('never lets a quantity be a number', () => {
    // `2.500` is not representable as a binary double, and `invoke` serialises
    // through JSON, where a number IS a double. A `number` here would be a
    // silent precision loss that no type checker and no test at the far end
    // could catch, because 2.5 does happen to survive.
    const payload = toStockBalanceSyncPayload(balance(), 0, options);

    expect(typeof payload.onHand).toBe('string');
    expect(typeof payload.reserved).toBe('string');
    expect(JSON.stringify(payload)).toContain('"onHand":"2.500"');
    expect(JSON.stringify(payload)).not.toContain('"onHand":2.5');
  });

  it('survives JSON round-trip without losing the trailing zero', () => {
    // The trailing zeros are what make `2.500` and `2.5` the same string. If
    // this round-trip ever drops them, the row that reaches SQLite depends on
    // which server deployment produced it.
    const payload = toStockBalanceSyncPayload(balance(), 0, options);
    const revived = JSON.parse(JSON.stringify(payload)) as typeof payload;

    expect(revived.onHand).toBe('2.500');
    expect(revived.reserved).toBe('0.250');
  });

  it('normalises a second spelling rather than passing it through', () => {
    // The server may send `2.50` or `2.5`; both mean 2.5. Re-rendering means
    // what is stored cannot depend on which one this deployment emitted.
    expect(toStockBalanceSyncPayload(balance({ on_hand: '2.5' }), 0, options).onHand).toBe('2.500');
    expect(toStockBalanceSyncPayload(balance({ on_hand: '2.50' }), 0, options).onHand).toBe(
      '2.500',
    );
  });

  it('passes a negative balance through as a negative quantity', () => {
    // An offline terminal that oversold must be able to RECORD that, not be
    // refused — the oversell is the fact an operator needs to see.
    const payload = toStockBalanceSyncPayload(balance({ on_hand: '-1.500' }), 0, options);
    expect(payload.onHand).toBe('-1.500');
  });

  it('records the terminal clock separately from the server clock', () => {
    // The two clocks routinely disagree on a till whose network just came back,
    // and ageing stale stock on screen needs the terminal's own reading.
    const payload = toStockBalanceSyncPayload(balance(), 0, options);

    expect(payload.updatedAt).toBe(UPDATED_AT);
    expect(payload.syncedAt).toBe(SYNCED_AT);
    expect(payload.updatedAt).not.toBe(payload.syncedAt);
  });

  it('is frozen, so a payload cannot be edited after mapping', () => {
    const payload = toStockBalanceSyncPayload(balance(), 0, options);
    expect(Object.isFrozen(payload)).toBe(true);
  });
});

describe('stockBalanceSync — what it refuses, and how it says so', () => {
  it('rejects a balance belonging to another branch', () => {
    // Writing it would file one branch's stock under another's shelf, and the
    // sell path would then answer a question about the wrong shelf.
    expect(() =>
      toStockBalanceSyncPayload(balance({ branch_id: OTHER_BRANCH }), 3, options),
    ).toThrow(StockBalanceSyncError);

    try {
      toStockBalanceSyncPayload(balance({ branch_id: OTHER_BRANCH }), 3, options);
      throw new Error('expected a rejection');
    } catch (error) {
      const err = error as StockBalanceSyncError;
      expect(err.index).toBe(3);
      expect(err.field).toBe('branchId');
      expect(err.message).toContain('balances[3].branchId');
    }
  });

  it('names the row and the field when a quantity is malformed', () => {
    // A snapshot of a whole branch's inventory can be hundreds of rows. "Invalid
    // quantity" with no index is a log line nobody can act on.
    try {
      toStockBalanceSyncPayload(balance({ on_hand: '2.5001' }), 11, options);
      throw new Error('expected a rejection');
    } catch (error) {
      const err = error as StockBalanceSyncError;
      expect(err.index).toBe(11);
      expect(err.field).toBe('onHand');
      expect(err.message).toContain('balances[11].onHand');
      expect(err.message).toContain('2.5001');
    }
  });

  it('rejects a fourth fraction digit rather than truncating it', () => {
    expect(() => toStockBalanceSyncPayload(balance({ on_hand: '2.5001' }), 0, options)).toThrow(
      /three/,
    );
  });

  it('rejects a second spelling of a value, with a message naming the fix', () => {
    // The rejection a caller is most likely to hit by accident is a leading zero
    // from a zero-padded formatter, so that message says what to send instead.
    expect(() => toStockBalanceSyncPayload(balance({ on_hand: '02.500' }), 0, options)).toThrow(
      /leading zero/,
    );
    expect(() => toStockBalanceSyncPayload(balance({ reserved: '-0.000' }), 0, options)).toThrow(
      /negative zero/,
    );
  });

  it('rejects a JSON number where the contract promises a string', () => {
    // Even an "innocent" 2.5: the contract says string, and a number arriving
    // means something upstream already lost the exact spelling.
    expect(() =>
      toStockBalanceSyncPayload(balance({ on_hand: 2.5 as unknown as string }), 0, options),
    ).toThrow(/STRING/);
  });

  it('rejects a negative optimistic-concurrency version', () => {
    // The local UPSERT compares `version` to decide which snapshot is newer, so a
    // nonsensical one has to fail here rather than silently never win.
    expect(() =>
      toStockBalanceSyncPayload(balance({ version: -1 }), 0, options),
    ).toThrow(StockBalanceSyncError);
  });

  it('rejects an empty terminal timestamp', () => {
    expect(() =>
      toStockBalanceSyncPayload(balance(), 0, { branchId: BRANCH, syncedAt: '  ' }),
    ).toThrow(/syncedAt/);
  });
});

describe('stockBalanceSync — mapping a whole snapshot', () => {
  it('maps every row and keeps the order the server sent', () => {
    const snapshot = [
      balance({ inventory_item_id: FLOUR, on_hand: '2.500' }),
      balance({ inventory_item_id: MILK, on_hand: '1.000', reserved: '0.000' }),
    ];

    const { payloads } = toStockBalanceSyncPayloads(snapshot, options);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.inventoryItemId).toBe(FLOUR);
    expect(payloads[1]?.inventoryItemId).toBe(MILK);
  });

  it('is all-or-nothing rather than skipping a bad row', () => {
    // The opposite of `catalog/domain/catalog.ts`, deliberately. A skipped price
    // leaves a visibly short menu; a skipped BALANCE leaves the terminal
    // reporting a stale number with nothing on screen to say so, and the cashier
    // sells stock the shop does not have.
    const snapshot = [
      balance({ inventory_item_id: FLOUR }),
      balance({ inventory_item_id: MILK, on_hand: 'not-a-number' }),
    ];

    expect(() => toStockBalanceSyncPayloads(snapshot, options)).toThrow(StockBalanceSyncError);
    try {
      toStockBalanceSyncPayloads(snapshot, options);
      throw new Error('expected a rejection');
    } catch (error) {
      // The message must point at the SECOND row, so an operator can find it.
      expect((error as StockBalanceSyncError).message).toContain('balances[1]');
    }
  });

  it('derives the next cursor from the newest row it received', () => {
    // Deliberately replay-biased: a cursor that replays a delta is harmless,
    // because the local UPSERT is idempotent, whereas one that SKIPS leaves
    // stock silently stale. `max` is the safe direction to be wrong in.
    const snapshot = [
      balance({ updated_at: '2026-10-05T08:00:00Z' }),
      balance({ updated_at: '2026-10-05T08:59:00Z' }),
      balance({ updated_at: '2026-10-05T08:30:00Z' }),
    ];

    expect(toStockBalanceSyncPayloads(snapshot, options).cursor).toBe('2026-10-05T08:59:00Z');
  });

  it('accepts an empty snapshot, because a branch may track nothing yet', () => {
    const { payloads, cursor } = toStockBalanceSyncPayloads([], options);

    expect(payloads).toEqual([]);
    // No cursor is better than a wrong one: the next pull stays a full pull.
    expect(cursor).toBe('');
  });

  it('rejects a whole snapshot that mixes two branches', () => {
    const snapshot = [
      balance({ inventory_item_id: FLOUR }),
      balance({ inventory_item_id: MILK, branch_id: OTHER_BRANCH }),
    ];

    expect(() => toStockBalanceSyncPayloads(snapshot, options)).toThrow(
      /balances\[1\]\.branchId/,
    );
  });

  it('is frozen, so a snapshot payload cannot be edited after mapping', () => {
    const { payloads } = toStockBalanceSyncPayloads([balance()], options);
    expect(Object.isFrozen(payloads)).toBe(true);
  });
});