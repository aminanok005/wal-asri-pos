/**
 * CatalogBrowser — the menu a cashier actually reaches for: tabs and a search box
 * above the grid.
 *
 * LAYER: UI (presentation). It owns NO filtering logic. `filterEntries` in
 * `../domain/catalog` decides which entries survive, exactly as
 * `buildCatalog` decided which variants were sellable in the first place; this
 * component holds two pieces of state and renders what the domain hands back.
 *
 * ── WHY A SEPARATE COMPONENT AND NOT MORE PROPS ON `CatalogGrid` ─────────────
 *
 * `CatalogGrid`'s contract is deliberately narrow: it takes a resolved index and
 * draws it. It is what the withheld-items warning, the money assertions and the
 * accessible-name guarantees in `CatalogGrid.test.tsx` are all written against,
 * and every one of those tests renders `<CatalogGrid>` directly with no wrapper.
 *
 * Putting tabs and a search field INSIDE it would mean every one of those tests
 * now had to know about a tab strip it does not care about — and the tests that
 * count tiles do it with `queryAllByRole('button')`, which would start counting
 * tab buttons as menu items. Keeping the chrome here means `CatalogGrid.test.tsx`
 * needed no changes at all when the grid became a card grid, and needs none now.
 *
 * ── WHY THE FILTER IS NOT REIMPLEMENTED HERE ────────────────────────────────
 *
 * The tab could be a `.filter()` over `index.entries` and the search could be
 * another. Both would look right and both would be a SECOND answer to "what can
 * this cashier sell", next to `buildCatalog`'s. `filterEntries` is one function,
 * in the domain, beside the other query — so the tab, the search, and any future
 * caller are guaranteed to agree about what a menu is.
 *
 * ── WHY NO DEBOUNCE ─────────────────────────────────────────────────────────
 *
 * The menu is tens of items, not thousands: `index.entries` is already resolved
 * and frozen before this component mounts, so filtering it is a single pass over
 * an array the terminal is holding in memory anyway. Debouncing would add a
 * timer per keystroke to make a calculation that takes microseconds invisible —
 * and, worse, make the grid briefly disagree with the search box.
 *
 * @see ./CatalogGrid.tsx — the grid this renders
 * @see ../domain/catalog.ts — where every "sellable" verdict was reached
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import { filterEntries } from '../domain/catalog';
import type { CatalogEntry, CatalogIndex, UuidV7 } from '../domain/catalog';
import { CatalogGrid } from './CatalogGrid';
import { SkippedWarning } from './SkippedWarning';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogBrowserProps {
  /** The resolved menu. Frozen, and safe to hold across renders. */
  readonly index: CatalogIndex;
  /** Called with the whole entry that was tapped. See `CatalogGridProps`. */
  readonly onSelect: (entry: CatalogEntry) => void;
  /**
   * How many of each variant is already in the basket, for the tile badges.
   *
   * Passed straight through, never consulted here. The browser's job is to decide
   * WHICH tiles are visible; what is in the basket is `CartView`'s business, and
   * a browser that also answered that would be a second place where the two
   * could disagree — a tile badged "×2" on a screen whose cart says one.
   */
  readonly quantities?: ReadonlyMap<UuidV7, bigint>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab model
//
// ── WHY A LABEL AND AN ID, AND NOT THE CATEGORY OBJECT ITSELF ────────────────
// `index.categories` is what the tabs are BUILT from, but what a tab needs to
// hold is two things — the Thai label to print, and the id to filter by — and a
// `Category` row carries nine more fields none of which a tab uses. Holding the
// row would mean every tab carries a mutable-looking object the UI never reads.
//
// ── WHY `ทั้งหมด` IS `id: undefined` AND NEVER `null` ─────────────────────────
// `filterEntries` keeps `entriesInCategory`'s three-state contract: `undefined`
// is NO category filter, and `null` is the UNCATEGORISED BUCKET — a real bucket
// holding items whose product is missing from the snapshot. Selecting
// `ทั้งหมด` and selecting that bucket are different intents, and the second one
// is not what "show me everything" means. Getting them backwards would show a
// nearly-empty menu under a tab that says "All".
//
// ── WHY UNCATEGORISED GETS ITS OWN TAB, AT ALL ────────────────────────────────
// Because the bucket is real. If a branch's snapshot is missing a product, that
// variant is still sellable — `buildCatalog` deliberately keeps it rather than
// hiding a drink because a parent row is absent — and it still has to be
// reachable. A menu that quietly makes those items unsellable is exactly the
// "visibly short menu" the withheld-items warning exists to prevent.
//
// The tab is only rendered when the bucket is NON-EMPTY, for the opposite
// reason: a tab labelled "Uncategorised" that shows nothing on every ordinary
// branch teaches a cashier that a tab which shows nothing is normal, which is
// how a genuinely empty tab stops being noticed.
// ─────────────────────────────────────────────────────────────────────────────

/** The tab shown when no category filter is applied. */
const ALL_TABS_LABEL = 'ทั้งหมด';

/** The label for the uncategorised bucket, when that bucket has anything in it. */
const UNCATEGORISED_LABEL = 'ไม่ระบุหมวด';

interface CategoryTab {
  /** The label the cashier reads. */
  readonly label: string;
  /**
   * The id to filter by: a category id, `null` for the uncategorised bucket, or
   * `undefined` for no filter. See the note above on why `null` is not `ทั้งหมด`.
   */
  readonly categoryId: UuidV7 | null | undefined;
}

/**
 * The tabs, in `index.categories` order, with `ทั้งหมด` first.
 *
 * NOT SORTED BY `sequence`, even though `Category` carries one: `buildCatalog`
 * states "Nothing here sorts" about `entries`, and the categories arrive in the
 * order the server chose for exactly the same reason. Sorting the tabs would put
 * a menu the branch has organised one way above a menu it has organised another
 * way, for a field whose whole purpose is server-side ordering.
 */
function buildTabs(index: CatalogIndex): readonly CategoryTab[] {
  const tabs: CategoryTab[] = [
    { label: ALL_TABS_LABEL, categoryId: undefined },
    ...index.categories.map((category) => ({
      label: category.name_th,
      categoryId: category.id as UuidV7,
    })),
  ];

  // The bucket is a tab only when it has something in it — see the note above.
  if (filterEntries(index, { categoryId: null }).length > 0) {
    tabs.push({ label: UNCATEGORISED_LABEL, categoryId: null });
  }

  return Object.freeze(tabs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function CatalogBrowser(props: CatalogBrowserProps): JSX.Element {
  const { index, onSelect, quantities } = props;

  // `undefined` rather than a tab id: the selected TAB is what a cashier points
  // at, and storing an id would need a separate lookup to find it again on every
  // render. An absent filter is also the honest initial state — it is what
  // `resolveInitialTab` below resolves a stale one to.
  const [categoryId, setCategoryId] = useState<UuidV7 | null | undefined>(undefined);
  const [query, setQuery] = useState('');

  const tabs = useMemo(() => buildTabs(index), [index]);

  // The domain's answer, not a `.filter()` in this file. `categoryId` and `query`
  // go in exactly as `CatalogGrid` would have received them — which is why the
  // withheld-items warning below the grid keeps counting the WHOLE snapshot
  // rather than the visible slice: a filter must not silence a short menu.
  const visibleEntries = useMemo(
    () => filterEntries(index, { categoryId, query }),
    [index, categoryId, query],
  );

  // ── Does the tab row overflow? ──────────────────────────────────────────────
  //
  // The edge arrows beside the tabs are the only cue that a category exists off
  // the right edge, and drawing them unconditionally means a four-category menu
  // gets arrows pointing at nothing. CSS cannot decide this — there is no
  // selector for "this element's content is wider than its box" — so the
  // measurement happens here and the ANSWER is handed to CSS as an attribute.
  //
  // WHY A REF AND NOT A QUERY IN THE RENDER BODY: `scrollWidth` on an element
  // that has never been laid out is 0, and reading it during render would
  // measure nothing on the first pass. A ref plus an effect measures after the
  // browser has actually given the row a width.
  const tabRowRef = useRef<HTMLElement | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);

  useEffect(() => {
    const row = tabRowRef.current;
    // No ref, or no `ResizeObserver` (an old webview, or a test DOM without it):
    // leave the arrows off. `false` is the safe default — an arrow pointing at
    // a tab that IS there is worse than a missing arrow on a row that overflows.
    if (row === null || typeof ResizeObserver === 'undefined') {
      return;
    }

    const measure = (): void => {
      // 1px of tolerance: a row whose content is exactly its own width reports
      // equal, and sub-pixel layout on some platforms reports one pixel OVER for
      // a row that genuinely fits. Either way the consequence is two arrows that
      // point at nothing, which is the thing this whole mechanism avoids.
      setTabsOverflow(row.scrollWidth > row.clientWidth + 1);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(row);
    // The CLEANUP is not optional: an observer left attached to a row that has
    // been unmounted keeps the node — and its observer — alive, so navigating
    // between screens repeatedly would leak one row per visit. This is the same
    // rule `RecentOrdersStrip` follows for its in-flight read.
    return () => {
      observer.disconnect();
    };
  }, [tabs.length]);

  return (
    <div className="catalog-browser" data-testid="catalog-browser">
      {/* ── Search ────────────────────────────────────────────────────────
          A REAL `<label>`, not a placeholder. The prototype's search box is a
          `placeholder` only, and a placeholder is not an accessible name: it
          disappears the moment anything is typed, and a screen reader announces
          the field with no name at all. The label is visually hidden rather than
          absent — the 🔍 glyph carries it for everyone else.

          The clear button exists and is conditional on there being something to
          clear, because a search box on a till gets a full-height miss-tap and a
          cashier should not have to select-all and delete. It renders NOTHING
          when the box is already empty, so it can never be a dead control. */}
      <div className="catalog-browser__search-row">
        <label className="catalog-browser__search">
          <span className="catalog-browser__search-icon" aria-hidden="true">
            🔍
          </span>
          <span className="catalog-browser__visually-hidden">ค้นหาเมนู</span>
          <input
            type="search"
            className="catalog-browser__search-input"
            placeholder="เช่น ลาเต้ หรือสแกนโค้ดสินค้า"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        {query.length > 0 && (
          <button
            type="button"
            className="catalog-browser__search-clear"
            onClick={() => setQuery('')}
          >
            ล้างคำค้น
          </button>
        )}

        {/* ── Withheld-items chip ──────────────────────────────────────────
            The full-width bar this replaced sat across the whole grid and
            carried a sentence nobody reads twice. A chip beside the search box
            says the same thing in the space where a cashier goes when a drink
            cannot be found — and it is the LAST thing in the row, so the field
            keeps `flex: 1` and stays the widest thing on the line.

            It counts the WHOLE snapshot: `index`, never `visibleEntries`, so
            typing in the search box can never make a short menu look complete.

            `CatalogGrid` below is told to stand down, so the sentence appears
            exactly once on the screen. */}
        <SkippedWarning index={index} />
      </div>

      {/* ── Category tabs ─────────────────────────────────────────────────
          Plain buttons in a `<nav>` with `aria-current`, NOT `role="tab"`.

          The tab pattern obliges its author to also provide a `role="tabpanel"`
          wired up with `aria-labelledby`, and the panel here is the grid, which
          is a plain container with no such contract. A `role="tab"` on a button
          with no tabpanel behind it is an ARIA lie that costs more than it buys.
          `aria-current` is what this repo already uses for its own nav
          (`app/AppShell.tsx`), so the till's two navs are described the same way.

          `overflow-x: auto` is the prototype's own behaviour and matters on a
          narrow till: with seven categories a bar that cannot scroll hides two
          of them, and a hidden category is a menu that looks complete. */}
      <nav
        className="catalog-browser__tabs"
        aria-label="หมวดหมู่เมนู"
        ref={tabRowRef}
        // `data-overflow` is the ONLY thing the arrows are keyed off, and it is
        // driven by a measurement rather than by a guess about how many
        // categories a branch has. A branch adding its tenth category is
        // reflected without touching this component, which is the whole reason
        // it is measured rather than derived from `tabs.length`.
        data-overflow={tabsOverflow ? 'true' : 'false'}
      >
        {tabs.map((tab) => {
          // The id, not the index: two tabs can never share a key here because
          // category ids are unique in a snapshot, and `ทั้งหมด` is the only tab
          // whose id is `undefined` — so it cannot collide with a real category.
          const isCurrent = tab.categoryId === categoryId;
          return (
            <button
              key={tab.categoryId ?? (tab.label === ALL_TABS_LABEL ? 'all' : 'none')}
              type="button"
              className="catalog-browser__tab"
              aria-current={isCurrent ? 'true' : undefined}
              onClick={() => setCategoryId(tab.categoryId)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* ── The grid ─────────────────────────────────────────────────────────
          `visibleEntries` is what the domain says is sellable under the current
          tab and query — and it is passed to `CatalogGrid` as `entries`
          through the existing `categoryId` prop's sibling, so the withheld-items
          warning still counts the WHOLE snapshot and a filter cannot hide a
          short menu from the shift lead.

          The empty state that reads "no sellable items here" belongs to
          `CatalogGrid` and is NOT duplicated here: its own tests query that
          string unscoped, and a second copy on screen would break them — and,
          more to the point, would show a cashier the same words twice for two
          different reasons. */}
      <CatalogGrid
        index={index}
        onSelect={onSelect}
        entries={visibleEntries}
        hideWithheldWarning
        // Spelled out rather than `quantities={quantities}`: the repo compiles
        // with `exactOptionalPropertyTypes`, so handing an absent prop down as
        // `undefined` is a type error even though the receiving prop is
        // optional. Conditional spread says "pass it only when there is one".
        {...(quantities === undefined ? {} : { quantities })}
      />
    </div>
  );
}

export default CatalogBrowser;