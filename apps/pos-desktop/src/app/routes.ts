/**
 * The terminal shell's route table.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * Two screens exist today: the Sales Terminal, and the history of the orders
 * this terminal took while offline. This module is the one place that says what
 * they are called, which fragment of the URL addresses them, and what happens
 * when that fragment is nonsense.
 *
 * LAYER: app shell. Pure TypeScript with NO imports of any kind — not React,
 * not Tauri, not a router. That is deliberate rather than incidental: a route
 * table is data, and data that can be imported from a unit test, from the shell
 * that renders it, and from a future native adapter without dragging a whole
 * framework along is worth more than the conveniences a router would add.
 *
 * ── Why the URL fragment and not the path ───────────────────────────────────
 * `location.hash` needs no server configuration and no rewrite rule, so
 * `#/offline_orders` survives an asset reload and works from the `file://`
 * origin a Tauri bundle can serve. The shell reads the fragment on mount and
 * writes it on navigation. Nothing here touches the DOM, so the table stays
 * testable under `bun test` with no browser and no Tauri runtime.
 *
 * ── Why nothing in here throws ──────────────────────────────────────────────
 * A till that will not open is a till that cannot take money. Every entry point
 * below is total. `parseRouteFromHash` returns a valid route for ANY input,
 * because a malformed fragment from a stale bookmark, a truncated deep link or
 * a hand-edited deep link must degrade to the sales screen rather than brick
 * the terminal.
 *
 * TODO(ROUTER): this table is a DELIBERATE PLACEHOLDER for a real router, not
 *   an oversight and not an unfinished import. When the shell grows nested
 *   screens, guarded routes or per-route lazy loading, a router's config is
 *   generated FROM this file and `RouteId` stays the single source of truth
 *   either way. No router dependency was added on purpose: one is a large
 *   install for a two-screen app, and every kilobyte shipped to a cafe in
 *   Chiang Mai has to be fetched once over whatever connection the till
 *   happens to have that week. Do NOT add one until a real routing requirement
 *   exists — when it does, this file is the migration path, not the obstacle.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Route ids
//
// `ROUTES` is the ONLY place a route id is spelled out. Every other lookup in
// this file — the guard, the table, the fragment round-trip — is derived from
// it or from ROUTE_DEFINITIONS, never from a second hand-written list that
// could quietly disagree with the first.
// ─────────────────────────────────────────────────────────────────────────────

export const ROUTES = {
  /** The Sales Terminal: scan items, take payment, print the receipt. */
  sales: 'sales',
  /** Offline order history: what this terminal has sold, and what has synced. */
  offline_orders: 'offline_orders',
} as const;

/** Every route id the shell can address. Derived from `ROUTES`, never restated. */
export type RouteId = (typeof ROUTES)[keyof typeof ROUTES];

// ─────────────────────────────────────────────────────────────────────────────
// The table
// ─────────────────────────────────────────────────────────────────────────────

/** One addressable screen in the terminal shell. */
export interface RouteDefinition {
  /** The stable id used in code, in tests, and as the fragment body. */
  readonly id: RouteId;
  /** The fragment path, always leading `/`. Combined with `#` by `hashForRoute`. */
  readonly path: string;
  /** The nav label the cashier actually reads. Thai, because the operator is. */
  readonly labelTh: string;
  /** What this screen is for, shown as the nav item's helper text and tooltip. */
  readonly description: string;
}

/**
 * The routes, in navigation order.
 *
 * Frozen because this is module-level shared state. A shell that could reorder
 * its own nav entries at runtime would be able to answer "which screen comes
 * first?" differently on two consecutive renders, and the first screen is
 * exactly the thing that must be stable.
 */
export const ROUTE_DEFINITIONS: readonly RouteDefinition[] = Object.freeze([
  Object.freeze({
    id: ROUTES.sales,
    path: '/sales',
    labelTh: 'หน้าขาย',
    description: 'สแกนสินค้า รับเงิน และพิมพ์ใบเสร็จ — หน้าจอหลักของแคชเชียร์',
  }),
  Object.freeze({
    id: ROUTES.offline_orders,
    path: '/offline_orders',
    labelTh: 'ประวัติออเดอร์ออฟไลน์',
    description: 'ดูออเดอร์ที่เครื่องนี้บันทึกไว้ตอนออฟไลน์ และสถานะการซิงก์ของแต่ละใบ',
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Errors
//
// Exactly one error in this file, and only `routeById` raises it. Every other
// function is total by design, so a `RouteError` reaching a screen means one
// caller skipped the guard that would have prevented it.
// ─────────────────────────────────────────────────────────────────────────────

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The default route
//
// WHY `sales` AND NOT A REPORT OR HISTORY SCREEN
// A POS terminal is a work tool, not a dashboard. Booting onto a reporting or
// history screen means the cashier's first interaction is with read-only UI
// while the sale they are in the middle of taking has nowhere to go — and it is
// one stray tap from yesterday's numbers. `sales` is the only screen where
// every touch can take money, which is the only screen whose default is safe
// to land on with no prior context. Offline history is one tap away and is
// perfectly reachable five seconds later.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ROUTE: RouteId = ROUTES.sales;

// ─────────────────────────────────────────────────────────────────────────────
// Lookup and guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A real type guard over `ROUTE_DEFINITIONS` — deliberately NOT a
 * `typeof value === 'sales'` comparison against a hand-written union.
 *
 * WHY: a hardcoded string compare has to be updated in TWO places — here and in
 * `ROUTE_DEFINITIONS` — every time a screen is added, and forgetting the second
 * place compiles cleanly and then rejects a perfectly valid route at runtime,
 * in production, on the till. Deriving the answer from the table makes adding
 * an entry to `ROUTE_DEFINITIONS` sufficient: the guard, `routeById` and the
 * fragment round-trip all follow from it automatically.
 *
 * Accepts `unknown` because the value arrives from `location.hash`, from a
 * postMessage, or from JSON — none of which are typed as `RouteId`.
 */
export function isRouteId(value: unknown): value is RouteId {
  return ROUTE_DEFINITIONS.some((route) => route.id === value);
}

/**
 * The definition for a route id.
 *
 * Returns a value rather than `undefined` because callers hold a `RouteId`,
 * which the table already guarantees exists. An untyped caller passing junk
 * still gets a loud `RouteError` instead of `undefined`, which would surface
 * much later as a blank screen with no explanation.
 *
 * @throws RouteError when `id` is absent from the table.
 */
export function routeById(id: RouteId): RouteDefinition {
  const definition = ROUTE_DEFINITIONS.find((route) => route.id === id);
  if (definition === undefined) {
    throw new RouteError(`unknown route id: ${String(id)}`);
  }
  return definition;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fragment parsing
//
// WHY THIS NEVER THROWS
// The fragment is user input, not programmer error: it can arrive from a stale
// bookmark, a typo, a link pasted from another terminal, or a deep link minted
// before a screen was renamed. Each of those resolves to DEFAULT_ROUTE instead
// of raising. A terminal that shows its sales screen after a bad link has lost
// nothing; one that throws during mount is a till that cannot open a till, and
// nobody is standing next to it to fix the URL.
//
// A leading `#` IS required, because that is exactly what `location.hash`
// carries and exactly what `hashForRoute` produces; the slash after it is
// optional so a hand-written `#sales` also works. Requiring the `#` is what
// keeps these two functions exact inverses of one another.
//
// The comparison is done on the raw string, never through `Date`, `decodeURI`
// or a URL parser: nothing needs decoding, and every one of those would be a
// way to throw on a malformed fragment.
// ─────────────────────────────────────────────────────────────────────────────

/** The fragment marker, as produced by `location.hash`. */
const HASH_PREFIX = '#';

/**
 * Parse a location fragment into a route id.
 *
 * Total by contract: `''`, `'#'`, `'#/nope'`, a path with no leading `#`, and
 * anything a non-string caller passes all resolve to `DEFAULT_ROUTE`.
 */
export function parseRouteFromHash(hash: string): RouteId {
  if (typeof hash !== 'string' || !hash.startsWith(HASH_PREFIX)) {
    return DEFAULT_ROUTE;
  }
  const candidate = hash.slice(HASH_PREFIX.length).replace(/^\//, '');
  return isRouteId(candidate) ? candidate : DEFAULT_ROUTE;
}

/**
 * The canonical fragment for a route: `'#/sales'`, `'#/offline_orders'`.
 *
 * Derived from `routeById` rather than concatenated from the id, so the written
 * fragment and the table can never disagree about the path.
 */
export function hashForRoute(id: RouteId): string {
  return `${HASH_PREFIX}${routeById(id).path}`;
}
