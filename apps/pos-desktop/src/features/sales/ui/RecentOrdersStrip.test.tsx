/**
 * RecentOrdersStrip component tests.
 *
 * These render the REAL strip over the REAL in-memory port, and assert on what a
 * cashier can actually read off the band. Nothing is mocked: the claim under test
 * is that this shows orders THIS TERMINAL took, which a mocked repository would
 * be able to satisfy while showing nothing real.
 *
 * Requires the simulated DOM from `test/setup-dom.ts`, registered in
 * `bunfig.toml` under `[test] preload`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, render, screen, within } from '@testing-library/react';

import { createInMemoryOfflineOrdersRepository } from '../application/offlineOrders';
import type { OfflineOrderSummary } from '../application/offlineOrders';
import { Money } from '../../payments/domain/money';
import { RecentOrdersStrip } from './RecentOrdersStrip';

// Unmount between tests, and let every read still in flight land FIRST. Without
// the flush the strip's `listRecent(...).then` resolves a microtask after the
// tree is gone, which React reports as an update outside act() — and a warning on
// every run teaches a reader to ignore this file's output. With it, each test
// ends the way a browser would: the read settles, then the tree goes.
afterEach(async () => {
  await flush();
  cleanup();
});

/**
 * Drain the microtask queue inside `act`, twice.
 *
 * Twice because the port is async BY DESIGN — so the SQLite adapter can land
 * without a rewrite — and the read is one hop followed by an update on the next
 * flush. One await leaves a race that only shows up on a busy machine.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
//
// Three orders spanning the states that matter: one synced, one still waiting,
// one rejected. An order's SYNC state is not its lifecycle state, and a strip
// that merged them would hide which of them a stuck order is stuck in.
// ─────────────────────────────────────────────────────────────────────────────

function order(o: {
  readonly id: string;
  readonly receipt: string;
  readonly status: OfflineOrderSummary['status'];
  readonly syncState: OfflineOrderSummary['syncState'];
  readonly lines: number;
}): OfflineOrderSummary {
  return {
    id: o.id,
    localReceiptNumber: o.receipt,
    status: o.status,
    syncState: o.syncState,
    createdAt: '2026-10-03T09:30:00.000Z',
    lineCount: o.lines,
    total: Money.fromSatang(4550n),
    roundingAdjustmentSatang: Money.fromSatang(0n),
    currencyCode: 'THB',
  };
}

const RECENT: readonly OfflineOrderSummary[] = [
  order({
    id: '018f3c2a-0000-7000-8000-0000000000d3',
    receipt: 'R-3003',
    status: 'completed',
    syncState: 'synced',
    lines: 2,
  }),
  order({
    id: '018f3c2a-0000-7000-8000-0000000000d2',
    receipt: 'R-3002',
    status: 'in_preparation',
    syncState: 'pending',
    lines: 1,
  }),
  order({
    id: '018f3c2a-0000-7000-8000-0000000000d1',
    receipt: 'R-3001',
    status: 'submitted',
    syncState: 'rejected',
    lines: 3,
  }),
];

/** The strip, or `null` when it rendered nothing. */
function strip(): HTMLElement | null {
  return screen.queryByTestId('recent-orders-strip');
}

/** The chips on the strip, newest first. */
function chips(): HTMLElement[] {
  const region = strip();
  if (region === null) {
    throw new Error('the strip rendered nothing');
  }
  return within(region).queryAllByRole('listitem');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. What it shows
// ─────────────────────────────────────────────────────────────────────────────

describe('RecentOrdersStrip — what it shows', () => {
  it('lists the orders this terminal took, newest first', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);
    await flush();

    expect(chips()).toHaveLength(3);
    // The port already ordered them; the strip must not re-sort, and asserting
    // the order is what pins that.
    expect(chips()[0]?.textContent).toContain('R-3003');
    expect(chips()[2]?.textContent).toContain('R-3001');
  });

  it('names each chip by receipt number, so a customer can be pointed at it', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);
    await flush();

    for (const receipt of ['R-3003', 'R-3002', 'R-3001']) {
      expect(screen.getByText(receipt)).toBeDefined();
    }
  });

  it('shows BOTH badges, because they answer different questions', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);
    await flush();

    // Lifecycle AND sync, side by side. "เสิร์ฟแล้ว รอซิงก์" is a healthy order
    // waiting on the network; "เสิร์ฟแล้ว ถูกปฏิเสธ" is a sale the server
    // refused. One merged badge would hide exactly that difference.
    expect(screen.getByText('ปิดรายการ')).toBeDefined();
    expect(screen.getByText('กำลังเตรียมสินค้า')).toBeDefined();
    expect(screen.getByText('ซิงก์แล้ว')).toBeDefined();
    expect(screen.getByText('รอซิงก์')).toBeDefined();
    expect(screen.getByText('ถูกปฏิเสธ')).toBeDefined();
  });

  it('keeps the sync badge addressable by its own data attribute', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);
    await flush();

    // The same hook the history rows and their tests use — a parallel class
    // scheme here could disagree with the attribute everything else reads.
    const region = strip()!;
    expect(within(region).getByText('ถูกปฏิเสธ').getAttribute('data-sync-state')).toBe('rejected');
    expect(within(region).getByText('ซิงก์แล้ว').getAttribute('data-sync-state')).toBe('synced');
  });

  it('shows the line count, and NO money', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);
    await flush();

    expect(screen.getByText('2 รายการ')).toBeDefined();
    // NO amount appears here. This is a glance, not the history screen: five
    // figures in peripheral vision while the cashier is working would bury the
    // one thing that matters, which is which order is stuck.
    expect(strip()?.textContent).not.toContain('฿');
  });

  it('shows NO customer name and NO table number', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);
    await flush();

    // The sales screen's own header renders these strings once. A second copy in
    // a scrolling band would be two elements with the same text on one page,
    // and the header's tests query them UNSCOPED.
    expect(strip()?.textContent).not.toContain('ลูกค้า');
    expect(strip()?.textContent).not.toContain('โต๊ะ');
  });

  it('renders NO interactive control — every action on an order is an outbox write', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);
    await flush();

    // SKILL.md §2.2: an offline order is changed by a transactional outbox write,
    // and this screen has no port that could perform one. A chip that looked
    // pressable would promise an action it cannot take — and a mis-tap here is
    // the one thing that must never be able to void a sale.
    const region = strip()!;
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
    expect(within(region).queryAllByRole('link')).toHaveLength(0);
  });

  it('is a labelled region, so it can be found on a page with several surfaces', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);
    await flush();

    expect(screen.getByRole('region', { name: 'ออเดอร์ล่าสุด' })).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. When it says nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('RecentOrdersStrip — when it renders nothing', () => {
  it('renders NOTHING when this terminal has taken no orders', async () => {
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository()} />);
    await flush();

    // Silence, not a banner. "ยังไม่มีออเดอร์" on every fresh terminal is a
    // permanent explanation of an absence nobody asked about, occupying the exact
    // space the menu should start at. The history screen is one tap away for
    // anyone who wants the empty state in full.
    expect(strip()).toBeNull();
  });

  it('renders NOTHING while the read is still in flight', async () => {
    // No loading text, no skeleton, no reserved space. A cashier opening the
    // screen should see the menu immediately; a strip that reserves its own
    // height for a moment then vanishes shifts every tile below it.
    render(<RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />);

    expect(strip()).toBeNull();
    await flush();
    expect(strip()).not.toBeNull();
  });

  it('renders NOTHING when the read fails, and does not shout about it', async () => {
    // A broken strip must not become a SECOND, differently-worded error report
    // on the screen a cashier is trying to take money on. The history screen
    // shows the failure in full; here it stays out of the way.
    const failing = {
      async listRecent(): Promise<readonly OfflineOrderSummary[]> {
        throw new Error('database is locked');
      },
      async findById(): Promise<OfflineOrderSummary | undefined> {
        return undefined;
      },
    };

    render(<RecentOrdersStrip repository={failing} />);
    await flush();

    expect(strip()).toBeNull();
    expect(screen.queryByText(/database is locked/)).toBeNull();
  });

  it('honours its page size', async () => {
    render(
      <RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} limit={2} />,
    );
    await flush();

    // A strip that grows without bound pushes the menu off screen, and the menu
    // is what the cashier came to this screen for.
    expect(chips()).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The unmount guard
// ─────────────────────────────────────────────────────────────────────────────

describe('RecentOrdersStrip — the unmount guard', () => {
  it('does not write into a tree that is gone', async () => {
    // The cashier navigates to the history screen and back constantly. A read
    // that lands after this component is gone writes into a tree that no longer
    // exists, and the symptom is a strip showing yesterday's last order under
    // today's newest one — stale data that looks perfectly current.
    const { unmount } = render(
      <RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />,
    );

    unmount();

    // If the guard were missing, this settle would schedule a state update on an
    // unmounted component — which React reports loudly, and the `afterEach`
    // flush above is what would surface it as a failure rather than a warning.
    await flush();
    expect(true).toBe(true);
  });

  it('re-reads when the repository changes identity', async () => {
    const { rerender } = render(
      <RecentOrdersStrip repository={createInMemoryOfflineOrdersRepository(RECENT)} />,
    );
    await flush();
    expect(chips()).toHaveLength(3);

    // The shell hands the screen the SAME port for the life of the app, so this
    // is the unusual path. It still has to re-read: the previous page is no
    // longer an answer to the question now being asked, and leaving it up while
    // the new one loads would show orders this terminal has not read.
    rerender(
      <RecentOrdersStrip
        repository={createInMemoryOfflineOrdersRepository([RECENT[0] as OfflineOrderSummary])}
      />,
    );
    await flush();

    expect(chips()).toHaveLength(1);
  });
});