# GreenTable POS — Go Backend (`services/api-backend`)

The **authoritative server** for the GreenTable POS ecosystem. The POS terminal
sells offline; this service is what makes those sales real — it re-prices them,
deduplicates them, and owns the catalogue.

> **Status: domain + application core is complete and tested. It serves one
> endpoint.** See [§ What is not built](#what-is-not-built) — the reasons are
> recorded, not excuses.

```bash
go build ./...   # clean
go vet ./...     # clean
go test ./...    # 9 packages, all green
go run ./cmd/api # listens on :8080
```

**Go 1.25** · **standard library only** · **zero network access to build**

---

## 1. The four architecture rules, and where each one lives

| Rule | Where it is enforced | Guarded by |
|---|---|---|
| **VAT-inclusive, per-order, round-half-up** | `internal/money/domain/vat.go` | `vat_test.go` — the ฿45.50 worked example, plus the forward-VAT figure asserted *for contrast* |
| **Money is integer satang (`int64`), never float** | `internal/money/domain/satang.go`, `quantity.go` | `architecture/layers_test.go` — source scan fails the build on `float32`/`float64` in a money file |
| **Clean Architecture folder layout** | every `internal/<module>/{domain,usecase,adapter}` | `architecture/layers_test.go` — walks every module, so a new one is checked automatically |
| **Sync Outbox Lifecycle, 4 states + Idempotency-Key** | `internal/sync/domain/outbox.go`, `idempotency.go` | `sync_test.go` |

---

## 2. Layout

```
services/api-backend/
├── go.mod                              module `wal-asri-pos/services/api-backend`, Go 1.25, NO requires
├── cmd/api/main.go                     composition root — the only place usecase + adapter meet
├── db/
│   ├── migrations/                     EMPTY — see § What is not built
│   └── queries/                        EMPTY — reserved for sqlc
└── internal/
    ├── money/domain/                   ← SHARED KERNEL
    │   ├── satang.go                     Satang (int64), round-half-up division, JSON guards
    │   ├── quantity.go                   Quantity — exact 3dp decimal as milli-units
    │   └── vat.go                        SplitInclusiveVAT — the ratified accounting rule
    ├── identity/domain/                ← SHARED KERNEL
    │   └── uuidv7.go                     parse, validate, compare, embedded timestamp
    ├── sync/domain/                    cross-cutting: outbox lifecycle + idempotency
    ├── catalog/
    │   ├── domain/                       Category, Product, ProductVariant, PriceListEntry,
    │   │                                 Sellable (the 2-row rule), PriceResolver, SyncCursor
    │   ├── usecase/                      GetCatalog + the CatalogRepository PORT
    │   └── adapter/
    │       ├── http/                     GET /catalog — the contract's only catalogue endpoint
    │       └── postgres/                 SKELETON — shape + SQL pinned, body returns ErrNotImplemented
    ├── order/
    │   ├── domain/                       Order, OrderLine, OrderLineModifier, Totals,
    │   │                                 the 8-rung append-only status ladder
    │   ├── usecase/                      IngestOrder — dedup → re-price → refuse → commit
    │   └── adapter/
    │       ├── http/                     EMPTY ON PURPOSE — see § The contract gap
    │       └── postgres/                 SKELETON — includes the VAT CHECK constraints verbatim
    └── architecture/
        └── layers_test.go               the Go twin of the terminal's layers.test.ts
```

### Why two packages are `domain/` only

`money` and `identity` are **shared kernels**: value-object libraries with no
application logic and no I/O. Giving them an empty `usecase/` and `adapter/` would
imply a boundary they do not have.

They exist as separate packages because `catalog` and `order` both need them, and a
VAT rule or an identifier implemented twice would be a rule implemented twice.
`layers_test.go` holds them to the same domain rules as the business modules —
"it is just a helper package" is exactly how a domain layer stops being pure.

---

## 3. The money rules

Prices are **VAT-inclusive**. ฿45.50 on the menu is ฿45.50 paid, and ฿2.98 of it
is tax. The tax is therefore **extracted** from a known gross, never computed
forward from a net:

```
net = round_half_up( gross × 10000 / (10000 + vat_rate_bp) )
tax = gross − net
```

| step | value |
|---|---|
| gross | `4550` (฿45.50) |
| net = `round_half_up(4550 × 10000 / 10700)` = `round_half_up(4252.336)` | `4252` |
| tax = `4550 − 4252` | `298` (฿2.98) |

Forward VAT would give `4550 × 700 / 10000 = 319` (฿3.19) — a **different amount
of money, wrong on every sale**, filed on the ภ.พ.30 return.
`TestSplitInclusiveVAT_ForwardVatWouldGiveADifferentAmount` pins that contrast so
"simplifying" the formula fails a test rather than a tax document.

**One rounding point per order.** The division that extracts the net is the only
place a fraction can appear, so it is the only place rounding is decided. Per-line
rounding would round up to seven times on a seven-line order and the sum of those
parts is not the VAT owed:

> 7 × ฿45.50, per-order extraction → tax **2084** satang.
> 7 × ฿45.50, per-line summed → tax **2086** satang. **2 satang too high.**

`TestComputeTotals_VatIsExtractedOncePerOrderNotOncePerLine` asserts both figures
so the difference is explicit rather than folklore.

`OrderLine` therefore has **no tax field at all** — `LineTaxIsAlwaysZero` is a
`const 0`, so no code path can produce a per-line tax. A second, differently
rounded copy of money the order total already contains is not computable here by
construction.

### The identity that must always hold

```
taxable (net) + tax === total − service charge − rounding adjustment
```

`Totals.Validate()` re-checks all four SQL `CHECK` constraints from
`docs/02-design/DOMAIN.md` and is exported so an ingest path can verify a client's
claimed totals without recomputing them.

---

## 4. The server re-validates; it does not trust, and it does not correct

`IngestOrder.Execute` is the most safety-critical code here. An order arrives from
a device that has been offline, carrying its own ids, its own pricing and its own
tax figure.

1. **Deduplicate** — look the hashed key up *first*. A live record means return
   the stored response and do nothing else, not even re-validate.
2. **Re-price** — read the branch's **own** `vat_rate_bp` and recompute from the
   order's *lines*. Never from the client's total, never from a client-supplied
   rate.
3. **Refuse a mismatch** — a terminal running a stale rate produces an order the
   server will not accept, and will not silently "fix":

   ```go
   if claimed.TotalSatang != authoritative.TotalSatang ||
      claimed.TaxSatang()   != authoritative.TaxSatang() {
       return i.holdForConflict(...)   // STORED as CONFLICT_HELD, not dropped
   }
   ```

   The sale really happened and the money is real, so it is **held for review**
   rather than discarded. Silently correcting it would produce a receipt that
   disagrees with the ledger, which is worse than a rejected order a cashier can
   re-ring.
4. **Commit, then record** — the idempotency record is written *last*, so a crash
   between the append and the save leaves a duplicate to be re-applied rather than
   a result to be lost.

---

## 5. Sync Outbox Lifecycle

```
PENDING ──► IN_FLIGHT ──┬──► ACKNOWLEDGED   (committed; terminal may prune)
                        └──► CONFLICT_HELD   (stored, deliberately not applied)
```

`CONFLICT_HELD` is why this is not a boolean. *"Did it arrive?"* and *"did it take
effect?"* are different questions; collapsing them either loses work or applies it
twice.

**This is not the terminal's local outbox.** That one (`sync_outbox` in
`0001_init.sql`) uses `pending | in_flight | done | failed_permanent` and answers
*"has my terminal handed this to the network?"*. This one answers *"has this
server durably accepted it?"*. A submission can leave the terminal's outbox
(`done`) and still be `IN_FLIGHT` here, because a 2xx the terminal never received
is indistinguishable from a crash.

**Idempotency-Key** is the duplicate-order interceptor. The terminal cannot tell a
lost response from a crash, so it retries — and that retry must be a *successful
no-op* returning the **original response**, not a recomputed one. Recomputing is
wrong in a way that is not obvious: pricing depends on the VAT rate at the moment
of the *original* sale, so replaying the maths today could return a different total
for an order already charged.

Keys are stored **hashed** (SHA-256 over branch ‖ key). A raw client-supplied key
in an index is a lookup oracle, and the branch scope stops two branches colliding
on a reused key.

---

## 6. The layer guard

`internal/architecture/layers_test.go` is the Go counterpart of the terminal's
`layers.test.ts`, and it exists because that file's own note is right: a
hand-written test per file is how new modules escape.

- `domain/` may not import `database/sql`, `net/http`, an ORM, `context`, `sync`,
  another module's `usecase`/`adapter`, or `cmd/`.
- `usecase/` may not import its own `adapter` — the arrow points adapter → usecase.
- No `float32`/`float64` in any non-test file that declares money fields.
- Exactly **one** Go implementation of the VAT extraction, in
  `money/domain/vat.go`.
- Every module has `domain/`, `usecase/`, `adapter/` — except the two kernels,
  which are listed explicitly so the exception is visible.

Comments are stripped before the source scans. HANDOVER.md §7 records trap B: a
boundary guard once flagged its own doc comment, and the fix was `stripComments()`.

Both money guards were verified to actually fire by temporarily introducing a
`database/sql` import into a domain package and a `float64` next to a money field.

---

## 7. What is **not** built, and why

### The contract gap — the important one

**`contracts/openapi.yaml` defines no order surface.** It has two paths
(`GET /catalog`, `GET /inventory/balances`) and two tags (Catalog, Inventory).
There is no `/orders`, no `/sync/push`, and no `Order`, `OrderLine`, `Payment`,
`Refund`, `OrderStatus` or `OutboxStatus` schema — even though the file's own
preamble refers to "`OrderStatus`, `OutboxStatus`" as if they existed.

So the order ingest path is **complete and tested but unrouted**. That is the
correct order of work: SKILL.md §4 goes contract → generate types → implement.
Building a wire format in code first would fork the contract and leave two sources
of truth for `openapi-typescript` to reconcile.

`internal/order/adapter/http/ports.go` lists exactly what the contract must gain,
including the four decisions nobody has made:

1. Is an order pushed as a whole aggregate or as discrete events?
2. What status for a replayed idempotency key? **200**, not 409 — a terminal that
   reads 409 as failure retries forever.
3. What status for a held order? **202** — stored, the money is real, stop retrying.
4. Header or body for the key? `ARCHITECTURE-DEMO.md` §7 shows a header; the
   contract must say so.

### Persistence — blocked, not deferred by choice

`sqlc` and `goose` are **HELD** (SKILL.md §3.2/§3.4) and `db/migrations/` is
empty. The postgres adapters are documented skeletons: method signatures, the SQL
each must run, and the two rules an implementation must not get wrong (the
`since` filter is **strictly** `>`; every read is **branch-scoped**, including the
variant join, because a variant has no `branch_id` of its own).

They return an error, never an empty slice. An empty slice would produce a
well-formed `200` with `"variants": []`, which a terminal caches as authoritative
and serves all shift with an empty menu.

### `grit`

Unresolvable (404 on the proxy, GitHub and the GitHub API) and no substitute is
permitted. **`go.mod` therefore has no `require` block at all** — the money, tax
and domain core is standard-library only, so it compiles, vets and tests green
today with no network, and stays correct however the HTTP/DB wiring is eventually
supplied.

### Also absent

- **Auth middleware** — needs a device credential store that does not exist. The
  contract's 401/403 are documented on the handler and unimplemented on purpose: a
  handler inventing its own weaker check is how a client-asserted branch id gets
  trusted.
- **Outbox worker** — needs a Postgres ledger and a destination.
- **Catalog pagination** — `next_cursor` is plumbed through the response but the
  repository has no paging, because there is no query to page.

---

## 8. Contract details worth knowing before writing SQL

**`unit_price_satang` is VAT-INCLUSIVE.** The contract says "before tax and before
discount". *"Before tax"* means the tax has not been **separated out** of the
amount — not that VAT is absent from it. Reading it as "excluding VAT" puts forward
VAT into checkout: ฿3.19 instead of ฿2.98 on every sale.
`TestPriceListEntry_PriceIsVatInclusiveNotExclusive` pins it.

**Sellability needs two rows.** `is_active` is the single source of truth for
"available to sell", but a variant is sellable only if it *and* its parent product
are active. A terminal reading one row will sell a size whose product left the
menu last month. `Sellable.IsSellable()` does the join, and refuses a mismatched
pair.

**The order status ladder is not invented.** It is the eight values the terminal
already enforces in `0001_init.sql:153` and `ORDER_STATUSES` in
`tauriOfflineOrders.ts:152`. A server disagreeing with its clients about a status
vocabulary cannot ingest anything they send.

**A void must be requested.** `completed → voided` directly is **refused**; it must
pass through `void_requested`, so the supervisor decision is recorded.
`draft → voided` is allowed — a draft was never submitted.

**`since` is strictly greater-than.** With `>=`, a terminal re-issuing a pull after
a dropped response replays the last row forever and its `last_seen_id` never
advances. The snapshot's `cursor` is stamped **before** the reads: taking the clock
afterwards would skip any row written mid-pull, a silent permanent hole in a cached
menu.

**Satang on the wire are bare integers.** `type: integer, format: int64`, never a
string or a decimal. `Satang.UnmarshalJSON` refuses `4550.0`, `4.55e3` and `"4550"`
outright. (Contrast the terminal's Tauri boundary, where an i64 crosses to
JavaScript as a *string* — HANDOVER.md §4. Same care, opposite direction.)

---

## 9. Known gaps to reconcile

| Gap | Where |
|---|---|
| `Order` has no `subtotal_satang` or `vat_rate_bp` field, but the SQL `CHECK`s need both to re-derive the tax without re-reading lines | `DOMAIN.md` `Order` field list |
| `OutboxItem` has no 4-state `CHECK` and no append-only trigger; the terminal's `sync_outbox` has both | `DOMAIN.md` `OutboxItem` |
| `taxable_satang` now holds the *net*; renaming to `net_satang` reads better | HANDOVER.md §11, unratified |
| `rounding_adjustment_satang` exists and is `0` everywhere; the policy is undecided | HANDOVER.md §11 — the code accepts an input and **chooses no value** |
| No Go CI job; `.github/workflows/verify.yml` has bun + rust only | see below |

### Adding Go to CI

`verify.yml` runs `bun` and `cargo` and says nothing about Go, so none of the above
is currently enforced on a pull request. A third job would be roughly:

```yaml
  go:
    name: Check and test the backend
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.25'
          cache-dependency-path: services/api-backend/go.mod
      - working-directory: services/api-backend
        run: go vet ./...
      - working-directory: services/api-backend
        run: go test ./...
```

No `go mod download` step: there are no dependencies, so the build cannot reach the
network and cannot be broken by a supply-chain event.