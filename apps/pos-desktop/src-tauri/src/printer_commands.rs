//! The printer command surface: the only way the frontend causes paper.
//!
//! ── WHAT THIS IS ─────────────────────────────────────────────────────────────
//! One command, `print_receipt`, which takes a receipt IR, compiles it to ESC/POS
//! bytes and sends them over the LAN. Both halves are already tested in
//! isolation ([`crate::escpos`] and [`crate::printer_port`]); this file only
//! joins them, and its whole job is to make sure the join happens **off the UI
//! thread**.
//!
//! ── WHY `spawn_blocking`, AGAIN ───────────────────────────────────────────────
//! See `printer_port.rs`: `TcpStream::connect` is blocking, and against a dead
//! address it blocks for the OS default — potentially over a minute. Called
//! from an async command on a single-threaded executor that IS the UI thread, a
//! printer on the wrong IP freezes the till mid-sale. The compiler is fast and
//! could stay inline, but it is bundled into the same closure so there is one
//! blocking boundary and no chance of a future refactor accidentally moving the
//! compile back onto the UI thread.
//!
//! ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
//! No business rules. This module does not decide the total, does not decide
//! whether to round, and does not decide whether the drawer opens — the
//! TypeScript domain decides all of that and sends the finished IR, exactly as
//! `commands.rs` receives pre-computed money.

use serde::{Deserialize, Serialize};

use crate::escpos::{self, CompileError, ReceiptIr};
use crate::printer_port::{PrinterTransport, SendOutcome, TcpPrinterConfig, TcpPrinterTransport};

/// A printer failure, shaped for the wire.
///
/// Mirrors `commands::CommandError`: a stable machine-readable `kind` for the
/// frontend to branch on, and a `message` for a human. Same reasoning — a
/// frontend that pattern-matches on prose breaks when the prose is reworded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterError {
  pub kind: PrinterErrorKind,
  pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PrinterErrorKind {
  /// The receipt contained a character the printer's code page cannot represent.
  ///
  /// Distinct from a transport failure on purpose: nothing is wrong with the
  /// printer, and retrying will not help. Someone has to fix the menu text.
  UnmappableText,
  /// The receipt IR was not internally consistent (e.g. a malformed total).
  InvalidReceipt,
  /// The printer could not be reached, or the write failed.
  Transport,
}

impl From<CompileError> for PrinterError {
  fn from(e: CompileError) -> Self {
    match e {
      CompileError::Unmappable { line, source } => PrinterError {
        kind: PrinterErrorKind::UnmappableText,
        message: format!(
          "line {line}: character {:?} ({}) cannot be printed in the printer's code page",
          source.character, source.codepoint
        ),
      },
      CompileError::MalformedTotal { received } => PrinterError {
        kind: PrinterErrorKind::InvalidReceipt,
        message: format!("total_satang is not a plain integer: {received:?}"),
      },
      CompileError::TotalOverflow { received } => PrinterError {
        kind: PrinterErrorKind::InvalidReceipt,
        message: format!("total_satang is too large to render: {received}"),
      },
    }
  }
}

/// The request: a receipt plus where to send it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrintRequest {
  /// Where the printer is.
  pub printer: TcpPrinterConfig,
  /// What to print.
  pub receipt: ReceiptIr,
}

/// Compile a receipt and send it to the printer on the LAN.
///
/// Returns the byte count handed to the socket. ⚠️ This is NOT a confirmation
/// that paper moved — ESC/POS has no acknowledgement and this layer cannot know.
/// See `printer_port.rs`.
///
/// Errors are separated by kind so the UI can respond differently: an
/// `UnmappableText` is a menu-data bug that will recur on every attempt, while
/// a `Transport` error may well succeed on the next sale.
#[tauri::command]
pub async fn print_receipt(request: PrintRequest) -> Result<SendOutcome, PrinterError> {
  // Compile first, then send — but BOTH inside one blocking closure.
  //
  // `spawn_blocking` takes a SYNCHRONOUS closure, so the async `send_bytes`
  // cannot be awaited inside it. The blocking primitive is therefore
  // `TcpPrinterTransport::send`, called directly, and one blocking boundary
  // covers the compile and the socket work together. Sequencing them this way is
  // also what guarantees a receipt that cannot be encoded never opens a socket.
  let transport = TcpPrinterTransport::new(request.printer);

  tauri::async_runtime::spawn_blocking(move || {
    let bytes = escpos::compile(&request.receipt)?;
    let written = transport.send(&bytes).map_err(|e| PrinterError {
      kind: PrinterErrorKind::Transport,
      message: e.to_string(),
    })?;

    Ok(SendOutcome { bytes_sent: written })
  })
  .await
  .map_err(|e| PrinterError {
    kind: PrinterErrorKind::Transport,
    message: format!("printer worker did not finish: {e}"),
  })?
}

/// ── Pure functions, tested directly ──────────────────────────────────────────
///
/// The command body needs a live Tauri app to invoke, so what is proven here is
/// the error mapping — the part that decides whether a cashier is told "fix the
/// menu" or "check the cable".
#[cfg(test)]
mod tests {
  use std::net::SocketAddr;

  use super::*;

  // ── Loopback harness ────────────────────────────────────────────────────────
  //
  // `print_receipt` is the command Tauri actually invokes, and it takes no
  // `AppHandle` and no `State`, so it can be driven directly. Until these tests
  // existed, NOTHING exercised the assembled production path: `escpos::compile`
  // and `TcpPrinterTransport::send` were each tested alone, and this module
  // only tested error MAPPING. A bug in the wiring — the wrong receipt handed to
  // the compiler, the drawer flag dropped, the compile happening after the
  // connect instead of before — would have passed every other test in the crate.
  fn fake_printer() -> (SocketAddr, std::thread::JoinHandle<Vec<u8>>) {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");

    let handle = std::thread::spawn(move || {
      use std::io::Read;
      let (mut stream, _) = listener.accept().expect("accept");
      let mut buf = Vec::new();
      stream
        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
        .expect("read timeout");
      let _ = stream.read_to_end(&mut buf);
      buf
    });

    (addr, handle)
  }

  fn request(addr: SocketAddr, receipt: ReceiptIr) -> PrintRequest {
    PrintRequest {
      printer: TcpPrinterConfig {
        host: addr.ip().to_string(),
        port: addr.port(),
      },
      receipt,
    }
  }

  fn receipt(open_drawer: bool) -> ReceiptIr {
    ReceiptIr {
      shop_name: "ร้านวาลังอาซิ".to_string(),
      receipt_number: "R-0001".to_string(),
      lines: vec![crate::escpos::ReceiptLine {
        text: "กาแฟโก้".to_string(),
        align: crate::escpos::Align::Left,
      }],
      total_satang: "4550".to_string(),
      open_drawer,
    }
  }

  #[test]
  fn print_receipt_sends_a_compiled_receipt_and_opens_the_drawer() {
    use tauri::async_runtime::block_on;

    let (addr, printer) = fake_printer();

    let outcome = block_on(print_receipt(request(addr, receipt(true)))).expect("print");

    let received = printer.join().expect("printer thread");

    assert_eq!(outcome.bytes_sent, received.len());
    assert!(!received.is_empty());

    // The head: initialise then the Thai code page, before any text.
    assert_eq!(&received[0..2], b"\x1b\x40", "ESC @ leads the stream");
    assert_eq!(&received[2..5], b"\x1b\x74\x14", "ESC t 20 follows it");

    // The tail: the DRAWER pulse, because this receipt set `open_drawer`. The
    // cut precedes it.
    assert_eq!(
      &received[received.len() - 5..],
      b"\x1b\x70\x00\x19\xfa",
      "ESC p 0 25 250 is last when the drawer opens"
    );
    assert!(
      received.windows(4).any(|w| w == b"\x1d\x56\x42\x00"),
      "the cut is in the stream, just not last"
    );
  }

  #[test]
  fn print_receipt_ends_on_the_cut_when_no_drawer_is_requested() {
    use tauri::async_runtime::block_on;

    let (addr, printer) = fake_printer();

    block_on(print_receipt(request(addr, receipt(false)))).expect("print");
    let received = printer.join().expect("printer thread");

    assert_eq!(
      &received[received.len() - 4..],
      b"\x1d\x56\x42\x00",
      "GS V 66 0 is the final command with no drawer"
    );
    assert!(
      !received.windows(5).any(|w| w == b"\x1b\x70\x00\x19\xfa"),
      "no drawer pulse may appear"
    );
  }

  #[test]
  fn print_receipt_encodes_before_it_connects() {
    use tauri::async_runtime::block_on;

    // Port 1 has no listener, so ANY attempt to open a socket fails. If the
    // command connected before compiling, this would report `Transport`; because
    // it compiles first, an unencodable receipt reports `UnmappableText` and
    // never touches the network.
    //
    // That ordering is a deliberate property, not an accident: an operator with
    // a broken menu entry must be told to fix the menu, not to check the cables.
    let mut bad = receipt(false);
    bad.lines[0].text = "ชา ☕".to_string();

    let result = block_on(print_receipt(PrintRequest {
      printer: TcpPrinterConfig {
        host: "127.0.0.1".to_string(),
        port: 1,
      },
      receipt: bad,
    }));

    match result {
      Err(e) => {
        assert_eq!(
          e.kind,
          PrinterErrorKind::UnmappableText,
          "a menu-data fault must not be reported as a transport fault: {}",
          e.message
        );
        assert!(e.message.contains('☕'), "names the character: {}", e.message);
      }
      Ok(outcome) => panic!("expected a refusal, sent {outcome:?}"),
    }
  }

  #[test]
  fn print_receipt_reports_an_unreachable_printer_as_a_transport_error() {
    use tauri::async_runtime::block_on;

    let result = block_on(print_receipt(PrintRequest {
      printer: TcpPrinterConfig {
        host: "127.0.0.1".to_string(),
        port: 1,
      },
      receipt: receipt(false),
    }));

    match result {
      Err(e) => {
        assert_eq!(e.kind, PrinterErrorKind::Transport);
        assert!(
          e.message.contains("127.0.0.1"),
          "names the address: {}",
          e.message
        );
      }
      Ok(outcome) => panic!("expected a transport error, sent {outcome:?}"),
    }
  }

  #[test]
  fn print_receipt_rejects_a_malformed_total_before_opening_a_socket() {
    use tauri::async_runtime::block_on;

    // The same ordering guarantee for the money path: a total that is not a
    // plain integer must never reach the printer or a customer's receipt.
    let mut bad = receipt(false);
    bad.total_satang = "forty five".to_string();

    let result = block_on(print_receipt(PrintRequest {
      printer: TcpPrinterConfig {
        host: "127.0.0.1".to_string(),
        port: 1,
      },
      receipt: bad,
    }));

    assert!(matches!(
      result,
      Err(PrinterError {
        kind: PrinterErrorKind::InvalidReceipt,
        ..
      })
    ));
  }

  #[test]
  fn an_unmappable_character_becomes_a_menu_data_error_not_a_transport_one() {
    // The distinction matters to the UI: a transport error may succeed next
    // time, an unmappable character will fail forever until someone edits the
    // menu. Reporting both as "printer error" would send the cashier to check
    // cables that are fine.
    let err: PrinterError = CompileError::Unmappable {
      line: 2,
      source: crate::cp874::UnmappableCharacter {
        character: '☕',
        codepoint: "U+2615".to_string(),
      },
    }
    .into();

    assert_eq!(err.kind, PrinterErrorKind::UnmappableText);
    assert!(err.message.contains("2"), "names the line: {}", err.message);
    assert!(err.message.contains("U+2615"), "names the character");
  }

  #[test]
  fn a_malformed_total_is_an_invalid_receipt() {
    let err: PrinterError = CompileError::MalformedTotal {
      received: "forty five".to_string(),
    }
    .into();

    assert_eq!(err.kind, PrinterErrorKind::InvalidReceipt);
    assert!(err.message.contains("forty five"));
  }

  #[test]
  fn the_wire_shape_is_camel_case() {
    // Locked because the TypeScript adapter reads these names; a rename here
    // would deserialize to undefined on the frontend and fail at runtime only.
    let json = serde_json::to_string(&PrinterError {
      kind: PrinterErrorKind::Transport,
      message: "x".into(),
    })
    .expect("serialize");

    assert!(json.contains("\"kind\":\"transport\""), "{json}");
    assert!(json.contains("\"message\""), "{json}");
  }
}
