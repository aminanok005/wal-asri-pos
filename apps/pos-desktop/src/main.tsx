/**
 * main.tsx — the native entry point. It mounts the shell and then stops.
 *
 * ── What this file is ────────────────────────────────────────────────────────
 * The smallest file in the app, on purpose. It does three things: find the
 * `#root` element that `index.html` declares, create a React root on it, and
 * render `<AppShell />`. There is no business logic here on purpose — no money
 * arithmetic, no catalog seeding, no cart wiring, no `fetch`, no `@tauri-apps/*`
 * import. A till's boot path should be boring enough to read in one sitting.
 *
 * ── Why there is no router in this file ──────────────────────────────────────
 * BECAUSE ROUTING IS NOT THE ENTRY POINT'S JOB. `app/routes.ts` is the route
 * table — what the screens are called, what order they appear in, and which URL
 * fragment addresses each one — and `app/AppShell.tsx` is the only thing that
 * reads it. `AppShell` reads the fragment itself on mount and writes it on every
 * navigation, so a deep link into a screen needs nothing from this file. Adding
 * a router here would mean two sources of truth: the router's own history and
 * the shell's `activeRoute`. See the `TODO(ROUTER)` note at the top of
 * `routes.ts` for when that trade is actually worth making.
 *
 * ── Why `<AppShell />` is mounted with no props ───────────────────────────────
 * Both of `AppShell`'s props are optional and both have deliberate defaults:
 * `initialRoute` falls back to the URL fragment and then to the sales screen,
 * and `ordersRepository` falls back to a single module-level in-memory port
 * with no rows behind it. So a bare mount is a COMPLETE, RUNNABLE terminal —
 * it opens on the sales screen with an empty cart and an empty order history.
 * That is what makes this file honest: what you read here is what the till does
 * today, not a stub that only works once a missing adapter lands.
 *
 * ── Where the SQLite adapter goes ────────────────────────────────────────────
 * WHEN THE SQLCIPHER-BACKED `OfflineOrdersRepository` LANDS, it is passed HERE,
 * and nowhere else:
 *
 *     createRoot(container).render(
 *       <StrictMode>
 *         <AppShell ordersRepository={createSqlOfflineOrdersRepository()} />
 *       </StrictMode>,
 *     );
 *
 * It is deliberately NOT constructed here yet, and deliberately not mocked
 * behind a global: a native adapter that cannot open a database should fail at
 * the point of use with a real error, not degrade into a silently empty history
 * that a cashier would read as "I sold nothing today". Until then the in-memory
 * port is an honest stand-in and the history screen is visibly empty.
 *
 * ── Why StrictMode ───────────────────────────────────────────────────────────
 * React's StrictMode double-invokes effects in development to surface
 * impure effects and stale-closure bugs. `AppShell` is written to survive that
 * (`window.location.hash` writes are wrapped, and the empty repository is built
 * once at module scope), and shipping StrictMode is what keeps it that way —
 * a double-mount bug discovered before release costs nothing; discovered on a
 * till mid-shift, it costs a queue.
 *
 * @see ./app/AppShell.tsx — the component this file mounts
 * @see ./app/routes.ts — the route table; the shell reads the fragment itself
 * @see ../index.html — the `#root` element, and why it carries no inline script
 */

// ─────────────────────────────────────────────────────────────────────────────
// Imports
//
// All three are VALUE imports — `StrictMode` and `createRoot` are called, and
// `AppShell` is a component. Nothing here is a type, so `verbatimModuleSyntax`
// (on repo-wide) is satisfied without a single `import type`.
// ─────────────────────────────────────────────────────────────────────────────

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppShell } from './app/AppShell';

// ─────────────────────────────────────────────────────────────────────────────
// The mount
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The element `index.html` declares. Named to match the id exactly, because the
 * whole lookup is by that string.
 */
const ROOT_ELEMENT_ID = 'root';

/**
 * WHY A MISSING ROOT THROWS INSTEAD OF RETURNING QUIETLY
 *
 * The two possible failure modes here are not comparable. Throwing stops the
 * boot with a message that names the element, and a dev watching the terminal's
 * console sees exactly which id is wrong. Returning quietly renders nothing at
 * all: the webview shows a blank white window, the till looks powered on, the
 * cashier taps a screen that is not there, and NOTHING anywhere says why — no
 * error, no log, no stack. A blank till in a cafe in Chiang Mai with a queue
 * building is the worst outcome available to this code, and it is reachable
 * from a single missing or renamed id. So the check is loud.
 */
const container = document.getElementById(ROOT_ELEMENT_ID);

if (container === null) {
  throw new Error(
    `main.tsx: no element with id "${ROOT_ELEMENT_ID}" in the document. ` +
      'index.html must declare <div id="root"></div> before this module runs.',
  );
}

/**
 * `createRoot(...).render(...)` rather than the legacy `ReactDOM.render`: the
 * legacy entry point is removed in React 19 and would warn loudly on every
 * boot if it were still reachable.
 *
 * The `root` handle is deliberately not kept in a module-level variable. It is
 * only needed for the two escape hatches React exposes — `root.unmount()` to
 * tear the tree down, and `root.hydrate` to adopt server markup — and NEITHER
 * HAS A CALLER IN THIS APP. Hoisting a handle nothing reads would be state to
 * reason about for the life of the file, and the GC will collect the root when
 * the document goes away, exactly like every other root React creates.
 */
createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
