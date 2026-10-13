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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { components } from '@wasri/api-types';

import { buildCatalog } from '../features/catalog/domain/catalog';
import type { CatalogEntry, CatalogIndex } from '../features/catalog/domain/catalog';
import { CatalogBrowser } from '../features/catalog/ui/CatalogBrowser';
import { DEMO_SNAPSHOT } from '../features/catalog/ui/demoCatalog';
// A VALUE import, not `import type`. It was type-only while this screen only
// formatted a `Money`; it now CONSTRUCTS one (`Money.fromSatang`) to carry the
// rounded payable total into the receipt IR, so the runtime import is real.
import { Money } from '../features/payments/domain/money';
import {
  addItem,
  calculateOrderTotals,
  createCart,
  quantitiesByVariant,
  totalUnits,
} from '../features/sales/domain/cart';
import type { Cart } from '../features/sales/domain/cart';
import { nextCartLineId } from '../features/sales/domain/lineId';
import { DEFAULT_VAT_RATE_BP } from '../features/sales/domain/tax';
import { CartView } from '../features/sales/ui/CartView';
import type { CartCatalogueItem } from '../features/sales/ui/CartView';
import { ReconciliationOverlay } from '../features/sales/ui/ReconciliationOverlay';
import { useStockConflicts } from '../features/sales/ui/hooks/useStockConflicts';
import { useCanResolveStockConflict } from '../features/sales/access/stockConflictAccess';
import type { StockConflict } from '../features/sales/api/reconcile';
import { readStockRequiresReconcile } from '../features/sales/domain/stockRequiresReconcile';
import { RecentOrdersStrip } from '../features/sales/ui/RecentOrdersStrip';
import { SegmentedControl } from '../features/sales/ui/SegmentedControl';
import type { SegmentedControlOption } from '../features/sales/ui/SegmentedControl';
import { playTick } from '../features/sales/application/tickSound';
import { createInMemoryOfflineOrdersRepository } from '../features/sales/application/offlineOrders';
import type { OfflineOrdersRepository } from '../features/sales/application/offlineOrders';
import { toWireInput } from '../features/sales/infrastructure/tauriOfflineOrders';
import { buildOrderSyncPayload } from '../features/sales/infrastructure/orderSyncPayload';
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
// Order context
//
// ── WHAT IS LIVE AND WHAT IS STILL A PLACEHOLDER ──────────────────────────────
//
// The FULFILMENT PAIR IS LIVE. `orderType` is real state on this screen, it
// decides what is written to `local_orders.type` on checkout, and it travels to
// the server in the `order_committed` payload. `local_orders.type` already
// accepts `'dine_in' | 'takeaway' | 'delivery'` (migrations/0001_init.sql:161),
// so this is a modelled field with one hardcoded value sitting behind two inert
// buttons — the buttons were the only part that had never been built.
//
// A PAIR OF MUTUALLY EXCLUSIVE CHOICES IS A RADIO GROUP, NOT TWO BUTTONS.
// `aria-pressed` on two buttons would tell a screen reader "these are two
// independent toggles that could both be on", and a cashier hearing that cannot
// tell whether the customer is seated or is taking the order away. So this uses
// the `<fieldset>` + `<legend>` + real `<input type="radio">` shape the payment
// selector below already uses — one pattern for every exclusive choice on the
// screen.
//
// The CUSTOMER NAME and TABLE NUMBER remain placeholders: there is no order
// entity, no customer list and no table map yet, and nothing in the cart or the
// checkout reads either. They are Thai labels rather than invented controls —
// a label that admits what it is beats a toggle that looks wired and records
// nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fulfilment modes, as `local_orders.type` defines them.
 *
 * Derived from the contract rather than hand-listed, so a fourth mode added to
 * `OrderType` is a COMPILE error here rather than a value SQLite rejects at
 * COMMIT — which on a till is a checkout that fails with a message about a
 * column the cashier cannot name.
 *
 * Only two are offered. `delivery` is a real mode with no order domain behind
 * it: a third option that saved nothing would be exactly the dead control this
 * section was rewritten to remove.
 */
const FULFILMENT_MODES: readonly SegmentedControlOption<OrderType>[] = Object.freeze([
  Object.freeze({ value: 'dine_in', label: 'ทานที่ร้าน' }),
  Object.freeze({ value: 'takeaway', label: 'ห่อกลับบ้าน' }),
]);

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

/**
 * A held order with amount mismatch details.
 *
 * When the server detects a mismatch between the terminal's claimed amounts
 * and the server's authoritative amounts during sync, it responds with
 * `held_for_review`. The terminal must then change the order status to
 * `failed_permanent` and surface the discrepancy to the cashier.
 */
export interface HeldOrderMismatch {
  /** The order's local receipt number (e.g., "R-123"). */
  readonly localReceiptNumber: string;
  /** The order's UUIDv7 ID. */
  readonly orderId: string;
  /** The terminal's claimed subtotal in satang. */
  readonly claimedSubtotalSatang: bigint;
  /** The server's authoritative subtotal in satang. */
  readonly authoritativeSubtotalSatang: bigint;
  /** The terminal's claimed total in satang. */
  readonly claimedTotalSatang: bigint;
  /** The server's authoritative total in satang. */
  readonly authoritativeTotalSatang: bigint;
  /** When the mismatch was detected (ISO-8601 UTC). */
  readonly detectedAt: string;
}

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
  /**
   * Where the recent-orders strip reads from. Defaults to a single module-level
   * in-memory port with no rows behind it, so a bare `<SalesTerminalView />`
   * renders — and renders a strip that is simply absent, because the terminal
   * has taken nothing yet.
   *
   * `AppShell` passes the SAME repository it hands the history screen. That is
   * the point: the strip and the history screen must never disagree about what
   * this terminal has sold, and two ports is the way they would.
   */
  readonly ordersRepository?: OfflineOrdersRepository;
  /**
   * Pre-resolved terminal identity (terminalId + branchId). Used by tests to
   * avoid the Tauri call. If omitted, `getTerminalIdentity` is called.
   */
  readonly terminalIdentity?: {
    readonly terminalId: string;
    readonly branchId: string;
  };
  /**
   * Async function that returns terminal identity. In production this calls
   * the native `get_terminal_identity` command. If omitted, the component
   * uses `terminalIdentity` prop or shows an error.
   */
  readonly getTerminalIdentity?: () => Promise<{
    readonly terminalId: string;
    readonly branchId: string;
  }>;
  /**
   * Async function that returns held orders with amount mismatches.
   *
   * In production this would call a native command to fetch orders that the
   * server has flagged with `held_for_review` due to claimed vs authoritative
   * amount mismatches. The terminal must change these to `failed_permanent`
   * and surface the discrepancy to the cashier.
   *
   * If omitted, no held-orders check is performed.
   */
  readonly getHeldOrders?: () => Promise<readonly HeldOrderMismatch[]>;
}

/**
 * The strip's fallback port, built ONCE at module scope.
 *
 * A repository built inline in the render body would be a NEW object every pass,
 * and `RecentOrdersStrip` keys its read effect on the repository's identity — so
 * the strip would issue a fresh `listRecent` on every render and never settle.
 * This is the same reason `AppShell` hoists its own default the same way.
 */
const EMPTY_ORDERS_REPOSITORY: OfflineOrdersRepository = createInMemoryOfflineOrdersRepository();

/** The channels a customer can pay on screen. */
const PAYMENT_METHODS: readonly SegmentedControlOption<PaymentMethod>[] = Object.freeze([
  Object.freeze({ value: 'cash', label: 'เงินสด' }),
  Object.freeze({ value: 'qr', label: 'QR' }),
  Object.freeze({ value: 'promptpay', label: 'พร้อมเพย์' }),
]);

/**
 * `local_orders.type`, as the generated contract spells it.
 *
 * TAKEN FROM THE CONTRACT rather than re-declared as a local union of two
 * strings. A hand-written `'dine_in' | 'takeaway'` here would typecheck forever
 * and would be WRONG the day the contract adds a mode — the local union would
 * quietly keep offering two, while the wire and the database both accepted three.
 * See `OrderType` in `packages/api-types/src/index.ts`, generated from
 * `contracts/openapi.yaml`.
 */
type OrderType = components['schemas']['OrderType'];

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
  ordersRepository = EMPTY_ORDERS_REPOSITORY,
  terminalIdentity: injectedTerminalIdentity,
  getTerminalIdentity: getTerminalIdentityProp,
  getHeldOrders: getHeldOrdersProp,
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

    // CONFIRMS THE TAP, AND ONLY THE TAP. The cashier is looking at the TILE
    // when they press it, so this is not telling them something they can see —
    // it is telling them the press REGISTERED, which is the question a till asked
    // dozens of times an hour answers badly when the response is a number
    // changing in a panel they are not looking at.
    //
    // Placed on the grid tile rather than inside the cart's own add path, so the
    // same press that draws the sound is the press that changed the basket. The
    // alternative — a sound inside `CartView` — would fire for the cart's own
    // +, and then two controls would make the same noise for one line.
    playTick('add');
  }, []);

  // The basket's size, from the DOMAIN, because it numbers the receipt below:
  // `totalUnits` is the same function `CartView` calls for the count beside its
  // heading, so the receipt and the panel cannot disagree about how many things
  // were sold. The totals come from one domain call too.
  const units = useMemo(() => totalUnits(cart), [cart]);
  const totals = useMemo(
    () => calculateOrderTotals(cart, DEFAULT_VAT_RATE_BP),
    [cart],
  );

  // How many of each variant is in the basket, for the tile badges — a DOMAIN
  // answer, from the same basket the cart panel renders, so a tile badged "×2"
  // and a cart row reading 2 cannot come from two different counts. Memoised
  // because it walks every line and it would otherwise rebuild on each render,
  // handing `CatalogGrid` a fresh `Map` and defeating its own memoisation.
  const quantities = useMemo(() => quantitiesByVariant(cart), [cart]);

  // ── Terminal identity ────────────────────────────────────────────────────────
  //
  // In production: loaded once on mount from the native `get_terminal_identity`
  // command via the `getTerminalIdentity` prop. Both `terminalId` and `branchId`
  // come from environment variables and are validated as UUIDv7 by the Rust command.
  // Failure means the terminal is not configured — there is NO fallback to hardcoded values.
  //
  // In tests: injected via the `terminalIdentity` prop to avoid the Tauri call.
  const [terminalIdentity, setTerminalIdentity] = useState<{
    readonly terminalId: string;
    readonly branchId: string;
  } | null>(injectedTerminalIdentity ?? null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [identityLoading, setIdentityLoading] = useState<boolean>(!injectedTerminalIdentity && !!getTerminalIdentityProp);

  useEffect(() => {
    if (injectedTerminalIdentity) return; // Test provided identity — no native call needed.
    if (!getTerminalIdentityProp) return; // No loader provided — will show error in render.

    setIdentityLoading(true);
    getTerminalIdentityProp()
      .then((identity) => {
        setTerminalIdentity(identity);
        setIdentityLoading(false);
      })
      .catch((error) => {
        setIdentityError(error instanceof Error ? error.message : String(error));
        setIdentityLoading(false);
      });
  }, [injectedTerminalIdentity, getTerminalIdentityProp]);

  // ── Held orders (amount mismatches) ───────────────────────────────────────────
  //
  // In production: loaded periodically from the native `get_held_orders` command
  // via the `getHeldOrders` prop. When the server detects a mismatch between the
  // terminal's claimed amounts and the server's authoritative amounts during sync,
  // it responds with `held_for_review`. The terminal must change the order status
  // to `failed_permanent` and surface the discrepancy to the cashier.
  //
  // In tests: injected via the `getHeldOrders` prop to avoid the Tauri call.
  const [heldOrders, setHeldOrders] = useState<readonly HeldOrderMismatch[]>([]);
  const [heldOrdersError, setHeldOrdersError] = useState<string | null>(null);
  const [heldOrdersLoading, setHeldOrdersLoading] = useState<boolean>(!!getHeldOrdersProp);
  // Store the promise to avoid calling the function twice in Strict Mode
  const heldOrdersPromiseRef = useRef<Promise<readonly HeldOrderMismatch[]> | null>(null);

  useEffect(() => {
    if (!getHeldOrdersProp) return; // No loader provided — skip.

    // Create or reuse the promise
    if (!heldOrdersPromiseRef.current) {
      heldOrdersPromiseRef.current = getHeldOrdersProp();
    }

    heldOrdersPromiseRef.current
      .then((orders) => {
        setHeldOrders(orders);
        setHeldOrdersLoading(false);
      })
      .catch((error) => {
        setHeldOrdersError(error instanceof Error ? error.message : String(error));
        setHeldOrdersLoading(false);
      });
  }, [getHeldOrdersProp]);

  // ── Stock conflicts (polled) ───────────────────────────────────────────────
  //
  // Polls the branch's stock conflicts. Passed the branchId from the resolved
  // terminal identity, or '' before it loads — the hook no-ops on an empty
  // branch, so nothing is fetched until identity is known and nothing is
  // fetched with a guessed branch. `terminalIdentity` is read here rather than
  // passed down, so the banner and the overlay always agree on which branch's
  // conflicts they are showing.
  const {
    conflicts: stockConflicts,
    unavailable: stockConflictsUnavailable,
    refresh: refreshStockConflicts,
  } = useStockConflicts(terminalIdentity?.branchId ?? '');

  // ── Fulfilment ───────────────────────────────────────────────────────────
  //
  // REAL STATE, AND IT DECIDES WHAT IS COMMITTED. `orderType` is written to
  // `local_orders.type` on checkout and travels to the server in the
  // `order_committed` payload, so this is not a display toggle over a value that
  // was already decided elsewhere.
  //
  // `dine_in` is the default because it is `DEFAULT_ROUTE`'s world: the terminal
  // opens on a seated café's main screen, and a customer who has not said
  // otherwise is eating here. Every other default would be a guess about the
  // most common sale in the branch.
  const [orderType, setOrderType] = useState<OrderType>('dine_in');

  // ── Checkout ──────────────────────────────────────────────────────────────
  //
  // The figures handed to the adapter are the DOMAIN's, not this screen's.
  // `calculateOrderTotals` is the one function that decides what ฿45.50 contains;
  // recomputing a total here would be a second copy of the VAT rule, and the SQL
  // `CHECK` in 0001_init.sql is a third. The screen's job is to press a button and
  // report what came back.

  const [checkout, setCheckout] = useState<CheckoutResult | null>(null);

  // ── Stock reconciliation ───────────────────────────────────────────────────
  //
  // The branch's stock conflicts, polled by the hook. A cashier is TOLD they
  // exist (a banner) but cannot act on them; a manager gets the overlay. Which
  // of the two is decided by `canResolveStockConflict`, the narrow access seam
  // — there is no auth/role system in this app yet, so it defaults to deny and
  // the resolve path is gated off until a real role is wired in.
  const canResolveStockConflict = useCanResolveStockConflict();
  const [selectedConflict, setSelectedConflict] = useState<StockConflict | null>(null);
  // When a checkout is refused because a basket item's stock is locked for
  // reconciliation, this holds the locked item ids so the screen can name them
  // instead of showing a generic failure.
  const [lockedItemIds, setLockedItemIds] = useState<readonly string[] | null>(null);
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

    if (!terminalIdentity) {
      setCheckout({
        ok: false,
        message: identityError ?? 'Terminal identity not loaded yet — cannot checkout',
      });
      playTick('error');
      return;
    }

    setSubmitting(true);
    setCheckout(null);
    setLockedItemIds(null);

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

      // ONE order id and ONE instant, shared by the local row, its lines and the
      // payload the server will receive. Two calls to `nextCartLineId()` would let the
      // event the server ingests describe a different order than the one on disk.
      const orderId = nextCartLineId();
      const committedAt = new Date().toISOString();

      const payload = toWireInput({
        order: {
          id: orderId,
          branchId: terminalIdentity.branchId,
          terminalId: terminalIdentity.terminalId,
          staffUserId: 'staff-01',
          // THE CASHIER'S CHOICE, not a constant. This is the value that decides
          // whether the kitchen treats the order as seated or as packed — and it is
          // written in the same transaction as the money, so a receipt and the kitchen
          // ticket cannot come to disagree about which it was.
          orderType,
          status: 'submitted',
          source: 'pos_desktop',
          currency: null,
          // `vat_rate_bp` is the ONE satang-shaped value that is NOT a string in the
          // Rust struct: a rate, not an amount, so it is a JSON number on both wires.
          vatRateBp: Number(DEFAULT_VAT_RATE_BP),
          discountSatang: 0n,
          idempotencyKey: `idem-${orderId}`,
          localReceiptNumber: `R-${units.toString()}`,
          createdAt: committedAt,
        },
        lines: cart.items.map((item) => ({
          id: item.id,
          variantId: item.variant.id,
          productId: null,
          sku: item.variant.sku,
          nameTh: item.variant.name_th,
          // `exactOptionalPropertyTypes` is on, so an optional field may be `null`
          // but NOT `undefined`. `name_en` is optional on the contract type, so `?? null`
          // converts "absent" into the explicit null the Rust `Option<String>` expects.
          nameEn: item.variant.name_en ?? null,
          quantity: item.quantity.toString(),
          unitPriceSatang: item.unitPrice.satang,
          lineDiscountSatang: 0n,
          lineTaxSatang: 0n, // VAT is per order — the schema rejects anything else
          lineTotalSatang: item.unitPrice.multiply(item.quantity).satang,
          createdAt: committedAt,
        })),
        outbox: {
          id: nextCartLineId(),
          // Left null so the Rust adapter applies its own defaults — the schema's CHECK
          // constraints are the one definition of these vocabularies, not this file.
          aggregateType: null,
          eventType: null,
          action: null,
          // The REAL order, in the shape the Go ingester parses. The previous
          // `{"order_id":"pending"}` placeholder carried no money and no id, and
          // `DisallowUnknownFields` would have refused it — permanently.
          payload: buildOrderSyncPayload({
            id: orderId,
            branchId: terminalIdentity.branchId,
            terminalId: terminalIdentity.terminalId,
            // The SAME `orderType` as the local row above, from the same state
            // variable. Two spellings of one decision — one hardcoded for the server
            // and one chosen for the database — would put "takeaway" on the till and
            // "dine_in" in the back office, and neither side would notice.
            type: orderType,
            status: 'submitted',
            source: 'pos_desktop',
            subtotalSatang: figures.subtotalSatang,
            discountSatang: 0n,
            taxableSatang: figures.taxableSatang,
            taxSatang: figures.taxSatang,
            serviceChargeSatang: figures.serviceChargeSatang,
            roundingAdjustmentSatang: figures.roundingAdjustmentSatang,
            totalSatang: figures.totalSatang,
            vatRateBp: Number(DEFAULT_VAT_RATE_BP),
            createdAt: committedAt,
            lines: cart.items.map((item, sequence) => ({
              id: item.id,
              orderId,
              productVariantId: item.variant.id,
              quantity: item.quantity.toString(),
              unitPriceSatang: item.unitPrice.satang,
              lineDiscountSatang: 0n,
              lineTotalSatang: item.unitPrice.multiply(item.quantity).satang,
              sequence,
              createdAt: committedAt,
            })),
          }),
          idempotencyKey: `idem-outbox-${orderId}`,
          createdAt: committedAt,
        },
        figures,
      });

      const saved = await repo.save(payload);

      // The basket clears ONLY after the native transaction committed. Clearing
      // it before would mean a cashier who taps twice has no basket and no
      // order — the sale is simply gone, and the till has no record of it.
      setCart(createCart());

      // ── THE MONEY IS COMMITTED. THIS IS THE ONLY SOUND THAT MEANS "MONEY" ────
      //
      // Placed HERE, immediately after `save` resolved and NOT after the print
      // settles. The sound is the cashier's confirmation that the sale happened,
      // and the sale happened at this line — the printer that follows is paper,
      // and a printer that hangs must not leave the till sounding like nothing
      // went wrong. The `printWarning` below is a second, quieter problem and it
      // gets the screen, not an alarm.
      //
      // Before this point a cashier waiting on a slow commit gets SILENCE, and
      // that is correct too: a success tone on a press, before the money was
      // safe, would announce a sale that could still fail.
      playTick('success');

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
      //
      // A refused sale because a basket item's stock is LOCKED for
      // reconciliation is a DIFFERENT failure from a generic one: the money was
      // never at risk, and the fix is "a manager must reconcile that item", not
      // "try again". So this reads the `stock_requires_reconcile` signal off the
      // error and names the locked items; anything else is the ordinary path.
      const locked = readStockRequiresReconcile(error);
      if (locked !== null) {
        setLockedItemIds(locked.inventoryItemIds);
        setCheckout(null);
      } else {
        setLockedItemIds(null);
        setCheckout({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      // The one sound that is deliberately UNPLEASANT. Every other outcome on
      // this screen is recoverable and the cashier already knows about it from
      // the screen changing; a failed COMMIT is not, and it is the only event
      // here that means money may not have been recorded. If this branch's alert
      // ever gets ignored, that is the day a sale is rung up and believed, and
      // is not in the shift report.
      playTick('error');
    } finally {
      setSubmitting(false);
    }
  // `orderType` is in the deps because the handler READS it. A callback that
    // closed over a stale `orderType` would commit a takeaway the cashier changed
    // to dine-in two taps earlier — the exact class of bug the cart's
    // latest-value ref in `CartView` exists to prevent on the other side of this
    // screen.
    // `terminalIdentity` and `identityError` are in deps because the handler
    // reads them to build the checkout payload and to show an error if not loaded.
  }, [cart, repo, submitting, totals, units, rounding, payable, canOpenDrawer, printer, printerEndpoint, orderType, terminalIdentity, identityError]);

  // ── Render ────────────────────────────────────────────────────────────────

  // The pay button is disabled when:
  // - cart is empty
  // - submitting
  // - identity is still loading
  // - identity failed to load
  const identityReady = terminalIdentity !== null && !identityLoading && !identityError;
  const payDisabled = cart.items.length === 0 || submitting || !identityReady;

  return (
    <main className="sales-terminal" aria-label="หน้าขาย" data-testid="sales-terminal">
      <header className="sales-terminal__header">
        <h2>หน้าขาย</h2>

        {/* ── Order context ──────────────────────────────────────────────
            The customer and table are still Thai labels and nothing more —
            there is no order entity to read them from. The fulfilment radio
            group lives in the order rail below, beside the basket its choice
            shapes; these two chips stay here as the order's read-only context. */}
        <div className="sales-terminal__context">
          <span className="sales-terminal__customer">ลูกค้า: ลูกค้าทั่วไป</span>
          <span className="sales-terminal__table">โต๊ะที่ 4</span>
        </div>
      </header>

      {/* ── Terminal identity status banner ───────────────────────────────────
          Shown at the very top of the body so the cashier sees it immediately.
          Loading: subtle spinner. Error: persistent alert with details for admin. */}
      {identityLoading && (
        <div className="sales-terminal__identity-banner" role="status" aria-live="polite" data-testid="identity-loading-banner">
          <svg className="sales-terminal__spinner" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="31.4 31.4" strokeLinecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
            </circle>
          </svg>
          <span>กำลังโหลดข้อมูลเครื่อง…</span>
        </div>
      )}
      {identityError && (
        <div className="sales-terminal__identity-banner sales-terminal__identity-banner--error" role="alert" data-testid="identity-error-banner">
          <svg className="sales-terminal__alert-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
            <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div>
            <strong>ยังไม่ได้ตั้งค่าเครื่อง — เรียกผู้ดูแลระบบ</strong>
            <details className="sales-terminal__identity-details">
              <summary>รายละเอียดสำหรับผู้ดูแล</summary>
              <pre>{identityError}</pre>
              <p>ตัวแปรสภาพแวดล้อมที่ต้องตั้งค่า: <code>WAL_ASRI_TERMINAL_ID</code>, <code>WAL_ASRI_BRANCH_ID</code></p>
            </details>
          </div>
        </div>
      )}

      {/* ── Held orders banner ───────────────────────────────────────────────────
          Shown when the server has flagged orders with amount mismatches (held_for_review).
          The terminal must change these to failed_permanent and show the discrepancy. */}
      {heldOrdersLoading && (
        <div className="sales-terminal__held-banner" role="status" aria-live="polite" data-testid="held-loading-banner">
          <svg className="sales-terminal__spinner" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="31.4 31.4" strokeLinecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
            </circle>
          </svg>
          <span>กำลังตรวจสอบออเดอร์ที่ระงับ…</span>
        </div>
      )}
      {heldOrdersError && (
        <div className="sales-terminal__held-banner sales-terminal__held-banner--error" role="alert" data-testid="held-error-banner">
          <svg className="sales-terminal__alert-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
            <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div>
            <strong>ตรวจสอบออเดอร์ที่ระงับไม่สำเร็จ — เรียกผู้ดูแลระบบ</strong>
            <details className="sales-terminal__held-details">
              <summary>รายละเอียดสำหรับผู้ดูแล</summary>
              <pre>{heldOrdersError}</pre>
            </details>
          </div>
        </div>
      )}
      {heldOrders.length > 0 && (
        <div className="sales-terminal__held-banner sales-terminal__held-banner--warning" role="alert" data-testid="held-orders-banner">
          <svg className="sales-terminal__warning-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2L2 22h20L12 2z" stroke="currentColor" strokeWidth="2" fill="none" />
            <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div className="sales-terminal__held-content">
            <strong>พบออเดอร์ที่ระงับ {heldOrders.length} รายการ — ยอดไม่ตรงกับเซิร์ฟเวอร์</strong>
            <details className="sales-terminal__held-details">
              <summary>ดูรายละเอียดความขัดแย้งของยอดเงิน</summary>
              <div className="sales-terminal__held-list">
                {heldOrders.map((order) => (
                  <div key={order.orderId} className="sales-terminal__held-item">
                    <div className="sales-terminal__held-receipt">ใบเสร็จ: {order.localReceiptNumber}</div>
                    <div className="sales-terminal__held-mismatch">
                      <div className="sales-terminal__held-amount">
                        <span className="sales-terminal__held-label">ยอดที่เครื่องส่ง (Claimed):</span>
                        <span className="sales-terminal__held-value sales-terminal__held-value--claimed">
                          {formatBaht(Money.fromSatang(order.claimedTotalSatang))}
                        </span>
                      </div>
                      <div className="sales-terminal__held-amount">
                        <span className="sales-terminal__held-label">ยอดที่เซิร์ฟเวอร์ยืนยัน (Authoritative):</span>
                        <span className="sales-terminal__held-value sales-terminal__held-value--authoritative">
                          {formatBaht(Money.fromSatang(order.authoritativeTotalSatang))}
                        </span>
                      </div>
                      <div className="sales-terminal__held-diff">
                        ความต่าง: <span className="sales-terminal__held-diff-value">
                          {formatBaht(Money.fromSatang(order.authoritativeTotalSatang - order.claimedTotalSatang))}
                        </span>
                      </div>
                    </div>
                    <div className="sales-terminal__held-detected">ตรวจพบเมื่อ: {new Date(order.detectedAt).toLocaleString('th-TH', { timeZone: 'UTC' })}</div>
                  </div>
                ))}
              </div>
              <p className="sales-terminal__held-action">
                ออเดอร์เหล่านี้จะถูกเปลี่ยนสถานะเป็น <code>failed_permanent</code> และห้ามขายซ้ำ — โปรดติดต่อผู้ดูแลระบบเพื่อ Reconcile
              </p>
            </details>
          </div>
        </div>
      )}

      {/* ── Stock-conflict banner ────────────────────────────────────────────
          EVERY user sees this when the branch has conflicts awaiting
          reconciliation — a cashier is TOLD, not left to discover it at
          checkout. A manager additionally gets a button to open the resolve
          overlay; a cashier gets the plain "tell a manager" line, because the
          resolve path is gated by the access seam (default: deny). When the
          backend reconcile commands are not registered yet (Lane 1, Plan 1.3),
          this shows nothing rather than a fabricated conflict count. */}
      {!stockConflictsUnavailable && stockConflicts.length > 0 && (
        <div
          className="sales-terminal__held-banner sales-terminal__held-banner--warning"
          role="status"
          aria-live="polite"
          data-testid="stock-conflict-banner"
        >
          <svg className="sales-terminal__warning-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2L2 22h20L12 2z" stroke="currentColor" strokeWidth="2" fill="none" />
            <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div className="sales-terminal__held-content">
            <strong>
              มีสต็อกรอปรับยอด {stockConflicts.length} รายการ
            </strong>
            {canResolveStockConflict ? (
              <ul className="sales-terminal__conflict-list">
                {stockConflicts.map((conflict) => (
                  <li key={conflict.inventoryItemId}>
                    <button
                      type="button"
                      className="sales-terminal__conflict-open"
                      onClick={() => setSelectedConflict(conflict)}
                    >
                      ปรับยอด {conflict.inventoryItemId}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sales-terminal__held-action">ต้องแจ้งผู้จัดการดำเนินการปรับยอด</p>
            )}
          </div>
        </div>
      )}

      <div className="sales-terminal__body">
        {/* ── The menu column ──────────────────────────────────────────────
            TWO THINGS IN ONE COLUMN, IN THIS ORDER, AND THE ORDER IS THE POINT.

            The recent-orders strip sits ABOVE `CatalogBrowser`, so it lands
            above the search box and the menu — the space the cashier's eye goes
            to first, and the only strip on the page that answers "what did I
            just sell?" without a tap. Putting it there rather than in the right
            column is deliberate: next to the basket it would be read as part of
            the CURRENT order, and a strip about past orders sitting beside a
            panel about the current one is a strip somebody will eventually
            mistake for a receipt they still owe money on.

            It is a SIBLING of `<CatalogBrowser>` and NOT a child. That is
            load-bearing, not cosmetic: the grid's own tests scope
            `getByRole('status')` to `data-testid="catalog-grid"`, so a second
            status region nested inside would be a second match and those tests
            would fail — and the strip must also stay out of `CatalogBrowser`'s
            filter scope, so narrowing the menu never narrows what the terminal
            has already sold.

            `CatalogBrowser` renders the search box and the tabs; the strip goes
            above both because "what did I just sell" is the question asked
            mid-sale, and searching the menu is the question asked while selling
            something new. */}
        <div className="sales-terminal__menu">
          <RecentOrdersStrip repository={ordersRepository} />

          {/* The menu: tabs, search, and one grid of tiles, every tile priced by
              the catalog domain. `handleSelect` is the whole seam between the
              two features.

              `quantities` is the basket's own answer, straight from the domain —
              so a tile badged "×2" is the same two the cart panel beside it is
              holding. */}
          <CatalogBrowser index={index} onSelect={handleSelect} quantities={quantities} />
        </div>

        {/* ── The order rail ───────────────────────────────────────────────
            Everything that acts on THIS order, in one sticky column beside the
            menu: the fulfilment tabs a cashier toggles per customer, the
            at-a-glance totals, the basket itself, and — pinned to the floor by
            the checkout's `margin-top: auto` — the VAT breakdown, the payment
            chips and the pay button. One stack rather than a header strip and
            a footer, so the total, its parts and the lines they sum stay one
            glance apart while the menu scrolls. */}
        <div className="sales-terminal__rail">
          {/* A radio GROUP — two mutually exclusive choices, with `orderType`
              deciding what is written to `local_orders.type` on checkout.
              `SegmentedControl` keeps the real `<fieldset>`/`<legend>`/`<input
              type="radio">` this used to spell out inline and changes only how it
              looks: one sliding pill, no visible radio dot.

              The values, the `name`, the `checked` test and `onChange` are
              unchanged, so `setOrderType` is still `setOrderType` and the payload
              assertion in `SalesTerminalView.test.tsx` still holds. */}
          <SegmentedControl
            className="sales-terminal__fulfilment"
            name="fulfilment-mode"
            legend="การจัดส่ง"
            hideLegend
            options={FULFILMENT_MODES}
            value={orderType}
            onChange={setOrderType}
            disabled={submitting}
            testIdPrefix="fulfilment"
          />

          {/* NO "basket at a glance" STRIP ANY MORE.
              It carried "N รายการ" beside the subtotal, and both figures already
              existed below it: the count now sits beside `ตะกร้าสินค้า` as the
              heading's own secondary text, and the subtotal is one of the three
              lines of the VAT breakdown at the bottom of this same column. A
              strip between them made the cashier read the total twice, 300px
              apart, with no way to tell the copies apart. */}

          {/* The basket: controlled by this screen, so its own +, −, ลบ and
              ล้างตะกร้า run `updateQuantity` / `removeItem` / `createCart` on the one
              cart this screen holds. Same domain, same basket, one source of
              truth. `EMPTY_CATALOGUE` is what keeps the second menu off the
              screen. */}
          <CartView cart={cart} onCartChange={setCart} catalogue={EMPTY_CATALOGUE} />

          {/* ── Checkout ─────────────────────────────────────────────────────────
              The VAT breakdown is on screen because a customer who is asked for
              ฿45.50 and told ฿45.50 is entitled to see that ฿2.98 of it is VAT. It
              comes from the same `calculateOrderTotals` call that produced the total,
              so the two can never disagree — printing a net that does not add back up
              to the gross is the fastest way to lose a customer's trust. */}
          <section className="sales-terminal__checkout" aria-label="สรุปการชำระเงิน">
            {/* ASCENDING, WITH THE TOTAL LAST AND LARGEST.

                The three rows are the same three `calculateOrderTotals` figures
                in the order a person adds them up in — net, then the VAT that is
                ALREADY INSIDE the price, then the gross — so the total reads as
                the answer the two rows above it add up to. Largest last rather
                than first because the pay button below quotes this same number:
                the eye should arrive at the figure and then find the control that
                charges it.

                VAT IS STILL INCLUDED, NOT ADDED ON TOP. Every value here is
                unchanged — `totals.net`, `totals.tax`, `totals.subtotal` are the
                same three objects the breakdown has always rendered — and the
                label says so in Thai rather than leaving it to be inferred:
                "รวมในราคา" means the ฿2.98 is part of the ฿45.52 beside it, not
                ฿2.98 to be added on the top. A breakdown that could be read
                either way is how a customer hears one total and agrees to
                another. */}
            <dl className="sales-terminal__tax-breakdown">
              <div>
                <dt>ราคาก่อนภาษี</dt>
                <dd data-testid="checkout-net">{formatBaht(totals.net)}</dd>
              </div>
              <div>
                <dt>VAT 7% (รวมในราคา)</dt>
                <dd data-testid="checkout-tax">{formatBaht(totals.tax)}</dd>
              </div>
              <div className="sales-terminal__tax-breakdown-total">
                <dt>ยอดรวม</dt>
                <dd data-testid="checkout-subtotal">{formatBaht(totals.subtotal)}</dd>
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
            {/* The same control as the fulfilment pair above, with three
                options instead of two — which is why it is one component rather
                than two similar blocks. `paymentMethod` still decides the cash
                rounding, so it is passed straight through and this never reads
                or writes it. */}
            <SegmentedControl
              className="sales-terminal__payment"
              name="payment-method"
              legend="ช่องทางชำระเงิน"
              options={PAYMENT_METHODS}
              value={paymentMethod}
              onChange={setPaymentMethod}
              disabled={submitting}
              testIdPrefix="payment"
            />

            {rounding.adjustment !== 0n && (
              <p className="sales-terminal__rounding" data-testid="checkout-rounding">
                {`${roundingRowText(rounding.adjustment, payable.toString())}`}
              </p>
            )}

<button
              type="button"
              className="sales-terminal__pay-button"
              data-testid="pay-button"
              onClick={handleCheckout}
              // Disabled while empty, in flight, or terminal identity not ready.
              // An empty basket is not a sale, a second press mid-transaction would
              // attempt a second order, and no identity means we cannot attribute
              // the sale to a valid terminal/branch.
              disabled={payDisabled}
            >
              {/* The PAYABLE total, not the subtotal: if cash rounding moved it, the
                  button must quote the amount that will actually be charged. */}
              {submitting ? 'กำลังบันทึก…' : identityLoading ? 'กำลังโหลดเครื่อง…' : identityError ? 'เครื่องยังไม่ได้ตั้งค่า' : `ชำระเงิน ${formatBaht(payable)}`}
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
            {/* A checkout refused because a basket item's stock is locked for
                reconciliation. Naming the locked items turns "บันทึกไม่สำเร็จ"
                into an actionable "these items need a manager first" — the
                money was never at risk and retrying will not help. */}
            {lockedItemIds !== null && (
              <div
                className="sales-terminal__error"
                data-testid="stock-locked-alert"
                role="alert"
              >
                <strong>มีสต็อกในออเดอร์นี้ต้องปรับยอดก่อน จึงจะขายต่อได้</strong>
                {lockedItemIds.length > 0 && (
                  <div>รหัสที่ต้องปรับยอด: {lockedItemIds.join(', ')}</div>
                )}
                <div>กรุณาแจ้งผู้จัดการดำเนินการปรับยอดสต็อก</div>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ── Resolve overlay ────────────────────────────────────────────────────
          Mounted only when a conflict is selected. The overlay itself hides the
          resolve controls for a cashier (via the access seam), so even if this
          were opened it could not be used to change a balance without the
          permission. After a successful resolve the parent refetches; when no
          conflicts remain, `selectedConflict` is cleared and the overlay closes. */}
      <ReconciliationOverlay
        isOpen={selectedConflict !== null}
        conflict={selectedConflict}
        actorTerminalId={terminalIdentity?.terminalId}
        onClose={() => setSelectedConflict(null)}
        onResolved={() => {
          refreshStockConflicts();
          // Close when this was the last conflict; otherwise keep the overlay
          // so the manager can pick the next one from the banner.
          if (stockConflicts.length <= 1) setSelectedConflict(null);
        }}
      />
    </main>
  );
}

export default SalesTerminalView;
