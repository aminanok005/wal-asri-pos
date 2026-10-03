/**
 * CatalogGrid component tests.
 *
 * These render the REAL grid over a REAL resolved index built by the REAL domain
 * from the demo snapshot. Nothing is mocked, because the claim under test is
 * precisely that the UI cannot invent a menu: if the grid could, a mocked index
 * would be the only thing that could catch it.
 *
 * A failure here means a cashier is shown the wrong price, or is shown a drink
 * that cannot be charged for. So the money assertions read the rendered text
 * exactly as a human would — if the tile says ฿45.50, that is what is asserted.
 *
 * Requires the simulated DOM from `test/setup-dom.ts`, registered in
 * `bunfig.toml` under `[test] preload`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { Money } from '../../payments/domain/money';
import { buildCatalog, findEntry } from '../domain/catalog';
import type { CatalogEntry, CatalogIndex, UuidV7 } from '../domain/catalog';
import { CatalogGrid } from './CatalogGrid';
import * as demoCatalog from './demoCatalog';

// Unmount between tests. Without this, a mounted tree from a previous test keeps
// its DOM and `screen.getByRole` finds the first of several matches.
afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Interaction notes
//
// `fireEvent` is used rather than `element.click()`, for the reason the cart
// tests give: React 19 batches state updates, and a raw DOM `.click()` invoked
// from test code sits outside React's act() scope, so the re-render is not flushed
// before the assertion runs and the click appears to do nothing.
//
// Every element is located the way a user would find it — by accessible name or
// by visible text. The one exception is the grid container itself, which is found
// by `data-testid`: it is a layout box with no name of its own, and the tests
// need to scope their queries to the grid rather than to the whole page.
// ─────────────────────────────────────────────────────────────────────────────

/** A grid with the given index, an inert selection handler unless overridden. */
function renderGrid(index: CatalogIndex, onSelect?: (entry: CatalogEntry) => void): void {
  const handler = onSelect ?? ((): void => {});
  render(<CatalogGrid index={index} onSelect={handler} />);
}

/** The grid container. */
function grid(): HTMLElement {
  return screen.getByTestId('catalog-grid');
}

/** The tile for an item, found by its accessible name. */
function tile(nameTh: string): HTMLElement {
  return within(grid()).getByRole('button', { name: `เพิ่ม ${nameTh}` });
}

/** Whether an item has a tile at all. */
function hasTile(nameTh: string): boolean {
  return within(grid()).queryByRole('button', { name: `เพิ่ม ${nameTh}` }) !== null;
}

/** Every tile's text, price and SKU included. */
function tileText(nameTh: string): string {
  return tile(nameTh).textContent ?? '';
}

/**
 * How many tiles are on the grid — zero included.
 *
 * `queryAll`, not `getAll`: an empty grid is one of the states under test, and a
 * helper that throws on it would turn "the empty state rendered" into a test that
 * fails for the wrong reason.
 */
function tileCount(): number {
  return within(grid()).queryAllByRole('button').length;
}

/** The withheld-items warning line, or `null` when nothing was withheld. */
function warning(): string | null {
  return screen.queryByText(/ซ่อนเมนูไว้ \d+ รายการ/)?.textContent ?? null;
}

/**
 * Look a fixture row up by predicate, loudly.
 *
 * `noUncheckedIndexedAccess` makes every `find` return `T | undefined`, and
 * silently rendering a grid without its latte would turn a fixture mistake into a
 * passing test about nothing. Throwing here fails the test that made the mistake.
 */
function mustFind<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  description: string,
): T {
  const found = items.find(predicate);
  if (found === undefined) {
    throw new Error(`the demo catalog has no ${description}`);
  }
  return found;
}

/** A demo variant by SKU — the thing a cashier would recognise on a shelf label. */
function variantFor(sku: string): UuidV7 {
  return mustFind(demoCatalog.DEMO_VARIANTS, (v) => v.sku === sku, `variant ${sku}`).id;
}

/** A demo category id by its Thai name, the way a tab is chosen. */
function categoryFor(nameTh: string): UuidV7 {
  return mustFind(
    demoCatalog.DEMO_CATEGORIES,
    (c) => c.name_th === nameTh,
    `category ${nameTh}`,
  ).id;
}

/** The demo snapshot resolved the way the screen would resolve it. */
function resolvedIndex(): CatalogIndex {
  return buildCatalog(demoCatalog.DEMO_SNAPSHOT);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The resolved menu
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogGrid — the resolved menu', () => {
  it('renders one tile per sellable variant, at the price the domain resolved', () => {
    const index = resolvedIndex();
    renderGrid(index);

    // Eight sellable rows out of ten variants: the soup is retired and the milk
    // has no price. Both are absent below; this is the count of what is left.
    expect(index.entries).toHaveLength(8);
    expect(tileCount()).toBe(8);

    expect(tileText('กาแฟลาเต้')).toContain('฿45.50');
    expect(tileText('มอคค่า')).toContain('฿60.00');
    expect(tileText('ชาไทย')).toContain('฿35.00');
    expect(tileText('กาแฟร้อน')).toContain('฿40.00');
    expect(tileText('น้ำเปล่า')).toContain('฿15.00');
    expect(tileText('เบเกอรี่ไก่')).toContain('฿65.00');
    expect(tileText('เค้กกล้วยหอม')).toContain('฿55.00');
    expect(tileText('สมูทตี้เบอร์เกอร์คอมโบ')).toContain('฿99.00');
  });

  it('shows the SKU, so a name on the tile can be matched to a shelf label', () => {
    renderGrid(resolvedIndex());

    expect(tileText('กาแฟลาเต้')).toContain('BEV-LATTE-12');
    expect(tileText('สมูทตี้เบอร์เกอร์คอมโบ')).toContain('CMB-BERRY-01');
  });

  it('does NOT show the variant the price list never mentioned', () => {
    // นมสด is active, categorised and sellable in every respect but one: no
    // `PriceListEntry` exists for it. A tile at ฿0.00 would be a claim about the
    // price that nobody made, and it would be tappable.
    const index = resolvedIndex();
    expect(index.skipped.map((s) => s.reason)).toContain('no_price_entry');

    renderGrid(index);

    expect(hasTile('นมสด')).toBe(false);
    expect(tileText('กาแฟลาเต้')).not.toContain('฿0.00');
  });

  it('does NOT show the retired variant, even though it is perfectly priced', () => {
    // ซุปมิโสะ has a price row in the snapshot. Retired and unpriced are
    // different facts, and only a priced-but-retired row proves the grid tells
    // them apart: a kitchen that kept last winter's soup must not be sellable.
    const index = resolvedIndex();
    expect(index.skipped.map((s) => s.reason)).toContain('inactive_variant');

    renderGrid(index);

    expect(hasTile('ซุปมิโสะ')).toBe(false);
  });

  it('gives every tile an accessible name that is the item and nothing else', () => {
    renderGrid(resolvedIndex());

    const labels = within(grid())
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? '');
    expect(labels).toHaveLength(8);
    for (const label of labels) {
      expect(label).toMatch(/^เพิ่ม /);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Selection
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogGrid — selection', () => {
  it('hands the whole entry back, once, and it is the very entry that was shown', () => {
    const index = resolvedIndex();
    const mochaId = variantFor('BEV-MOCHA-12');
    const selected: CatalogEntry[] = [];

    renderGrid(index, (entry) => {
      selected.push(entry);
    });
    fireEvent.click(tile('มอคค่า'));

    expect(selected).toHaveLength(1);
    // Identity, not equality: the caller must receive the same frozen entry the
    // tile rendered, so the price it hands to the cart is the price on screen.
    expect(selected[0]).toBe(findEntry(index, mochaId));
    expect(selected[0]?.unitPrice.satang).toBe(6000n);
    expect(selected[0]?.variant.sku).toBe('BEV-MOCHA-12');
  });

  it('reports only the tile that was pressed', () => {
    const index = resolvedIndex();
    const selected: CatalogEntry[] = [];

    renderGrid(index, (entry) => {
      selected.push(entry);
    });
    fireEvent.click(tile('ชาไทย'));

    expect(selected).toHaveLength(1);
    expect(selected[0]?.variant.sku).toBe('BEV-THAI-12');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Category filter
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogGrid — category filter', () => {
  it('shows every category when no category is named', () => {
    renderGrid(resolvedIndex());

    expect(tileCount()).toBe(8);
    expect(hasTile('กาแฟลาเต้')).toBe(true);
    expect(hasTile('เค้กกล้วยหอม')).toBe(true);
  });

  it('narrows the grid to one category, and to what that category can sell', () => {
    const index = resolvedIndex();
    render(
      <CatalogGrid index={index} onSelect={() => {}} categoryId={categoryFor('เครื่องดื่ม')} />,
    );

    // Five drinks sell. นมสด is a drink too, but it has no price — so the count is
    // the category's sellable rows, not the category's row count.
    expect(tileCount()).toBe(5);
    expect(hasTile('กาแฟลาเต้')).toBe(true);
    expect(hasTile('น้ำเปล่า')).toBe(true);
    expect(hasTile('เบเกอรี่ไก่')).toBe(false);
    expect(hasTile('นมสด')).toBe(false);
  });

  it('treats an explicit null as the uncategorised bucket, not as no filter', () => {
    // Every demo product has a category, so the bucket is empty — and an empty
    // bucket must read as empty rather than quietly widening to the whole menu.
    const index = resolvedIndex();
    render(<CatalogGrid index={index} onSelect={() => {}} categoryId={null} />);

    expect(tileCount()).toBe(0);
    expect(screen.getByText('ยังไม่มีเมนูที่ขายได้ในหมวดนี้')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Empty states
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogGrid — empty state', () => {
  it('says so explicitly when nothing resolved to a sellable entry', () => {
    // Two price lists and no list named is the one payload the domain refuses:
    // guessing would mean guessing what a customer is charged. Nothing can be
    // priced, so nothing may be sold.
    const index = buildCatalog(demoCatalog.buildDemoSnapshot({ includeSecondPriceList: true }));
    expect(index.priceListId).toBeNull();
    expect(index.entries).toHaveLength(0);

    renderGrid(index);

    expect(tileCount()).toBe(0);
    expect(screen.getByText('ยังไม่มีเมนูที่ขายได้ในหมวดนี้')).toBeDefined();
  });

  it('renders no blank grid: the empty state is text a cashier can act on', () => {
    const index = buildCatalog(demoCatalog.buildDemoSnapshot({ includeSecondPriceList: true }));
    renderGrid(index);

    const empty = screen.getByText('ยังไม่มีเมนูที่ขายได้ในหมวดนี้');
    expect(empty.textContent).not.toBe('');
    // Every variant in the payload was withheld for the same reason, so the
    // warning has to be on screen too — a blank grid alone would look like a bug.
    expect(warning()).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Withheld items
//
// The warning is the difference between a menu that is short and a menu that
// looks fine. These assertions are about the shift lead, not about a number.
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogGrid — withheld items warning', () => {
  it('names the count and every reason, so the menu cannot be quietly short', () => {
    const index = resolvedIndex();
    renderGrid(index);

    const text = warning();
    expect(text).not.toBeNull();
    expect(text).toContain('ซ่อนเมนูไว้ 2 รายการ');
    expect(text).toContain('ปิดการขายแล้ว 1 รายการ');
    expect(text).toContain('ไม่ได้ตั้งราคา 1 รายการ');
  });

  it('stays visible while a category filter narrows the grid', () => {
    // The branch is short of a drink whoever is looking. A warning that vanished
    // with the tab would be a warning that hides exactly when someone switched
    // tabs to check whether the drink was still there.
    const index = resolvedIndex();
    render(
      <CatalogGrid index={index} onSelect={() => {}} categoryId={categoryFor('เครื่องดื่ม')} />,
    );

    expect(warning()).toContain('ซ่อนเมนูไว้ 2 รายการ');
  });

  it('says nothing at all when the snapshot is complete', () => {
    // A warning that is always present stops being read. Nothing withheld, so
    // nothing is rendered — and that absence is what proves the line above is
    // reporting the snapshot rather than decorating the screen.
    const latteId = variantFor('BEV-LATTE-12');
    const lattePrice = mustFind(
      demoCatalog.DEMO_PRICE_LIST_ENTRIES,
      (entry) => entry.product_variant_id === latteId,
      'the latte price row',
    );
    const index = buildCatalog({
      ...demoCatalog.DEMO_SNAPSHOT,
      variants: [mustFind(demoCatalog.DEMO_VARIANTS, (v) => v.id === latteId, 'the latte')],
      price_list_entries: [lattePrice],
    });
    expect(index.skipped).toHaveLength(0);

    renderGrid(index);

    expect(warning()).toBeNull();
    expect(tileCount()).toBe(1);
    expect(tileText('กาแฟลาเต้')).toContain('฿45.50');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Money on the tile
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogGrid — money on the tile', () => {
  it('renders the Money the domain resolved, not a number formatted by the UI', () => {
    const index = resolvedIndex();
    const latteId = variantFor('BEV-LATTE-12');
    const entry = findEntry(index, latteId);
    renderGrid(index);

    // The price on the tile is exactly the `Money.toString()` of the price the
    // grid was handed. A component that had divided satang by 100 itself would
    // produce something else here for any price the float grid could not hold —
    // which is the failure this assertion exists to prevent.
    expect(entry?.unitPrice).toBeInstanceOf(Money);
    expect(entry?.unitPrice.satang).toBe(4550n);
    expect(within(tile('กาแฟลาเต้')).getByText(/^฿\d+\.\d{2}$/).textContent).toBe(
      `฿${entry?.unitPrice.toString()}`,
    );
  });

  it('keeps two decimal places on every tile, whatever the satang count', () => {
    renderGrid(resolvedIndex());

    for (const button of within(grid()).getAllByRole('button')) {
      expect(button.textContent).toMatch(/฿\d+\.\d{2}/);
    }
  });
});
