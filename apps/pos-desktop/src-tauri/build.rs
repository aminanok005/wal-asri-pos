fn main() {
  // `tauri-build` reads `tauri.conf.json` at compile time and injects
  // configuration constants (window sizes, CSP, etc.) into the generated
  // `tauri::generate_context!()` macro in `lib.rs`. Without this the build
  // cannot resolve the app's configuration at all.
  tauri_build::build()
}
