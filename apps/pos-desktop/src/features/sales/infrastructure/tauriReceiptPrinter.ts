/**
 * Tauri adapter for the receipt-printer port.
 *
 * LAYER: infrastructure. Like `tauriOfflineOrders.ts`, this is the EDGE — the
 * one place in the sales feature allowed to know `@tauri-apps/api` exists.
 *
 * ── WHAT IT SENDS ────────────────────────────────────────────────────────────
 *
 * `invoke('print_receipt', { request })`, which Rust parses as
 * `printer_commands::PrintRequest`:
 *
 *     #[serde(rename_all = "camelCase", deny_unknown_fields)]
 *     pub struct PrintRequest { printer: TcpPrinterConfig, receipt: ReceiptIr }
 *
 * Two shape facts this file exists to get right:
 *
 *   1. The OUTER object is camelCase: `printer`, `receipt`. `TcpPrinterConfig`
 *      is camelCase too, but its fields are single words (`host`, `port`), so
 *      that distinction is invisible there.
 *   2. The INNER `receipt` is SNAKE_CASE. `escpos::ReceiptIr` carries no
 *      `rename_all`, so `shop_name`, `receipt_number` and `total_satang` keep
 *      their Rust names. Sending `totalSatang` would leave the field MISSING
 *      rather than rejected — `ReceiptIr` has no `deny_unknown_fields` — and
 *      Rust would then reject the receipt with "total_satang is not a plain
 *      integer", which reads like a money bug and is actually a casing bug.
 *
 * `toPrintRequest` is exported and tested separately so that mapping is
 * verifiable without a Tauri runtime, which is the whole point of an edge
 * layer: the dangerous code here is the shape, not the `invoke` call.
 *
 * @see ../application/receiptPrinter.ts — the port implemented below
 * @see ../../../../src-tauri/src/printer_commands.rs — the Rust side
 */

import { invoke } from '@tauri-apps/api/core';

import {
  ReceiptPrintError,
  type PrinterEndpoint,
  type PrintOutcome,
  type ReceiptPrinter,
} from '../application/receiptPrinter';
import type { ReceiptIr } from '../domain/receiptLayout';

/** The JSON Rust deserialises into `PrintRequest`. */
export interface PrintRequestWire {
  readonly printer: {
    readonly host: string;
    readonly port: number;
  };
  readonly receipt: ReceiptIr;
}

/** `SendOutcome` in printer_commands.rs — `bytes_sent`, camelCased by serde. */
interface PrintOutcomeWire {
  readonly bytesSent?: unknown;
}

/**
 * Build the wire request from domain values.
 *
 * Deliberately a pure function: it is the part that can be wrong in a way a
 * running app would only reveal at the till, and it needs a plain `bun test`.
 */
export function toPrintRequest(receipt: ReceiptIr, endpoint: PrinterEndpoint): PrintRequestWire {
  return Object.freeze({
    printer: Object.freeze({ host: endpoint.host, port: endpoint.port }),
    receipt,
  });
}

/**
 * Read Rust's response without asserting it.
 *
 * `invoke<T>` casts whatever came back to `T` WITHOUT CHECKING — a TypeScript
 * interface here would be documentation, not enforcement. The same reasoning as
 * `tauriOfflineOrders.ts`, which validates the wire independently because the
 * two sides can be at different versions during a rollout.
 */
function parseOutcome(value: unknown): PrintOutcome {
  const wire = (value ?? {}) as PrintOutcomeWire;

  if (typeof wire.bytesSent !== 'number' || !Number.isInteger(wire.bytesSent)) {
    throw new ReceiptPrintError(
      `print_receipt returned no usable byte count (received ${JSON.stringify(value)}); ` +
        'the receipt may not have been sent',
    );
  }

  return Object.freeze({ bytesSent: wire.bytesSent });
}

/**
 * The real adapter: compiles in Rust and writes to the printer over TCP.
 *
 * Every failure is funnelled into `ReceiptPrintError` so the screen has one
 * error type to handle. The distinction the UI cares about — fix the menu vs
 * check the cable — is carried in the MESSAGE, which Rust already phrases that
 * way (`printer_commands::PrinterErrorKind`).
 */
export function createTauriReceiptPrinter(): ReceiptPrinter {
  return {
    async print(receipt: ReceiptIr, endpoint: PrinterEndpoint): Promise<PrintOutcome> {
      let raw: unknown;
      try {
        raw = await invoke('print_receipt', { request: toPrintRequest(receipt, endpoint) });
      } catch (error) {
        throw new ReceiptPrintError(error instanceof Error ? error.message : String(error));
      }

      return parseOutcome(raw);
    },
  };
}
