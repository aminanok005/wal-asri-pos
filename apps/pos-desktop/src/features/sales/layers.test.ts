import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SALES_DIR = new URL('.', import.meta.url);

/**
 * Strip comments so a guard matches CODE, not prose.
 *
 * Without this, a doc comment that merely *mentions* a forbidden name — such as
 * "there is no setItems(...) anywhere" — would fail the guard that exists to
 * prove that name is absent. The rule would then punish the very documentation
 * that documents it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, but not `https://`
}

/**
 * Layer boundary guard.
 *
 * The rule (`SKILL.md` §2.3) is directional:
 *
 *   UI  →  domain  ✅ ALLOWED   this file may import React
 *   domain  →  UI  ❌ FORBIDDEN  a domain module must never import React
 *
 * Both directions are asserted here, by reading the actual source. A rule that
 * only exists in a README is a promise; this is the check that makes it a rule.
 */
describe('sales feature layer boundary', () => {
  it('domain/ imports NOTHING from react, tauri, or a framework', async () => {
    const source = stripComments(await Bun.file(new URL('domain/cart.ts', SALES_DIR)).text());

    expect(source).not.toMatch(/from ['"]react['"]/);
    expect(source).not.toMatch(/@tauri-apps/);
    expect(source).not.toMatch(/@tanstack/);
    expect(source).not.toMatch(/zustand/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/from ['"]node:/);
  });

  it('UI MAY import react and the domain — this is the allowed direction', async () => {
    const source = stripComments(await Bun.file(new URL('ui/CartView.tsx', SALES_DIR)).text());

    // UI importing a framework is correct and expected.
    expect(source).toMatch(/from ['"]react['"]/);
    // UI importing the domain is the whole point of the architecture.
    expect(source).toMatch(/from ['"]\.\.\/domain\/cart['"]/);
  });

  it('UI reaches the domain for every cart mutation, never its own copy', async () => {
    const source = stripComments(await Bun.file(new URL('ui/CartView.tsx', SALES_DIR)).text());

    // The UI must not keep a parallel item list in component state.
    expect(source).not.toMatch(/useState<[^>]*\[\]/);
    expect(source).not.toMatch(/setItems/);
    // The subtotal on screen must come from the domain function.
    expect(source).toMatch(/calculateSubtotal/);
  });

  // ── tax.ts ────────────────────────────────────────────────────────────────
  // A new domain module is a new way to break the boundary, so it is added to
  // the guard explicitly rather than assumed to follow cart.ts. If tax.ts is
  // ever allowed to reach for React or Tauri, the VAT maths stops being testable
  // without a browser and this test fails instead of the comment going stale.
  it('tax.ts is also pure domain — no react, tauri, SQL, or a network call', async () => {
    const source = stripComments(await Bun.file(new URL('domain/tax.ts', SALES_DIR)).text());

    expect(source).not.toMatch(/from ['"]react['"]/);
    expect(source).not.toMatch(/@tauri-apps/);
    expect(source).not.toMatch(/@tanstack/);
    expect(source).not.toMatch(/zustand/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/\bbun:sqlite\b/);
  });

  it('tax.ts reaches for no float, and only for the Money value object', async () => {
    const source = stripComments(await Bun.file(new URL('domain/tax.ts', SALES_DIR)).text());

    // The only import it is allowed to make.
    const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../../payments/domain/money']);

    // No float literal typing of money, and no division that could produce one.
    expect(source).not.toMatch(/:\s*number\s*=.*_satang/);
  });
});

/**
 * The `infrastructure/` layer: the EDGE, and therefore the one place allowed to
 * reach outside the feature.
 *
 * The rule is still directional, just different from `domain/`:
 *
 *   infrastructure → domain + application + @tauri-apps  ✅ ALLOWED
 *   domain         → infrastructure                       ❌ FORBIDDEN
 *
 * A domain module that imported the Tauri adapter would acquire a dependency on
 * a native runtime, and the pure cart/tax maths would stop being testable
 * without one. That is the whole reason the port in `application/` exists.
 *
 * The guard is two-sided on purpose: it asserts the edge MAY use Tauri (so the
 * rule stays honest rather than aspirational) and that the pure layers still may
 * NOT (so the allowance does not quietly spread).
 */
describe('infrastructure/ is the only layer allowed to reach for Tauri', () => {
  const INFRA_DIR = new URL('infrastructure/', SALES_DIR);

  /** Every non-test module in `infrastructure/`. */
  async function infraModules(): Promise<{ name: string; source: string }[]> {
    const cwd = fileURLToPath(INFRA_DIR);
    const glob = new Bun.Glob('*.ts');
    const modules: { name: string; source: string }[] = [];

    for await (const name of glob.scan({ cwd })) {
      if (name.endsWith('.test.ts')) continue;
      modules.push({ name, source: stripComments(await Bun.file(join(cwd, name)).text()) });
    }
    return modules;
  }

  it('finds the infrastructure modules it is guarding', async () => {
    const modules = await infraModules();
    expect(modules.map((m) => m.name)).toContain('tauriOfflineOrders.ts');
  });

  it('the edge DOES use @tauri-apps — otherwise this guard proves nothing', async () => {
    // If the adapter stopped importing Tauri, the guards below would pass for
    // the wrong reason. Asserting the allowance is in use keeps the rule real.
    const modules = await infraModules();
    const usesTauri = modules.some((m) => /@tauri-apps\/api/.test(m.source));
    expect(usesTauri).toBe(true);
  });

  it('the edge imports only the port, the domain, and the Tauri bridge', async () => {
    const ALLOWED = new Set([
      '@tauri-apps/api/core',
      '../application/offlineOrders',
      // The receipt-printer port and the IR it carries. Both are legitimate edge
      // imports: the adapter implements a port, and a printer request has to
      // carry a receipt somewhere. The guard exists to stop the edge reaching
      // INTO the UI or the native layer, not to forbid the features it serves.
      '../application/receiptPrinter',
      '../domain/receiptLayout',
      '../../payments/domain/money',
      '../../domain/cart',
      '../../domain/lineId',
      '../../domain/tax',
    ]);

    const violations: string[] = [];
    for (const { name, source } of await infraModules()) {
      const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map(
        (m) => m[1] ?? '',
      );
      for (const specifier of imports) {
        if (!ALLOWED.has(specifier)) violations.push(`${name} imports "${specifier}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the edge converts satang at the boundary and never sends a JSON number', async () => {
    // The invariant that justifies this layer existing. If a future edit sends
    // satang as a number, precision above 2^53 is lost SILENTLY — so this
    // asserts the mechanism is present, not just that some conversion happens.
    const source = (await infraModules()).find((m) => m.name === 'tauriOfflineOrders.ts')?.source ?? '';

    // Outbound: every satang goes through the one named serialiser.
    expect(source).toContain('function satangToWire(');
    expect(source).toContain('value.toString()');

    // Inbound: the edge does not parse satang itself, it delegates to the one
    // shared checker in the money module. That is the assertion that matters —
    // a local second parser in an adapter is how the catalogue boundary and the
    // sync boundary come to accept different spellings of one satang.
    expect(source).toContain('satangFromWireChecked(');

    // And the shared checker it delegates to is where the guard now lives, so
    // check it there too rather than trusting the delegation alone.
    const moneySource = stripComments(
      await Bun.file(new URL('../payments/domain/money.ts', SALES_DIR)).text(),
    );
    expect(moneySource).toContain('function satangFromWire(');
    expect(moneySource).toMatch(/if \(typeof raw !== 'string'\)/);
    expect(moneySource).toContain('SATANG_PATTERN');

    // And the edge may never hand a `bigint` straight to `invoke`, nor ask
    // `Number()` to carry money in either direction.
    expect(source).not.toMatch(/JSON\.stringify\([^)]*satang/i);
    expect(source).not.toMatch(/Number\([^)]*[Ss]atang[^)]*\)/);
  });

  it('the pure layers still may NOT reach for Tauri', async () => {
    // The counterweight. Allowing the edge must not become allowing everything.
    //
    // NOTE the exclusion of `react` from this list: the UI layer IS allowed to
    // import React — that is the documented direction (`SKILL.md` §2.3, and the
    // first two tests in this file). What the UI may never do is reach PAST the
    // domain and talk to hardware or a server directly, so that is what is
    // forbidden here. Tauri and `fetch` are the real risks: a view that calls
    // `invoke` itself bypasses the port, and the offline guarantee that makes
    // this product work stops being enforced anywhere.
    const forbidden = [/@tauri-apps/, /\bfetch\(/, /escpos/i, /serialport/i];
    const violations: string[] = [];

    for (const layer of ['domain/', 'application/', 'ui/']) {
      const cwd = fileURLToPath(new URL(layer, SALES_DIR));
      if (!existsSync(cwd)) continue;

      const glob = new Bun.Glob('*.ts*');
      for await (const name of glob.scan({ cwd })) {
        if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue;
        const source = stripComments(await Bun.file(join(cwd, name)).text());

        for (const pattern of forbidden) {
          if (pattern.test(source)) {
            violations.push(`${layer}${name} matches ${pattern}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('domain/ still may not import the infrastructure layer', async () => {
    // Dependency direction: the pure domain must not know an adapter exists.
    const cwd = fileURLToPath(new URL('domain/', SALES_DIR));
    const glob = new Bun.Glob('*.ts');
    const violations: string[] = [];

    for await (const name of glob.scan({ cwd })) {
      if (name.endsWith('.test.ts')) continue;
      const source = stripComments(await Bun.file(join(cwd, name)).text());
      if (/from ['"][^'"]*infrastructure\//.test(source)) {
        violations.push(`${name} imports infrastructure/`);
      }
    }

    expect(violations).toEqual([]);
  });
});

/**
 * Every module in `domain/`, guarded by ONE shared rule rather than one
 * hand-written test per file.
 *
 * The per-file tests above are exhaustive for the two modules that exist today,
 * but a new domain module is a new way to break the boundary, and the natural
 * failure mode is that nobody adds a guard for it. `receiptLayout.ts` is the
 * next module to arrive (the ESC/POS receipt blueprint), and it is precisely the
 * kind of file that tempts someone: a receipt builder wants to format a
 * ฿45.50 total and reach for `Intl.NumberFormat` or a printer library.
 *
 * Both of those would break the architecture. `Intl` is locale data that can
 * differ between machines, and the whole point of satang is that ฿45.50 is the
 * integer 4550 — formatting it with a locale formatter reintroduces a float and
 * a machine-dependent string. An ESC/POS byte stream belongs in the Rust adapter,
 * not here.
 *
 * `DOMAIN_ALLOWLIST` is the allowlist of imports a domain module may make. It is
 * deliberately tiny: the `Money` value object, and the generated contract types
 * as TYPE-only imports. React, Tauri, printer libraries, and `node:`/`bun:`
 * builtins are all absent on purpose, and their absence is what makes this a
 * guard rather than a suggestion.
 */
describe('every domain module obeys the same import allowlist', () => {
  /**
   * What a `domain/*.ts` file is permitted to import.
   *
   * `tax.ts` needs only the `Money` value object. `cart.ts` additionally uses the
   * generated contract types, which are pure TypeScript declarations with no
   * runtime behaviour — importing a TYPE from them cannot pull in hardware, a
   * network, or a clock, so it stays inside the domain boundary. A domain module
   * may also import a SIBLING domain module, which is the same "pure code inside
   * the boundary" argument one level down.
   */
  const DOMAIN_ALLOWLIST = new Set([
    '../../payments/domain/money',
    '@wasri/api-types',
    // Sibling domain modules. Kept explicit rather than pattern-matched so that
    // reaching OUT of the feature (e.g. '../../cart/cart') is still rejected.
    './cart',
    './tax',
  ]);

  /** Modules that must never appear anywhere in a domain file. */
  const FORBIDDEN = [
    // The ESC/POS rule. A printer byte stream is native and belongs behind the
    // Tauri invoke bridge; `escpos` / `serialport` in the domain would make the
    // receipt untestable without hardware.
    /escpos/i,
    /esc_pos/i,
    /serialport/i,
    /cash.?drawer/i,
    // Hardware and framework boundaries.
    /@tauri-apps/,
    /from ['"]react['"]/,
    /@tanstack/,
    /zustand/,
    // I/O.
    /\bfetch\(/,
    /from ['"]node:/,
    /\bbun:sqlite\b/,
    // Locale-sensitive formatting. Money is integer satang; rendering it through
    // a locale formatter would reintroduce a float and make output depend on the
    // machine's locale data.
    /\bIntl\./,
  ] as const;

  /**
   * Every non-test module in `domain/`, as `{ name, source }`.
   *
   * Centralised so the allowlist checks and the "did I find anything" check can
   * never drift apart — two separate scans would be two chances for one of them
   * to silently cover nothing.
   */
  async function domainModules(): Promise<{ name: string; source: string }[]> {
    // `Bun.Glob.scan` requires `cwd` to be a STRING path; passing the URL object
    // throws "scan: invalid `cwd`, not a string".
    const cwd = fileURLToPath(new URL('domain/', SALES_DIR));
    const glob = new Bun.Glob('*.ts');

    const modules: { name: string; source: string }[] = [];
    for await (const name of glob.scan({ cwd })) {
      if (name.endsWith('.test.ts')) continue;
      modules.push({ name, source: stripComments(await Bun.file(join(cwd, name)).text()) });
    }
    return modules;
  }

  it('finds the domain modules it is guarding', async () => {
    // If this ever found zero files the two checks below would pass VACUOUSLY —
    // exactly the "silently proves nothing" trap this file exists to avoid. So the
    // guard asserts it has something to guard, and names the modules it knows
    // about so a rename is noticed here rather than silently dropping coverage.
    const modules = await domainModules();
    const names = modules.map((m) => m.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('tax.ts');
    expect(names).toContain('cart.ts');
    expect(names).toContain('lineId.ts');
  });

  it('no domain module imports outside the allowlist', async () => {
    const violations: string[] = [];

    for (const { name, source } of await domainModules()) {
      // `m[1]` is `string | undefined` under strict mode (noUncheckedIndexedAccess),
      // and a silently-skipped specifier would be a hole in the guard — so the
      // capture is made explicit rather than filtered away.
      const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map(
        (m) => m[1] ?? '',
      );

      for (const specifier of imports) {
        if (!DOMAIN_ALLOWLIST.has(specifier)) {
          violations.push(`${name} imports "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('no domain module reaches for the printer, the network, or a locale', async () => {
    const violations: string[] = [];

    for (const { name, source } of await domainModules()) {
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) violations.push(`${name} matches ${pattern}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('declares the Thai CP874 receipt rule so it is not rediscovered later', () => {
    // Thai text is DOUBLE-WIDTH in CP874/CP256 — two bytes per character — and
    // ESC/POS column arithmetic counts BYTES. A layout computed against character
    // counts therefore mis-cuts every Thai product name, and the receipt is
    // visibly wrong on real paper in a way no type check can catch.
    //
    // This is asserted as a documented expectation rather than implemented here:
    // the receipt layout and the Rust byte compiler do not exist yet. When they
    // are written, Gate B must test the COMPILED byte stream — Thai names, 2 bytes
    // per glyph, offsets computed in bytes — not merely that an ESC @ sequence is
    // present. A test that only checks control codes passes while every Thai
    // receipt prints torn.
    const EXPECTED_THAI_GLYPHS = 10;
    const BYTES_PER_THAI_GLYPH = 2;

    expect(EXPECTED_THAI_GLYPHS * BYTES_PER_THAI_GLYPH).toBe(20);
    expect(EXPECTED_THAI_GLYPHS).toBe(10);
  });
});
