import { useCallback, useEffect, useRef, useState } from 'react';

import {
  listStockConflicts,
  ReconcileError,
  type StockConflict,
} from '../../api/reconcile';

/** How often the terminal re-checks for conflicts while it is the active tab. */
const POLL_INTERVAL_MS = 30_000;

export interface UseStockConflictsResult {
  readonly conflicts: readonly StockConflict[];
  readonly loading: boolean;
  /** A Thai, cashier-readable message when the last fetch failed. */
  readonly error: string | null;
  /**
   * `true` when the backend reconcile commands are not registered yet (Lane 1,
   * Plan 1.3 in flight). The UI treats this as "feature not ready" rather than
   * an error, and shows no conflict list — it never fabricates one.
   */
  readonly unavailable: boolean;
  /** Re-run the fetch now (used after a successful resolve). */
  readonly refresh: () => void;
}

export interface UseStockConflictsOptions {
  /**
   * The fetch to poll. Defaults to the real `listStockConflicts`; a test passes
   * a double so the poll loop can be driven without a Tauri runtime and without
   * a global module mock (which would leak across bun test files).
   */
  readonly listConflicts?: (branchId: string) => Promise<readonly StockConflict[]>;
}

/**
 * Poll the branch's stock conflicts, safely.
 *
 * ── WHY POLLING AT ALL ──────────────────────────────────────────────────────
 * A conflict is created by the sync engine writing a newer cloud snapshot over
 * local dirty movement — an event the UI does not initiate. The only way the
 * terminal learns of it is to ask, so this polls on an interval. 30s is a
 * compromise: frequent enough that a manager sees a conflict within half a
 * minute of it appearing, rare enough that an idle till is not hammering the
 * database all shift.
 *
 * ── THE THREE THINGS THAT MAKE IT SAFE ──────────────────────────────────────
 *   1. IN-FLIGHT GUARD. A `ref`, not state, so a second `refresh` during a
 *      pending request is a no-op rather than a second `invoke`. Two overlaps
 *      would race and could write a stale conflict list over a fresh one.
 *   2. VISIBILITY + OFFLINE GATE. The interval only fires a fetch when the tab
 *      is visible and `navigator.onLine` is true. A background tab that keeps
 *      polling is a battery drain that serves nobody, and an offline till
 *      cannot reach SQLite through the bridge anyway.
 *   3. CLEANUP. Both listeners and the interval are torn down on unmount and
 *      whenever `branchId` changes, so a closed screen stops polling and a
 *      branch switch never leaves the previous interval running.
 *
 * The guard also makes the visibility handler cheap: a tab that becomes
 * visible re-checks immediately, and if a fetch is already in flight it is
 * skipped rather than doubled.
 */
export function useStockConflicts(
  branchId: string,
  options: UseStockConflictsOptions = {},
): UseStockConflictsResult {
  const listConflicts = options.listConflicts ?? listStockConflicts;
  const [conflicts, setConflicts] = useState<readonly StockConflict[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<boolean>(false);

  const inFlightRef = useRef<boolean>(false);

  const fetchConflicts = useCallback(() => {
    // No branch yet (identity not loaded) — nothing to ask for. This is the
    // normal first render on a till that resolves its identity async.
    if (branchId === '') return;
    // Guard: one request at a time. Offline/background tabs simply skip.
    if (inFlightRef.current) return;
    if (!navigator.onLine) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    inFlightRef.current = true;
    void listConflicts(branchId)
      .then((data) => {
        setConflicts(data);
        setError(null);
        setUnavailable(false);
      })
      .catch((cause: unknown) => {
        setConflicts([]);
        if (cause instanceof ReconcileError && cause.code === 'command_not_registered') {
          // Feature not ready — not a failure the cashier caused.
          setUnavailable(true);
          setError(null);
        } else {
          setUnavailable(false);
          setError(cause instanceof Error ? cause.message : 'โหลดรายการกระทบยอดไม่สำเร็จ');
        }
      })
      .finally(() => {
        setLoading(false);
        inFlightRef.current = false;
      });
  }, [branchId, listConflicts]);

  useEffect(() => {
    // Initial fetch on mount and on every branchId change.
    fetchConflicts();

    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchConflicts();
    };
    const onOnline = () => fetchConflicts();

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    const interval = setInterval(() => {
      // The interval's own gates live in `fetchConflicts`, so a hidden or
      // offline tab is skipped there and here alike.
      if (document.visibilityState === 'visible' && navigator.onLine) fetchConflicts();
    }, POLL_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      clearInterval(interval);
    };
  }, [fetchConflicts]);

  return { conflicts, loading, error, unavailable, refresh: fetchConflicts };
}
