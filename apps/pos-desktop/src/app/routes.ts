/**
 * The terminal shell's route table.
 *
 * Three screens exist: the Sales Terminal, the history of the orders this
 * terminal took while offline, and the Smart Restaurant ecosystem demo
 * (POS / Staff / Manager / CEO views sharing one design system).
 * This module is the one place that says what they are called, in what
 * order, and which URL fragment addresses each one.
 *
 * LAYER: app shell. Pure TypeScript with NO imports of any kind.
 */

export const ROUTES = {
  /** The Sales Terminal: scan items, take payment, print the receipt. */
  sales: 'sales',
  /** Offline order history: what this terminal has sold, and what has synced. */
  offline_orders: 'offline_orders',
  /** Smart Restaurant ecosystem: POS / Staff / Manager / CEO demo views. */
  smart_restaurant: 'smart_restaurant',
} as const;

/** Every route id the shell can address. Derived from `ROUTES`, never restated. */
export type RouteId = (typeof ROUTES)[keyof typeof ROUTES];

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
 * The routes, in navigation order. Frozen because this is module-level
 * shared state.
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
  Object.freeze({
    id: ROUTES.smart_restaurant,
    path: '/smart_restaurant',
    labelTh: 'สมาร์ทเรสเตอรองท์',
    description: 'เดโมระบบ 4 มุมมอง: POS แคชเชียร์, ครัว/บาริสต้า, ผู้จัดการ, CEO',
  }),
]);

/** The route the shell opens on when nothing better is available. */
export const DEFAULT_ROUTE: RouteId = ROUTES.sales;

/** Route ids that must never be guessed by a hand-written string compare. */
export class RouteError extends Error {
  override readonly name = 'RouteError';
}

/**
 * Whether `value` names a route in the table. Accepts `unknown` because the
 * value arrives from `location.hash`, which is untyped user input.
 */
export function isRouteId(value: unknown): value is RouteId {
  return ROUTE_DEFINITIONS.some((route) => route.id === value);
}

/**
 * The definition for a route id.
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

/** The fragment marker, as produced by `location.hash`. */
const HASH_PREFIX = '#';

/**
 * Parse a location fragment into a route id. Total by contract: anything
 * unrecognised resolves to `DEFAULT_ROUTE` rather than throwing.
 */
export function parseRouteFromHash(hash: string): RouteId {
  if (typeof hash !== 'string' || !hash.startsWith(HASH_PREFIX)) {
    return DEFAULT_ROUTE;
  }
  const candidate = hash.slice(HASH_PREFIX.length).replace(/^\//, '');
  return isRouteId(candidate) ? candidate : DEFAULT_ROUTE;
}

/**
 * The canonical fragment for a route: `'#/sales'`, `'#/offline_orders'`,
 * `'#/smart_restaurant'`.
 */
export function hashForRoute(id: RouteId): string {
  return `${HASH_PREFIX}${routeById(id).path}`;
}
