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
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { SalesTerminalView } from './SalesTerminalView';

// Unmount between tests. Without this, a mounted tree from a previous test keeps
// its DOM and `screen.getByRole` finds the first of several matches.
afterEach(() => {
  cleanup();
});

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

/** How many tiles the grid is offering. */
function tileCount(): number {
  return within(grid()).queryAllByRole('button').length;
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

/** The cart's own subtotal, exactly as rendered. */
function subtotalText(): string {
  return within(cartPanel()).getByTestId('cart-subtotal').textContent ?? '';
}

/** The screen header's subtotal — the same number, read from the other end. */
function headerSubtotalText(): string {
  return within(terminal()).getByTestId('sales-subtotal').textContent ?? '';
}

/** The screen header's item count, from the domain's `totalUnits`. */
function itemCountText(): string {
  return within(terminal()).getByTestId('sales-item-count').textContent ?? '';
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
    expect(subtotalText()).toBe('฿45.50');
    expect(headerSubtotalText()).toBe('฿45.50');
  });

  it('keeps the SKU the catalog gave, so the line can be matched to a shelf', () => {
    render(<SalesTerminalView />);
    sell('มอคค่า');

    expect(cartRow('มอคค่า')?.textContent).toContain('BEV-MOCHA-12');
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

    pressCartButton('ล้างตะกร้า');

    expect(rowCount()).toBe(0);
    expect(subtotalText()).toBe('฿0.00');
    expect(headerSubtotalText()).toBe('฿0.00');
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
    expect(within(grid()).getByRole('status').textContent).toContain('ซ่อนเมนูไว้ 2 รายการ');
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
    expect(headerSubtotalText()).toBe('฿409.50');
  });

  it('renders two decimal places everywhere it shows an amount', () => {
    render(<SalesTerminalView />);
    sell('ชาไทย'); // ฿35.00

    expect(subtotalText()).toMatch(/^฿\d+\.\d{2}$/);
    expect(headerSubtotalText()).toMatch(/^฿\d+\.\d{2}$/);
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

  it('shows the placeholder order context, wired to nothing', () => {
    render(<SalesTerminalView />);

    // Presentational only: no state, no handler, no domain behind any of it.
    // Asserted so that a future change which quietly gives one of these a
    // behaviour has to come back here and say so out loud.
    expect(within(terminal()).getByText('ลูกค้า: ลูกค้าทั่วไป')).toBeDefined();
    expect(within(terminal()).getByText('โต๊ะที่ 4')).toBeDefined();
    expect(within(terminal()).getByRole('button', { name: 'ทานที่ร้าน' })).toBeDefined();
    expect(within(terminal()).getByRole('button', { name: 'ห่อกลับบ้าน' })).toBeDefined();

    // Pressing one of them must not change the basket, because the basket is
    // the only thing on this screen that is wired to anything.
    sell('กาแฟลาเต้');
    fireEvent.click(within(terminal()).getByRole('button', { name: 'ห่อกลับบ้าน' }));
    expect(subtotalText()).toBe('฿45.50');
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
