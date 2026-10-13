/**
 * stockRequiresReconcile — reading the "this sale hit a locked stock item"
 * signal off a rejected checkout.
 *
 * LAYER: domain. Pure TypeScript, zero imports. It exists because a checkout
 * can fail for a reason that is NOT the cashier's fault and NOT a generic
 * error: Lane 1's `save_offline_order` rejects with `code:
 * "stock_requires_reconcile"` and `details.inventoryItemIds` naming the locked
 * items, when the basket contains stock whose local balance is flagged
 * `requires_reconcile`. The screen must answer that with "these items are
 * locked, tell a manager" rather than "บันทึกไม่สำเร็จ: <prose>".
 *
 * ── WHY IT READS `code` AND NEVER THE MESSAGE ───────────────────────────────
 * The `CommandError` doc comment in commands.rs warns explicitly against
 * pattern-matching on prose, because the prose is reworded freely while the
 * `code` is a stable discriminator. So this reads `code` (and Lane 1's optional
 * `details`) only. An error that carries no `code` yields `null` — the caller
 * then treats it as an ordinary failure, never a false "locked stock".
 *
 * ── WHY A DISCRIMINATED RESULT, NOT A THROWN ERROR ──────────────────────────
 * This runs inside the checkout `catch`, where throwing would replace the real
 * failure with a new one. It returns a plain result the screen branches on.
 */
export interface StockRequiresReconcileSignal {
  readonly inventoryItemIds: readonly string[];
}

/**
 * If `error` is a `stock_requires_reconcile` rejection, return the locked item
 * ids from `details.inventoryItemIds`; otherwise `null`.
 */
export function readStockRequiresReconcile(
  error: unknown,
): StockRequiresReconcileSignal | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;

  const code = typeof record.code === 'string' ? record.code : null;
  if (code !== 'stock_requires_reconcile') return null;

  // `details` may sit at the top level or one level down under `error`/`payload`
  // depending on the Tauri version's serialization.
  const details =
    (typeof record.details === 'object' && record.details !== null
      ? (record.details as Record<string, unknown>)
      : null) ??
    (typeof record.error === 'object' && record.error !== null
      ? ((record.error as Record<string, unknown>).details as Record<string, unknown> | undefined) ?? null
      : null);

  const raw = details?.inventoryItemIds;
  const inventoryItemIds = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return { inventoryItemIds };
}
