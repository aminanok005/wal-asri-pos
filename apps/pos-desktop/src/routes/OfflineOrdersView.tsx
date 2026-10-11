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

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { THAI_STATUS_LABELS, THAI_SYNC_LABELS } from '../features/sales/ui/orderLabels';
import { ALL_SYNC_STATES, summariseSyncStates } from './offlineOrdersSummary';
import { formatAdjustment } from './moneyFormat';

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
  /**
   * How the cashier gets back to the sales screen.
   *
   * OPTIONAL, and the empty state renders its "กลับไปหน้าขาย" button only when
   * this is supplied — a screen shown on its own has nowhere to go, and a
   * permanent button that does nothing is the one control on this screen that
   * could lie. `AppShell` owns the route, so it passes the navigation down
   * rather than this view reaching for a global that may not exist.
   */
  readonly onGoToSales?: () => void;
}

/** Rows requested when the caller names no page size. */
const DEFAULT_LIMIT = 50;

/**
 * The empty page, shared.
 *
 * `state.orders` is already an array on every `loaded` page, so this only stands
 * in for the two states that have no rows at all — and it is a frozen EMPTY
 * constant rather than a fresh `[]` so the `useMemo` below does not see a new
 * reference on every render of a screen that is loading or has failed.
 */
const NO_ORDERS: readonly OfflineOrderSummary[] = Object.freeze([]);

// ─────────────────────────────────────────────────────────────────────────────
// Thai labels for the two ladders
//
// RE-EXPORTED, NOT DECLARED HERE.
//
// Both maps moved to `features/sales/ui/orderLabels.ts` when the sales screen's
// recent-orders strip needed to render the same two badges. Importing them from
// this route would have made a UI component depend on a route — inverting the
// layering `layers.test.ts` exists to hold — and would have left two components
// each holding their own copy of the same map.
//
// Both maps are EXHAUSTIVE BY TYPE, and that is the point: `Record<
// OfflineOrderStatus, string>` makes a missing rung a COMPILE error on every
// screen that might mention it. A missing rung is not a blank cell — indexing an
// object with an absent key yields `undefined`, and React renders `undefined` as
// nothing at all. A status nobody labelled would show as an empty chip in a row
// whose receipt number, total and line count are all perfectly legible.
//
// Re-exported so the test suite can still iterate them from this path, and so
// `OfflineOrdersView.test.tsx` keeps failing loudly when a new rung lands without
// a label, rather than waiting for a row to render blank.
// ─────────────────────────────────────────────────────────────────────────────

export { THAI_STATUS_LABELS, THAI_SYNC_LABELS };

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
  const { repository, limit, onGoToSales } = props;
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

  // Counted once per page rather than per render.
  const syncCounts = useMemo(
    () => (state.kind === 'loaded' ? summariseSyncStates(state.orders) : null),
    [state],
  );

  // ── The sync-state filter ─────────────────────────────────────────────────
  //
  // A SET rather than "which single rung is selected": the buckets are
  // independent and additive. A shift lead chasing every conflict AND every
  // rejected write wants both lit at once, and a single-select control would
  // make the second press TRADE one filter for the other.
  //
  // EMPTY SET MEANS NO FILTER, not "nothing matches". The default state of this
  // screen is the whole page — the answer to the question the cashier arrived
  // with — and reaching for a "ทั้งหมด" chip to undo an accidental press would be
  // one more thing to remember.
  const [activeStates, setActiveStates] = useState<ReadonlySet<SyncState>>(
    () => new Set<SyncState>(),
  );

  const toggleSyncState = useCallback((syncState: SyncState) => {
    setActiveStates((previous) => {
      // A fresh Set rather than mutating `previous`: React compares state by
      // reference, and mutating in place would leave every chip looking unpressed.
      const next = new Set(previous);
      if (next.has(syncState)) {
        next.delete(syncState);
      } else {
        next.add(syncState);
      }
      return next;
    });
  }, []);

  const filtering = activeStates.size > 0;

  // THE PAGE, NARROWED.
  //
  // Memoised for the same reason `syncCounts` is: this walks every order, and
  // the screen re-renders on every chip press. Filtering the LOADED page rather
  // than the port result — the port is asked once, for the whole page, and no
  // press here can make it answer again.
  const visibleOrders = useMemo(() => {
    if (state.kind !== 'loaded') return NO_ORDERS;
    if (!filtering) return state.orders;
    return state.orders.filter((order) => activeStates.has(order.syncState));
  }, [state, activeStates, filtering]);

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

      {/* ── Sync summary ──────────────────────────────────────────────────
          Two axes: the four buckets partition the page and sum to it, `voided`
          counts the same rows again by another column. Merging them would make
          the figures disagree about how many orders this terminal holds.
          The trailing colon keeps each label a text node of its own — the row
          badges reuse these four strings, and a test matches one by exact text. */}
      {syncCounts !== null && (
        <div className="offline-orders__sync-summary">
          <ul className="offline-orders__sync-list">
            {ALL_SYNC_STATES.map((syncState) => (
              <li
                key={syncState}
                className="offline-orders__sync-item"
                data-sync-state={syncState}
              >
                {/* `aria-pressed` AND NOT a radio group: the four buckets are
                    additive filters, and a pressed/unpressed button is exactly
                    what the attribute means. It also tells a screen reader the
                    list below is currently narrowed, and by which rungs — which
                    a plain count never could.

                    `role="status"` IS GONE from this container, and deliberately:
                    it now holds buttons, and a live region whose contents change
                    announces the whole bar on every press. The one count still
                    worth announcing is announced once, at the foot of the screen.

                    The trailing colon on each label is unchanged, and still earns
                    its place — it keeps the label a text node of its own, because
                    the row badges reuse these same four strings. */}
                <button
                  type="button"
                  className="offline-orders__sync-filter"
                  aria-pressed={activeStates.has(syncState)}
                  onClick={() => {
                    toggleSyncState(syncState);
                  }}
                >
                  <span className="offline-orders__sync-label">{`${THAI_SYNC_LABELS[syncState]}:`}</span>
                  <span className="offline-orders__sync-count">
                    {syncCounts.bySyncState[syncState].toString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <p className="offline-orders__sync-voided">
            {`ยกเลิกออเดอร์แล้ว ${syncCounts.voided} รายการ`}
          </p>
        </div>
      )}

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
        <div className="offline-orders__empty" data-testid="offline-orders-empty">
          {/* A LINE drawing, not a filled glyph: an empty state is a quiet
              statement of fact, and a solid icon would make it look like a
              warning. `aria-hidden` because the sentence under it already says
              everything the shape was saying. */}
          <svg
            className="offline-orders__empty-icon"
            width="56"
            height="56"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 3.5h12a1 1 0 0 1 1 1v16l-2.4-1.6-2.6 1.6-2.6-1.6L8 20.5 5 18.9v-14.4a1 1 0 0 1 1-1Z" />
            <path d="M9 8.5h6M9 12.5h4" />
          </svg>
          <p className="offline-orders__empty-title">ยังไม่มีออเดอร์ที่บันทึกไว้ในเครื่องนี้</p>
          {/* WHAT TO DO ABOUT IT. The old line named the condition and stopped,
              which left the cashier's only move to be guessing. This says the
              screen is watching the machine and will fill itself in. */}
          <p className="offline-orders__empty-hint">
            ออเดอร์ที่ขายขณะออฟไลน์จะแสดงที่นี่ทันทีที่บันทึกลงเครื่องนี้
          </p>
          {/* RENDERED ONLY WHEN THERE IS SOMEWHERE TO GO — see `onGoToSales`. */}
          {onGoToSales !== undefined && (
            <button
              type="button"
              className="offline-orders__empty-action"
              onClick={onGoToSales}
            >
              กลับไปหน้าขาย
            </button>
          )}
        </div>
      )}

      {/* ── Filtered to nothing ───────────────────────────────────────────
          A DIFFERENT SENTENCE FROM THE EMPTY STATE ABOVE, and the distinction is
          the whole point: the till HAS orders and the filter is hiding them, so
          offering "กลับไปหน้าขาย" here would send the cashier away from a screen
          that is working correctly. Telling them to press a chip again is the
          action that actually resolves it. */}
      {state.kind === 'loaded' &&
        state.orders.length > 0 &&
        visibleOrders.length === 0 && (
          <p className="offline-orders__empty-filtered">
            ไม่มีออเดอร์ในสถานะที่เลือก — กดชิปสถานะอีกครั้งเพื่อแสดงทั้งหมด
          </p>
        )}

      {/* ── Loaded ───────────────────────────────────────────────────────
          One `li` per order, newest first — the order the port returned is the
          order the screen shows, so this file neither re-sorts nor re-pages.
          The list is presentational: no row is a button and nothing here can
          mutate a sale. Every action on an offline order is an outbox write
          (SKILL.md §2.2) and this screen deliberately has no way to perform
          one. */}
      {state.kind === 'loaded' && visibleOrders.length > 0 && (
        <ul className="offline-orders__list">
          {visibleOrders.map((order) => (
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
              {/* The cash-rounding adjustment, SIGNED, and ONLY when it is not
                  zero. This is the field a shift lead reconciles the drawer
                  against: +3 means the customer was charged 3 satang more than
                  the goods so the drawer could hold whole baht, −3 means 3 less.
                  Hiding the sign would turn an exact till into one that looks
                  6 satang out.
                  Rendered through `formatAdjustment` (shared with checkout) rather
                  than `formatBaht`, because `formatBaht` would emit `฿-0.03` —
                  the sign inside the currency symbol — and a blank span instead of
                  a row is what `0n` would give, which is correct: a sale that did
                  not round carries no rounding line at all. */}
              {!order.roundingAdjustmentSatang.isZero() && (
                <span
                  className="offline-orders__row-rounding"
                  data-testid="offline-order-rounding"
                  data-rounding-sign={order.roundingAdjustmentSatang.isNegative() ? 'negative' : 'positive'}
                >
                  {`ปัดเศษ ${formatAdjustment(order.roundingAdjustmentSatang.satang)}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ── Summary ──────────────────────────────────────────────────────
          STILL A LIVE REGION, AND STILL THE COUNT THAT MATTERS — a truncated page
          and a complete one must be distinguishable: fifty rows means the port
          honoured the page size, and any other number means the terminal is
          showing only part of the day's history.

          BUT NO LONGER VISIBLE. It used to sit at the bottom-left corner as grey
          13px text, and on an empty screen it read "โหลดออเดอร์ 0 รายการ" under a
          heading that already said, in much larger type, that this terminal holds
          no orders. A page whose only content is "nothing here", stated twice and
          in the smallest type available, is a page that looks broken rather than
          empty.

          CLIPPED, NOT `display: none`, so it stays in the accessibility tree and
          is still announced when the rows arrive — which is the job it was
          written for. See `.offline-orders__summary` in `offline-orders.css`.

          It counts `state.orders`, NOT `visibleOrders`: this reports what the port
          returned, so the figure does not change as chips are pressed and two
          numbers on one screen never mean two different things. */}
      {state.kind === 'loaded' && (
        <p className="offline-orders__summary" role="status">
          {`โหลดออเดอร์ ${state.orders.length} รายการ`}
        </p>
      )}
    </section>
  );
}

export default OfflineOrdersView;
