/**
 * The receipt IR and its wire mapping — Gate A, and the casing trap.
 */

import { describe, expect, it } from 'bun:test';

import { addItem, createCart } from './cart';
import { Money } from '../../payments/domain/money';
import { nextCartLineId } from './lineId';
import { buildReceiptIr } from './receiptLayout';
import type { ReceiptIr } from './receiptLayout';

function cartWith(nameTh: string, price: bigint, quantity: bigint) {
  return addItem(
    createCart(),
    {
      id: '0190f3a0-0000-7000-8000-000000000001' as never,
      product_id: 'product-latte',
      sku: 'LATTE-HOT',
      name_th: nameTh,
      name_en: null,
      price_list_id: 'pl-1',
      is_active: true,
      updated_at: '2026-10-02T09:00:00.000Z',
    } as never,
    quantity,
    Money.fromSatang(price),
    nextCartLineId(),
  );
}

const baseInput = (cart: ReturnType<typeof createCart>, total: bigint) => ({
  cart,
  shopName: 'ร้านวาลังอาซิ',
  receiptNumber: 'R-0001',
  total: Money.fromSatang(total),
  openDrawer: true,
});

describe('buildReceiptIr', () => {
  it('carries the total as a STRING, because that is the wire type', () => {
    const ir = buildReceiptIr(baseInput(createCart(), 4550n));

    expect(ir.total_satang).toBe('4550');
    expect(typeof ir.total_satang).toBe('string');
  });

  it('prints the total it is GIVEN, never one it derives itself', () => {
    // The cart below is worth ฿45.50. The total passed in is ฿45.25 — a cash
    // rounding has already moved it. The receipt MUST print ฿45.25, because
    // that is what went into SQLite and what the customer handed over.
    //
    // If this function computed its own total from the cart, the paper and the
    // database would disagree by 25 satang on every rounded cash sale.
    const ir = buildReceiptIr(baseInput(cartWith('กาแฟลาเต้', 4550n, 1n), 4525n));

    expect(ir.total_satang).toBe('4525');
    const body = ir.lines.map((l) => l.text).join('\n');
    // The LINE still shows ฿45.50 — that is the price of the drink. What must
    // change is the GRAND TOTAL, which is the last line.
    expect(body).toContain('กาแฟลาเต้ ×1    ฿45.50');
    expect(ir.lines[ir.lines.length - 1]!.text).toBe('฿45.25');
  });

  it('lists each line with its name, quantity and line total', () => {
    const ir = buildReceiptIr(baseInput(cartWith('กาแฟลาเต้', 4550n, 2n), 9100n));

    const first = ir.lines[0]!;
    expect(first.text).toContain('กาแฟลาเต้');
    expect(first.text).toContain('×2');
    expect(first.text).toContain('฿91.00');
    expect(first.align).toBe('left');
  });

  it('ends with a right-aligned grand total', () => {
    const ir = buildReceiptIr(baseInput(cartWith('กาแฟลาเต้', 4550n, 1n), 4550n));

    const last = ir.lines[ir.lines.length - 1]!;
    expect(last.align).toBe('right');
    expect(last.text).toBe('฿45.50');
  });

  it('carries the drawer flag through untouched', () => {
    expect(buildReceiptIr(baseInput(createCart(), 0n)).open_drawer).toBe(true);

    const noDrawer = buildReceiptIr({
      ...baseInput(createCart(), 0n),
      openDrawer: false,
    });
    expect(noDrawer.open_drawer).toBe(false);
  });

  it('is frozen, so nothing downstream can mutate a committed order', () => {
    const ir: ReceiptIr = buildReceiptIr(baseInput(createCart(), 4550n));

    expect(Object.isFrozen(ir)).toBe(true);
    expect(Object.isFrozen(ir.lines)).toBe(true);
    expect(Object.isFrozen(ir.lines[0]!)).toBe(true);
  });

  it('uses snake_case, because escpos::ReceiptIr has no rename_all', () => {
    // ⚠️ THE CASING TRAP. `printer_commands::PrintRequest` is camelCase, so the
    // wrapper is `printer` / `receipt` — but `escpos::ReceiptIr` carries no
    // `rename_all` and no `deny_unknown_fields`, so sending `totalSatang` would
    // leave the field MISSING rather than rejected, and Rust would then refuse
    // the whole receipt with "total_satang is not a plain integer" — a message
    // that reads like a money bug and is actually a casing bug.
    const ir = buildReceiptIr(baseInput(createCart(), 4550n));

    expect(Object.keys(ir).sort()).toEqual(
      ['lines', 'open_drawer', 'receipt_number', 'shop_name', 'total_satang'].sort(),
    );
  });

  it('survives a JSON round trip with the field names intact', () => {
    const ir = buildReceiptIr(baseInput(cartWith('กาแฟโก้', 4550n, 1n), 4550n));
    const back = JSON.parse(JSON.stringify(ir)) as ReceiptIr;

    expect(back.total_satang).toBe('4550');
    expect(back.shop_name).toBe('ร้านวาลังอาซิ');
    // Thai must not be mangled by the JSON hop, because it becomes bytes later.
    expect(back.lines[0]!.text).toContain('กาแฟโก้');
  });
});
