/**
 * CartView — the cashier's basket panel.
 *
 * LAYER: UI (presentation). This is the first component in the app, and it is
 * the component that proves the layer boundary works in the direction that
 * matters: **UI may import domain; domain must never import UI.**
 *
 * Every cart mutation here goes through `../domain/cart`, which is pure. This
 * file holds React state and rendering, and nothing else. If a total were
 * computed inline in a component it would eventually be computed a second way
 * in a second component, and the two would disagree — that is the exact bug
 * class `ARCHITECTURE-DEMO.md` §3 describes.
 *
 * ── WHY CONTROLLED *AND* UNCONTROLLED ───────────────────────────────────────
 *
 * Two callers, two different owners of one basket:
 *
 *   • The component tests render a bare `<CartView />` and press its buttons, so
 *     the component has to own a cart for those buttons to have anything to act
 *     on. That is what "uncontrolled" means here: it is the existing behaviour.
 *   • The sales screen owns checkout state — who is paying, which order this
 *     basket belongs to — and a panel keeping a second cart beside that is two
 *     sources of truth for one basket. That is how a screen ends up showing
 *     ฿140.50 while the order it is about to submit says ฿0.00.
 *
 * So `cart` is optional. Supply it and the component is *controlled*: the parent
 * owns the basket and this component only reports intent through
 * `onCartChange`. Omit it and the component owns its own state and is
 * self-contained, exactly as it was. Rendering, strings and domain calls are
 * identical in both modes, so there is one basket to reason about and one set
 * of rules behind it.
 *
 * @see ../domain/cart.ts — the rules this component merely displays
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import {
  addItem,
  calculateLineTotal,
  calculateSubtotal,
  createCart,
  isEmpty,
  removeItem,
  updateQuantity,
} from '../domain/cart';
import type { Cart, ProductVariant, UuidV7 } from '../domain/cart';
// Line identity comes from the domain too, and deliberately from ONE module: this
// panel and the sales screen both mint lines, and two counters mint the same id.
import { nextCartLineId } from '../domain/lineId';
import { Money } from '../../payments/domain/money';

// ─────────────────────────────────────────────────────────────────────────────
// Props
//
// Every prop is optional, and that is the whole design: a bare `<CartView />`
// has to keep working exactly as it did, because that is how the existing tests
// and the demo screen use it. A prop here is an opt-in capability, never a
// requirement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One item the cashier can add to the basket, as the parent sees it.
 *
 * Deliberately narrower than the contract's `ProductVariant`: the cart domain
 * needs a variant, but the caller of this component usually holds a resolved
 * catalog entry and should not have to reshape a contract row into a UI prop
 * before it can sell anything. `toProductVariant` below fills in the rest.
 */
export interface CartCatalogueItem {
  /** Line identity for the item once it is in a basket. Client-minted. */
  readonly id: UuidV7;
  /** Display name, Thai — what both the add button and the cart row show. */
  readonly name: string;
  /** **MONEY — Satang (int64).** Unit price for one unit, already a `Money`. */
  readonly unitPrice: Money;
  /** A retired item renders a disabled button and can never enter the cart. */
  readonly isActive: boolean;
}

/** Optional wiring for a parent that owns the basket. */
export interface CartViewProps {
  /** Supply it to control the basket. Omit it for a self-contained cart. */
  readonly cart?: Cart;
  /**
   * Called with the next cart on every mutation. Works in both modes: in
   * uncontrolled mode the component has already applied the change itself and
   * this is the notification, not the instruction.
   */
  readonly onCartChange?: (cart: Cart) => void;
  /**
   * The items to offer as add-buttons. Omit it and the built-in demo list is
   * used, so the component is still demonstrable with no parent at all.
   */
  readonly catalogue?: readonly CartCatalogueItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo catalogue
//
// Stands in for the local SQLite cache the terminal would read from. In the
// real app this arrives from `GET /catalog` via the sync engine and is handed to
// the component as the `catalogue` prop. It is inline here so the domain logic
// can be exercised by pressing the buttons, with no server and no database —
// which is the point of an offline-first design.
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_VARIANTS: readonly ProductVariant[] = [
  {
    id: '018f3c2a-0000-7000-8000-00000000000a' as UuidV7,
    product_id: '018f3c2a-0000-7000-8000-000000000001' as UuidV7,
    sku: 'BEV-LATTE',
    barcode: null,
    name_th: 'กาแฟลาเต้',
    name_en: 'Iced Latte',
    size: '12 ออนซ์',
    image_url: null,
    is_active: true,
    version: 1,
    created_at: '2026-10-02T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  },
  {
    id: '018f3c2a-0000-7000-8000-00000000000b' as UuidV7,
    product_id: '018f3c2a-0000-7000-8000-000000000002' as UuidV7,
    sku: 'BEV-MOCHA',
    barcode: null,
    name_th: 'มอคค่า',
    name_en: 'Mocha',
    size: '12 ออนซ์',
    image_url: null,
    is_active: true,
    version: 1,
    created_at: '2026-10-02T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  },
  {
    id: '018f3c2a-0000-7000-8000-00000000000c' as UuidV7,
    product_id: '018f3c2a-0000-7000-8000-000000000003' as UuidV7,
    sku: 'BEV-THAI',
    barcode: null,
    name_th: 'ชาไทย',
    name_en: 'Thai Tea',
    size: null,
    image_url: null,
    is_active: true,
    version: 1,
    created_at: '2026-10-02T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  },
];

/** Price per variant, in satang. ฿45.50 is `4550`. */
const DEMO_PRICES_SATANG: Readonly<Record<string, bigint>> = {
  'BEV-LATTE': 4550n,
  'BEV-MOCHA': 6000n,
  'BEV-THAI': 3500n,
};

/** The timestamp a minted variant reports. A demo list is not a sync engine. */
const DEMO_TIMESTAMP = '2026-10-02T00:00:00Z';

/** One demo variant, offered through the `catalogue` prop's own smaller shape. */
function demoCatalogueItem(variant: ProductVariant): CartCatalogueItem {
  return {
    id: variant.id,
    name: variant.name_th,
    unitPrice: Money.fromSatang(DEMO_PRICES_SATANG[variant.sku] ?? 0n),
    isActive: variant.is_active,
  };
}

/** The built-in catalogue, used whenever no `catalogue` prop was supplied. */
const DEMO_CATALOGUE: readonly CartCatalogueItem[] = DEMO_VARIANTS.map(demoCatalogueItem);

// ─────────────────────────────────────────────────────────────────────────────
// Line identity
//
// `nextCartLineId` lives in `../domain/lineId`, not in this file. It used to sit
// here as a private counter, and it moved because this panel is no longer the
// only caller: the sales screen adds a line for every clicked catalog tile. Two
// private counters would restart at one in two files that never meet, and two
// lines sharing an id in one cart is a cart whose quantity buttons act on the
// wrong line. The reasoning, the UUIDv7 shape and the reason the counter is at
// module scope all live with the function now.
//
// The real terminal mints these in Rust (SKILL.md §2.3); that adapter is what
// `nextCartLineId` stands in for.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint the contract `ProductVariant` that `addItem` is typed against.
 *
 * `CartCatalogueItem` is deliberately smaller than a variant, and both the demo
 * list and a parent-driven list arrive in that smaller shape, so the rest of the
 * row is filled in here once rather than at every call site.
 */
function toProductVariant(item: CartCatalogueItem): ProductVariant {
  return {
    id: item.id,
    // A cart line's category is never resolved here, so the parent id is the
    // item's own id; `sku` likewise reports that id, because a catalogue item
    // carries no human-readable SKU for the cart row to print.
    product_id: item.id,
    sku: item.id,
    name_th: item.name,
    // Copied, not forced: `addItem` rejects an inactive variant outright, and the
    // disabled button is a courtesy to a mouse, not the guard.
    is_active: item.isActive,
    version: 1,
    updated_at: DEMO_TIMESTAMP,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
//
// Display only. No arithmetic happens here — `Money` owns every calculation,
// and these helpers only turn an already-exact result into text.
// ─────────────────────────────────────────────────────────────────────────────

/** Render a `Money` as Thai baht, e.g. ฿45.50. */
function formatBaht(amount: Money): string {
  return `฿${amount.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function CartView(props?: CartViewProps): JSX.Element {
  const cart = props?.cart;
  const onCartChange = props?.onCartChange;
  const catalogue = props?.catalogue;

  // The self-contained cart, used whenever the parent does not supply one. It is
  // initialised even in controlled mode because a hook cannot be called
  // conditionally — its value is simply never read while `cart` is defined.
  const [internalCart, setInternalCart] = useState<Cart>(createCart);

  // The basket on screen. One value, whichever mode is in play — every render
  // below reads this and never `internalCart` directly, so the two modes cannot
  // drift apart in behaviour.
  const currentCart = cart ?? internalCart;

  // Latest-value ref. A handler must act on the cart that the *next* render will
  // show, and a `useCallback` closed over the props of the render that created it
  // would apply a stale price to a line on a fast double-tap. Refilling it during
  // render rather than in an effect is what makes the very first tap after a
  // parent update already see the parent's new cart.
  const cartRef = useRef<Cart>(currentCart);
  cartRef.current = currentCart;

  /**
   * Apply a domain result: internally when uncontrolled, and always to the parent
   * when one is listening.
   *
   * The asymmetry is the point. Uncontrolled, the component has to apply the
   * change itself or nothing would visibly happen. Controlled, it must NOT: the
   * parent is the only writer, and writing here as well would render a cart built
   * from the previous one until the parent answered. `onCartChange` fires in both
   * modes — in controlled mode it is the instruction that produces the next
   * `cart`, in uncontrolled mode a notification of a change already applied.
   */
  const commit = useCallback(
    (next: Cart) => {
      if (cart === undefined) {
        setInternalCart(next);
      }
      onCartChange?.(next);
    },
    [cart, onCartChange],
  );

  // Derived values. `useMemo` because the subtotal walks every line and this
  // recomputes on every quantity change; the domain function is pure, so
  // memoising it is safe and correct.
  const subtotal = useMemo(() => calculateSubtotal(currentCart), [currentCart]);
  const empty = useMemo(() => isEmpty(currentCart), [currentCart]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  // Each one calls the domain and hands the result to `commit`. None of them
  // reaches into the cart's internals, and none of them does money arithmetic.

  const handleAdd = useCallback(
    (item: CartCatalogueItem) => {
      commit(
        addItem(
          cartRef.current,
          toProductVariant(item),
          1n,
          item.unitPrice,
          nextCartLineId(),
        ),
      );
    },
    [commit],
  );

  const handleIncrement = useCallback(
    (itemId: UuidV7, quantity: bigint) => {
      commit(updateQuantity(cartRef.current, itemId, quantity + 1n));
    },
    [commit],
  );

  const handleDecrement = useCallback(
    (itemId: UuidV7, quantity: bigint) => {
      // A quantity of zero removes the line, which is the domain's rule and not
      // something this component needs to special-case.
      commit(updateQuantity(cartRef.current, itemId, quantity - 1n));
    },
    [commit],
  );

  const handleRemove = useCallback(
    (itemId: UuidV7) => {
      commit(removeItem(cartRef.current, itemId));
    },
    [commit],
  );

  const handleClear = useCallback(() => {
    commit(createCart());
  }, [commit]);

  // What is on offer: the parent's catalogue when it supplied one, the built-in
  // demo list otherwise.
  const catalogueItems = catalogue ?? DEMO_CATALOGUE;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <section className="cart-view" aria-label="ตะกร้าสินค้า">
      <header className="cart-view__header">
        <h2>ตะกร้าสินค้า</h2>
        <button type="button" onClick={handleClear} disabled={empty}>
          ล้างตะกร้า
        </button>
      </header>

      {/* ── Catalogue: the buttons that exercise the domain ─────────────
          Exposed as a labelled `group` so the region can be named on its own.
          Without it the "add this item" buttons are indistinguishable from the
          per-line controls, which all mention the same product name — both for
          a screen reader user and for a query that needs to press one and not
          the others.

          Rendered only when there is something to put in it. A resolved
          catalogue can legitimately be empty — nothing priced, nothing active,
          or nothing in the chosen price list — and the screen showing the grid
          already says so in its own words. An empty strip here would leave a
          labelled "แคตตาล็อก" region on the page containing no control at all,
          which reaches a screen reader as a control that failed to appear. */}
      {catalogueItems.length > 0 && (
        <div className="cart-view__catalogue" role="group" aria-label="แคตตาล็อก">
          {catalogueItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="cart-view__add"
              onClick={() => handleAdd(item)}
              disabled={!item.isActive}
            >
              {item.name}
              <span className="cart-view__add-price">{formatBaht(item.unitPrice)}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Item list ──────────────────────────────────────────────────── */}
      {empty ? (
        <p className="cart-view__empty">ยังไม่มีสินค้าในตะกร้า</p>
      ) : (
        <ul className="cart-view__items">
          {currentCart.items.map((item) => {
            // The line total comes from the domain, never from arithmetic here.
            const lineTotal = calculateLineTotal(item);

            return (
              <li key={item.id} className="cart-view__item">
                <div className="cart-view__item-main">
                  <span className="cart-view__item-name">{item.variant.name_th}</span>
                  <span className="cart-view__item-sku">{item.variant.sku}</span>
                </div>

                <div className="cart-view__item-quantity">
                  <button
                    type="button"
                    aria-label={`ลดจำนวน ${item.variant.name_th}`}
                    onClick={() => handleDecrement(item.id, item.quantity)}
                  >
                    −
                  </button>
                  <span className="cart-view__item-count">{item.quantity.toString()}</span>
                  <button
                    type="button"
                    aria-label={`เพิ่มจำนวน ${item.variant.name_th}`}
                    onClick={() => handleIncrement(item.id, item.quantity)}
                  >
                    +
                  </button>
                </div>

                <div className="cart-view__item-prices">
                  <span className="cart-view__item-unit">{formatBaht(item.unitPrice)}</span>
                  <span className="cart-view__item-total">{formatBaht(lineTotal)}</span>
                </div>

                <button
                  type="button"
                  className="cart-view__item-remove"
                  aria-label={`ลบ ${item.variant.name_th}`}
                  onClick={() => handleRemove(item.id)}
                >
                  ลบ
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Summary ─────────────────────────────────────────────────────── */}
      <footer className="cart-view__summary">
        <span className="cart-view__summary-label">ยอดรวม</span>
        {/* The subtotal is a Money. `toString()` is exact — no float is involved
            anywhere between the scan and this number on screen. */}
        <span className="cart-view__summary-value" data-testid="cart-subtotal">
          {formatBaht(subtotal)}
        </span>
      </footer>
    </section>
  );
}

export default CartView;
