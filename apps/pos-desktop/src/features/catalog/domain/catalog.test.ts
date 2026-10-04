import { describe, expect, it } from 'bun:test';
import { Money } from '../../payments/domain/money';
import { buildCatalog, entriesInCategory, findEntry, unitPriceOf } from './catalog';
import type {
  CatalogIndex,
  CatalogResponse,
  Category,
  PriceListEntry,
  Product,
  ProductVariant,
  SkipReason,
  UuidV7,
} from './catalog';
/**
 * Ids come from a counter so that lexicographic order equals numeric order.
 *
 * The duplicate-price tie-break compares entry ids as strings, so a test built
 * on hand-typed uuids would be one careless edit away from asserting the wrong
 * winner and still passing.
 */
function uid(n: number): UuidV7 {
  return `018f3c2a-0000-7000-8000-${String(n).padStart(12, '0')}` as UuidV7;
}

const BRANCH = uid(1);
const COFFEE = uid(11);
const FOOD = uid(12);
const PRODUCT_DRINKS = uid(21);
const PRODUCT_FOOD = uid(22);
const LIST_STANDARD = uid(31);
const LIST_PROMO = uid(32);
/** A sellable SKU, pointing at the product that owns its category. */
function variant(n: number, sku: string, productId: UuidV7, isActive = true): ProductVariant {
  return {
    id: uid(n),
    product_id: productId,
    sku,
    name_th: sku,
    is_active: isActive,
    version: 1,
    updated_at: '2026-10-02T00:00:00Z',
  };
}

/** The parent row a variant inherits its category from. */
function product(id: UuidV7, categoryId: UuidV7 | null): Product {
  return {
    id,
    branch_id: BRANCH,
    category_id: categoryId,
    name_th: 'เมนู',
    is_active: true,
    is_combo: false,
    version: 1,
    updated_at: '2026-10-02T00:00:00Z',
  };
}
function category(id: UuidV7, nameTh: string): Category {
  return {
    id,
    branch_id: BRANCH,
    name_th: nameTh,
    sequence: 0,
    is_active: true,
    version: 1,
    updated_at: '2026-10-02T00:00:00Z',
  };
}

/**
 * One price row. `satang` is a `number` only so the call sites read as amounts;
 * the contract's `Satang` schema is a quoted digit string, so it is stringified
 * here at the single point where a fixture crosses into wire shape.
 */
function price(o: {
  id: number;
  listId: UuidV7;
  variantId: UuidV7;
  satang: number;
  version?: number;
}): PriceListEntry {
  return {
    id: uid(o.id),
    price_list_id: o.listId,
    product_variant_id: o.variantId,
    unit_price_satang: String(o.satang),
    currency_code: 'THB',
    version: o.version ?? 1,
    updated_at: '2026-10-02T00:00:00Z',
  };
}

/** A snapshot carrying only what a given test actually cares about. */
function snapshot(over: Partial<CatalogResponse> = {}): CatalogResponse {
  return {
    branch_id: BRANCH,
    categories: [],
    products: [],
    variants: [],
    price_list_entries: [],
    cursor: '2026-10-02T09:15:00Z',
    pulled_at: '2026-10-02T09:15:00Z',
    ...over,
  };
}
/** The reasons, in snapshot order — the shape an assertion usually wants. */
function reasons(index: CatalogIndex): readonly SkipReason[] {
  return index.skipped.map((item) => item.reason);
}

/** SKUs of the sellable rows, in grid order. */
function skus(index: CatalogIndex): readonly string[] {
  return index.entries.map((entry) => entry.variant.sku);
}

/**
 * The UI's own formatting, repeated rather than imported.
 *
 * `CartView.tsx` renders `฿${amount.toString()}`; the domain deliberately holds
 * no currency symbol, because formatting is display and not arithmetic. So the
 * one line is restated here, and the assertion is about what a cashier reads.
 */
function formatBaht(amount: Money): string {
  return `฿${amount.toString()}`;
}
/** One variant priced at whatever `satang` the test wants to attack. */
function pricedAt(satang: number): CatalogIndex {
  return pricedAtWire(String(satang));
}

/**
 * One variant whose wire price is the given STRING, verbatim.
 *
 * Needed because `pricedAt` takes a `number`, and a `number` cannot express a
 * satang count above 2^53-1 — the double rounds it before the boundary ever
 * sees it. Testing the boundary at that magnitude therefore requires the input
 * to arrive as the string it would actually be on the wire, which is the entire
 * point of the string wire form.
 */
function pricedAtWire(spelling: string): CatalogIndex {
  const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
  return buildCatalog(
    snapshot({
      variants: [latte],
      price_list_entries: [
        {
          id: uid(401),
          price_list_id: LIST_STANDARD,
          product_variant_id: latte.id,
          unit_price_satang: spelling,
          currency_code: 'THB',
          version: 1,
          updated_at: '2026-10-02T00:00:00Z',
        },
      ],
    }),
  );
}

describe('active price list resolution', () => {
  it('auto-resolves the one price list present in the snapshot', () => {
    const index = pricedAt(4550);

    expect(index.priceListId).toBe(LIST_STANDARD);
    expect(skus(index)).toEqual(['BEV-LATTE-12']);
  });
  it('honours an explicit list and ignores every other list in the payload', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
          price({ id: 402, listId: LIST_PROMO, variantId: latte.id, satang: 3500 }),
        ],
      }),
      { activePriceListId: LIST_PROMO },
    );

    expect(index.priceListId).toBe(LIST_PROMO);
    expect(unitPriceOf(index, latte.id)?.satang).toBe(3500n);
  });
  it('refuses to guess between two lists — no variant reaches the grid', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const mocha = variant(202, 'BEV-MOCHA-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte, mocha],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
          price({ id: 402, listId: LIST_PROMO, variantId: latte.id, satang: 3500 }),
        ],
      }),
    );

    expect(index.priceListId).toBeNull();
    expect(index.entries).toHaveLength(0);
    expect(reasons(index)).toEqual(['ambiguous_price_list', 'ambiguous_price_list']);
  });
  it('names the SKU of every ambiguous variant, so a manager can be told which item', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
          price({ id: 402, listId: LIST_PROMO, variantId: latte.id, satang: 3500 }),
        ],
      }),
    );

    expect(index.skipped[0]?.variantId).toBe(latte.id);
    expect(index.skipped[0]?.sku).toBe('BEV-LATTE-12');
  });
  it('an empty price payload is unpriced, not ambiguous', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(snapshot({ variants: [latte] }));

    expect(index.priceListId).toBeNull();
    expect(reasons(index)).toEqual(['no_price_entry']);
  });
});

describe('sellability', () => {
  it('skips a retired variant even when it is perfectly priced', () => {
    const seasonal = variant(203, 'BEV-LATTE-ICE', PRODUCT_DRINKS, false);
    const index = buildCatalog(
      snapshot({
        variants: [seasonal],
        price_list_entries: [
          price({ id: 403, listId: LIST_STANDARD, variantId: seasonal.id, satang: 4550 }),
        ],
      }),
    );
    expect(index.entries).toHaveLength(0);
    expect(reasons(index)).toEqual(['inactive_variant']);
  });

  it('skips a variant the active list does not price, and never invents ฿0.00', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({ variants: [latte], price_list_entries: [] }),
    );

    expect(index.entries).toHaveLength(0);
    expect(reasons(index)).toEqual(['no_price_entry']);
    // Absent is not free: a ฿0.00 fallback would be a lie about the price.
    expect(unitPriceOf(index, latte.id)).toBeUndefined();
  });
  it('skips a variant that is priced only in some other list', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const mocha = variant(202, 'BEV-MOCHA-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte, mocha],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
          price({ id: 402, listId: LIST_PROMO, variantId: mocha.id, satang: 5000 }),
        ],
      }),
      { activePriceListId: LIST_STANDARD },
    );
    expect(skus(index)).toEqual(['BEV-LATTE-12']);
    expect(reasons(index)).toEqual(['no_price_entry']);
  });
});

describe('duplicate price entries in the active list', () => {
  it('resolves a duplicate to the highest version', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550, version: 2 }),
          price({ id: 402, listId: LIST_STANDARD, variantId: latte.id, satang: 9900, version: 7 }),
        ],
      }),
    );

    expect(unitPriceOf(index, latte.id)?.satang).toBe(9900n);
  });
  it('breaks a version tie with the lexicographically smallest entry id', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte],
        price_list_entries: [
          // uid(402) > uid(401), so the lower-priced row is the one that wins.
          price({ id: 402, listId: LIST_STANDARD, variantId: latte.id, satang: 1111, version: 3 }),
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 9999, version: 3 }),
        ],
      }),
    );

    expect(unitPriceOf(index, latte.id)?.satang).toBe(9999n);
  });
  it('answers the same way whatever order the duplicates arrive in', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const low = price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 9999, version: 3 });
    const high = price({ id: 402, listId: LIST_STANDARD, variantId: latte.id, satang: 1111, version: 3 });

    const forwards = buildCatalog(
      snapshot({ variants: [latte], price_list_entries: [low, high] }),
    );
    const backwards = buildCatalog(
      snapshot({ variants: [latte], price_list_entries: [high, low] }),
    );

    expect(unitPriceOf(forwards, latte.id)?.satang).toBe(9999n);
    expect(unitPriceOf(backwards, latte.id)?.satang).toBe(9999n);
  });
});

describe('the money boundary', () => {
  it('rejects a fractional satang value — a float already got in', () => {
    const index = pricedAt(45.5);

    expect(index.entries).toHaveLength(0);
    expect(reasons(index)).toEqual(['invalid_price']);
  });

  it('rejects a negative satang value — a negative price is a refund', () => {
    const index = pricedAt(-1);

    expect(index.entries).toHaveLength(0);
    expect(reasons(index)).toEqual(['invalid_price']);
  });
  it('rejects NaN', () => {
    const index = pricedAt(Number.NaN);

    expect(index.entries).toHaveLength(0);
    expect(reasons(index)).toEqual(['invalid_price']);
  });

  it('rejects Infinity', () => {
    const index = pricedAt(Number.POSITIVE_INFINITY);

    expect(index.entries).toHaveLength(0);
    expect(reasons(index)).toEqual(['invalid_price']);
  });
  it('carries a value past 2^53 exactly, where the old numeric wire form dropped satang', () => {
    // The string wire form is why this is now an acceptance rather than a
    // rejection. Under `type: integer` this value arrived as a double and lost
    // precision past 2^53-1, so the boundary had to refuse it. As quoted digits
    // it goes straight to `bigint` and is exact.
    //
    // The input has to be spelled as a string: `Number.MAX_SAFE_INTEGER + 2` is
    // itself rounded to ...992 by the double, so the loss happens in the
    // arithmetic long before the boundary is reached. A `number` cannot even
    // state the value this test is about.
    const index = pricedAtWire('9007199254740993');

    expect(reasons(index)).toEqual([]);
    expect(index.entries[0]?.unitPrice.satang).toBe(9007199254740993n);
  });

  it('accepts the largest satang count a JSON number used to be able to carry', () => {
    const index = pricedAt(Number.MAX_SAFE_INTEGER);

    expect(reasons(index)).toEqual([]);
    expect(index.entries[0]?.unitPrice.satang).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('rejects a non-canonical spelling the pattern forbids', () => {
    // A second spelling of one value is how two clients end up disagreeing about
    // a customer's total at close rather than at the pull, so the grammar is
    // checked rather than delegated to BigInt.
    for (const spelling of ['04550', '-4550', '+4550', '4550.0', ' 4550', '']) {
      const index = pricedAtWire(spelling);

      expect(index.entries).toHaveLength(0);
      expect(reasons(index)).toEqual(['invalid_price']);
    }
  });
  it('one bad price does not take the rest of the menu with it', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const mocha = variant(202, 'BEV-MOCHA-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte, mocha],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 45.5 }),
          price({ id: 402, listId: LIST_STANDARD, variantId: mocha.id, satang: 6000 }),
        ],
      }),
    );

    expect(skus(index)).toEqual(['BEV-MOCHA-12']);
    expect(reasons(index)).toEqual(['invalid_price']);
  });
  it('no float survives the boundary: every price is a bigint, and the sum is exact', () => {
    // 100 cups of ฿0.10. A float would accumulate visible error across the
    // rows; in satang the total is 1000n, and nothing along the way is a number.
    const teas = Array.from({ length: 100 }, (_, i) =>
      variant(1000 + i, `TEA-${i}`, PRODUCT_DRINKS),
    );
    const index = buildCatalog(
      snapshot({
        variants: teas,
        price_list_entries: teas.map((tea, i) =>
          price({ id: 2000 + i, listId: LIST_STANDARD, variantId: tea.id, satang: 10 }),
        ),
      }),
    );

    expect(index.entries).toHaveLength(100);
    for (const entry of index.entries) {
      expect(typeof entry.unitPrice.satang).toBe('bigint');
    }
    expect(Money.sum(index.entries.map((entry) => entry.unitPrice)).satang).toBe(1000n);
  });
});

describe('money exactness', () => {
  it('carries ฿45.50 as exactly 4550 satang, as a bigint, and reads ฿45.50', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
        ],
      }),
    );
    const entry = findEntry(index, latte.id);
    const unitPrice = entry?.unitPrice;

    expect(entry).toBeDefined();
    expect(unitPrice).toBeInstanceOf(Money);
    expect(unitPrice?.satang).toBe(4550n);
    expect(typeof unitPrice?.satang).toBe('bigint');
    expect(unitPrice && formatBaht(unitPrice)).toBe('฿45.50');
  });
});

describe('ordering', () => {
  it('follows response.variants order exactly, and never sorts', () => {
    const khao = variant(203, 'ZZZ-KHAO-THAI', PRODUCT_FOOD);
    const latte = variant(201, 'AAA-LATTE-12', PRODUCT_DRINKS);
    const mocha = variant(202, 'MMM-MOCHA-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [khao, latte, mocha],
        price_list_entries: [khao, latte, mocha].map((v, i) =>
          price({ id: 401 + i, listId: LIST_STANDARD, variantId: v.id, satang: 4550 }),
        ),
      }),
    );

    expect(skus(index)).toEqual(['ZZZ-KHAO-THAI', 'AAA-LATTE-12', 'MMM-MOCHA-12']);
  });

  it('carries the categories through in snapshot order, for the grid headings', () => {
    const index = buildCatalog(
      snapshot({ categories: [category(FOOD, 'อาหาร'), category(COFFEE, 'กาแฟ')] }),
    );

    expect(index.categories.map((c) => c.name_th)).toEqual(['อาหาร', 'กาแฟ']);
  });
});

describe('immutability', () => {
  it('freezes the index, its arrays, the lookup map, and every entry', () => {
    const index = pricedAt(4550);

    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.entries)).toBe(true);
    expect(Object.isFrozen(index.skipped)).toBe(true);
    expect(Object.isFrozen(index.categories)).toBe(true);
    expect(Object.isFrozen(index.byVariantId)).toBe(true);
    expect(Object.isFrozen(index.entries[0])).toBe(true);
  });
  it('freezes each skipped record, and the result of a category filter', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        products: [product(PRODUCT_DRINKS, COFFEE)],
        variants: [latte, variant(202, 'OLD-ONE', PRODUCT_DRINKS, false)],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
        ],
      }),
    );

    expect(Object.isFrozen(index.skipped[0])).toBe(true);
    expect(Object.isFrozen(entriesInCategory(index, COFFEE))).toBe(true);
  });
  it('leaves the snapshot it was given untouched', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const pulled = snapshot({
      variants: [latte],
      price_list_entries: [
        price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
      ],
    });
    const before = JSON.stringify(pulled);

    buildCatalog(pulled);

    expect(JSON.stringify(pulled)).toBe(before);
  });
  it('is deterministic: the same snapshot twice yields the same menu', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const pulled = snapshot({
      variants: [latte, variant(202, 'BEV-MOCHA-12', PRODUCT_DRINKS)],
      price_list_entries: [
        price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
        price({ id: 402, listId: LIST_STANDARD, variantId: uid(202), satang: 6000 }),
        price({ id: 403, listId: LIST_PROMO, variantId: latte.id, satang: 3500 }),
      ],
    });

    const first = buildCatalog(pulled);
    const second = buildCatalog(pulled);

    expect(skus(first)).toEqual(skus(second));
    expect(reasons(first)).toEqual(reasons(second));
    expect(first.priceListId).toBe(second.priceListId);
  });
});

describe('queries', () => {
  it('findEntry returns undefined for a variant that was never in the snapshot', () => {
    const index = pricedAt(4550);

    expect(findEntry(index, uid(999))).toBeUndefined();
    expect(unitPriceOf(index, uid(999))).toBeUndefined();
  });

  it('findEntry returns undefined for a skipped variant, not only an unknown one', () => {
    const seasonal = variant(203, 'BEV-LATTE-ICE', PRODUCT_DRINKS, false);
    const index = buildCatalog(
      snapshot({
        variants: [seasonal],
        price_list_entries: [
          price({ id: 403, listId: LIST_STANDARD, variantId: seasonal.id, satang: 4550 }),
        ],
      }),
    );
    expect(findEntry(index, seasonal.id)).toBeUndefined();
    expect(unitPriceOf(index, seasonal.id)).toBeUndefined();
    expect(index.skipped[0]?.reason).toBe('inactive_variant');
  });

  it('findEntry and unitPriceOf return the very entry the grid is showing', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = pricedAt(4550);
    const entry = findEntry(index, latte.id);

    expect(entry).toBe(index.entries[0]);
    expect(entry?.unitPrice).toBe(unitPriceOf(index, latte.id));
  });
  it('entriesInCategory filters to one category and preserves entries order', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const mocha = variant(202, 'BEV-MOCHA-12', PRODUCT_DRINKS);
    const khao = variant(203, 'FOOD-KHAO-THAI', PRODUCT_FOOD);
    const index = buildCatalog(
      snapshot({
        products: [product(PRODUCT_DRINKS, COFFEE), product(PRODUCT_FOOD, FOOD)],
        variants: [khao, latte, mocha],
        price_list_entries: [khao, latte, mocha].map((v, i) =>
          price({ id: 401 + i, listId: LIST_STANDARD, variantId: v.id, satang: 4550 }),
        ),
      }),
    );
    const inCoffee = entriesInCategory(index, COFFEE);

    expect(inCoffee.map((e) => e.variant.sku)).toEqual(['BEV-LATTE-12', 'BEV-MOCHA-12']);
    expect(entriesInCategory(index, FOOD).map((e) => e.variant.sku)).toEqual([
      'FOOD-KHAO-THAI',
    ]);
    expect(index.entries[0]?.variant.sku).toBe('FOOD-KHAO-THAI');
  });

  it('entriesInCategory(null) returns the uncategorised entries', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        products: [product(PRODUCT_DRINKS, null)],
        variants: [latte],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
        ],
      }),
    );
    expect(entriesInCategory(index, null).map((e) => e.variant.sku)).toEqual([
      'BEV-LATTE-12',
    ]);
    expect(entriesInCategory(index, COFFEE)).toHaveLength(0);
  });

  it('treats a variant whose product is missing from the snapshot as uncategorised', () => {
    const latte = variant(201, 'BEV-LATTE-12', PRODUCT_DRINKS);
    const index = buildCatalog(
      snapshot({
        variants: [latte],
        price_list_entries: [
          price({ id: 401, listId: LIST_STANDARD, variantId: latte.id, satang: 4550 }),
        ],
      }),
    );

    expect(index.entries[0]?.categoryId).toBeNull();
  });
});

describe('domain boundary', () => {
  /** Strip comments so the guard matches CODE, not prose. */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('imports nothing from React, Tauri, SQL, or a network client', async () => {
    const source = stripComments(
      await Bun.file(new URL('./catalog.ts', import.meta.url)).text(),
    );

    expect(source).not.toMatch(/from ['"]react['"]/);
    expect(source).not.toMatch(/@tauri-apps/);
    expect(source).not.toMatch(/@tanstack/);
    expect(source).not.toMatch(/zustand/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/from ['"]node:/);
  });

  it('takes contract types from @wasri/api-types rather than redeclaring them', async () => {
    const source = await Bun.file(new URL('./catalog.ts', import.meta.url)).text();

    expect(source).toContain('components[\'schemas\']');
    expect(source).toContain("from '@wasri/api-types'");
  });
});
