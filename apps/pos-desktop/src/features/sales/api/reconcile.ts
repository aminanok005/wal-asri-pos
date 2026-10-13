import { invoke } from '@tauri-apps/api/core';

/**
 * The reconcile API layer — the ONE place in the sales feature that calls the
 * two stock-conflict Tauri commands.
 *
 * LAYER: infrastructure/edge. This module imports `@tauri-apps/api` and is the
 * only reconcile caller allowed to; every layer above it (the hook, the
 * overlay, the screen) sees these functions and their types, never `invoke`.
 *
 * ── WHY MILLI IS A `number` HERE, NOT A `bigint` OR A STRING ────────────────
 * `invoke` serialises through JSON, and a JSON number is a double. A `bigint`
 * is NOT JSON-serialisable — `JSON.stringify(1n)` throws — so a `bigint`
 * cannot cross this bridge at all, and a decimal `string` is refused by the
 * Rust side, which reads these fields as `i64`. The contract therefore carries
 * every quantity as a plain integer `number` of milli-units, and that is what
 * every type below declares. Conversion from a human's decimal happens once,
 * in `../domain/milliUnits`, never here.
 *
 * ── WHY THE ERROR MAPPING READS A `code` BEFORE A `kind` ────────────────────
 * Today the registered commands reject with the `CommandError` shape from
 * `commands.rs`: `{ kind, message }`, where `kind` is a camelCase
 * `CommandErrorKind` (`invalidPayload` | `storage` | `worker`). Lane 1 is
 * adding `code?: string` and `details?: object` so the reconcile commands can
 * name their rejections precisely (`stock_balance_not_found`,
 * `stock_requires_reconcile` with `details.inventoryItemIds`, `validation`
 * with `details.field`). A frontend that pattern-matched on the human `message`
 * would break the day either side reworded a sentence — the `CommandError` doc
 * comment warns against exactly that — so this reads the stable discriminators
 * only and NEVER a substring of the prose. `code` wins when present, else the
 * existing `kind`, else a safe generic line.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (all milli quantities are integer `number`s — see the file header)
// ─────────────────────────────────────────────────────────────────────────────

export interface StockConflict {
  readonly inventoryItemId: string;
  readonly branchId: string;
  readonly localQuantityMilli: number;
  /** `null` when the cloud has never reported a figure for this item. */
  readonly cloudQuantityMilli: number | null;
  readonly requiresReconcile: boolean;
  readonly updatedAt: string;
}

export interface ResolveConflictArgs {
  readonly inventoryItemId: string;
  readonly branchId: string;
  readonly resolvedQuantityMilli: number;
  readonly reason: string;
  readonly actorTerminalId?: string | undefined;
}

export interface ResolveConflictResult {
  readonly inventoryItemId: string;
  readonly branchId: string;
  readonly oldQuantityMilli: number;
  readonly newQuantityMilli: number;
  readonly requiresReconcile: boolean;
  readonly updatedAt: string;
  readonly auditLogId: string;
}

/**
 * A command failure, carrying a Thai message the cashier can act on. Thrown by
 * both functions below so callers branch on one type. `code` is the stable
 * discriminator (Lane 1's `code`, else the existing `kind`) and is exposed so
 * a screen can react to `stock_requires_reconcile` specifically;
 * `inventoryItemIds` is present only for that code, taken from
 * `details.inventoryItemIds`.
 */
export class ReconcileError extends Error {
  readonly code: string;
  readonly inventoryItemIds: readonly string[];

  constructor(code: string, message: string, inventoryItemIds: readonly string[] = []) {
    super(message);
    this.name = 'ReconcileError';
    this.code = code;
    this.inventoryItemIds = inventoryItemIds;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error extraction — `unknown` in, stable discriminator out. No `any`.
// ─────────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArrayField(record: Record<string, unknown> | null, key: string): readonly string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Pull `details` (Lane 1's optional error detail object) off an error. Tauri
 * versions nest the serialized command error differently, so this also looks
 * one level down under `error` / `payload`.
 */
function detailsOf(record: Record<string, unknown> | null): Record<string, unknown> | null {
  const direct = asRecord(record?.details);
  if (direct) return direct;
  const nested = asRecord(record?.error) ?? asRecord(record?.payload);
  return asRecord(nested?.details);
}

/** The stable machine discriminator on a rejected `invoke`. */
function discriminatorOf(error: unknown): string | null {
  if (typeof error === 'string') return error;
  const record = asRecord(error);
  if (!record) return null;
  // Lane 1's reconcile `code` wins over the existing `CommandError.kind`.
  return stringField(record, 'code') ?? stringField(record, 'kind') ?? null;
}

/**
 * A Tauri error thrown because the command is not in `invoke_handler`. Read as
 * a stable signal, not by matching prose: the runtime names the missing
 * command in the message, and this checks for that name only.
 */
function isCommandNotRegistered(error: unknown, command: string): boolean {
  if (typeof error === 'string') return error.includes(command);
  const record = asRecord(error);
  if (!record) return false;
  const message = stringField(record, 'message') ?? stringField(record, 'error');
  return typeof message === 'string' && message.includes(command);
}

/** The Thai message a cashier reads for a known code/kind. */
function messageForCode(code: string): string {
  switch (code) {
    // ── Lane 1 reconcile `code` values ──
    case 'stock_balance_not_found':
      return 'ไม่พบรายการสต็อกในระบบ กรุณาแจ้งผู้จัดการตรวจสอบ';
    case 'stock_requires_reconcile':
      return 'สต็อกรายการนี้ต้องกระทบยอดก่อน จึงจะขายต่อได้ กรุณาแจ้งผู้จัดการดำเนินการ';
    case 'validation':
    case 'validation_error':
      return 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบปริมาณและเหตุผลที่กรอก';
    // ── Existing `CommandError.kind` values (camelCase, see commands.rs) ──
    case 'invalidPayload':
      return 'ข้อมูลที่ส่งไม่ถูกต้อง กรุณาตรวจสอบปริมาณและเหตุผลที่กรอก';
    case 'storage':
      return 'บันทึกไม่สำเร็จ เนื่องจากฐานข้อมูลขัดข้อง กรุณาลองอีกครั้ง';
    case 'worker':
      return 'ระบบยังประมวลผลไม่เสร็จ กรุณารอสักครู่แล้วลองใหม่';
    default:
      return 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ กรุณาแจ้งผู้จัดการ';
  }
}

/** Build the `ReconcileError` the callers throw, from any rejected `invoke`. */
function toReconcileError(error: unknown, command: string): ReconcileError {
  if (isCommandNotRegistered(error, command)) {
    // Lane 1's commands are not registered yet (Plan 1.3 in flight). The
    // honest answer is "not ready", never a fabricated balance.
    return new ReconcileError(
      'command_not_registered',
      'ระบบกระทบยอดยังไม่พร้อมใช้งาน กรุณาแจ้งผู้จัดการ',
    );
  }
  const record = asRecord(error);
  const code = discriminatorOf(error) ?? 'unknown';
  const details = detailsOf(record);
  const inventoryItemIds =
    code === 'stock_requires_reconcile' ? stringArrayField(details, 'inventoryItemIds') : [];
  return new ReconcileError(code, messageForCode(code), inventoryItemIds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes (JSON numbers) → domain types
// ─────────────────────────────────────────────────────────────────────────────

function toStockConflict(raw: unknown, index: number): StockConflict {
  const record = asRecord(raw);
  const label = `list_stock_conflicts[${index}]`;
  if (!record) throw new ReconcileError('validation', `รูปแบบข้อมูลไม่ถูกต้อง: ${label}`);

  const inventoryItemId = stringField(record, 'inventoryItemId');
  const branchId = stringField(record, 'branchId');
  if (!inventoryItemId || !branchId) {
    throw new ReconcileError('validation', `ข้อมูลสต็อกไม่ครบถ้วน: ${label}`);
  }

  const localQuantityMilli = record.localQuantityMilli;
  if (typeof localQuantityMilli !== 'number' || !Number.isInteger(localQuantityMilli)) {
    throw new ReconcileError('validation', `ปริมาณหน้าร้านไม่ถูกต้อง: ${label}`);
  }

  const cloudRaw = record.cloudQuantityMilli;
  // `null`/`undefined` both mean "the cloud has no figure" — never guessed.
  let cloudQuantityMilli: number | null = null;
  if (cloudRaw !== null && cloudRaw !== undefined) {
    if (typeof cloudRaw !== 'number' || !Number.isInteger(cloudRaw)) {
      throw new ReconcileError('validation', `ปริมาณคลาวด์ไม่ถูกต้อง: ${label}`);
    }
    cloudQuantityMilli = cloudRaw;
  }

  return Object.freeze({
    inventoryItemId,
    branchId,
    localQuantityMilli,
    cloudQuantityMilli,
    requiresReconcile: record.requiresReconcile === true,
    updatedAt: stringField(record, 'updatedAt') ?? '',
  });
}

function toResolveResult(raw: unknown): ResolveConflictResult {
  const record = asRecord(raw);
  if (!record) throw new ReconcileError('validation', 'รูปแบบผลลัพธ์ไม่ถูกต้อง');
  const inventoryItemId = stringField(record, 'inventoryItemId') ?? '';
  const branchId = stringField(record, 'branchId') ?? '';
  const oldQuantityMilli = record.oldQuantityMilli;
  const newQuantityMilli = record.newQuantityMilli;
  if (typeof oldQuantityMilli !== 'number' || typeof newQuantityMilli !== 'number') {
    throw new ReconcileError('validation', 'ผลลัพธ์การกระทบยอดไม่ถูกต้อง');
  }
  return Object.freeze({
    inventoryItemId,
    branchId,
    oldQuantityMilli,
    newQuantityMilli,
    requiresReconcile: record.requiresReconcile === true,
    updatedAt: stringField(record, 'updatedAt') ?? '',
    auditLogId: stringField(record, 'auditLogId') ?? '',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch the stock conflicts awaiting reconciliation for one branch. */
export async function listStockConflicts(
  branchId: string,
): Promise<readonly StockConflict[]> {
  const command = 'list_stock_conflicts';
  try {
    const raw = await invoke<readonly unknown[]>(command, { branchId });
    if (!Array.isArray(raw)) {
      throw new ReconcileError('validation', 'รูปแบบรายการสต็อกไม่ถูกต้อง');
    }
    return Object.freeze(raw.map((item, index) => toStockConflict(item, index)));
  } catch (error: unknown) {
    if (error instanceof ReconcileError) throw error;
    throw toReconcileError(error, command);
  }
}

/**
 * Resolve one stock conflict.
 *
 * `resolvedQuantityMilli` is sent as a JSON integer `number` (the Rust side
 * reads `i64`); `actorTerminalId` is passed straight through and stays
 * `undefined` when the caller has no terminal identity — an absent actor is
 * honest, a fabricated one is not.
 */
export async function resolveStockConflict(
  args: ResolveConflictArgs,
): Promise<ResolveConflictResult> {
  const command = 'resolve_stock_conflict';
  try {
    const raw = await invoke<unknown>(command, {
      args: {
        inventoryItemId: args.inventoryItemId,
        branchId: args.branchId,
        resolvedQuantityMilli: args.resolvedQuantityMilli,
        reason: args.reason,
        actorTerminalId: args.actorTerminalId,
      },
    });
    return toResolveResult(raw);
  } catch (error: unknown) {
    if (error instanceof ReconcileError) throw error;
    throw toReconcileError(error, command);
  }
}
