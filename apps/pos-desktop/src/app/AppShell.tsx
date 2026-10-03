/**
 * AppShell — the terminal's frame, and the only thing that switches screens.
 *
 * ── What this file is ────────────────────────────────────────────────────────
 * Two screens exist today: the Sales Terminal, and the history of the orders this
 * terminal took while offline. `app/routes.ts` says what they are called, in
 * what order, and which URL fragment addresses each one. This file renders one
 * nav button per entry in that table and the screen the current entry names.
 *
 * LAYER: app shell. It holds exactly ONE piece of state — the active route id —
 * and passes data down. There is no business logic here, no money arithmetic, and
 * no import of `@tauri-apps/*`, `bun:sqlite` or any network client. The shell is
 * what a native entry point mounts, so the moment it could not be rendered under
 * `bun test` with no Tauri runtime it would stop being testable at all.
 *
 * @see ./routes.ts — the route table this shell switches over
 * @see ../routes/SalesTerminalView.tsx — the screen a till must open on
 * @see ../routes/OfflineOrdersView.tsx — the screen that reads the port
 */

// ─────────────────────────────────────────────────────────────────────────────
// Imports
//
// `import type` for the ids, the port and `JSX`: `verbatimModuleSyntax` is on
// repo-wide, and none of those is used as a VALUE here. A value import would
// emit a runtime `require` of modules pulled in for type positions alone.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { createInMemoryOfflineOrdersRepository } from '../features/sales/application/offlineOrders';
import type { OfflineOrdersRepository } from '../features/sales/application/offlineOrders';
import { OfflineOrdersView } from '../routes/OfflineOrdersView';
import { SalesTerminalView } from '../routes/SalesTerminalView';
import {
  DEFAULT_ROUTE,
  ROUTES,
  ROUTE_DEFINITIONS,
  hashForRoute,
  isRouteId,
  parseRouteFromHash,
  routeById,
} from './routes';
import type { RouteId } from './routes';

// ─────────────────────────────────────────────────────────────────────────────
// Props
//
// Both props are optional so `<AppShell />` renders standalone, which is what lets
// this file be tested and reviewed with no native runtime and no wiring. The real
// terminal entry point will pass the SQLCipher adapter as `ordersRepository`.
// ─────────────────────────────────────────────────────────────────────────────

export interface AppShellProps {
  /** Where to start. Defaults to the hash in the URL, then to DEFAULT_ROUTE. */
  readonly initialRoute?: RouteId;
  /** Defaults to an empty in-memory repository, so the shell renders standalone. */
  readonly ordersRepository?: OfflineOrdersRepository;
}

/**
 * The screen the shell opens on.
 *
 * THE ORDER OF THESE CHECKS IS A SAFETY RULE, NOT A STYLE CHOICE.
 *
 * An INVALID ROUTE MUST NEVER BE RENDERED: a value that does not pass `isRouteId`
 * is discarded here, before it can reach the `switch` in `renderRoute`, so no
 * caller — a typo'd prop, a stale bookmark, a deep link minted before a screen was
 * renamed — can put the terminal into a state the table does not describe.
 *
 * A TILL MUST OPEN ON THE SALES SCREEN: with no usable `initialRoute` and no
 * `window` at all (a server render, a design review, a test with no DOM) the
 * answer is `DEFAULT_ROUTE`, which is the only screen where every touch can take
 * money. Landing on a read-only screen with no prior context puts yesterday's
 * numbers one stray tap away from the sale the cashier is in the middle of taking.
 *
 * The hash is read only when there is nothing better, and `parseRouteFromHash` is
 * total, so that line can answer DEFAULT_ROUTE as well — a nonsense fragment
 * degrades to the sales screen rather than bricking the till.
 */
function resolveInitialRoute(initialRoute: RouteId | undefined): RouteId {
  if (isRouteId(initialRoute)) {
    return initialRoute;
  }
  if (typeof window === 'undefined') {
    return DEFAULT_ROUTE;
  }
  return parseRouteFromHash(window.location.hash);
}

/**
 * The shell's standalone port: a REAL adapter with no rows behind it.
 *
 * Module-level and built once, deliberately. `createInMemoryOfflineOrdersRepository`
 * returns a fresh frozen object on every call, and `OfflineOrdersView` re-reads
 * its list whenever `repository` changes identity — so a default built inline in
 * the render body would hand the history screen a new port on every pass, and the
 * screen would read, render, re-read and render forever.
 */
const EMPTY_ORDERS_REPOSITORY: OfflineOrdersRepository = createInMemoryOfflineOrdersRepository();

/**
 * The compile-time half of the exhaustive check in `renderRoute`.
 *
 * Takes `never`, so it only type-checks inside a branch the switch has already
 * proved impossible, and it does nothing at runtime. It exists so that adding a
 * rung to `RouteId` without an arm below FAILS THE BUILD rather than shipping.
 */
function assertRouteIsExhaustive(value: never): void {
  void value;
}

/**
 * The screen for a route id.
 *
 * An explicit `switch` rather than a component lookup table, because the arms are
 * what make the routing total: TypeScript proves the default arm unreachable, and
 * a third screen added to `ROUTE_DEFINITIONS` without an arm here does not compile.
 *
 * THE DEFAULT ARM RENDERS THE SALES SCREEN, AND THAT IS THE POINT
 *
 * A NEW ROUTE ADDED TO THE TABLE WITHOUT A SCREEN MUST NOT BLANK THE TERMINAL.
 * The unreachable arm is still written as a fallback because the two failure
 * modes are not equal: a build that refuses to compile is caught in an office,
 * whereas an empty terminal is a till that cannot take money — and it happens in
 * a cafe in Chiang Mai, mid-shift, with nobody standing next to the machine. A
 * sales screen the cashier did not ask for is a recoverable annoyance. A blank
 * one is a queue.
 */
function renderRoute(route: RouteId, ordersRepository: OfflineOrdersRepository): JSX.Element {
  switch (route) {
    case ROUTES.offline_orders:
      return <OfflineOrdersView repository={ordersRepository} />;
    case ROUTES.sales:
      return <SalesTerminalView />;
    default:
      assertRouteIsExhaustive(route);
      return <SalesTerminalView />;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The terminal frame: a nav built from the route table, and the active screen.
 *
 * `props = {}` rather than `props?.` — the entry point mounts `<AppShell />` with
 * no props at all, and a shell that demanded `{}` to render would be a shell that
 * cannot demonstrate itself.
 */
export function AppShell(props: AppShellProps = {}): JSX.Element {
  const { initialRoute, ordersRepository } = props;

  // THE ONE PIECE OF STATE IN THE SHELL. A lazy initialiser rather than a value,
  // so the fragment is read once per mount instead of on every render — the
  // fragment is input to the mount, not something this component keeps tracking.
  const [activeRoute, setActiveRoute] = useState<RouteId>(() =>
    resolveInitialRoute(initialRoute),
  );

  // The shell OWNS the fragment and listens to nothing. `routes.ts` is the parser
  // and this is the only writer: the state above is the source of truth and the
  // URL follows it. A `hashchange` listener would be a second source of truth
  // fighting the first — and in this repo's simulated DOM it would never fire on
  // its own, so any behaviour resting on one would be untested behaviour.
  useEffect(() => {
    // No `window` at all under a server render or a bare Node process. The screen
    // on the cashier's table is the thing that must survive; the bar's fragment is
    // not.
    if (typeof window === 'undefined') {
      return;
    }
    try {
      // THE FRAGMENT IS WHAT SURVIVES A RELOAD IN A TAURI BUNDLE, and it needs no
      // server rewrite rule: `#/offline_orders` comes back untouched after an asset
      // reload, and it works from the `file://` origin the bundle serves, where a
      // path (`/offline_orders`) would be a request nothing is there to answer.
      // `hashForRoute` rather than concatenation, so the written fragment can never
      // disagree with the table.
      window.location.hash = hashForRoute(activeRoute);
    } catch {
      // A THROWN WRITE MUST NOT BREAK RENDERING. Some embedders refuse to let a
      // document rewrite its own URL — a sandboxed frame, a hardened webview — and
      // `hashForRoute` is the one call in this file that can raise. The screen a
      // cashier is looking at matters more than the fragment in the bar, so the
      // failure is swallowed here rather than thrown through the effect.
    }
  }, [activeRoute]);

  // `routeById` raises `RouteError` on an id the table does not hold, which cannot
  // happen for a `RouteId`: the heading text and the nav below read the table
  // rather than restating a label, so a renamed screen renames itself in the nav,
  // in the heading and in the suite's assertions at once. `??` rather than a
  // required prop, because a shell that cannot render alone cannot be tested here.
  const activeDefinition = routeById(activeRoute);
  const activeScreen = renderRoute(activeRoute, ordersRepository ?? EMPTY_ORDERS_REPOSITORY);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <section className="app-shell" aria-label="ระบบแคชเชียร์" data-testid="app-shell">
      <header className="app-shell__header">
        {/* THE PAGE'S `h1`, MARKING THE ACTIVE SCREEN. Each screen keeps its own
            heading underneath as a lower level, so the document has one top-level
            heading saying which screen is open, and the screens' own headings stop
            competing with it for the "what is this page" slot. */}
        <h1 className="app-shell__title">{activeDefinition.labelTh}</h1>

        {/* One button per entry in `ROUTE_DEFINITIONS`, in the table's own order —
            the nav is GENERATED, so a screen cannot exist without a way to reach
            it, and no second hand-written list can quietly disagree with the table.
            `aria-current="page"` on the active one: that is what tells a screen
            reader — and a screenshot attached to a bug report — which of the till's
            screens is open, which is otherwise only knowable from a heading. */}
        <nav className="app-shell__nav" aria-label="เมนูหลัก">
          {ROUTE_DEFINITIONS.map((definition) => {
            const isActive = definition.id === activeRoute;
            return (
              <button
                key={definition.id}
                type="button"
                className="app-shell__nav-item"
                aria-current={isActive ? 'page' : undefined}
                title={definition.description}
                onClick={() => {
                  setActiveRoute(definition.id);
                }}
              >
                {definition.labelTh}
              </button>
            );
          })}
        </nav>
      </header>

      {/* The screen, and nothing else. The shell adds no toolbar, no banner and no
          data of its own to what the screen renders: a cashier's next tap has to
          reach the same controls it reached before the shell existed. */}
      <div className="app-shell__screen">{activeScreen}</div>
    </section>
  );
}

export default AppShell;
