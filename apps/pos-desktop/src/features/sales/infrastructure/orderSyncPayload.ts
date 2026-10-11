/**
 * The `order_committed` payload that travels to the server inside
 * `sync_outbox.payload` and is POSTed as the command body.
 *
 * SHAPE: `services/api-backend/internal/sync/adapter/order/ingester.go` parses
 * this into `orderBody`/`lineBody` with `json.Unmarshal` (NOT `DisallowUnknownFields`).
 * Extra keys are ACCEPTED SILENTLY — the field list here documents what we send,
 * but the server does not reject unknown fields. This is intentional: forward
 * compatibility means a newer client can send fields an older server ignores.
 *
 * SATANG IS A STRING — WITH ONE DELIBERATE EXCEPTION. Every `*_satang` is
 * `money.Satang`, whose UnmarshalJSON refuses a bare JSON number, so money
 * takes `bigint` in and emits a decimal string — EXCEPT
 * `rounding_adjustment_satang`. The server types that one `money.SignedSatang`:
 * a BARE JSON integer that explicitly refuses a quoted string (the mirror-image
 * rule, same file in the Go money kernel). Sending `"-2"` there is a permanent
 * rejection (`malformed_payload`) for every order that carried a cash
 * rounding — at this till that is every order, because the field is always
 * present. Do NOT "normalise" it back to `.toString()`.
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
  /**
   * The one SIGNED field — and the one money field that crosses as a BARE JSON
   * INTEGER, not a string: the server types it `money.SignedSatang`, whose
   * UnmarshalJSON refuses a quoted digit string exactly the way `money.Satang`
   * refuses a bare number. Stays `bigint` at this edge; only
   * `buildOrderSyncPayload` turns it into a JSON number.
   */
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
 * no JSON representation, and a `Number` there would lose satang above 2^53
 * silently — which is the failure `money.Satang` exists to make impossible. The
 * single exception is `rounding_adjustment_satang`, emitted as a bare integer
 * because the server types it `money.SignedSatang` (see the module header).
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
    // BARE INTEGER — the inverse of every other satang field here. `Number()` is
    // safe on this field and only this field: it is a cash-rounding adjustment,
    // bounded by the payable coin (a handful of satang), nowhere near the 2^53
    // precision cliff that keeps every AMOUNT a string. The sign survives: -2n → -2.
    rounding_adjustment_satang: Number(order.roundingAdjustmentSatang),
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