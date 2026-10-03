/**
 * Cart line identity — one counter for every caller that mints a cart line.
 *
 * LAYER: domain. Pure TypeScript: no React, no Tauri, no clock, no `crypto`.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ────────────────────────────────────────────
 *
 * Because two callers mint cart-line ids and they must not mint them apart.
 * `CartView` mints one for each add-button it renders; the sales screen mints
 * one for each clicked catalog tile. If each kept a private counter, each would
 * hand `…000000000001` to its first line — the same id, twice, produced by two
 * files that never meet.
 *
 * That collision is not cosmetic. `CartItem.id` is the handle every cart
 * mutation goes through: `updateQuantity(cart, id, …)` and `removeItem` find
 * their line by equality. Two lines sharing an id is a cart whose quantity
 * buttons act on the wrong line — the cashier presses "+ กาแฟลาเต้" and a
 * ฿60.00 mocha quietly becomes two.
 *
 * So the counter lives here, at module scope, and both callers import it: one
 * process, one counter, one sequence.

/**
 * WHY MODULE SCOPE, NOT COMPONENT SCOPE
 *
 * A counter held in `useState` restarts at zero on every mount, so a remount
 * would begin handing out ids a controlled cart already holds. A controlled
 * cart can outlive any single mount of the panel — the parent may rebuild the
 * panel while the basket keeps its lines — so uniqueness has to last for the
 * lifetime of the process, not of a mount. Module scope is the smallest scope
 * that gives that, and each test file still gets a fresh counter for free,
 * because a test file is a fresh module registry.
 *
 * WHY THE STRING IS FIXED
 *
 * `018f3c2a-0000-7000-8000-…` — a timestamp prefix, a `7` in the version
 * nibble and an `8` in the variant nibble, which is what makes the string a v7
 * rather than a v4 written by hand. The 12-digit counter keeps string order
 * equal to numeric order, which is the ordering a v7 promises. This is the same
 * string `CartView` has always produced; only the owner of the counter moved.

/**
 * WHY THERE IS NO `crypto` HERE
 *
 * The real terminal mints these in Rust: SKILL.md §2.3 makes the Rust core the
 * native adapter, and client-generated UUIDv7 ids exist so an offline terminal
 * can create a record before it has ever been synced. This module is the
 * placeholder for that adapter — same type, same shape, one call site to swap.
 * When the Rust side lands, `nextCartLineId` is the only function that changes;
 * no caller inspects the string or builds one itself.
 *
 * @see ./cart.ts — `CartItem.id`, the handle this id exists to be
 */

import type { UuidV7 } from './cart';

// ─────────────────────────────────────────────────────────────────────────────
// The counter
//
// Module-level and deliberately not exported. A caller that could set it could
// rewind the sequence and hand out an id the basket already holds; a caller
// that could read it has no use for it. `nextCartLineId` is the whole API, and
// the module has no other export.
// ─────────────────────────────────────────────────────────────────────────────

let lineCounter = 0;

/**
 * Mint the next cart-line id.
 *
 * Total and never throws: this runs inside a click handler on a till that has
 * to keep taking money, so it has no failure mode to report. The id is only
 * consumed by `addItem` when it is creating a genuinely new line — a repeat of
 * a variant already in the cart merges and returns before the id is used, which
 * is why the sequence may run ahead of the number of rows on screen.
 */
export function nextCartLineId(): UuidV7 {
  lineCounter += 1;
  return `018f3c2a-0000-7000-8000-${lineCounter.toString().padStart(12, '0')}` as UuidV7;
}
