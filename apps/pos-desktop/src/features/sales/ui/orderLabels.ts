/**
 * The Thai wording for an order's two ladders, shared by every screen that shows
 * one.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * `THAI_STATUS_LABELS` and `THAI_SYNC_LABELS` lived in
 * `routes/OfflineOrdersView.tsx`, because the history screen was the only thing
 * that showed an order. Then `RecentOrdersStrip` needed the same two maps to
 * render the same two badges on the sales screen — and importing them from
 * `routes/` would have made a UI component depend on a ROUTE, which inverts the
 * layering this repo spends `layers.test.ts` enforcing. A view importing another
 * view's module is how two components end up each holding their own copy of the
 * same map, and then a renamed status renders correctly on one screen and blank
 * on the other.
 *
 * So the maps live beside the components that use them, and
 * `OfflineOrdersView` re-exports them unchanged. Every existing importer of
 * either name keeps working, and `OfflineOrdersView.test.tsx` — which iterates
 * both maps to prove no rung is left unlabelled — still exercises them from the
 * same path.
 *
 * LAYER: ui. Pure data and nothing else — no React, no Tauri, no domain imports
 * beyond the port's own types. `layers.test.ts` scans `ui/*.ts*` for `@tauri-apps`,
 * `fetch(`, `escpos` and `serialport`; a map of strings is clean under all four.
 *
 * ── BOTH MAPS ARE EXHAUSTIVE BY TYPE, AND THAT IS THE POINT ─────────────────
 *
 * `Record<OfflineOrderStatus, string>` makes a missing rung a COMPILE error on
 * every screen that might mention it. That matters because a missing rung is not
 * a blank cell: indexing an object with an absent key yields `undefined`, and
 * React renders `undefined` as nothing at all. A status nobody labelled would
 * show as an empty chip in a row whose receipt number, total and line count are
 * all perfectly legible — the one field a cashier needs to be missing, and
 * missing silently.
 *
 * The two maps answer DIFFERENT questions and are reconciled separately:
 * "เสิร์ฟแล้ว รอซิงก์" is a perfectly healthy order, while
 * "เสิร์ฟแล้ว ข้อมูลขัดแย้ง" is the one a shift lead has to phone the back
 * office about. Collapsing them into one badge would hide exactly that.
 *
 * @see ../application/offlineOrders.ts — the unions these ladders mirror
 */

import type { OfflineOrderStatus, SyncState } from '../application/offlineOrders';

/** Thai wording for each `OfflineOrderStatus`, for the person reading the till. */
export const THAI_STATUS_LABELS: Readonly<Record<OfflineOrderStatus, string>> = {
  draft: 'ร่าง',
  submitted: 'ส่งออเดอร์แล้ว',
  in_preparation: 'กำลังเตรียมสินค้า',
  ready: 'พร้อมเสิร์ฟ',
  served: 'เสิร์ฟแล้ว',
  completed: 'ปิดรายการ',
  void_requested: 'ขอยกเลิกออเดอร์',
  voided: 'ยกเลิกออเดอร์แล้ว',
};

/** Thai wording for each `SyncState`. */
export const THAI_SYNC_LABELS: Readonly<Record<SyncState, string>> = {
  pending: 'รอซิงก์',
  synced: 'ซิงก์แล้ว',
  conflict: 'ข้อมูลขัดแย้ง',
  rejected: 'ถูกปฏิเสธ',
};