/**
 * Counts of a loaded page of offline orders, for the sync summary bar.
 *
 * LAYER: route UI, pure. No React, no money: every value is a count of rows.
 */

import type { OfflineOrderSummary, SyncState } from '../features/sales/application/offlineOrders';

/**
 * Every rung of `SyncState`, in a fixed order.
 *
 * Exported rather than derived from `Object.keys` on a label map: key order is a
 * runtime property of the object, so casting the result to `SyncState[]` would
 * type-check while silently dropping a rung the labels happened not to cover.
 */
export const ALL_SYNC_STATES: readonly SyncState[] = ['pending', 'synced', 'conflict', 'rejected'];

/** A tally of one page of orders. */
export interface SyncSummary {
  readonly total: number;
  /** Partitions the rows, so its four members always sum to `total`. */
  readonly bySyncState: Readonly<Record<SyncState, number>>;
  /** Orders whose `status` is `voided`. The SAME rows again, on a second axis. */
  readonly voided: number;
}

/**
 * Tally a page of orders by delivery state.
 *
 * `voided` is NOT subtracted from `bySyncState`: a voided order still occupies a
 * sync bucket, so removing it would make the two figures disagree about how many
 * orders this terminal holds. They answer different questions, so the bar labels
 * them as separate axes.
 */
export function summariseSyncStates(orders: readonly OfflineOrderSummary[]): SyncSummary {
  // Written out in full rather than built from ALL_SYNC_STATES, so a rung added to
  // `SyncState` fails to compile here until it is counted — rather than counting
  // into a bucket nobody reads.
  const counts: Record<SyncState, number> = { pending: 0, synced: 0, conflict: 0, rejected: 0 };

  for (const order of orders) {
    counts[order.syncState] += 1;
  }

  return Object.freeze({
    total: orders.length,
    bySyncState: Object.freeze(counts),
    voided: orders.filter((order) => order.status === 'voided').length,
  });
}