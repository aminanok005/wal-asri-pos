/**
 * Tauri adapter for the offline-orders port.
 *
 * LAYER: infrastructure. This is the EDGE — the one place in the sales feature
 * that is allowed to know `@tauri-apps/api` exists, and the one place where a
 * wire value is allowed to become a domain type.
 *
 * ── THE STRING RULE, AND WHY IT IS NOT PARANOIA ─────────────────────────────────
 *
 * Every satang amount crossing `invoke` is a **string**, in both directions.
 * That is not a stylistic preference, and it is not symmetric with how JSON
 * usually works:
 *
 *   JSON has ONE number type. serde serialises Rust's `i64` as a JSON number,
 *   and JavaScript parses every JSON number into a `number`, which is an IEEE-754
 *   double. Values above 2^53 − 1 silently round. A ฿90,000,000,000,000.00 order
 *   (฿90 trillion) is where 2^53 satang lands — not a figure this POS will ever
 *   see, but the failure is SILENT: no error, no warning, a receipt that is off
 *   by an amount nobody can read off the paper.
 *
 *   A string has no such limit. `"9007199254740993"` survives JSON exactly, and
 *   `BigInt("9007199254740993")` is that precise integer again.
 *
 * Rust already serialises satang as `String` (`OrderSummary.total_satang`) and
 * already REJECTS a malformed one on the way in (`parse_satang` enforces
 * `^(0|[1-9][0-9]*)$` — no sign, no decimal point, no exponent, no leading
 * zero). This adapter validates independently rather than trusting that, because
 * the two sides can be at different versions during a rollout and the money must
 * not depend on them agreeing.
 *
 * ── WHY `Money`, NOT `bigint` ─────────────────────────────────────────────────
 *
 * `Money` is frozen and immutable, so a summary handed to a view cannot be
 * edited and cannot be used as a scratch number. Returning a raw `bigint` would
 * hand every caller the ability to do arithmetic without the type that forbids
 * it. The conversion happens exactly here, at the edge, once.
 *
 * @see ../application/offlineOrders.ts — the port implemented below
 * @see ../../../../src-tauri/src/commands.rs — the Rust side of this contract
 */

import { invoke } from '@tauri-apps/api/core';

import {
  Money,
  MoneyError,
  satangFromWire as satangFromWireChecked,
  signedSatangFromWire as signedSatangFromWireChecked,
} from '../../payments/domain/money';
import {
  OfflineOrdersError,
  sortByNewestFirst,
} from '../application/offlineOrders';
import type {
  OfflineOrderStatus,
  OfflineOrderSummary,
  OfflineOrdersRepository,
  SyncState,
} from '../application/offlineOrders';

// ─────────────────────────────────────────────────────────────────────────────
// Wire types
//
// These mirror the Rust structs field for field. They are declared as `unknown`
// first and validated below, because a TypeScript interface is a claim about
// what Rust sends, and `invoke<T>` ASSERTS that claim rather than checking it —
// Tauri returns whatever the command returned, deserialised and unchecked. An
// interface here would be documentation; the parsers are the enforcement.
// ─────────────────────────────────────────────────────────────────────────────

/** `SaveOfflineOrderInput` in commands.rs — every satang field is a string. */
export interface SaveOfflineOrderInputWire {
  readonly order: {
    readonly id: string;
    readonly branchId: string;
    readonly terminalId: string;
    readonly staffUserId: string;
    readonly orderType: string;
    readonly status?: string | null;
    readonly source?: string | null;
    readonly currency?: string | null;
    readonly vatRateBp?: number | null;
    /** MONEY — satang as a decimal-integer STRING. */
    readonly subtotalSatang: string;
    /** MONEY — satang as a decimal-integer STRING. */
    readonly discountSatang: string;
    /** MONEY — satang as a decimal-integer STRING (the NET). */
    readonly taxableSatang: string;
    /** MONEY — satang as a decimal-integer STRING (the VAT). */
    readonly taxSatang: string;
    /** MONEY — satang as a decimal-integer STRING. Always "0" for this shop. */
    readonly serviceChargeSatang: string;
    /** MONEY — satang as a decimal-integer STRING. Always "0" today (see HANDOVER §11). */
    readonly roundingAdjustmentSatang: string;
    /** MONEY — satang as a decimal-integer STRING. */
    readonly totalSatang: string;
    readonly discountType?: string | null;
    readonly loyaltyPointsEarned?: number | null;
    readonly idempotencyKey: string;
    readonly localReceiptNumber: string;
    readonly createdAt: string;
  };
  readonly lines: readonly {
    readonly id: string;
    readonly variantId: string;
    readonly productId?: string | null;
    readonly sku?: string | null;
    readonly nameTh: string;
    readonly nameEn?: string | null;
    readonly quantity: string;
    /** MONEY — satang as a decimal-integer STRING. */
    readonly unitPriceSatang: string;
    /** MONEY — satang as a decimal-integer STRING. */
    readonly lineDiscountSatang: string;
    /** MONEY — satang as a decimal-integer STRING. Always "0": VAT is per order. */
    readonly lineTaxSatang: string;
    /** MONEY — satang as a decimal-integer STRING. */
    readonly lineTotalSatang: string;
    readonly createdAt: string;
  }[];
  readonly outbox: {
    readonly id: string;
    readonly aggregateType?: string | null;
    readonly eventType?: string | null;
    readonly action?: string | null;
    readonly payload: string;
    readonly idempotencyKey: string;
    readonly createdAt: string;
  };
}

/** `SaveOfflineOrderOutput` in commands.rs. */
export interface SaveOfflineOrderOutputWire {
  readonly orderId: string;
  readonly localReceiptNumber: string;
  readonly lineCount: number;
}

/** `OrderSummary` in commands.rs. */
export interface OrderSummaryWire {
  readonly id: string;
  readonly localReceiptNumber: string;
  readonly status: string;
  readonly syncState: string;
  readonly createdAt: string;
  readonly lineCount: number;
  /** MONEY — satang as a decimal-integer STRING. */
  readonly totalSatang: string;
  readonly currencyCode: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge validation
// ─────────────────────────────────────────────────────────────────────────────

/** The statuses `local_orders.status` permits; mirrors `offlineOrders.ts`. */
const ORDER_STATUSES = new Set<OfflineOrderStatus>([
  'draft',
  'submitted',
  'in_preparation',
  'ready',
  'served',
  'completed',
  'void_requested',
  'voided',
]);

/** The delivery states `local_orders.sync_state` permits. */
const SYNC_STATES = new Set<SyncState>(['pending', 'synced', 'conflict', 'rejected']);

/**
 * Parse a satang STRING from the wire into a `Money`.
 *
 * A thin wrapper over the shared `satangFromWire` in the money module. The
 * grammar — `^(0|[1-9][0-9]*)$` — lives there rather than here because the Rust
 * `parse_satang` enforces the same text, and a second copy in an adapter is how
 * the catalogue boundary and the sync boundary end up accepting different
 * spellings of one satang.
 */
function satangFromWireField(field: string, raw: unknown): Money {
  try {
    return satangFromWireChecked(field, raw);
  } catch (cause) {
    if (cause instanceof MoneyError) {
      throw new OfflineOrdersError(cause.message);
    }
    throw cause;
  }
}

/**
 * Same boundary role as [`satangFromWireField`], but for a SIGNED field.
 *
 * Split rather than flagged with a boolean because the two grammars are the
 * actual difference: `satangFromWire` must keep rejecting `-` so that no total
 * can arrive negative, while `roundingAdjustmentSatang` must accept it or the
 * history screen throws on the first rounded-down sale. One function with a
 * `signed?: boolean` parameter would be a boolean trap — every future call site
 * would have to remember which mode each money field is in, and getting it
 * wrong throws only at runtime, only for the rows that happen to round down.
 *
 * The `MoneyError` → `OfflineOrdersError` translation is preserved so the view
 * still reports a field name rather than a bare parse failure.
 */
function signedSatangFromWireField(field: string, raw: unknown): Money {
  try {
    return signedSatangFromWireChecked(field, raw);
  } catch (cause) {
    if (cause instanceof MoneyError) {
      throw new OfflineOrdersError(cause.message);
    }
    throw cause;
  }
}

/** Validate a non-money string field, naming the field if it is absent. */
function requiredString(field: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OfflineOrdersError(`${field} must be a non-empty string, received ${JSON.stringify(raw)}`);
  }
  return raw;
}

function requiredEnum<T extends string>(field: string, raw: unknown, allowed: ReadonlySet<T>): T {
  const value = requiredString(field, raw);
  if (!allowed.has(value as T)) {
    throw new OfflineOrdersError(
      `${field} must be one of ${[...allowed].join(', ')}, received ${JSON.stringify(value)}. ` +
        'This usually means the UI and the SQLite CHECK disagree.',
    );
  }
  return value as T;
}

function requiredCount(field: string, raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new OfflineOrdersError(`${field} must be a non-negative integer, received ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Map one wire row into the domain projection.
 *
 * The satang conversion happens HERE and nowhere else. Everything downstream
 * receives a frozen `Money`.
 */
function summaryFromWire(raw: unknown): OfflineOrderSummary {
  if (raw === null || typeof raw !== 'object') {
    throw new OfflineOrdersError(`expected an order summary object, received ${JSON.stringify(raw)}`);
  }

  const wire = raw as Record<string, unknown>;

  return Object.freeze({
    id: requiredString('id', wire.id),
    localReceiptNumber: requiredString('localReceiptNumber', wire.localReceiptNumber),
    status: requiredEnum('status', wire.status, ORDER_STATUSES),
    syncState: requiredEnum('syncState', wire.syncState, SYNC_STATES),
    createdAt: requiredString('createdAt', wire.createdAt),
    lineCount: requiredCount('lineCount', wire.lineCount),
    total: satangFromWireField('totalSatang', wire.totalSatang),
    // SIGNED — the one field on this projection whose minus sign means
    // something. Delegates to the signed grammar, because `satangFromWire`
    // rejects `-3` and would throw here, taking the whole history list with it.
    roundingAdjustmentSatang: signedSatangFromWireField(
      'roundingAdjustmentSatang',
      wire.roundingAdjustmentSatang,
    ),
    currencyCode: requiredString('currencyCode', wire.currencyCode),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A repository backed by the native SQLite database through Tauri `invoke`.
 *
 * NOTE ON TYPED `invoke`: the generic parameter on `invoke<T>` is an
 * ASSERTION, not a check — Bun will hand back whatever JSON arrived. So every
 * call below deliberately uses the UNTYPED overload and passes the result to a
 * validator. Declaring `invoke<OrderSummaryWire>` would typecheck beautifully and
 * then trust a shape nobody has checked.
 */
export function createTauriOfflineOrdersRepository(): OfflineOrdersRepository {
  return {
    async listRecent(limit: number): Promise<readonly OfflineOrderSummary[]> {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
        throw new OfflineOrdersError(
          `limit must be a positive integer, received ${String(limit)}. ` +
            'The native command rejects this too; checking here keeps the error readable.',
        );
      }

      const raw: unknown = await invoke('list_recent_orders', { limit });

      if (!Array.isArray(raw)) {
        throw new OfflineOrdersError(
          `list_recent_orders must return an array, received ${typeof raw}`,
        );
      }

      const summaries = raw.map(summaryFromWire);

      // Sorted HERE as well as in SQL. The native command already orders by
      // `created_at DESC, id DESC`, but this adapter is also the test double's
      // peer: if a future command returns rows unordered, the history screen
      // must not reshuffle between renders. `sortByNewestFirst` is the one
      // definition of "newest".
      return Object.freeze(sortByNewestFirst(summaries));
    },

    async findById(id: string): Promise<OfflineOrderSummary | undefined> {
      const wanted = requiredString('id', id);

      // There is no single-order command: the native crate exposes
      // `list_recent_orders` and `save_offline_order` only. Rather than invent
      // a new Rust command inside a wiring change — which would be a schema-
      // adjacent decision in disguise — this filters a bounded window.
      //
      // That is honest about its limits: an order older than the window is a
      // MISS, which the port already models as `undefined` rather than an error.
      // A dedicated `find_order_by_id` command is the right fix and is listed in
      // the handover as future work.
      const summaries = await this.listRecent(RECENT_WINDOW);
      return summaries.find((summary) => summary.id === wanted);
    },
  };
}

/**
 * How many rows `findById` scans before giving up.
 *
 * Sized for the history screen's own page (50) plus headroom, not for the
 * whole database. Every row is converted and validated, so a very large window
 * would be a real cost on a busy terminal.
 */
const RECENT_WINDOW = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Checkout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three numbers a receipt has to be able to explain, all satang.
 *
 * Produced by `calculateOrderTotals` in the domain, so the wire shape is built
 * from domain output rather than recomputed here — an adapter that did its own
 * VAT arithmetic would be a second copy of the rule that the SQL CHECK also
 * enforces, and the three copies would drift.
 */
export interface CheckoutFigures {
  /** MONEY — satang. VAT-INCLUSIVE amount the customer pays (฿45.50 → 4550). */
  readonly subtotalSatang: bigint;
  /** MONEY — satang. NET value, VAT excluded (4252). */
  readonly taxableSatang: bigint;
  /** MONEY — satang. The VAT contained in the subtotal (298). */
  readonly taxSatang: bigint;
  /** MONEY — satang. Always 0 — this shop has no service charge. */
  readonly serviceChargeSatang: bigint;
  /** MONEY — satang. Always 0 today; cash rounding is unratified (HANDOVER §11). */
  readonly roundingAdjustmentSatang: bigint;
  /** MONEY — satang. Equal to the subtotal, because the price is VAT-inclusive. */
  readonly totalSatang: bigint;
}

/**
 * Commit a checkout through the native three-write transaction.
 *
 * Every satang field is converted with `satangToWire` BEFORE the payload is
 * handed to `invoke`. Doing it any later — inside the Rust command, or by
 * letting `JSON.stringify` handle a `bigint` — is what turns exact money into a
 * rounded double. (`JSON.stringify` on a `bigint` actually throws, which is
 * the safe failure, but relying on that is not a design.)
 */
export async function saveOfflineOrder(
  input: SaveOfflineOrderInputWire,
): Promise<SaveOfflineOrderOutputWire> {
  const raw: unknown = await invoke('save_offline_order', { input });

  if (raw === null || typeof raw !== 'object') {
    throw new OfflineOrdersError(
      `save_offline_order must return an object, received ${JSON.stringify(raw)}`,
    );
  }

  const wire = raw as Record<string, unknown>;
  return Object.freeze({
    orderId: requiredString('orderId', wire.orderId),
    localReceiptNumber: requiredString('localReceiptNumber', wire.localReceiptNumber),
    lineCount: requiredCount('lineCount', wire.lineCount),
  });
}

/**
 * Render satang for the wire.
 *
 * `String(bigint)` is exact for every bigint, so this is a pure re-typing. It
 * exists as a named function because it is the invariant the whole file is
 * about: if someone ever replaces this with `Number(x).toString()`, the change
 * is one line and the damage is unlimited. One obvious place to be wrong is
 * better than the same expression scattered across nine fields.
 */
function satangToWire(value: bigint): string {
  if (typeof value !== 'bigint') {
    throw new OfflineOrdersError(
      `satang must be a bigint before it is sent; received ${typeof value}. ` +
        'Convert at the domain boundary, never at the wire.',
    );
  }
  return value.toString();
}

/**
 * Terminal identity from the native command.
 *
 * `get_terminal_identity` reads `WAL_ASRI_TERMINAL_ID` and `WAL_ASRI_BRANCH_ID`
 * from the process environment. Both must be set and be valid UUIDv7s, or the
 * command fails with `kind: "invalidPayload"`. There is NO fallback — an unset
 * or malformed variable is an error that surfaces to the UI.
 *
 * @throws OfflineOrdersError with the command's message when the terminal is not configured.
 */
export interface TerminalIdentityWire {
  readonly terminalId: string;
  readonly branchId: string;
}

export async function getTerminalIdentity(): Promise<TerminalIdentityWire> {
  const raw: unknown = await invoke('get_terminal_identity');

  if (raw === null || typeof raw !== 'object') {
    throw new OfflineOrdersError(
      `get_terminal_identity must return an object, received ${JSON.stringify(raw)}`,
    );
  }

  const wire = raw as Record<string, unknown>;

  if ('kind' in wire && wire.kind === 'invalidPayload') {
    const message = typeof wire.message === 'string' ? wire.message : 'terminal not configured';
    throw new OfflineOrdersError(message);
  }

  return Object.freeze({
    terminalId: requiredString('terminalId', wire.terminalId),
    branchId: requiredString('branchId', wire.branchId),
  });
}

/**
 * Build a wire payload from domain checkout figures.
 *
 * Separated from `saveOfflineOrder` so the mapping is testable WITHOUT a Tauri
 * runtime — which is the point: the most dangerous code in this feature is the
 * shape conversion, and it must be verifiable in a plain `bun test`.
 */
export function toWireInput(draft: {
  readonly order: Omit<
    SaveOfflineOrderInputWire['order'],
    | 'subtotalSatang'
    | 'discountSatang'
    | 'taxableSatang'
    | 'taxSatang'
    | 'serviceChargeSatang'
    | 'roundingAdjustmentSatang'
    | 'totalSatang'
  > & {
    /** MONEY — satang as bigint; converted to a string by `satangToWire`. */
    readonly discountSatang: bigint;
  };
  readonly lines: readonly (Omit<SaveOfflineOrderInputWire['lines'][number], 'unitPriceSatang' | 'lineDiscountSatang' | 'lineTaxSatang' | 'lineTotalSatang'> & {
    readonly unitPriceSatang: bigint;
    readonly lineDiscountSatang: bigint;
    readonly lineTaxSatang: bigint;
    readonly lineTotalSatang: bigint;
  })[];
  readonly outbox: SaveOfflineOrderInputWire['outbox'];
  readonly figures: CheckoutFigures;
}): SaveOfflineOrderInputWire {
  const { order, lines, outbox, figures } = draft;

  return Object.freeze({
    order: Object.freeze({
      ...order,
      // Discount is an INPUT, not something this layer derives. It is threaded
      // through the draft rather than inferred from the totals, because
      // `subtotal - net - tax` is ZERO by construction under VAT-inclusive
      // pricing — the VAT is already inside the subtotal — so recovering the
      // discount by subtraction would silently discard a real ฿10 discount and
      // leave the stored row claiming no discount was ever applied.
      discountSatang: satangToWire(order.discountSatang),
      subtotalSatang: satangToWire(figures.subtotalSatang),
      taxableSatang: satangToWire(figures.taxableSatang),
      taxSatang: satangToWire(figures.taxSatang),
      serviceChargeSatang: satangToWire(figures.serviceChargeSatang),
      roundingAdjustmentSatang: satangToWire(figures.roundingAdjustmentSatang),
      totalSatang: satangToWire(figures.totalSatang),
    }),
    lines: Object.freeze(
      lines.map((line) =>
        Object.freeze({
          ...line,
          unitPriceSatang: satangToWire(line.unitPriceSatang),
          lineDiscountSatang: satangToWire(line.lineDiscountSatang),
          lineTaxSatang: satangToWire(line.lineTaxSatang),
          lineTotalSatang: satangToWire(line.lineTotalSatang),
        }),
      ),
    ),
    outbox: Object.freeze({ ...outbox }),
  });
}