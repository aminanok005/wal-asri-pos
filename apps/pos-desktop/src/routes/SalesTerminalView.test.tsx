/**
 * SalesTerminalView — acceptance tests for the screen that joins the two
 * features.
 *
 * These are the only tests that render BOTH the catalog grid and the cart, so
 * they are the only place the claim "a click on a tile lands in a real cart"
 * can be tested at all. Everything is real: the real screen, the real grid over
 * the real `buildCatalog` result, the real `CartView`, the real cart domain.
 * Nothing is mocked, because a mocked price would hide the one bug these tests
 * exist to find — the tile showing ฿45.50 and the line charging something else.
 *
 * Requires the simulated DOM from `test/setup-dom.ts`, registered in
 * `bunfig.toml` under `[test] preload`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { SalesTerminalView } from './SalesTerminalView';
import type { CheckoutRepository } from './SalesTerminalView';
import type { SaveOfflineOrderInputWire } from '../features/sales/infrastructure/tauriOfflineOrders';
import type { SalesTerminalViewProps, HeldOrderMismatch } from './SalesTerminalView';

// A valid UUIDv7 for testing (version=7, variant=10xx)
const TEST_TERMINAL_ID = '018f3c2a-0000-7000-8000-000000000001';
const TEST_BRANCH_ID = '018f3c2b-0000-7000-8000-000000000002';

/** Render SalesTerminalView with test terminal identity injected. */
function renderTerminal(props: Omit<SalesTerminalViewProps, 'terminalIdentity'>): ReturnType<typeof render> {
  return render(<SalesTerminalView {...props} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);
}

/**
 * A checkout repository that RECORDS rather than commits.
 *
 * The fulfilment test needs to assert on the payload, and the real adapter needs
 * a Tauri runtime — so the screen is given this double and the assertion is made
 * on what would have been written. It is the same shape `SalesTerminalCheckout.test.tsx`
 * uses; duplicated here rather than imported, because a test file importing
 * another test file's helpers couples two suites' assertions to each other's edit.
 */
function recordingRepository(): {
  repo: CheckoutRepository;
  saved: SaveOfflineOrderInputWire[];
} {
  const saved: SaveOfflineOrderInputWire[] = [];
  return {
    saved,
    repo: {
      async save(input) {
        saved.push(input);
        return { receiptNumber: input.order.localReceiptNumber };
      },
    },
  };
}

// Unmount between tests, and let every read still in flight land FIRST.
//
// The flush is not optional. `SalesTerminalView` renders the recent-orders strip,
// which reads `listRecent` in an effect; that read is async BY DESIGN — so the
// SQLite adapter can land without a rewrite — and it settles a microtask after
// the tree is gone. A synchronous `cleanup()` leaves that update landing on an
// unmounted component, which React reports as an act() warning. Fifteen of those
// on every run would teach a reader to ignore this file's output entirely, and a
// real act() warning arriving later would be lost among them.
//
// Two awaits, not one: the read is one hop and the update it schedules lands on
// the following flush. One await leaves a race that only shows up on a busy
// machine — which is to say, in CI, intermittently.
afterEach(async () => {
  await flush();
  cleanup();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction helpers
//
// `fireEvent`, not `element.click()`: React 19 batches state updates, and a raw
// DOM `.click()` from test code sits outside React's act() scope, so the
// re-render is not flushed before the assertion and the tap appears to do
// nothing. `fireEvent` dispatches through React's own event system and the
// update is applied synchronously.
//
// EVERY QUERY IS SCOPED TO A REGION, and on this screen that matters more than
// anywhere else in the repo: a product name appears on a grid tile AND on the
// increment, decrement and delete controls of its cart row. "กาแฟลาเต้" is four
// controls on this page once the item is in the basket, so an unscoped query
// matches several elements and the test fails for a reason that has nothing to
// do with the wiring.
// ─────────────────────────────────────────────────────────────────────────────

/** The screen itself — a layout box with no accessible name of its own. */
function terminal(): HTMLElement {
  return screen.getByTestId('sales-terminal');
}

/**
 * The menu grid — the only element found by test id rather than by name, for
 * the reason `CatalogGrid.test.tsx` gives: it is a layout container with no
 * name, and every tile inside it has a proper accessible name.
 */
function grid(): HTMLElement {
  return within(terminal()).getByTestId('catalog-grid');
}

/** The basket panel, reached through the heading the panel owns. */
function cartPanel(): HTMLElement {
  const heading = within(terminal()).getByRole('heading', { name: 'ตะกร้าสินค้า' });
  const panel = heading.closest('section');
  if (panel === null) {
    throw new Error('the cart panel is not a <section>');
  }
  return panel;
}

/** A tile on the grid, found by its accessible name — "เพิ่ม <name>". */
function tile(nameTh: string): HTMLElement {
  return within(grid()).getByRole('button', { name: `เพิ่ม ${nameTh}` });
}

/** Whether an item has a tile at all. `queryBy`, so "absent" is answerable. */
function hasTile(nameTh: string): boolean {
  return within(grid()).queryByRole('button', { name: `เพิ่ม ${nameTh}` }) !== null;
}

/**
 * How many tiles the grid is offering.
 *
 * Scoped to `data-testid="catalog-tiles"`, not to the grid: the withheld-items
 * chip is a button inside the grid's scope and is not a sellable drink.
 */
function tileCount(): number {
  const list = screen.queryByTestId('catalog-tiles');
  return list === null ? 0 : within(list).queryAllByRole('button').length;
}

/** The rendered cart row for a line, or `null` when the line is not in the cart. */
function cartRow(nameTh: string): HTMLElement | null {
  return within(cartPanel()).queryByText(nameTh)?.closest('li') ?? null;
}

/** How many cart rows are on screen. */
function rowCount(): number {
  return within(cartPanel()).queryAllByRole('listitem').length;
}

/** The quantity shown on a cart line. */
function quantityOf(nameTh: string): string {
  const row = cartRow(nameTh);
  if (row === null) {
    throw new Error(`no cart row for ${nameTh}`);
  }
  return within(row).getByText(/^\d+$/).textContent ?? '';
}

/**
 * THE ORDER TOTAL, exactly as rendered.
 *
 * ONE helper now, where there were two. The screen used to quote the subtotal
 * twice — in a strip above the basket and again in the basket's own footer — and
 * the two tests that read each copy are the reason a stale figure could sit a
 * few hundred pixels from the live one with nothing to tell them apart. The
 * total is now in the checkout breakdown and nowhere else, so this reads that
 * one place.
 */
function subtotalText(): string {
  return within(terminal()).getByTestId('checkout-subtotal').textContent ?? '';
}

/**
 * The item count beside the basket heading, from the domain's `totalUnits`.
 *
 * It used to be in a totals strip of its own at the top of the order rail; it
 * is now secondary text qualifying `ตะกร้าสินค้า`, inside the cart panel.
 */
function itemCountText(): string {
  return within(cartPanel()).getByTestId('cart-item-count').textContent ?? '';
}

/** Sell something: press its grid tile, the way a cashier does. */
function sell(nameTh: string): void {
  fireEvent.click(tile(nameTh));
}

/** Press the + button on a cart line. */
function increment(nameTh: string): void {
  fireEvent.click(within(cartPanel()).getByRole('button', { name: `เพิ่มจำนวน ${nameTh}` }));
}

/** Press the − button on a cart line. */
function decrement(nameTh: string): void {
  fireEvent.click(within(cartPanel()).getByRole('button', { name: `ลดจำนวน ${nameTh}` }));
}

/** Press a button in the cart panel by its exact accessible name. */
function pressCartButton(name: string): void {
  fireEvent.click(within(cartPanel()).getByRole('button', { name }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The wiring itself: both halves are on screen and the basket starts empty
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — the wiring', () => {
  it('shows the resolved menu at the prices the catalog domain resolved', () => {
    render(<SalesTerminalView />);

    // Eight sellable rows: the soup is retired and the milk is unpriced. The
    // screen did not choose that — `buildCatalog` did, before the grid drew.
    expect(tileCount()).toBe(8);
    expect(tile('กาแฟลาเต้').textContent).toContain('฿45.50');
    expect(tile('มอคค่า').textContent).toContain('฿60.00');
    expect(tile('ชาไทย').textContent).toContain('฿35.00');
    expect(tile('น้ำเปล่า').textContent).toContain('฿15.00');
  });

  it('starts with an empty basket that totals exactly zero', () => {
    render(<SalesTerminalView />);

    expect(within(cartPanel()).getByText('ยังไม่มีสินค้าในตะกร้า')).toBeDefined();
    expect(rowCount()).toBe(0);
    expect(subtotalText()).toBe('฿0.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Click → a real cart
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — a click lands in the basket', () => {
  it('turns one tap on a tile into one line at exactly the tile’s price', () => {
    render(<SalesTerminalView />);

    sell('กาแฟลาเต้');

    // ฿45.50 is the number the tile displayed, not a re-read of the catalog and
    // not something the screen recomputed. The tile said it and the line says
    // it, and that is the whole claim.
    expect(rowCount()).toBe(1);
    expect(cartRow('กาแฟลาเต้')).not.toBeNull();
    expect(quantityOf('กาแฟลาเต้')).toBe('1');
    // ONE total on this screen now. It used to be asserted twice — once from the
    // strip above the basket and once from the basket's own footer — and those
    // two assertions were the whole reason a stale copy could sit unnoticed.
    expect(subtotalText()).toBe('฿45.50');
  });

  it('keeps the SKU the catalog gave, so the line can be matched to a shelf', () => {
    render(<SalesTerminalView />);
    sell('มอคค่า');

    // Round A hid the SKU from the cashier's screen, so the text is no longer
    // in `textContent`. The line still CARRIES it — as `data-sku` — which is
    // what a shelf-side lookup needs, so the assertion moved to the attribute
    // rather than dropping the guarantee.
    expect(cartRow('มอคค่า')?.getAttribute('data-sku')).toBe('BEV-MOCHA-12');
    expect(cartRow('มอคค่า')?.textContent).toContain('1 × ฿60.00');
    expect(subtotalText()).toBe('฿60.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Two entry points, one domain
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — the grid and the cart share one domain', () => {
  it('reaches the same line through a second tap and through the cart’s own +', () => {
    render(<SalesTerminalView />);

    sell('กาแฟลาเต้');
    sell('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('2');
    expect(subtotalText()).toBe('฿91.00');

    // The cart panel's + is a different button on a different component, and it
    // moves the very same line by exactly the same step. It could only do that
    // if both controls end up in one domain over one basket — two private carts
    // would leave the second control acting on a copy.
    increment('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('3');
    expect(subtotalText()).toBe('฿136.50');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 & 5. Merging and exact sums
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — the domain rules showing through the grid', () => {
  it('merges three taps of one item into ONE line at quantity 3', () => {
    render(<SalesTerminalView />);

    sell('กาแฟลาเต้');
    sell('กาแฟลาเต้');
    sell('กาแฟลาเต้');

    // `addItem` merges on repeat. The screen did not implement that — it called
    // the domain three times and rendered whatever came back.
    expect(rowCount()).toBe(1);
    expect(quantityOf('กาแฟลาเต้')).toBe('3');
    expect(subtotalText()).toBe('฿136.50');
  });

  it('sums two different items to their exact combined total', () => {
    render(<SalesTerminalView />);

    sell('กาแฟลาเต้'); // ฿45.50
    sell('ชาไทย'); // ฿35.00
    expect(rowCount()).toBe(2);
    expect(subtotalText()).toBe('฿80.50');

    sell('มอคค่า'); // ฿60.00
    expect(rowCount()).toBe(3);
    expect(subtotalText()).toBe('฿140.50');
    // Three lines, three cups — and the header's count is `totalUnits`, not a
    // tally of rows the screen happened to render.
    expect(itemCountText()).toBe('3 รายการ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 & 10. Decrement to zero, and clearing
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — removing lines', () => {
  it('deletes the row when the quantity reaches zero', () => {
    render(<SalesTerminalView />);

    sell('กาแฟลาเต้');
    sell('กาแฟลาเต้');
    expect(rowCount()).toBe(1);
    expect(subtotalText()).toBe('฿91.00');

    decrement('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('1');
    decrement('กาแฟลาเต้');

    // A quantity of zero removes the line. That is `updateQuantity`'s rule
    // reaching the screen untouched: a row that lingered at zero would still
    // show up in the item count while contributing nothing to the total.
    expect(rowCount()).toBe(0);
    expect(cartRow('กาแฟลาเต้')).toBeNull();
    expect(subtotalText()).toBe('฿0.00');
    expect(itemCountText()).toBe('0 รายการ');
  });

  it('empties the basket from the cart’s ล้างตะกร้า', () => {
    render(<SalesTerminalView />);

    sell('กาแฟลาเต้');
    sell('มอคค่า');
    expect(rowCount()).toBe(2);

    // Clearing is CONFIRMED, so one press only arms the question. Asserting the
    // basket still holds both lines here is what makes the confirmation real
    // rather than decorative.
    pressCartButton('ล้างตะกร้า');
    expect(rowCount()).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันล้างตะกร้า' }));

    expect(rowCount()).toBe(0);
    expect(subtotalText()).toBe('฿0.00');
    expect(itemCountText()).toBe('0 รายการ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 & 9. What the screen must NOT offer
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — what never reaches the screen', () => {
  it('withholds the unpriced variant and the retired one', () => {
    render(<SalesTerminalView />);

    // นมสด is active and categorised and has no price row in the snapshot. A
    // tile at ฿0.00 would be a claim about a price nobody set, and it would be
    // tappable. ซุปมิโสะ is perfectly priced and retired, which is the harder
    // case: unpriced and inactive are different facts.
    expect(hasTile('นมสด')).toBe(false);
    expect(hasTile('ซุปมิโสะ')).toBe(false);
    // Scoped to the TERMINAL rather than to `data-testid="catalog-grid"`: the
    // withheld-items warning is a chip in the browser's search row, which sits
    // above the grid instead of inside it. `getByRole('status')` is unscoped
    // within that scope on purpose — it is the only status region on this screen,
    // so a second one anywhere under the terminal would still fail here.
    expect(within(terminal()).getByRole('status').textContent).toContain(
      'ซ่อนเมนูไว้ 2 รายการ',
    );
  });

  it('renders NO second menu beside the grid', () => {
    // THIS IMPLEMENTATION RENDERS NONE — zero groups named "แคตตาล็อก", not
    // one. The screen hands `CartView` an empty catalogue and `CartView` draws
    // no catalogue strip for an empty one, so the eight drinks are sellable from
    // exactly one place on the page. A second strip would be a second menu with
    // a second set of identical buttons and no way to tell them apart.
    render(<SalesTerminalView />);

    expect(screen.queryAllByRole('group', { name: 'แคตตาล็อก' })).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Money integrity across the whole screen
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — money never drifts', () => {
  it('totals nine taps of ฿45.50 at exactly ฿409.50', () => {
    // A float would fail this. ฿45.50 is 45.5 in binary, which no double holds
    // exactly; nine additions land near 409.5 and not on it, and the rendered
    // text would show the gap. Integer satang has no gap to find: 4550 × 9 is
    // 40950, so ฿409.50 is the only string the screen can produce.
    //
    // It is also the indirect type check. The values under those prices are
    // integer satang counts — a `number` that happened to sum correctly here
    // would still be a float the moment a price arrived as 45.505.
    render(<SalesTerminalView />);

    sell('กาแฟลาเต้');
    for (let i = 0; i < 8; i += 1) {
      sell('กาแฟลาเต้');
    }

    expect(quantityOf('กาแฟลาเต้')).toBe('9');
    expect(subtotalText()).toBe('฿409.50');
  });

  it('renders two decimal places everywhere it shows an amount', () => {
    render(<SalesTerminalView />);
    sell('ชาไทย'); // ฿35.00

    // Every ฿figure this screen renders, not just the total: the order total in
    // the breakdown, the VAT row above it, and the line total on the row.
    expect(subtotalText()).toMatch(/^฿\d+\.\d{2}$/);
    for (const text of screen.getAllByText(/^฿/)) {
      expect(text.textContent).toMatch(/^฿\d+\.\d{2}$/);
    }
    expect(tile('ชาไทย').textContent).toMatch(/฿\d+\.\d{2}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The shell around the wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — the screen around the basket', () => {
  it('is named, headed and reachable as a landmark', () => {
    render(<SalesTerminalView />);

    // Queried from `screen`, not from `within(terminal())`: a scoped query only
    // searches DESCENDANTS of its container, and the landmark is the container.
    // A `main` with a Thai name is what tells a screen reader which of a till's
    // several surfaces this is.
    expect(screen.getByRole('main', { name: 'หน้าขาย' })).toBeDefined();
    expect(within(terminal()).getByRole('heading', { name: 'หน้าขาย' })).toBeDefined();
  });

  it('records the fulfilment choice, and only that', async () => {
    // ONE repository for the whole test. Building it twice would give the
    // screen a repository and the assertions a different one, and the
    // `saved` array being checked would not be the one the screen wrote to.
    const repo = recordingRepository();
    render(
      <SalesTerminalView
        repository={repo.repo}
        terminalIdentity={{ terminalId: '018f3c2a-0000-7000-8000-000000000001', branchId: '018f3c2b-0000-7000-8000-000000000002' }}
      />,
    );

    // The customer and table are STILL labels and nothing else — there is no
    // order entity to read them from, and this assertion is here so a future
    // change which quietly wires one of them has to come back and say so.
    expect(within(terminal()).getByText('ลูกค้า: ลูกค้าทั่วไป')).toBeDefined();
    expect(within(terminal()).getByText('โต๊ะที่ 4')).toBeDefined();

    // A PAIR OF MUTUALLY EXCLUSIVE CHOICES IS A RADIO GROUP. Asserted as radios
    // deliberately: two buttons with `aria-pressed` would announce "two
    // independent toggles", and a cashier hearing that cannot tell whether the
    // customer is seated or packing.
    const dineIn = within(terminal()).getByRole('radio', { name: 'ทานที่ร้าน' });
    const takeaway = within(terminal()).getByRole('radio', { name: 'ห่อกลับบ้าน' });
    expect(dineIn).toHaveProperty('checked', true);
    expect(takeaway).toHaveProperty('checked', false);

    // It must change the basket NOTHING — the basket is money, and how the food
    // is handed over says nothing about what it costs. This is the half of the
    // old test that survives: choosing ห่อกลับบ้าน must leave ฿45.50 alone.
    sell('กาแฟลาเต้');
    fireEvent.click(takeaway);

    expect(takeaway).toHaveProperty('checked', true);
    expect(dineIn).toHaveProperty('checked', false);
    expect(subtotalText()).toBe('฿45.50');

    // And it must reach the payload — the reason this is not another label.
    // A toggle that looked wired but committed nothing is the exact failure this
    // assertion exists to prevent.
    fireEvent.click(within(terminal()).getByRole('button', { name: /ชำระเงิน/ }));
    await waitFor(() => expect(repo.saved).toHaveLength(1));
    expect(repo.saved[0]!.order.orderType).toBe('takeaway');
  });

  it('counts cups from the domain, not from the number of rows', () => {
    render(<SalesTerminalView />);

    sell('กาแฟลาเต้');
    sell('กาแฟลาเต้');
    sell('กาแฟลาเต้'); // one line…
    sell('มอคค่า'); // …and a second one

    // Two rows, four cups. A screen counting rows would say 2; `totalUnits`
    // says what a customer would actually be handed.
    expect(rowCount()).toBe(2);
    expect(itemCountText()).toBe('4 รายการ');
    expect(subtotalText()).toBe('฿196.50');
  });
});

describe('SalesTerminalView — terminal identity', () => {
  it('shows loading banner while identity is being fetched', async () => {
    // Use a promise that resolves synchronously to test the state update flow
    const getTerminalIdentity = () => Promise.resolve({ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID });
    render(<SalesTerminalView getTerminalIdentity={getTerminalIdentity} />);

    // Loading banner should be visible initially (identityLoading starts true)
    const loadingBanner = screen.getByTestId('identity-loading-banner');
    expect(loadingBanner.textContent).toBe('กำลังโหลดข้อมูลเครื่อง…');
    // Cart is empty initially, so pay button is disabled
    expect(screen.getByTestId('pay-button')).toHaveProperty('disabled', true);

    // Add an item to the cart
    sell('กาแฟลาเต้');

    // Wait for the promise to resolve and state to update - wait for button to be enabled (stable state)
    // Use longer timeout to account for React 18 Strict Mode double-mount cycles
    await waitFor(() => expect(screen.getByTestId('pay-button')).toHaveProperty('disabled', false), { timeout: 3000 });
  });

  it('shows error banner and disables pay when identity fails to load', async () => {
    const getTerminalIdentity = () => Promise.resolve().then(() => {
      throw new Error('WAL_ASRI_TERMINAL_ID is not set; this command never invents an identity — launch the terminal with it configured');
    });
    render(<SalesTerminalView getTerminalIdentity={getTerminalIdentity} />);

    // Wait for error to be caught by useEffect
    await waitFor(() => expect(screen.getByTestId('identity-error-banner')).toBeDefined(), { timeout: 3000 });
    const errorBanner = screen.getByTestId('identity-error-banner');
    expect(errorBanner.textContent).toContain('ยังไม่ได้ตั้งค่าเครื่อง — เรียกผู้ดูแลระบบ');
    expect(screen.getByTestId('pay-button')).toHaveProperty('disabled', true);

    // Basket should still be usable — add items, clear, etc.
    sell('กาแฟลาเต้');
    expect(rowCount()).toBe(1);
    pressCartButton('ล้างตะกร้า');
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันล้างตะกร้า' }));
    expect(rowCount()).toBe(0);
  });

  it('uses loaded identity in both order and outbox payload', async () => {
    const { repo, saved } = recordingRepository();

    // Use pre-resolved terminalIdentity prop to avoid Strict Mode remount issues
    // Async loading is tested by the previous two tests
    render(<SalesTerminalView repository={repo} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);

    // Add item to cart FIRST (button disabled when cart empty)
    sell('กาแฟลาเต้');

    // Pay button should be enabled immediately (no async loading)
    await waitFor(() => expect(screen.getByTestId('pay-button')).toHaveProperty('disabled', false), { timeout: 3000 });

    fireEvent.click(screen.getByTestId('pay-button'));
    await waitFor(() => expect(saved).toHaveLength(1));

    // Check order has the loaded identity (order uses camelCase)
    expect(saved[0]!.order.terminalId).toBe(TEST_TERMINAL_ID);
    expect(saved[0]!.order.branchId).toBe(TEST_BRANCH_ID);

    // Check outbox payload has the SAME identity (payload uses snake_case per server contract)
    const outboxPayload = JSON.parse(saved[0]!.outbox.payload);
    expect(outboxPayload.terminal_id).toBe(TEST_TERMINAL_ID);
    expect(outboxPayload.branch_id).toBe(TEST_BRANCH_ID);
  });
});

describe('SalesTerminalView — held orders (amount mismatches)', () => {
  const HELD_ORDER: HeldOrderMismatch = {
    localReceiptNumber: 'R-42',
    orderId: '018f3c2a-0000-7000-8000-000000000099',
    claimedSubtotalSatang: 4550n,
    authoritativeSubtotalSatang: 4800n,
    claimedTotalSatang: 4550n,
    authoritativeTotalSatang: 4800n,
    detectedAt: '2026-10-10T12:00:00.000Z',
  };

  it('shows loading banner while held orders are being fetched', async () => {
    // Use a promise that resolves synchronously to test the state update flow
    const getHeldOrders = () => Promise.resolve([HELD_ORDER]);
    render(<SalesTerminalView getHeldOrders={getHeldOrders} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);

    // Loading banner should be visible initially
    const loadingBanner = screen.getByTestId('held-loading-banner');
    expect(loadingBanner.textContent).toBe('กำลังตรวจสอบออเดอร์ที่ระงับ…');

    // Wait for the final stable state: held orders banner appears (loading is done)
    await waitFor(() => expect(screen.getByTestId('held-orders-banner')).toBeDefined(), { timeout: 3000 });
  });

  it('shows error banner when held orders fetch fails', async () => {
    const getHeldOrders = () => Promise.resolve().then(() => {
      throw new Error('Failed to fetch held orders');
    });
    render(<SalesTerminalView getHeldOrders={getHeldOrders} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);

    await waitFor(() => expect(screen.getByTestId('held-error-banner')).toBeDefined(), { timeout: 3000 });
    const errorBanner = screen.getByTestId('held-error-banner');
    expect(errorBanner.textContent).toContain('ตรวจสอบออเดอร์ที่ระงับไม่สำเร็จ');
  });

  it('shows held orders banner with mismatch details when orders are found', async () => {
    // Use pre-resolved terminalIdentity prop to avoid Strict Mode remount issues
    const getHeldOrders = () => Promise.resolve([HELD_ORDER]);
    render(<SalesTerminalView getHeldOrders={getHeldOrders} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);

    // Wait for held orders banner to appear
    await waitFor(() => expect(screen.getByTestId('held-orders-banner')).toBeDefined(), { timeout: 3000 });

    const banner = screen.getByTestId('held-orders-banner');
    expect(banner.textContent).toContain('พบออเดอร์ที่ระงับ 1 รายการ');
    expect(banner.textContent).toContain('R-42');
    // Claimed vs Authoritative amounts
    expect(banner.textContent).toContain('ยอดที่เครื่องส่ง (Claimed)');
    expect(banner.textContent).toContain('ยอดที่เซิร์ฟเวอร์ยืนยัน (Authoritative)');
    expect(banner.textContent).toContain('฿45.50'); // claimed
    expect(banner.textContent).toContain('฿48.00'); // authoritative
    // Difference
    expect(banner.textContent).toContain('ความต่าง');
    expect(banner.textContent).toContain('฿2.50');
    // Detected timestamp
    expect(banner.textContent).toContain('ตรวจพบเมื่อ');
    // Action text
    expect(banner.textContent).toContain('failed_permanent');
    expect(banner.textContent).toContain('Reconcile');
  });

  it('shows multiple held orders in the banner', async () => {
    const secondOrder: HeldOrderMismatch = {
      ...HELD_ORDER,
      localReceiptNumber: 'R-43',
      orderId: '018f3c2a-0000-7000-8000-000000000100',
      claimedTotalSatang: 9100n,
      authoritativeTotalSatang: 9500n,
    };
    const getHeldOrders = () => Promise.resolve([HELD_ORDER, secondOrder]);
    render(<SalesTerminalView getHeldOrders={getHeldOrders} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);

    await waitFor(() => expect(screen.getByTestId('held-orders-banner')).toBeDefined(), { timeout: 3000 });

    const banner = screen.getByTestId('held-orders-banner');
    expect(banner.textContent).toContain('พบออเดอร์ที่ระงับ 2 รายการ');
    expect(banner.textContent).toContain('R-42');
    expect(banner.textContent).toContain('R-43');
  });

  it('does not show held orders banner when no held orders', async () => {
    // Use a promise that resolves synchronously
    const getHeldOrders = () => Promise.resolve([]);
    render(<SalesTerminalView getHeldOrders={getHeldOrders} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);

    // Wait for the final stable state: no held orders banner, no loading banner
    // We wait for either the held orders banner to appear (it shouldn't) or for a timeout
    // then verify neither banner is present
    await waitFor(() => {
      const loadingBanner = screen.queryByTestId('held-loading-banner');
      const heldBanner = screen.queryByTestId('held-orders-banner');
      // If loading is done and no held orders banner, we're in the final state
      if (loadingBanner === null && heldBanner === null) {
        return;
      }
      // Otherwise, wait longer
      throw new Error('Not in final state yet');
    }, { timeout: 3000, interval: 100 });

    // Verify final state
    expect(screen.queryByTestId('held-loading-banner')).toBeNull();
    expect(screen.queryByTestId('held-orders-banner')).toBeNull();
  });

  it('allows basket interaction while held orders banner is visible', async () => {
    const getHeldOrders = () => Promise.resolve([HELD_ORDER]);
    render(<SalesTerminalView getHeldOrders={getHeldOrders} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);

    await waitFor(() => expect(screen.getByTestId('held-orders-banner')).toBeDefined(), { timeout: 3000 });

    // Basket should still be usable
    sell('กาแฟลาเต้');
    expect(rowCount()).toBe(1);
    pressCartButton('ล้างตะกร้า');
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันล้างตะกร้า' }));
    expect(rowCount()).toBe(0);
  });
});
