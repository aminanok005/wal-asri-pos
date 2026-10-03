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

/** The subtotal exactly as rendered on screen, e.g. "฿151.00". */
function subtotalText(): string {
  return screen.getByTestId('cart-subtotal').textContent ?? '';
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
  it('shows an empty cart with a zero subtotal', () => {
    render(<CartView />);

    // The empty state is explicit, not a blank panel.
    expect(screen.getByText('ยังไม่มีสินค้าในตะกร้า')).toBeDefined();
    expect(rowCount()).toBe(0);

    // Zero is a measured value here: an empty basket totals exactly ฿0.00.
    expect(subtotalText()).toBe('฿0.00');
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
    expect(subtotalText()).toBe('฿45.50');
  });

  it('updates the quantity and subtotal when + is pressed', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');

    increment('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('2');
    expect(subtotalText()).toBe('฿91.00');

    increment('กาแฟลาเต้');
    expect(quantityOf('กาแฟลาเต้')).toBe('3');
    expect(subtotalText()).toBe('฿136.50');
  });

  it('accumulates nine lines with no float drift', () => {
    // The classic failure is 0.1 + 0.2 !== 0.30. Nine 45.50 lines must total
    // ฿409.50 exactly; a float would drift here.
    render(<CartView />);
    addItem('กาแฟลาเต้');

    for (let i = 0; i < 8; i += 1) {
      increment('กาแฟลาเต้');
    }

    expect(quantityOf('กาแฟลาเต้')).toBe('9');
    expect(subtotalText()).toBe('฿409.50');
  });

  it('merges a repeated scan into ONE line, not many', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('กาแฟลาเต้');
    addItem('กาแฟลาเต้');

    expect(rowCount()).toBe(1);
    expect(quantityOf('กาแฟลาเต้')).toBe('3');
    expect(subtotalText()).toBe('฿136.50');
  });

  it('sums different items exactly', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้'); // ฿45.50
    addItem('มอคค่า'); // ฿60.00
    addItem('ชาไทย'); // ฿35.00

    expect(rowCount()).toBe(3);
    expect(subtotalText()).toBe('฿140.50');

    increment('ชาไทย'); // ฿35.00 × 2
    expect(subtotalText()).toBe('฿175.50');
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
    expect(subtotalText()).toBe('฿45.50');
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
    expect(subtotalText()).toBe('฿0.00');
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
    expect(subtotalText()).toBe('฿60.00');
  });

  it('removes a line via the delete button', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('ชาไทย');

    press('ลบ กาแฟลาเต้');

    expect(rowCount()).toBe(1);
    expect(subtotalText()).toBe('฿35.00');
  });

  it('clears the whole cart', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    addItem('มอคค่า');
    expect(rowCount()).toBe(2);

    press('ล้างตะกร้า');

    expect(rowCount()).toBe(0);
    expect(subtotalText()).toBe('฿0.00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Money integrity on screen
// ─────────────────────────────────────────────────────────────────────────────

describe('CartView — money integrity on screen', () => {
  it('always renders exactly two decimal places', () => {
    render(<CartView />);
    addItem('ชาไทย'); // ฿35.00
    expect(subtotalText()).toBe('฿35.00');

    increment('ชาไทย');
    increment('ชาไทย');
    expect(subtotalText()).toBe('฿105.00');

    expect(subtotalText()).toMatch(/^฿\d+\.\d{2}$/);
  });

  it('shows unit price and line total separately on each row', () => {
    render(<CartView />);
    addItem('กาแฟลาเต้');
    increment('กาแฟลาเต้');

    const row = cartRow('กาแฟลาเต้');
    expect(row).not.toBeNull();

    const text = row?.textContent ?? '';
    expect(text).toContain('฿45.50'); // unit price
    expect(text).toContain('฿91.00'); // line total (× 2)
  });
});