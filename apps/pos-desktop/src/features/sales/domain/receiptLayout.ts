/**
 * Receipt IR — the neutral layout a receipt becomes before it reaches Rust.
 *
 * LAYER: domain. Pure TypeScript. No React, no Tauri, no SQL, no `Intl`, and no
 * float. This is Gate A in `docs/02-design/DOMAIN.md`: "turns a cart + TaxSplit
 * into a neutral IR (JSON)".
 *
 * ── WHY THE IR IS NEUTRAL ────────────────────────────────────────────────────
 *
 * The IR names no font, no column count and no escape sequence. It says "this
 * line, left-aligned, in Thai", and `escpos.rs` decides what a Thai glyph costs
 * in printer cells. That separation is the whole point: the receipt layout is
 * testable in `bun test` with no native runtime, and the byte compiler is
 * testable in `cargo test` with no hardware. Neither needs the other to exist.
 *
 * ── ⚠️ THE WIRE IS snake_case INSIDE A camelCase WRAPPER ─────────────────────
 *
 * `printer_commands.rs` declares:
 *
 *     #[serde(rename_all = "camelCase", deny_unknown_fields")]
 *     pub struct PrintRequest { printer, receipt }
 *
 * so the OUTER object is camelCase — but `escpos::ReceiptIr` and
 * `escpos::ReceiptLine` carry NO `rename_all`, so their fields stay snake_case:
 *
 *     { "printer": { "host", "port" },
 *       "receipt": { "shop_name", "receipt_number", "total_satang", ... } }
 *
 * `totalSatang` here would fail to deserialise, and `ReceiptIr` has no
 * `deny_unknown_fields`, so the field would simply be MISSING — and
 * `format_satang` in Rust would then reject the whole receipt with a confusing
 * "total_satang is not a plain integer". This asymmetry is pinned by
 * `receiptLayout.test.ts`.
 *
 * ── MONEY ────────────────────────────────────────────────────────────────────
 *
 * Every satang value here is a `bigint` until the infrastructure adapter
 * stringifies it, and a STRING on the wire (`total_satang`). No float touches
 * this file: ฿45.50 is the integer 4550, and `45.50` in binary floating point
 * is not that number.
 *
 * @see ./cashRounding.ts — decides the payable total that goes in here
 * @see ../../../../src-tauri/src/escpos.rs — the Rust side of this contract
 */

import type { Cart } from './cart';
import { calculateLineTotal } from './cart';
import { Money } from '../../payments/domain/money';

// ─────────────────────────────────────────────────────────────────────────────
// The IR — mirrored field for field from `escpos::ReceiptIr`
// ─────────────────────────────────────────────────────────────────────────────

/** `escpos::Align` — serde `rename_all = "lowercase"`. */
export type ReceiptAlign = 'left' | 'center' | 'right';

/** `escpos::ReceiptLine`. Pre-formatted text; the compiler adds no formatting. */
export interface ReceiptLineIr {
  /** May contain Thai. Encoding is the compiler's job, not this layer's. */
  readonly text: string;
  readonly align: ReceiptAlign;
}

/** `escpos::ReceiptIr`. */
export interface ReceiptIr {
  readonly shop_name: string;
  readonly receipt_number: string;
  readonly lines: readonly ReceiptLineIr[];
  /** MONEY — satang as a decimal string (see the snake_case note above). */
  readonly total_satang: string;
  /** Whether to pulse the cash drawer after the cut. */
  readonly open_drawer: boolean;
}

/** What the layout needs from the checkout, all of it already decided. */
export interface ReceiptLayoutInput {
  readonly cart: Cart;
  readonly shopName: string;
  readonly receiptNumber: string;
  /** MONEY — the amount actually being charged, AFTER any cash rounding. */
  readonly total: Money;
  /** True when the customer handed over notes and the till must open. */
  readonly openDrawer: boolean;
}

/** Render a `Money` for the receipt body. Display only — no arithmetic. */
function baht(amount: Money): string {
  return `฿${amount.toString()}`;
}

/**
 * Build the neutral receipt IR from a cart and the committed totals.
 *
 * The TOTAL IS TAKEN AS AN ARGUMENT, never recomputed from the cart, for one
 * reason: it is the amount that was actually committed to SQLite, after cash
 * rounding. If this function derived its own total, a cash sale rounded down by
 * 2 satang would print the UNROUNDED figure while the database recorded the
 * rounded one — a receipt and a shift report that disagree about what the
 * customer paid, which is the exact failure the money rules exist to prevent.
 */
export function buildReceiptIr(input: ReceiptLayoutInput): ReceiptIr {
  const { cart, shopName, receiptNumber, total, openDrawer } = input;

  const lines: ReceiptLineIr[] = [];

  for (const item of cart.items) {
    const lineTotal = calculateLineTotal(item);
    lines.push(
      Object.freeze({
        text: `${item.variant.name_th} ×${item.quantity.toString()}    ${baht(lineTotal)}`,
        align: 'left' as const,
      }),
    );
  }

  lines.push(Object.freeze({ text: 'ยอดรวม', align: 'right' as const }));
  lines.push(Object.freeze({ text: baht(total), align: 'right' as const }));

  return Object.freeze({
    shop_name: shopName,
    receipt_number: receiptNumber,
    lines: Object.freeze(lines),
    total_satang: total.satang.toString(),
    open_drawer: openDrawer,
  });
}
