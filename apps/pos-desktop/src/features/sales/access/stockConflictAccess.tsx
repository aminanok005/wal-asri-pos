/**
 * Stock-conflict access — the ONE seam between "who is at the till" and "who
 * may resolve a stock conflict".
 *
 * LAYER: access. It is deliberately the narrowest possible seam: a single
 * boolean, `useCanResolveStockConflict()`, and a single provider used ONLY to
 * inject that boolean in tests. There is no login screen, no user store, no
 * role enum, no permission table here — none of that exists in this app yet,
 * and inventing one is explicitly out of scope for this lane.
 *
 * ── WHY DEFAULT IS `false` (DENY) ───────────────────────────────────────────
 * A cashier must NEVER be able to resolve a stock conflict. The safe failure
 * of a not-yet-wired permission is therefore "cannot resolve": the worst case
 * is a manager has to resolve at the console, which is recoverable. The
 * opposite default — "everyone can resolve" — would let any till overwrite a
 * stock balance, which is not. So the production default denies, and the UI
 * shows every user a banner; only a caller that has wrapped the tree in
 * `StockConflictAccessProvider` with `canResolve` gets the resolve button.
 *
 * ── WHY A PROVIDER AND NOT A PROP DRILLED THROUGH EVERY SCREEN ─────────────
 * The boolean is read by the overlay, the banner, and the terminal screen —
 * three places at different depths. A provider is the app's existing idiom for
 * exactly this (see `AppShell`), and it is what lets a test grant the
 * permission for one render without touching any production default. There is
 * NO flag, NO env var, and NO query parameter that turns this on in
 * production: the only way `canResolve` becomes true is a real role mechanism
 * being wired into the provider, which is tracked as a follow-up.
 *
 * ── WHERE THE REAL ROLE MUST BE WIRED ───────────────────────────────────────
 * See the report: there is no auth/role mechanism in `apps/pos-desktop/src`
 * today (only the device-level `get_terminal_identity`, which carries
 * terminalId/branchId and NO user identity). When one lands, it belongs at the
 * provider call site in `AppShell.tsx` — not here — so this file stays a
 * denial seam until then.
 */

import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

/**
 * The access context. `false` at the root, so anything rendered outside an
 * explicit provider (i.e. all of production today) cannot resolve.
 */
const StockConflictAccessContext = createContext<boolean>(false);

export interface StockConflictAccessProviderProps {
  /** `true` only when the current user is an admin/manager per a real role. */
  readonly canResolve: boolean;
  readonly children: ReactNode;
}

/**
 * Grants the resolve permission to a subtree. Used by tests to assert the
 * permission-gated UI, and — once a real role mechanism exists — by the app
 * shell to grant it to managers.
 */
export function StockConflictAccessProvider({
  canResolve,
  children,
}: StockConflictAccessProviderProps): ReactElement {
  return (
    <StockConflictAccessContext.Provider value={canResolve}>
      {children}
    </StockConflictAccessContext.Provider>
  );
}

/**
 * Whether the current user may resolve a stock conflict. `false` everywhere a
 * provider has not granted it, which is every production path until a real
 * role mechanism is wired in. A cashier therefore always sees the banner and
 * never the resolve button.
 */
export function useCanResolveStockConflict(): boolean {
  return useContext(StockConflictAccessContext);
}
