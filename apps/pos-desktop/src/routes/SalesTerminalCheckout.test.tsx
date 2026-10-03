/**
 * The checkout path: pressing ชำระเงิน and what reaches the database.
 *
 * The screen renders and collects; the ADAPTER commits. These tests therefore
 * run the real screen against a recording double and assert on the PAYLOAD that
 * would have gone to `save_offline_order` — because the payload is where money
 * can go wrong, not in the click.
 *
 * What is deliberately NOT mocked: the screen, the cart domain, the tax
 * extraction, and the wire serialiser. A mocked VAT number would hide the exact
 * bug these tests exist to catch.
 *
 * The real Tauri adapter is never loaded: the screen takes a `repository` prop,
 * so `invoke` is never called and no native runtime is required.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SalesTerminalView } from './SalesTerminalView';
import type { CheckoutRepository } from './SalesTerminalView';
import type { SaveOfflineOrderInputWire } from '../features/sales/infrastructure/tauriOfflineOrders';

afterEach(() => {
  cleanup();
});

/** A tile's visible price, e.g. "฿45.50". */
const LATTE = /ลาเต้/;

/** One captured checkout payload, plus a way to make the save fail. */
function recordingRepository(): {
  repo: CheckoutRepository;
  saved: SaveOfflineOrderInputWire[];
  failWith: (message: string) => void;
} {
  const saved: SaveOfflineOrderInputWire[] = [];
  let failure: string | null = null;

  return {
    saved,
    failWith(message: string) {
      failure = message;
    },
    repo: {
      async save(input) {
        if (failure !== null) throw new Error(failure);
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

describe('SalesTerminalView — the checkout button', () => {
  it('is disabled on an empty basket', () => {
    const { repo } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    // An empty basket is not a sale. The button says so rather than pretending.
    expect(screen.getByRole('button', { name: /ชำระเงิน/ })).toHaveProperty('disabled', true);
  });

  it('enables once something is in the basket, and shows the total', () => {
    const { repo } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    addLatte();
    const button = screen.getByRole('button', { name: /ชำระเงิน/ });
    expect(button).toHaveProperty('disabled', false);
    expect(button.textContent).toContain('฿45.50');
  });

  it('shows the VAT breakdown, and the three numbers reconcile', () => {
    const { repo } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    addLatte();

    // VAT-INCLUSIVE: the customer is charged ฿45.50, of which ฿2.98 is VAT.
    expect(screen.getByTestId('checkout-subtotal').textContent).toBe('฿45.50');
    expect(screen.getByTestId('checkout-tax').textContent).toBe('฿2.98');
    expect(screen.getByTestId('checkout-net').textContent).toBe('฿42.52');

    // The invariant a customer is entitled to see: net + tax === gross.
    const gross = screen.getByTestId('checkout-subtotal').textContent!;
    const tax = screen.getByTestId('checkout-tax').textContent!;
    const net = screen.getByTestId('checkout-net').textContent!;
    expect(netToSatang(net) + netToSatang(tax)).toBe(netToSatang(gross));
  });
});

describe('SalesTerminalView — what reaches the database', () => {
  it('sends every satang field as a STRING', async () => {
    const { repo, saved } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const { order, lines } = saved[0]!;

    // This is the whole point of the adapter. A JSON number here loses
    // precision above 2^53 with no error at all.
    for (const [field, value] of Object.entries(order)) {
      if (field.toLowerCase().includes('satang')) {
        expect(typeof value).toBe('string');
      }
    }
    for (const line of lines) {
      expect(typeof line.unitPriceSatang).toBe('string');
      expect(typeof line.lineTotalSatang).toBe('string');
      expect(typeof line.lineTaxSatang).toBe('string');
    }
  });

  it('sends the VAT-INCLUSIVE split: gross 4550, net 4252, tax 298', async () => {
    const { repo, saved } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const { order } = saved[0]!;

    expect(order.subtotalSatang).toBe('4550');
    expect(order.taxableSatang).toBe('4252');
    expect(order.taxSatang).toBe('298');
    // NOT 4848: under inclusive pricing the tax is already inside the price.
    expect(order.totalSatang).toBe('4550');
    expect(order.serviceChargeSatang).toBe('0');
    expect(order.vatRateBp).toBe(700);
  });

  it('sends line_tax 0 on every line, because VAT is per order', async () => {
    const { repo, saved } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    addLatte(3);
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    // Three taps merge into ONE line at quantity 3, per the domain rule.
    expect(saved[0]!.lines).toHaveLength(1);
    expect(saved[0]!.lines[0]!.lineTaxSatang).toBe('0');
    expect(saved[0]!.lines[0]!.quantity).toBe('3');
    expect(saved[0]!.lines[0]!.lineTotalSatang).toBe('13650');
  });

  it('carries Thai product names across the wire intact', async () => {
    const { repo, saved } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.lines[0]!.nameTh).toBe('กาแฟลาเต้');
  });

  it('carries an outbox event, so the sale can sync later', async () => {
    const { repo, saved } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    addLatte();
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    // SKILL.md §2.2: the outbox row is what makes the sale syncable at all.
    expect(saved[0]!.outbox.idempotencyKey).toBeTruthy();
  });
});

describe('SalesTerminalView — the basket clears only after the sale is recorded', () => {
  it('empties the basket and shows the receipt on success', async () => {
    const { repo, saved } = recordingRepository();
    render(<SalesTerminalView repository={repo} />);

    addLatte(2);
    expect(screen.getByTestId('sales-item-count').textContent).toBe('2 รายการ');

    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('checkout-receipt')).toBeDefined());

    // Cleared because the transaction committed — not before.
    expect(screen.getByTestId('sales-item-count').textContent).toBe('0 รายการ');
  });

  it('KEEPS the basket and shows the error when the save fails', async () => {
    const { repo, failWith } = recordingRepository();
    failWith('SQLCipher: key rejected');
    render(<SalesTerminalView repository={repo} />);

    addLatte(2);
    fireEvent.click(screen.getByRole('button', { name: /ชำระเงิน/ }));

    // Nothing was committed, so the cashier still has the sale in front of them
    // to retry. Clearing here would lose an order the till has no record of.
    await waitFor(() => expect(screen.getByTestId('checkout-error')).toBeDefined());
    expect(screen.getByTestId('checkout-error').textContent).toContain('SQLCipher');
    expect(screen.getByTestId('sales-item-count').textContent).toBe('2 รายการ');
    expect(screen.queryByTestId('checkout-receipt')).toBeNull();
  });
});

/** "฿45.50" → 4550n, for the reconciliation assertion above. */
function netToSatang(text: string): bigint {
  return BigInt(text.replace(/^฿/, '').replace('.', ''));
}