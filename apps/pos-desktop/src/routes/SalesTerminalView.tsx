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
// A VALUE import, not `import type`. It was type-only while this screen only
// formatted a `Money`; it now CONSTRUCTS one (`Money.fromSatang`) to carry the
// rounded payable total into the receipt IR, so the runtime import is real.
import { Money } from '../features/payments/domain/money';
import { addItem, calculateOrderTotals, createCart, totalUnits } from '../features/sales/domain/cart';
import type { Cart } from '../features/sales/domain/cart';
import { nextCartLineId } from '../features/sales/domain/lineId';
import { DEFAULT_VAT_RATE_BP } from '../features/sales/domain/tax';
import { CartView } from '../features/sales/ui/CartView';
import type { CartCatalogueItem } from '../features/sales/ui/CartView';
import { toWireInput } from '../features/sales/infrastructure/tauriOfflineOrders';
import type { CheckoutFigures } from '../features/sales/infrastructure/tauriOfflineOrders';
import { formatAdjustment, roundingRowText } from './moneyFormat';
// Cash rounding, the receipt IR, and the printer port. Each is imported from its
// own layer and none of them may be reimplemented here — see the checkout
// handler for why that matters more than usual on this screen.
import { applyCashRounding } from '../features/sales/domain/cashRounding';
import type { PaymentMethod } from '../features/sales/domain/cashRounding';
import { buildReceiptIr } from '../features/sales/domain/receiptLayout';
import { createNullReceiptPrinter } from '../features/sales/application/receiptPrinter';
import type {
  PrinterEndpoint,
  ReceiptPrinter,
} from '../features/sales/application/receiptPrinter';

/**
 * How the checkout reaches the database.
 *
 * Injected rather than imported, which is what keeps this screen testable.
 * `SalesTerminalView` renders and collects the basket; the ADAPTER that opens
 * SQLCipher is `infrastructure/tauriOfflineOrders.ts`, and a test passes a
 * double instead. A screen that called `invoke` itself would be untestable
 * without a Tauri runtime — and the offline-first guarantee this product sells
 * would then only be verified by launching a desktop app.
 *
 * Defaulted to the real adapter so the app works; overridable so the tests
 * never touch native code.
 */
export type CheckoutRepository = {
  save(input: ReturnType<typeof toWireInput>): Promise<{ readonly receiptNumber: string }>;
};

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

/**
 * The outcome of pressing ชำระเงิน, as the screen reports it.
 *
 * `ok: false` carries a message rather than throwing, because the cashier needs
 * to be told what went wrong and a rejected promise in a render handler is not a
 * way to do that. The screen is the only place that decides how an error looks.
 */
export type CheckoutResult =
  | {
      readonly ok: true;
      readonly receiptNumber: string;
      /**
       * Set when the sale COMMITTED but the receipt did not print.
       *
       * ⚠️ This exists because a single `ok` flag cannot honestly describe
       * commit-then-print. The two outcomes are independent: the money is
       * committed, the customer has been served, and the printer is dead.
       * Collapsing that into `ok: false` would tell the cashier the SALE failed
       * when it succeeded, and the obvious response — ring it again — would
       * double the sale.
       *
       * `null` means the receipt printed. Never absent: `undefined` here would
       * make "printed" and "we forgot to ask" indistinguishable at the call site.
       */
      readonly printWarning: string | null;
    }
  | { readonly ok: false; readonly message: string };

/** Render a `Money` as Thai baht, e.g. ฿45.50. Display only — no arithmetic. */
function formatBaht(amount: Money): string {
  return `฿${amount.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export interface SalesTerminalViewProps {
  /**
   * Where a confirmed checkout is committed. Defaults to the real Tauri
   * adapter; tests pass an in-memory double.
   */
  readonly repository?: CheckoutRepository;
  /**
   * Where the receipt is printed. Defaults to the null printer, which REFUSES
   * rather than pretending — a till with no printer configured must say so,
   * not show a green "printed" that never happened.
   */
  readonly printer?: ReceiptPrinter;
  /**
   * The printer's address. Separate from the printer so a test can vary the
   * endpoint without supplying a printer at all, and so the two concerns are
   * not confused: the endpoint is configuration, the port is a capability.
   */
  readonly printerEndpoint?: PrinterEndpoint;
}

/** The channels a customer can pay on screen. */
const PAYMENT_METHODS: readonly { readonly id: PaymentMethod; readonly label: string }[] =
  Object.freeze([
    Object.freeze({ id: 'cash' as const, label: 'เงินสด' }),
    Object.freeze({ id: 'qr' as const, label: 'QR' }),
    Object.freeze({ id: 'promptpay' as const, label: 'พร้อมเพย์' }),
  ]);

/**
 * Sign a satang adjustment the way a Thai customer expects to read it.
 *
 * The implementation moved to `./moneyFormat` when the offline history screen
 * needed the same rendering; importing it from THIS file would have pulled the
 * whole checkout route into that screen's module graph. Re-exported here so
 * every existing importer — and the tests that reach it through this path —
 * keeps working unchanged.
 *
 * Still directly testable, which still matters: a component test cannot reach
 * it, because every price in the demo menu is an exact multiple of 25 satang and
 * no basket the screen can build ever rounds. See `SalesTerminalPrint.test.ts`
 * for the full note.
 */
export { formatAdjustment, roundingRowText };

export function SalesTerminalView({
  repository,
  printer,
  printerEndpoint = { host: '127.0.0.1', port: 9100 },
}: SalesTerminalViewProps = {}): JSX.Element {
  // Resolved once per mount. The lazy default keeps `@tauri-apps/api` out of
  // the module graph of any test that renders this screen WITHOUT a prop — the
  // import would resolve, but calling `invoke` outside a Tauri runtime would
  // throw, so the default must never be *used* without the prop.
  const repo = useMemo<CheckoutRepository>(
    () =>
      repository ?? {
        async save(input) {
          // Imported at the point of use, so a test rendering this screen with a
          // double never loads the native bridge at all.
          const { saveOfflineOrder } = await import(
            '../features/sales/infrastructure/tauriOfflineOrders'
          );
          const out = await saveOfflineOrder(input);
          return { receiptNumber: out.localReceiptNumber };
        },
      },
    [repository],
  );
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
  // `totalUnits` counts what is in it and the totals come from one domain call.
  const units = useMemo(() => totalUnits(cart), [cart]);
  const totals = useMemo(
    () => calculateOrderTotals(cart, DEFAULT_VAT_RATE_BP),
    [cart],
  );
  const subtotal = totals.subtotal;

  // ── Checkout ──────────────────────────────────────────────────────────────
  //
  // The figures handed to the adapter are the DOMAIN's, not this screen's.
  // `calculateOrderTotals` is the one function that decides what ฿45.50 contains;
  // recomputing a total here would be a second copy of the VAT rule, and the SQL
  // `CHECK` in 0001_init.sql is a third. The screen's job is to press a button and
  // report what came back.

  const [checkout, setCheckout] = useState<CheckoutResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Payment method, and what it does to the total ──────────────────────────
  //
  // The rounding is a DOMAIN decision, computed once here and reused in three
  // places: the on-screen total, the figures committed to SQLite, and the total
  // printed on the receipt. All three MUST be the same number — a till that
  // shows ฿45.50, stores ฿45.52 and prints ฿45.50 is three sources of truth
  // for one sale, and the shift report is the one that gets blamed.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');

  const rounding = useMemo(
    () => applyCashRounding(totals.total.satang, paymentMethod),
    [totals.total, paymentMethod],
  );

  // The amount actually charged. A `Money`, so no float can creep in between
  // the rounding decision and the receipt.
  const payable = useMemo(() => Money.fromSatang(rounding.payable), [rounding.payable]);

  const canOpenDrawer = paymentMethod === 'cash';

  const handleCheckout = useCallback(async () => {
    if (submitting) return; // a double press must not write two orders

    if (cart.items.length === 0) return;

    setSubmitting(true);
    setCheckout(null);

    try {
      const figures: CheckoutFigures = {
        subtotalSatang: totals.subtotal.satang,
        taxableSatang: totals.net.satang,
        taxSatang: totals.tax.satang,
        serviceChargeSatang: totals.serviceCharge.satang,
        // ⚠️ SIGNED, and COMMITTED — not merely displayed. Round-to-nearest moves
        // both ways, so a cash total of ฿45.52 stores -2 satang here. It MUST be
        // persisted rather than only shown, because `payable` is what the
        // customer actually hands over; a stored unrounded total would make the
        // shift report disagree with the cash drawer. Migration 0002 is what
        // allows this column to be negative at all.
        roundingAdjustmentSatang: rounding.adjustment,
        totalSatang: rounding.payable,
      };

      const payload = toWireInput({
        order: {
          id: nextCartLineId(),
          branchId: 'branch-siam',
          terminalId: 'terminal-01',
          staffUserId: 'staff-01',
          orderType: 'dine_in',
          status: 'submitted',
          source: null,
          currency: null,
          // `vat_rate_bp` is the ONE satang-shaped value that is NOT a string in
          // the Rust struct: it is `Option<i64>` with a 0..10000 bound, so it fits
          // a double exactly and serialises as a JSON number. Every MONEY field
          // is a string; a rate is a percentage, not an amount.
          vatRateBp: Number(DEFAULT_VAT_RATE_BP),
          discountSatang: 0n,
          idempotencyKey: `idem-${nextCartLineId()}`,
          localReceiptNumber: `R-${units.toString()}`,
          createdAt: new Date().toISOString(),
        },
        lines: cart.items.map((item) => ({
          id: item.id,
          variantId: item.variant.id,
          productId: null,
          sku: item.variant.sku,
          nameTh: item.variant.name_th,
          // `exactOptionalPropertyTypes` is on, so an optional field may be
          // `null` but NOT `undefined`. `name_en` is optional on the contract
          // type, so `?? null` converts "absent" into the explicit null the Rust
          // `Option<String>` expects.
          nameEn: item.variant.name_en ?? null,
          quantity: item.quantity.toString(),
          unitPriceSatang: item.unitPrice.satang,
          lineDiscountSatang: 0n,
          lineTaxSatang: 0n, // VAT is per order — the schema rejects anything else
          lineTotalSatang: item.unitPrice.multiply(item.quantity).satang,
          createdAt: new Date().toISOString(),
        })),
        outbox: {
          id: nextCartLineId(),
          aggregateType: null,
          eventType: null,
          action: null,
          payload: JSON.stringify({ order_id: 'pending' }),
          idempotencyKey: `idem-outbox-${nextCartLineId()}`,
          createdAt: new Date().toISOString(),
        },
        figures,
      });

      const saved = await repo.save(payload);

      // The basket clears ONLY after the native transaction committed. Clearing
      // it before would mean a cashier who taps twice has no basket and no
      // order — the sale is simply gone, and the till has no record of it.
      setCart(createCart());

      // ── COMMIT-THEN-PRINT, and the order of those two words matters ─────────
      //
      // `save` resolved, so the money is committed and the sale happened. Only
      // NOW is a printer touched. Printing first would mean a receipt for a sale
      // that then failed to commit — a customer holding proof of a transaction
      // the till has no record of, which is unrecoverable without a void flow
      // that does not exist yet.
      //
      // The IR is built from `payable`, the SAME `Money` that went into
      // `figures` above. Passing anything else would put one number on paper and
      // another in the database, and neither would notice.
      const print = printer ?? createNullReceiptPrinter();
      const ir = buildReceiptIr({
        cart,
        shopName: 'ร้านวาลังอาซิ',
        receiptNumber: saved.receiptNumber,
        total: payable,
        openDrawer: canOpenDrawer,
      });

      try {
        await print.print(ir, printerEndpoint);
        setCheckout({ ok: true, receiptNumber: saved.receiptNumber, printWarning: null });
      } catch (printError) {
        // A print failure is ADVISORY, not a rollback. The sale is committed and
        // the money was taken; re-ringing it would double the sale. The result
        // is therefore still `ok: true` — with a warning the cashier can act on
        // — because `ok: false` would say the SALE failed, which it did not.
        setCheckout({
          ok: true,
          receiptNumber: saved.receiptNumber,
          printWarning: `บันทึกออเดอร์แล้ว แต่พิมพ์ใบเสร็จไม่สำเร็จ: ${
            printError instanceof Error ? printError.message : String(printError)
          }`,
        });
      }
    } catch (error) {
      // The cart is left intact on purpose: nothing was committed, so the
      // cashier still has the sale in front of them to retry.
      setCheckout({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  }, [cart, repo, submitting, totals, units, rounding, payable, canOpenDrawer, printer, printerEndpoint]);

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

      {/* ── Checkout ─────────────────────────────────────────────────────────
          The VAT breakdown is on screen because a customer who is asked for
          ฿45.50 and told ฿45.50 is entitled to see that ฿2.98 of it is VAT. It
          comes from the same `calculateOrderTotals` call that produced the total,
          so the two can never disagree — printing a net that does not add back up
          to the gross is the fastest way to lose a customer's trust. */}
      <section className="sales-terminal__checkout" aria-label="สรุปการชำระเงิน">
        <dl className="sales-terminal__tax-breakdown">
          <div>
            <dt>ราคารวมภาษี</dt>
            <dd data-testid="checkout-subtotal">{formatBaht(totals.subtotal)}</dd>
          </div>
          <div>
            <dt>ภาษีมูลค่าเพิ่ม 7%</dt>
            <dd data-testid="checkout-tax">{formatBaht(totals.tax)}</dd>
          </div>
          <div>
            <dt>ราคาก่อนภาษี</dt>
            <dd data-testid="checkout-net">{formatBaht(totals.net)}</dd>
          </div>
        </dl>

        {/* ── Payment method, and the rounding it causes ──────────────────────
            Shown BEFORE the customer confirms, never after. A customer who is
            charged ฿45.50 instead of ฿45.52 has to see WHY while they can still
            ask about it; revealing it on the receipt is how a till earns a
            complaint at the counter.

            The adjustment line renders only when it is non-zero. A cash sale of
            exactly ฿45.50 needs no explanation, and a "ปัดเศษ ฿0.00" row on every
            receipt trains staff to stop reading the one that matters. */}
        <fieldset className="sales-terminal__payment" aria-label="ช่องทางชำระเงิน">
          <legend>ช่องทางชำระเงิน</legend>
          {PAYMENT_METHODS.map((method) => (
            <label key={method.id} className="sales-terminal__payment-option">
              <input
                type="radio"
                name="payment-method"
                value={method.id}
                checked={paymentMethod === method.id}
                disabled={submitting}
                onChange={() => setPaymentMethod(method.id)}
                data-testid={`payment-${method.id}`}
              />
              {method.label}
            </label>
          ))}
        </fieldset>

        {rounding.adjustment !== 0n && (
          <p className="sales-terminal__rounding" data-testid="checkout-rounding">
            {`${roundingRowText(rounding.adjustment, payable.toString())}`}
          </p>
        )}

        <button
          type="button"
          className="sales-terminal__pay"
          onClick={handleCheckout}
          // Disabled while empty or in flight. An empty basket is not a sale, and
          // a second press mid-transaction would attempt a second order.
          disabled={cart.items.length === 0 || submitting}
        >
          {/* The PAYABLE total, not the subtotal: if cash rounding moved it, the
              button must quote the amount that will actually be charged. */}
          {submitting ? 'กำลังบันทึก…' : `ชำระเงิน ${formatBaht(payable)}`}
        </button>

        {checkout?.ok === true && (
          <>
            <p className="sales-terminal__receipt" data-testid="checkout-receipt">
              {`บันทึกใบเสร็จ ${checkout.receiptNumber} แล้ว`}
            </p>
            {/* Rendered ALONGSIDE the success line, never instead of it: the sale
                did happen, and only the paper failed. */}
            {checkout.printWarning !== null && (
              <p
                className="sales-terminal__error"
                data-testid="checkout-print-warning"
                role="alert"
              >
                {checkout.printWarning}
              </p>
            )}
          </>
        )}
        {checkout?.ok === false && (
          <p className="sales-terminal__error" data-testid="checkout-error" role="alert">
            {`บันทึกไม่สำเร็จ: ${checkout.message}`}
          </p>
        )}
      </section>

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
