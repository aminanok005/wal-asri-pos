/**
 * `lineId.ts` — the cart-line id factory, tested directly.
 *
 * The module is 80 lines with a single export, and it is load-bearing: both
 * callers of `addItem` (`SalesTerminalView` and `CartView`) take their line id
 * from here, and `CartItem.id` is the handle every cart mutation looks its line
 * up by. Two lines sharing an id is not a display defect — it is a cart whose
 * "+" button increments the wrong line. So what is asserted below is the set of
 * properties whose failure surfaces as money moving onto the wrong row.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED, AND WHY
 *
 * - No wall clock, no randomness. The module's header pins "no clock, no
 *   `crypto`"; no behavioural test can tell a clock that happens to be constant
 *   from no clock at all, so the `domain boundary` block below reads the source,
 *   which is the only place that promise is falsifiable.
 * - No literal first id. `nextCartLineId` increments before it returns, so the
 *   first value depends on how many ids the module has already minted. Every
 *   assertion here is relative — a difference, a delta, an ordering — and none
 *   of them names a starting value.
 * - The counter is MODULE-GLOBAL and unresettable, so it is shared by every
 *   `describe` in this file and, if the runner reuses one registry across
 *   files, by other files too. That is exactly why nothing below depends on
 *   where it starts, and why this file passes in any execution order.
 * - "A brand-new module registry continues the sequence" is NOT tested. The repo
 *   has no module-reset machinery, and a second `import()` of one specifier is a
 *   cache hit, not a fresh registry, so a test claiming otherwise would be
 *   theatre. The mechanism it depends on is pinned instead: the counter is
 *   declared once at module scope, and nothing can reach or rewind it.
 *
 * @see ./lineId.ts — the module under test
 * @see ./cart.test.ts — the cart, whose duplicate-id handling is pinned there
 */

import { describe, expect, it } from 'bun:test';
import { Money } from '../../payments/domain/money';
import { addItem, createCart, findItem, lineCount, updateQuantity } from './cart';
import type { ProductVariant, UuidV7 } from './cart';
import * as lineIdModule from './lineId';
import { nextCartLineId } from './lineId';

// ─────────────────────────────────────────────────────────────────────────────
// Reading the module's own source
//
// The shape assertions below are driven off the constants `lineId.ts` actually
// contains rather than off copies written here. If the prefix or the padding
// width ever changes, these tests follow the change and still catch a mismatch
// between what the module documents and what it returns. A remembered constant
// would do the opposite: fail for the wrong reason, or be "fixed" by editing
// the test to match the bug.
// ─────────────────────────────────────────────────────────────────────────────

let sourceText: Promise<string> | undefined;

/** `lineId.ts` as text. Read once per file, then reused. */
function readSource(): Promise<string> {
  sourceText = sourceText ?? Bun.file(new URL('./lineId.ts', import.meta.url)).text();
  return sourceText;
}

/**
 * Strip comments so a guard matches CODE, not prose.
 *
 * `lineId.ts` names React, Tauri, `crypto` and the clock in its header in order
 * to explain why it uses none of them. Without stripping, the guards written to
 * prove those are absent would fail on the very paragraphs that document the
 * rule, and the obvious "fix" would be to delete the explanation. Copied from
 * `../layers.test.ts`, which enforces the same idea one layer up.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, but not `https://`
}

/** The module's code: comments removed, so a guard cannot match prose. */
async function readCode(): Promise<string> {
  return stripComments(await readSource());
}

/**
 * The fixed UUID prefix the module's template literal actually contains —
 * `018f3c2a-0000-7000-8000-` as it stands today.
 *
 * Pulled from the source rather than written out, so this test fails if the
 * prefix stops being a UUID at all and keeps working if a future adapter
 * legitimately changes it.
 */
async function declaredPrefix(): Promise<string> {
  const prefix = /`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})-\$\{/.exec(await readCode())?.[1];
  if (prefix === undefined) {
    throw new Error('lineId.ts no longer builds its id from a fixed UUID prefix plus a counter');
  }
  return prefix;
}

/**
 * The zero-padding width the module applies to the counter — `padStart(12, '0')`
 * today. `Number(undefined)` is `NaN`, so a missing `padStart` throws here
 * rather than quietly asserting against a width of 0.
 */
async function declaredWidth(): Promise<number> {
  const width = Number(/padStart\((\d+)/.exec(await readCode())?.[1]);
  if (!Number.isInteger(width)) {
    throw new Error('lineId.ts no longer zero-pads its counter with padStart');
  }
  return width;
}

/**
 * The trailing counter field of an id, kept as text.
 *
 * Text, not a number, so the width assertions can still see it: a counter that
 * outgrew its field shows up as a *shorter* string than the layout promises, and
 * a `Number` would have thrown exactly that information away.
 */
function counterField(id: UuidV7): string {
  const field = id.split('-')[4];
  if (field === undefined) {
    throw new Error(`id ${id} has no fifth field to read a counter from`);
  }
  return field;
}

/**
 * The body of `nextCartLineId` as source text, closing brace included.
 *
 * Read structurally rather than matched inline so the two guards that need it
 * cannot drift apart, and so a rewrite that moves the body fails with a sentence
 * instead of a bare regex diff.
 */
function functionBody(code: string): string {
  const body = /export function nextCartLineId[\s\S]*?\n\}/.exec(code)?.[0];
  if (body === undefined) {
    throw new Error('lineId.ts no longer declares nextCartLineId in the shape these guards read');
  }
  return body;
}

/**
 * How many consecutive ids the uniqueness and ordering tests mint.
 *
 * A per-component counter — the bug this module exists to prevent — collides on
 * its *second* id, so a batch of three would already catch it. 1500 is chosen so
 * the batch is also meaningful for the subtler failures: a counter re-seeded
 * part-way through, a cache handing back a stale value, a step that only goes
 * wrong once the sequence crosses a digit boundary. It costs 1500 short string
 * builds, which is nothing next to the cost of the bug.
 */
const BATCH = 1500;

/** Mint `count` ids in call order. */
function mintBatch(count: number): UuidV7[] {
  const ids: UuidV7[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(nextCartLineId());
  }
  return ids;
}

/**
 * Build a minimal but valid `ProductVariant` — the argument `addItem` is typed
 * against. Only the fields the cart reads are meaningful; the rest exist to
 * satisfy the contract type. Two variants with different ids, because `addItem`
 * merges on `variant.id` and a test about id collision needs two real lines.
 */
function variant(id: string, sku: string, nameTh: string): ProductVariant {
  return {
    id: id as UuidV7,
    product_id: '018f3c2a-0000-7000-8000-000000000001' as UuidV7,
    sku,
    barcode: null,
    name_th: nameTh,
    name_en: null,
    size: null,
    image_url: null,
    is_active: true,
    version: 1,
    created_at: '2026-10-02T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  };
}

const LATTE = variant('018f3c2a-0000-7000-8000-00000000000a', 'BEV-LATTE', 'ลาเต้');
const MOCHA = variant('018f3c2a-0000-7000-8000-00000000000b', 'BEV-MOCHA', 'มอคค่า');

describe('nextCartLineId: the shape the module documents', () => {
  it('stamps every id with the fixed v7 prefix the source declares', async () => {
    const prefix = await declaredPrefix();
    const fields = prefix.split('-');

    // A `7` in the version nibble and an `8` in the variant nibble are what make
    // this a v7 rather than a v4 written by hand. Asserted against the parsed
    // prefix, so the claim is about the string that actually ships and not about
    // a comment describing it.
    expect(fields[2]?.startsWith('7')).toBe(true);
    expect(fields[3]?.startsWith('8')).toBe(true);

    for (const id of mintBatch(3)) {
      expect(id.startsWith(`${prefix}-`)).toBe(true);
    }
  });

  it('lays the id out as 8-4-4-4-N with the counter padded to the declared width', async () => {
    const prefix = await declaredPrefix();
    const width = await declaredWidth();
    const layout = new RegExp(`^${prefix}-\\d{${width}}$`);

    for (const id of mintBatch(3)) {
      // A counter wider than its field would break the layout, and with it the
      // promise that string order equals numeric order. `padStart` only ever pads,
      // so a 13th digit is the one way this could fail — and it is asserted
      // rather than assumed, because 10^12 is close to nothing in real terms yet
      // is exactly the kind of boundary that is never exercised by hand.
      expect(id).toMatch(layout);
    }
  });

  it('never returns a zero or unpadded counter', async () => {
    const width = await declaredWidth();

    for (const id of mintBatch(3)) {
      const field = counterField(id);
      expect(field).toHaveLength(width);
      // The counter is incremented BEFORE it is stringified, so an all-zeroes
      // field would mean the id had been built from the pre-increment value —
      // and two calls one apart would then hand out the same id.
      expect(BigInt(field)).toBeGreaterThan(0n);
    }
  });

  it('takes no arguments and cannot fail — it runs inside a click handler', () => {
    // `nextCartLineId` is the whole API: no variant, no timestamp, no prefix to
    // pass in. A zero-arity signature is the type-level proof that the id depends
    // on call order and on nothing the caller knows. And it is total by contract:
    // a till that has to keep taking money cannot be handed a throwing id.
    expect(nextCartLineId.length).toBe(0);
    expect(() => nextCartLineId()).not.toThrow();
  });
});

describe('nextCartLineId: one counter, one sequence', () => {
  it(`mints ${BATCH} ids in a row with zero duplicates`, () => {
    const ids = mintBatch(BATCH);

    // The whole reason the counter lives in a shared module rather than beside
    // either caller. `CartItem.id` is the handle `updateQuantity` and `removeItem`
    // look a line up by, so a repeat here is a quantity button that acts on the
    // wrong line — not a cosmetic defect.
    expect(new Set(ids).size).toBe(BATCH);
  });

  it('advances the counter by exactly one on every call, with no wrap and no repeat', () => {
    const counters = mintBatch(BATCH).map((id) => BigInt(counterField(id)));
    const first = counters[0] ?? 0n;
    const consecutive = counters.map((_, index) => first + BigInt(index));

    // A repeat is worse than an unordered id, and that is why this asserts the
    // strong form. An id that is merely out of order still identifies exactly one
    // line — `findItem` compares with `===` — so the cart stays correct and the
    // v7's time ordering degrades to a nicety. An id that REPEATS identifies two
    // lines and no consumer can tell which one it meant: `updateQuantity` finds
    // the first match and increments someone else's mocha. So every call must
    // advance by exactly 1, which rules out a repeat, a skip and a wrap in one
    // assertion. `toEqual` on a 1500-long array names the first index that broke,
    // which is the difference between a debuggable failure and a red cross.
    expect(counters).toEqual(consecutive);
  });

  it('keeps the batch in call order when the ids are sorted as plain strings', () => {
    const ids = mintBatch(BATCH);

    // Fixed-width zero padding is what makes lexicographic order equal numeric
    // order, which is the ordering a v7 promises whatever consumes it. Drop the
    // padding and '…0000000010' sorts before '…0000000009', so a string-sorted
    // list of lines would quietly reorder itself. Nothing about the cart depends
    // on that today; the next thing that sorts ids by string will.
    expect([...ids].sort()).toEqual(ids);
  });

  it('changes only the counter between two calls in a row', () => {
    const first = nextCartLineId();
    const second = nextCartLineId();

    // No clock, no entropy, no argument: two consecutive calls differ in the
    // counter field and in nothing else — same prefix, same length, same
    // four leading fields. If any other field moved, something time- or
    // randomness-derived had crept in, and the id would no longer be a function
    // of call order alone.
    expect(second).not.toBe(first);
    expect(second.length).toBe(first.length);
    expect(second.split('-').slice(0, 4)).toEqual(first.split('-').slice(0, 4));
    expect(BigInt(counterField(second))).toBe(BigInt(counterField(first)) + 1n);
  });
});

describe('nextCartLineId: the counter belongs to the module', () => {
  it('keeps the sequence in the module, not in the caller', async () => {
    // Honest scope, stated up front: a second `import()` of the same specifier is
    // a cache hit, not a fresh module registry, so this does NOT prove what a
    // remount does. What it does prove is the part a remount depends on — the
    // counter is state on the module, so every caller that reaches it by any
    // import shares ONE sequence and the two production callers cannot mint the
    // same id. Testing the fresh-registry half would need module-reset machinery
    // this repo does not have; the two blocks below pin the mechanism instead.
    const reimported = await import('./lineId');
    expect(reimported.nextCartLineId).toBe(nextCartLineId);

    const before = nextCartLineId();
    const after = reimported.nextCartLineId();
    expect(BigInt(counterField(after))).toBe(BigInt(counterField(before)) + 1n);
  });

  it('exports the minting function and nothing else, so no caller can rewind it', () => {
    // The counter is private on purpose: a caller that could reset it would hand
    // out an id the basket already holds, which is the exact collision this
    // module exists to prevent. A single export puts that out of reach by
    // accident, and this assertion fails loudly the day a second one appears.
    expect(Object.keys(lineIdModule)).toEqual(['nextCartLineId']);
  });

  it('declares the counter once, at module scope, and increments it in the function', async () => {
    const code = await readCode();

    // Component state would restart at zero on every mount, and a controlled cart
    // can outlive any single mount of the panel — the parent may rebuild the
    // panel while the basket keeps its lines — so uniqueness has to last for the
    // lifetime of the process, not of a mount. One module-scope declaration is
    // what gives that. TWO declarations would be the original bug: each would
    // hand its first line the same id, from two files that never meet.
    expect(code.match(/^let lineCounter\b.*$/gm) ?? []).toHaveLength(1);
    expect(code.indexOf('let lineCounter')).toBeLessThan(code.indexOf('export function nextCartLineId'));

    // …and the declaration has to be OUTSIDE the function. A `let lineCounter`
    // in the body would satisfy a count of one while restarting the sequence on
    // every call, which is the subtlest version of the failure there is.
    const body = functionBody(code);
    expect(body).toContain('lineCounter += 1');
    expect(body).not.toContain('let lineCounter');
  });

  it('has no failure path: the body increments and returns, and does nothing else', async () => {
    const body = functionBody(await readCode());

    // This runs inside a click handler on a till that has to keep taking money,
    // so the function is total by contract: no branch, no throw, no loop, no
    // second return. A condition in here is a condition under which no id gets
    // minted, and the caller has no way to notice except a line missing from the
    // screen. Stated as a guard because the docstring promising totality is not
    // the same as the code having none.
    expect(body).not.toMatch(/\b(if|throw|try|for|while|switch)\b/);
    expect(body.match(/return /g) ?? []).toHaveLength(1);
  });
});

describe('nextCartLineId: ids the cart accepts', () => {
  it('hands addItem a line id the cart keeps and can find', () => {
    const id = nextCartLineId();
    const cart = addItem(createCart(), LATTE, 1n, Money.fromSatang(4550n), id);

    // Legality here is the ABSENCE of a check, not the presence of one: `addItem`
    // validates quantity, price and `is_active`, and stores `itemId` verbatim, so
    // whatever this module returns becomes the handle. This round trip is the
    // smallest honest statement that a generated id is usable as a line id. A
    // hand-written id proves nothing about the generator; `cart.test.ts` already
    // covers the cart's own validation for those.
    expect(lineCount(cart)).toBe(1);
    expect(findItem(cart, id)?.id).toBe(id);
  });

  it('keeps two consecutive ids on separate lines, so "+" can only move its own line', () => {
    // The bug this module exists to prevent, stated as behaviour. `updateQuantity`
    // finds a line by `===`, so two lines sharing an id would mean pressing
    // "+ กาแฟลาเต้" on the second line increments the first. `cart.test.ts` covers
    // merging a repeated variant and keeping distinct variants apart, both with
    // hand-written ids; only the generator can promise that two ids minted back to
    // back are not the same id.
    const latteId = nextCartLineId();
    const mochaId = nextCartLineId();
    let cart = addItem(createCart(), LATTE, 1n, Money.fromSatang(4550n), latteId);
    cart = addItem(cart, MOCHA, 1n, Money.fromSatang(6000n), mochaId);

    expect(lineCount(cart)).toBe(2);

    const after = updateQuantity(cart, mochaId, 3n);
    expect(findItem(after, mochaId)?.quantity).toBe(3n);
    expect(findItem(after, latteId)?.quantity).toBe(1n);
  });

  it('keeps advancing past an id the cart discarded when a repeat variant merged', () => {
    // Documented in the function's own docstring: a repeat scan merges and returns
    // before the id is used, so the sequence runs ahead of the number of rows on
    // screen. That is only safe because a discarded id is never reissued — the
    // next call is a fresh value, not a replay of the merge.
    const first = nextCartLineId();
    const discarded = nextCartLineId();
    const once = addItem(createCart(), LATTE, 1n, Money.fromSatang(4550n), first);
    const merged = addItem(once, LATTE, 1n, Money.fromSatang(4550n), discarded);

    expect(lineCount(merged)).toBe(1);
    expect(findItem(merged, discarded)).toBeUndefined();
    expect(nextCartLineId()).not.toBe(discarded);
  });

  it('returns the contract UuidV7 type rather than a string it asserts into one', async () => {
    // `UuidV7` is the generated contract type, re-exported by `cart.ts`, and it is
    // the declared RETURN type — not only a cast at the end of the template. A
    // cast alone would leave a caller free to build its own line id by hand,
    // which is the second way two counters end up in one process.
    const code = await readCode();
    expect(code).toContain("import type { UuidV7 } from './cart'");
    expect(functionBody(code)).toMatch(/export function nextCartLineId\(\): UuidV7/);
  });
});

describe('nextCartLineId: domain boundary', () => {
  it('reads neither the clock nor crypto, and imports nothing from a framework', async () => {
    const code = await readCode();

    // The header claims "no React, no Tauri, no clock, no `crypto`" and then
    // explains at length why: this is a placeholder for a Rust adapter. Behaviour
    // cannot check that claim — a clock read that happened to be constant would
    // look identical to no clock at all — so the source is the only place the
    // promise is falsifiable. It matters because an id that varied with time would
    // not be a function of call order, and the uniqueness argument above would
    // quietly become an assumption about the clock's resolution instead.
    expect(code).not.toMatch(/from ['"]react['"]/);
    expect(code).not.toMatch(/@tauri-apps/);
    expect(code).not.toMatch(/@tanstack/);
    expect(code).not.toMatch(/zustand/);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/from ['"]node:/);
    expect(code).not.toMatch(/\bDate\b/);
    expect(code).not.toMatch(/performance\./);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/\bcrypto\b/);
    expect(code).not.toMatch(/randomUUID/);
  });
});
