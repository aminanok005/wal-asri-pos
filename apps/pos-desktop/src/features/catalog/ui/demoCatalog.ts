/**
 * Demo catalog snapshot — the menu the grid sells from before sync exists.
 *
 * LAYER: UI fixtures. This is data, not logic: it stands in for the payload the
 * sync engine will eventually pull from `GET /catalog` and write into local
 * SQLite, so the grid, the price resolution and the cart can be built and tested
 * end to end with no server, no database and no network.
 *
 * The menu is the one in `GreenTable POS V4.html`, in Thai, with every price an
 * exact integer count of satang: ฿45.50 is `4550`. `Satang` is `integer,
 * format: int64` in the contract, so a float written here would not be a
 * shortcut — it would be the fault the domain is written to catch.
 *
 * Every id is a distinct, deterministic, UUIDv7-shaped string from `uid(n)`.
 * Deterministic so a failing test names the same row twice, and counter-ordered
 * so string order equals numeric order, which is what the domain's
 * duplicate-price tie-break compares.
 *
 * ── WHY THESE ROWS TYPED OFF THE GENERATED CONTRACT ────────────────────────
 *
 * Each type below is `Schema<'Name'>` over `components['schemas']`, never a
 * hand-declared interface. A local copy would keep compiling after the contract
 * moved a field, and the first symptom would be a fixture the server rejects in
 * production — which is the class of bug this repo refuses to ship.
 *
 * @see ../domain/catalog.ts — the module this fixture exists to feed
 */

import type { components } from '@wasri/api-types';

/** A generated contract type, addressed by its schema name. */
type Schema<K extends keyof components['schemas']> = components['schemas'][K];

/** UUIDv7 — client-generated, time-ordered (`UuidV7` in the contract). */
export type UuidV7 = Schema<'UuidV7'>;

/** A menu grouping, hierarchical via `parent_id`. */
export type Category = Schema<'Category'>;

/** A sellable concept. Owns the category; carries no price. */
export type Product = Schema<'Product'>;

/** A concrete sellable SKU — the row the grid shows and the cart holds. */
export type ProductVariant = Schema<'ProductVariant'>;

/** The price of one variant under one price list. */
export type PriceListEntry = Schema<'PriceListEntry'>;

/** One catalog snapshot plus the cursor needed to ask for the next delta. */
export type CatalogResponse = Schema<'CatalogResponse'>;

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deterministic, UUIDv7-shaped id from a counter.
 *
 * `018f3c2a-0000-7000-8000-…` — a timestamp prefix, a `7` in the version nibble
 * and an `8` in the variant nibble, which is what makes the string a v7 rather
 * than a v4 that happens to be written by hand.
 */
function uid(n: number): UuidV7 {
  return `018f3c2a-0000-7000-8000-${String(n).padStart(12, '0')}` as UuidV7;
}

/** The branch every row below belongs to. Pricing and VAT are branch-specific. */
export const DEMO_BRANCH_ID: UuidV7 = uid(1);

/** When the demo snapshot was "pulled". Doubles as its sync cursor. */
const DEMO_PULLED_AT = '2026-10-02T09:15:00Z';

// ─────────────────────────────────────────────────────────────────────────────
// Categories
//
// The prototype's own tabs: เครื่องดื่ม, แซนด์วิช, เส้น, สลัด, เบอร์เกอร์,
// คอมโบ. They are flattened into four roots here because a variant's category
// is resolved through its product in one hop, and the demo menu reads better as
// four buckets than as seven nearly identical ones.
// ─────────────────────────────────────────────────────────────────────────────

function category(o: { n: number; nameTh: string; sequence: number }): Category {
  return {
    id: uid(o.n),
    branch_id: DEMO_BRANCH_ID,
    name_th: o.nameTh,
    name_en: null,
    parent_id: null,
    sequence: o.sequence,
    is_active: true,
    version: 1,
    created_at: DEMO_PULLED_AT,
    updated_at: DEMO_PULLED_AT,
  };
}

export const DEMO_CATEGORIES: readonly Category[] = Object.freeze([
  category({ n: 11, nameTh: 'เครื่องดื่ม', sequence: 1 }),
  category({ n: 12, nameTh: 'อาหาร', sequence: 2 }),
  category({ n: 13, nameTh: 'ของหวาน', sequence: 3 }),
  category({ n: 14, nameTh: 'คอมโบ', sequence: 4 }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Products
//
// A product owns the category; a variant never does. The join happens in the
// domain, so this is the row that decides which tab a drink appears under.
// ─────────────────────────────────────────────────────────────────────────────

function product(o: {
  n: number;
  nameTh: string;
  categoryId: UuidV7 | null;
  isCombo?: boolean;
}): Product {
  return {
    id: uid(o.n),
    branch_id: DEMO_BRANCH_ID,
    category_id: o.categoryId,
    name_th: o.nameTh,
    name_en: null,
    is_active: true,
    is_combo: o.isCombo ?? false,
    recipe_id: null,
    image_url: null,
    version: 1,
    created_at: DEMO_PULLED_AT,
    updated_at: DEMO_PULLED_AT,
  };
}

const PRODUCT_DRINKS = uid(21);
const PRODUCT_FOOD = uid(22);
const PRODUCT_SWEETS = uid(23);
const PRODUCT_COMBO = uid(24);

export const DEMO_PRODUCTS: readonly Product[] = Object.freeze([
  product({ n: 21, nameTh: 'กาแฟและชา', categoryId: uid(11) }),
  product({ n: 22, nameTh: 'อาหารปักลอก', categoryId: uid(12) }),
  product({ n: 23, nameTh: 'ของหวาน', categoryId: uid(13) }),
  // A combo sells other variants through its components and still carries its own
  // price, so it needs a price row exactly like any other variant.
  product({ n: 24, nameTh: 'คอมโบเบอร์เกอร์', categoryId: uid(14), isCombo: true }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Variants
//
// Ten sellable SKUs, Thai names, sizes carried as free-form labels because that
// is what `size` is for. `barcode` and `image_url` are present and null rather
// than absent: the contract types them nullable so a deserialiser never breaks on
// their absence, and a fixture that omitted them would not exercise that path.
// ─────────────────────────────────────────────────────────────────────────────

function variant(o: {
  n: number;
  sku: string;
  nameTh: string;
  nameEn: string;
  productId: UuidV7;
  size?: string | null;
  isActive?: boolean;
}): ProductVariant {
  return {
    id: uid(o.n),
    product_id: o.productId,
    sku: o.sku,
    barcode: null,
    name_th: o.nameTh,
    name_en: o.nameEn,
    size: o.size ?? null,
    image_url: null,
    is_active: o.isActive ?? true,
    version: 1,
    created_at: DEMO_PULLED_AT,
    updated_at: DEMO_PULLED_AT,
  };
}

export const DEMO_VARIANTS: readonly ProductVariant[] = Object.freeze([
  variant({ n: 101, sku: 'BEV-LATTE-12', nameTh: 'กาแฟลาเต้', nameEn: 'Iced Latte', size: '12 ออนซ์', productId: PRODUCT_DRINKS }),
  variant({ n: 102, sku: 'BEV-MOCHA-12', nameTh: 'มอคค่า', nameEn: 'Mocha', size: '12 ออนซ์', productId: PRODUCT_DRINKS }),
  variant({ n: 103, sku: 'BEV-THAI-12', nameTh: 'ชาไทย', nameEn: 'Thai Tea', size: '12 ออนซ์', productId: PRODUCT_DRINKS }),
  variant({ n: 104, sku: 'BEV-HOT-12', nameTh: 'กาแฟร้อน', nameEn: 'Hot Coffee', size: '12 ออนซ์', productId: PRODUCT_DRINKS }),
  // ── Retired SKU, deliberately in the payload ──────────────────────────────
  // A winter-only soup: still priced below, still valid on every historical
  // order, and still not sellable. It is here so the grid's `inactive_variant`
  // skip is visible in the demo data itself rather than only in a test that had
  // to invent the row. A real snapshot always contains a few of these.
  variant({ n: 105, sku: 'FOOD-SOUP-01', nameTh: 'ซุปมิโสะ', nameEn: 'Miso Soup', productId: PRODUCT_FOOD, isActive: false }),
  variant({ n: 106, sku: 'FOD-BAGEL-01', nameTh: 'เบเกอรี่ไก่', nameEn: 'Chicken Bagel', size: '1 ชิ้น', productId: PRODUCT_FOOD }),
  variant({ n: 107, sku: 'SWT-CAKE-01', nameTh: 'เค้กกล้วยหอม', nameEn: 'Banana Cake', size: '1 ชิ้น', productId: PRODUCT_SWEETS }),
  variant({ n: 108, sku: 'BEV-WATER-01', nameTh: 'น้ำเปล่า', nameEn: 'Plain Water', size: '500 มล.', productId: PRODUCT_DRINKS }),
  variant({ n: 109, sku: 'CMB-BERRY-01', nameTh: 'สมูทตี้เบอร์เกอร์คอมโบ', nameEn: 'Berry Burger Combo', productId: PRODUCT_COMBO }),
  // ── Deliberately left UNPRICED ───────────────────────────────────────────
  // There is no `PriceListEntry` for this one, anywhere below. It is active and
  // it has a product and a category, so the only thing standing between it and a
  // customer is the absence of a price. The grid must withhold it — showing it
  // at ฿0.00 would be a claim about the price that nobody made, and a cashier
  // could tap it. This row is where that behaviour becomes visible in the demo.
  variant({ n: 110, sku: 'BEV-MILK-01', nameTh: 'นมสด', nameEn: 'Fresh Milk', size: '250 มล.', productId: PRODUCT_DRINKS }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Prices
//
// `unit_price_satang` is a quoted digit STRING — the contract's `Satang` schema
// is `type: string`, pattern `^(0|[1-9][0-9]*)$`. That is now the strongest
// boundary check in this codebase: a `number` cannot be assigned to the field at
// all, where the previous `number` typing let a float through and relied on the
// domain check to catch what JSON.parse produced.
//
// This fixture takes `satang` as a `number` only so the literals below stay
// readable as amounts, and converts at this one point with `String()`. The
// conversion is total because every literal is a whole integer, which is why
// `String()` cannot produce a decimal or an exponent form here.
// ─────────────────────────────────────────────────────────────────────────────

/** The branch's one price list in play. */
const DEMO_PRICE_LIST_ID: UuidV7 = uid(31);

/** A promotional list, opt-in only — see `buildDemoSnapshot`. */
const DEMO_PROMO_PRICE_LIST_ID: UuidV7 = uid(32);

function price(o: {
  n: number;
  variantId: UuidV7;
  satang: number;
  listId?: UuidV7;
}): PriceListEntry {
  return {
    id: uid(o.n),
    price_list_id: o.listId ?? DEMO_PRICE_LIST_ID,
    product_variant_id: o.variantId,
    unit_price_satang: String(o.satang),
    currency_code: 'THB',
    version: 1,
    created_at: DEMO_PULLED_AT,
    updated_at: DEMO_PULLED_AT,
  };
}

export const DEMO_PRICE_LIST_ENTRIES: readonly PriceListEntry[] = Object.freeze([
  // ฿45.50 / ฿60.00 / ฿35.00 — the same three prices the cart tests assert, so the
  // grid and the basket agree about what a latte costs.
  price({ n: 201, variantId: uid(101), satang: 4550 }),
  price({ n: 202, variantId: uid(102), satang: 6000 }),
  price({ n: 203, variantId: uid(103), satang: 3500 }),
  price({ n: 204, variantId: uid(104), satang: 4000 }),
  // The retired soup keeps a price row on purpose: "inactive" and "unpriced" are
  // different facts, and only a priced-but-retired row proves the domain
  // distinguishes them.
  price({ n: 205, variantId: uid(105), satang: 5500 }),
  price({ n: 206, variantId: uid(106), satang: 6500 }),
  price({ n: 207, variantId: uid(107), satang: 5500 }),
  price({ n: 208, variantId: uid(108), satang: 1500 }),
  // ฿99.00, down from the struck-through ฿129.00 the prototype shows. A
  // promotion never edits this number — a discount is resolved at checkout — so
  // the list price stays comparable across periods.
  price({ n: 209, variantId: uid(109), satang: 9900 }),
  // No row for uid(110). See the unpriced-variant note above.
]);

/**
 * Rows belonging to the promotional list, kept out of the exported set on purpose.
 *
 * They exist only so `buildDemoSnapshot({ includeSecondPriceList: true })` can
 * produce a payload with two lists in it. Two lists with no list named is the one
 * situation `buildCatalog` refuses to resolve: guessing would mean guessing what a
 * customer is charged, silently, on a screen that looks identical either way.
 */
const DEMO_PROMO_PRICE_LIST_ENTRIES: readonly PriceListEntry[] = Object.freeze([
  price({ n: 301, variantId: uid(101), satang: 3500, listId: DEMO_PROMO_PRICE_LIST_ID }),
  price({ n: 302, variantId: uid(109), satang: 8900, listId: DEMO_PROMO_PRICE_LIST_ID }),
]);

/**
 * Build the demo snapshot, optionally with a second price list.
 *
 * The option is here so the ambiguity path can be *shown* rather than described:
 * pass `includeSecondPriceList` and the payload carries two lists with no list
 * named, so `buildCatalog` resolves no price list at all and withholds every
 * variant it cannot price. The default snapshot is unambiguous — one list — which
 * is what a real branch normally looks like.
 */
export function buildDemoSnapshot(options?: {
  readonly includeSecondPriceList?: boolean;
}): CatalogResponse {
  const promo =
    options?.includeSecondPriceList === true ? DEMO_PROMO_PRICE_LIST_ENTRIES : [];

  return {
    branch_id: DEMO_BRANCH_ID,
    // Spreads, not the frozen constants: the contract types these arrays
    // mutably — they describe a wire payload — and a fixture that handed the
    // domain a `readonly` array would not typecheck against that contract type.
    categories: [...DEMO_CATEGORIES],
    products: [...DEMO_PRODUCTS],
    variants: [...DEMO_VARIANTS],
    price_list_entries: [...DEMO_PRICE_LIST_ENTRIES, ...promo],
    cursor: DEMO_PULLED_AT,
    pulled_at: DEMO_PULLED_AT,
    // `null` means the payload is complete: there is no next page to ask for.
    next_cursor: null,
  };
}

/** The default demo snapshot: one price list, so nothing is ambiguous. */
export const DEMO_SNAPSHOT: CatalogResponse = buildDemoSnapshot();
