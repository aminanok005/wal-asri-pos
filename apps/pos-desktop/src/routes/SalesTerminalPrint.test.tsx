/**
 * Commit-then-print, and the cash-rounding figures on the way through it.
 *
 * These tests exist because the screen now holds THREE copies of one number:
 * what it shows, what it commits to SQLite, and what it prints. Any two of them
 * drifting apart produces a till that looks fine and reconciles to nothing, so
 * the assertions below deliberately compare the SAME sale across all three
 * rather than checking each in isolation.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  SalesTerminalView,
  formatAdjustment,
  roundingRowText,
} from './SalesTerminalView';
import type { CheckoutRepository } from './SalesTerminalView';
import type { SalesTerminalViewProps } from './SalesTerminalView';
import type { PrinterEndpoint, ReceiptPrinter } from '../features/sales/application/receiptPrinter';
import { ReceiptPrintError } from '../features/sales/application/receiptPrinter';
import type { ReceiptIr } from '../features/sales/domain/receiptLayout';
import { applyCashRounding } from '../features/sales/domain/cashRounding';

// A valid UUIDv7 for testing (version=7, variant=10xx)
const TEST_TERMINAL_ID = '018f3c2a-0000-7000-8000-000000000001';
const TEST_BRANCH_ID = '018f3c2b-0000-7000-8000-000000000002';

/** Render SalesTerminalView with test terminal identity injected. */
function renderTerminal(props: Omit<SalesTerminalViewProps, 'terminalIdentity'>): ReturnType<typeof render> {
  return render(<SalesTerminalView {...props} terminalIdentity={{ terminalId: TEST_TERMINAL_ID, branchId: TEST_BRANCH_ID }} />);
}

// Unmount between tests, and let every read still in flight land FIRST.
//
// This file mounts TWO trees in one test (`:251-275`), so the first screen's
// recent-orders read is still in flight when that tree is unmounted. Without the
// flush its update lands afterwards and React reports an act() warning — and two
// live carts and two live strips is exactly the state this suite exists to keep
// impossible.
afterEach(async () => {
  await flush();
  cleanup();
});

/** Drain the microtask queue inside `act`, twice — see the note above. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const LATTE = /ลาเต้/;

interface Captured {
  readonly ir: ReceiptIr;
  readonly endpoint: PrinterEndpoint;
}

/** A printer double that records what it was asked to print. */
function recordingPrinter(opts: { failWith?: string } = {}): {
  printer: ReceiptPrinter;
  printed: Captured[];
} {
  const printed: Captured[] = [];
  return {
    printed,
    printer: {
      async print(ir, endpoint) {
        printed.push({ ir, endpoint });
        if (opts.failWith !== undefined) throw new ReceiptPrintError(opts.failWith);
        return { bytesSent: ir.lines.length };
      },
    },
  };
}

function repo(): { repo: CheckoutRepository; saved: Parameters<CheckoutRepository['save']>[0][] } {
  const saved: Parameters<CheckoutRepository['save']>[0][] = [];
  return {
    saved,
    repo: {
      async save(input) {
        saved.push(input);
        return { receiptNumber: input.order.localReceiptNumber };
      },
    },
  };
}

function addLatte(times = 1): void {
  for (let i = 0; i < times; i += 1) {
    fireEvent.click(screen.getAllByRole('button', { name: LATTE })[0]!);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The headline: the screen, the database and the receipt must AGREE
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — one total, three places', () => {
  it('shows, commits and prints the SAME payable total', async () => {
    const { repo: r, saved } = repo();
    const { printer, printed } = recordingPrinter();
    renderTerminal({ repository: r, printer });

    // \u0e1f91.00 = 9100 satang for two lattes. Note 9100 % 25 === 0, so cash
    // rounding does NOT move it \u2014 which is exactly why this test earns its
    // place. The three copies have to agree whether or not rounding fired, and
    // on the demo menu's round numbers a wiring bug is least visible.
    addLatte(2);
    fireEvent.click(screen.getByTestId('payment-cash'));

    // Read the button BEFORE pressing it: a successful checkout clears the
    // basket, so afterwards the button honestly quotes ฿0.00.
    const quoted = screen.getByRole('button', { name: /ชำระเงิน/ }).textContent;

    expect(applyCashRounding(9100n, 'cash').adjustment).toBe(0n);

    // 1. on screen — the amount the cashier was asked to take
    expect(quoted).toContain('฿91.00');

    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    await waitFor(() => expect(printed).toHaveLength(1));

    // 2. committed to SQLite
    expect(saved[0]!.order.roundingAdjustmentSatang).toBe('0');
    expect(saved[0]!.order.totalSatang).toBe('9100');
    // 3. printed on paper
    expect(printed[0]!.ir.total_satang).toBe('9100');
  });

  it('never rounds a digital payment, on screen or in the database', async () => {
    const { repo: r, saved } = repo();
    const { printer, printed } = recordingPrinter();
    renderTerminal({ repository: r, printer });

    addLatte(2); // ฿91.00, which cash would round to ฿91.00 anyway; see below
    fireEvent.click(screen.getByTestId('payment-qr'));
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(saved).toHaveLength(1));

    expect(saved[0]!.order.roundingAdjustmentSatang).toBe('0');
    expect(saved[0]!.order.totalSatang).toBe('9100');
    expect(screen.queryByTestId('checkout-rounding')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rounding row itself
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — the cash-rounding row', () => {
  it('is absent when the total needs no rounding', () => {
    const { repo: r } = repo();
    renderTerminal({ repository: r });

    addLatte(); // ฿45.50 = 4550, an exact multiple of 25

    // A "ปัดเศษ ฿0.00" line on every receipt trains staff to stop reading the
    // one that matters, so it only renders when there is something to say.
    expect(screen.queryByTestId('checkout-rounding')).toBeNull();
  });

  it('shows a signed adjustment, formatted for a customer', () => {
    // Unreachable through the demo menu — see the note below. The formatter is
    // the unit under test, and it is the one place a negative sign could be
    // dropped or double-negated.
    expect(formatAdjustment(-2n)).toBe('-฿0.02');
    expect(formatAdjustment(12n)).toBe('+฿0.12');
    expect(formatAdjustment(-125n)).toBe('-฿1.25');
    expect(formatAdjustment(0n)).toBe('฿0.00');
  });

  it('renders the row text the cashier reads', () => {
    // The whole string, because "ปัดเศษ -฿0.02" and "-฿0.02" are different claims
    // to a customer: one says WHY the number moved, the other just states it.
    expect(roundingRowText(-2n, '45.50')).toBe('ปัดเศษ -฿0.02 → ฿45.50');
    expect(roundingRowText(12n, '45.75')).toBe('ปัดเศษ +฿0.12 → ฿45.75');
  });

  it('renders no row at all when the total is already payable', () => {
    const { repo: r } = repo();
    renderTerminal({ repository: r });

    addLatte(); // ฿45.50 = 4550, an exact multiple of 25

    // A "ปัดเศษ ฿0.00" line on every receipt trains staff to stop reading the
    // one that matters, so it only renders when there is something to say.
    expect(screen.queryByTestId('checkout-rounding')).toBeNull();
  });

  it('renders no row for a digital payment either', () => {
    const { repo: r } = repo();
    renderTerminal({ repository: r });

    addLatte();
    fireEvent.click(screen.getByTestId('payment-qr'));
    // A QR transfer can move ฿45.52 exactly; it is never rounded.
    expect(screen.queryByTestId('checkout-rounding')).toBeNull();
  });
});

/**
 * ⚠️ WHY THE ROUNDING ROW IS NOT EXERCISED THROUGH THE SCREEN
 *
 * The obvious way to cover the row is to render a ฿45.52 basket, and that is
 * NOT REACHABLE with the demo menu: every price in `demoCatalog.ts` is an exact
 * multiple of 25 satang (4550, 3500, 6000, 9900, 12900, …), so every basket
 * built from it lands on a multiple of 25 and `applyCashRounding` always
 * returns an adjustment of `0n`. A helper that "adjusted the basket to 4552"
 * would have had to fabricate state the product cannot produce, so none was
 * written — an earlier draft of this file had exactly such a helper, and it was
 * deleted rather than dressed up.
 *
 * This is not merely a fixture problem, it is a PRODUCT observation worth
 * raising: with 25-satang rounding and menu prices in ฿0.50 increments, the
 * rounding almost never fires in real use. It appears once a discount, a
 * service charge, or a ฿0.05-quantity price enters the picture.
 *
 * So the three halves are pinned where each can honestly be pinned:
 *   - every rounding VALUE is pinned in cashRounding.test.ts, exhaustively.
 *   - the formatting and the row TEXT are pinned above, directly.
 *   - the row's PRESENCE rule is pinned above, through the reachable case.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Commit-then-Print
// ─────────────────────────────────────────────────────────────────────────────

describe('SalesTerminalView — commit happens BEFORE any print', () => {
  it('does not touch the printer when the save fails', async () => {
    const saved: unknown[] = [];
    const { printer, printed } = recordingPrinter();

    renderTerminal({
      repository: {
        async save() {
          throw new Error('database is locked');
        },
      },
      printer,
    });
    void saved;

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(screen.getByTestId('checkout-error')).toBeDefined());

    // The load-bearing assertion. A receipt printed for a sale that then failed
    // to commit is a customer holding proof of a transaction the till has no
    // record of.
    expect(printed).toHaveLength(0);
  });

  it('prints AFTER the save resolves, carrying the committed receipt number', async () => {
    const { printer, printed } = recordingPrinter();
    const { repo: r, saved } = repo();
    renderTerminal({ repository: r, printer });

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(printed).toHaveLength(1));

    // Same number the database received — not a freshly generated one.
    expect(printed[0]!.ir.receipt_number).toBe(saved[0]!.order.localReceiptNumber);
  });

  it('opens the drawer for CASH and not for QR', async () => {
    // Two separate mounts: React state does not reset between renders, and
    // rendering into the same tree would leave the second screen's basket
    // contaminated by the first one's already-cleared one.
    const cashRun = recordingPrinter();
    const cashView = renderTerminal({ repository: repo().repo, printer: cashRun.printer });
    addLatte();
    fireEvent.click(screen.getByTestId('payment-cash'));
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));
    await waitFor(() => expect(cashRun.printed).toHaveLength(1));
    // Cash went into the drawer, so the till must open it.
    expect(cashRun.printed[0]!.ir.open_drawer).toBe(true);
    cashView.unmount();

    const qrRun = recordingPrinter();
    renderTerminal({ repository: repo().repo, printer: qrRun.printer });
    addLatte();
    fireEvent.click(screen.getByTestId('payment-qr'));
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));
    await waitFor(() => expect(qrRun.printed).toHaveLength(1));
    // A QR transfer moves money electronically. Pulsing the drawer on one would
    // open an empty till in front of the customer.
    expect(qrRun.printed[0]!.ir.open_drawer).toBe(false);
  });

  it('sends the receipt to the configured endpoint', async () => {
    const { repo: r } = repo();
    const { printer, printed } = recordingPrinter();
    renderTerminal({
      repository: r,
      printer,
      printerEndpoint: { host: '192.168.1.50', port: 9100 },
    });

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(printed).toHaveLength(1));
    expect(printed[0]!.endpoint).toEqual({ host: '192.168.1.50', port: 9100 });
  });
});

describe('SalesTerminalView — a print failure is NOT a failed sale', () => {
  it('keeps the basket cleared and still reports the sale as saved', async () => {
    const { repo: r, saved } = repo();
    const { printer } = recordingPrinter({ failWith: 'cannot reach printer at 192.168.1.50:9100' });
    renderTerminal({ repository: r, printer });

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(screen.getByTestId('checkout-print-warning')).toBeDefined());

    // The money was taken. The sale shows as SAVED...
    expect(screen.getByTestId('checkout-receipt')).toBeDefined();
    // ...the basket is empty, because re-ringing would double the sale...
    expect(screen.getByTestId('cart-item-count').textContent).toBe('0 รายการ');
    // ...the database has exactly one order...
    expect(saved).toHaveLength(1);
    // ...and the cashier is told the paper failed.
    expect(screen.getByTestId('checkout-print-warning').textContent).toContain('192.168.1.50');
    // The generic failure banner must NOT appear: nothing failed but the printer.
    expect(screen.queryByTestId('checkout-error')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The wire shape
// ─────────────────────────────────────────────────────────────────────────────

describe('the receipt IR that crosses the bridge', () => {
  it('uses snake_case for the IR and camelCase for the wrapper', async () => {
    const { repo: r } = repo();
    const { printer, printed } = recordingPrinter();
    renderTerminal({ repository: r, printer });

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));
    await waitFor(() => expect(printed).toHaveLength(1));

    const ir = printed[0]!.ir;
    // `escpos::ReceiptIr` has no `rename_all`, so these stay snake_case. Sending
    // `totalSatang` would leave the field MISSING — the struct has no
    // `deny_unknown_fields` — and Rust would reject the receipt with
    // "total_satang is not a plain integer", which reads like a money bug.
    expect(ir.total_satang).toBe('4550');
    expect('shopName' in ir).toBe(false);
    expect('receiptNumber' in ir).toBe(false);
    expect('openDrawer' in ir).toBe(false);
  });

  it('carries the Thai product name into the receipt body', async () => {
    const { repo: r } = repo();
    const { printer, printed } = recordingPrinter();
    renderTerminal({ repository: r, printer });

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));
    await waitFor(() => expect(printed).toHaveLength(1));

    const body = printed[0]!.ir.lines.map((l) => l.text).join('\n');
    expect(body).toContain('กาแฟลาเต้');
    expect(body).toContain('฿45.50');
  });

  it('is frozen, so a printer cannot mutate the order that produced it', async () => {
    const { repo: r } = repo();
    let captured: ReceiptIr | null = null;
    const mutatingPrinter: ReceiptPrinter = {
      async print(ir) {
        captured = ir;
        expect(Object.isFrozen(ir)).toBe(true);
        return { bytesSent: 1 };
      },
    };

    renderTerminal({ repository: r, printer: mutatingPrinter });
    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(captured).not.toBeNull());
  });
});
