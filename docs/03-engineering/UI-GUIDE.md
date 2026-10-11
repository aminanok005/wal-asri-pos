# UI GUIDE — GreenTable POS terminal

> Design tokens, interaction rules, feedback, and the traps that make a build
> succeed while the screen is broken. Read this before adding a component.
> `HANDOVER.md` covers the money rules and the architecture; this covers
> everything above the domain layer.
>
> **Reference:** `GreenTable POS V4.html` at the repo root is the agreed visual
> target. Its palette is already verbatim in `tokens.css`.

---

## 1. The one rule that shapes everything else

**The webview runs under `csp: "default-src 'self'"`.**

This is enforced by the *webview at runtime* — not by a linter, not by a build
step. The failure mode is nasty and quiet: the build succeeds, the bundle is
produced, and the till renders wrong with only a console message nobody is
watching.

Under that policy:

| Blocked | Do instead |
|---|---|
| `<script>` inline | Bundle entry only |
| `style="…"` on any element | A CSS class |
| `<style>` blocks | `*.css` files imported by `index.css` |
| `<link>` to a CDN (fonts, polyfills) | Vendor into `src/` and import |

**In React, `style={{ … }}` is the trap.** It compiles, it passes typecheck, and
it renders nothing. It is the reason the menu tiles pick their gradient from a
class hashed off the variant id rather than from an inline colour pair.

Verify before committing:

```bash
grep -rn "style={{" src/ index.html   # must print nothing
```

---

## 2. Where CSS lives

`features/sales/ui/styles/index.css` is the **only** import point. `main.tsx`
imports that file and nothing else, so stylesheet load order is decided in one
readable place rather than by whichever component mounts first.

Order is dependency order: **tokens → components → screens.**

```
tokens.css                    design system; every colour and tap size
catalog-grid.css              menu tiles
catalog-browser.css           tabs + search  (wraps the grid)
recent-orders-strip.css       recent orders band
cart-view.css                 basket panel
sales-terminal.css            screen chrome
offline-orders.css            history screen
```

A new component stylesheet is `@import`ed into `index.css`, never
`import './styles/x.css'` from inside the component.

---

## 3. Design tokens

Everything resolves to `tokens.css`. **No component stylesheet declares a hex
code.**

```css
--bg --card --ink --mut --line      surfaces and text
--acc --accs                         the accent, and its soft background
--danger --ok --oks --warn --warns   state colours
--tap --tap-sm --tap-pay             48px / 44px / 56px
--tile-grad-1-from … --tile-grad-6-from   menu-tile gradients (+ -to)
```

The palette is copied verbatim from the prototype. `--warn`/`--warns` were added
for **low-stock indication** and are deliberately **not consumed yet** — that is
the seam for the inventory work, and borrowing `--acc` for a stock warning would
put a warning colour on the pay button.

Dark mode is two blocks — `@media (prefers-color-scheme: dark)` with
`:not([data-theme='light'])` and `:root[data-theme='dark']`. **Adding a token
means adding it to both**, or it will not follow the theme.

---

## 4. Interaction rules — already enforced app-wide

These live in `index.css` and apply to every control. **Do not re-declare them
per component.**

| Rule | Why |
|---|---|
| `touch-action: manipulation` | Without it a touchscreen browser waits ~300 ms to check for double-tap zoom before firing `click`. On a till sold as "quick tapping", that delay is on every press. `auto` would kill pinch-zoom — don't use it. |
| `-webkit-tap-highlight-color: transparent` | The grey OS flash otherwise fires on top of the app's own pressed state. |
| `:active { transform: scale(0.97) }` | Until this existed, a tap produced **no** press feedback at all — the button did nothing visible until the basket updated a frame later. |
| `transition` on the base rule | So the *un-press* animates too. A `transition` only on `:active` makes the control snap back and the press read as a flicker. |
| `:focus-visible` | A cashier who cannot see where they are while tabbing cannot sell. |

### The trap that will bite you

**A `transition` on a more specific rule REPLACES the app-wide list; it does not
extend it.**

```css
/* WRONG — kills the tap-scale, and nothing fails */
.catalog-grid__tile-button {
  transition: border-color 0.15s ease;
}
```

Name only the properties that are genuinely component-specific, and put a comment
saying why `transform` is absent. Both current sites
(`catalog-grid.css`, `sales-terminal.css`) do.

### Layout properties are not animatable here

Only `transform`, `opacity`, `background-color`, `border-color` and `color`.
Animating `width`, `height`, `margin` or `top` forces a layout recalculation on
the element and often its whole subtree — on a grid of tiles that is the opposite
of fast.

---

## 5. Motion

`prefers-reduced-motion: reduce` is honoured app-wide in `index.css` and
repeated per component sheet. It disables `transition` and `animation` with
`!important` **and** resets `scroll-behavior` to `auto`.

`scroll-behavior: smooth` is set **only** inside
`@media (prefers-reduced-motion: no-preference)`. Smooth scrolling is exactly the
kind of motion that triggers vestibular symptoms — it moves a large area of the
screen a large distance.

### Scrollbars are not a global decision

| Strip | Scrollbar | Why |
|---|---|---|
| Category tabs | **`thin`, visible** | A category may exist off the right edge. A cashier who cannot tell has no way to know to swipe, and a menu with a hidden category looks complete. |
| Recent-orders chips | `none` | Supplementary; their absence costs nothing. |

---

## 6. Sound

`features/sales/application/tickSound.ts`. **Synthesised, not sampled — there is
no audio file anywhere in this repository, by design:**

1. The CSP would block a fetched asset.
2. SKILL.md §2.2 requires a sale to complete offline. Feedback that depends on a
   network call fails exactly when the branch's connection does.

A tone is an oscillator, a gain envelope and a stop. Nothing loads, so nothing
can fail to load. **Bundle cost: zero.**

| Sound | Where | Pitch | Means |
|---|---|---|---|
| `add` | grid tile, cart `+` | 880 Hz, 50 ms | a line landed |
| `remove` | cart `−`, ลบ, ล้างตะกร้า | 587 Hz, 50 ms | a line went away |
| `success` | **immediately after `save` resolves** | 784 → 1046 Hz, rising | money committed |
| `error` | **`save` rejected** | 330 Hz, 180 ms | commit refused |

### Why only four

A sound on every control is the fastest way to make a POS unpleasant — the till
runs eight hours, and a beep per keystroke in a search box is an irritation by
lunchtime. Sound is spent only where it carries information the screen does not
already show plainly.

**Deliberately silent:** tab changes, typing, navigation, and the print warning.
A print warning is a second, quieter problem and it gets the screen, not an
alarm.

### Three rules for adding a sound

1. **After the outcome, not on the press.** `success` fires after `save`
   resolves. A success tone on the press, before the money is safe, announces a
   sale that could still fail.
2. **Never between the cashier and a sale.** `playTick` is total — no audio
   device, a suspended context, a refused resume, all return normally. Sound is
   feedback, never a precondition for a transaction.
3. **`error` means money.** It is the only sound that fires on a failed commit,
   and it is deliberately unpleasant. If it ever gets ignored, that is the day a
   sale is rung up and believed and is not in the shift report.

---

## 7. Accessibility rules already decided

- **Thai `lang="th"`** on `<html>` — it selects pronunciation rules. English
  rules mispronounce Thai badly enough to be unusable for a blind cashier.
- **Line-height ≥ 1.5** on any text that can hold Thai. Thai stacks a vowel or
  tone mark ABOVE its consonant in a taller glyph box; Latin-tight line-height
  clips the mark on a name like `กาแฟ`.
- **Mutually exclusive choices are radio groups** — `<fieldset>` + `<legend>` +
  real `<input type="radio">` + `:has(input:checked)`. Not two buttons with
  `aria-pressed`, which announces "two independent toggles". The sales screen
  uses this for both payment method and fulfilment.
- **Nav and tab bars are plain `<button>`s with `aria-current`**, not
  `role="tab"`. `role="tab"` obliges its author to supply a `role="tabpanel"`
  wired with `aria-labelledby`, and the menu grid is not one.
- **A placeholder is not a label.** Every input has a real `<label>`; visually
  hidden with `clip-path`, never `display: none`, which removes it from the
  accessibility tree entirely.
- **Searchable names, decorative content marked.** A tile's `aria-label` is the
  item and nothing else; its quantity badge is `aria-hidden`.
- **Exactly one `aria-current`** in any nav. Two current items is a nav telling
  a screen reader the till is on two screens at once.

---

## 8. Things deliberately absent from the UI

Every one of these is in the reference and is **not** here, because the contract
has no field for it. **Do not add one from a hardcoded string** — that is a
number no system computed, and it will disagree with the server the first time
someone changes it there.

| Reference shows | Why absent |
|---|---|
| `🔥 380 kcal`, `⏱ 10 นาที` | `ProductVariant` carries neither |
| `BESTSELLER` badge | not a contract field |
| `-25%` promo badge | a discount is resolved at checkout; the list price stays comparable across periods |
| Promo banner carousel | no campaign entity |
| Per-order progress ring | no per-order progress exists to render |
| Card-flip quantity stepper | deferred — a second control per item, and a third path into the cart |

If one of these is wanted, it is a **contract edit**: change
`contracts/openapi.yaml`, run `bun run generate:types`, then build the UI.

---

## 9. Before you commit

```bash
bunx tsc --noEmit     # clean
bun test              # 604 pass / 0 fail, and ZERO act() warnings
bun run build         # ✓
grep -rn "style={{" src/ index.html   # must print nothing
```

The act() warning count is a real gate, not noise. A warning on every run
teaches a reader to ignore the file's output, which is how a genuine one goes
unnoticed. If adding an async read makes one appear, `flush()` **inside the test
body** — not in `afterEach`, where it is too late.