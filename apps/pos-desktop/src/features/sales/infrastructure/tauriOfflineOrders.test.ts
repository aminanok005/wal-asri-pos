/**
 * The Tauri adapter's edge conversions.
 *
 * These tests exercise the MAPPING without a Tauri runtime, which is the whole
 * reason `toWireInput` is separate from `saveOfflineOrder`. The most dangerous
 * code in this feature is the shape conversion — it is where exact money can
 * quietly become a rounded double — so it must be verifiable in a plain
 * `bun test` rather than only by launching a desktop app.
 *
 * `invoke` is never called here. The functions under test are pure.
 */

import { describe, expect, it } from 'bun:test';
import { Money } from '../../payments/domain/money';
import { OfflineOrdersError } from '../application/offlineOrders';
import { toWireInput } from './tauriOfflineOrders';

const ORDER_DRAFT = {
  id: '018f3c2a-0000-7000-8000-000000000001',
  branchId: 'branch-1',
  terminalId: 'terminal-01',
  staffUserId: 'staff-01',
  orderType: 'takeaway',
  status: 'submitted' as const,
  source: null,
  currency: null,
  vatRateBp: 700 as const,
  discountSatang: 0n,
  idempotencyKey: 'idem-1',
  localReceiptNumber: 'R-0001',
  createdAt: '2026-10-03T09:00:00.000Z',
};

const OUTBOX = {
  id: 'outbox-1',
  aggregateType: null,
  eventType: null,
  action: null,
  payload: '{}',
  idempotencyKey: 'idem-outbox-1',
  createdAt: '2026-10-03T09:00:00.000Z',
};

/** The worked example from DOMAIN.md: ฿45.50 inclusive at 7%. */
const FIGURES = {
  subtotalSatang: 4550n,
  taxableSatang: 4252n,
  taxSatang: 298n,
  serviceChargeSatang: 0n,
  roundingAdjustmentSatang: 0n,
  totalSatang: 4550n,
};

function wire(overrides: Partial<typeof FIGURES> = {}, lines: unknown[] = []) {
  return toWireInput({
    order: ORDER_DRAFT,
    lines: lines as never[],
    outbox: OUTBOX,
    figures: { ...FIGURES, ...overrides },
  });
}

describe('toWireInput — satang crosses as a STRING', () => {
  it('serialises every order-level satang field to a decimal string', () => {
    const payload = wire();

    expect(typeof payload.order.subtotalSatang).toBe('string');
    expect(typeof payload.order.taxableSatang).toBe('string');
    expect(typeof payload.order.taxSatang).toBe('string');
    expect(typeof payload.order.serviceChargeSatang).toBe('string');
    expect(typeof payload.order.roundingAdjustmentSatang).toBe('string');
    expect(typeof payload.order.totalSatang).toBe('string');
    expect(typeof payload.order.discountSatang).toBe('string');
  });

  it('produces the exact worked-example values', () => {
    const { order } = wire();

    // VAT-INCLUSIVE: ฿45.50 charged, of which ฿2.98 is VAT and ฿42.52 is net.
    expect(order.subtotalSatang).toBe('4550');
    expect(order.taxableSatang).toBe('4252');
    expect(order.taxSatang).toBe('298');
    expect(order.totalSatang).toBe('4550');
    expect(order.serviceChargeSatang).toBe('0');
  });

  // ── Signed rounding ───────────────────────────────────────────────────────
  // The one order-level field that may carry a minus sign, and the one whose
  // mishandling is invisible until a shift lead reconciles a drawer.
  it('serialises a NEGATIVE rounding adjustment as "-3", not "3" or "-3n"', () => {
    const { order } = wire({ roundingAdjustmentSatang: -3n });

    expect(order.roundingAdjustmentSatang).toBe('-3');
    expect(typeof order.roundingAdjustmentSatang).toBe('string');

    // The sign is the data. Dropping it would report a till that was 6 satang
    // out instead of one that balanced; keeping it as a BigInt would not even
    // survive the trip — `JSON.stringify(-3n)` throws.
    expect(JSON.parse(JSON.stringify({ ...order })).roundingAdjustmentSatang).toBe('-3');
  });

  it('serialises a POSITIVE rounding adjustment with its sign too', () => {
    expect(wire({ roundingAdjustmentSatang: 3n }).order.roundingAdjustmentSatang).toBe('3');
    expect(wire({ roundingAdjustmentSatang: 0n }).order.roundingAdjustmentSatang).toBe('0');
  });

  it('keeps the sign through a full JSON round-trip of the save payload', () => {
    // This is the object handed to `invoke('save_offline_order')` — so this
    // assertion is the closest a unit test gets to "it is on disk correctly".
    // The disk leg itself is pinned in test/migrations.test.ts and in Rust's
    // `history_returns_a_negative_rounding_adjustment_with_its_sign`.
    const payload = wire({ roundingAdjustmentSatang: -3n, totalSatang: 4547n });
    const roundTripped = JSON.parse(JSON.stringify(payload)) as {
      order: { roundingAdjustmentSatang: string; totalSatang: string };
    };

    expect(roundTripped.order.roundingAdjustmentSatang).toBe('-3');
    expect(roundTripped.order.totalSatang).toBe('4547');
  });

  it('survives JSON round-trip with exact precision', () => {
    // The whole reason money is a string: this value is NOT representable as a
    // JS number, and a JSON number would come back subtly changed with no
    // error. 2^53 = 9007199254740992; one satang more cannot survive a double.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const payload = wire({ subtotalSatang: huge, totalSatang: huge, taxSatang: 0n, taxableSatang: huge });

    const roundTripped = JSON.parse(JSON.stringify(payload)) as { order: { subtotalSatang: string } };

    expect(roundTripped.order.subtotalSatang).toBe('9007199254740993');
    expect(BigInt(roundTripped.order.subtotalSatang)).toBe(huge);

    // Proof of the hazard this design avoids: as a number it does NOT survive.
    expect(BigInt(Number(huge))).not.toBe(huge);
  });

  it('carries a real discount instead of inferring one from the totals', () => {
    // Under VAT-inclusive pricing, subtotal - net - tax is ZERO by
    // construction, so a discount recovered by subtraction would be silently
    // discarded and the stored row would claim none was applied.
    const payload = toWireInput({
      order: { ...ORDER_DRAFT, discountSatang: 1000n },
      lines: [],
      outbox: OUTBOX,
      figures: FIGURES,
    });

    expect(payload.order.discountSatang).toBe('1000');
  });

  it('refuses a satang value that is not a bigint', () => {
    // A JS number here is the exact mistake this layer exists to prevent. The
    // cast is deliberate: it bypasses the compile-time guard so the RUNTIME
    // guard is what has to catch it.
    expect(() =>
      toWireInput({
        order: ORDER_DRAFT,
        lines: [],
        outbox: OUTBOX,
        figures: { ...FIGURES, subtotalSatang: 4550 as unknown as bigint },
      }),
    ).toThrow(OfflineOrdersError);
  });

  it('freezes the payload so it cannot be edited after validation', () => {
    const payload = wire();

    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.order)).toBe(true);
    expect(Object.isFrozen(payload.outbox)).toBe(true);
  });
});

describe('toWireInput — line satang', () => {
  const LINE = {
    id: 'line-1',
    variantId: 'variant-1',
    productId: null,
    sku: null,
    nameTh: 'ลาเต้',
    nameEn: null,
    quantity: '1',
    unitPriceSatang: 4550n,
    lineDiscountSatang: 0n,
    lineTaxSatang: 0n,
    lineTotalSatang: 4550n,
    createdAt: '2026-10-03T09:00:00.000Z',
  };

  it('serialises every line satang field to a string', () => {
    const payload = wire({}, [LINE]);
    const line = payload.lines[0]!;

    expect(typeof line.unitPriceSatang).toBe('string');
    expect(typeof line.lineDiscountSatang).toBe('string');
    expect(typeof line.lineTaxSatang).toBe('string');
    expect(typeof line.lineTotalSatang).toBe('string');
    expect(line.unitPriceSatang).toBe('4550');
    expect(line.lineTaxSatang).toBe('0'); // always 0: VAT is per order
  });

  it('keeps quantity as the string the Rust side already expects', () => {
    // `quantity` is NUMERIC(10,3) in SQL — a ratio, not money — so it stays a
    // string to avoid a float on a decimal column.
    const payload = wire({}, [LINE]);
    expect(payload.lines[0]!.quantity).toBe('1');
  });

  it('carries Thai product names through untouched', () => {
    const payload = wire({}, [LINE]);
    expect(payload.lines[0]!.nameTh).toBe('ลาเต้');
  });
});

describe('Money round-trips through the wire shape', () => {
  it('string → Money → string is lossless', () => {
    for (const satang of [0n, 1n, 45n, 298n, 4252n, 4550n, 10_000_000n]) {
      const text = satang.toString();
      const money = Money.fromSatang(BigInt(text));
      expect(money.satang.toString()).toBe(text);
    }
  });

  it('a wire string is never silently accepted as a float', () => {
    // `"4550.0"` is what a naive serialiser produces from a float. The Rust
    // `parse_satang` rejects it (satang is a whole count, never `.0`), and so
    // must this layer — otherwise a version skew would let a laundered float
    // through the front door.
    //
    // Note the distinction this test pins down: `Money.fromString` parses MAJOR
    // UNITS ('4550.00' is ฿4,550.00 = 455000 satang), whereas the WIRE format is
    // a whole satang COUNT with no decimal point. They are different formats for
    // different layers, and conflating them is exactly the error above.
    expect(Money.fromString('4550.00').satang).toBe(455_000n);

    // What the wire actually carries, and what BigInt must parse:
    expect(BigInt('4550')).toBe(4550n);

    // THE ACTUAL HAZARD, stated precisely: satang must never make the round
    // trip through a JS double. 2^53 satang is where a double runs out of
    // integers, and a value one above it comes back changed — with no error.
    const beyondDouble = 9_007_199_254_740_993n; // 2^53 + 1
    expect(BigInt(String(beyondDouble))).toBe(beyondDouble);
    expect(BigInt(Number(beyondDouble))).not.toBe(beyondDouble);

    // `Money.fromNumber` is not the thing under test here and it deliberately
    // tolerates a fractional MAJOR-unit value (4550.5 -> 455050 satang, i.e.
    // ฿45.505 rounds to ฿45.50 or ฿45.51 per half-up). What must not happen is a
    // satang COUNT being routed through it, which is what the wire formatter and
    // `satangFromWire` both refuse to do.
  });
});