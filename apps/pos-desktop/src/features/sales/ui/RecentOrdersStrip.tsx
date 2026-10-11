/**
 * RecentOrdersStrip — what THIS terminal has already sold, above the menu.
 *
 * LAYER: UI (presentation). It reads order history through exactly one thing, the
 * `OfflineOrdersRepository` port handed in as a prop, and knows nothing about
 * SQLCipher, `@tauri-apps/*`, `bun:sqlite` or the network — which is what lets it
 * render under `bun test` on a machine with no native runtime.
 *
 * ── WHY IT IS ON THE SALES SCREEN AT ALL ────────────────────────────────────
 *
 * Because a cashier's question mid-shift is "what did I just sell?", and the
 * answer was one screen and one navigation away. On a till, navigation is a
 * deliberate act; the gap between "I rang up three coffees" and "where did they
 * go" is where a reprint gets pressed, a customer waits, and the drawer stops
 * matching the screen. The strip answers the question without leaving the sale.
 *
 * ── WHY IT SHOWS SO LITTLE ──────────────────────────────────────────────────
 *
 * Receipt number, lifecycle status, sync state, line count. Nothing else. This is
 * a glance, not the history screen: `OfflineOrdersView` is the one a shift lead
 * opens during a bug report and it shows money, timestamps and rounding. A strip
 * that carried those would put five figures in the cashier's peripheral vision
 * while they were working, and the one that mattered — which order is stuck —
 * would be lost among them.
 *
 * It carries NO customer name and NO table number, and that is a contract rather
 * than an omission: the sales screen's own header already renders those strings
 * once, and a second copy in a scrolling strip would be two elements with the
 * same text on one page.
 *
 * ── WHY IT IS ITS OWN COMPONENT ─────────────────────────────────────────────
 *
 * So `SalesTerminalView` holds one effect and one JSX line instead of growing by
 * the whole read-and-render cycle. That file is documented as the thinnest in the
 * repo, and it is already the thickest thing in `routes/`.
 *
 * @see ./orderLabels.ts — the Thai wording for the two badges
 * @see ../application/offlineOrders.ts — the port this reads through
 */

import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import type { OfflineOrdersRepository, OfflineOrderSummary } from '../application/offlineOrders';
import { THAI_STATUS_LABELS, THAI_SYNC_LABELS } from './orderLabels';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface RecentOrdersStripProps {
  /**
   * The port the recent orders are read through. Required, and the ONLY way data
   * reaches this component.
   */
  readonly repository: OfflineOrdersRepository;
  /**
   * How many orders to show. Defaults to 8 — about one screenful at the strip's
   * own height on a till, and enough to cover the walk-back from the kitchen.
   *
   * A page size rather than a scroll window: a strip that grows without bound is
   * a strip that pushes the menu off the screen, and the menu is what the
   * cashier came to this screen for.
   */
  readonly limit?: number;
}

/** Orders requested when the caller names no page size. */
const DEFAULT_LIMIT = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Screen state
//
// ONE value discriminated by `kind`, rather than three booleans — the same
// argument `OfflineOrdersView` makes, and for the same reason: separate pieces of
// state admit the combinations nobody wants, like a stale list beside an error.
//
// `loaded` carries an EMPTY list as an ordinary answer. "This terminal has sold
// nothing yet" is a real result, not a missing one.
//
// ── WHY THE STRIP HIDES WHEN THERE IS NOTHING TO SHOW ───────────────────────
//
// A strip that renders "ยังไม่มีออเดอร์" on every fresh terminal is a permanent
// banner explaining an absence nobody asked about, occupying the exact space the
// menu should start at. Silence is the honest rendering of an empty history on a
// sales screen; the history screen is one tap away for anyone who wants to read
// the empty state in full.
// ─────────────────────────────────────────────────────────────────────────────

type StripState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly orders: readonly OfflineOrderSummary[] }
  | { readonly kind: 'error'; readonly message: string };

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function RecentOrdersStrip(props: RecentOrdersStripProps): JSX.Element | null {
  const { repository, limit } = props;
  const effectiveLimit = limit ?? DEFAULT_LIMIT;

  const [state, setState] = useState<StripState>({ kind: 'loading' });

  useEffect(() => {
    // The unmount guard, copied from `OfflineOrdersView` for the reason given
    // there: the cashier navigates to the history screen and back constantly, and
    // a read that lands after the component is gone writes into a tree that no
    // longer exists. React warns about the update, and the warning is the only
    // thing standing between a stale write and a strip showing yesterday's last
    // order under today's newest one.
    let cancelled = false;

    // Reset on every run, not only the first: a changed `repository` or `limit`
    // means the previous page is no longer an answer to the question now being
    // asked, and leaving it up while the new one loads would show orders this
    // terminal has not read.
    setState({ kind: 'loading' });

    repository.listRecent(effectiveLimit).then(
      (orders) => {
        if (cancelled) return;
        setState({ kind: 'loaded', orders });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [repository, effectiveLimit]);

  // ── Nothing to show ───────────────────────────────────────────────────────
  // Rendering `null` rather than a labelled-but-empty region: an empty region
  // with an accessible name announces itself to a screen reader as a control
  // that failed to appear, which is worse than saying nothing.

  if (state.kind === 'loaded' && state.orders.length === 0) {
    return null;
  }

  // A read that failed renders nothing either — see the note above. The failure
  // is not hidden from the shift lead: the history screen shows it in full, and a
  // broken strip must not become a second, differently-worded error report on the
  // screen a cashier is trying to take money on.
  if (state.kind !== 'loaded') {
    return null;
  }

  return (
    <section
      className="recent-orders"
      aria-label="ออเดอร์ล่าสุด"
      data-testid="recent-orders-strip"
    >
      <h2 className="recent-orders__heading">ออเดอร์ล่าสุด</h2>

      <ul className="recent-orders__list">
        {state.orders.map((order) => (
          <li key={order.id} className="recent-orders__chip">
            <span className="recent-orders__receipt">{order.localReceiptNumber}</span>
            <span className="recent-orders__status">{THAI_STATUS_LABELS[order.status]}</span>
            {/* The sync badge keeps its own element and its own `data-sync-state`
                hook, exactly as on the history rows: the two ladders answer
                different questions, and a strip that merged them would hide
                which of them a stuck order is stuck in. */}
            <span className="recent-orders__sync" data-sync-state={order.syncState}>
              {THAI_SYNC_LABELS[order.syncState]}
            </span>
            <span className="recent-orders__lines">{`${order.lineCount} รายการ`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default RecentOrdersStrip;