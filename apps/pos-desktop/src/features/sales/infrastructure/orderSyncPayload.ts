/**
 * The `order_committed` payload that travels to the server inside
 * `sync_outbox.payload` and is POSTed as the command body.
 *
 * SHAPE: `services/api-backend/internal/sync/adapter/order/ingester.go` parses
 * this into `orderBody`/`lineBody` with `DisallowUnknownFields`. An extra key is
 * a PERMANENT rejection, so the field list here is closed and must match.
 *
 * SATANG IS A STRING: every `*_satang` is `money.Satang`, whose UnmarshalJSON
 * refuses a bare JSON number. Money takes `bigint` in, this emits a decimal
 * string, which is the only form the server will accept.
 *
 * `line_tax_satang` is deliberately absent — the ingester states VAT is per
 * order and accepts no per-line value.
 */

export interface SyncOrderPayload {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly type: string;
  readonly status: string;
  readonly source: string;
  /** All satang as bigint in, decimal string out. Never a `number`. */
  readonly subtotalSatang: bigint;
  readonly discountSatang: bigint;
  readonly taxableSatang: bigint;
  readonly taxSatang: bigint;
  readonly serviceChargeSatang: bigint;
  /** The one SIGNED field: the server's `money.SignedSatang`. */
  readonly roundingAdjustmentSatang: bigint;
  readonly totalSatang: bigint;
  /** A rate, not an amount — a JSON number on both sides of this wire. */
  readonly vatRateBp: number;
  readonly createdAt: string;
  readonly lines: readonly SyncOrderLinePayload[];
}

export interface SyncOrderLinePayload {
  readonly id: string;
  readonly orderId: string;
  readonly productVariantId: string;
  readonly quantity: string;
  readonly unitPriceSatang: bigint;
  readonly lineDiscountSatang: bigint;
  readonly lineTotalSatang: bigint;
  /** Zero-based position, because the server applies lines in array order. */
  readonly sequence: number;
  readonly createdAt: string;
}

/**
 * Serialise one order into the server's `Order` shape.
 *
 * Key order matches the ingester's struct so a diff of this file against it is
 * readable. `.toString()` on every satang is the load-bearing part: `bigint` has
 * no JSON representation, and a `Number` here would lose satang above 2^53
 * silently — which is the failure `money.Satang` exists to make impossible.
 */
export function buildOrderSyncPayload(order: SyncOrderPayload): string {
  return JSON.stringify({
    id: order.id,
    branch_id: order.branchId,
    terminal_id: order.terminalId,
    type: order.type,
    status: order.status,
    source: order.source,
    subtotal_satang: order.subtotalSatang.toString(),
    discount_satang: order.discountSatang.toString(),
    taxable_satang: order.taxableSatang.toString(),
    tax_satang: order.taxSatang.toString(),
    service_charge_satang: order.serviceChargeSatang.toString(),
    rounding_adjustment_satang: order.roundingAdjustmentSatang.toString(),
    total_satang: order.totalSatang.toString(),
    vat_rate_bp: order.vatRateBp,
    created_at: order.createdAt,
    lines: order.lines.map((line) => ({
      id: line.id,
      order_id: line.orderId,
      product_variant_id: line.productVariantId,
      quantity: line.quantity,
      unit_price_satang: line.unitPriceSatang.toString(),
      line_discount_satang: line.lineDiscountSatang.toString(),
      line_total_satang: line.lineTotalSatang.toString(),
      sequence: line.sequence,
      created_at: line.createdAt,
    })),
  });
}