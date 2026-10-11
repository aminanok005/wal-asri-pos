/**
 * CartView component tests.
 *
 * These exercise the REAL component against the REAL domain. Nothing is
 * mocked, because the point of the architecture is that the domain is pure and
 * needs no mocking to be tested through a UI.
 *
 * A failure here means the cashier would see the wrong number, so the money
 * assertions below read the rendered text exactly as a human would — if the
 * screen says ฿151.00, that is what the test asserts.
 *
 * Requires the simulated DOM from `test/setup-dom.ts`, registered in
 * `bunfig.toml` under `[test] preload`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { CartView } from './CartView';

// Unmount between tests. Without this, a mounted tree from a previous test
// keeps its DOM and `screen.getByText` finds the first of several matches.
afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Interaction helpers
//
// `fireEvent` is used rather than `element.click()`. This is not a style
// preference: React 19 batches state updates, and a raw DOM `.click()` invoked
// from test code sits outside React's act() scope, so the resulting re-render
// is not flushed before the assertion runs. The click appears to do nothing —
// the DOM still shows an empty cart. `fireEvent` dispatches through React's own
// event system and the update is applied synchronously, which is what makes
// these assertions trustworthy.
//
// Every element is located the way a user would find it: by visible text or by
// its accessible name, never by test id or CSS selector.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The unit count beside the heading, e.g. "3 รายการ".
 *
 * THE PANEL NO LONGER SHOWS A TOTAL, and that is the shape this file now tests:
 * the basket says what is IN it, and the order total lives once in the checkout
 * breakdown. What replaced the old `subtotalText()` helper is this — plus
 * `lineTotalOf` for the one figure per row the panel is still answerable for.
 */
function countText(): string {
  return screen.getByTestId('cart-item-count').textContent ?? '';
}

/**
 * The line total rendered on one row, e.g. "฿91.00".
 *
 * Located through the row's own hook rather than by its text: a row carries two
 * ฿figures — the unit price and the line total — and they are the same string
 * whenever the quantity is 1, which is exactly the case most of these tests are
 * in. Text alone cannot tell them apart.
 */
function lineTotalOf(itemName: string): string {
  const row = cartRow(itemName);
  if (row === null) {
    throw new Error(`no cart row for ${itemName}`);
  }
  return within(row).getByTestId('cart-line-total').textContent ?? '';
}

/**
 * The catalogue region — the buttons that ADD an item.
 *
 * Every lookup below is scoped to the region it belongs to, and this one is
 * why. A product's name appears on its catalogue button *and* on the quantity
 * and remove controls of its cart row, so an unscoped query matches several
 * elements the moment the item is in the cart. That is true for a cashier
 * reading the screen too: "กาแฟลาเต้" is not one control, it is four.
 */
function catalogue(): HTMLElement {
  return screen.getByRole('group', { name: 'แคตตาล็อก' });
}

/** The cart's line list, or `null` while the cart is empty. */
function cartList(): HTMLElement | null {
  return screen.queryByRole('list');
}

/** The rendered cart row for a line, or `null` when the line is not in the cart. */
function cartRow(itemName: string): HTMLElement | null {
  const list = cartList();
  if (list === null) {
    return null;
  }
  return within(list).queryByText(itemName)?.closest('li') ?? null;
}

/** Add a catalogue item by its visible Thai name. */
function addItem(name: string): void {
  fireEvent.click(within(catalogue()).getByRole('button', { name: new RegExp(name) }));
}

/** Press the + button on a cart line, found by its accessible name. */
function increment(itemName: string): void {
  fireEvent.click(screen.getByRole('button', { name: `เพิ่มจำนวน ${itemName}` }));
}

/** Press the − button on a cart line, found by its accessible name. */
function decrement(itemName: string): void {
  fireEvent.click(screen.getByRole('button', { name: `ลดจำนวน ${itemName}` }));
}

/** Press a button by its exact accessible name. */
function press(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** The displayed quantity for a cart line. */
function quantityOf(itemName: string): string {
  const row = cartRow(itemName);
  if (row === null) {
    throw new Error(`no cart row for ${itemName}`);
  }
  return within(row).getByText(/^\d+$/).textContent ?? '';
}

/** How many cart rows are on screen. */
function rowCount(): number {
  return screen.queryAllByRole('listitem').length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Initial render
// ─────────────────────────────────────────────────────────────────────────────

describe('CartView — initial render', () => {
  it('shows an empty cart and a zero count beside the heading', () => {
    render(<CartView />);

    // The empty state is explicit, not a blank panel.
    expect(screen.getByText('ยังไม่มีสินค้าในตะกร้า')).toBeDefined();
    expect(rowCount()).toBe(0);

    // Zero is a measured value here, and it is a COUNT — the panel states how
    // many things are in the basket and nothing about what they cost.
    expect(countText()).toBe('0 รายการ');
    expect(screen.queryByTestId('cart-line-total')).toBeNull();
  });

  it('lists the catalogue with prices derived from satang', () => {
    render(<CartView />);

    // ฿45.50 comes from 4550 satang — the price went through the Money VO,
    // so it cannot have been produced by float arithmetic.
    expect(screen.getByRole('button', { name: /กาแฟลาเต้/ }).textContent).toContain('฿45.50');
    expect(screen.getByRole('button', { name: /มอคค่า/ }).textContent).toContain('฿60.00');
    expect(screen.getByRole('button', { name: /ชาไทย/ }).textContent).toContain('฿35.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Increment
// ─────────────────────────────────────────────────────────────────────────────

describe('CartView — adding and incrementing', () => {
  it('adds a line and shows its unit price and line total', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');

    expect(rowCount()).toBe(1);
    expect(quantityOf('กาแฟลาเต้')).toBe('1');
    expect(countText()).toBe('1 รายการ');
    expect(lineTotalOf('กาแฟลาเต้')).toBe('฿45.50');
  });

  it('updates the quantity and the line total when + is pressed', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');

    increment('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('2');
    expect(countText()).toBe('2 รายการ');
    expect(lineTotalOf('กาแฟลาเต้')).toBe('฿91.00');

    increment('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('3');
    expect(countText()).toBe('3 รายการ');
    expect(lineTotalOf('กาแฟลาเต้')).toBe('฿136.50');
  });

  it('accumulates nine units with no float drift', () => {
    // The classic failure is 0.1 + 0.2 !== 0.30. Nine 45.50 units must come to
    // ฿409.50 exactly; a float would drift here. With a single line in the basket
    // the line total and the old subtotal are the same figure, so this keeps its
    // whole claim while reading what the panel now renders.
    render(<CartView />);
    addItem('กาแฟลาเต้');

    for (let i = 0; i < 8; i += 1) {
      increment('กาแฟลาเต้');
    }

    expect(quantityOf('กาแฟลาเต้')).toBe('9');
    expect(countText()).toBe('9 รายการ');
    expect(lineTotalOf('กาแฟลาเต้')).toBe('฿409.50');
  });

  it('merges a repeated scan into ONE line, not many', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('กาแฟลาเต้');
    addItem('กาแฟลาเต้');

    expect(rowCount()).toBe(1);
    expect(quantityOf('กาแฟลาเต้')).toBe('3');
    expect(countText()).toBe('3 รายการ');
    expect(lineTotalOf('กาแฟลาเต้')).toBe('฿136.50');
  });

  it('totals each line exactly, whatever else is in the basket', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้'); // ฿45.50
    addItem('มอคค่า'); // ฿60.00
    addItem('ชาไทย'); // ฿35.00

    expect(rowCount()).toBe(3);
    expect(countText()).toBe('3 รายการ');

    // Per LINE, not for the basket. Adding two more drinks must not move the
    // ฿45.50 beside the latte — which is the property the old order-subtotal
    // assertion used to cover, and the reason these figures are read from a row.
    expect(lineTotalOf('กาแฟลาเต้')).toBe('฿45.50');
    expect(lineTotalOf('มอคค่า')).toBe('฿60.00');
    expect(lineTotalOf('ชาไทย')).toBe('฿35.00');

    increment('ชาไทย'); // ฿35.00 × 2
    expect(lineTotalOf('ชาไทย')).toBe('฿70.00');
    expect(lineTotalOf('กาแฟลาเต้')).toBe('฿45.50');
    expect(countText()).toBe('4 รายการ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Decrement / remove
// ─────────────────────────────────────────────────────────────────────────────

describe('CartView — decrement and remove', () => {
  it('decrements one unit at a time', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    increment('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('2');

    decrement('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('1');
    expect(countText()).toBe('1 รายการ');
    expect(lineTotalOf('กาแฟลาเต้')).toBe('฿45.50');
  });

  it('REMOVES the row when the quantity reaches zero — the domain rule', () => {
    // This is the behaviour being locked in. `updateQuantity(0)` deletes the
    // line. The component does not implement that; it calls the domain and
    // renders whatever comes back. The row disappearing is the domain's rule
    // showing through, not a UI decision.
    render(<CartView />);
    addItem('กาแฟลาเต้');
    expect(rowCount()).toBe(1);

    decrement('กาแฟลาเต้');

    expect(rowCount()).toBe(0);
    expect(cartRow('กาแฟลาเต้')).toBeNull();
    expect(countText()).toBe('0 รายการ');
    expect(screen.getByText('ยังไม่มีสินค้าในตะกร้า')).toBeDefined();
  });

  it('removes only the decremented row, leaving other lines intact', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('มอคค่า');
    expect(rowCount()).toBe(2);

    decrement('กาแฟลาเต้');

    expect(rowCount()).toBe(1);
    expect(cartRow('กาแฟลาเต้')).toBeNull();
    expect(cartRow('มอคค่า')).not.toBeNull();
    expect(lineTotalOf('มอคค่า')).toBe('฿60.00');
    expect(countText()).toBe('1 รายการ');
  });

  it('removes a line via the delete button', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('ชาไทย');

    // The delete button now uses an icon with aria-label
    press('ลบ กาแฟลาเต้');

    expect(rowCount()).toBe(1);
    expect(lineTotalOf('ชาไทย')).toBe('฿35.00');
    expect(countText()).toBe('1 รายการ');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Clearing is CONFIRMED
//
// Clearing destroys every line in the basket and there is no undo, so the button
// arms a question rather than acting. These lock in both branches, because the
// one worth having a test for is the branch where the cashier said NO — and with
// a native `window.confirm` that branch would be unreachable from here at all.
// ─────────────────────────────────────────────────────────────────────────────

describe('CartView — clearing the basket asks first', () => {
  it('a first press ARMS the question and keeps every line', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('มอคค่า');
    expect(rowCount()).toBe(2);

    press('ล้างตะกร้า');

    // The whole point: one press is not a clear. A till gets fat-fingered.
    expect(rowCount()).toBe(2);
    expect(countText()).toBe('2 รายการ');
    expect(screen.getByText('ล้างสินค้าทั้งหมดในตะกร้าใช่ไหม')).toBeDefined();
  });

  it('cancelling leaves the basket exactly as it was', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('มอคค่า');

    press('ล้างตะกร้า');
    press('ยกเลิก');

    // The branch a native confirm could never have been tested for.
    expect(rowCount()).toBe(2);
    expect(countText()).toBe('2 รายการ');
    expect(lineTotalOf('มอคค่า')).toBe('฿60.00');
    expect(screen.queryByText('ล้างสินค้าทั้งหมดในตะกร้าใช่ไหม')).toBeNull();
  });

  it('confirming empties the basket', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('มอคค่า');
    expect(rowCount()).toBe(2);

    press('ล้างตะกร้า');
    press('ยืนยันล้างตะกร้า');

    expect(rowCount()).toBe(0);
    expect(countText()).toBe('0 รายการ');
    expect(screen.getByText('ยังไม่มีสินค้าในตะกร้า')).toBeDefined();
    expect(screen.queryByText('ล้างสินค้าทั้งหมดในตะกร้าใช่ไหม')).toBeNull();
  });

  it('names the dialog and its two answers, so neither is ambiguous', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    press('ล้างตะกร้า');

    const dialog = screen.getByRole('alertdialog');
    // `alertdialog` and not `dialog`: this interrupts, and it is about a
    // destructive act with no undo.
    expect(dialog.getAttribute('aria-labelledby')).toBe('cart-clear-question');
    expect(document.getElementById('cart-clear-question')?.textContent).toBe(
      'ล้างสินค้าทั้งหมดในตะกร้าใช่ไหม',
    );

    // The three buttons in the panel are now THREE different names. "ล้างตะกร้า"
    // naming both the arm and the act would be unreadable out loud.
    expect(screen.getByRole('button', { name: 'ล้างตะกร้า' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'ยกเลิก' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'ยืนยันล้างตะกร้า' })).toBeDefined();
  });

  it('an emptied basket has nothing to confirm, and asks nothing', () => {
    render(<CartView />);

    // Disabled, so the prompt cannot be armed over an empty basket.
    expect(screen.getByRole('button', { name: 'ล้างตะกร้า' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('the prompt disappears if the basket empties underneath it', () => {
    // The prompt must not outlive its own subject. `commit` writes to the PARENT
    // in controlled mode, and a parent that swaps the customer mid-prompt empties
    // the basket without going through this component at all — so the render
    // asks `empty` itself rather than trusting that the armed flag is still
    // meaningful. A prompt left standing would offer to confirm a clear that had
    // already happened.
    render(<CartView />);
    addItem('กาแฟลาเต้');
    press('ล้างตะกร้า');
    expect(screen.queryByRole('alertdialog')).not.toBeNull();

    // Empty it by an unrelated route while the question is open.
    press('ลบ กาแฟลาเต้');

    expect(rowCount()).toBe(0);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Money integrity on screen
// ─────────────────────────────────────────────────────────────────────────────

describe('CartView — money integrity on screen', () => {
  it('always renders exactly two decimal places', () => {
    render(<CartView />);
    addItem('ชาไทย'); // ฿35.00
    expect(lineTotalOf('ชาไทย')).toBe('฿35.00');

    increment('ชาไทย');
    increment('ชาไทย');
    const total = lineTotalOf('ชาไทย');
    expect(total).toBe('฿105.00');

    expect(total).toMatch(/^฿\d+\.\d{2}$/);
  });

  it('shows unit price and line total separately on each row', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    increment('กาแฟลาเต้');

    const row = cartRow('กาแฟลาเต้');
    expect(row).not.toBeNull();

    // Check for unit price and line total — SKU is now hidden.
    // The row contains: name, quantity x unit price, line total.
    const text = row?.textContent ?? '';
    expect(text).toContain('฿45.50'); // unit price
    expect(text).toContain('฿91.00'); // line total (× 2)
    // SKU is hidden in round A
  });
});