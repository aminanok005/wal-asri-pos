import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { useStockConflicts } from './useStockConflicts';
import { ReconcileError } from '../../api/reconcile';
import type { StockConflict } from '../../api/reconcile';

/**
 * useStockConflicts tests.
 *
 * LAYER: UI. The claim under test is the SAFETY of the poll, not the fetch
 * itself: one request at a time, no fetch while offline or on a hidden tab, and
 * everything torn down on unmount so a closed screen stops polling.
 *
 * The fetch is INJECTED (the `listConflicts` option) rather than mocked at the
 * module level, so the poll loop can be driven deterministically without a
 * Tauri runtime and without a global `mock.module` that would leak into sibling
 * test files sharing the bun process.
 */
describe('useStockConflicts', () => {
  let listConflicts: ReturnType<typeof mock>;

  beforeEach(() => {
    listConflicts = mock((_branchId: string) => Promise.resolve([]) as Promise<readonly StockConflict[]>);
    // Default the environment to online + visible for the common cases.
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('fetches once on mount and exposes the conflicts', async () => {
    listConflicts.mockResolvedValue([
      {
        inventoryItemId: 'item-a',
        branchId: 'branch-1',
        localQuantityMilli: 2500,
        cloudQuantityMilli: null,
        requiresReconcile: true,
        updatedAt: '2026-10-13T00:00:00Z',
      },
    ] as readonly StockConflict[]);

    const { result } = renderHook(() => useStockConflicts('branch-1', { listConflicts }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conflicts).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(listConflicts).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when branchId is empty (identity not yet known)', async () => {
    renderHook(() => useStockConflicts('', { listConflicts }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(listConflicts).not.toHaveBeenCalled();
  });

  it('does not fetch while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    renderHook(() => useStockConflicts('branch-1', { listConflicts }));
    // Give the effect a tick to (not) run.
    await act(async () => {
      await Promise.resolve();
    });
    expect(listConflicts).not.toHaveBeenCalled();
  });

  it('guards in-flight: a manual refresh during a pending fetch does not double-fire', async () => {
    let resolveFetch: (value: readonly StockConflict[]) => void = () => {};
    listConflicts.mockImplementation(
      () =>
        new Promise<readonly StockConflict[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { result } = renderHook(() => useStockConflicts('branch-1', { listConflicts }));
    // First fetch is in flight. Two refresh calls must both be no-ops.
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    expect(listConflicts).toHaveBeenCalledTimes(1);

    // Let it settle so the pending promise does not leak into the next test.
    await act(async () => {
      resolveFetch([]);
      await Promise.resolve();
    });
  });

  it('stops polling after unmount (cleanup removes listeners + interval)', async () => {
    const { unmount } = renderHook(() => useStockConflicts('branch-1', { listConflicts }));
    await waitFor(() => expect(listConflicts).toHaveBeenCalledTimes(1));
    unmount();

    // Dispatch the events the listeners would have reacted to; after cleanup
    // none of them may trigger another fetch.
    const callsAfterUnmount = listConflicts.mock.calls.length;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    });
    expect(listConflicts.mock.calls.length).toBe(callsAfterUnmount);
  });

  it('surfaces an error message and empty list on failure', async () => {
    listConflicts.mockRejectedValue(new Error('โหลดไม่สำเร็จ'));
    const { result } = renderHook(() => useStockConflicts('branch-1', { listConflicts }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('โหลดไม่สำเร็จ');
    expect(result.current.conflicts).toEqual([]);
  });

  it('marks the feature unavailable (not an error) when the command is not registered', async () => {
    listConflicts.mockRejectedValue(
      new ReconcileError('command_not_registered', 'ระบบกระทบยอดยังไม่พร้อมใช้งาน'),
    );
    const { result } = renderHook(() => useStockConflicts('branch-1', { listConflicts }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.error).toBeNull();
  });
});
