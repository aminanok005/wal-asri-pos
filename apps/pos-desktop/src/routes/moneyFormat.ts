/**
 * Baht formatting shared by more than one route.
 *
 * WHY THIS FILE EXISTS ───────────────────────────────────────────────────────
 * `formatAdjustment` started life inside `SalesTerminalView`, because the
 * checkout screen was its only caller. The offline history screen then needed
 * the SAME rendering for the same field, and importing it from
 * `SalesTerminalView` would have been the obvious move — and wrong: that module
 * pulls in the payment method selector, the printer port and the Tauri
 * endpoint defaults, so the history screen's module graph would have grown to
 * include the whole checkout route in order to render one string.
 *
 * So the pure functions live here, and `SalesTerminalView` re-exports them.
 * Its existing importers are untouched: `formatAdjustment` and
 * `roundingRowText` still resolve from the same place they always did, and the
 * tests that import them from the checkout route keep passing.
 *
 * Everything is `bigint` in and `string` out — never a `number`. These values
 * are satang, and a float here would reintroduce exactly the rounding this code
 * exists to get right.
 */

/**
 * A signed satang amount as the cashier reads it: `-฿0.03`, `+฿3.00`, `฿0.00`.
 *
 * Zero gets no sign on purpose. `+฿0.00` on a sale that was not rounded at all
 * is noise, and noise is what makes staff stop reading the row where a real
 * adjustment appears.
 *
 * The sign is OUTSIDE the baht symbol, matching how the amount is spoken
 * ("ลบสามสตางค์" / minus three satang). Rendering `฿-0.03` instead would put the
 * sign inside the currency, which no Thai till printer does.
 */
export function formatAdjustment(satang: bigint): string {
  if (satang === 0n) return '฿0.00';
  const magnitude = satang < 0n ? -satang : satang;
  const whole = magnitude / 100n;
  const frac = (magnitude % 100n).toString().padStart(2, '0');
  return satang < 0n ? `-฿${whole}.${frac}` : `+฿${whole}.${frac}`;
}

/** The whole rounding line, as the cashier reads it. `payable` is "45.50". */
export function roundingRowText(adjustment: bigint, payable: string): string {
  return `ปัดเศษ ${formatAdjustment(adjustment)} → ฿${payable}`;
}
