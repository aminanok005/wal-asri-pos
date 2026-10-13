import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ReconciliationOverlay } from './ReconciliationOverlay';
import { StockConflictAccessProvider } from '../access/stockConflictAccess';
import { ReconcileError } from '../api/reconcile';
import type { StockConflict } from '../api/reconcile';

/**
 * ReconciliationOverlay tests.
 *
 * LAYER: UI. The claims under test are the ones that protect a stock balance:
 * the reason is mandatory, the confirm is two steps, a null cloud figure
 * disables (never guesses) the cloud option, a failure keeps the form, and a
 * user without the permission sees NO way to submit.
 *
 * The resolve call is INJECTED (the `resolveConflict` prop) rather than mocked
 * at the module level, so success and failure can be driven without a Tauri
 * runtime and without a global `mock.module` that would leak into sibling test
 * files sharing the bun process.
 */
const CONFLICT_WITH_CLOUD: StockConflict = Object.freeze({
  inventoryItemId: 'item-a',
  branchId: 'branch-1',
  localQuantityMilli: 2500,
  cloudQuantityMilli: 2000,
  requiresReconcile: true,
  updatedAt: '2026-10-13T00:00:00Z',
});

const CONFLICT_NO_CLOUD: StockConflict = Object.freeze({
  inventoryItemId: 'item-b',
  branchId: 'branch-1',
  localQuantityMilli: 3000,
  cloudQuantityMilli: null,
  requiresReconcile: true,
  updatedAt: '2026-10-13T00:00:00Z',
});

const RESOLVE_RESULT = Object.freeze({
  inventoryItemId: 'item-a',
  branchId: 'branch-1',
  oldQuantityMilli: 2500,
  newQuantityMilli: 2000,
  requiresReconcile: false,
  updatedAt: '2026-10-13T00:00:00Z',
  auditLogId: 'audit-1',
});

interface RenderOptions {
  canResolve?: boolean;
  onResolved?: () => void;
  onClose?: () => void;
  resolveConflict?: (args: {
    inventoryItemId: string;
    branchId: string;
    resolvedQuantityMilli: number;
    reason: string;
    actorTerminalId?: string | undefined;
  }) => Promise<typeof RESOLVE_RESULT>;
}

/** Render the overlay as a manager (canResolve) by default. */
function renderOverlay(conflict: StockConflict, options: RenderOptions = {}) {
  const {
    canResolve = true,
    onResolved = () => {},
    onClose = () => {},
    resolveConflict = () => Promise.resolve(RESOLVE_RESULT),
  } = options;
  return render(
    <StockConflictAccessProvider canResolve={canResolve}>
      <ReconciliationOverlay
        isOpen
        conflict={conflict}
        actorTerminalId="terminal-1"
        onClose={onClose}
        onResolved={onResolved}
        resolveConflict={resolveConflict}
      />
    </StockConflictAccessProvider>,
  );
}

describe('ReconciliationOverlay', () => {
  beforeEach(() => {
    // no global state to reset — every test injects its own resolve double.
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the diff in units, not milli', () => {
    renderOverlay(CONFLICT_WITH_CLOUD);
    // 2500 milli renders as "2.500", 2000 as "2.000". The diff block shows
    // both; the local option repeats "2.500", so query the diff figure row.
    const figures = screen.getByText(/หน้าร้าน:/).closest('div');
    expect(figures?.textContent).toContain('2.500');
    expect(figures?.textContent).toContain('2.000');
  });

  it('requires a reason before the confirm step', () => {
    renderOverlay(CONFLICT_WITH_CLOUD);
    // Advance without a reason.
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจทานอีกครั้ง' }));
    expect(screen.getByRole('alert').textContent).toContain('เหตุผล');
    // Still on the select step — no confirm button yet.
    expect(screen.queryByRole('button', { name: 'ยืนยันบันทึก' })).toBeNull();
  });

  it('advances to a two-step confirm when the reason is filled', () => {
    renderOverlay(CONFLICT_WITH_CLOUD);
    fireEvent.change(screen.getByLabelText(/เหตุผล/), { target: { value: 'นับ physical' } });
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจทานอีกครั้ง' }));
    // Now on the confirm step.
    expect(screen.getByRole('button', { name: 'ยืนยันบันทึก' })).toBeTruthy();
  });

  it('resolves on the final confirm and announces success', async () => {
    const resolveConflict = mock(() => Promise.resolve(RESOLVE_RESULT));
    const onResolved = mock(() => {});
    renderOverlay(CONFLICT_WITH_CLOUD, { onResolved, resolveConflict });
    fireEvent.change(screen.getByLabelText(/เหตุผล/), { target: { value: 'นับ physical' } });
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจทานอีกครั้ง' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันบันทึก' }));

    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    // The value sent is the chosen local figure, as an integer milli number.
    const args = (resolveConflict.mock.calls[0] as unknown as [{ resolvedQuantityMilli: number }])[0];
    expect(args.resolvedQuantityMilli).toBe(2500);
    expect(typeof args.resolvedQuantityMilli).toBe('number');
  });

  it('disables the cloud option and explains it when cloudQuantityMilli is null', () => {
    renderOverlay(CONFLICT_NO_CLOUD);
    const cloudRadio = screen.getByRole('radio', { name: /ใช้ค่าจากคลาวด์/ });
    expect((cloudRadio as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/ยังไม่มีค่าจากคลาวด์/)).toBeTruthy();
  });

  it('converts a custom unit input to integer milli with Math.round', async () => {
    const resolveConflict = mock(() => Promise.resolve(RESOLVE_RESULT));
    renderOverlay(CONFLICT_WITH_CLOUD, { resolveConflict });
    fireEvent.click(screen.getByRole('radio', { name: /ระบุค่าด้วยตนเอง/ }));
    fireEvent.change(screen.getByLabelText(/ปริมาณใหม่/), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText(/เหตุผล/), { target: { value: 'นับ' } });
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจทานอีกครั้ง' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันบันทึก' }));

    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    const args = (resolveConflict.mock.calls[0] as unknown as [{ resolvedQuantityMilli: number }])[0];
    expect(args.resolvedQuantityMilli).toBe(2500);
  });

  it('rejects an invalid custom quantity and does not advance', () => {
    renderOverlay(CONFLICT_WITH_CLOUD);
    fireEvent.click(screen.getByRole('radio', { name: /ระบุค่าด้วยตนเอง/ }));
    fireEvent.change(screen.getByLabelText(/ปริมาณใหม่/), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText(/เหตุผล/), { target: { value: 'นับ' } });
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจทานอีกครั้ง' }));
    expect(screen.getByRole('alert').textContent).toContain('ติดลบ');
    expect(screen.queryByRole('button', { name: 'ยืนยันบันทึก' })).toBeNull();
  });

  it('keeps the form and does NOT close when the resolve fails', async () => {
    const resolveConflict = mock(() =>
      Promise.reject(
        new ReconcileError('stock_requires_reconcile', 'สต็อกรายการนี้ต้องกระทบยอดก่อน'),
      ),
    );
    const onClose = mock(() => {});
    renderOverlay(CONFLICT_WITH_CLOUD, { onClose, resolveConflict });
    fireEvent.change(screen.getByLabelText(/เหตุผล/), { target: { value: 'นับ physical' } });
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจทานอีกครั้ง' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันบันทึก' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('กระทบยอดก่อน'));
    // The reason the manager typed is still shown on the confirm step — not
    // cleared — and the overlay did not close.
    expect(screen.getByText(/นับ physical/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = mock(() => {});
    renderOverlay(CONFLICT_WITH_CLOUD, { onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows NO resolve controls for a user without the permission', () => {
    renderOverlay(CONFLICT_WITH_CLOUD, { canResolve: false });
    // No advance / confirm buttons at all.
    expect(screen.queryByRole('button', { name: 'ตรวจทานอีกครั้ง' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ยืนยันบันทึก' })).toBeNull();
    // The cashier is told a manager must act.
    expect(screen.getByText(/ต้องให้ผู้จัดการดำเนินการ/)).toBeTruthy();
  });
});
