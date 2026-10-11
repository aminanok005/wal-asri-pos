/**
 * SkippedWarning — the withheld-menu warning, folded into one chip.
 *
 * LAYER: UI (presentation). It decides nothing. `buildCatalog` in
 * `../domain/catalog` already withheld every variant it could not vouch for and
 * left the reasons in `index.skipped`; this component's only job is to show that
 * something was withheld, how much, and why.
 *
 * ── WHY A CHIP, AND WHY IT LIVES BESIDE THE SEARCH BOX ───────────────────────
 *
 * The warning used to be a full-width bar across the top of the grid — a
 * permanent band of the menu's width, carrying a sentence the shift lead reads
 * once and then stops seeing. It is not a headline: it is a caveat about the
 * grid, and it belongs where caveats about the grid live, which is the same row
 * as the search box that is used when a drink cannot be found.
 *
 * ── THE TEXT NEVER LEAVES THE DOM ───────────────────────────────────────────
 *
 * Collapsed, the detail is CLIPPED, not removed — the same recipe used by
 * `.offline-orders__summary`. This is load-bearing in both directions:
 *
 *   · A screen reader still announces the whole sentence without the shift lead
 *     having to know a disclosure exists, which is what the full-width bar gave
 *     them for free.
 *   · `role="status"` keeps matching the element while collapsed. Removing the
 *     node, or marking it `hidden`, would silently delete the live region and
 *     with it every test — and, more importantly, the announcement a cashier
 *     gets when a menu has just got shorter.
 *
 * ── WHY `<button aria-expanded>` AND NOT A RADIO ─────────────────────────────
 *
 * One disclosure, opened and closed. `aria-expanded` says exactly that, and the
 * Esc handler below is the keyboard half of the same contract: the popover is
 * tied to its own trigger, so Escape anywhere inside it closes it and hands
 * focus back to the chip that opened it.
 *
 * COLOUR: `--warns` / `--warn` / `--danger` only. `--warn` on `--warns` measures
 * 4.31:1 — short of AA for 13px text — so the LABEL wears `--danger` (4.68:1
 * light, 5.21:1 dark) and `--warn` is left for the border and the ⚠, where the
 * 3:1 non-text rule applies and it clears at 4.31:1. No new token was added.
 */

import { useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';

import type { CatalogIndex, SkipReason, SkippedVariant } from '../domain/catalog';

export interface SkippedWarningProps {
  /**
   * The whole resolved snapshot — NOT the entries currently on screen.
   *
   * The warning counts what the domain withheld from the entire menu, so a
   * category tab or a search query can never hide a short menu from the shift
   * lead. That is why this takes the `index` and not a tile list.
   */
  readonly index: CatalogIndex;
}

// `SkipReason` is a closed set, so this record is exhaustive by construction:
// add a reason to the domain and TypeScript fails here, on the screen that is
// supposed to mention it, rather than in a support ticket a week later.
//
// The wording is MOVED, not rewritten — every label below is the character the
// full-width bar used to render.
const SKIP_REASON_LABELS: Readonly<Record<SkipReason, string>> = {
  inactive_variant: 'ปิดการขายแล้ว',
  no_price_entry: 'ไม่ได้ตั้งราคา',
  ambiguous_price_list: 'ราคาไม่ชัดเจน',
  invalid_price: 'ราคาไม่ถูกต้อง',
};

interface WithheldSummary {
  readonly total: number;
  /** e.g. `['ไม่ได้ตั้งราคา 1 รายการ', 'ปิดการขายแล้ว 1 รายการ']` */
  readonly clauses: readonly string[];
}

/**
 * Group the skips by reason.
 *
 * A single count ("3 รายการ") would not be actionable: three retired seasonal
 * sizes is expected, three missing prices is a broken price list, and those two
 * need different people to look at them. The order follows first appearance in
 * the snapshot, which is the same order the grid uses, so the warning and the menu
 * read consistently.
 */
function summariseWithheld(skipped: readonly SkippedVariant[]): WithheldSummary {
  const counts = new Map<SkipReason, number>();
  for (const item of skipped) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  const clauses = [...counts.entries()].map(
    ([reason, count]) => `${SKIP_REASON_LABELS[reason]} ${count} รายการ`,
  );
  return { total: skipped.length, clauses };
}

/**
 * The warning line a shift lead reads when the menu is short.
 *
 * It states the count, then the reasons, then why it matters: an item with no
 * trustworthy price must not be sold, so a silently short menu is a revenue and a
 * compliance problem, not a cosmetic one.
 *
 * WORD FOR WORD the line the full-width bar used to render. Collapsing the bar
 * changed how much of it is visible at rest, never what it says.
 */
function withheldText(summary: WithheldSummary): string {
  const reasons = summary.clauses.join(' · ');
  return `ซ่อนเมนูไว้ ${summary.total} รายการ (${reasons}) — เมนูที่ไม่มีราคาที่เชื่อถือได้ห้ามขาย ผู้ดูแลร้านต้องตรวจสอบก่อนเปิดขาย`;
}

export function SkippedWarning({ index }: SkippedWarningProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const detailId = useId();

  const withheld = summariseWithheld(index.skipped);

  // Esc. The handler sits on the WRAPPER so it catches the key whether focus is
  // on the chip that opened the popover or on anything inside it, and returning
  // focus to the chip is what stops a keyboard user from being dropped back at
  // the top of the document.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    setOpen(false);
    chipRef.current?.focus();
  };

  // Nothing withheld, nothing rendered. A warning that is always present stops
  // being read, and this is the same rule the full-width bar followed.
  if (withheld.total === 0) return null;

  return (
    <div className="skipped-warning" data-open={open ? 'true' : 'false'} onKeyDown={handleKeyDown}>
      <button
        ref={chipRef}
        type="button"
        className="skipped-warning__chip"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((was) => !was)}
      >
        {/* Decorative. The count beside it already says everything the glyph
            says, so announcing it too would read the same fact twice. */}
        <span className="skipped-warning__chip-icon" aria-hidden="true">
          ⚠
        </span>
        <span className="skipped-warning__chip-label">{`ซ่อน ${withheld.total} เมนู`}</span>
      </button>

      {/* ALWAYS MOUNTED. `role="status"` so a menu that just got shorter is
          announced rather than noticed by looking, and so the sentence is
          readable whether or not the chip has ever been tapped. */}
      <p id={detailId} className="skipped-warning__detail" role="status">
        {withheldText(withheld)}
      </p>
    </div>
  );
}

export default SkippedWarning;