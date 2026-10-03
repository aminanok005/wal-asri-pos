/**
 * vite.config.ts — how the terminal's frontend is bundled.
 *
 * LAYER: build tooling. It is loaded by Vite itself (esbuild-bundled, then run
 * in Node) and never by the app, so it sits beside `src/` rather than inside
 * it.
 *
 * ── Why this file is NOT in the typecheck program (read this) ─────────────────
 * `tsconfig.json` sets `include` to the `src` and `test` globs only, so this file
 * is NOT type-checked by `bun run typecheck`. That is not an accident to rely on:
 * it is a real gap, and it has a cost. `clearScreen` was originally written here
 * as `server.clearScreen`; that is not a Vite option at all — `clearScreen` is
 * TOP-LEVEL, and `server` has no such key — and no `bun run typecheck` run
 * would ever have reported it, because a config nobody type-checks is a config
 * that can only be found by running it. It is caught here by type-checking this
 * file directly against the same strict flags the app uses.
 *
 * The durable fix is a `tsconfig.node.json` covering this file plus a second
 * `tsc -p` in the app's `typecheck` script. That is deliberately NOT done yet:
 * it changes what `bun run verify` executes, and this task's contract is that
 * `verify` keeps its exact current shape. It is recorded here so the gap is
 * known rather than rediscovered.
 *
 * ── Why Vite at all, and why with no extra plugins ───────────────────────────
 * The app is a two-screen shell that already has 258 passing tests and an
 * in-memory repository; the bundler's whole job here is to turn
 * `src/main.tsx` plus its imports into the static file tree that
 * `tauri.conf.json`'s `build.frontendDist` points at. That is a one-job job, and
 * it is done by the entries below and nothing else.
 *
 *   * `@vitejs/plugin-react` — JSX transform and Fast Refresh. It is the ONLY
 *     plugin. No router plugin, no CSS framework, no state library, no
 *     auto-import magic. Every dependency here has to be fetched once by a till
 *     on whatever connection the cafe has that week, and a plugin that only
 *     saves the developer from writing an `import` is not worth those bytes.
 *   * No `@vitejs/plugin-legacy` either: Tauri bundles its own webview, so the
 *     transpilation targets are that webview's engine and nothing older.
 *
 * @see ../index.html — the `#root` element and the one module script
 * @see ./src/main.tsx — the entry point this config bundles
 */

// ─────────────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────────────

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // ── `root` ──────────────────────────────────────────────────────────────────
  // Left at Vite's default, which is the process working directory. Both entry
  // points into this file start in `apps/pos-desktop`: the root `build` script
  // is `bun run --filter '*' build`, and Bun runs a workspace script with the
  // CWD set to that workspace's directory — verified, the build prints
  // `dist/index.html` and writes to `apps/pos-desktop/dist/`. So `index.html`
  // resolves as `apps/pos-desktop/index.html` and not as `index.html` relative
  // to the monorepo root, which is the one thing that would silently move
  // `dist/` off the path `frontendDist` names.

  // ── `clearScreen` ───────────────────────────────────────────────────────────
  // TOP-LEVEL, AND THAT IS THE WHOLE POINT OF THIS BLOCK.
  //
  // By default Vite clears the terminal and prints a full-screen "VITE ready"
  // splash, which would wipe the `cargo` / `tauri dev` output printed just above
  // it. That output IS the diagnostic surface for a native app — a plugin
  // registration panic, a missing capability, a failed migration all land in it —
  // so the clear is turned off and the two streams interleave instead of
  // overwriting each other.
  //
  // It is a top-level option, NOT `server.clearScreen`. The terminal belongs to
  // the CLI process, not to the HTTP server, and the mistake is invisible: Vite
  // does not reject unknown keys at runtime, so `server.clearScreen` would
  // simply be ignored, the splash would come back, and nothing would say so.
  clearScreen: false,

  // ── `base` ──────────────────────────────────────────────────────────────────
  // RELATIVE, AND IT IS LOAD-BEARING FOR THE PACKAGED APP.
  //
  // Vite's default `base: '/'` makes the built HTML reference
  // `/assets/index-<hash>.js`. From a `file://` origin a leading slash is the
  // FILESYSTEM ROOT, not the bundle root: the request is for
  // `/assets/index-<hash>.js` on the drive, not for the file sitting next to
  // `index.html` inside `dist/`. The build would succeed, `tauri build` would
  // find `dist/index.html` where `frontendDist` expects it, and the packaged
  // till would open to a white window with a 404 in the console.
  //
  // `base: './'` makes Vite emit `./assets/index-<hash>.js`, which resolves
  // against the document's own location and so works from `file://`, from
  // `tauri://localhost`, and from the `http://tauri.localhost` origin that
  // Windows webviews use. One setting, all three origins.
  //
  // The dev server is unaffected: Vite normalises a relative `base` to `/` while
  // serving, so `bun run dev` still answers on http://localhost:1420/ with
  // `/src/main.tsx` resolvable. Both were verified, not assumed.
  base: './',

  plugins: [react()],

  // ── Dev server ──────────────────────────────────────────────────────────────

  server: {
    // ── The port ──────────────────────────────────────────────────────────────
    // 1420 is the port in Tauri's own `create-tauri-app` template, and it is
    // used here for a concrete reason rather than out of habit:
    // `tauri.conf.json`'s `devUrl` is what tells the Rust side which address to
    // load, and the Rust side has no discovery mechanism — no handshake, no
    // port file. The number is written down in two places by hand and has to
    // match, so the one number people already have in their heads is the one
    // used here.
    port: 1420,

    // ── `strictPort` ──────────────────────────────────────────────────────────
    // FAIL LOUDLY INSTEAD OF MOVING. Without it, Vite falls forward to 1421,
    // 1422, … when 1420 is busy and prints the address it actually bound. The
    // dev build would keep working, the Rust side would keep loading 1420, and
    // the till would show whatever else on the machine is listening there — or
    // nothing at all. A dev session that cannot bind the port the native side
    // expects is already broken, and the moment to find out is immediately, not
    // three hours later when someone wonders why their nav edits stopped
    // appearing on the terminal.
    //
    // This is not hypothetical. Writing this file, `bun run dev` exited 1 with
    // `Port 1420 is already in use` because an unrelated Vite from another
    // project had held the port for a day and a half. The strict failure said
    // exactly what was wrong; without `strictPort` the same situation would
    // have produced a dev server on 1421 that the native side could not reach.
    strictPort: true,

    // THE OTHER END OF THE WIRING, AND ALL OF IT IS HAND-WRITTEN.
    //
    // `src-tauri/tauri.conf.json` points the native side at THIS file:
    // `devUrl` is `http://localhost:1420` and `beforeDevCommand` is
    // `bun run dev`, so `tauri dev` starts the server configured above and
    // then loads that address into the webview. Nothing derives either end
    // from the other, so `port` and `strictPort` have to be kept agreeing
    // with that `devUrl` by hand; move one without the other and the webview
    // is pointed at an address nothing is serving.
    //
    // `beforeBuildCommand` is `bun run build`, and Tauri runs that hook with
    // its working directory set to this frontend directory, so the
    // process-CWD reliance on `root` and `index.html` above holds under
    // `tauri build` too, not only under the workspace `build` script.
    //
    // @see src-tauri/README.md — the "Vite ↔ Tauri wiring" section.
  },

  // ── Production build ────────────────────────────────────────────────────────

  build: {
    // THE ONE PATH THAT HAS TO MATCH `tauri.conf.json`.
    //
    // `tauri.conf.json` sets `build.frontendDist: "../dist"`, resolved relative
    // to `src-tauri/`, so it lands on `apps/pos-desktop/dist`. An `outDir`
    // pointing anywhere else makes `tauri build` fail at that path — or, worse,
    // succeed against a stale directory from an earlier run.
    outDir: 'dist',

    // WIPE THE DIRECTORY FIRST. Not cosmetic: without it, hashed filenames from
    // an earlier build survive, and a stale `index-<oldhash>.js` in
    // `dist/assets/` is a file the bundle ships and never references. Enough
    // builds later that is real dead weight on a till that must fetch the whole
    // bundle to boot.
    emptyOutDir: true,
  },
});
