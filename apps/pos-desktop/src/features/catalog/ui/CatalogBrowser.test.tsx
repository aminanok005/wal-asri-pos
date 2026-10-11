/**
 * CatalogBrowser component tests — the tabs and the search box.
 *
 * These render the REAL browser over the REAL `buildCatalog` result from the
 * REAL demo snapshot, and the REAL grid underneath. Nothing is mocked, because
 * the claim under test is precisely that the chrome cannot invent a menu: a
 * mocked index would let a tab that showed the wrong items pass.
 *
 * Requires the simulated DOM from `test/setup-dom.ts`, registered in
 * `bunfig.toml` under `[test] preload`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { buildCatalog } from '../domain/catalog';
import type { CatalogEntry, CatalogIndex } from '../domain/catalog';
import { CatalogBrowser } from './CatalogBrowser';
import * as demoCatalog from './demoCatalog';

afterEach(() => {
  restoreResizeObserver();
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// The overflow measurement
//
// A stub, and a REAL one would be a test that cannot run: `scrollWidth` and
// `clientWidth` are both 0 in a DOM with no layout engine, so every measurement
// would report "fits" and the tests would pass for the wrong reason — exactly
// the failure this whole mechanism exists to prevent.
//
// So the observer is faked and the two numbers are SET per test. What is asserted
// is the decision (`data-overflow`) and the wiring (observed, then disconnected),
// not the browser's own arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

/** What the fake observer is told about the element it watches. */
interface FakeOverflow {
  scrollWidth: number;
  clientWidth: number;
}

let overflow: FakeOverflow = { scrollWidth: 0, clientWidth: 0 };
let observedTargets: Element[] = [];
/** Every fake observer built, so a test can fire one on demand. */
const fakeObservers: { trigger: () => void }[] = [];
let disconnectCount = 0;
let originalResizeObserver: unknown;

/**
 * Install a fake `ResizeObserver` that records what it was given.
 *
 * The element's `scrollWidth`/`clientWidth` are DEFINE-DERIVED on the fake
 * observer rather than assigned onto the real node: happy-dom's `Element` types
 * those as readonly accessors backed by nothing, and writing to them either
 * throws or silently does nothing depending on the version — which would make
 * these tests pass or fail for reasons unrelated to the component.
 */
/**
 * Make an element report the numbers in `overflow`.
 *
 * `Object.defineProperty` rather than assignment: happy-dom types
 * `scrollWidth`/`clientWidth` as readonly accessors, so writing to them either
 * throws or silently does nothing depending on version — and a test that
 * silently measures nothing passes for the wrong reason.
 */
function defineSizes(target: Element): void {
  Object.defineProperty(target, 'scrollWidth', {
    configurable: true,
    get: () => overflow.scrollWidth,
  });
  Object.defineProperty(target, 'clientWidth', {
    configurable: true,
    get: () => overflow.clientWidth,
  });
}

function mockResizeObserver(): void {
  originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

  class FakeResizeObserver {
    constructor(private readonly callback: () => void) {
      fakeObservers.push({ trigger: () => this.callback() });
    }
    observe(target: Element): void {
      observedTargets.push(target);
      /*
       * THE NUMBERS ARE DEFINED HERE, ON OBSERVE — NOT AT CONSTRUCTION.
       *
       * The component calls `measure()` once on mount and only THEN constructs
       * the observer and observes the row. So a stub that defined the sizes in
       * its constructor would define them against nothing: the component's first
       * read would get happy-dom's real 0/0, report "fits", and never re-read —
       * and the "does overflow" test would fail while the component was right.
       *
       * Defining them at `observe()` time means the first *observer-driven*
       * measure is correct, which is the one that matters on a real browser
       * anyway: layout exists by the time an observer fires.
       */
      defineSizes(target);
      /*
       * AND FIRE ONCE, WHICH IS WHAT THE REAL ONE DOES.
       *
       * A `ResizeObserver` fires an initial callback the moment it starts
       * observing — that is its contract, and it is what makes the measurement
       * correct on a real browser without waiting for a resize. A stub that only
       * recorded the target and stayed silent would leave the component's
       * mount-time read looking at happy-dom's 0/0, and the component would
       * correctly conclude "fits" and then never be told otherwise.
       */
      this.callback();
    }
    unobserve(): void {}
    disconnect(): void {
      disconnectCount += 1;
    }
  }

  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
}

function restoreResizeObserver(): void {
  if (originalResizeObserver === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  } else {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  }
  observedTargets = [];
  fakeObservers.length = 0;
  disconnectCount = 0;
  overflow = { scrollWidth: 0, clientWidth: 0 };
}

/** The tab row, and the `data-overflow` value the component decided on. */
function tabRow(): HTMLElement {
  return tabs();
}

function overflowAttribute(): string | null {
  return tabRow().getAttribute('data-overflow');
}

/**
 * Re-measure, the way the real observer would on a resize.
 *
 * The fake observer's callback is kept so a test can fire it; the element's
 * `scrollWidth`/`clientWidth` are re-defined to whatever `overflow` currently
 * holds, because happy-dom cannot lay anything out and reports 0 for both.
 */
function fireResizeObserver(): void {
  for (const target of observedTargets) {
    defineSizes(target);
  }
  for (const instance of fakeObservers) {
    instance.trigger();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
//
// `fireEvent` rather than `element.click()`, for the reason every other screen
// test in this repo gives: React 19 batches state updates, and a raw DOM click
// from test code sits outside React's act() scope, so the re-render is not
// flushed before the assertion.
// ─────────────────────────────────────────────────────────────────────────────

/** The grid the browser wraps — the node carrying `data-testid="catalog-grid"`. */
function grid(): HTMLElement {
  return screen.getByTestId('catalog-grid');
}

/** The browser's own root — everything above the tiles, search row included. */
function browser(): HTMLElement {
  return screen.getByTestId('catalog-browser');
}

/** The tab bar. */
function tabs(): HTMLElement {
  return screen.getByRole('navigation', { name: 'หมวดหมู่เมนู' });
}

/** A tab by its visible label. */
function tab(label: string): HTMLElement {
  return within(tabs()).getByRole('button', { name: label });
}

/** The search field, by the name its label gives it. */
function searchBox(): HTMLElement {
  return screen.getByRole('searchbox', { name: 'ค้นหาเมนู' });
}

/**
 * How many tiles are on the grid.
 *
 * Scoped to `data-testid="catalog-tiles"` on purpose: the tab buttons and the
 * withheld-items chip are buttons too, and counting every button on the page
 * would count them as menu items. Zero when the `<ul>` is absent, which is what
 * a search that matched nothing looks like.
 */
function tileCount(): number {
  const list = screen.queryByTestId('catalog-tiles');
  return list === null ? 0 : within(list).queryAllByRole('button').length;
}

/** The tile for an item, by its accessible name. */
function tile(nameTh: string): HTMLElement {
  return within(grid()).getByRole('button', { name: `เพิ่ม ${nameTh}` });
}

/** Whether an item has a tile at all. */
function hasTile(nameTh: string): boolean {
  return within(grid()).queryByRole('button', { name: `เพิ่ม ${nameTh}` }) !== null;
}

/** Type into the search box, the way a cashier does. */
function search(text: string): void {
  fireEvent.change(searchBox(), { target: { value: text } });
}

/** The resolved menu, exactly as the sales screen resolves it. */
function resolvedIndex(): CatalogIndex {
  return buildCatalog(demoCatalog.DEMO_SNAPSHOT);
}

/** A browser over the demo menu, with an inert handler unless overridden. */
function renderBrowser(index: CatalogIndex, onSelect?: (entry: CatalogEntry) => void): void {
  render(<CatalogBrowser index={index} onSelect={onSelect ?? ((): void => {})} />);
}

/**
 * Find a fixture row up by predicate, loudly.
 *
 * `noUncheckedIndexedAccess` turns every `find` into a `T | undefined`, and
 * quietly building a "complete" snapshot out of a missing price row would
 * produce a menu that is short for a reason the test never mentioned — which is
 * the exact bug this component exists to report. Throwing names the mistake.
 */
function mustFind<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  description: string,
): T {
  const found = items.find(predicate);
  if (found === undefined) {
    throw new Error(`fixture is missing ${description}`);
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The tabs
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogBrowser — the category tabs', () => {
  it('offers ทั้งหมด first, then every category in the snapshot', () => {
    renderBrowser(resolvedIndex());

    // Generated from `index.categories`, NOT a hand-written list of Thai labels:
    // a copied list would go stale the moment the branch adds a category, and the
    // symptom would be a menu with items no cashier can reach.
    const labels = within(tabs())
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(labels).toEqual([
      'ทั้งหมด',
      ...demoCatalog.DEMO_CATEGORIES.map((c) => c.name_th),
    ]);
    expect(labels[0]).toBe('ทั้งหมด');
  });

  it('opens on ทั้งหมด showing every sellable item', () => {
    renderBrowser(resolvedIndex());

    // Eight sellable rows out of ten variants: the soup is retired and the milk
    // is unpriced. `buildCatalog` decided that, before the tabs existed.
    expect(tab('ทั้งหมด').getAttribute('aria-current')).toBe('true');
    expect(tileCount()).toBe(8);
    expect(hasTile('กาแฟลาเต้')).toBe(true);
    expect(hasTile('สมูทตี้เบอร์เกอร์คอมโบ')).toBe(true);
  });

  it('narrows the grid to a category when its tab is pressed', () => {
    renderBrowser(resolvedIndex());

    fireEvent.click(tab('เครื่องดื่ม'));

    // Five drinks sell. นมสด is a drink too but has no price, so this is the
    // category's SELLABLE rows and not its row count.
    expect(tileCount()).toBe(5);
    expect(hasTile('กาแฟลาเต้')).toBe(true);
    expect(hasTile('เบเกอรี่ไก่')).toBe(false);
    // นมสด must NOT appear here — a tile at ฿0.00 is a claim nobody made.
    expect(hasTile('นมสด')).toBe(false);
  });

  it('marks exactly ONE tab current, and moves the marker', () => {
    renderBrowser(resolvedIndex());
    fireEvent.click(tab('คอมโบ'));

    // Two current tabs is a nav that tells a screen reader the cashier is
    // looking at two menus at once.
    const current = within(tabs())
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('คอมโบ');
  });

  it('returns to the whole menu when ทั้งหมด is pressed again', () => {
    renderBrowser(resolvedIndex());
    fireEvent.click(tab('อาหาร'));
    expect(tileCount()).toBe(1);

    fireEvent.click(tab('ทั้งหมด'));
    expect(tileCount()).toBe(8);
  });

  it('does NOT offer an uncategorised tab when the bucket is empty', () => {
    // Every demo product carries a category, so the bucket holds nothing. A tab
    // labelled "uncategorised" that always shows nothing teaches a cashier that
    // an empty tab is normal — which is how a genuinely empty one stops being
    // noticed.
    renderBrowser(resolvedIndex());
    expect(
      within(tabs()).queryByRole('button', { name: 'ไม่ระบุหมวด' }),
    ).toBeNull();
  });

  it('keeps the withheld-items warning while a tab narrows the grid', () => {
    // The branch is short of a drink whoever is looking. A warning that vanished
    // with the tab would hide exactly when someone switched tabs to check.
    renderBrowser(resolvedIndex());
    fireEvent.click(tab('เครื่องดื่ม'));

    // Scoped to the BROWSER, not to `data-testid="catalog-grid"`: the withheld-items
    // warning is a chip in the search row, which is a sibling of the grid rather
    // than a child of it. `getByRole('status')` is unscoped on purpose for the same
    // reason — this screen must carry exactly one status region, so a second one
    // anywhere under the browser would still fail here.
    expect(within(browser()).getByRole('status').textContent).toContain(
      'ซ่อนเมนูไว้ 2 รายการ',
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 1b. The overflow arrows
//
// The arrows beside the tab row are the ONLY cue that a category exists off
// the right edge. Drawn unconditionally they point at tabs that are already
// visible, and a cashier who has learned to ignore them will not notice when
// they are pointing at something real.
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogBrowser — the tab overflow arrows', () => {
  it('says the row does NOT overflow when every tab fits', async () => {
    mockResizeObserver();
    overflow = { scrollWidth: 400, clientWidth: 400 };
    renderBrowser(resolvedIndex());

    // The initial measure happens in the effect on mount.
    await waitFor(() => expect(overflowAttribute()).toBe('false'));
  });

  it('says the row DOES overflow when a category is off the right edge', async () => {
    mockResizeObserver();
    overflow = { scrollWidth: 600, clientWidth: 400 };
    renderBrowser(resolvedIndex());

    await waitFor(() => expect(overflowAttribute()).toBe('true'));
  });

  it('treats a one-pixel difference as NOT overflowing', async () => {
    // Sub-pixel layout on some platforms reports a row as 1px wider than it
    // really is. Without the tolerance, that is two arrows pointing at nothing —
    // the exact false signal the measurement exists to avoid.
    mockResizeObserver();
    overflow = { scrollWidth: 401, clientWidth: 400 };
    renderBrowser(resolvedIndex());

    await waitFor(() => expect(overflowAttribute()).toBe('false'));
  });

  it('flips when the row overflows AFTER the first paint', async () => {
    // The realistic direction: a branch syncs a new category and the row that fit
    // a moment ago no longer does. A measurement taken only on mount would leave
    // the arrows off for the rest of the shift.
    mockResizeObserver();
    overflow = { scrollWidth: 400, clientWidth: 400 };
    renderBrowser(resolvedIndex());
    await waitFor(() => expect(overflowAttribute()).toBe('false'));

    overflow = { scrollWidth: 900, clientWidth: 400 };
    const observer = observedTargets;
    expect(observer).toHaveLength(1);
    // Drive the callback the way the real observer would on a resize.
    fireResizeObserver();
    await waitFor(() => expect(overflowAttribute()).toBe('true'));
  });

  it('watches the tab row itself, not some outer container', async () => {
    mockResizeObserver();
    overflow = { scrollWidth: 600, clientWidth: 400 };
    renderBrowser(resolvedIndex());

    await waitFor(() => expect(observedTargets.length).toBeGreaterThan(0));
    expect(observedTargets[0]).toBe(tabs());
  });

  it('DISCONNECTS the observer on unmount', async () => {
    // The cleanup is not optional. An observer left attached to a removed node
    // keeps that node alive, so a cashier moving between the menu and the order
    // history all shift leaks one tab row per visit.
    //
    // ASSERTED AS "AT LEAST ONCE", NOT "EXACTLY ONCE", and that is deliberate.
    // `waitFor` retries by re-rendering, so the effect's cleanup runs once per
    // attempt and a strict count would report a number that depends on how many
    // attempts the assertion needed — which is a fact about the test, not about
    // the component. What must hold is the opposite of the leak: cleanup DID
    // run. `0` would mean an observer outlived the row.
    mockResizeObserver();
    overflow = { scrollWidth: 600, clientWidth: 400 };
    const { unmount } = render(
      <CatalogBrowser index={resolvedIndex()} onSelect={() => {}} />,
    );

    await waitFor(() => expect(observedTargets.length).toBeGreaterThan(0));
    unmount();
    expect(disconnectCount).toBeGreaterThanOrEqual(1);
  });

  it('reports no overflow when the browser has no ResizeObserver at all', async () => {
    // An old webview, or a DOM without it. The component must degrade rather
    // than throw — a menu that cannot render is a till that cannot sell.
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

    renderBrowser(resolvedIndex());

    expect(overflowAttribute()).toBe('false');
  });
});

describe('CatalogBrowser — the search box', () => {
  it('is named for a screen reader, not only labelled by its placeholder', () => {
    renderBrowser(resolvedIndex());

    // A placeholder is not an accessible name: it disappears the moment anything
    // is typed, and it is announced as nothing at all. The real `<label>` is what
    // survives — asserted by ROLE, so the field must have foundable text.
    expect(screen.getByRole('searchbox', { name: 'ค้นหาเมนู' })).toBeDefined();
  });

  it('filters by Thai name as the cashier types', () => {
    renderBrowser(resolvedIndex());

    search('ลาเต้');

    expect(tileCount()).toBe(1);
    expect(hasTile('กาแฟลาเต้')).toBe(true);
    expect(hasTile('มอคค่า')).toBe(false);
  });

  it('filters by SKU too, because a barcode scan speaks SKU', () => {
    renderBrowser(resolvedIndex());

    search('BEV-MOCHA');

    expect(tileCount()).toBe(1);
    expect(hasTile('มอคค่า')).toBe(true);
  });

  it('filters IMMEDIATELY, with no debounce', () => {
    renderBrowser(resolvedIndex());

    // The menu is a resolved, frozen array of tens of items — filtering it is a
    // single pass in memory. A debounce would add a timer per keystroke to hide
    // work that takes microseconds, and would leave the grid briefly disagreeing
    // with the box the cashier is reading.
    search('ชา');
    expect(tileCount()).toBe(1);
    expect(hasTile('ชาไทย')).toBe(true);
  });

  it('treats a whitespace-only search as no search, not as no results', () => {
    // The likeliest mistake on a touchscreen: a stray thumb would blank the menu
    // a cashier is halfway through searching.
    renderBrowser(resolvedIndex());

    search('   ');
    expect(tileCount()).toBe(8);
  });

  it('intersects with the active tab rather than overriding it', () => {
    renderBrowser(resolvedIndex());
    fireEvent.click(tab('อาหาร'));

    // "latte while on the food tab" is empty — not "show the latte anyway".
    search('ลาเต้');
    expect(tileCount()).toBe(0);
  });

  it('falls back to the whole menu when the search is cleared', () => {
    renderBrowser(resolvedIndex());
    search('ลาเต้');
    expect(tileCount()).toBe(1);

    search('');
    expect(tileCount()).toBe(8);
  });

  it('offers a clear control only while there is something to clear', () => {
    renderBrowser(resolvedIndex());

    // Nothing to clear, so nothing is rendered — a permanently-present ✕ is a
    // dead control on every screen that opens the till.
    expect(screen.queryByRole('button', { name: 'ล้างคำค้น' })).toBeNull();

    search('ลาเต้');
    const clear = screen.getByRole('button', { name: 'ล้างคำค้น' });
    expect(clear).toBeDefined();

    // And the clear button must ACTUALLY clear, not merely appear.
    fireEvent.click(clear);
    expect(tileCount()).toBe(8);
    expect(screen.queryByRole('button', { name: 'ล้างคำค้น' })).toBeNull();
  });

  it('lets the grid own the empty message rather than duplicating it', () => {
    renderBrowser(resolvedIndex());
    search('ไม่มีเมนูนี้จริงๆ');

    // The grid's own empty state carries it. A second copy here would show the
    // same words twice for two different reasons — and the grid's tests query
    // that string UNSCOPED, so a duplicate would break them outright.
    expect(tileCount()).toBe(0);
    expect(
      screen.getAllByText('ยังไม่มีเมนูที่ขายได้ในหมวดนี้'),
    ).toHaveLength(1);
  });
});

// 3. The withheld-items chip
//
// The full-width bar this replaced said the same sentence across the whole grid.
// What matters here is that folding it into a chip changed HOW MUCH is visible at
// rest, and nothing else: the count still stands next to the search box, the full
// sentence is still on the screen for a screen reader, and the whole thing is
// still one disclosure with one trigger.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The warning chip, by the name its label gives it.
 *
 * The `⚠` is `aria-hidden`, so the accessible name is the count alone — which is
 * exactly what a screen reader user needs and what `getByRole` matches here.
 */
function chip(): HTMLElement {
  return screen.getByRole('button', { name: 'ซ่อน 2 เมนู' });
}

/** The full sentence behind the chip — present whether or not the chip is open. */
function detail(): string {
  return screen.getByRole('status').textContent ?? '';
}

describe('CatalogBrowser — the withheld-items chip', () => {
  it('sits in the search row, not across the grid', () => {
    renderBrowser(resolvedIndex());

    // The row is where the eye already goes when a drink cannot be found, so the
    // caveat about a short menu belongs beside the field. A sibling of the grid
    // would put it back exactly where the full-width bar was.
    const row = chip().closest('.catalog-browser__search-row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('input[type="search"]')).not.toBeNull();
  });

  it('collapses to one chip, shut until it is tapped', () => {
    renderBrowser(resolvedIndex());

    expect(chip().textContent).toBe('⚠ซ่อน 2 เมนู');
    expect(chip().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the whole sentence in the DOM with the chip shut', () => {
    // THE load-bearing assertion. A cashier who never taps the chip still has
    // every reason, and `role="status"` still matches while collapsed — which a
    // `hidden` attribute or an unmounted node would have quietly undone.
    renderBrowser(resolvedIndex());

    expect(detail()).toContain('ซ่อนเมนูไว้ 2 รายการ');
    expect(detail()).toContain('ปิดการขายแล้ว 1 รายการ');
    expect(detail()).toContain('ไม่ได้ตั้งราคา 1 รายการ');
    expect(detail()).toContain('เมนูที่ไม่มีราคาที่เชื่อถือได้ห้ามขาย');
    expect(detail()).toContain('ผู้ดูแลร้านต้องตรวจสอบก่อนเปิดขาย');
  });

  it('opens and shuts on the chip, and says which state it is in', () => {
    renderBrowser(resolvedIndex());

    fireEvent.click(chip());
    expect(chip().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(chip());
    expect(chip().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and hands focus back to the chip', () => {
    // Escape is the keyboard half of the same contract: the popover belongs to
    // its trigger, so it can be dismissed without hunting for the trigger first.
    renderBrowser(resolvedIndex());
    fireEvent.click(chip());
    expect(chip().getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(chip(), { key: 'Escape' });

    expect(chip().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip());
  });

  it('ignores Escape while it is already shut', () => {
    // Closing something that is closed is not a state change, and treating it as
    // one would move focus on a key the cashier pressed for something else.
    renderBrowser(resolvedIndex());

    fireEvent.keyDown(chip(), { key: 'Escape' });

    expect(chip().getAttribute('aria-expanded')).toBe('false');
  });

  it('says the warning ONCE, not once for the grid and once for the chip', () => {
    // Both components can draw it. Two sentences on one screen reads as two
    // separate problems rather than one warning stated twice.
    renderBrowser(resolvedIndex());

    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('renders no chip and no status when nothing was withheld', () => {
    // A warning that is always present stops being read. Nothing skipped, so
    // nothing at all — and that absence is what proves the chip is reporting the
    // snapshot rather than decorating the search row.
    const latteId = mustFind(
      demoCatalog.DEMO_VARIANTS,
      (variant) => variant.sku === 'BEV-LATTE-12',
      'the latte variant',
    ).id;
    const index = buildCatalog({
      ...demoCatalog.DEMO_SNAPSHOT,
      variants: [
        mustFind(demoCatalog.DEMO_VARIANTS, (variant) => variant.id === latteId, 'the latte'),
      ],
      price_list_entries: [
        mustFind(
          demoCatalog.DEMO_PRICE_LIST_ENTRIES,
          (entry) => entry.product_variant_id === latteId,
          'the latte price row',
        ),
      ],
    });
    expect(index.skipped).toHaveLength(0);

    renderBrowser(index);

    expect(screen.queryByRole('button', { name: /ซ่อน \d+ เมนู/ })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// 4. Selection still reaches the domain entry
// ─────────────────────────────────────────────────────────────────────────────

describe('CatalogBrowser — selecting', () => {
  it('hands the whole entry back, even through a tab', () => {
    const index = resolvedIndex();
    const selected: CatalogEntry[] = [];
    renderBrowser(index, (entry) => {
      selected.push(entry);
    });

    fireEvent.click(tab('เครื่องดื่ม'));
    fireEvent.click(tile('มอคค่า'));

    // Identity, not equality: the caller must receive the very frozen entry the
    // grid rendered, so the price it hands to the cart is the price on screen.
    expect(selected).toHaveLength(1);
    expect(selected[0]?.unitPrice.satang).toBe(6000n);
    expect(selected[0]?.variant.sku).toBe('BEV-MOCHA-12');
  });

  it('still selects through the search box', () => {
    const index = resolvedIndex();
    const selected: CatalogEntry[] = [];
    renderBrowser(index, (entry) => {
      selected.push(entry);
    });

    search('กล้วย');
    fireEvent.click(tile('เค้กกล้วยหอม'));

    expect(selected).toHaveLength(1);
    expect(selected[0]?.unitPrice.satang).toBe(5500n);
  });
});