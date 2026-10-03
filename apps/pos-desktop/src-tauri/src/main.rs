// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Desktop entry point.
///
/// The `tauri init` template calls `app_lib::run()`. The crate's `[lib]` is
/// named `wasri_pos_desktop_lib` (see `Cargo.toml`), so the Rust item path is
/// `wasri_pos_desktop_lib::run`. This file stays a one-line thunk so the
/// mobile entry point (`#[cfg_attr(mobile, tauri::mobile_entry_point)]` in
/// `lib.rs`) and the desktop entry point share a single `run()` body.
fn main() {
  wasri_pos_desktop_lib::run();
}
