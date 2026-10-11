/**
 * CatalogGrid — the menu a cashier sells from, one tile per sellable variant.
 *
 * LAYER: UI (presentation). It renders a resolved `CatalogIndex` and nothing
 * more: it does not decide what is sellable, does not read a price out of the
 * wire payload, and does not add anything to a cart. `buildCatalog` already
 * reached a verdict on every variant, and this component's only job is to show
 * the tiles that survived and to say what it withheld.
 *
 * THAT SECOND JOB IS THE POINT
 *
 * A grid that quietly drops rows is a grid that looks correct. The shift lead
 * sees 48 items on the screen and the server has 52, and nobody learns that four
 * drinks cannot be sold until a customer asks for one. So `index.skipped` is
 * surfaced as a visible warning with a count, grouped by reason — which is the
 * difference between "the menu is short" and "the menu is short because four
 * prices are missing".
 *
 * MONEY
 *
 * Every price on a tile is `entry.unitPrice.toString()` prefixed with ฿. That is
 * the whole formatting rule: the `Money` reached the screen having been built
 * once from an exact satang count, and no component divides, rounds or adds
 * anything. A price computed inline here would be a second implementation of
 * money, and two implementations eventually disagree by one satang.
 *
 * @see ../domain/catalog.ts — where every "sellable" verdict was reached
 */

import type { JSX } from 'react';

import { entriesInCategory } from '../domain/catalog';
import type { CatalogEntry, CatalogIndex, UuidV7 } from '../domain/catalog';
import type { Product } from '../domain/catalog';
import { Money } from '../../payments/domain/money';
// A VALUE import: the media span renders the glyph this returns. Presentation,
// like everything else in this component — see `emoji.ts` for why the mapping
// claims nothing about the product.
import { emojiForName } from './emoji';
import { SkippedWarning } from './SkippedWarning';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The grid takes a finished index, never a snapshot.
 *
 * That is the whole layering argument in one signature: this component cannot
 * read `price_list_entries`, so it cannot invent a price, and it cannot see
 * `is_active`, so it cannot resurrect a retired SKU. Whatever it shows was
 * resolved by the domain.
 */
export interface CatalogGridProps {
  /** The resolved menu. Frozen, and safe to hold across renders. */
  readonly index: CatalogIndex;
  /**
   * Called with the whole entry that was tapped.
   *
   * The entry, not the variant id: the caller needs the price too, and the one
   * guarantee this component can offer is that the `unitPrice` it hands over is
   * the exact same `Money` the tile displayed. Handing back only an id would make
   * every caller go and look the price up again, and one of them would do it wrong.
   */
  readonly onSelect: (entry: CatalogEntry) => void;
  /**
   * Show one category. `undefined` — the default — shows every sellable entry;
   * `null` is the uncategorised bucket, which is a real bucket rather than an
   * error: a variant whose product is missing from the snapshot is still sellable
   * and has to go somewhere.
   */
  readonly categoryId?: UuidV7 | null;
  /**
   * Suppress the withheld-items warning, because something above already shows it.
   *
   * `false` — the default — keeps the grid owning it, which is what a bare
   * `<CatalogGrid>` has always done and what its own tests render. `CatalogBrowser`
   * passes `true` because it draws the chip beside the search box instead, and two
   * warnings on one screen would say the same sentence twice.
   */
  readonly hideWithheldWarning?: boolean;
  /**
   * How many of each variant is already in the basket, for the tile's badge.
   *
   * KEYED BY VARIANT ID — the key `quantitiesByVariant` in `sales/domain/cart.ts`
   * produces — because a tile knows which variant it is showing and has never
   * heard of a cart line id.
   *
   * OPTIONAL, and the default is an empty map rather than a required prop: a
   * caller with no basket behind it still gets a working grid, and every existing
   * use of `<CatalogGrid>` keeps compiling unchanged. The badge renders only for a
   * variant present in the map, so a missing entry reads as "none in the basket"
   * rather than as a zero the cashier has to interpret.
   */
  readonly quantities?: ReadonlyMap<UuidV7, bigint>;
  /**
   * Draw exactly these entries, instead of resolving `index` itself.
   *
   * THE ESCAPE HATCH FOR A PRE-FILTERED MENU, NOT A REPLACEMENT FOR THE INDEX.
   * `index` is still required and still the only source of the withheld-items
   * warning — which is why supplying `entries` cannot hide a short menu from the
   * shift lead. A caller filtering with `filterEntries` (or anything else)
   * passes the result here and the grid draws it.
   *
   * `undefined` — the default — resolves `categoryId` through the domain exactly
   * as it always has. It is optional rather than required so that every existing
   * caller, and every existing test, is unaffected by its existence: `undefined`
   * and "the caller computed the same thing the domain would" are
   * indistinguishable here, which is the point.
   *
   * A caller passing both `entries` and `categoryId` gets a silent contradiction
   * on screen, so `entries` WINS and `categoryId` is ignored. That is stated here
   * rather than enforced at the type level because a type cannot express "exactly
   * one of these two", and a runtime throw on a prop combination would be a
   * worse failure than a documented precedence.
   */
  readonly entries?: readonly CatalogEntry[];
  /**
   * Product lookup by product id, for rendering recipe badges.
   *
   * KEYED BY PRODUCT ID — the `Product.id` from the catalog snapshot. When
   * provided, tiles whose variant's product has a `recipe_id` will show a
   * recipe component preview badge. Optional: when omitted or when a variant's
   * product is not in the map, no recipe badge is rendered.
   */
  readonly products?: ReadonlyMap<UuidV7, Product>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tile colour
//
// ── WHY A HASH AND NOT RENDER ORDER ──────────────────────────────────────────
// The prototype gives each menu item a gradient in its data table. Nothing in the
// contract describes a product's colour — `ProductVariant` has `image_url` and
// `is_active` and nothing visual — so a colour cannot be READ, only chosen.
//
// Render order was the obvious way to choose one and it is wrong: it would give
// a drink whichever colour happened to fall on its index, so adding a category
// renames the colours of everything after it, and two tills showing different
// snapshots would show the same latte in different colours. Hashing the variant
// id instead makes the assignment a property OF THE ITEM: stable across
// re-renders, across terminals, and across any change to the menu.
//
// Six classes over six token pairs, chosen modulo six. Six is arbitrary and
// small — it is enough that a grid does not read as a repeating pattern of three.
// ─────────────────────────────────────────────────────────────────────────────

/** How many gradient pairs `tokens.css` defines. */
const TILE_GRADIENT_COUNT = 6;

/**
 * The gradient class for a variant, from a stable hash of its id.
 *
 * A plain character-code sum, not a crypto hash: the requirement is
 * *determinism*, not uniformity, and this runs once per tile per render over
 * eight items. `charCodeAt` returns `NaN` for nothing — `id` is a non-empty
 * UUIDv7 string from the contract — so every char contributes a real number.
 */
function gradientClass(variantId: string): string {
  let sum = 0;
  for (let i = 0; i < variantId.length; i += 1) {
    sum += variantId.charCodeAt(i);
  }
  return `catalog-grid__tile-media--${(sum % TILE_GRADIENT_COUNT) + 1}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a `Money` as Thai baht, e.g. ฿45.50.
 *
 * Repeated rather than imported from a sibling UI file: `CartView.tsx` holds its
 * own copy for the same reason. Formatting is display, the domain deliberately
 * holds no currency symbol, and a shared "formatting" module would be one more
 * layer whose only content is a template string.
 */
function formatBaht(amount: Money): string {
  return `฿${amount.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function CatalogGrid(props: CatalogGridProps): JSX.Element {
  const {
    index,
    onSelect,
    categoryId,
    quantities,
    products,
    entries: entriesOverride,
    hideWithheldWarning = false,
  } = props;

  // The domain does the filtering, so the grid and any other consumer of the
  // index can never disagree about which entries a category contains. `undefined`
  // means "no filter" and passes the frozen `entries` straight through; `null` is
  // a real request — the uncategorised bucket — and goes through the domain.
  //
  // `entriesOverride` short-circuits both: a caller that already holds the
  // answer hands it over, and asking the domain to narrow it a second time would
  // be a second filtering rule for the same menu. See the prop's note for why the
  // warning below still counts the whole snapshot either way.
  const entries =
    entriesOverride ?? (categoryId === undefined ? index.entries : entriesInCategory(index, categoryId));

  return (
    <div className="catalog-grid" data-testid="catalog-grid">
      {/* ── Withheld warning ───────────────────────────────────────────────
          `role="status"` so it is announced when it appears — a menu that just
          got three items shorter is exactly the kind of change a cashier should
          hear about rather than notice by looking. It renders nothing at all when
          nothing was skipped, so a healthy menu does not train anyone to ignore
          the line.

          It counts the WHOLE snapshot, not the visible tiles, so a filter
          narrowing the grid cannot silence it.

          `hideWithheldWarning` is how `CatalogBrowser` moves this beside the
          search box without two warnings on one screen. The default stays `false`
          on purpose: this component used to own the warning outright, and every
          test that renders `<CatalogGrid>` on its own still expects to find it
          here. */}
      {!hideWithheldWarning && <SkippedWarning index={index} />}

      {/* ── Tiles ──────────────────────────────────────────────────────────
          An explicit empty state, never a blank box: "nothing here" and "still
          loading" look identical on screen otherwise, and they call for opposite
          responses from the person standing in front of the terminal. */}
      {entries.length === 0 ? (
        <p className="catalog-grid__empty">ยังไม่มีเมนูที่ขายได้ในหมวดนี้</p>
      ) : (
        <ul className="catalog-grid__tiles" data-testid="catalog-tiles">
          {entries.map((entry) => {
            // `undefined` when the basket holds none of this variant — which is
            // most tiles, most of the time. Only a positive quantity earns a
            // badge, so "none" never has to be distinguished from "zero".
            const inBasket = quantities?.get(entry.variant.id) ?? 0n;

            // Look up the product for this variant to check for recipe_id.
            // The variant carries `product_id`; the products map is keyed by product id.
            const product = products?.get(entry.variant.product_id);
            const hasRecipe = product?.recipe_id !== null && product?.recipe_id !== undefined;

            return (
              <li key={entry.variant.id} className="catalog-grid__tile">
                {/* The accessible name is the item's name and nothing else. A screen
                    reader user pressing tiles one after another should hear
                    "เพิ่ม กาแฟลาเต้", "เพิ่ม มอคค่า" — not a price recited before
                    every name, and never the quantity controls that later sit in
                    the same row of the cart. The price stays visible on the tile,
                    where it belongs. */}
                <button
                  type="button"
                  className="catalog-grid__tile-button"
                  aria-label={`เพิ่ม ${entry.variant.name_th}`}
                  onClick={() => onSelect(entry)}
                >
                  {/* The colour panel, wearing a decorative emoji — the tile's
                      stand-in for the product photo this contract has no field
                      for. A CLASS, not an inline `style`: the CSP is
                      `default-src 'self'` and an inline style is blocked, so the
                      prototype's `style="background:linear-gradient(...)"` would
                      build cleanly and render colourless. The glyph is TEXT —
                      it needs no CSP source at all — and it lives inside the
                      `aria-hidden` span, so it never enters the tile's
                      accessible name: the `aria-label` above remains the whole
                      name, exactly as the tests assert it. Which emoji comes
                      from `emojiForName` — a keyword rule over THIS name,
                      deterministic, decoration only; the price lives in the
                      body below, where a screen reader and a cashier both want
                      it. */}
                  <span
                    className={`catalog-grid__tile-media ${gradientClass(entry.variant.id)}`}
                    aria-hidden="true"
                  >
                    {emojiForName(entry.variant.name_th)}
                  </span>

                  {/* The badge is inside the button but NOT focusable and NOT in
                      the accessible name — `aria-hidden`, because the tile's
                      `aria-label` above is the whole name and a screen reader
                      announcing "2" between "เพิ่ม" and the item would be noise.
                      It is a `<span>`, never a `<button>`: this tile's own tests
                      count buttons to find tiles, and a badge button would read as
                      an extra sellable item. */}
                  {inBasket > 0n && (
                    <span className="catalog-grid__tile-badge" aria-hidden="true">
                      {`×${inBasket.toString()}`}
                    </span>
                  )}

                  {/* Recipe component preview badge — shows when the product has a
                      recipe_id, indicating ingredient/allergen info is available.
                      Uses the warning token (brown-orange) to avoid clashing with
                      the accent-coloured quantity badge and the pay button flow. */}
                  {hasRecipe && (
                    <span
                      className="catalog-grid__tile-recipe-badge"
                      aria-label="มีข้อมูลสูตรผสมและสารก่อภูมิแพ้"
                      aria-hidden="false"
                    >
                      📋
                    </span>
                  )}

                  <span className="catalog-grid__tile-body">
                    <span className="catalog-grid__tile-name">{entry.variant.name_th}</span>
                    <span className="catalog-grid__tile-price">{formatBaht(entry.unitPrice)}</span>
                    <span className="catalog-grid__tile-sku">{entry.variant.sku}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default CatalogGrid;
