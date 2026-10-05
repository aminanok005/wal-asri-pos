/**
 * OfflineOrdersView component tests.
 *
 * These render the REAL screen over REAL ports — the in-memory adapter from the
 * application layer where a list is expected, and hand-rolled object literals
 * where a test needs control over WHEN a promise settles or WHETHER it rejects.
 * Nothing about React, the DOM or the state machine is stubbed, because the
 * claim under test is precisely that the screen's only way to data is the port.
 *
 * A failure here means a cashier is shown a wrong total, a blank status field,
 * or a list that cannot be told apart from one that has not loaded yet.
 *
 * Requires the simulated DOM from `test/setup-dom.ts`, registered in
 * `bunfig.toml` under `[test] preload`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { Money } from '../features/payments/domain/money';
import {
  OfflineOrdersError,
  createInMemoryOfflineOrdersRepository,
} from '../features/sales/application/offlineOrders';
import type {
  OfflineOrderStatus,
  OfflineOrderSummary,
  OfflineOrdersRepository,
  SyncState,
} from '../features/sales/application/offlineOrders';
import {
  OfflineOrdersView,
  THAI_STATUS_LABELS,
  THAI_SYNC_LABELS,
} from './OfflineOrdersView';

// Unmount between tests. Without this, a mounted tree from a previous test keeps
// its DOM and `screen.getByTestId` finds the first of several matches.
afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Interaction notes
//
// `fireEvent` is used rather than `element.click()` for the reason the catalog
// and cart tests give: React 19 batches state updates, and a raw DOM `.click()`
// invoked from test code sits outside React's act() scope, so the re-render is
// not flushed before the assertion runs.
//
// `act` is used to settle the promises the screen is waiting on. The port is
// async by design — so the SQLite adapter can land without a rewrite — so a
// test that rendered and immediately asserted would assert the loading state
// forever.
//
// Every element is located the way a person would find it: by its visible Thai
// text, scoped through `within(view())` so a query cannot wander off the screen.
// The screen itself is the one exception, found by `data-testid`.
// ─────────────────────────────────────────────────────────────────────────────

/** The screen under test. */
function view(): HTMLElement {
  return screen.getByTestId('offline-orders');
}

/** Every rendered row, zero included — an empty list is one of the states under test. */
function rows(): HTMLElement[] {
  return within(view()).queryAllByTestId('offline-order-row');
}

/**
 * The row for one receipt number, looked up loudly.
 *
 * `noUncheckedIndexedAccess` makes every `find` return `T | undefined`, and
 * quietly asserting against no row at all would turn a fixture mistake into a
 * passing test about nothing.
 */
function rowFor(receiptNumber: string): HTMLElement {
  const found = rows().find((row) => (row.textContent ?? '').includes(receiptNumber));
  if (found === undefined) {
    throw new Error(`no row was rendered for receipt ${receiptNumber}`);
  }
  return found;
}

/** The visible text of one row, exactly as the cashier reads it. */
function rowText(receiptNumber: string): string {
  return rowFor(receiptNumber).textContent ?? '';
}

/**
 * Drain the microtask queue inside `act`, twice.
 *
 * Twice on purpose: the screen's `listRecent(...).then(...)` is one hop, and the
 * state update it schedules is applied on the following flush. A single await
 * leaves a race that only shows up when the machine running the suite is busier
 * than the author's laptop.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Render the screen and let every already-settled promise flush. */
async function renderView(props: {
  readonly repository: OfflineOrdersRepository;
  readonly limit?: number;
}): Promise<void> {
  render(<OfflineOrdersView {...props} />);
  await flush();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
//
// Every field defaults to a plausible committed sale, so a test states only the
// ONE thing it is about. A fixture that spelled out all eight fields per order
// would bury the assertion under noise.
// ─────────────────────────────────────────────────────────────────────────────

function summary(
  id: string,
  createdAt: string,
  overrides: Partial<OfflineOrderSummary> = {},
): OfflineOrderSummary {
  return {
    id,
    localReceiptNumber: `R-${id.slice(-4)}`,
    status: 'completed',
    syncState: 'pending',
    createdAt,
    lineCount: 2,
    total: Money.fromSatang(5250n),
    roundingAdjustmentSatang: Money.fromSatang(0n),
    currencyCode: 'THB',
    ...overrides,
  };
}

// Three orders across a morning shift, one per status/sync combination the shift
// lead has to tell apart. IDs are UUIDv7-shaped and ascending with time, exactly
// as the terminal would mint them.
const ORDER_LATTE = summary('018f3c2a-0000-7000-8000-0000000000a1', '2026-10-02T09:00:00.000Z', {
  localReceiptNumber: 'R-1001',
  status: 'completed',
  syncState: 'synced',
  lineCount: 2,
  total: Money.fromSatang(5250n),
});

const ORDER_TEA = summary('018f3c2a-0000-7000-8000-0000000000b1', '2026-10-02T10:00:00.000Z', {
  localReceiptNumber: 'R-1002',
  status: 'in_preparation',
  syncState: 'pending',
  lineCount: 3,
  total: Money.fromSatang(13000n),
});

const ORDER_MOCHA = summary('018f3c2a-0000-7000-8000-0000000000c1', '2026-10-02T11:00:00.000Z', {
  localReceiptNumber: 'R-1003',
  status: 'voided',
  syncState: 'rejected',
  lineCount: 1,
  total: Money.zero(),
});

const SHIFT: readonly OfflineOrderSummary[] = [ORDER_LATTE, ORDER_TEA, ORDER_MOCHA];

// ─────────────────────────────────────────────────────────────────────────────
// Hand-rolled ports
//
// Needed where the in-memory adapter is the wrong tool: it always resolves on
// the next microtask, so it can neither prove the loading→loaded transition nor
// reject at all.
// ─────────────────────────────────────────────────────────────────────────────

/** A promise the test settles by hand. */
function deferred(): {
  readonly promise: Promise<readonly OfflineOrderSummary[]>;
  readonly resolve: (orders: readonly OfflineOrderSummary[]) => void;
  readonly reject: (error: unknown) => void;
} {
  // The no-op initialisers are replaced synchronously by the executor below,
  // before this function returns — the declaration exists only so TypeScript has
  // something to assign into without a non-null assertion.
  let resolve: (orders: readonly OfflineOrderSummary[]) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<readonly OfflineOrderSummary[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A port that hands back one hand-settled promise. One render per test. */
function deferredRepository(pending: ReturnType<typeof deferred>): OfflineOrdersRepository {
  return {
    listRecent: () => pending.promise,
    findById: async () => undefined,
  };
}

/** A port whose `listRecent` always fails, the way a locked database does. */
function rejectingRepository(error: unknown): OfflineOrdersRepository {
  return {
    listRecent: () => Promise.reject(error),
    findById: async () => undefined,
  };
}

/** Wrap a port so the `limit` values it was asked for can be asserted on. */
function recordingLimits(
  inner: OfflineOrdersRepository,
  calls: number[],
): OfflineOrdersRepository {
  return {
    listRecent: (limit: number) => {
      calls.push(limit);
      return inner.listRecent(limit);
    },
    findById: (id: string) => inner.findById(id),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Loading, then loaded
//
// The transition is asserted rather than skipped. "Loading" and "no orders" are
// the two states a history screen is most easily allowed to get wrong, and both
// begin with an empty list on screen.
// ─────────────────────────────────────────────────────────────────────────────

describe('OfflineOrdersView — loading, then loaded', () => {
  it('shows the loading line first, and replaces it with the rows once the port answers', async () => {
    const pending = deferred();
    render(<OfflineOrdersView repository={deferredRepository(pending)} />);

    // Before anything resolves: a live region saying so, in Thai, and NO rows.
    const loading = within(view()).getByRole('status');
    expect(loading.textContent).toBe('กำลังโหลด…');
    expect(rows()).toHaveLength(0);

    await act(async () => {
      pending.resolve(SHIFT);
      await Promise.resolve();
    });

    // After: the loading line is GONE. It cannot merely be overwritten by the
    // summary line, because a screen that still reads "loading" next to a full
    // list tells the cashier to wait for orders that are already there.
    expect(screen.queryByText('กำลังโหลด…')).toBeNull();
    expect(rows()).toHaveLength(3);
  });

  it('shows the newest order first, in the order the port returned them', async () => {
    // The screen neither re-sorts nor re-pages: `created_at DESC` is what the
    // index `idx_local_orders_created_at` already serves, and re-sorting here
    // would be a second implementation of that ordering to disagree with.
    await renderView({ repository: createInMemoryOfflineOrdersRepository(SHIFT) });

    expect(rows().map((row) => row.textContent ?? '')).toHaveLength(3);
    expect(rows()[0]?.textContent ?? '').toContain('R-1003');
    expect(rows()[2]?.textContent ?? '').toContain('R-1001');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every seeded order, field by field
//
// Read as rendered text, not as state: if the row says ฿52.50 that is what the
// cashier sees, and a screen that computed the same figure by another route
// would still be a second implementation of money.
// ─────────────────────────────────────────────────────────────────────────────

describe('OfflineOrdersView — one row per order', () => {
  it('renders every seeded order with its receipt, status, sync state, lines and total', async () => {
    await renderView({ repository: createInMemoryOfflineOrdersRepository(SHIFT) });

    // ฿52.50 — the latte and pastry, committed and already pushed upstream.
    const latte = rowText('R-1001');
    expect(latte).toContain('R-1001');
    expect(latte).toContain(THAI_STATUS_LABELS.completed);
    expect(latte).toContain(THAI_SYNC_LABELS.synced);
    expect(latte).toContain('2026-10-02T09:00:00.000Z');
    expect(latte).toContain('2 รายการ');
    expect(latte).toContain('฿52.50');

    // ฿130.00 — still being made, and still waiting to be pushed. The healthy
    // case where status and sync state disagree, and both must be visible.
    const tea = rowText('R-1002');
    expect(tea).toContain('R-1002');
    expect(tea).toContain(THAI_STATUS_LABELS.in_preparation);
    expect(tea).toContain(THAI_SYNC_LABELS.pending);
    expect(tea).toContain('3 รายการ');
    expect(tea).toContain('฿130.00');

    // ฿0.00 — a void is not a negative amount, and the row still has to show it.
    const mocha = rowText('R-1003');
    expect(mocha).toContain('R-1003');
    expect(mocha).toContain(THAI_STATUS_LABELS.voided);
    expect(mocha).toContain(THAI_SYNC_LABELS.rejected);
    expect(mocha).toContain('1 รายการ');
    expect(mocha).toContain('฿0.00');
  });

  it('counts the orders it actually loaded, so a truncated page is visible', async () => {
    await renderView({ repository: createInMemoryOfflineOrdersRepository(SHIFT) });

    expect(within(view()).getByText('โหลดออเดอร์ 3 รายการ')).toBeDefined();
  });

  it('gives each row its own sync badge, separate from the status label', async () => {
    await renderView({ repository: createInMemoryOfflineOrdersRepository(SHIFT) });

    // A screen that had started printing the status label in the sync badge
    // would still satisfy every text assertion above on a row where the two
    // happen to be similar — so the badge is located by its own hook.
    const badges = within(view()).getAllByText(THAI_SYNC_LABELS.synced);
    expect(badges).toHaveLength(1);
    expect(badges[0]?.getAttribute('data-sync-state')).toBe('synced');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Empty
// ─────────────────────────────────────────────────────────────────────────────

describe('OfflineOrdersView — signed cash rounding', () => {
  // A sale that rounded DOWN: the ฿45.50 basket became ฿45.47 on the drawer, so
  // the adjustment is −3. The sign is the whole point of the field.
  const ORDER_ROUNDED = summary('018f3c2a-0000-7000-8000-0000000c1', '2026-10-02T11:00:00.000Z', {
    localReceiptNumber: 'R-3001',
    total: Money.fromSatang(4547n),
    roundingAdjustmentSatang: Money.fromSatang(-3n),
  });

  it('shows the NEGATIVE adjustment with its sign, not its absolute value', async () => {
    await renderView({ repository: createInMemoryOfflineOrdersRepository([ORDER_ROUNDED]) });

    const rounding = rowFor('R-3001').querySelector('[data-testid="offline-order-rounding"]');
    expect(rounding).not.toBeNull();

    // `-฿0.03`, sign OUTSIDE the baht symbol. `฿-0.03` would be the sign inside
    // the currency, and `฿0.03` would be the sign dropped — the failure this
    // test exists to catch.
    expect(rounding?.textContent ?? '').toContain('ปัดเศษ -฿0.03');
    expect(rounding?.getAttribute('data-rounding-sign')).toBe('negative');

    // The payable shown beside it must reconcile with the adjustment:
    // 4547 + 3 = 4550. A screen showing −฿0.03 next to ฿45.50 would be lying.
    expect(rowText('R-3001')).toContain('฿45.47');
    expect(rowText('R-3001')).not.toContain('฿-0.03');
  });

  it('shows a POSITIVE adjustment with a plus, so the direction is never guessed', async () => {
    const up = summary('018f3c2a-0000-7000-8000-0000000c2', '2026-10-02T12:00:00.000Z', {
      localReceiptNumber: 'R-3002',
      total: Money.fromSatang(4550n),
      roundingAdjustmentSatang: Money.fromSatang(3n),
    });

    await renderView({ repository: createInMemoryOfflineOrdersRepository([up]) });

    const rounding = rowFor('R-3002').querySelector('[data-testid="offline-order-rounding"]');
    expect(rounding?.textContent ?? '').toContain('ปัดเศษ +฿0.03');
    expect(rounding?.getAttribute('data-rounding-sign')).toBe('positive');
  });

  it('renders NO rounding line at all when the sale did not round', async () => {
    // A blank span would be a bug, not a nicety: `ปัดเศษ ฿0.00` on an untouched
    // sale trains staff to ignore the row where a real adjustment appears.
    await renderView({ repository: createInMemoryOfflineOrdersRepository(SHIFT) });

    const anyRounding = view().querySelector('[data-testid="offline-order-rounding"]');
    expect(anyRounding).toBeNull();
    expect(view().textContent ?? '').not.toContain('ปัดเศษ');
  });

  it('keeps the rounding line inside its own row, so it cannot move between sales', async () => {
    await renderView({
      repository: createInMemoryOfflineOrdersRepository([...SHIFT, ORDER_ROUNDED]),
    });

    expect(rowFor('R-3001').querySelector('[data-testid="offline-order-rounding"]')).not.toBeNull();
    expect(rowFor('R-1001').querySelector('[data-testid="offline-order-rounding"]')).toBeNull();
  });
});

describe('OfflineOrdersView — empty state', () => {
  it('says no orders are recorded here, and does NOT say it is still loading', async () => {
    await renderView({ repository: createInMemoryOfflineOrdersRepository() });

    expect(
      within(view()).getByText('ยังไม่มีออเดอร์ที่บันทึกไว้ในเครื่องนี้'),
    ).toBeDefined();
    // THE assertion that matters most on this screen. The two states look
    // identical if both are an empty box, and they call for opposite responses:
    // "wait" versus "this till has sold nothing today".
    expect(screen.queryByText('กำลังโหลด…')).toBeNull();
    expect(rows()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Error
//
// The adapter is asked for a list it cannot produce — a locked SQLCipher file,
// or a page size the port refuses. Either way the manager has to be able to
// report something more useful than "it did not load".
// ─────────────────────────────────────────────────────────────────────────────

describe('OfflineOrdersView — error state', () => {
  it('names the failed read in Thai and repeats the adapter message verbatim', async () => {
    await renderView({
      repository: rejectingRepository(
        new OfflineOrdersError('SQLCIPHER: cannot open database file'),
      ),
    });

    const alert = within(view()).getByRole('alert');
    expect(alert.textContent).toContain('อ่านรายการออเดอร์ไม่สำเร็จ');
    expect(alert.textContent).toContain('SQLCIPHER: cannot open database file');
    expect(rows()).toHaveLength(0);
    expect(screen.queryByText('กำลังโหลด…')).toBeNull();
  });

  it('still says something readable when what was thrown is not an Error', async () => {
    // A rejected promise carries no guarantee about what was thrown into it, and
    // a screen that rendered `[object Object]` — or nothing at all — would leave
    // the shift lead with nothing to report.
    await renderView({ repository: rejectingRepository('database is locked') });

    expect(within(view()).getByRole('alert').textContent).toContain('database is locked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Exhaustive Thai labels
//
// Iterated off explicit member lists rather than off `Object.keys`, so a new rung
// added to either union lands here as a MISSING MEMBER and fails, instead of
// quietly rendering `undefined` into a row whose every other field is legible.
// ─────────────────────────────────────────────────────────────────────────────

const ALL_STATUSES: readonly OfflineOrderStatus[] = [
  'draft',
  'submitted',
  'in_preparation',
  'ready',
  'served',
  'completed',
  'void_requested',
  'voided',
];

const ALL_SYNC_STATES: readonly SyncState[] = ['pending', 'synced', 'conflict', 'rejected'];

describe('OfflineOrdersView — every rung has a Thai label', () => {
  it('labels EVERY member of the status union, with nothing extra and nothing blank', () => {
    for (const status of ALL_STATUSES) {
      expect(THAI_STATUS_LABELS[status]).toBeString();
      expect(THAI_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
    // Equal counts in both directions: no member unlabelled, and no label left
    // behind for a rung the union no longer has.
    expect(Object.keys(THAI_STATUS_LABELS)).toHaveLength(ALL_STATUSES.length);
  });

  it('labels EVERY member of the sync-state union, with nothing extra and nothing blank', () => {
    for (const state of ALL_SYNC_STATES) {
      expect(THAI_SYNC_LABELS[state]).toBeString();
      expect(THAI_SYNC_LABELS[state].length).toBeGreaterThan(0);
    }
    expect(Object.keys(THAI_SYNC_LABELS)).toHaveLength(ALL_SYNC_STATES.length);
  });

  it('renders a row for every status and every sync state, with no `undefined` on screen', async () => {
    // One order per rung, so the labels are asserted as RENDERED TEXT rather
    // than as map entries. A map can be exhaustive and a row can still print
    // `undefined` if the screen ever indexed it wrongly.
    const every: OfflineOrderSummary[] = ALL_STATUSES.map((status, index) =>
      summary(
        `018f3c2a-0000-7000-8000-000000000${index}01`,
        `2026-10-02T0${index}:00:00.000Z`,
        {
          localReceiptNumber: `R-200${index}`,
          status,
          syncState: ALL_SYNC_STATES[index] ?? 'pending',
        },
      ),
    );

    await renderView({ repository: createInMemoryOfflineOrdersRepository(every) });

    expect(rows()).toHaveLength(ALL_STATUSES.length);
    for (const label of [...Object.values(THAI_STATUS_LABELS), ...Object.values(THAI_SYNC_LABELS)]) {
      expect(within(view()).getAllByText(label).length).toBeGreaterThan(0);
    }
    // The failure this whole block exists to prevent, named literally.
    expect(view().textContent).not.toContain('undefined');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The page size
// ─────────────────────────────────────────────────────────────────────────────

describe('OfflineOrdersView — limit', () => {
  it('asks the port for 50 orders when the caller names no limit', async () => {
    const calls: number[] = [];
    await renderView({
      repository: recordingLimits(createInMemoryOfflineOrdersRepository(SHIFT), calls),
    });

    expect(calls).toEqual([50]);
  });

  it('honours an explicit limit: three seeded, limit 2, exactly two rows', async () => {
    const calls: number[] = [];
    await renderView({
      repository: recordingLimits(createInMemoryOfflineOrdersRepository(SHIFT), calls),
      limit: 2,
    });

    expect(calls).toEqual([2]);
    expect(rows()).toHaveLength(2);
    // The two NEWEST, because the port owns the ordering and this screen only
    // asks. A screen that re-paged after the fact could show any two.
    expect(rows()[0]?.textContent ?? '').toContain('R-1003');
    expect(rows()[1]?.textContent ?? '').toContain('R-1002');
    expect(within(view()).getByText('โหลดออเดอร์ 2 รายการ')).toBeDefined();
  });

  it("surfaces the port's own limit rejection as the error state", async () => {
    // A `limit` of 0 is rejected by the port rather than clamped, on purpose: a
    // caller that computed 0 has a broken page size, and quietly showing an
    // empty list would turn that bug into a till that appears to have no sales.
    await renderView({ repository: createInMemoryOfflineOrdersRepository(SHIFT), limit: 0 });

    const alert = within(view()).getByRole('alert');
    expect(alert.textContent).toContain('อ่านรายการออเดอร์ไม่สำเร็จ');
    expect(alert.textContent).toContain('limit must be a positive integer');
    expect(rows()).toHaveLength(0);
  });

  it('returns to the loading state when the limit changes, then renders the new page', async () => {
    const repository = createInMemoryOfflineOrdersRepository(SHIFT);
    const { rerender } = render(<OfflineOrdersView repository={repository} limit={3} />);
    await flush();
    expect(rows()).toHaveLength(3);

    rerender(<OfflineOrdersView repository={repository} limit={1} />);

    // The old page is GONE while the new one is in flight. Keeping three rows on
    // screen under a limit of one would show the cashier orders the screen is
    // not claiming to have loaded.
    expect(screen.queryByText('กำลังโหลด…')).not.toBeNull();
    expect(rows()).toHaveLength(0);

    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent ?? '').toContain('R-1003');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Money integrity
//
// THE FLOAT TRAP THIS GUARDS: `฿0.10 + ฿0.20` is `0.30000000000000004` in IEEE
// 754, so a screen that had divided satang by 100 itself would print ฿0.30 only
// by luck, and ฿52.50 would survive while ฿0.30 did not. Thirty satang must
// reach the screen as ฿0.30 because `summary.total` is read and formatted —
// never recomputed from the lines, never divided, never turned into a number.
// ─────────────────────────────────────────────────────────────────────────────

describe('OfflineOrdersView — money on the row', () => {
  it('renders 30 satang as ฿0.30 and zero as ฿0.00, exactly', async () => {
    const awkward = summary('018f3c2a-0000-7000-8000-0000000000ee', '2026-10-02T09:45:00.000Z', {
      localReceiptNumber: 'R-3001',
      lineCount: 2,
      // Built the way the domain builds it: two satang counts added, never two
      // floats. This is the exact construction that breaks at ฿0.30.
      total: Money.fromSatang(10n).add(Money.fromSatang(20n)),
    });
    const free = summary('018f3c2a-0000-7000-8000-0000000000f1', '2026-10-02T09:50:00.000Z', {
      localReceiptNumber: 'R-3002',
      status: 'voided',
      lineCount: 0,
      total: Money.zero(),
    });

    await renderView({ repository: createInMemoryOfflineOrdersRepository([awkward, free]) });

    expect(awkward.total.satang).toBe(30n);
    expect(rowText('R-3001')).toContain('฿0.30');
    expect(rowText('R-3002')).toContain('฿0.00');
    // A void with no lines is a real row and still carries a total. Rendering it
    // as a blank cell would read as a screen that failed to load the money.
    expect(rowText('R-3002')).toContain('0 รายการ');
  });

  it('keeps two decimal places on every row, whatever the satang count', async () => {
    await renderView({ repository: createInMemoryOfflineOrdersRepository(SHIFT) });

    for (const row of rows()) {
      expect(row.textContent).toMatch(/฿\d+\.\d{2}/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. The screen's shape
// ─────────────────────────────────────────────────────────────────────────────

describe('OfflineOrdersView — a read-only screen', () => {
  it('renders no interactive control, and a tap on a row changes nothing', async () => {
    await renderView({ repository: createInMemoryOfflineOrdersRepository(SHIFT) });

    // Every action on an offline order is an outbox write (SKILL.md §2.2) and
    // this screen has no way to perform one. A row that had quietly become a
    // button would be an affordance the port cannot honour — and a mis-tap here
    // is the one thing that must never be able to void a sale.
    expect(within(view()).queryAllByRole('button')).toHaveLength(0);
    expect(within(view()).queryAllByRole('link')).toHaveLength(0);

    const before = rowText('R-1001');
    fireEvent.click(rowFor('R-1001'));
    expect(rowText('R-1001')).toBe(before);
    expect(rows()).toHaveLength(3);
  });

  it('names itself and heads itself in Thai, matching the nav label', async () => {
    await renderView({ repository: createInMemoryOfflineOrdersRepository() });

    // The same wording as `ROUTE_DEFINITIONS` in `app/routes.ts`, so the tab the
    // cashier pressed and the screen it opened say the same thing.
    expect(view().getAttribute('aria-label')).toBe('ประวัติออเดอร์ออฟไลน์');
    expect(within(view()).getByRole('heading').textContent).toBe('ประวัติออเดอร์ออฟไลน์');
  });

  it('reads the port it was given, and nothing else', async () => {
    // The seam, asserted from the outside. A screen that had started importing
    // SQLite or Tauri would still render these tests on a machine with no
    // native runtime, and would then be the thing that cannot be tested at all.
    const seen: string[] = [];
    const port: OfflineOrdersRepository = {
      listRecent: async () => SHIFT,
      findById: async (id) => {
        seen.push(id);
        return undefined;
      },
    };

    await renderView({ repository: port });
    expect(rows()).toHaveLength(3);
    // The history screen reads a page and nothing else.
    expect(seen).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. The unmount guard
// ─────────────────────────────────────────────────────────────────────────────

describe('OfflineOrdersView — a late response never reaches a dead tree', () => {
  it('ignores a response that lands after the cashier navigated away', async () => {
    const pending = deferred();
    const { unmount } = render(
      <OfflineOrdersView repository={deferredRepository(pending)} />,
    );

    expect(screen.getByText('กำลังโหลด…')).toBeDefined();
    unmount();
    expect(screen.queryByTestId('offline-orders')).toBeNull();

    // The read completes only now — after the screen is gone. React must not be
    // asked to write into an unmounted tree, and a terminal that logs a
    // thousand of those warnings a shift is a terminal nobody reads the log of.
    await act(async () => {
      pending.resolve(SHIFT);
      await Promise.resolve();
    });

    expect(screen.queryByTestId('offline-orders')).toBeNull();
  });
});
