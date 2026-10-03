/**
 * OfflineOrdersView — the history of what THIS terminal sold while offline.
 *
 * LAYER: route UI (presentation). This screen reads order history through
 * exactly one thing — the `OfflineOrdersRepository` port handed in as a prop —
 * and knows nothing about SQLCipher, `@tauri-apps/*`, `bun:sqlite` or the
 * network. That is what lets the screen be rendered under `bun test` on a
 * machine with no native runtime, which is the whole reason the port exists.
 *
 * THE REAL ADAPTER IS LATER, AND IT IS INTERCHANGEABLE
 *
 * This screen is written against `OfflineOrdersRepository` exactly as the
 * in-memory adapter in the port's own module implements it: two methods, frozen
 * results, a rejection on a bad `limit`. When the SQLCipher adapter arrives it
 * implements the same interface, so this file does not change at all — it is
 * simply handed a different object of the same shape.
 *
 * @see ../features/sales/application/offlineOrders.ts — the port and the unions
 */

import { useEffect, useState } from 'react';
import type { JSX } from 'react';

// `import type` for both of these. `verbatimModuleSyntax` is on repo-wide, and
// neither the unions nor `Money` is used as a VALUE here — a value import would
// emit a runtime require of the port module and the money module for type
// positions alone, dragging two domain files into the view's module graph for
// nothing. `formatBaht` below only ever calls a method that already exists on
// the instance it was handed.
import type {
  OfflineOrderStatus,
  OfflineOrderSummary,
  OfflineOrdersRepository,
  SyncState,
} from '../features/sales/application/offlineOrders';
import type { Money } from '../features/payments/domain/money';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface OfflineOrdersViewProps {
  /**
   * The port the history is read through. Required, and the ONLY way data
   * reaches this screen: no SQLite handle, no `invoke`, no fetch.
   */
  readonly repository: OfflineOrdersRepository;
  /**
   * How many recent orders to ask for. Defaults to 50.
   *
   * A page size rather than a scroll window, because the terminal's history is
   * bounded by one shift's worth of receipts and 50 covers a long one without
   * making the list slow to paint on the hardware these tills actually run on.
   */
  readonly limit?: number;
}

/** Rows requested when the caller names no page size. */
const DEFAULT_LIMIT = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Thai labels for the two ladders
//
// BOTH MAPS ARE EXHAUSTIVE BY TYPE, AND THAT IS THE POINT
//
// `Record<OfflineOrderStatus, string>` makes a missing rung a COMPILE error on
// the screen that is supposed to mention it. That matters because a missing rung
// is not a blank cell: indexing an object with an absent key yields
// `undefined`, and React renders `undefined` as nothing at all. A status nobody
// labelled would show as an empty span in a row whose receipt number, total and
// line count are all perfectly legible — the one field a cashier needs to be
// missing, and missing silently, in the one screen opened during a bug report.
//
// Exported so the test suite can iterate them and fail loudly when a new rung
// lands without a label, rather than waiting for the row to render blank.
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Thai wording for each `SyncState`.
 *
 * Kept separate from the status map above because the two answer different
 * questions and a cashier reconciles them separately: "เสิร์ฟแล้ว รอซิงก์" is a
 * perfectly healthy order, while "เสิร์ฟแล้ว ข้อมูลขัดแย้ง" is the one the shift
 * lead has to phone the back office about. Collapsing them into one badge would
 * hide exactly that difference.
 */
export const THAI_SYNC_LABELS: Readonly<Record<SyncState, string>> = {
  pending: 'รอซิงก์',
  synced: 'ซิงก์แล้ว',
  conflict: 'ข้อมูลขัดแย้ง',
  rejected: 'ถูกปฏิเสธ',
};

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
//
// DISPLAY ONLY. No arithmetic happens in this file. `Money` owns every
// calculation in the system and this module only turns an already-exact result
// into text.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a `Money` as Thai baht, e.g. ฿52.50.
 *
 * THE MONEY RULE (SKILL.md §2.1) STOPS HERE
 *
 * The row's total is READ from `summary.total` and formatted. It is never
 * recomputed from the lines, never divided by 100 here, and never turned into a
 * `number` — `toNumber()` would hand this screen back the float grid that
 * `Money` exists to keep it away from, and a total divided here could disagree
 * with the same order's printed receipt by one satang. `toString()` is exact
 * integer maths performed by the value object that owns the value.
 *
 * Repeated rather than imported from a sibling UI file: `CartView.tsx` and
 * `CatalogGrid.tsx` each hold their own copy for the same reason. A shared
 * "formatting" module would be one more layer whose entire content is a
 * template string.
 */
function formatBaht(amount: Money): string {
  return `฿${amount.toString()}`;
}

/**
 * The text of an unknown thrown value.
 *
 * The error a manager sees has to be reportable: "the list did not load" on its
 * own sends nobody to the right person, whereas the adapter's own message —
 * `limit must be a positive integer, received 0`, or a SQLCipher open failure —
 * names the fault. Accepts `unknown` because a rejected promise carries no
 * guarantee about what was thrown into it.
 */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen state
//
// ONE value, discriminated by `kind`, rather than three booleans.
//
// `isLoading`, `hasError` and `orders` as separate pieces of state admit the
// combinations nobody wants to be reachable: loading with rows still on screen,
// an error next to a stale list, an empty list that used to mean "not loaded
// yet". A single union makes every one of those unrepresentable, and the render
// below becomes a total walk over its cases.
//
// Note that `loaded` carries an EMPTY list as an ordinary answer. "This terminal
// has recorded no orders" is a real result, not a missing one, and the two are
// told apart in the render rather than by faking a distinct state here.
// ─────────────────────────────────────────────────────────────────────────────

type OrdersState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly orders: readonly OfflineOrderSummary[] };

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function OfflineOrdersView(props: OfflineOrdersViewProps): JSX.Element {
  const { repository, limit } = props;
  const effectiveLimit = limit ?? DEFAULT_LIMIT;

  const [state, setState] = useState<OrdersState>({ kind: 'loading' });

  useEffect(() => {
    // The unmount guard. A response that arrives AFTER the cashier has
    // navigated back to the sales screen must not write into a tree that no
    // longer exists: React warns about the update, and the warning is the only
    // thing standing between a stale write and a genuinely confusing list on
    // the next visit. `cancelled` is checked on both exit paths because a
    // rejected `listRecent` is as likely to land late as a resolved one.
    let cancelled = false;

    // Reset unconditionally on every run of the effect. When `repository` or
    // `limit` changes, the previous page is no longer an answer to the question
    // now being asked, and leaving its rows up while the new page is in flight
    // would show a cashier orders this terminal has not loaded.
    setState({ kind: 'loading' });

    // The PORT is the only way to data — `repository.listRecent(limit)`. There
    // is no SQLite handle, no Tauri `invoke` and no fetch anywhere in this file,
    // which is what makes the screen renderable under `bun test` with no native
    // runtime and swappable for the real adapter later.
    repository.listRecent(effectiveLimit).then(
      (orders) => {
        if (cancelled) return;
        setState({ kind: 'loaded', orders });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: errorMessageOf(error) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [repository, effectiveLimit]);

  // ── Render ────────────────────────────────────────────────────────────────
  // The Thai heading matches the nav label in `app/routes.ts`, so the tab the
  // cashier pressed and the screen it opened say the same thing.

  return (
    <section
      className="offline-orders"
      aria-label="ประวัติออเดอร์ออฟไลน์"
      data-testid="offline-orders"
    >
      <h2 className="offline-orders__heading">ประวัติออเดอร์ออฟไลน์</h2>

      {/* ── Loading ──────────────────────────────────────────────────────
          A live region, so a screen reader is told the list is on its way
          instead of leaving the operator to wonder whether the tap registered.
          `role="status"` rather than `alert`: nothing has gone wrong, and an
          interrupting alert for an ordinary read would train the cashier to
          dismiss the ones that matter. */}
      {state.kind === 'loading' && (
        <p className="offline-orders__loading" role="status">
          กำลังโหลด…
        </p>
      )}

      {/* ── Error ────────────────────────────────────────────────────────
          Says in Thai that the LIST could not be read, then repeats the
          adapter's own message so the shift lead can report it. `role="alert"`
          because this one is a failure the operator has to act on, unlike the
          read still in progress above. */}
      {state.kind === 'error' && (
        <p className="offline-orders__error" role="alert">
          {`อ่านรายการออเดอร์ไม่สำเร็จ: ${state.message}`}
        </p>
      )}

      {/* ── Empty ─────────────────────────────────────────────────────────
          AN EXPLICIT LINE, NEVER A BLANK LIST AREA, AND NEVER THE LOADING TEXT.

          "Still loading" and "this terminal has no orders" look identical if
          both are an empty box, and they call for opposite responses from the
          person standing at the terminal: one means wait, the other means a
          till that has never sold anything today. Reading one as the other
          either strands the cashier waiting for a list that will never arrive,
          or sends the shift lead hunting a sync fault that does not exist. */}
      {state.kind === 'loaded' && state.orders.length === 0 && (
        <p className="offline-orders__empty">ยังไม่มีออเดอร์ที่บันทึกไว้ในเครื่องนี้</p>
      )}

      {/* ── Loaded ───────────────────────────────────────────────────────
          One `li` per order, newest first — the order the port returned is the
          order the screen shows, so this file neither re-sorts nor re-pages.
          The list is presentational: no row is a button and nothing here can
          mutate a sale. Every action on an offline order is an outbox write
          (SKILL.md §2.2) and this screen deliberately has no way to perform
          one. */}
      {state.kind === 'loaded' && state.orders.length > 0 && (
        <ul className="offline-orders__list">
          {state.orders.map((order) => (
            <li key={order.id} className="offline-orders__row" data-testid="offline-order-row">
              <span className="offline-orders__row-receipt">{order.localReceiptNumber}</span>
              <span className="offline-orders__row-status">{THAI_STATUS_LABELS[order.status]}</span>
              {/* The sync state keeps its own badge and its own `data-sync-state`
                  hook: the two ladders answer different questions, and a test
                  that could not tell them apart could not catch a screen that
                  had started showing the status label twice. */}
              <span className="offline-orders__row-sync" data-sync-state={order.syncState}>
                {THAI_SYNC_LABELS[order.syncState]}
              </span>
              {/* The stored `created_at` verbatim. It is ISO-8601 UTC text, which
                  is exactly what the column holds, and it is rendered unaltered
                  rather than through a `Date`: converting it here would invent a
                  second unit conversion to disagree with the one the SQL layer
                  already made, and would make the row differ from the same
                  order's printed receipt whenever the branch timezone moved. */}
              <span className="offline-orders__row-created">{order.createdAt}</span>
              <span className="offline-orders__row-lines">{`${order.lineCount} รายการ`}</span>
              <span className="offline-orders__row-total">{formatBaht(order.total)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* ── Summary ──────────────────────────────────────────────────────
          How many orders were actually loaded, announced politely when the rows
          arrive. A count rather than a bare list, because a truncated page and a
          complete one must be distinguishable at a glance: fifty rows means the
          port honoured the page size, and any other number means the terminal is
          showing only part of the day's history. */}
      {state.kind === 'loaded' && (
        <p className="offline-orders__summary" role="status">
          {`โหลดออเดอร์ ${state.orders.length} รายการ`}
        </p>
      )}
    </section>
  );
}

export default OfflineOrdersView;
