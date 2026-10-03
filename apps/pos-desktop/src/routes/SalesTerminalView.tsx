/**
 * SalesTerminalView — the screen that proves a click lands in a real cart.
 *
 * LAYER: app shell / screen composition. This is the first file that puts the
 * two features side by side, and it is deliberately the *thinnest* file in the
 * repo: it owns a cart, resolves a menu once, and hands a tap to the cart
 * domain. It computes no total, invents no price, and reaches into no feature's
 * internals.
 *
 * THE CLAIM BEING TESTED
 *
 * `CatalogGrid` can show a price. `CartView` can hold a basket. Neither fact
 * says anything about the other. This screen is where the two meet, and
 * `SalesTerminalView.test.tsx` is the acceptance test for the join: click a
 * tile that says ฿45.50 and the basket says ฿45.50. If the tile's price and the
 * line's price are two different numbers, the terminal is a lie with a receipt.
 *
 * ── WHY THE MENU IS RESOLVED ONCE, HERE ─────────────────────────────────────
 *
 * `buildCatalog` walks the whole snapshot and reaches a verdict on every
 * variant, so it runs once per mount, memoised. It stands in for the sync engine
 * pulling a `CatalogResponse` into local SQLite. No network call is made,
 * because the terminal is offline-first: a real pull lands in local storage and
 * is read back off disk, never fetched from a component's render path.
 *
 * @see ../features/sales/domain/cart.ts — the only place cart arithmetic happens
 */

import { useCallback, useMemo, useState } from 'react';
import type { JSX } from 'react';

import { buildCatalog } from '../features/catalog/domain/catalog';
import type { CatalogEntry, CatalogIndex } from '../features/catalog/domain/catalog';
import { CatalogGrid } from '../features/catalog/ui/CatalogGrid';
import { DEMO_SNAPSHOT } from '../features/catalog/ui/demoCatalog';
import type { Money } from '../features/payments/domain/money';
import { addItem, calculateSubtotal, createCart, totalUnits } from '../features/sales/domain/cart';
import type { Cart } from '../features/sales/domain/cart';
import { nextCartLineId } from '../features/sales/domain/lineId';
import { CartView } from '../features/sales/ui/CartView';
import type { CartCatalogueItem } from '../features/sales/ui/CartView';

// ─────────────────────────────────────────────────────────────────────────────
// One menu on screen, not two
//
// `CartView` renders a strip of add-buttons of its own when it is given a
// catalogue, and falls back to a built-in demo list when it is given none. Hand
// it the same eight items the grid already shows and the screen has two menus,
// two ways to sell one cup, and a seller who has to work out which of two
// identical buttons is the real one.
//
// An empty catalogue is the honest answer, and `CartView` renders nothing at all
// for an empty one — no labelled region, no dead strip. Frozen and module-level
// so the value is stable across renders and no caller can mutate it.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_CATALOGUE: readonly CartCatalogueItem[] = Object.freeze([]);

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder order context
//
// NOT WIRED TO ANY DOMAIN — and deliberately so. The customer name, the
// dine-in/takeaway pair and the table number rendered below are layout
// placeholder only: there is no order entity yet, no fulfilment rule, and
// nothing here is read by the cart, by the subtotal or by checkout. They exist
// so the screen has the shape a cashier expects, and no behaviour is invented
// for them — no state, no handler, no rule about which mode is "selected". When
// the order domain lands these three become its fields and nothing else on this
// screen has to move.
//
// A Thai label and a button that does nothing beats a toggle that looks wired
// and lies about what it is recording.
// ─────────────────────────────────────────────────────────────────────────────

/** Render a `Money` as Thai baht, e.g. ฿45.50. Display only — no arithmetic. */
function formatBaht(amount: Money): string {
  return `฿${amount.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function SalesTerminalView(): JSX.Element {
  // The screen owns the basket, because the screen owns checkout state — which
  // order this is, who is paying, whether it has been submitted. `CartView` is
  // handed the cart rather than left to keep one of its own: a panel holding a
  // second cart beside the real one is two sources of truth for one basket, and
  // that is how a terminal ends up showing ฿140.50 while the order it is about
  // to send says ฿0.00. Controlled mode here is not a convenience, it is the
  // point.
  const [cart, setCart] = useState<Cart>(createCart);

  // The resolved menu, once. `buildCatalog` is total and pure and hands back a
  // frozen index, so memoising it is both safe and the reason a re-render caused
  // by a quantity change never re-walks the snapshot.
  const index: CatalogIndex = useMemo(() => buildCatalog(DEMO_SNAPSHOT), []);

  // ── THE WHOLE POINT OF THIS SCREEN, ON ONE LINE ────────────────────────────
  //
  // The handler mutates nothing itself: it hands the tapped entry to `addItem`
  // and lets the domain decide what a basket is. `1n` because a cart line is a
  // whole number of cups, never a fraction of one. And the price handed in is
  // `entry.unitPrice` — the exact `Money` the tile displayed. Not a re-read of
  // the catalog, not a number recomputed here; if those could disagree, a
  // cashier would quote one price and the receipt would print another.
  //
  // Minting the id inside the updater is deliberate: React may run an updater
  // twice, but a second run can only skip an id, never repeat one, and a skipped
  // id is harmless — uniqueness is the only property line ids have to keep.
  const handleSelect = useCallback((entry: CatalogEntry) => {
    setCart((current) => addItem(current, entry.variant, 1n, entry.unitPrice, nextCartLineId()));
  }, []);

  // Everything the header says about the basket is a domain answer as well:
  // `totalUnits` counts what is in it and `calculateSubtotal` sums it. Neither
  // is derived from the other, and neither is worked out in the markup below.
  const units = useMemo(() => totalUnits(cart), [cart]);
  const subtotal = useMemo(() => calculateSubtotal(cart), [cart]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="sales-terminal" aria-label="หน้าขาย" data-testid="sales-terminal">
      <header className="sales-terminal__header">
        <h1>หน้าขาย</h1>

        {/* ── Order context ── PLACEHOLDER, wired to nothing ─────────────── */}
        <div className="sales-terminal__context">
          <span className="sales-terminal__customer">ลูกค้า: ลูกค้าทั่วไป</span>
          <div className="sales-terminal__fulfilment">
            <button type="button" className="sales-terminal__fulfilment-button">
              ทานที่ร้าน
            </button>
            <button type="button" className="sales-terminal__fulfilment-button">
              ห่อกลับบ้าน
            </button>
          </div>
          <span className="sales-terminal__table">โต๊ะที่ 4</span>
        </div>

        {/* ── Basket at a glance ─────────────────────────────────────────────
            Only the subtotal carries ฿, because only the subtotal is money. A
            count of cups is not an amount, and hanging a currency sign on it
            would be a small lie about what the two numbers on this line mean. */}
        <p className="sales-terminal__totals">
          <span data-testid="sales-item-count">{`${units.toString()} รายการ`}</span>
          <span data-testid="sales-subtotal">{formatBaht(subtotal)}</span>
        </p>
      </header>

      <div className="sales-terminal__body">
        {/* The menu: one grid of tiles, every tile priced by the catalog domain.
            `handleSelect` is the whole seam between the two features. */}
        <CatalogGrid index={index} onSelect={handleSelect} />

        {/* The basket: controlled by this screen, so its own +, −, ลบ and
            ล้างตะกร้า run `updateQuantity` / `removeItem` / `createCart` on the one
            cart this screen holds. Same domain, same basket, one source of
            truth. `EMPTY_CATALOGUE` is what keeps the second menu off the
            screen. */}
        <CartView cart={cart} onCartChange={setCart} catalogue={EMPTY_CATALOGUE} />
      </div>
    </main>
  );
}

export default SalesTerminalView;
