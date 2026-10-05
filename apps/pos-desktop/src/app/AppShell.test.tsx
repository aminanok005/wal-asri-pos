/**
 * AppShell — the tests for the frame that switches between the two screens.
 *
 * These assert the wiring and nothing else: where the shell opens, what the nav
 * says, what pressing a nav item does, and whether the repository it was handed
 * is the one the history screen reads. The screens' own behaviour is tested in
 * `routes/SalesTerminalView.test.tsx` and `routes/OfflineOrdersView.test.tsx`,
 * and none of it is re-tested here — a shell test that asserted a cart total
 * would be a test that kept passing after the shell stopped switching screens.
 *
 * REAL COMPONENTS, REAL TABLE, REAL PORT. The nav is asserted against
 * `ROUTE_DEFINITIONS` rather than a hand-written list of Thai labels, so a screen
 * added to the table has to appear in the nav for this suite to stay green: a
 * copied list would go quietly stale, and the missing button is the exact defect
 * that strands a cashier on a screen they cannot leave.
 *
 * Requires the simulated DOM from `test/setup-dom.ts`, registered in
 * `bunfig.toml` under `[test] preload`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { Money } from '../features/payments/domain/money';
import { createInMemoryOfflineOrdersRepository } from '../features/sales/application/offlineOrders';
import type { OfflineOrderSummary } from '../features/sales/application/offlineOrders';
import { AppShell } from './AppShell';
import { ROUTES, ROUTE_DEFINITIONS, hashForRoute, routeById } from './routes';
import type { RouteId } from './routes';

// Unmount between tests, and let every read still in flight land FIRST. Without the
// flush, the history screen's `listRecent(...).then` resolves in a microtask after
// the tree is gone, which React reports as an update outside act() — and a warning
// on every run teaches a reader to ignore the output of this suite. With it, each
// test ends the same way a browser would: the read settles, then the tree goes.
afterEach(async () => {
  await flush();
  cleanup();
});

// The fragment is SHARED STATE between tests: the shell writes it on every mount
// and reads it when no prop names a route. A `#/offline_orders` left behind by
// one test would silently boot the next one onto the history screen, so every test
// starts from a blank fragment. This is the one piece of setup that is not an
// assertion — `hashForRoute` never produces an empty fragment, so the blank state
// can only be written by hand.
beforeEach(() => {
  window.location.hash = '';
});

// ─────────────────────────────────────────────────────────────────────────────
// Interaction notes
//
// `fireEvent` is used rather than `element.click()` for the reason the catalog,
// cart and history tests give: React 19 batches state updates, and a raw DOM
// `.click()` invoked from test code sits outside React's act() scope, so the
// re-render is not flushed before the assertion runs and the tap looks inert.
//
// EVERY QUERY IS SCOPED TO A REGION, and here the reason is stronger than
// elsewhere in the repo: the nav carries the SAME Thai labels as the headings
// inside the screens, so "หน้าขาย" is both a button and a heading on the sales
// screen. An unscoped `getByText('หน้าขาย')` would match several elements and the
// test would fail for a reason that has nothing to do with the wiring.
//
// `act` drains the microtask queue so the history screen's read settles before an
// assertion runs. The port is async by design — so the SQLite adapter can land
// without a rewrite — and a test that asserted straight after the tap would be
// asserting the loading state forever.

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The shell frame itself. */
function shell(): HTMLElement {
  return screen.getByTestId('app-shell');
}

/** The main nav, reached through the accessible name the shell gives it. */
function nav(): HTMLElement {
  return within(shell()).getByRole('navigation', { name: 'เมนูหลัก' });
}

/**
 * A nav button, named by the Thai label the route table gives it.
 *
 * Driven off `routeById` rather than a Thai literal in the test, so the assertion
 * and the table cannot disagree: a renamed screen then fails loudly here instead
 * of leaving this suite asserting a label the shell no longer renders.
 */
function navButton(id: RouteId): HTMLElement {
  return within(nav()).getByRole('button', { name: routeById(id).labelTh });
}

/** Whether the sales screen is the one on show. */
function salesVisible(): boolean {
  return screen.queryByTestId('sales-terminal') !== null;
}

/** Whether the history screen is the one on show. */
function historyVisible(): boolean {
  return screen.queryByTestId('offline-orders') !== null;
}

/**
 * Drain the microtask queue inside `act`, twice.
 *
 * Twice for the reason `OfflineOrdersView.test.tsx` gives: the screen's
 * `listRecent(...).then(...)` is one hop and the update it schedules lands on the
 * following flush. One await leaves a race that only shows up on a busy machine.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
//
// One committed sale, every field spelled out, because there is exactly one of it
// and the assertions below quote its receipt number and its total verbatim. The
// total is a `Money` built from SATANG, never from a number: ฿45.50 is 45.5 in
// binary, and a fixture written as `Money.fromNumber(45.5)` would be a rounding
// test in disguise.
// ─────────────────────────────────────────────────────────────────────────────

const SEEDED_ORDER: OfflineOrderSummary = {
  id: '018f3c2a-0000-7000-8000-0000000000d1',
  localReceiptNumber: 'R-2001',
  status: 'completed',
  syncState: 'pending',
  createdAt: '2026-10-03T09:30:00.000Z',
  lineCount: 1,
  total: Money.fromSatang(4550n),
  roundingAdjustmentSatang: Money.fromSatang(0n),
  currencyCode: 'THB',
};

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 2. Where the shell opens
// ─────────────────────────────────────────────────────────────────────────────

describe('AppShell — where it opens', () => {
  it('boots on the sales screen with no props at all', () => {
    render(<AppShell />);

    // A till that opens anywhere else puts a read-only list between the cashier
    // and a customer who is waiting to pay.
    expect(salesVisible()).toBe(true);
    expect(historyVisible()).toBe(false);
  });

  it('boots straight onto the screen a valid initialRoute names', async () => {
    render(<AppShell initialRoute={ROUTES.offline_orders} />);
    await flush();

    expect(historyVisible()).toBe(true);
    expect(salesVisible()).toBe(false);
  });

  it('opens the screen the URL fragment names, when no prop does', async () => {
    // The fragment is what survives a reload in a Tauri bundle, so this is the
    // path a deep link and a restored window actually take.
    window.location.hash = hashForRoute(ROUTES.offline_orders);
    render(<AppShell />);
    await flush();

    expect(historyVisible()).toBe(true);
    expect(salesVisible()).toBe(false);
  });

  it('renders the sales screen for an invalid initialRoute instead of throwing', () => {
    // Cast past the type on purpose: this is the shape of a bad value arriving
    // from JSON, from a stale bookmark, or from a caller that lost track. An
    // invalid route must never be RENDERED, and must never brick the mount.
    const bogus = 'sales_terminal_v2' as unknown as RouteId;
    render(<AppShell initialRoute={bogus} />);

    expect(salesVisible()).toBe(true);
    expect(historyVisible()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The nav the table generates
// ─────────────────────────────────────────────────────────────────────────────

describe('AppShell — the nav', () => {
  it('renders one button per route, labelled with the Thai label the table gives', () => {
    render(<AppShell />);

    // Driven off `ROUTE_DEFINITIONS`, NOT a hand-written list of two labels. A
    // copied list would still pass with a third screen added to the table, and the
    // symptom of that would be a screen nobody can navigate to — the one defect a
    // shell exists to prevent.
    const buttons = within(nav()).getAllByRole('button');
    expect(buttons).toHaveLength(ROUTE_DEFINITIONS.length);
    for (const definition of ROUTE_DEFINITIONS) {
      expect(within(nav()).getByRole('button', { name: definition.labelTh })).toBeDefined();
    }
  });

  it('marks the active item with aria-current, and it is sales on boot', () => {
    render(<AppShell />);

    // Exactly ONE item may claim to be the current page: two of them is a nav
    // that tells a screen reader the till is on two screens at once.
    const current = within(nav())
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe(routeById(ROUTES.sales).labelTh);
  });

  it('moves the aria-current marker when the cashier taps the other item', async () => {
    render(<AppShell />);
    fireEvent.click(navButton(ROUTES.offline_orders));
    await flush();

    expect(navButton(ROUTES.offline_orders).getAttribute('aria-current')).toBe('page');
    expect(navButton(ROUTES.sales).getAttribute('aria-current')).toBeNull();
  });

  // ── Switching screens ─────────────────────────────────────────────────────

  it('swaps the sales screen for the history screen, and back again', async () => {
    render(<AppShell />);
    expect(salesVisible()).toBe(true);

    fireEvent.click(navButton(ROUTES.offline_orders));
    await flush();
    expect(historyVisible()).toBe(true);
    // Both screens on screen at once would leave the cashier unable to say which
    // one the basket belongs to.
    expect(salesVisible()).toBe(false);

    fireEvent.click(navButton(ROUTES.sales));
    expect(salesVisible()).toBe(true);
    expect(historyVisible()).toBe(false);
  });

  it('unmounts the sales screen, so coming back is an empty terminal', async () => {
    // The switch must REPLACE the sales screen, not hide a second live copy of it:
    // two copies means two carts, and the receipt would print the one the cashier
    // is not looking at. So a basket is filled before navigating away, and the
    // terminal the shell shows afterwards must not carry it over.
    render(<AppShell />);
    const grid = within(screen.getByTestId('catalog-grid'));
    fireEvent.click(grid.getByRole('button', { name: 'เพิ่ม กาแฟลาเต้' }));
    expect(screen.getByTestId('sales-subtotal').textContent).toBe('฿45.50');

    fireEvent.click(navButton(ROUTES.offline_orders));
    await flush();
    expect(historyVisible()).toBe(true);

    fireEvent.click(navButton(ROUTES.sales));
    expect(screen.getByTestId('sales-subtotal').textContent).toBe('฿0.00');
  });

  it('writes the fragment for the screen it just showed', () => {
    render(<AppShell />);
    fireEvent.click(navButton(ROUTES.offline_orders));

    // Compared against `hashForRoute`, not against a literal '#/offline_orders':
    // the written fragment is the table's, and the test says so.
    expect(window.location.hash).toBe(hashForRoute(ROUTES.offline_orders));

    fireEvent.click(navButton(ROUTES.sales));
    expect(window.location.hash).toBe(hashForRoute(ROUTES.sales));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 & 5. The repository seam
//
// The shell's whole job at this seam is to hand the SAME port object to the
// history screen. A shell that wrapped it, rebuilt it per render or passed a
// different one would still show a list, and the SQLCipher adapter would silently
// never be the thing being read.
// ─────────────────────────────────────────────────────────────────────────────

describe('AppShell — the repository it hands the history screen', () => {
  it('shows the order the injected repository was seeded with', async () => {
    const repository = createInMemoryOfflineOrdersRepository([SEEDED_ORDER]);
    render(<AppShell ordersRepository={repository} />);
    fireEvent.click(navButton(ROUTES.offline_orders));
    await flush();

    const row = within(screen.getByTestId('offline-orders')).getByTestId('offline-order-row');
    // The receipt number and the EXACT total, read as rendered. ฿45.50 is the
    // `Money.toString()` of 4550 satang — not a number either the shell or the view
    // divided, which would have produced '฿45.5' and failed here.
    expect(row.textContent).toContain(SEEDED_ORDER.localReceiptNumber);
    expect(row.textContent).toContain('฿45.50');
  });

  it('renders the empty state on its own when no repository is supplied', async () => {
    // `<AppShell />` with nothing wired must still show a usable screen: the empty
    // line the history screen writes, not a crash and not a loading state that
    // never resolves.
    render(<AppShell />);
    fireEvent.click(navButton(ROUTES.offline_orders));
    await flush();

    const view = within(screen.getByTestId('offline-orders'));
    expect(view.getByText('ยังไม่มีออเดอร์ที่บันทึกไว้ในเครื่องนี้')).toBeDefined();
    expect(view.queryAllByTestId('offline-order-row')).toHaveLength(0);
  });
});
