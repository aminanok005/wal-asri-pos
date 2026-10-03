/**
 * CatalogGrid — the menu a cashier sells from, one tile per sellable variant.
 *
 * LAYER: UI (presentation). It renders a resolved `CatalogIndex` and nothing
 * more: it does not decide what is sellable, does not read a price out of the
 * wire payload, and does not add anything to a cart. `buildCatalog` already
 * reached a verdict on every variant, and this component's only job is to show
 * the tiles that survived and to say what it withheld.
 *
 * THAT SECOND JOB IS THE POINT
 *
 * A grid that quietly drops rows is a grid that looks correct. The shift lead
 * sees 48 items on the screen and the server has 52, and nobody learns that four
 * drinks cannot be sold until a customer asks for one. So `index.skipped` is
 * surfaced as a visible warning with a count, grouped by reason — which is the
 * difference between "the menu is short" and "the menu is short because four
 * prices are missing".
 *
 * MONEY
 *
 * Every price on a tile is `entry.unitPrice.toString()` prefixed with ฿. That is
 * the whole formatting rule: the `Money` reached the screen having been built
 * once from an exact satang count, and no component divides, rounds or adds
 * anything. A price computed inline here would be a second implementation of
 * money, and two implementations eventually disagree by one satang.
 *
 * @see ../domain/catalog.ts — where every "sellable" verdict was reached
 */

import type { JSX } from 'react';

import { entriesInCategory } from '../domain/catalog';
import type {
  CatalogEntry,
  CatalogIndex,
  SkipReason,
  SkippedVariant,
  UuidV7,
} from '../domain/catalog';
import { Money } from '../../payments/domain/money';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The grid takes a finished index, never a snapshot.
 *
 * That is the whole layering argument in one signature: this component cannot
 * read `price_list_entries`, so it cannot invent a price, and it cannot see
 * `is_active`, so it cannot resurrect a retired SKU. Whatever it shows was
 * resolved by the domain.
 */
export interface CatalogGridProps {
  /** The resolved menu. Frozen, and safe to hold across renders. */
  readonly index: CatalogIndex;
  /**
   * Called with the whole entry that was tapped.
   *
   * The entry, not the variant id: the caller needs the price too, and the one
   * guarantee this component can offer is that the `unitPrice` it hands over is
   * the exact same `Money` the tile displayed. Handing back only an id would make
   * every caller go and look the price up again, and one of them would do it wrong.
   */
  readonly onSelect: (entry: CatalogEntry) => void;
  /**
   * Show one category. `undefined` — the default — shows every sellable entry;
   * `null` is the uncategorised bucket, which is a real bucket rather than an
   * error: a variant whose product is missing from the snapshot is still sellable
   * and has to go somewhere.
   */
  readonly categoryId?: UuidV7 | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Withheld items
//
// `SkipReason` is a closed set, so this record is exhaustive by construction: add
// a reason to the domain and TypeScript fails here, on the screen that is supposed
// to mention it, rather than in a support ticket a week later.
// ─────────────────────────────────────────────────────────────────────────────

/** Thai wording for each reason a variant never reaches the grid. */
const SKIP_REASON_LABELS: Readonly<Record<SkipReason, string>> = {
  inactive_variant: 'ปิดการขายแล้ว',
  no_price_entry: 'ไม่ได้ตั้งราคา',
  ambiguous_price_list: 'ราคาไม่ชัดเจน',
  invalid_price: 'ราคาไม่ถูกต้อง',
};

/** How many items were withheld, and one clause per distinct reason. */
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
 */
function withheldText(summary: WithheldSummary): string {
  const reasons = summary.clauses.join(' · ');
  return `ซ่อนเมนูไว้ ${summary.total} รายการ (${reasons}) — เมนูที่ไม่มีราคาที่เชื่อถือได้ห้ามขาย ผู้ดูแลร้านต้องตรวจสอบก่อนเปิดขาย`;
}

/**
 * Render a `Money` as Thai baht, e.g. ฿45.50.
 *
 * Repeated rather than imported from a sibling UI file: `CartView.tsx` holds its
 * own copy for the same reason. Formatting is display, the domain deliberately
 * holds no currency symbol, and a shared "formatting" module would be one more
 * layer whose only content is a template string.
 */
function formatBaht(amount: Money): string {
  return `฿${amount.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function CatalogGrid(props: CatalogGridProps): JSX.Element {
  const { index, onSelect, categoryId } = props;

  // The domain does the filtering, so the grid and any other consumer of the
  // index can never disagree about which entries a category contains. `undefined`
  // means "no filter" and passes the frozen `entries` straight through; `null` is
  // a real request — the uncategorised bucket — and goes through the domain.
  const entries =
    categoryId === undefined ? index.entries : entriesInCategory(index, categoryId);

  // Counted from the whole snapshot, not from the visible tiles. A filter
  // narrowing the grid must not silence the warning: the shift lead still needs
  // to know the branch is short of a drink while standing on any tab.
  const withheld = summariseWithheld(index.skipped);

  return (
    <div className="catalog-grid" data-testid="catalog-grid">
      {/* ── Withheld warning ───────────────────────────────────────────────
          `role="status"` so it is announced when it appears — a menu that just
          got three items shorter is exactly the kind of change a cashier should
          hear about rather than notice by looking. It renders nothing at all when
          nothing was skipped, so a healthy menu does not train anyone to ignore
          the line. */}
      {withheld.total > 0 && (
        <p className="catalog-grid__warning" role="status">
          {withheldText(withheld)}
        </p>
      )}

      {/* ── Tiles ──────────────────────────────────────────────────────────
          An explicit empty state, never a blank box: "nothing here" and "still
          loading" look identical on screen otherwise, and they call for opposite
          responses from the person standing in front of the terminal. */}
      {entries.length === 0 ? (
        <p className="catalog-grid__empty">ยังไม่มีเมนูที่ขายได้ในหมวดนี้</p>
      ) : (
        <ul className="catalog-grid__tiles">
          {entries.map((entry) => (
            <li key={entry.variant.id} className="catalog-grid__tile">
              {/* The accessible name is the item's name and nothing else. A screen
                  reader user pressing tiles one after another should hear
                  "เพิ่ม กาแฟลาเต้", "เพิ่ม มอคค่า" — not a price recited before
                  every name, and never the quantity controls that later sit in
                  the same row of the cart. The price stays visible on the tile,
                  where it belongs. */}
              <button
                type="button"
                className="catalog-grid__tile-button"
                aria-label={`เพิ่ม ${entry.variant.name_th}`}
                onClick={() => onSelect(entry)}
              >
                <span className="catalog-grid__tile-name">{entry.variant.name_th}</span>
                <span className="catalog-grid__tile-price">{formatBaht(entry.unitPrice)}</span>
                <span className="catalog-grid__tile-sku">{entry.variant.sku}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default CatalogGrid;
