/**
 * Test DOM environment.
 *
 * Bun's test runner has no `document` — it is not a browser. React components
 * need one, so a simulated DOM is installed onto `globalThis` before any test
 * file loads.
 *
 * Registered in `apps/pos-desktop/bunfig.toml` under `[test] preload`, which
 * Bun runs BEFORE the test module graph is imported. That ordering matters:
 * `@testing-library/react` captures a reference to the global `document` when
 * it is imported, so the DOM must already exist by then.
 *
 * This file affects TESTS ONLY. `tsconfig.json` excludes `test/` from the
 * application source, and nothing under `src/` imports it.
 */

import { Window } from 'happy-dom';

/**
 * A single Window instance, shared by every test file in the process.
 *
 * Sharing is deliberate: React binds to the document it was imported against,
 * so a second Window created later would leave React rendering into a document
 * that the test could not query.
 */
const window = new Window({ url: 'http://localhost' });

/**
 * Copy the DOM surface onto `globalThis`.
 *
 * `happy-dom` ships a `Window` class but no global registrator, so the
 * properties are assigned here explicitly. Spreading the whole object is
 * deliberately avoided: it would overwrite Bun's own globals (`fetch`,
 * `Promise`, `setTimeout`) and break the test runner itself. Only the
 * browser-shaped surface is installed.
 */
const DOM_GLOBALS = [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'NodeList',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'DOMParser',
  'localStorage',
  'sessionStorage',
  'location',
] as const;

for (const key of DOM_GLOBALS) {
  const value = (window as unknown as Record<string, unknown>)[key];
  if (value !== undefined) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
}

(globalThis as unknown as Record<string, unknown>).window = window;
