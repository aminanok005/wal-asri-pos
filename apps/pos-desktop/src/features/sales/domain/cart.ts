/**
 * Cart — the basket a cashier is building.
 *
 * LAYER: domain. Pure TypeScript, zero imports beyond this monorepo.
 * No React, no Tauri, no SQL, no HTTP, no external library. That constraint is
 * the point: a cart total is business logic, and business logic that can reach
 * for the network or the DOM will eventually be computed two different ways in
 * two different places.
 *
 * WHY A `Money` OBJECT AND NOT A NUMBER
 *
 * A cart is a sum of multiplications: price × quantity, repeated per line and
 * then added together. In floating point that is the classic
 *
 *     0.10 + 0.20 !== 0.30        and        3 × 0.1 = 0.30000000000000004
 *
 * A POS that prints a total which is not the sum of its lines will not
 * reconcile against the shift report, and the discrepancy is impossible to
 * explain to a shop owner. So every amount here is a `Money`, internally
 * integer satang (`bigint`), and every operation goes through an exact integer
 * method. There is no code path in this file where a monetary value is ever a
 * `number`.
 *
 * WHY `unitPrice` IS CAPTURED, NOT LOOKED UP
 *
 * A line stores the price **as it was when the item was added**. Prices are
 * server-authoritative and can change mid-sale (a manager edits a price list
 * while a basket is open). Re-reading the price at checkout would silently
 * change what the cashier saw when they scanned the item. The basket must show
 * one price per line, consistently. This mirrors how a printed quote works.
 *
 * WHY EVERY FUNCTION RETURNS A NEW CART
 *
 * React state updates, undo/redo, and the outbox all depend on being able to
 * keep a previous basket. Mutation would make "what did the cashier see before
 * they pressed pay?" unanswerable. Every function here is pure: same input,
 * same output, original untouched.
 *
 * Money is immutable too (`Object.freeze` in its constructor), so a
 * `CartItem` cannot be edited in place even by accident.
 *
 * @see ../README.md — the boundary rule this file obeys
 */

import type { components } from '@wasri/api-types';
import { Money } from '../../payments/domain/money';
import { splitInclusive, taxFromInclusive } from './tax';

// ─────────────────────────────────────────────────────────────────────────────
// Contract-derived types
//
// These come from `contracts/openapi.yaml` via `@wasri/api-types`, which is
// GENERATED. Importing them rather than redeclaring the shape means this file
// cannot drift from the contract: change the contract, regenerate, and a
// mismatch becomes a compile error here.
// ─────────────────────────────────────────────────────────────────────────────

/** A generated contract type, addressed by its schema name. */
type Schema<K extends keyof components['schemas']> = components['schemas'][K];

/** UUIDv7 — client-generated, time-ordered (`UuidV7` in the contract). */
export type UuidV7 = Schema<'UuidV7'>;

/** Money on the wire: an integer count of satang (`Satang` in the contract). */
export type Satang = Schema<'Satang'>;

/** A sellable SKU, including its price-bearing identity (`ProductVariant`). */
export type ProductVariant = Schema<'ProductVariant'>;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CartError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quantity
//
// A cart line counts discrete sellable units — cups, plates, glasses. It is
// therefore an integer, and it is held as `bigint` to match `Money`'s
// representation and to make an accidental `number` arithmetic path impossible.
//
// This is deliberately NOT the contract's `Quantity` type: that one is a
// decimal string because stock balances are ratios (2.500 kg of flour). A cart
// line is a count of things, not a measured amount. Using the decimal form here
// would invite a half-cup into a cart.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A positive whole number of sellable units.
 *
 * A plain `bigint` alias rather than a branded type. A brand would stop a
 * caller passing an arbitrary `bigint`, but `addItem` already accepts
 * `bigint` and validates it, so the brand would only stop a *caller* from
 * reading a quantity out — which is not a mistake worth a compile error.
 * The invariant is enforced at the boundary, in `toQuantity`.
 */
export type Quantity = bigint;

/** Narrow a `bigint` to a `Quantity`, rejecting zero and negatives. */
function toQuantity(value: bigint): Quantity {
  if (value <= 0n) {
    throw new CartError(`quantity must be a positive whole number, received ${value}`);
  }
  return value as Quantity;
}

/** Render a quantity for display. */
function formatQuantity(quantity: Quantity): string {
  return quantity.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// CartItem
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line in the basket: a variant, how many, and the price that was captured
 * when it was added.
 */
export interface CartItem {
  /**
   * Stable identity for this line. Client-generated UUIDv7, so a line can be
   * identified before it has ever been synced. Distinct from `variant.id`:
   * the same variant appears at most once per cart (adding it again increments
   * `quantity`), so the line still needs its own id.
   */
  readonly id: UuidV7;
  /** The sellable SKU this line refers to. */
  readonly variant: ProductVariant;
  /** How many units. A positive whole number. */
  readonly quantity: Quantity;
  /**
   * **MONEY — Satang (int64), captured at add time.** Unit price for one unit,
   * before tax and before any discount. ฿45.50 is `4550`.
   *
   * Wrapped in `Money`, never a bare number, so it cannot be used in float
   * arithmetic by accident.
   */
  readonly unitPrice: Money;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cart
// ─────────────────────────────────────────────────────────────────────────────

/** The basket. Immutable: every operation returns a new `Cart`. */
export interface Cart {
  /** The lines, in the order they were added. */
  readonly items: readonly CartItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

/** An empty cart. */
export function createCart(): Cart {
  return Object.freeze({ items: Object.freeze([]) as readonly CartItem[] });
}

function freezeCart(items: readonly CartItem[]): Cart {
  return Object.freeze({ items: Object.freeze([...items]) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/** Whether the cart has no lines. */
export function isEmpty(cart: Cart): boolean {
  return cart.items.length === 0;
}

/** How many distinct lines the cart has. */
export function lineCount(cart: Cart): number {
  return cart.items.length;
}

/**
 * **MONEY — Satang (int64).** Total number of units across all lines, ignoring
 * price. Used by the "3 items" badge in the UI.
 */
export function totalUnits(cart: Cart): bigint {
  return cart.items.reduce((sum, item) => sum + item.quantity, 0n);
}

/** Find a line by its `id`, or `undefined`. */
export function findItem(cart: Cart, itemId: UuidV7): CartItem | undefined {
  return cart.items.find((item) => item.id === itemId);
}

/**
 * How many units of each VARIANT the cart holds.
 *
 * WHY BY VARIANT AND NOT BY LINE ID: the grid needs to badge a tile with "how many
 * of this item is already in the basket", and the grid knows a variant — it has
 * never heard of a line id. `addItem` merges on repeat (`cart.ts` guarantees one
 * line per variant), so a variant id is a TOTAL key here: there is never a second
 * line for the same variant whose quantity would be lost to a `Map.set`.
 *
 * WHY IT LIVES HERE AND NOT IN THE VIEW: this is the same question
 * `totalUnits` answers — how much of what is in the basket — asked per variant
 * instead of summed, and it is answered from the one basket rather than from
 * whatever the component happened to be counting. A view that built this map from
 * `cart.items` itself would be a second implementation of the merge rule, which
 * is the class of bug the layer guard exists to prevent.
 *
 * Frozen: `readonly` is erased at runtime, so the freeze is what actually stops
 * a caller adding a line to a map describing a cart that does not contain it.
 */
export function quantitiesByVariant(cart: Cart): ReadonlyMap<UuidV7, bigint> {
  const quantities = new Map<UuidV7, bigint>();
  for (const item of cart.items) {
    // `?? 0n` rather than a read-modify-write: a map already holding this
    // variant means `addItem` merged, so summing is correct and a missing
    // entry means first sight of it. Both fall out of `?? 0n`.
    quantities.set(item.variant.id, (quantities.get(item.variant.id) ?? 0n) + item.quantity);
  }
  return Object.freeze(quantities);
}

// ─────────────────────────────────────────────────────────────────────────────
// Line totals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **MONEY — Satang (int64).** One line's total: unit price × quantity.
 *
 * Exact by construction — `Money.multiply` is integer `bigint` arithmetic, so
 * ฿0.10 × 3 is exactly ฿0.30 and never ฿0.30000000000000004.
 */
export function calculateLineTotal(item: CartItem): Money {
  return item.unitPrice.multiply(item.quantity);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations — all pure, all returning a new Cart
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a variant to the cart, or increment it if already present.
 *
 * Merging on repeat: scanning the same cup three times should produce one line
 * at quantity 3, not three lines at quantity 1. Three separate lines would
 * make the item badge wrong and would triple the outbox payload for one sale.
 *
 * The unit price of an existing line is **kept**, not replaced. If the price
 * changed between scans, the cashier's first scan set the expectation; silently
 * repricing a line already on screen is worse than a slightly stale price, and
 * the difference is visible and correctable before payment.
 *
 * @param itemId - Client-generated UUIDv7 identifying the new line.
 * @throws CartError if quantity is not a positive whole number, or the variant
 *   is not sellable (`is_active === false`).
 */
export function addItem(
  cart: Cart,
  variant: ProductVariant,
  quantity: bigint,
  unitPrice: Money,
  itemId: UuidV7,
): Cart {
  const validQuantity = toQuantity(quantity);

  if (!variant.is_active) {
    throw new CartError(
      `cannot add inactive variant ${variant.id} (${variant.sku}) to the cart`,
    );
  }

  if (unitPrice.isNegative()) {
    throw new CartError(`unit price must not be negative, received ${unitPrice.satang}`);
  }

  const existingIndex = cart.items.findIndex((item) => item.variant.id === variant.id);

  // Merging an existing line: bump the quantity, keep the original price.
  if (existingIndex !== -1) {
    const existing = cart.items[existingIndex];
    if (existing === undefined) {
      // Unreachable: findIndex already proved the index is in range. Guarded
      // because noUncheckedIndexedAccess is on and a silent `undefined` here
      // would drop a line from the basket.
      return cart;
    }

    const merged: CartItem = Object.freeze({
      ...existing,
      quantity: toQuantity(existing.quantity + validQuantity),
    });

    const items = [...cart.items];
    items[existingIndex] = merged;
    return freezeCart(items);
  }

  const item: CartItem = Object.freeze({
    id: itemId,
    variant,
    quantity: validQuantity,
    unitPrice,
  });

  return freezeCart([...cart.items, item]);
}

/**
 * Remove a line entirely.
 *
 * Returns a new cart. If the `itemId` is not present the cart is returned
 * unchanged — removing something that is not there is a no-op, not an error.
 * (A cashier tapping "remove" on an already-empty line should see nothing
 * happen, not a crash mid-sale.)
 */
export function removeItem(cart: Cart, itemId: UuidV7): Cart {
  const remaining = cart.items.filter((item) => item.id !== itemId);
  if (remaining.length === cart.items.length) {
    return cart;
  }
  return freezeCart(remaining);
}

/**
 * Set a line's quantity to a new value.
 *
 * A quantity of zero **removes the line** rather than leaving a zero-quantity
 * row, because a zero-quantity line would contribute nothing to the subtotal
 * while still showing in the UI and in the item count. Deleting is what the
 * cashier meant.
 *
 * @throws CartError if the line is absent, or `newQuantity` is negative.
 */
export function updateQuantity(cart: Cart, itemId: UuidV7, newQuantity: bigint): Cart {
  if (newQuantity < 0n) {
    throw new CartError(`quantity must not be negative, received ${newQuantity}`);
  }

  const index = cart.items.findIndex((item) => item.id === itemId);
  if (index === -1) {
    throw new CartError(`cannot update quantity: no line with id ${itemId}`);
  }

  if (newQuantity === 0n) {
    return removeItem(cart, itemId);
  }

  const existing = cart.items[index];
  if (existing === undefined) {
    return cart;
  }

  const items = [...cart.items];
  items[index] = Object.freeze({ ...existing, quantity: toQuantity(newQuantity) });
  return freezeCart(items);
}

/**
 * Replace the unit price of a line.
 *
 * Separate from `addItem` because repricing is a deliberate, auditable act —
 * a manager override — and it must be an explicit call, never a side effect of
 * adding an item.
 *
 * @throws CartError if the line is absent or the price is negative.
 */
export function updateUnitPrice(cart: Cart, itemId: UuidV7, unitPrice: Money): Cart {
  if (unitPrice.isNegative()) {
    throw new CartError(`unit price must not be negative, received ${unitPrice.satang}`);
  }

  const index = cart.items.findIndex((item) => item.id === itemId);
  if (index === -1) {
    throw new CartError(`cannot update price: no line with id ${itemId}`);
  }

  const existing = cart.items[index];
  if (existing === undefined) {
    return cart;
  }

  const items = [...cart.items];
  items[index] = Object.freeze({ ...existing, unitPrice });
  return freezeCart(items);
}

/** Remove every line. */
export function clearCart(): Cart {
  return createCart();
}

// ─────────────────────────────────────────────────────────────────────────────
// Totals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **MONEY — Satang (int64).** Sum of every line total: Σ(unitPrice × quantity).
 *
 * Always a `Money`, never a `number`, and `Money.zero()` for an empty cart
 * rather than `undefined` or `null` — an empty basket totals exactly zero, and
 * that is a fact about the cart, not a missing measurement.
 *
 * Excludes tax, discounts and service charge. Those are separate policies
 * applied at checkout; folding them in here would make this function answer a
 * different question than its name. See `ARCHITECTURE-DEMO.md` §4.
 */
export function calculateSubtotal(cart: Cart): Money {
  return Money.sum(cart.items.map(calculateLineTotal));
}

/**
 * **MONEY — Satang (int64).** Per-line breakdown of the subtotal, in cart
 * order. Powers the "show me how this total was reached" view, which is what
 * a cashier shows when a customer disputes the amount.
 */
export function calculateLineTotals(cart: Cart): readonly Money[] {
  return Object.freeze(cart.items.map(calculateLineTotal));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tax — VAT-INCLUSIVE, rounded ONCE per order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **MONEY — Satang (int64).** The VAT contained in the cart's subtotal.
 *
 * The prices in this system are **VAT-INCLUSIVE**: the ฿45.50 on the menu is
 * what the customer pays, and the tax sits inside it. So the tax is extracted
 * from the subtotal rather than added to it — see `./tax.ts` for why the
 * direction of that operation matters and is not interchangeable.
 *
 * Rounded **once**, on the order subtotal. Rounding per line would round up to
 * seven times on a seven-line order, and the parts would not add back to the
 * VAT actually shown on the receipt.
 *
 * `vatRateBp` is basis points: 700 = 7%. A rate of 0 is zero-rated and returns
 * exactly zero rather than dividing by an empty denominator.
 *
 * @throws TaxError if the rate is outside `0..9999` bp.
 */
export function calculateTax(cart: Cart, vatRateBp: bigint): Money {
  return taxFromInclusive(calculateSubtotal(cart), vatRateBp);
}

/**
 * The full VAT breakdown of a cart, for the receipt and for the Tauri bridge.
 *
 * This exists so the numbers that go to storage are produced by ONE function.
 * A caller that took `calculateSubtotal` and `calculateTax` separately and then
 * derived a third figure itself is how a receipt and a tax report end up
 * disagreeing by a satang.
 *
 * | field      | meaning                                              |
 * |------------|------------------------------------------------------|
 * | `subtotal` | **MONEY** — VAT-inclusive amount the customer pays   |
 * | `net`      | **MONEY** — value before tax (the tax base)          |
 * | `tax`      | **MONEY** — VAT contained in the subtotal            |
 * | `total`    | **MONEY** — the payable amount; equals the subtotal  |
 *
 * `serviceCharge` is always `Money.zero()`: this is a café/retail till, not a
 * restaurant with a service charge. It is carried explicitly rather than
 * omitted so the storage contract stays unchanged.
 */
export function calculateOrderTotals(
  cart: Cart,
  vatRateBp: bigint,
): {
  subtotal: Money;
  net: Money;
  tax: Money;
  total: Money;
  serviceCharge: Money;
} {
  const subtotal = calculateSubtotal(cart);
  const { net, tax } = splitInclusive(subtotal, vatRateBp);

  return Object.freeze({
    subtotal,
    net,
    tax,
    // Inclusive pricing: the payable amount is the subtotal itself. The VAT is
    // already inside it. Adding `tax` on top would charge the customer twice.
    total: subtotal,
    serviceCharge: Money.zero(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
//
// Formatting is not arithmetic. These return strings for the UI and take no
// part in any total — keeping the two apart is what stops a "helpful" round()
// from quietly changing money.
// ─────────────────────────────────────────────────────────────────────────────

/** A one-line summary for a receipt or debug log. */
export function describeCart(cart: Cart): string {
  if (isEmpty(cart)) {
    return 'Cart is empty';
  }

  const lines = cart.items.map((item) => {
    const name = item.variant.name_th;
    return `${formatQuantity(item.quantity)} × ${name} @ ${item.unitPrice.toString()}`;
  });

  return `${lines.join(' + ')} = ${calculateSubtotal(cart).toString()}`;
}
