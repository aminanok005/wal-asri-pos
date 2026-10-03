# HANDOVER — GreenTable POS terminal

> **For whoever picks this up next.** Written 2026-10-02 at the end of the
> offline-native foundation. Read this before reading the code: it records what
> is *decided*, what is *proven*, and — more usefully — what is **not finished**.
>
> Verify the state yourself before trusting it:
> ```bash
> bun run verify   # expect 309 pass / 0 fail
> cd apps/pos-desktop/src-tauri && cargo test --locked   # expect 36 pass / 0 fail
> ```

---

## 1. Where the project stands

Three surfaces, all green as of the commit that introduced this file.

| Layer | State | Tests |
|---|---|---|
| Domain (`Money`, `cart`, `tax`, `lineId`, `catalog`) | Complete | `bun test` |
| Storage (`0001_init.sql`) | Complete, enforced | `migrations.test.ts` |
| Native crate (SQLCipher, offline checkout) | Complete | `cargo test` |
| UI (`CartView`, `SalesTerminalView`, `AppShell`) | Present, **not yet connected to the database** | component tests |
| ESC/POS printing | **Not started** | — |
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

## 4. Phase 2A — Native bridge (the next real work)

**Rust side is essentially done.** `save_offline_order` and `list_recent_orders`
exist, are registered in `lib.rs`, and are tested. Do not rewrite them.

What is missing is the **TypeScript ↔ Rust wire**:

1. **Install `@tauri-apps/api`** — not currently a dependency.
2. **Write a Tauri adapter** implementing the `OfflineOrdersRepository` port in
   `application/offlineOrders.ts` (that port exists; only the in-memory adapter
   does).
3. ⚠️ **`i64` crosses as a STRING, never a number.** The Rust structs already
   serialise money as `String` and `parse_satang` rejects anything non-numeric —
   this is deliberate. A JS `number` silently loses precision above 2^53, and
   satang values are `i64` on the wire. `Money.fromSatang` expects `bigint`, so
   the adapter must go `string → bigint` at the boundary.
4. **Keep the in-memory adapter** as a test double — the UI tests must keep
   running without a Tauri runtime.
5. **Add the checkout button** to `SalesTerminalView`, and surface the order
   summary on screen: gross `4550` / net `4252` / tax `298`.

The highest-risk part is (3). It is where an `i64` becomes a `number` by
accident, and the failure is silent until a large order lands.

---

## 5. Phase 2B — ESC/POS printing

Nothing exists yet. Blueprint in `docs/02-design/DOMAIN.md`
("Offline receipt printing").

Three test gates: **A** TypeScript layout → neutral IR · **B** Rust IR → byte
stream · **C** layer guard (already installed).

⚠️ **The trap: Thai is DOUBLE-WIDTH.** Two bytes per glyph in CP874/CP256, but
ESC/POS column arithmetic counts **bytes**. A layout computed against character
counts mis-cuts every Thai product name, and the receipt looks torn on paper in a
way no type check catches. Gate B must assert the **compiled byte stream** — a
10-glyph Thai name is 20 bytes — not merely that `1B 40` is present. A test that
only checks control codes passes while every Thai receipt prints wrong.

Also undecided: CP874 is not in the Rust standard library, so this needs either
a crate (`encoding_rs` exposes `windows-874`) or a hand-written table. That is a
real decision, not an implementation detail.

Byte-level control codes agreed: `1B 40` init · `1B 69` cut ·
`10 14 01 00 05` drawer kick.

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
| **`line_tax = 0` caught stale fixtures** | Enforcing per-order rounding immediately failed 4 Rust tests still carrying the old exclusive numbers. That was the CHECK working. | 36 Rust tests. |
| **`Money.fromSatang` rejects numbers** | Passing a `number` where `bigint` was expected. | Runtime throw — satang never pass through a JS number. |
| **`Bun.Glob.scan` needs a string `cwd`** | Passing a `URL` throws `invalid cwd, not a string`. | `fileURLToPath()` in `layers.test.ts`. |
| **Only Rust's own tests prove the Rust** | `migrations.test.ts` proves the CHECKs are right; nothing proved the code satisfying them was right. | CI `rust` job with `--locked`. |

---

## 8. Toolchain (pinned, deliberately)

| Tool | Version | Why pinned |
|---|---|---|
| Bun | `1.3.14` | 1.4 writes `bun.lock` v2; 1.3.x writes v1, the committed format. A newer runner silently loses the workspace graph. |
| Rust | `1.98.1` | Matches the toolchain the 36 Rust tests were last green on. |
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