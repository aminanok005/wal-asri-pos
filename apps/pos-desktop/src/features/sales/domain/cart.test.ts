import { describe, expect, it } from 'bun:test';
import type { components } from '@wasri/api-types';
import { Money } from '../../payments/domain/money';
import {
  addItem,
  calculateLineTotal,
  calculateLineTotals,
  calculateSubtotal,
  clearCart,
  createCart,
  describeCart,
  findItem,
  isEmpty,
  lineCount,
  quantitiesByVariant,
  removeItem,
  totalUnits,
  updateQuantity,
  updateUnitPrice,
  CartError,
} from './cart';
import type { Cart, ProductVariant, UuidV7 } from './cart';

/**
 * Build a minimal but valid ProductVariant. Only the fields the cart reads are
 * filled; the rest are irrelevant to cart arithmetic.
 */
function variant(id: string, sku: string, nameTh: string, isActive = true): ProductVariant {
  return {
    id: id as UuidV7,
    product_id: '018f3c2a-0000-7000-8000-000000000001' as UuidV7,
    sku,
    barcode: null,
    name_th: nameTh,
    name_en: null,
    size: null,
    image_url: null,
    is_active: isActive,
    version: 1,
    created_at: '2026-10-02T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  };
}

const LATTE = variant('018f3c2a-0000-7000-8000-00000000000a', 'BEV-LATTE', 'ลาเต้');
const MOCHA = variant('018f3c2a-0000-7000-8000-00000000000b', 'BEV-MOCHA', 'มอคค่า');
const DISABLED = variant('018f3c2a-0000-7000-8000-00000000000c', 'OLD', 'เก่า', false);

const ID_1 = '018f3c2a-0000-7000-8000-0000000000a1' as UuidV7;
const ID_2 = '018f3c2a-0000-7000-8000-0000000000a2' as UuidV7;
const ID_3 = '018f3c2a-0000-7000-8000-0000000000a3' as UuidV7;

/** Add a line and return both the cart and the line id used. */
function withItem(
  cart: Cart = createCart(),
  v: ProductVariant = LATTE,
  quantity: bigint = 1n,
  priceSatang: bigint = 4550n,
  id: UuidV7 = ID_1,
) {
  return { cart: addItem(cart, v, quantity, Money.fromSatang(priceSatang), id), id };
}

describe('construction', () => {
  it('starts empty', () => {
    const cart = createCart();
    expect(isEmpty(cart)).toBe(true);
    expect(lineCount(cart)).toBe(0);
    expect(cart.items).toHaveLength(0);
  });

  it('an empty cart totals exactly zero, not undefined', () => {
    const subtotal = calculateSubtotal(createCart());
    expect(subtotal).toBeInstanceOf(Money);
    expect(subtotal.satang).toBe(0n);
    expect(subtotal.isZero()).toBe(true);
  });
});

describe('addItem', () => {
  it('adds a line with quantity and price', () => {
    const { cart, id } = withItem();
    expect(lineCount(cart)).toBe(1);

    const item = findItem(cart, id);
    expect(item?.variant.sku).toBe('BEV-LATTE');
    expect(item?.quantity).toBe(1n);
    expect(item?.unitPrice.satang).toBe(4550n);
  });

  it('converts a wire satang number into a Money without float loss', () => {
    // The contract carries Satang as `number`; the domain works in `bigint`.
    // This is the boundary, and it must be exact.
    const wireSatang: number = 4550;
    const { cart } = withItem(createCart(), LATTE, 1n, BigInt(wireSatang));
    expect(cart.items[0]?.unitPrice.satang).toBe(4550n);
    expect(cart.items[0]?.unitPrice.toString()).toBe('45.50');
  });

  it('returns a NEW cart and leaves the original untouched', () => {
    const original = createCart();
    const next = addItem(original, LATTE, 1n, Money.fromSatang(4550n), ID_1);

    expect(next).not.toBe(original);
    expect(lineCount(original)).toBe(0);
    expect(lineCount(next)).toBe(1);
  });

  it('merges a repeated variant into one line and sums the quantity', () => {
    const once = addItem(createCart(), LATTE, 1n, Money.fromSatang(4550n), ID_1);
    const twice = addItem(once, LATTE, 2n, Money.fromSatang(4550n), ID_2);

    expect(lineCount(twice)).toBe(1);
    expect(twice.items[0]?.quantity).toBe(3n);
    expect(totalUnits(twice)).toBe(3n);
  });

  it('keeps the ORIGINAL price when merging a repeat at a different price', () => {
    // The cashier scanned at 4550. A price change mid-sale must not silently
    // reprice a line already on screen.
    const first = addItem(createCart(), LATTE, 1n, Money.fromSatang(4550n), ID_1);
    const merged = addItem(first, LATTE, 1n, Money.fromSatang(9999n), ID_2);

    expect(merged.items[0]?.unitPrice.satang).toBe(4550n);
  });

  it('keeps distinct variants on separate lines', () => {
    let cart = addItem(createCart(), LATTE, 1n, Money.fromSatang(4550n), ID_1);
    cart = addItem(cart, MOCHA, 1n, Money.fromSatang(6000n), ID_2);

    expect(lineCount(cart)).toBe(2);
    expect(totalUnits(cart)).toBe(2n);
  });

  it('preserves insertion order', () => {
    let cart = addItem(createCart(), LATTE, 1n, Money.fromSatang(4550n), ID_1);
    cart = addItem(cart, MOCHA, 1n, Money.fromSatang(6000n), ID_2);

    expect(cart.items[0]?.variant.sku).toBe('BEV-LATTE');
    expect(cart.items[1]?.variant.sku).toBe('BEV-MOCHA');
  });

  it('rejects an inactive variant', () => {
    expect(() => addItem(createCart(), DISABLED, 1n, Money.fromSatang(100n), ID_1)).toThrow(
      CartError,
    );
  });

  it('rejects a zero or negative quantity', () => {
    expect(() => addItem(createCart(), LATTE, 0n, Money.fromSatang(100n), ID_1)).toThrow(CartError);
    expect(() => addItem(createCart(), LATTE, -1n, Money.fromSatang(100n), ID_1)).toThrow(CartError);
  });

  it('rejects a negative price', () => {
    expect(() => addItem(createCart(), LATTE, 1n, Money.fromSatang(-1n), ID_1)).toThrow(CartError);
  });

  it('freezes the cart so it cannot be mutated in place', () => {
    const { cart } = withItem();
    expect(Object.isFrozen(cart)).toBe(true);
    expect(Object.isFrozen(cart.items)).toBe(true);
    expect(Object.isFrozen(cart.items[0])).toBe(true);
  });
});

describe('removeItem', () => {
  it('removes the matching line', () => {
    const { cart, id } = withItem();
    const after = removeItem(cart, id);
    expect(isEmpty(after)).toBe(true);
  });

  it('leaves other lines untouched', () => {
    let cart = addItem(createCart(), LATTE, 1n, Money.fromSatang(4550n), ID_1);
    cart = addItem(cart, MOCHA, 1n, Money.fromSatang(6000n), ID_2);

    const after = removeItem(cart, ID_1);
    expect(lineCount(after)).toBe(1);
    expect(after.items[0]?.id).toBe(ID_2);
  });

  it('is a no-op for an unknown id rather than an error', () => {
    const { cart } = withItem();
    const after = removeItem(cart, 'does-not-exist' as UuidV7);
    expect(lineCount(after)).toBe(1);
  });
});

describe('updateQuantity', () => {
  it('sets a new quantity', () => {
    const { cart, id } = withItem();
    const after = updateQuantity(cart, id, 5n);
    expect(after.items[0]?.quantity).toBe(5n);
  });

  it('REMOVES the line when the quantity is zero', () => {
    // A zero-quantity line would total nothing yet still appear in the item
    // count. Deleting is what the cashier meant.
    const { cart, id } = withItem();
    const after = updateQuantity(cart, id, 0n);
    expect(isEmpty(after)).toBe(true);
  });

  it('rejects a negative quantity', () => {
    const { cart, id } = withItem();
    expect(() => updateQuantity(cart, id, -1n)).toThrow(CartError);
  });

  it('throws for an unknown line id', () => {
    const { cart } = withItem();
    expect(() => updateQuantity(cart, 'nope' as UuidV7, 2n)).toThrow(CartError);
  });

  it('does not mutate the original', () => {
    const { cart, id } = withItem();
    updateQuantity(cart, id, 99n);
    expect(cart.items[0]?.quantity).toBe(1n);
  });
});

describe('updateUnitPrice', () => {
  it('replaces the captured price', () => {
    const { cart, id } = withItem();
    const after = updateUnitPrice(cart, id, Money.fromSatang(5000n));
    expect(after.items[0]?.unitPrice.satang).toBe(5000n);
    expect(after.items[0]?.quantity).toBe(1n);
  });

  it('rejects a negative price and an unknown line', () => {
    const { cart, id } = withItem();
    expect(() => updateUnitPrice(cart, id, Money.fromSatang(-1n))).toThrow(CartError);
    expect(() => updateUnitPrice(cart, 'nope' as UuidV7, Money.fromSatang(1n))).toThrow(CartError);
  });
});

describe('calculateLineTotal', () => {
  it('multiplies price by quantity exactly', () => {
    const { cart } = withItem(createCart(), LATTE, 3n, 4550n);
    expect(calculateLineTotal(cart.items[0]!).satang).toBe(13650n);
  });

  it('does not drift on the classic float trap (3 × ฿0.10)', () => {
    // In float this is 0.30000000000000004. In satang it is exact.
    const { cart } = withItem(createCart(), LATTE, 3n, 10n);
    expect(calculateLineTotal(cart.items[0]!).satang).toBe(30n);
  });
});

describe('calculateSubtotal', () => {
  it('sums the line totals', () => {
    let cart = addItem(createCart(), LATTE, 2n, Money.fromSatang(4550n), ID_1);
    cart = addItem(cart, MOCHA, 1n, Money.fromSatang(6000n), ID_2);

    // 2 × 4550 = 9100, plus 6000 = 15100
    expect(calculateSubtotal(cart).satang).toBe(15100n);
  });

  it('always returns a Money, never a number', () => {
    const { cart } = withItem();
    expect(calculateSubtotal(cart)).toBeInstanceOf(Money);
  });

  it('has no float drift across many lines', () => {
    // 100 lines of ฿0.10 at quantity 1. Float would accumulate visible error.
    let cart = createCart();
    for (let i = 0; i < 100; i += 1) {
      cart = addItem(
        cart,
        variant(`018f3c2a-0000-7000-8000-${i.toString().padStart(12, '0')}`, `SKU-${i}`, `Item ${i}`),
        1n,
        Money.fromSatang(10n),
        `018f3c2a-0000-7000-8001-${i.toString().padStart(12, '0')}` as UuidV7,
      );
    }
    expect(calculateSubtotal(cart).satang).toBe(1000n);
  });

  it('excludes tax and discounts — subtotal is a sum of lines only', () => {
    const { cart } = withItem();
    // ฿45.50 exactly, not a tax-inclusive figure.
    expect(calculateSubtotal(cart).toString()).toBe('45.50');
  });
});

describe('calculateLineTotals', () => {
  it('returns a per-line breakdown in cart order', () => {
    let cart = addItem(createCart(), LATTE, 2n, Money.fromSatang(4550n), ID_1);
    cart = addItem(cart, MOCHA, 1n, Money.fromSatang(6000n), ID_2);

    const totals = calculateLineTotals(cart);
    expect(totals.map((t) => t.satang)).toEqual([9100n, 6000n]);
    expect(Money.sum(totals).satang).toBe(calculateSubtotal(cart).satang);
  });
});

describe('clearCart', () => {
  it('empties the cart', () => {
    const { cart } = withItem();
    expect(isEmpty(clearCart())).toBe(true);
  });
});

describe('describeCart', () => {
  it('describes an empty cart', () => {
    expect(describeCart(createCart())).toBe('Cart is empty');
  });

  it('lists each line and the total', () => {
    let cart = addItem(createCart(), LATTE, 2n, Money.fromSatang(4550n), ID_1);
    cart = addItem(cart, MOCHA, 1n, Money.fromSatang(6000n), ID_2);

    expect(describeCart(cart)).toBe('2 × ลาเต้ @ 45.50 + 1 × มอคค่า @ 60.00 = 151.00');
  });
});

describe('purity', () => {
  it('every operation leaves the input cart and its lines untouched', () => {
    const original = addItem(createCart(), LATTE, 2n, Money.fromSatang(4550n), ID_1);
    const snapshotQuantity = original.items[0]?.quantity;
    const snapshotTotal = calculateSubtotal(original).satang;

    addItem(original, MOCHA, 1n, Money.fromSatang(6000n), ID_2);
    updateQuantity(original, ID_1, 99n);
    updateUnitPrice(original, ID_1, Money.fromSatang(1n));
    removeItem(original, ID_1);
    calculateSubtotal(original);

    expect(original.items[0]?.quantity).toBe(snapshotQuantity);
    expect(calculateSubtotal(original).satang).toBe(snapshotTotal);
  });

  it('is deterministic: the same input yields an equal cart', () => {
    const a = addItem(createCart(), LATTE, 2n, Money.fromSatang(4550n), ID_1);
    const b = addItem(createCart(), LATTE, 2n, Money.fromSatang(4550n), ID_1);
    expect(calculateSubtotal(a).equals(calculateSubtotal(b))).toBe(true);
  });
});

describe('quantitiesByVariant', () => {
  const MOCHA = variant('018f3c2a-0000-7000-8000-00000000000b', 'BEV-MOCHA', 'มอคค่า');
  const LATTE_PRICE = Money.fromSatang(4550n);
  const MOCHA_PRICE = Money.fromSatang(6000n);

  it('is empty for an empty cart — not a map full of zeroes', () => {
    // The grid treats an ABSENT entry as "none in the basket" and a zero as a
    // value it has to suppress. A map pre-filled with every known variant at 0
    // would make those two cases indistinguishable at the call site.
    expect(quantitiesByVariant(createCart()).size).toBe(0);
  });

  it('keys by VARIANT id, which is what a grid tile knows', () => {
    const cart = addItem(createCart(), LATTE, 2n, LATTE_PRICE, ID_1);
    const quantities = quantitiesByVariant(cart);

    // Keyed by `item.variant.id`, NOT by the line id — a tile has never heard of
    // a cart line id, so a map keyed by it would answer nothing useful.
    expect(quantities.get(LATTE.id)).toBe(2n);
    expect(quantities.get(ID_1)).toBeUndefined();
  });

  it('merges repeat additions of one variant into the single quantity', () => {
    // `addItem` merges on repeat, so there is one LINE — and this asserts the
    // map still reports the summed quantity rather than the last one written.
    let cart = addItem(createCart(), LATTE, 2n, LATTE_PRICE, ID_1);
    cart = addItem(cart, LATTE, 3n, LATTE_PRICE, ID_2);

    expect(cart.items).toHaveLength(1);
    expect(quantitiesByVariant(cart).get(LATTE.id)).toBe(5n);
  });

  it('holds one entry per variant, with two variants side by side', () => {
    let cart = addItem(createCart(), LATTE, 1n, LATTE_PRICE, ID_1);
    cart = addItem(cart, MOCHA, 4n, MOCHA_PRICE, ID_2);

    const quantities = quantitiesByVariant(cart);
    expect(quantities.size).toBe(2);
    expect(quantities.get(LATTE.id)).toBe(1n);
    expect(quantities.get(MOCHA.id)).toBe(4n);
  });

  it('agrees with totalUnits, summed over its own entries', () => {
    // The map and the count are two answers to "how much is in the basket". If
    // they could disagree, a tile badged ×2 beside a header saying 1 รายการ
    // would be on screen with no way to tell which was wrong.
    let cart = addItem(createCart(), LATTE, 3n, LATTE_PRICE, ID_1);
    cart = addItem(cart, MOCHA, 4n, MOCHA_PRICE, ID_2);

    const summed = [...quantitiesByVariant(cart).values()].reduce((a, b) => a + b, 0n);
    expect(summed).toBe(totalUnits(cart));
  });

  it('returns a frozen map, so a caller cannot add a phantom line', () => {
    // `readonly` is erased at runtime; the freeze is what actually prevents a
    // view from writing a quantity for a variant the cart does not hold.
    const quantities = quantitiesByVariant(
      addItem(createCart(), LATTE, 1n, LATTE_PRICE, ID_1),
    );
    expect(Object.isFrozen(quantities)).toBe(true);
  });
});

describe('domain boundary', () => {
  it('imports nothing from React, Tauri, SQL, or a network client', async () => {
    // Enforced structurally, not by convention. `cart.ts` has no import of any
    // of these; if a future edit adds one, this fails.
    const source = await Bun.file(new URL('./cart.ts', import.meta.url)).text();
    expect(source).not.toMatch(/from ['"]react['"]/);
    expect(source).not.toMatch(/@tauri-apps/);
    expect(source).not.toMatch(/@tanstack/);
    expect(source).not.toMatch(/zustand/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/from ['"]node:/);
  });
});
