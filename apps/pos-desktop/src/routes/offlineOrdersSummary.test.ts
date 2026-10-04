/**
 * Unit tests for the sync tally.
 *
 * Pure function, no DOM: these need no `act()` and no repository double, which is
 * the point of keeping it out of the component.
 */

import { describe, expect, it } from 'bun:test';

import { Money } from '../features/payments/domain/money';
import type {
  OfflineOrderStatus,
  OfflineOrderSummary,
  SyncState,
} from '../features/sales/application/offlineOrders';
import { summariseSyncStates, ALL_SYNC_STATES } from './offlineOrdersSummary';
import { THAI_SYNC_LABELS } from './OfflineOrdersView';

/** One row. Only the two fields the tally reads are meaningful; the rest is shape. */
function order(
  syncState: SyncState,
  status: OfflineOrderStatus = 'completed',
  id: string = `${syncState}-${status}`,
): OfflineOrderSummary {
  return {
    id,
    localReceiptNumber: `R-${id}`,
    status,
    syncState,
    createdAt: '2026-10-02T09:00:00.000Z',
    lineCount: 2,
    total: Money.fromSatang(5250n),
    currencyCode: 'THB',
  };
}


describe('summariseSyncStates', () => {
  it('an empty page counts zero of everything, and is not an error', () => {
    const summary = summariseSyncStates([]);

    expect(summary.total).toBe(0);
    expect(summary.voided).toBe(0);
    expect(summary.bySyncState).toEqual({ pending: 0, synced: 0, conflict: 0, rejected: 0 });
  });

  it('counts every rung, including the ones that need action', () => {
    const orders = [
      order('pending'),
      order('pending'),
      order('pending'),
      order('synced'),
      order('synced'),
      order('conflict'),
      order('rejected'),
      order('rejected'),
      order('rejected'),
    ];

    const summary = summariseSyncStates(orders);

    expect(summary.bySyncState).toEqual({ pending: 3, synced: 2, conflict: 1, rejected: 3 });
    expect(summary.total).toBe(9);
  });

  it('the four buckets always sum to the number of orders loaded', () => {
    // The invariant the bar relies on: the buckets must account for every row.
    const orders = [
      ...ALL_SYNC_STATES.map((state) => order(state, 'completed', `a-${state}`)),
      ...ALL_SYNC_STATES.map((state) => order(state, 'voided', `b-${state}`)),
      order('pending', 'voided', 'c-extra'),
      order('conflict', 'in_preparation', 'd-mixed'),
    ];

    const summary = summariseSyncStates(orders);
    const summed = ALL_SYNC_STATES.reduce((total, state) => total + summary.bySyncState[state], 0);

    expect(summed).toBe(summary.total);
    expect(summed).toBe(orders.length);
  });

  it('holds the invariant across sizes that are not multiples of four', () => {
    // 0..9 rows cycling the four states: every remainder case, including sizes
    // where a bucket is empty and where the last is only partly filled.
    for (let size = 0; size <= 9; size += 1) {
      const orders = Array.from({ length: size }, (_unused, index) =>
        order(ALL_SYNC_STATES[index % 4] ?? 'pending', 'completed', `row-${index}`),
      );

      const summary = summariseSyncStates(orders);
      const summed = ALL_SYNC_STATES.reduce((total, state) => total + summary.bySyncState[state], 0);

      expect(summed).toBe(size);
    }
  });

  it('counts voided on a SEPARATE axis, without removing it from the sync buckets', () => {
    // A voided order still occupies a sync bucket; subtracting it would make the two
    // figures disagree about how many orders the terminal holds.
    const orders = [
      order('pending', 'voided', 'void-1'),
      order('rejected', 'voided', 'void-2'),
      order('synced', 'completed', 'live-1'),
    ];

    const summary = summariseSyncStates(orders);

    expect(summary.voided).toBe(2);
    expect(summary.total).toBe(3);
    expect(summary.bySyncState.pending).toBe(1);
    expect(summary.bySyncState.rejected).toBe(1);
    expect(summary.bySyncState.synced).toBe(1);
    // The buckets still account for all three rows, voided ones included.
    expect(summary.bySyncState.pending + summary.bySyncState.rejected + summary.bySyncState.synced).toBe(
      summary.total,
    );
  });

  it('a void_requested order is not voided yet', () => {
    // The two rungs are different states, and only the settled one is a void.
    const summary = summariseSyncStates([order('pending', 'void_requested')]);

    expect(summary.voided).toBe(0);
    expect(summary.bySyncState.pending).toBe(1);
  });

  it('does not mutate the array it was given', () => {
    const orders = [order('pending'), order('conflict'), order('rejected', 'voided')];
    const before = orders.slice();

    summariseSyncStates(orders);

    expect(orders).toEqual(before);
    expect(orders.length).toBe(3);
  });

  it('returns a frozen result, so a caller cannot corrupt it in flight', () => {
    const summary = summariseSyncStates([order('pending'), order('synced')]);

    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.bySyncState)).toBe(true);
  });

  it('every rung of SyncState has a bucket, so no row lands nowhere', () => {
    const orders = ALL_SYNC_STATES.map((state) => order(state, 'completed', `only-${state}`));
    const summary = summariseSyncStates(orders);

    for (const state of ALL_SYNC_STATES) {
      expect(summary.bySyncState[state]).toBe(1);
    }
    // No extra bucket: a stale one would show a count of 0 forever.
    expect(Object.keys(summary.bySyncState)).toHaveLength(ALL_SYNC_STATES.length);
  });

  it('every counted rung has a Thai label, so the bar never renders a blank tile', () => {
    // The bar maps ALL_SYNC_STATES to labels. A rung with no label would render
    // an empty `<span>` next to a count — a count a shift lead can read but
    // cannot tell what it counts.
    for (const state of ALL_SYNC_STATES) {
      expect(THAI_SYNC_LABELS[state]).toBeString();
      expect(THAI_SYNC_LABELS[state].length).toBeGreaterThan(0);
    }
  });

  it('the label map has no rung the counter does not count', () => {
    // The other direction: a label left behind for a rung `SyncState` no longer
    // has would never render, so the two lists would drift apart silently.
    expect(Object.keys(THAI_SYNC_LABELS)).toHaveLength(ALL_SYNC_STATES.length);
  });
});