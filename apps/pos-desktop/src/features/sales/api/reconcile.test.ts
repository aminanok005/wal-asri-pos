import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// The API layer is the only reconcile caller allowed to import `@tauri-apps/api`,
// so mocking `invoke` here exercises the real error-mapping path end to end.
const invokeMock = mock((_command: string, _payload?: unknown): Promise<unknown> => Promise.resolve([]));
mock.module('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

// Imported AFTER the mock is installed so the module graph picks up the stub.
const { listStockConflicts, resolveStockConflict, ReconcileError } = await import('./reconcile');
import type { ReconcileError as ReconcileErrorType } from './reconcile';

/**
 * reconcile API tests.
 *
 * LAYER: infrastructure. These assert the ERROR MAPPING — the contract between
 * a rejected `invoke` and the Thai line a cashier reads. The claim under test is
 * that the mapping reads the STABLE discriminator (`code`, then the existing
 * `kind`) and never a substring of the prose, so a reworded message cannot
 * change which Thai line appears.
 */
describe('reconcile error mapping', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it('maps list_stock_conflicts stock_requires_reconcile by code', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'stock_requires_reconcile', message: 'x' });
    await expect(listStockConflicts('branch-1')).rejects.toMatchObject({
      name: 'ReconcileError',
      code: 'stock_requires_reconcile',
    });
  });

  it('maps the existing CommandError.kind shape (storage) when no code is present', async () => {
    invokeMock.mockRejectedValueOnce({ kind: 'storage', message: 'db locked' });
    await expect(listStockConflicts('branch-1')).rejects.toMatchObject({
      code: 'storage',
    });
  });

  it('reports command-not-registered as a distinct, honest code', async () => {
    // The Tauri runtime names the missing command in the message.
    invokeMock.mockRejectedValueOnce(new Error('command list_stock_conflicts not found'));
    const error = await listStockConflicts('branch-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReconcileError);
    expect((error as ReconcileErrorType).code).toBe('command_not_registered');
  });

  it('maps validation code to validation message', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'validation', message: 'invalid qty' });
    const error = await listStockConflicts('branch-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReconcileError);
    expect((error as ReconcileErrorType).code).toBe('validation');
    expect((error as ReconcileErrorType).message).toBe('ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบปริมาณและเหตุผลที่กรอก');
  });

  it('also maps validation_error temporarily for compatibility', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'validation_error', message: 'invalid qty' });
    const error = await listStockConflicts('branch-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReconcileError);
    expect((error as ReconcileErrorType).code).toBe('validation_error');
    expect((error as ReconcileErrorType).message).toBe('ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบปริมาณและเหตุผลที่กรอก');
  });

  it('prefers code over kind when both are present', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'stock_balance_not_found',
      kind: 'storage',
      message: 'x',
    });
    const error = await listStockConflicts('branch-1').catch((e: unknown) => e);
    expect((error as ReconcileErrorType).code).toBe('stock_balance_not_found');
  });

  it('carries inventoryItemIds from details on a resolve stock_requires_reconcile', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'stock_requires_reconcile',
      details: { inventoryItemIds: ['item-a'] },
    });
    const error = await resolveStockConflict({
      inventoryItemId: 'item-a',
      branchId: 'branch-1',
      resolvedQuantityMilli: 1000,
      reason: 'counted',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReconcileError);
    expect((error as ReconcileErrorType).inventoryItemIds).toEqual(['item-a']);
  });

  it('parses a well-formed list response into number milli (never bigint)', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        inventoryItemId: 'item-a',
        branchId: 'branch-1',
        localQuantityMilli: 2500,
        cloudQuantityMilli: null,
        requiresReconcile: true,
        updatedAt: '2026-10-13T00:00:00Z',
      },
    ] as unknown);
    const conflicts = await listStockConflicts('branch-1');
    expect(conflicts[0]?.localQuantityMilli).toBe(2500);
    expect(typeof conflicts[0]?.localQuantityMilli).toBe('number');
    expect(conflicts[0]?.cloudQuantityMilli).toBeNull();
  });

  it('sends resolvedQuantityMilli as a JSON integer number', async () => {
    invokeMock.mockResolvedValueOnce({
      inventoryItemId: 'item-a',
      branchId: 'branch-1',
      oldQuantityMilli: 2500,
      newQuantityMilli: 2000,
      requiresReconcile: false,
      updatedAt: '2026-10-13T00:00:00Z',
      auditLogId: 'audit-1',
    } as unknown);
    await resolveStockConflict({
      inventoryItemId: 'item-a',
      branchId: 'branch-1',
      resolvedQuantityMilli: 2000,
      reason: 'counted',
    });
    const call = invokeMock.mock.calls[0] as unknown as [string, { args: Record<string, unknown> }];
    expect(call[1].args.resolvedQuantityMilli).toBe(2000);
    expect(typeof call[1].args.resolvedQuantityMilli).toBe('number');
  });
});
