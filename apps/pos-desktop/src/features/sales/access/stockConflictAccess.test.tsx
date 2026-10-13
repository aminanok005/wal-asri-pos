import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';

import {
  StockConflictAccessProvider,
  useCanResolveStockConflict,
} from './stockConflictAccess';

/**
 * stockConflictAccess tests.
 *
 * LAYER: access. The claim under test is the DEFAULT and the ONLY override: with
 * no provider the answer is `false` (deny) — a cashier can never resolve — and
 * only an explicit `canResolve` grant flips it. There is no env var, flag, or
 * query parameter that turns it on, so there is nothing here to test but the
 * seam itself.
 */

/** A tiny probe that renders the boolean as text so a test can read it. */
function Probe() {
  const canResolve = useCanResolveStockConflict();
  return <span data-testid="probe">{canResolve ? 'yes' : 'no'}</span>;
}

describe('useCanResolveStockConflict', () => {
  afterEach(() => {
    cleanup();
  });

  it('defaults to deny (false) with no provider — a cashier cannot resolve', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('no');
  });

  it('is false under a provider that denies', () => {
    render(
      <StockConflictAccessProvider canResolve={false}>
        <Probe />
      </StockConflictAccessProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('no');
  });

  it('is true only under a provider that grants (a real manager role)', () => {
    render(
      <StockConflictAccessProvider canResolve>
        <Probe />
      </StockConflictAccessProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('yes');
  });
});
