/**
 * The printer edge: the wire mapping, and the refusal to trust the response.
 *
 * The Tauri runtime is never loaded. `toPrintRequest` and `parseOutcome` are
 * exported precisely so the part that can be wrong — the shape — is verifiable
 * in a plain `bun test`. Only `createTauriReceiptPrinter` touches `invoke`, and
 * it is not called here.
 */

import { describe, expect, it } from 'bun:test';

import { ReceiptPrintError } from '../application/receiptPrinter';
import { createNullReceiptPrinter, type PrinterEndpoint } from '../application/receiptPrinter';
import type { ReceiptIr } from '../domain/receiptLayout';

const ir: ReceiptIr = Object.freeze({
  shop_name: 'ร้านวาลังอาซิ',
  receipt_number: 'R-0001',
  lines: Object.freeze([Object.freeze({ text: 'กาแฟ ×1', align: 'left' as const })]),
  total_satang: '4550',
  open_drawer: true,
});

const endpoint: PrinterEndpoint = Object.freeze({ host: '192.168.1.50', port: 9100 });

describe('the null printer', () => {
  it('refuses rather than pretending it printed', async () => {
    const printer = createNullReceiptPrinter();

    // A till with no printer configured must SAY SO. An adapter that returned
    // `{ bytesSent: 0 }` here would let the screen show a green "printed" for
    // a receipt that never existed.
    await expect(printer.print(ir, endpoint)).rejects.toThrow(ReceiptPrintError);
  });

  it('refuses a malformed total BEFORE any socket work', async () => {
    const printer = createNullReceiptPrinter();
    const bad = { ...ir, total_satang: '45.50' } as ReceiptIr;

    await expect(printer.print(bad, endpoint)).rejects.toThrow(/plain integer string/);
  });

  it('refuses an impossible port', async () => {
    const printer = createNullReceiptPrinter();

    for (const port of [0, -1, 70000, 1.5]) {
      await expect(printer.print(ir, { host: '127.0.0.1', port })).rejects.toThrow(
        /valid TCP port/,
      );
    }
  });
});

describe('the shape crossing the bridge', () => {
  it('wraps the receipt and the printer exactly as PrintRequest expects', async () => {
    const { toPrintRequest } = await import('./tauriReceiptPrinter');

    const request = toPrintRequest(ir, endpoint);

    // `PrintRequest` is `#[serde(rename_all = "camelCase", deny_unknown_fields)]`,
    // so the OUTER keys are camelCase AND an extra key would be a hard error.
    expect(Object.keys(request).sort()).toEqual(['printer', 'receipt']);
    expect(Object.keys(request.printer).sort()).toEqual(['host', 'port']);
  });

  it('keeps the inner receipt snake_case', async () => {
    const { toPrintRequest } = await import('./tauriReceiptPrinter');

    const request = toPrintRequest(ir, endpoint);

    // ⚠️ The trap. `ReceiptIr` has NO `rename_all` and NO
    // `deny_unknown_fields`, so a camelCase field would arrive MISSING and be
    // silently ignored rather than rejected — and Rust would then fail the whole
    // receipt with "total_satang is not a plain integer".
    expect(Object.keys(request.receipt).sort()).toEqual(
      ['lines', 'open_drawer', 'receipt_number', 'shop_name', 'total_satang'].sort(),
    );
    expect('totalSatang' in request.receipt).toBe(false);
  });

  it('never sends a satang value as a JSON number', async () => {
    const { toPrintRequest } = await import('./tauriReceiptPrinter');

    const request = toPrintRequest(ir, endpoint);
    const parsed = JSON.parse(JSON.stringify(request)) as {
      receipt: { total_satang: unknown };
    };

    expect(typeof parsed.receipt.total_satang).toBe('string');
  });

  it('is frozen, so the shape cannot be edited between mapping and sending', async () => {
    const { toPrintRequest } = await import('./tauriReceiptPrinter');

    const request = toPrintRequest(ir, endpoint);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.printer)).toBe(true);
  });
});
