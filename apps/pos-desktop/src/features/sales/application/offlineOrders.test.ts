import { describe, expect, it } from 'bun:test';
import { Money } from '../../payments/domain/money';
import {
  DEFAULT_ROUTE,
  ROUTE_DEFINITIONS,
  ROUTES,
  RouteError,
  hashForRoute,
  isRouteId,
  parseRouteFromHash,
  routeById,
} from '../../../app/routes';
import {
  OfflineOrdersError,
  createInMemoryOfflineOrdersRepository,
  sortByNewestFirst,
} from './offlineOrders';
import type { OfflineOrderSummary } from './offlineOrders';

/**
 * Strip comments so a boundary guard matches CODE, not prose.
 *
 * Both source files this suite guards DISCUSS the things they are forbidden to
 * import — the port's header names React, the Tauri API and `bun:sqlite` in
 * order to explain why it does not use them. A guard that matched raw source
 * would then fail on the very documentation that documents the rule, and the
 * obvious "fix" would be to delete the explanation. Copied from
 * `../layers.test.ts`, which enforces the same idea one layer up.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, but not `https://`
}

/**
 * Build an order summary.
 *
 * Every field defaults to a plausible committed sale so a test only has to
 * state the ONE thing it is about; a fixture that forced all eight fields to be
 * spelled out would bury the assertion under noise.
 */
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

// Three orders, one per hour of a morning shift. IDs are UUIDv7-shaped and
// ascending with time, exactly as the terminal would mint them.
const ORDER_0900 = summary('018f3c2a-0000-7000-8000-0000000000a1', '2026-10-02T09:00:00.000Z');
const ORDER_1000 = summary('018f3c2a-0000-7000-8000-0000000000b1', '2026-10-02T10:00:00.000Z');
const ORDER_1100 = summary('018f3c2a-0000-7000-8000-0000000000c1', '2026-10-02T11:00:00.000Z');

const SHIFT = [ORDER_0900, ORDER_1000, ORDER_1100] as const;

describe('route table: the default route', () => {
  it('boots onto sales, never onto a report or history screen', () => {
    // A POS terminal is a work tool. Landing on read-only UI means the
    // cashier's first touch is not on the screen where money is taken.
    expect(DEFAULT_ROUTE).toBe(ROUTES.sales);
    expect(DEFAULT_ROUTE).toBe('sales');
  });

  it('has a default route that actually exists in the table', () => {
    // Otherwise a malformed fragment would "fall back" to nowhere.
    expect(isRouteId(DEFAULT_ROUTE)).toBe(true);
    expect(routeById(DEFAULT_ROUTE).id).toBe('sales');
  });
});

describe('route table: hash round-trip', () => {
  it('round-trips EVERY route through hashForRoute and parseRouteFromHash', () => {
    // Driven off ROUTE_DEFINITIONS, not a hand-written list, so a route added
    // to the table later is covered by this test automatically.
    for (const route of ROUTE_DEFINITIONS) {
      expect(parseRouteFromHash(hashForRoute(route.id))).toBe(route.id);
    }
  });

  it('writes the fragment the task specified', () => {
    expect(hashForRoute(ROUTES.sales)).toBe('#/sales');
    expect(hashForRoute(ROUTES.offline_orders)).toBe('#/offline_orders');
  });

  it('parses both accepted spellings', () => {
    expect(parseRouteFromHash('#/sales')).toBe('sales');
    expect(parseRouteFromHash('#/offline_orders')).toBe('offline_orders');
  });
});

describe('route table: isRouteId', () => {
  it('accepts a real route id', () => {
    expect(isRouteId(ROUTES.sales)).toBe(true);
    expect(isRouteId('offline_orders')).toBe(true);
  });

  it('rejects junk of every shape', () => {
    for (const junk of ['', '#', '/sales', 'sales/', 'SALES', 'unknown', null, undefined, 42]) {
      expect(isRouteId(junk)).toBe(false);
    }
  });

  it('rejects an object that merely looks like a route', () => {
    expect(isRouteId({ id: 'sales' })).toBe(false);
  });
});

describe('route table: parseRouteFromHash never throws', () => {
  it('falls back to the default for every unusable fragment', () => {
    // '' — nothing written yet. '#' — the shell cleared it. '#/nope' — a stale
    // bookmark to a screen that was renamed. '/sales' — a bare path with no
    // fragment marker, so not a hash at all.
    for (const fragment of ['', '#', '#/nope', '/sales', '#/', '##/sales', '#/sales/extra']) {
      expect(parseRouteFromHash(fragment)).toBe(DEFAULT_ROUTE);
    }
  });

  it('survives a non-string arriving from untyped JS', () => {
    // `location.hash` is a string, but a postMessage or a JSON body is not, and
    // a till must not fail to open because something upstream sent a number.
    expect(parseRouteFromHash(undefined as unknown as string)).toBe(DEFAULT_ROUTE);
    expect(parseRouteFromHash(7 as unknown as string)).toBe(DEFAULT_ROUTE);
  });
});

describe('route table: routeById', () => {
  it('returns the definition matching the id', () => {
    const sales = routeById(ROUTES.sales);
    expect(sales.id).toBe('sales');
    expect(sales.path).toBe('/sales');
    expect(sales.labelTh).toBe('หน้าขาย');

    const history = routeById(ROUTES.offline_orders);
    expect(history.id).toBe('offline_orders');
    expect(history.path).toBe('/offline_orders');
    expect(history.labelTh).toBe('ประวัติออเดอร์ออฟไลน์');
  });

  it('returns the identical object every time, from one frozen table', () => {
    expect(routeById(ROUTES.sales)).toBe(routeById(ROUTES.sales));
    expect(Object.isFrozen(ROUTE_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(ROUTE_DEFINITIONS[0])).toBe(true);
  });

  it('throws a RouteError for an id an untyped caller invented', () => {
    // Better than `undefined`, which would surface later as a blank screen.
    expect(() => routeById('nope' as 'sales')).toThrow(RouteError);
  });

  it('gives every route a label and a description', () => {
    for (const route of ROUTE_DEFINITIONS) {
      expect(route.labelTh.length).toBeGreaterThan(0);
      expect(route.description.length).toBeGreaterThan(0);
    }
  });
});

describe('sortByNewestFirst', () => {
  it('orders a shift newest first', () => {
    const sorted = sortByNewestFirst(SHIFT);
    expect(sorted.map((order) => order.id)).toEqual([ORDER_1100.id, ORDER_1000.id, ORDER_0900.id]);
  });

  it('accepts an input in any order', () => {
    const sorted = sortByNewestFirst([ORDER_1000, ORDER_1100, ORDER_0900]);
    expect(sorted.map((order) => order.createdAt)).toEqual([
      '2026-10-02T11:00:00.000Z',
      '2026-10-02T10:00:00.000Z',
      '2026-10-02T09:00:00.000Z',
    ]);
  });

  it('breaks a same-millisecond tie on id, descending, regardless of input order', () => {
    // Two orders committed inside one millisecond is routine during a rush.
    // Without the tie-break the same two rows can swap between renders and
    // the history list looks like it is losing orders.
    const twin1 = summary('018f3c2a-0000-7000-8000-0000000000d1', '2026-10-02T09:30:00.123Z');
    const twin2 = summary('018f3c2a-0000-7000-8000-0000000000d2', '2026-10-02T09:30:00.123Z');

    const ascendingInput = sortByNewestFirst([twin1, twin2]).map((order) => order.id);
    const descendingInput = sortByNewestFirst([twin2, twin1]).map((order) => order.id);

    // UUIDv7 embeds a monotonic counter, so the larger id is the later order
    // and must come first — and both input orders must agree.
    expect(ascendingInput).toEqual([twin2.id, twin1.id]);
    expect(descendingInput).toEqual(ascendingInput);
  });

  it('leaves the input array untouched and returns a frozen result', () => {
    const input: OfflineOrderSummary[] = [ORDER_0900, ORDER_1000];
    const sorted = sortByNewestFirst(input);

    expect(input.map((order) => order.id)).toEqual([ORDER_0900.id, ORDER_1000.id]);
    expect(Object.isFrozen(sorted)).toBe(true);
    expect(sorted).not.toBe(input);
  });

  it('sorts empty and single-element inputs without complaint', () => {
    expect(sortByNewestFirst([])).toEqual([]);
    expect(sortByNewestFirst([ORDER_1100]).map((order) => order.id)).toEqual([ORDER_1100.id]);
  });
});

describe('listRecent', () => {
  it('returns at most `limit` orders, newest first', async () => {
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);

    const two = await repo.listRecent(2);
    expect(two.map((order) => order.id)).toEqual([ORDER_1100.id, ORDER_1000.id]);
    expect(two).toHaveLength(2);
  });

  it('returns everything when the limit exceeds what is stored', async () => {
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);
    expect(await repo.listRecent(50)).toHaveLength(3);
  });

  it('returns an empty list for an empty adapter', async () => {
    const repo = createInMemoryOfflineOrdersRepository();
    expect(await repo.listRecent(10)).toEqual([]);
  });

  it('rejects a zero, negative, fractional or NaN limit', async () => {
    // Clamping instead of throwing would turn a caller's broken page size into
    // an empty screen that looks like a till with no sales.
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);

    for (const bad of [0, -1, -50, 1.5, Number.NaN]) {
      await expect(repo.listRecent(bad)).rejects.toThrow(OfflineOrdersError);
    }
  });

  it('rejects the limit with a message that names the bad value', async () => {
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);
    await expect(repo.listRecent(0)).rejects.toThrow('limit must be a positive integer');
  });

  it('returns a frozen array', async () => {
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);
    const recent = await repo.listRecent(3);
    expect(Object.isFrozen(recent)).toBe(true);
  });
});

describe('in-memory adapter: the seed does not leak', () => {
  it('does not leak its seed — emptying the seed cannot shorten a later call', async () => {
    // The adapter must hold its OWN copy. If it kept the caller's array by
    // reference, emptying that array would silently empty the adapter too.
    const seed: OfflineOrderSummary[] = [ORDER_0900, ORDER_1000, ORDER_1100];
    const repo = createInMemoryOfflineOrdersRepository(seed);

    seed.length = 0;
    seed.push(summary('018f3c2a-0000-7000-8000-0000000000ff', '2026-10-02T12:00:00.000Z'));

    const recent = await repo.listRecent(10);
    expect(recent).toHaveLength(3);
    expect(recent.map((order) => order.id)).toEqual([ORDER_1100.id, ORDER_1000.id, ORDER_0900.id]);
  });

  it('does not leak its seed — mutating a returned array cannot affect a second call', async () => {
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);

    const first = (await repo.listRecent(10)) as OfflineOrderSummary[];
    expect(() => first.pop()).toThrow(TypeError);
    expect(() => first.splice(0, first.length)).toThrow(TypeError);

    const second = await repo.listRecent(10);
    expect(second).toHaveLength(3);
    expect(second.map((order) => order.id)).toEqual([ORDER_1100.id, ORDER_1000.id, ORDER_0900.id]);
  });

  it('does not leak its seed — a caller cannot edit a summary it was handed', async () => {
    // Money is frozen by its own constructor; the summaries handed out here are
    // frozen for the same reason, so a stray write in a view cannot corrupt the
    // row the next component will read.
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);
    const found = await repo.findById(ORDER_1000.id);

    expect(found).toBeDefined();
    expect(Object.isFrozen(found)).toBe(true);
    expect(() => {
      (found as { status: string }).status = 'voided';
    }).toThrow(TypeError);

    const again = await repo.findById(ORDER_1000.id);
    expect(again?.status).toBe('completed');
  });
});

describe('findById', () => {
  it('returns the matching summary', async () => {
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);
    const found = await repo.findById(ORDER_1000.id);

    expect(found?.id).toBe(ORDER_1000.id);
    expect(found?.localReceiptNumber).toBe(ORDER_1000.localReceiptNumber);
    expect(found?.status).toBe('completed');
    expect(found?.syncState).toBe('pending');
    expect(found?.createdAt).toBe('2026-10-02T10:00:00.000Z');
    expect(found?.lineCount).toBe(2);
    expect(found?.currencyCode).toBe('THB');
  });

  it('returns undefined for an unknown id', async () => {
    // A miss is an ordinary answer, not an error: an id from another branch's
    // terminal must not read as a failure of this one.
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);

    expect(await repo.findById('018f3c2a-0000-7000-8000-000000009999')).toBeUndefined();
    expect(await repo.findById('')).toBeUndefined();
    expect(await createInMemoryOfflineOrdersRepository().findById(ORDER_1000.id)).toBeUndefined();
  });
});

describe('the money rule at the port boundary', () => {
  it('carries the total as a Money whose satang is a bigint, never a number', async () => {
    // SKILL.md §2.1. The adapter will read a SQLite INTEGER out of
    // `bun:sqlite` as a JS number; if the port let a number through, `total *
    // 1.07` in a view would be one keystroke away and would lose satang.
    const repo = createInMemoryOfflineOrdersRepository(SHIFT);
    const found = await repo.findById(ORDER_1100.id);
    const total = found?.total;

    expect(total).toBeInstanceOf(Money);
    expect(typeof total?.satang).toBe('bigint');
    expect(total?.satang).toBe(5250n);
    expect(total?.toString()).toBe('52.50');
  });

  it('keeps the exact satang count through a round trip — no float drift', async () => {
    // ฿0.10 + ฿0.20 must be ฿0.30. The port passes the value through untouched.
    const awkward = summary('018f3c2a-0000-7000-8000-0000000000ee', '2026-10-02T09:45:00.000Z', {
      total: Money.fromSatang(10n).add(Money.fromSatang(20n)),
    });

    const repo = createInMemoryOfflineOrdersRepository([awkward]);
    const found = await repo.findById(awkward.id);

    expect(found?.total.satang).toBe(30n);
    expect(found?.total.toString()).toBe('0.30');
  });

  it('carries a voided order total as Money too, sign and all', async () => {
    // A void is a separate event, not a negative amount — but the port must not
    // care: whatever the row holds arrives as a Money.
    const voided = summary('018f3c2a-0000-7000-8000-0000000000dd', '2026-10-02T08:00:00.000Z', {
      status: 'voided',
      syncState: 'rejected',
      total: Money.zero(),
    });

    const repo = createInMemoryOfflineOrdersRepository([voided]);
    const found = await repo.findById(voided.id);

    expect(found?.total).toBeInstanceOf(Money);
    expect(found?.total.isZero()).toBe(true);
    expect(found?.status).toBe('voided');
    expect(found?.syncState).toBe('rejected');
  });
});

describe('layer boundary', () => {
  it('the port imports nothing from react, tauri, or a SQL driver', async () => {
    // Enforced structurally, not by convention: the port is the seam, and a
    // stray `import { invoke }` here would make every consumer untestable.
    const source = stripComments(await Bun.file(new URL('./offlineOrders.ts', import.meta.url)).text());

    expect(source).not.toMatch(/from ['"]react['"]/);
    expect(source).not.toMatch(/@tauri-apps/);
    expect(source).not.toMatch(/bun:sqlite/);
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it('the route table imports nothing at all — it is dependency-free by design', async () => {
    // TODO(ROUTER) in routes.ts explains why no router was added. This guard is
    // what keeps that decision honest rather than a comment that quietly rots.
    const source = stripComments(await Bun.file(new URL('../../../app/routes.ts', import.meta.url)).text());

    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/react-router|wouter|@tanstack\/router/);
  });

  it('the route table imports no view component', async () => {
    // A later agent wires the screens to this table. Nothing here may reach
    // back into a view, or the dependency arrow points the wrong way.
    const source = await Bun.file(new URL('../../../app/routes.ts', import.meta.url)).text();

    expect(source).not.toMatch(/\.tsx['"]/);
    expect(source).not.toMatch(/View/);
  });
});
