/**
 * Tests for the stock-balance INVOKE edge.
 *
 * The load-bearing constraint, mirrored from `tauriOfflineOrders.test.ts`:
 * `invoke` is never called here. The function under test is the pure result
 * validator, because a mock of `invoke` would only prove the mock works. The
 * payload half of this wire is tested in `stockBalanceSync.test.ts` (what
 * crosses), and the disk half in `test/migrations.test.ts` plus Rust's
 * `stock_balances.rs` tests (what lands).
 *
 * The RESULT is what this file owns: `invoke<T>` asserts rather than checks, so
 * these tests pin the only place the shape of the native answer is looked at.
 */

import { describe, expect, test } from 'bun:test';

import {
  StockBalanceWriteError,
  writeSummaryFromWire,
} from './tauriStockBalances';

describe('writeSummaryFromWire', () => {
  test('accepts the shape `StockBalanceWriteResult` serialises to', () => {
    const summary = writeSummaryFromWire({ inserted: 3, updated: 17 });

    expect(summary).toEqual({ inserted: 3, updated: 17 });
  });

  test('accepts zero counts — an empty pull is a legitimate no-op', () => {
    expect(writeSummaryFromWire({ inserted: 0, updated: 0 })).toEqual({
      inserted: 0,
      updated: 0,
    });
  });

  test('freezes the summary so a caller cannot edit what the command said', () => {
    const summary = writeSummaryFromWire({ inserted: 1, updated: 2 });
    expect(Object.isFrozen(summary)).toBe(true);
  });

  // ── The negative shape assertions ──────────────────────────────────────────
  // Each of these is "the thing on the other end of the bridge is not the
  // command this build expects", and each must fail loudly rather than reach a
  // sync report as a wrong figure.

  test.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'inserted: 1'],
    ['a number', 42],
  ])('rejects %s instead of an object', (_label, raw) => {
    expect(() => writeSummaryFromWire(raw)).toThrow(StockBalanceWriteError);
  });

  test.each([
    ['inserted', { updated: 1 }],
    ['updated', { inserted: 1 }],
  ])('rejects a missing `%s` count', (field, raw) => {
    expect(() => writeSummaryFromWire(raw)).toThrow(
      new RegExp(`\`${field}\``),
    );
  });

  test('rejects a float count — a quantity must never drift into a row count', () => {
    // 1.5 is the shape `0.1 + 0.2` arithmetic produces. Row counts are usize;
    // a fractional one means the bridge delivered something other than this
    // command's answer.
    expect(() => writeSummaryFromWire({ inserted: 1.5, updated: 0 })).toThrow(
      StockBalanceWriteError,
    );
  });

  test('rejects a negative count', () => {
    // `-1` is what a subtracted-instead-of-added tally looks like. It is not a
    // row count and must not be summed into one.
    expect(() => writeSummaryFromWire({ inserted: -1, updated: 0 })).toThrow(
      StockBalanceWriteError,
    );
  });

  test('rejects NaN', () => {
    expect(() => writeSummaryFromWire({ inserted: NaN, updated: 0 })).toThrow(
      StockBalanceWriteError,
    );
  });

  test('rejects a count past 2^53 − 1', () => {
    // Not a plausible row count — which is the point: if one ever arrives, the
    // value was a JSON number that already lost precision, exactly the failure
    // the string rule exists to prevent elsewhere on this wire.
    expect(() =>
      writeSummaryFromWire({ inserted: 2 ** 53, updated: 0 }),
    ).toThrow(StockBalanceWriteError);
  });

  test('the error names the broken field, not just the shape', () => {
    // A caller debugging a rejected summary needs to know which half is wrong
    // without reading this file.
    expect(() =>
      writeSummaryFromWire({ inserted: 1, updated: 'two' }),
    ).toThrow(/`updated`/);
  });

  test('a rejection is a StockBalanceWriteError, not a StockBalanceSyncError', () => {
    // The sync error's message is shaped `balances[i].field: reason` for a row
    // being MAPPED. Nothing here has a row; conflating the two would make a
    // result-shape failure read like a snapshot the mapping edge should have
    // caught — before the write it describes.
    try {
      writeSummaryFromWire(null);
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StockBalanceWriteError);
      expect((error as Error).name).toBe('StockBalanceWriteError');
    }
  });
});
