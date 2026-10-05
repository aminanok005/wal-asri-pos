import { describe, expect, it } from 'bun:test';
import { buildOrderSyncPayload } from './orderSyncPayload';
import type { SyncOrderPayload } from './orderSyncPayload';

/** The worked example from the module header, with a DOWNWARD cash rounding. */
const ORDER: SyncOrderPayload = {
  id: '018f3c2a-0000-7000-8000-000000000001',
  branchId: 'branch-siam',
  terminalId: 'terminal-01',
  type: 'dine_in',
  status: 'submitted',
  source: 'pos_desktop',
  subtotalSatang: 4550n,
  discountSatang: 0n,
  taxableSatang: 4252n,
  taxSatang: 298n,
  serviceChargeSatang: 0n,
  roundingAdjustmentSatang: -2n,
  totalSatang: 4548n,
  vatRateBp: 700,
  createdAt: '2026-10-05T09:00:00.000Z',
  lines: [
    {
      id: 'line-1',
      orderId: '018f3c2a-0000-7000-8000-000000000001',
      productVariantId: 'variant-latte',
      quantity: '2',
      unitPriceSatang: 2275n,
      lineDiscountSatang: 0n,
      lineTotalSatang: 4550n,
      sequence: 0,
      createdAt: '2026-10-05T09:00:00.000Z',
    },
  ],
};

function parse(order: SyncOrderPayload = ORDER): Record<string, unknown> {
  return JSON.parse(buildOrderSyncPayload(order)) as Record<string, unknown>;
}

describe('buildOrderSyncPayload — satang crosses as a STRING', () => {
  it('emits every order-level satang as a quoted decimal string', () => {
    const body = parse();

    // Plan 1 requirement: "Payload ส่งออกไปในฟอร์แมต String Satang 100%".
    for (const field of [
      'subtotal_satang',
      'discount_satang',
      'taxable_satang',
      'tax_satang',
      'service_charge_satang',
      'rounding_adjustment_satang',
      'total_satang',
    ]) {
      expect(typeof body[field], `${field} must be a string`).toBe('string');
    }

    expect(body.subtotal_satang).toBe('4550');
    expect(body.taxable_satang).toBe('4252');
    expect(body.tax_satang).toBe('298');
    expect(body.total_satang).toBe('4548');
  });

  it('keeps the minus sign on the rounding adjustment, as a string', () => {
    // `money.SignedSatang` on the server; a dropped sign reports a till that was
    // short by 4 satang instead of one that balanced.
    const body = parse();
    expect(body.rounding_adjustment_satang).toBe('-2');
    expect(typeof body.rounding_adjustment_satang).toBe('string');
  });

  it('emits every line satang as a string too', () => {
    const lines = parse().lines as Record<string, unknown>[];

    for (const field of ['unit_price_satang', 'line_discount_satang', 'line_total_satang']) {
      expect(typeof lines[0]![field], `${field} must be a string`).toBe('string');
    }
    expect(lines[0]!.unit_price_satang).toBe('2275');
    expect(lines[0]!.line_total_satang).toBe('4550');
  });

  it('does not lose precision on a value a double could not hold', () => {
    // 2^53 + 1 satang. As a JSON number this comes back changed and NOTHING
    // errors; as a string it is exact. This is the reason the wire is strings.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const body = parse({ ...ORDER, subtotalSatang: huge, totalSatang: huge });

    expect(body.subtotal_satang).toBe('9007199254740993');
    expect(body.total_satang).toBe('9007199254740993');
    expect(BigInt(body.subtotal_satang as string)).toBe(huge);
  });

  it('sends vat_rate_bp as a NUMBER, because a rate is not an amount', () => {
    const body = parse();
    expect(typeof body.vat_rate_bp).toBe('number');
    expect(body.vat_rate_bp).toBe(700);
  });
});

describe('buildOrderSyncPayload — the shape the server will accept', () => {
  it('carries no field the Go ingester does not know', () => {
    // `parseOrderPayload` runs with DisallowUnknownFields, so an EXTRA key is a
    // PERMANENT rejection — the event would never sync and never be retried.
    // This list is `orderBody` in ingester.go, transcribed.
    const allowed = new Set([
      'id', 'branch_id', 'terminal_id', 'type', 'status', 'source',
      'subtotal_satang', 'discount_satang', 'taxable_satang', 'tax_satang',
      'service_charge_satang', 'rounding_adjustment_satang', 'total_satang',
      'vat_rate_bp', 'created_at', 'lines',
    ]);

    for (const key of Object.keys(parse())) {
      expect(allowed.has(key), `unknown field ${key} would be rejected`).toBe(true);
    }
  });

  it('omits line_tax_satang, which the ingester refuses to model', () => {
    // The ingester states VAT is per order and accepts no per-line value.
    const line = (parse().lines as Record<string, unknown>[])[0]!;
    expect(Object.keys(line)).not.toContain('line_tax_satang');

    const allowed = new Set([
      'id', 'order_id', 'product_variant_id', 'quantity', 'unit_price_satang',
      'line_discount_satang', 'line_total_satang', 'sequence', 'created_at',
    ]);
    for (const key of Object.keys(line)) {
      expect(allowed.has(key), `unknown line field ${key}`).toBe(true);
    }
  });

  it('orders lines by `sequence`, because the server applies them in order', () => {
    const two = parse({
      ...ORDER,
      lines: [
        { ...ORDER.lines[0]!, id: 'line-a', sequence: 0 },
        { ...ORDER.lines[0]!, id: 'line-b', sequence: 1 },
      ],
    }).lines as Record<string, unknown>[];

    expect(two.map((line) => line.id)).toEqual(['line-a', 'line-b']);
    expect(two.map((line) => line.sequence)).toEqual([0, 1]);
  });

  it('describes the SAME order the local row will record', () => {
    // The view passes one `orderId` to both. If these ever diverge, the server
    // would ingest an order the till has no record of.
    const body = parse();
    expect(body.id).toBe(ORDER.id);
    const lines = body.lines as Record<string, unknown>[];
    for (const line of lines) {
      expect(line.order_id).toBe(body.id);
    }
  });

  it('produces a JSON object, which the outbox CHECK requires', () => {
    // `CHECK (json_valid(payload) AND json_type(payload) = 'object')` rejects an
    // array or a scalar at INSERT — before the drain ever sees it.
    const parsed = JSON.parse(buildOrderSyncPayload(ORDER)) as unknown;
    expect(Array.isArray(parsed)).toBe(false);
    expect(typeof parsed).toBe('object');
  });
});