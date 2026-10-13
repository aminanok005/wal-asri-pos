import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { readStockRequiresReconcile } from './stockRequiresReconcile';

/**
 * readStockRequiresReconcile tests.
 *
 * LAYER: domain. Pure — no Tauri, no React. The claim under test is narrow and
 * load-bearing: a checkout can be refused with `code: "stock_requires_reconcile"`
 * and the screen must read the locked item ids off `details`, and must NOT
 * mistake any other error for that signal.
 */
describe('readStockRequiresReconcile', () => {
  it('reads item ids from a top-level details object', () => {
    const error = {
      code: 'stock_requires_reconcile',
      message: 'stock requires reconcile',
      details: { inventoryItemIds: ['item-a', 'item-b'] },
    };
    expect(readStockRequiresReconcile(error)).toEqual({
      inventoryItemIds: ['item-a', 'item-b'],
    });
  });

  it('reads item ids when details is nested under error', () => {
    const error = {
      code: 'stock_requires_reconcile',
      error: { details: { inventoryItemIds: ['item-x'] } },
    };
    expect(readStockRequiresReconcile(error)).toEqual({ inventoryItemIds: ['item-x'] });
  });

  it('returns the signal with an empty list when details has no ids', () => {
    const error = { code: 'stock_requires_reconcile', details: {} };
    expect(readStockRequiresReconcile(error)).toEqual({ inventoryItemIds: [] });
  });

  it('returns null for a different code — never a false "locked stock"', () => {
    const error = { code: 'validation', details: { inventoryItemIds: ['item-a'] } };
    expect(readStockRequiresReconcile(error)).toBeNull();
  });

  it('returns null for the existing CommandError.kind shape', () => {
    const error = { kind: 'storage', message: 'db locked' };
    expect(readStockRequiresReconcile(error)).toBeNull();
  });

  it('returns null for a non-object error', () => {
    expect(readStockRequiresReconcile('boom')).toBeNull();
    expect(readStockRequiresReconcile(null)).toBeNull();
    expect(readStockRequiresReconcile(undefined)).toBeNull();
  });
});
