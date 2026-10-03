/**
 * Catalog — the menu grid a cashier sells from, resolved from one snapshot.
 *
 * LAYER: domain. Pure TypeScript, zero imports beyond this monorepo: no React,
 * no Tauri, no SQL, no HTTP, no external library. Whether an item may be sold,
 * and at what price, is a business decision — and a business decision that can
 * reach for the network will eventually be taken twice with two answers.
 *
 * WHAT THIS MODULE ACTUALLY DOES
 *
 * A `CatalogResponse` is not a menu. It is everything the server knows about a
 * branch, including rows that must never reach a cashier's screen: retired
 * variants, variants no active price list mentions, variants whose price
 * arrived as a float. `buildCatalog` is the one place that turns the raw
 * snapshot into what is *sellable here*, and it is deliberately **total**: it
 * reaches a verdict on every variant and records why the rest were left out.
 *
 * ── WHY A BAD ROW IS SKIPPED, NOT THROWN ─────────────────────────────────
 *
 * The tempting implementation validates the snapshot and throws on the first
 * bad row. On a terminal that is the wrong trade: one malformed price would
 * blank the entire menu, and a cashier mid-shift can serve nobody until a
 * human restarts the app. So a problem with a *row* degrades into one entry in
 * `skipped` and the rest of the menu still loads. A visibly short menu is
 * fixable; an empty one during service is a lost queue. `skipped` is the
 * receipt for what was dropped, so the UI can surface a pricing-problem count
 * instead of silently serving a menu that is quietly missing items.
 *
 * ── WHY CATEGORY IS RESOLVED THROUGH THE PRODUCT ─────────────────────────
 *
 * `ProductVariant` carries no category; `Product` does, and a variant points at
 * its product. So the join happens here, through `response.products`. A variant
 * whose product is absent from the snapshot is treated as uncategorised rather
 * than dropped: the product is not what is being sold, and a missing parent row
 * is a catalog gap, not a reason to hide a drink.
 *
 * @see ../README.md — the boundary rule this file obeys
 */

import type { components } from '@wasri/api-types';
import { Money } from '../../payments/domain/money';
// ─────────────────────────────────────────────────────────────────────────────
// Contract-derived types
//
// These come from `contracts/openapi.yaml` via `@wasri/api-types`, which is
// GENERATED. Importing them rather than redeclaring the shape means this file
// cannot drift from the contract: change the contract, regenerate, and any
// mismatch becomes a compile error here rather than a runtime surprise in a shop.
// ─────────────────────────────────────────────────────────────────────────────

/** A generated contract type, addressed by its schema name. */
type Schema<K extends keyof components['schemas']> = components['schemas'][K];

/** UUIDv7 — client-generated, time-ordered (`UuidV7` in the contract). */
export type UuidV7 = Schema<'UuidV7'>;

/** MONEY on the wire: an integer count of satang (`Satang` in the contract). */
export type Satang = Schema<'Satang'>;

/** Optimistic-concurrency counter. Prices are last-write-wins by `version`. */
export type Version = Schema<'Version'>;

/** A menu grouping, hierarchical via `parent_id`. */
export type Category = Schema<'Category'>;

/** A sellable concept, e.g. "Iced Latte". Owns the category. */
export type Product = Schema<'Product'>;

/** A concrete sellable SKU — the row the grid shows and the cart holds. */
export type ProductVariant = Schema<'ProductVariant'>;

/** The price of one variant under one price list — the only price in the contract. */
export type PriceListEntry = Schema<'PriceListEntry'>;

/** One catalog snapshot plus the cursor needed to ask for the next delta. */
export type CatalogResponse = Schema<'CatalogResponse'>;
// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The catalog domain's single error identity.
 *
 * `buildCatalog` is total and never throws, which is deliberate: a bad *row*
 * must cost one item on the grid, not the whole menu, and the reason is
 * recorded in `skipped` rather than raised. This class exists so every catalog
 * fault surfaces under one `instanceof`, instead of a mix of `MoneyError`,
 * `TypeError` and `RangeError` that a caller cannot discriminate.
 */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skips
//
// Every reason a variant is absent from the grid, as a closed set. A closed set
// matters: the UI counts skips by reason to warn the shift lead ("3 items have
// no price"), and a free-form string would make that count a string comparison.
// ─────────────────────────────────────────────────────────────────────────────
/** Why a variant from the snapshot is not on the grid. */
export type SkipReason =
  /** The variant is retired (`is_active === false`). Not sellable, full stop. */
  | 'inactive_variant'
  /** The active price list says nothing about this variant. */
  | 'no_price_entry'
  /** Several price lists arrived and the caller named none. */
  | 'ambiguous_price_list'
  /** A price arrived, but it is not a safe non-negative integer count of satang. */
  | 'invalid_price';
/** One variant that did not make the grid, and why. */
export interface SkippedVariant {
  /** The variant that was left out — present so the UI can name it to a manager. */
  readonly variantId: UuidV7;
  /** Its SKU, which is what a human recognises on a printed report. */
  readonly sku: string;
  readonly reason: SkipReason;
}
// ─────────────────────────────────────────────────────────────────────────────
// CatalogEntry
//
// A variant that IS sellable, together with the one price it is being sold at
// in the active list. The two are bound together on purpose: a variant on the
// grid and the price next to it must never be able to disagree.
// ─────────────────────────────────────────────────────────────────────────────

/** One sellable row of the menu grid. */
export interface CatalogEntry {
  /** The SKU being sold, exactly as the server described it. */
  readonly variant: ProductVariant;
  /**
   * **MONEY — Satang (int64), as a `Money`.** Price for one unit, before tax
   * and before discount, from the active price list.
   *
   * Already a value object, never a bare `number`: once a satang count exists
   * as a JS number it can be added to a float and lose a satang without a
   * sound. The conversion is done once, here, in `toUnitPrice`.
   */
  readonly unitPrice: Money;
  /**
   * Owning category, resolved through `variant.product_id`. `null` when the
   * product is uncategorised — or absent from the snapshot, which the grid
   * treats the same way: an "Other" bucket beats a drink that cannot be sold.
   */
  readonly categoryId: UuidV7 | null;
}
// ─────────────────────────────────────────────────────────────────────────────
// CatalogIndex
//
// The whole answer, in one immutable value. It carries `skipped` alongside
// `entries` so a caller cannot read a menu without also being able to find out
// what the menu is missing — the two facts are always produced together.
// ─────────────────────────────────────────────────────────────────────────────

/** The resolved menu. Immutable: arrays, map and object are all frozen. */
export interface CatalogIndex {
  /** Sellable rows, in `response.variants` order exactly. Never sorted. */
  readonly entries: readonly CatalogEntry[];
  /** Lookup by variant id, for a barcode scan or a cart that already holds a variant. */
  readonly byVariantId: ReadonlyMap<UuidV7, CatalogEntry>;
  /** The category rows from the snapshot, in snapshot order. */
  readonly categories: readonly Category[];
  /** Everything that was left out, in `response.variants` order. */
  readonly skipped: readonly SkippedVariant[];
  /**
   * The price list these entries were priced from. `null` when the snapshot had
   * no price entries at all, or when it had several and the caller named none.
   * A `null` here is a statement, not a gap: it means "no list is in effect".
   */
  readonly priceListId: UuidV7 | null;
}
/**
 * How to build the index.
 *
 * `activePriceListId` is optional because a branch usually has exactly one price
 * list in play, and making the caller look it up every time a snapshot arrives
 * would push the ambiguity decision out to every screen. When it is genuinely
 * ambiguous, this module refuses to resolve it (see `resolvePriceListId`).
 */
export interface BuildCatalogOptions {
  /** The price list to sell at. When omitted, a sole list is inferred. */
  readonly activePriceListId?: UuidV7;
}
// ─────────────────────────────────────────────────────────────────────────────
// Price list resolution
//
// Rule 1. A branch can run more than one price list (standard, promotional,
// staff). The snapshot carries entries for all of them, and only one of them is
// the price a customer is supposed to pay.
// ─────────────────────────────────────────────────────────────────────────────

/** Every distinct `price_list_id` in the snapshot, in first-seen order. */
function distinctPriceListIds(response: CatalogResponse): readonly UuidV7[] {
  const seen = new Set<UuidV7>();
  for (const entry of response.price_list_entries) {
    seen.add(entry.price_list_id);
  }
  return [...seen];
}
/**
 * Decide which price list is in effect. `null` means "none is in effect".
 *
 * An explicit `activePriceListId` always wins, and entries belonging to every
 * other list are ignored entirely. That is the whole point of naming it: the
 * caller has said which list this register is selling at, and a second list in
 * the payload is not a reason to second-guess them.
 */
function resolvePriceListId(
  response: CatalogResponse,
  activePriceListId: UuidV7 | undefined,
): UuidV7 | null {
  if (activePriceListId !== undefined) {
    return activePriceListId;
  }

  const listIds = distinctPriceListIds(response);

  // Exactly one list: unambiguous, so infer it. The usual case, and the reason
  // `activePriceListId` is optional at all.
  const soleListId = listIds[0];
  if (listIds.length === 1 && soleListId !== undefined) {
    return soleListId;
  }
  // More than one list and no instruction: refuse. Picking one would mean a
  // guess about what a customer is being charged, made silently, on a screen
  // that looks identical either way. Forcing the caller to be explicit costs
  // one argument at the call site; a wrong guess costs a wrong price, a
  // mis-reconciled shift, and no evidence of which list was used.
  if (listIds.length > 1) {
    return null;
  }

  // No price entries at all. There is no list to be ambiguous about, so this is
  // not an ambiguity failure: every variant simply has no price, and is
  // skipped as `no_price_entry`.
  return null;
}
// ─────────────────────────────────────────────────────────────────────────────
// Duplicate price entries
//
// Rule 4. The contract does not promise (price_list_id, product_variant_id) is
// unique — a real deployment should add that unique constraint server-side, and
// until it does, a duplicated row must not make the terminal non-deterministic.
// Two terminals that disagree about a price produce two shift reports.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Which of two entries for the same variant wins.
 *
 * Highest `version` first, because that is the contract's own last-write-wins
 * rule. On a tie, the lexicographically smallest entry `id` — arbitrary but
 * fixed, and the same arbitrary answer on every terminal, which is the property
 * that actually matters here. Two runs of the same payload cannot differ.
 */
function pickWinningEntry(
  candidate: PriceListEntry,
  incumbent: PriceListEntry | undefined,
): PriceListEntry {
  if (incumbent === undefined) {
    return candidate;
  }
  if (candidate.version > incumbent.version) {
    return candidate;
  }
  if (candidate.version < incumbent.version) {
    return incumbent;
  }
  return candidate.id < incumbent.id ? candidate : incumbent;
}
/**
 * Index the active list's entries by variant, one winner per variant.
 *
 * Entries from other lists are dropped here rather than filtered later, so no
 * downstream code can accidentally read a promotional price as the list price.
 */
function indexActivePrices(
  response: CatalogResponse,
  priceListId: UuidV7,
): ReadonlyMap<UuidV7, PriceListEntry> {
  const winners = new Map<UuidV7, PriceListEntry>();
  for (const entry of response.price_list_entries) {
    if (entry.price_list_id !== priceListId) {
      continue;
    }
    const incumbent = winners.get(entry.product_variant_id);
    winners.set(entry.product_variant_id, pickWinningEntry(entry, incumbent));
  }
  return winners;
}
// ─────────────────────────────────────────────────────────────────────────────
// THE MONEY BOUNDARY
//
// Rule 5, and the reason this file exists.
//
// The contract says `Satang` is `type: integer, format: int64`, and
// openapi-typescript turns that into a TypeScript `number`. That is the one
// place a float can enter this codebase, and it is this line. JSON has no
// integer type, so `4550` arrives, is parsed by `JSON.parse`, and becomes a
// double. That is fine *only* while it is still a whole number inside the
// exactly-representable range — which is precisely what is checked here.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Convert a wire satang count into a `Money`, or reject it.
 *
 * `Number.isSafeInteger` is the whole check, and it is stricter than it looks.
 * It rejects `45.5` (not a whole number — a float already got in), `-1` and
 * every negative (a negative *price* is a refund, and putting one on a menu
 * button would silently credit the cashier on every tap), `NaN` and `Infinity`
 * (a parse artefact, which would otherwise become `BigInt(NaN)` and throw),
 * and anything past 2^53-1, where a double starts silently dropping satang.
 * Past that check the value is exact, so `BigInt` of it is lossless, and
 * `Money.fromSatang` takes a `bigint` and refuses a `number` — so this function
 * is the one and only door from wire money into domain money.
 *
 * The terminal is the last line of defence, not the first: the server is
 * authoritative and is expected to reject a bad price on write. This check
 * exists because a terminal is offline-first, so a snapshot written on a
 * terminal nobody is watching can still be in local SQLite when the register
 * boots. Catch it here and one drink disappears; do not, and it sells at ฿0.00.
 */
function toUnitPrice(wireSatang: Satang): Money | null {
  // `typeof` first: the contract's type is a promise, not a guarantee, and a
  // deserialiser that hands back a string must be rejected rather than coerced.
  if (typeof wireSatang !== 'number' || !Number.isSafeInteger(wireSatang)) {
    return null;
  }
  if (wireSatang < 0) {
    return null;
  }
  return Money.fromSatang(BigInt(wireSatang));
}
// ─────────────────────────────────────────────────────────────────────────────
// Category resolution
//
// A variant has no category of its own; its product does. The join is a plain
// lookup built once per snapshot, because the grid asks for it per row and a
// linear scan per row would be O(variants x products) on a slow terminal.
// ─────────────────────────────────────────────────────────────────────────────

function indexCategoryByProduct(response: CatalogResponse): ReadonlyMap<UuidV7, UuidV7 | null> {
  const byProduct = new Map<UuidV7, UuidV7 | null>();
  for (const product of response.products) {
    byProduct.set(product.id, product.category_id ?? null);
  }
  return byProduct;
}
// ─────────────────────────────────────────────────────────────────────────────
// buildCatalog
//
// The one function that reads the whole snapshot. It iterates
// `response.variants` in order and never sorts, because the snapshot order is
// what the server chose to present and re-ordering a menu by, say, SKU would
// make the grid jump around between pulls for no reason a cashier asked for.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a catalog snapshot into the sellable menu for one price list.
 *
 * Every variant gets a verdict: it lands in `entries`, or it lands in
 * `skipped` with a reason. Nothing is thrown, and the input is not mutated.
 *
 * @param response - A `CatalogResponse` as pulled from `GET /catalog`.
 * @param options - Names the active price list when the caller knows it.
 * @returns A frozen `CatalogIndex`. Same input, same output, always.
 *
 * The precedence for a variant, and why it is in this order:
 *   1. inactive      — a retired SKU is not sellable, whatever it is priced at.
 *   2. ambiguous     — with no list in effect, no variant can be priced at all.
 *   3. no entry      — nothing in the active list prices this variant.
 *   4. invalid price — a price arrived but is not an exact satang integer.
 *
 * Inactivity is checked first because it is a fact about the SKU rather than
 * about this snapshot: reporting a retired variant as "no price" would send the
 * shift lead hunting for a pricing fault that does not exist.
 */
export function buildCatalog(
  response: CatalogResponse,
  options?: BuildCatalogOptions,
): CatalogIndex {
  const requestedListId = options?.activePriceListId;
  const priceListId = resolvePriceListId(response, requestedListId);

  // Ambiguity is a property of the snapshot, not of any one variant: when the
  // payload held more than one list and the caller named none, no price in it
  // can be trusted as the price to sell at. So no list is in effect, and every
  // variant that would otherwise have been priced is skipped for that reason.
  const isAmbiguous =
    priceListId === null && distinctPriceListIds(response).length > 1;
  const activePrices = priceListId === null ? null : indexActivePrices(response, priceListId);
  const categoryByProduct = indexCategoryByProduct(response);

  const entries: CatalogEntry[] = [];
  const skipped: SkippedVariant[] = [];
  const byVariantId = new Map<UuidV7, CatalogEntry>();
  for (const variant of response.variants) {
    // Rule 2. A retired variant is not sellable, whatever price it carries.
    if (!variant.is_active) {
      skipped.push(skip(variant.id, variant.sku, 'inactive_variant'));
      continue;
    }

    // Rule 1, refusal branch. Refusing to guess is the whole behaviour.
    if (isAmbiguous) {
      skipped.push(skip(variant.id, variant.sku, 'ambiguous_price_list'));
      continue;
    }
    // Rule 3. Nothing in the active list prices this variant, so it cannot be
    // sold — and it must not be shown at ฿0.00 either, because a visible ฿0.00
    // is a claim about the price. An item the cashier cannot charge for is an
    // item they must not be able to tap.
    const priceEntry = activePrices === null ? undefined : activePrices.get(variant.id);
    if (priceEntry === undefined) {
      skipped.push(skip(variant.id, variant.sku, 'no_price_entry'));
      continue;
    }
    // Rule 5. The price is the one value that may have arrived as a float.
    // It is skipped, not thrown: one unpriceable row must not hide the menu.
    // Recording it in `skipped` is what lets the UI show a pricing-problem
    // count instead of serving a silently short menu.
    const unitPrice = toUnitPrice(priceEntry.unit_price_satang);
    if (unitPrice === null) {
      skipped.push(skip(variant.id, variant.sku, 'invalid_price'));
      continue;
    }
    // Rule 6: appended in snapshot order. Nothing here sorts.
    const entry: CatalogEntry = Object.freeze({
      variant,
      unitPrice,
      categoryId: categoryByProduct.get(variant.product_id) ?? null,
    });
    entries.push(entry);
    byVariantId.set(variant.id, entry);
  }
  // Rule 7. `readonly` is erased at runtime, so freezing is what actually makes
  // the guarantee: a menu grid that a stray `push` can add to would show an
  // item no price was ever resolved for.
  return Object.freeze({
    entries: Object.freeze(entries),
    byVariantId: Object.freeze(byVariantId),
    categories: Object.freeze([...response.categories]),
    skipped: Object.freeze(skipped),
    priceListId,
  });
}
// ─────────────────────────────────────────────────────────────────────────────
// Internal helper
//
// A function declaration, so it is hoisted: `buildCatalog` above is its only
// caller, and putting the record shape next to the loop that builds it keeps
// the build path readable top to bottom.
// ─────────────────────────────────────────────────────────────────────────────

function skip(variantId: UuidV7, sku: string, reason: SkipReason): SkippedVariant {
  return Object.freeze({ variantId, sku, reason });
}
// ─────────────────────────────────────────────────────────────────────────────
// Queries
//
// Reads over a finished index. None of them throw and none of them sort: a
// grid can be mid-render with a stale id in hand (a barcode scanned for a
// variant that was just retired by a pull), and a lookup that threw there would
// take the register down mid-sale.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sellable entry for a variant, or `undefined`.
 *
 * `undefined` covers both "no such variant" and "that variant is on the
 * `skipped` list". The caller cannot tell them apart, and does not need to: a
 * variant that is not sellable is not on the grid either way.
 */
export function findEntry(index: CatalogIndex, variantId: UuidV7): CatalogEntry | undefined {
  return index.byVariantId.get(variantId);
}

/**
 * **MONEY — Satang (int64).** The unit price for a sellable variant, or
 * `undefined` if the variant is unknown or was skipped. Never a number, and
 * never `Money.zero()`: an absent price and a free item are different facts.
 */
export function unitPriceOf(index: CatalogIndex, variantId: UuidV7): Money | undefined {
  return index.byVariantId.get(variantId)?.unitPrice;
}

/**
 * Every sellable entry in one category, in `entries` order.
 *
 * `null` selects the uncategorised ones. That is a real bucket, not an
 * error case: a variant whose product is uncategorised still has to be
 * sellable, and the grid needs somewhere to put it. Frozen, like everything
 * this module hands out.
 */
export function entriesInCategory(
  index: CatalogIndex,
  categoryId: UuidV7 | null,
): readonly CatalogEntry[] {
  return Object.freeze(index.entries.filter((entry) => entry.categoryId === categoryId));
}
