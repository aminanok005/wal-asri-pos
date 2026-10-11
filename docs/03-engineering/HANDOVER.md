# HANDOVER — GreenTable POS terminal

> **For whoever picks this up next.** Written 2026-10-02 at the end of the
> offline-native foundation; **updated 2026-10-04** after Phase 2A and Phase 2B
> (ESC/POS byte compiler, CP874 encoding, LAN transport, cash rounding);
> **updated again 2026-10-06** after the UI pass that brought the sales screen
> up to the `GreenTable POS V4.html` reference and added interaction feedback.
> Read this before reading the code: it records what is *decided*, what is
> *proven*, and — more usefully — what is **not finished**.
>
> Verify the state yourself before trusting it:
> ```bash
> bun run verify   # expect 604 pass / 0 fail, then the Rust suite below
> cd apps/pos-desktop/src-tauri && cargo test --locked   # expect 160 pass / 0 fail
> ```
> `bun run verify` now chains the Rust suite (via `test:rust`), so the first
> command covers both sides. The `cargo` invocation is still worth running on its
> own when you want the per-test names.
>
> **The UI has its own guide:** [`UI-GUIDE.md`](./UI-GUIDE.md) — design tokens,
> the CSP traps that silently break a build, the sound catalogue, and which
> interaction rules are already enforced app-wide so nobody adds a second
> opinion.

---

## 1. Where the project stands

Three surfaces, all green as of the commit that introduced this file.

| Layer | State | Tests |
|---|---|---|
| Domain (`Money`, `cart`, `tax`, `lineId`, `catalog`) | Complete | `bun test` |
| Domain (`cashRounding`) | Complete — cash rounding, signed adjustment | `cashRounding.test.ts` |
| Domain (`inventory/quantity`) | Complete — signed milli-unit quantities | `quantity.test.ts` |
| Storage (`0001` + `0002` + `0003`) | Complete, enforced | `migrations.test.ts` |
| Native crate (SQLCipher, offline checkout) | Complete | `cargo test` |
| Native crate (CP874, ESC/POS compiler, TCP transport) | Complete, **no hardware tested** | `cargo test` |
| Native crate (`stock_balances`) | Complete, **no hardware tested** | `cargo test` |
| UI (`CartView`, `SalesTerminalView`, `AppShell`) | Connected to the database | component tests |
| UI chrome (`CatalogBrowser`, `RecentOrdersStrip`) | Complete — tabs, search, cards, recent orders | component tests |
| UI feedback (press, sound, reduced motion) | Complete — see [`UI-GUIDE.md`](./UI-GUIDE.md) | `tickSound.test.ts` |
| ESC/POS printing | Byte compiler + TCP adapter done; **never run against a real printer** | `cargo test` |
| Go backend + sync | **Blocked** | — |

**The single most important fact:** the POS sells offline. Checkout, the receipt
and the cash drawer all work with no network and no server. That is the product,
and most of the architecture exists to protect it.

---

## 2. The money rules (the part to not get wrong)

Prices on the menu are **VAT-inclusive**. ฿45.50 is what the customer pays and
฿2.98 of it is tax.

```
net = round_half_up( gross × 10000 / (10000 + vat_rate_bp) )
tax = gross − net
```

Forward VAT would give ฿3.19 — **a different amount of money, on every sale.**
The direction is not a style preference, which is why it is enforced in three
places (SQL `CHECK`, the domain, the cross-layer test) rather than one.

Also load-bearing:

- **Integer satang everywhere.** `bigint` in TypeScript, `INTEGER` in SQLite.
  No float, no `Intl`. `3 × 0.1 = 0.30000000000000004`.
- **Round-half-up**, chosen deliberately: ties resolve *up*.
- **Rounding happens ONCE per order**, not per line. The sales-tax return is
  filed on receipt totals; the declared figure has to be the figure the receipt
  shows.
- **Service charge is always `0`** (café/retail, not a restaurant).
- `line_tax_satang` is constrained to `0` — rounding is per order.

Full rationale with the worked example: `docs/02-design/DOMAIN.md`,
"Money and tax rules".

---

## 3. Architecture in one picture

```
UI (CartView, SalesTerminalView)      ← may use React, hooks, state
        ↓ calls
Application (offlineOrders.ts)        ← ports/interfaces, no concrete adapters yet
        ↓
Domain (cart.ts, tax.ts, money.ts)    ← PURE. No React/Tauri/SQL/Intl/printer
        ↓ Tauri invoke bridge
Rust adapter (commands.rs, db.rs)    ← SQLCipher, 3-write transaction
        ↓
SQLite (local_orders, local_order_lines, sync_outbox)
```

**The layer rule is directional:** UI may import domain; domain must never
import UI. `layers.test.ts` enforces this for *every* `domain/*.ts` module from
one shared allowlist, so a new module cannot quietly reach for `escpos`,
`@tauri-apps/*`, `react` or `Intl`.

---

## 4. Phase 2A — Native bridge ✅ DONE

**Do not rewrite any of this.** `@tauri-apps/api` is installed and pinned to
2.12.1 to match the Rust Tauri, `tauriOfflineOrders.ts` implements the
`OfflineOrdersRepository` port, the infrastructure boundary guards are in place,
and `SalesTerminalView` has the checkout button, the VAT breakdown and
commit-then-clear behaviour. All satang cross `invoke` as decimal strings and
become `Money(bigint)` at the infrastructure edge.

## 4b. Phase 2B — Printer and cash rounding ⚠️ BUILT, NOT PROVEN ON HARDWARE

Both halves are unit-tested and green, and neither has touched real equipment.

**Byte compiler** — `src-tauri/src/{cp874,escpos}.rs`.
`escpos::compile(ReceiptIr) -> Vec<u8>`, transport-independent.
⚠️ Two corrections to earlier documentation are recorded in the module headers:
Thai is **one** byte per character (not two), and the byte compiler does **not**
visually stack Thai marks — CP874 has no combining mechanism, so that is the
printer's font table. `ESC t 20` is also unverified against Epson's manual; it
lives in one constant (`cp874::THAI_CODE_PAGE_SELECT`) so changing it is a
one-line edit with the tests watching.

**Transport** — `src-tauri/src/{printer_port,printer_commands}.rs`. TCP to a LAN
printer, behind a `PrinterTransport` trait, wrapped in `spawn_blocking` so a
dead IP cannot freeze the UI thread. Tested against a real loopback socket, so
the socket path is genuinely exercised. ⚠️ **`bytes_sent` is not proof that paper
moved** — ESC/POS has no acknowledgement.

**Cash rounding** — `sales/domain/cashRounding.ts`, plus migration
`0002_signed_rounding.sql`. Round-to-nearest, bigint only, zero adjustment for
QR/PromptPay. Migration 0002 is a **full table rebuild** (SQLite cannot ALTER a
CHECK) and had to repair `local_order_lines`' foreign key afterwards; the
reasoning is in that file and the tests in `migrations.test.ts` §8–§9.

**Still outstanding:** a physical printer smoke test, and the `ESC t` value
confirmed against the actual printer model.

---

## 5. Phase 2B — ESC/POS printing

Nothing exists yet. Blueprint in `docs/02-design/DOMAIN.md`
("Offline receipt printing").

Three test gates: **A** TypeScript layout → neutral IR · **B** Rust IR → byte
stream · **C** layer guard (already installed).

⚠️ **The trap, CORRECTED 2026-10-04: Thai is ONE byte per character, not two.**
This file previously said "Thai is DOUBLE-WIDTH — two bytes per glyph in
CP874/CP256" and asked Gate B to assert that a 10-glyph Thai name is 20 bytes.
**That was wrong**, and it was wrong in the expensive direction: `windows-874` is
a single-byte code page, so a layout assuming two bytes per glyph pads receipt
lines at half the necessary width and pushes totals off the right edge of an
80mm roll. `thai_coverage.rs` proves it, including that ๐–๙ (U+0E50–U+0E59) map to
`F0`–`F9`, one byte each. With one byte per character, column arithmetic is
exact rather than approximate — the encoded byte length *is* the cell count.

The general lesson still stands and is still worth Gate B's attention: assert the
**compiled byte stream**, not just that `1B 40` is present. A test that only
checks control codes passes while every Thai receipt prints wrong.

`encoding_rs` was the decision, over a hand-written table — see the reasoning at
the top of `Cargo.toml`.

Control codes actually shipped: `1B 40` init · `1B 74 14` Thai code page ·
`1D 56 42 00` full cut · `1B 70 00 19 FA` drawer kick.

---

## 6. Phase 3 — Go backend (BLOCKED)

**`grit` cannot be installed.** `github.com/aminanok005/grit` returns 404 on the
Go proxy, on GitHub, and on the GitHub API. The account itself resolves (HTTP
200, six public repositories) — the module is simply not public.

Per an explicit standing instruction: **do not substitute another framework, and
do not hand-write a replacement.** The Go backend, `sqlc`, `goose` and the sync
worker stay blocked until someone supplies the correct source, path or access.

Everything above works without it, precisely because the terminal is
offline-first. Do not let this block Phase 2A or 2B.

---

## 7. Traps already hit — read before "fixing" anything

These cost real time. Each one is now covered by a test, so a regression will be
caught; this section exists so nobody re-derives them.

| Trap | What happened | Guard now |
|---|---|---|
| **A half-satang tie is unreachable at 7%** | A rounding test scanned for one, found none, and passed silently behind `if (tie !== null)`. At 700 bp the congruence `gross×10000 ≡ 5350 (mod 10700)` has no solution, because `gcd(10000,10700)=100` does not divide `5350`. | Real fixtures at 2000 bp (gcd 2000 \| 6000): gross 9 → exactly 7.5 → net 8. |
| **Guards that match prose** | A boundary guard flagged its own doc comment for mentioning `setItems`. | `stripComments()` runs before every source scan. |
| **`line_tax = 0` caught stale fixtures** | Enforcing per-order rounding immediately failed 4 Rust tests still carrying the old exclusive numbers. That was the CHECK working. | 36 Rust tests (the suite has since grown). |
| **`Money.fromSatang` rejects numbers** | Passing a `number` where `bigint` was expected. | Runtime throw — satang never pass through a JS number. |
| **`Bun.Glob.scan` needs a string `cwd`** | Passing a `URL` throws `invalid cwd, not a string`. | `fileURLToPath()` in `layers.test.ts`. |
| **Only Rust's own tests prove the Rust** | `migrations.test.ts` proves the CHECKs are right; nothing proved the code satisfying them was right. | CI `rust` job with `--locked`. |
| **Inline `style=` builds fine and renders nothing** | The prototype assigns each tile its gradient with `style="background:linear-gradient(...)"`. `csp: "default-src 'self'"` is enforced by the webview at runtime, so an inline style has no `'self'` source — the build succeeds, the bundle ships, and every card is colourless. | Gradients are tokens in `tokens.css` selected by a class. `CatalogGrid.test.tsx` asserts no tile carries a `style` attribute. |
| **`transition` on a base rule silently kills the shared press feedback** | `catalog-grid.css` declared `transition: border-color …`. A `transition` on a more specific rule REPLACES the app-wide list in `index.css` rather than extending it, so the tap-scale stopped animating — and nothing failed, because the button still worked. | Comments at both declaration sites naming the interaction; the shared list lives only in `index.css`. |
| **An `act()` warning cannot be fixed in `afterEach`** | Adding an async read to `SalesTerminalView` produced 25 act() warnings. Flushing in `afterEach` changed nothing: the warning is emitted when the read settles during the *test body*, which runs before `afterEach`. Confirmed with a throwaway probe test. | `flush()` inside the test body, at every point a screen mounts. `AppShell.test.tsx` is the pattern; 0 warnings is the gate. |
| **A partial audio stub makes sound tests pass while sound is broken** | The Web Audio stub was missing `start`/`stop`, so `playTick`'s try/catch swallowed the TypeError. Oscillators were "recorded" but never started, and the failures pointed at the module rather than the stub. | `tickSound.test.ts` asserts on frequency, envelope and timing — a tone that never plays fails every one of them. |

---

## 8. Toolchain (pinned, deliberately)

| Tool | Version | Why pinned |
|---|---|---|
| Bun | `1.3.14` | 1.4 writes `bun.lock` v2; 1.3.x writes v1, the committed format. A newer runner silently loses the workspace graph. |
| Rust | `1.98.1` | Matches the toolchain the 36 Rust tests were last green on (now 87). |
| cargo / bun | `--locked` / `--frozen-lockfile` | CI must not resolve different dependency versions than were reviewed. |

**Container runtime:** Docker Desktop is installed but its daemon is down. The
engine is native containerd. Use `./dev/wasri` (a namespaced wrapper) —
**never** bare `nerdctl` or `docker`. `nerdctl` without `sudo` fails, and bare
`nerdctl` targets the *other* project's namespace.

---

## 9. Isolation from sibling projects

`wal-asri-pos` is its **own git repository**. It used to sit untracked inside
`/home/nisreen/yt-project`, which contains 18 other projects — including
`pos-walasri/`, which must not be touched. It now has a single commit and **no
remote**, so there is nowhere for it to push by accident.

If a remote is added later, `git remote add origin <url>` is the only step —
and it should point at a repository created for *this* project.

Infrastructure is separated the same way, at three levels: containerd namespace
(`walasri` vs `default`), container names (`wasri-*` vs `pos-*`), and ports
(5433/6380 vs 5432/6379). Details in `dev/DEV-SETUP.md`.

---

## 10. Where to start tomorrow

1. Read `SKILL.md` and `docs/02-design/DOMAIN.md` — especially "Money and tax
   rules", which is normative.
2. Run both gates and confirm the numbers in §1.
3. Phase 2A, starting with `@tauri-apps/api` and the string-satang adapter
   boundary. The Rust side needs no new work.
4. Resist adding a dependency, a rounding rule, or a tax formula that is not
   already recorded here. Each one is a decision with a reason.

## 11. Open decisions (nobody has ratified these)

- **Cash rounding.** Thai baht coins end in 5 satang, so ฿45.50 often needs
  rounding to the nearest payable coin. `rounding_adjustment_satang` exists and
  is `0` everywhere. The policy is undecided.
- **Mobile runtime.** `SKILL.md` says Expo; `ARCHITECTURE-DEMO.md` says Tauri 2
  mobile. They contradict, and the offline-first guarantee depends on which.
- **App split.** One Tauri app with role-based views, or three apps.
- **`taxable_satang` naming.** It now holds the *net* (VAT-exclusive) value,
  which reads oddly when the menu price is inclusive. Renaming to `net_satang`
  would read better at the cost of a wider diff.