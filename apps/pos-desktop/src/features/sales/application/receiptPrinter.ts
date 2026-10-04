/**
 * The port the UI prints receipts through.
 *
 * LAYER: application, between the domain and the native adapter. It must not
 * import React, `@tauri-apps/*`, or `bun:sqlite` — which is the entire reason
 * the interface exists.
 *
 * ── WHY A PORT, WHEN `OfflineOrdersRepository` ALREADY ESTABLISHED ONE ───────
 *
 * Same reason, same shape. A view that called `invoke('print_receipt')` itself
 * could not be rendered in a unit test without a native runtime, so the
 * commit-then-print lifecycle — the rule that a sale must reach SQLite before a
 * printer is touched — would only ever be verified by launching the desktop app
 * on a machine with a printer on the network.
 *
 * ── WHY `print` IS SEPARATE FROM `save` ──────────────────────────────────────
 *
 * Deliberately NOT a method on the orders repository. The two have different
 * failure semantics and must not share a call:
 *
 *   • `save` is a TRANSACTION. If it fails the sale did not happen, the basket
 *     must survive, and nothing may be printed.
 *   • `print` is a SIDE EFFECT that can fail on its own. The money is already
 *     committed at that point; a dead printer is not a reason to un-ring a sale
 *     that really did happen.
 *
 * Folding them into one method would force the caller to choose what to do when
 * the second half fails after the first succeeded, and there is no correct
 * answer — which is exactly why the rule is "commit first, then print, and treat
 * a print failure as a warning rather than a rollback".
 *
 * @see ./offlineOrders.ts — the sibling port, and the pattern copied here
 * @see ../infrastructure/tauriReceiptPrinter.ts — the adapter
 */

import type { ReceiptIr } from '../domain/receiptLayout';

/** Raised when a receipt could not be printed. Never a rollback signal. */
export class ReceiptPrintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptPrintError';
  }
}

/** Where the printer is. Mirrors `printer_port::TcpPrinterConfig`. */
export interface PrinterEndpoint {
  /** IPv4 or IPv6 literal. A hostname is refused by Rust — print by IP. */
  readonly host: string;
  /** Raw 9100 is conventional for ESC/POS over TCP. */
  readonly port: number;
}

/**
 * What the native layer reported.
 *
 * ⚠️ `bytesSent` is NOT proof that paper moved. ESC/POS has no acknowledgement
 * and no printer status query, so the Rust side cannot know either. This is
 * documented rather than hidden because a field called `printed` would invite
 * exactly the wrong assumption.
 */
export interface PrintOutcome {
  readonly bytesSent: number;
}

/** The capability the sales screen depends on. */
export interface ReceiptPrinter {
  /**
   * Compile and send one receipt.
   *
   * @throws {ReceiptPrintError} on a transport or encoding failure. Callers must
   *         treat this as advisory: the sale is already committed.
   */
  print(receipt: ReceiptIr, endpoint: PrinterEndpoint): Promise<PrintOutcome>;
}

/**
 * A printer that accepts everything and does nothing.
 *
 * The DEFAULT for the sales screen, and the reason the screen renders in a
 * plain `bun test`: a screen whose default adapter reached for `invoke` could
 * not be rendered without a native runtime, and every checkout test would have
 * to become an integration test.
 *
 * It is a real implementation of the port rather than a bare stub — it validates
 * its arguments, so a test that passes against it is testing behaviour. What it
 * deliberately does NOT do is silently swallow a printing failure: a till with
 * no printer configured says so in the UI instead of pretending it printed.
 */
export function createNullReceiptPrinter(
  reason = 'ไม่ได้ตั้งค่าเครื่องพิมพ์: ข้ามการพิมพ์ใบเสร็จ',
): ReceiptPrinter {
  return {
    async print(receipt: ReceiptIr, endpoint: PrinterEndpoint): Promise<PrintOutcome> {
      if (typeof receipt.total_satang !== 'string' || !/^[0-9]+$/.test(receipt.total_satang)) {
        throw new ReceiptPrintError(
          `refusing to print: total_satang must be a plain integer string, received ${JSON.stringify(receipt.total_satang)}`,
        );
      }
      if (!Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535) {
        throw new ReceiptPrintError(
          `refusing to print: printer port must be a valid TCP port, received ${String(endpoint.port)}`,
        );
      }
      throw new ReceiptPrintError(reason);
    },
  };
}
