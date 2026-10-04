//! Printer transport — sending compiled ESC/POS bytes to a printer on the LAN.
//!
//! ── WHY A TRAIT, AND WHY IT SITS BELOW THE BYTE COMPILER ─────────────────────
//!
//! `escpos.rs` turns a receipt into a `Vec<u8>`. This module decides where those
//! bytes go. Keeping the two apart is what lets the compiler be tested with no
//! hardware at all, and lets the transport be swapped without touching a single
//! byte-compilation test.
//!
//! The trait exists for a second reason: a LAN printer is not the only ESC/POS
//! transport. USB and direct serial speak the same command language over a
//! different pipe, so a `PrinterTransport` implementation can be added without
//! revisiting anything here.
//!
//! ── WHY A TURNED-ON PRINTER IS NOT A GUARANTEED PRINTED RECEIPT ───────────────
//!
//! ESC/POS has no acknowledgement. There is no "receipt received" status, no
//! checksum the printer verifies, and no way to ask whether the paper actually
//! fed. `write_all` returning `Ok` means the bytes reached the operating
//! system's send buffer — nothing more. The printer may be powered off, out of
//! paper, or have a jammed cutter at that moment, and this layer cannot tell.
//!
//! So `send` returns what it can honestly report — that the bytes were handed
//! to the socket — and no caller should treat it as a receipt. A till that needs
//! to know must re-query the printer, which ESC/POS does not support.
//!
//! ── WHY EVERY SOCKET CALL IS BLOCKING, AND WHY THAT IS FINE HERE ─────────────
//!
//! `std::net::TcpStream` is blocking. That is safe **only** because this module
//! is never called on the UI thread: [`send_bytes`] wraps the whole connect +
//! write in `spawn_blocking`, so a printer that is unplugged and silently
//! swallowing packets (a 15 s TCP timeout, not an instant refusal) delays a
//! worker thread and never the window.
//!
//! This is the same rule `commands.rs` follows for the SQLite driver, and for
//! the same reason: a synchronous driver called directly from an async command
//! blocks the runtime's worker, which on a single-threaded executor is the UI
//! thread.

use std::io::Write;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/// Connection timeouts.
///
/// These are the difference between "the printer is unplugged" costing the
/// cashier one second and costing them fifteen. Without them a TCP connect to a
/// dead IP on a shop LAN can hang for the OS default (over a minute on some
/// platforms), which from the customer's side looks exactly like a frozen till.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Write timeout. Generous relative to a 58mm receipt — a few hundred bytes —
/// but bounded, so a printer that accepts the connection and then stops reading
/// cannot pin the worker forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// A printer reachable over the network.
///
/// Fields are named for the wire, not for Rust style: this struct is
/// deserialised directly from the JSON the frontend sends, so a `#[serde(rename)]`
/// would be an extra translation layer to keep in sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TcpPrinterConfig {
  /// The printer's IPv4 or IPv6 address, as a string.
  ///
  /// A `String` rather than an `IpAddr` because serde's human-readable form for
  /// an IPv6 address is contentious and a till is configured by typing one. An
  /// unparseable address is a `SendError`, not a panic.
  pub host: String,
  /// TCP port. Raw 9100 is the conventional ESC/POS-over-TCP port; an
  /// Ethernet print server may present it elsewhere, so it is configurable
  /// rather than hardcoded.
  pub port: u16,
}

impl TcpPrinterConfig {
  /// Parse the address, or explain precisely what was wrong with it.
  ///
  /// The error names the received value because the realistic failure is a
  /// typo in a shop-configuration screen, and "invalid IP address" alone sends
  /// the operator hunting without telling them what to fix.
  fn socket_addr(&self) -> Result<SocketAddr, SendError> {
    let ip: IpAddr = self.host.parse().map_err(|_| SendError::BadAddress {
      received: self.host.clone(),
    })?;
    Ok(SocketAddr::new(ip, self.port))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/// Why a send failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
  /// `host` was not a valid IP address.
  BadAddress {
    /// Exactly what was received, verbatim.
    received: String,
  },
  /// The port was 0, which can never be a destination.
  BadPort {
    /// The port that was configured.
    received: u16,
  },
  /// The socket could not be opened within `CONNECT_TIMEOUT`.
  ///
  /// Usually one of three things: printer powered off, wrong IP, or a VLAN that
  /// does not route to the till.
  Connect {
    /// The address that was tried.
    target: String,
    /// The underlying OS error, verbatim.
    cause: String,
  },
  /// The bytes could not be handed to the socket within `WRITE_TIMEOUT`.
  Write {
    /// How many bytes had been accepted when it stopped.
    written: usize,
    /// The underlying OS error, verbatim.
    cause: String,
  },
}

impl std::fmt::Display for SendError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      SendError::BadAddress { received } => {
        write!(f, "printer host is not a valid IP address: {received:?}")
      }
      SendError::BadPort { received } => write!(f, "printer port must be non-zero, got {received}"),
      SendError::Connect { target, cause } => {
        write!(f, "cannot reach printer at {target}: {cause}")
      }
      SendError::Write { written, cause } => {
        write!(f, "printer write failed after {written} bytes: {cause}")
      }
    }
  }
}

impl std::error::Error for SendError {}

/// What the frontend is told after a send.
///
/// ⚠️ `bytesSent` is NOT a confirmation that paper moved. See the module docs:
/// ESC/POS cannot report this. The field is named for what it measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
  /// How many bytes were handed to the socket.
  pub bytes_sent: usize,
}

// ─────────────────────────────────────────────────────────────────────────────
// The transport
// ─────────────────────────────────────────────────────────────────────────────

/// Somewhere compiled ESC/POS bytes can be written.
///
/// Blocking by design. Implementations are I/O, and the async wrapper that
/// keeps them off the UI thread lives in [`send_bytes`], not in each adapter.
pub trait PrinterTransport: Send + Sync {
  /// Hand `bytes` to the printer. Returns how many were accepted.
  fn send(&self, bytes: &[u8]) -> Result<usize, SendError>;
}

/// A printer on the LAN, reached over TCP.
#[derive(Debug, Clone)]
pub struct TcpPrinterTransport {
  config: TcpPrinterConfig,
}

impl TcpPrinterTransport {
  /// Construct a transport. Does not connect — construction is cheap and
  /// connectionless, so a misconfigured printer fails on the first send with a
  /// useful error rather than at construction time with no context.
  pub fn new(config: TcpPrinterConfig) -> Self {
    Self { config }
  }

  /// The configuration in use, for logging.
  pub fn config(&self) -> &TcpPrinterConfig {
    &self.config
  }
}

impl PrinterTransport for TcpPrinterTransport {
  fn send(&self, bytes: &[u8]) -> Result<usize, SendError> {
    if self.config.port == 0 {
      return Err(SendError::BadPort {
        received: self.config.port,
      });
    }

    let addr = self.config.socket_addr()?;

    // A zero-length receipt is a programming error upstream, not something to
    // paper over with a "successfully sent 0 bytes".
    if bytes.is_empty() {
      return Err(SendError::Write {
        written: 0,
        cause: "refusing to send an empty byte stream".to_string(),
      });
    }

    // `connect_timeout` rather than `connect`: this is the call that hangs for
    // a minute against a dead address if left unbounded.
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| {
      SendError::Connect {
        target: addr.to_string(),
        cause: e.to_string(),
      }
    })?;

    // Write timeout. A printer that accepts the connection and then stops
    // reading (out of paper on some units) must not pin this worker.
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));

    stream
      .write_all(bytes)
      .map_err(|e| SendError::Write {
        written: 0,
        cause: e.to_string(),
      })?;

    // `flush` on a TcpStream is a no-op for the OS send buffer, but it makes the
    // intent explicit and would matter for a buffered writer.
    let _ = stream.flush();

    Ok(bytes.len())
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The async wrapper
// ─────────────────────────────────────────────────────────────────────────────

/// Send a receipt without blocking the caller's thread.
///
/// Wraps `spawn_blocking` around the whole connect-and-write. This is the ONLY
/// entry point the Tauri command uses, and it exists for the reason in the
/// module docs: `TcpStream::connect` is blocking, and on Tauri 2 the async
/// runtime's worker can be the thread that renders the window. A printer on the
/// wrong IP would then freeze the till for as long as the OS timeout, mid-sale,
/// with the customer watching.
///
/// The transport is moved into the closure rather than borrowed, so `'static`
/// is satisfied and nothing shares state with a caller that might not outlive
/// the blocking task.
///
/// A `.await` is NOT used inside the closure: `spawn_blocking` runs a
/// SYNCHRONOUS closure, and awaiting inside one does not compile. This function
/// is the async wrapper around the blocking send; `TcpPrinterTransport::send` is
/// the blocking primitive it delegates to.
pub async fn send_bytes(
  transport: TcpPrinterTransport,
  bytes: Vec<u8>,
) -> Result<SendOutcome, SendError> {
  tauri::async_runtime::spawn_blocking(move || {
    let written = transport.send(&bytes)?;
    Ok(SendOutcome {
      bytes_sent: written,
    })
  })
  .await
  .map_err(|e| SendError::Write {
    written: 0,
    cause: format!("blocking worker did not finish: {e}"),
  })?
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A one-shot TCP listener on an ephemeral port, standing in for a printer.
  ///
  /// This is what makes the transport testable with no hardware: the tests bind
  /// a real loopback socket, so `connect_timeout`, `write_all` and the timeout
  /// plumbing are genuinely exercised rather than mocked away. A mock would
  /// pass while the real code failed to compile against the real socket API.
  ///
  /// Returns the address to dial and a handle to the received bytes.
  fn fake_printer() -> (SocketAddr, std::thread::JoinHandle<Vec<u8>>) {
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");

    let handle = std::thread::spawn(move || {
      // `Read` is imported here rather than at module scope: the test harness
      // is the only thing that reads, and an unused top-level import is a
      // warning the compiler is right to raise.
      use std::io::Read;

      let (mut stream, _) = listener.accept().expect("accept");
      let mut buf = Vec::new();
      // The printer reads until the till closes; `read_to_end` on a socket the
      // sender never shuts down would block, so a bounded read stands in for a
      // printer draining its buffer.
      stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .expect("read timeout");
      let _ = stream.read_to_end(&mut buf);
      buf
    });

    (addr, handle)
  }

  fn transport_to(addr: SocketAddr) -> TcpPrinterTransport {
    TcpPrinterTransport::new(TcpPrinterConfig {
      host: addr.ip().to_string(),
      port: addr.port(),
    })
  }

  // ── The happy path ────────────────────────────────────────────────────────

  #[test]
  fn a_receipt_reaches_the_socket_byte_for_byte() {
    let (addr, printer) = fake_printer();

    let sent = vec![0x1B, 0x40, 0x1B, 0x74, 0x14, b'T', b'h', b'a', b'i', 0x0A, 0x1D, 0x56, 0x42, 0x00];
    let outcome = transport_to(addr).send(&sent).expect("send should succeed");

    assert_eq!(outcome, sent.len(), "every byte is reported as sent");

    let received = printer.join().expect("printer thread");
    assert_eq!(received, sent, "the printer must see the exact compiled stream");
  }

  #[test]
  fn a_whole_receipt_stream_survives_the_round_trip() {
    use crate::escpos::{self, Align, ReceiptIr, ReceiptLine};

    let ir = ReceiptIr {
      shop_name: "ร้านวาลังอาซิ".to_string(),
      receipt_number: "R-0001".to_string(),
      lines: vec![ReceiptLine {
        text: "กาแฟโก้".to_string(),
        align: Align::Left,
      }],
      total_satang: "4550".to_string(),
      open_drawer: true,
    };

    let compiled = escpos::compile(&ir).expect("compile");
    let (addr, printer) = fake_printer();

    let outcome = transport_to(addr).send(&compiled).expect("send");
    assert_eq!(outcome, compiled.len());

    let received = printer.join().expect("printer thread");
    assert_eq!(received, compiled, "the wire bytes are the compiled bytes, unchanged");

    // And the control sequences are still intact at the head and tail. Note the
    // tail is the DRAWER pulse, not the cut: this fixture sets `open_drawer`,
    // and the compiler appends ESC p after GS V. Asserting the cut here would
    // be wrong about which command actually ends the stream.
    assert_eq!(&received[0..2], b"\x1b\x40", "ESC @ still leads");
    assert_eq!(&received[2..5], b"\x1b\x74\x14", "ESC t 20 still follows");
    assert!(
      received.windows(4).any(|w| w == b"\x1d\x56\x42\x00"),
      "the cut is still in the stream, just not last"
    );
    assert_eq!(
      &received[received.len() - 5..],
      b"\x1b\x70\x00\x19\xfa",
      "ESC p 0 25 250 is the final command when the drawer opens"
    );
  }

  #[test]
  fn a_receipt_without_the_drawer_ends_on_the_cut() {
    // The same stream with `open_drawer: false`, which is the common case and
    // therefore the one the earlier assertion should have covered.
    use crate::escpos::{self, Align, ReceiptIr, ReceiptLine};

    let ir = ReceiptIr {
      shop_name: "ร้านวาลังอาซิ".to_string(),
      receipt_number: "R-0001".to_string(),
      lines: vec![ReceiptLine {
        text: "กาแฟโก้".to_string(),
        align: Align::Left,
      }],
      total_satang: "4550".to_string(),
      open_drawer: false,
    };

    let compiled = escpos::compile(&ir).expect("compile");
    let (addr, printer) = fake_printer();

    let outcome = transport_to(addr).send(&compiled).expect("send");
    assert_eq!(outcome, compiled.len());

    let received = printer.join().expect("printer thread");
    assert_eq!(
      &received[received.len() - 4..],
      b"\x1d\x56\x42\x00",
      "GS V 66 0 is the final command"
    );
  }

  // ── Failure modes ─────────────────────────────────────────────────────────

  #[test]
  fn an_unreachable_printer_is_an_error_not_a_hang() {
    // Port 1 on loopback: nothing listens, so the connection is refused
    // immediately rather than timing out. This asserts the error path is
    // reachable and typed, which matters because a cashier seeing a dead
    // printer needs a message rather than a frozen till.
    let transport = TcpPrinterTransport::new(TcpPrinterConfig {
      host: "127.0.0.1".to_string(),
      port: 1,
    });

    match transport.send(b"test") {
      Err(SendError::Connect { target, .. }) => assert!(target.contains("127.0.0.1")),
      other => panic!("expected Connect, got {other:?}"),
    }
  }

  #[test]
  fn a_malformed_host_names_the_offending_value() {
    let transport = TcpPrinterTransport::new(TcpPrinterConfig {
      host: "192.168.1".to_string(),
      port: 9100,
    });

    match transport.send(b"test") {
      Err(SendError::BadAddress { received }) => assert_eq!(received, "192.168.1"),
      other => panic!("expected BadAddress, got {other:?}"),
    }
  }

  #[test]
  fn a_zero_port_is_refused_before_any_socket_call() {
    let transport = TcpPrinterTransport::new(TcpPrinterConfig {
      host: "127.0.0.1".to_string(),
      port: 0,
    });

    assert!(matches!(transport.send(b"test"), Err(SendError::BadPort { received: 0 })));
  }

  #[test]
  fn an_empty_stream_is_refused_rather_than_reported_as_a_success() {
    // A zero-byte "successful print" is the worst possible lie: the till
    // records a receipt that no customer received.
    let (addr, _printer) = fake_printer();
    let outcome = transport_to(addr).send(&[]);

    assert!(
      matches!(outcome, Err(SendError::Write { written: 0, .. })),
      "an empty stream must not be reported as sent"
    );
  }

  #[test]
  fn every_error_renders_something_a_cashier_can_act_on() {
    let cases = [
      SendError::BadAddress { received: "nope".into() },
      SendError::BadPort { received: 0 },
      SendError::Connect { target: "1.2.3.4:9100".into(), cause: "refused".into() },
      SendError::Write { written: 4, cause: "broken pipe".into() },
    ];

    for case in cases {
      let text = case.to_string();
      assert!(!text.is_empty(), "{case:?} must render a message");

      // Each variant must surface the value an operator needs to act on: the
      // address to check, the port, the bad host, or the underlying cause.
      let actionable = match &case {
        SendError::BadAddress { received } => text.contains(received),
        SendError::BadPort { received } => text.contains(&received.to_string()),
        SendError::Connect { target, cause } => text.contains(target) && text.contains(cause),
        SendError::Write { cause, .. } => text.contains(cause),
      };
      assert!(actionable, "{text:?} should name the value to act on");
    }
  }

  // ── Configuration parsing ─────────────────────────────────────────────────

  #[test]
  fn a_valid_configuration_parses_to_a_socket_address() {
    let config = TcpPrinterConfig {
      host: "192.168.1.50".to_string(),
      port: 9100,
    };
    let addr = config.socket_addr().expect("valid address");

    assert_eq!(addr.to_string(), "192.168.1.50:9100");
    assert_eq!(config.host, "192.168.1.50");
  }

  #[test]
  fn an_ipv6_configuration_parses_too() {
    // Shop LANs are not always IPv4, and a till that only understood dotted
    // quads would be a till that cannot be deployed on a modern network.
    let config = TcpPrinterConfig {
      host: "fe80::1".to_string(),
      port: 9100,
    };
    assert!(config.socket_addr().is_ok());
  }

  #[test]
  fn a_hostname_is_refused_rather_than_resolved() {
    // Deliberate: a DNS lookup on a till is a blocking call with its own
    // failure modes, and an offline shop has no resolver to answer. Printers
    // are configured by IP.
    let config = TcpPrinterConfig {
      host: "printer.local".to_string(),
      port: 9100,
    };
    assert!(matches!(config.socket_addr(), Err(SendError::BadAddress { .. })));
  }
}
