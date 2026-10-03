# `src-tauri/` — the POS desktop native shell

This directory holds the Tauri 2 native core for the Wal-Asri POS desktop
terminal. Per SKILL.md §2.3 it is an **adapter only**: it wires up the SQL
plugin, exposes commands, and will eventually own the ESC/POS printer bridge,
the cash drawer, and the SQLCipher key. It contains **no business rules** —
cart arithmetic, tax policy and promotion eligibility are pure TypeScript under
`apps/pos-desktop/src/features/**/domain/`.

## File tree

```
src-tauri/
├── Cargo.toml                 Crate manifest for wasri_pos_desktop.
├── build.rs                   Tauri's build script; generates the context
│                              macros from tauri.conf.json.
├── tauri.conf.json            Window, bundle, CSP, and the SQL preload DB URL.
├── capabilities/
│   └── default.json           The permission set the main window runs with.
├── icons/                     Bundle icons referenced by tauri.conf.json.
├── migrations/
│   └── 0001_init.sql          The local schema: the authoritative contract for
│                              money, append-only rules and the outbox.
└── src/
    ├── lib.rs                 Plugin registration and migration embedding.
    ├── main.rs                Thin binary entry point; calls
    │                          wasri_pos_desktop_lib::run().
    └── README.md              This file.
```

Files outside this directory that matter to the same story:

| Path                                                    | Purpose                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/pos-desktop/src/features/payments/domain/money.ts` | The `Money` value object (integer satang): the real money boundary. |
| `apps/pos-desktop/src/features/sales/domain/cart.ts`    | Pure cart arithmetic, no SQL and no Tauri imports.                  |
| `apps/pos-desktop/test/migrations.test.ts`              | Executes `0001_init.sql` against a real SQLite engine and attacks it. |

## The money invariant

**Every monetary value is an INTEGER count of satang** (SKILL.md §2.1). ฿45.50
is `4550`. `REAL`, `FLOAT`, `DOUBLE` and `NUMERIC` are forbidden for money, in
SQL and in Rust and TypeScript alike; Rust money crosses the IPC boundary as
`i64`.

The database does not merely declare money columns as `INTEGER`; each one also
carries `CHECK (typeof(col) = 'integer' AND col >= 0)`. The `typeof()` half is
**load-bearing, not belt-and-braces**: SQLite has type *affinity*, not types, so
an `INTEGER`-affinity column accepts the float `45.5` without complaint (45.5 is
not losslessly convertible, so SQLite records storage class REAL). Only the
`typeof()` CHECK rejects it.

What that CHECK honestly **cannot** do is reject a numeric-looking string:
SQLite's INTEGER affinity silently coerces `'4550'` into the integer 4550 before
the constraint runs, and CHECKs observe post-coercion values. That is engine
behaviour, not a schema defect, so the real boundary is the application layer —
the `Money` value object and the `i64` command signatures. A JSON payload
carrying `{"total_satang": "5250"}` must fail deserialization and never reach
SQL. `apps/pos-desktop/test/migrations.test.ts` pins the coercion case as an
*accepted* behaviour so the gap stays visible instead of being rediscovered in
production.

## Append-only rules

A committed sale is a **fact**, not a draft. Once checkout commits inside the
§2.2 transaction, money is never rewritten and rows are never deleted:

| Trigger                             | Rule it protects                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `local_orders_money_immutable`      | No UPDATE may change **any** of the seven `*_satang` columns of a committed order. Lifecycle columns (`status`, `sync_state`, `updated_at`) stay writable. |
| `local_order_lines_money_immutable` | The same rule for `unit_price_satang`, `line_discount_satang`, `line_tax_satang` and `line_total_satang`.                                  |
| `local_orders_no_delete`            | No DELETE at all, pending an undecided retention / PDPA pruning policy.                                                                   |
| `local_order_lines_no_delete`       | The same, with `ON DELETE RESTRICT` on the parent foreign key as a second line of defence.                                                |
| `sync_outbox_append_only`           | An event's `id`, `idempotency_key`, `payload` and `created_at` are frozen; only delivery state (`status`, `attempt_count`, `next_attempt_at`, `last_error`) may advance. |

Corrections are **void events and new rows**, never edits. The money guards
compare *every* money column, because the arithmetic `CHECK`s alone do not stop
a consistent restatement: `UPDATE local_orders SET subtotal_satang = 6000,
discount_satang = 1450` leaves `taxable` and `total` untouched and satisfies
every identity in the table.

## Migrations

* **Naming:** `NNNN_description.sql`, four-digit zero-padded, applied in
  ascending version order.
* **Forward-only.** There are no down migrations. A shipped terminal has taken
  real money, so "un-applying" a migration is never safe; changes ship as
  `0002_...`, `0003_...`, and so on.
* **Never edit a migration that has shipped.** Each version is applied exactly
  once and recorded in `tauri-plugin-sql`'s own `_sqlx_migrations` table, so an
  edited `0001` would leave already-upgraded installs on the old schema and new
  installs on the new one.
* `PRAGMA user_version` at the end of `0001_init.sql` is for **app-level**
  checks only. The plugin tracks applied versions in `_sqlx_migrations`, not in
  the pragma.

## Why migrations are embedded with `include_str!`

`tauri_plugin_sql::Builder::add_migrations` takes `sql: &'static str`, so the
canonical way to supply a `.sql` file is `include_str!`. The compiler reads the
file at **build time** and embeds its bytes in the executable:

```rust
tauri_plugin_sql::Builder::default()
  .add_migrations(
    "sqlite:wal_asri_pos.db",
    vec![tauri_plugin_sql::Migration {
      version: 1,
      description: "init — local_orders, local_order_lines, sync_outbox",
      sql: include_str!("../migrations/0001_init.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    }],
  )
```

This is the offline-first guarantee of SKILL.md §2.2: a terminal in airplane
mode, on a machine with no source tree, must still be able to create and
migrate its own database. Each migration is listed explicitly rather than
globbed, so version order stays visible in source and a renamed file cannot
silently reorder the schema.

## The DB URL must match in two places

The database URL string appears **twice**, and the two copies must stay
byte-identical:

1. `src/lib.rs` — `add_migrations("sqlite:wal_asri_pos.db", ...)`, where the
   migrations are attached.
2. `tauri.conf.json` — `plugins.sql.preload: ["sqlite:wal_asri_pos.db"]`, which
   is what opens the pool at startup instead of on the first JS call.

Nothing links the two at compile time. The preload exists so that the migrations
run before the frontend can open a connection, and so a checkout starting in
airplane mode pays no first-call latency to open its own database. If the two
ever diverge, the frontend silently talks to a second, empty database — which is
why the pair is covered by a test.

## Capabilities and permissions

`capabilities/default.json` grants the `main` window:

| Permission        | Why                                                                           |
| ----------------- | ----------------------------------------------------------------------------- |
| `core:default`    | Tauri's default core surface: windows, events, app lifecycle.                  |
| `sql:allow-load`  | Open a connection to the preloaded database.                                   |
| `sql:allow-select` | Read committed sales, their lines, and the outbox queue.                      |
| `sql:allow-execute` | INSERT a committed sale, its lines, and its outbox event in one transaction. |
| `sql:allow-close` | Release the connection on shutdown.                                            |

Note what is deliberately **absent**: there is no blanket "run any SQL" grant,
and no capability handing the frontend file-system or network access. The money
invariants live in the schema, so the frontend never has to be trusted with
them — but it does need write access to record a sale, which is why
`sql:allow-execute` is present.

## The Vite ↔ Tauri wiring

`tauri.conf.json`'s `build` object is the join between the bundler and the
native shell, and every key in it has to agree with `vite.config.ts`:

| Key                  | Value                   | Agreement it encodes                                 |
| -------------------- | ----------------------- | ---------------------------------------------------- |
| `frontendDist`       | `../dist`               | Resolved from `src-tauri/`, so `apps/pos-desktop/dist`. |
| `beforeBuildCommand` | `bun run build`         | `vite build` writes exactly that directory.            |
| `devUrl`             | `http://localhost:1420` | The address `bun run dev` actually binds.               |
| `beforeDevCommand`   | `bun run dev`           | The dev server the webview is pointed at.              |

Those keys are absent-by-history, not absent-by-choice: they were left out when
no frontend build existed at all. `vite.config.ts`, `index.html` and
`src/main.tsx` now exist and emit a bundle, so `frontendDist` names a directory
something actually produces, and `tauri dev` finally has a server to
hot-reload against.

**The port is fixed at 1420 and `strictPort` is on because the Rust side has no
discovery mechanism.** `devUrl` is a hand-written string: no handshake, no port
file, no fallback. Were Vite to fall forward to 1421 because 1420 was busy, the
dev build would keep working, the webview would keep loading 1420, and the till
would show whatever else on that machine was listening there — or nothing at
all. Failing loudly is correct: a dev session that cannot bind the port the
native side expects is already broken, and the moment to find out is
immediately, not hours later when someone wonders why their edits stopped
appearing on the terminal. 1420 specifically because it is the port Tauri's own
`create-tauri-app` template uses, so it is the one number people already have
in their heads.

**`base: './'` in `vite.config.ts` is load-bearing for the packaged app, and it
is what makes `frontendDist` alone sufficient.** Vite's default `base: '/'`
emits `/assets/index-<hash>.js`. A Tauri app is served from a custom-protocol
origin, where a leading slash is the *bundle* root rather than a web-server
root: the request is for `/assets/index-<hash>.js` at that origin, not for the
file sitting next to `index.html` inside the embedded `dist/`. The build would
succeed, `tauri build` would find `dist/index.html` exactly where
`frontendDist` expects it, and the packaged till would open to a blank window
with a 404 in the console — a green build producing a broken till. Relative
paths resolve against the document's own location, so one setting covers
`file://`, `tauri://localhost`, and the `http://tauri.localhost` origin that
Windows webviews use. The dev server is unaffected: Vite normalises a relative
`base` to `/` while serving.

**The CSP stays `default-src 'self'`, and `devUrl` pointing at localhost does
not change that.** Two separate facts make widening it the wrong trade. First,
this one file also governs the packaged binary: a `http://localhost:1420`
allowance shipped inside the POS build is a permanent permission for a server
that does not exist on a till, and it is exactly the kind of origin that a
malicious page would try to reach. `'self'` remains sufficient because the
bundle is entirely first-party — no CDN, no remote font, no analytics beacon —
and the only IPC the frontend needs is `sql:`, which is not a network origin at
all. Second, a dev-only policy belongs in a dev-only field: Tauri's
`app.security.devCsp` overrides `csp` in development, and if it is unset the
documented behaviour is that `csp` is injected in dev too. So Vite's HMR client
and its WebSocket are already running under the tight policy, and the correct
place to relieve that — if a future Vite version ever needs it — is
`devCsp`, never `csp`.

**Where `before*Command` runs, and why `bun run dev` is the right string.** The
hook's working directory is not `src-tauri/`; that would be the useless one,
since neither script exists there. Tauri v2 resolves a *frontend* directory —
`$TAURI_FRONTEND_PATH` if set, otherwise the CLI's own working directory, and
if that has no `package.json`, the first `package.json` found within three
levels below it — and runs the hook explicitly in it. It separately moves its
*own* working directory to `src-tauri/` before doing so, which is what keeps
the relative `frontendDist: "../dist"` resolving to `apps/pos-desktop/dist`
rather than to a sibling of it. The upshot for this repo: both `dev` and
`build` are scripts of `apps/pos-desktop/package.json`, which is that frontend
directory, so `bun run dev` and `bun run build` are the correct command
strings. The directory walk skips `node_modules/`, `target/` and `.DS_Store`,
so the resolution still lands on `apps/pos-desktop` even when the CLI is
invoked from inside `src-tauri/`. `bun run` rather than `bunx vite` is also
deliberate: it is the package script, so it keeps using the version resolved
from this workspace's `devDependencies` instead of whatever `bunx` would fetch.

## Open TODOs

These are unresolved gaps, recorded so nobody assumes they are handled. (The
"wire Vite up" item that used to lead this list is done; it is now the section
above.)

1. **`tauri-plugin-sql` does NOT provide SQLCipher encryption.** SKILL.md §1 and
   §2.3 specify "Encrypted SQLite via SQLCipher" and a "SQLCipher key" in the
   Rust core, but the plugin's `sqlite` feature links plain SQLite — the
   `sqlite:wal_asri_pos.db` URL opens an **unencrypted** file. So the
   specification and the implementation currently disagree, and encryption-at-rest
   is an **unresolved gap**, not a finished feature. Two candidate resolutions:
   * a `tauri-plugin-sql` build backed by a SQLCipher-enabled libsqlite3, or
   * replacing the plugin's pool with a `rusqlite` + bundled-sqlcipher adapter
     in `src-tauri/src/`, exposing the same commands.

   Until one of those lands, treat any local database file as sensitive plain
   text. This also interacts with the money rules above: an unencrypted drawer
   file is trivially editable by anyone with filesystem access, which is the
   reason the append-only triggers exist as defence in depth rather than as the
   only control.

2. **Retention / PDPA pruning is undecided.** `local_orders_no_delete` and
   `local_order_lines_no_delete` refuse all deletes until a policy is agreed, so
   the local database grows without bound and personal data is never pruned.

3. **`outbox_events` vs `sync_outbox` naming.** SKILL.md §2.2 names the example
   table `outbox_events`; this schema uses `sync_outbox`. Only one table exists.
   A human must reconcile the doc and the code.

4. **Tax rounding is not enforced.** `tax_satang` is stored and identity-checked
   but the VAT formula is deliberately left as a commented-out `CHECK` until
   `docs/02-design/DOMAIN.md` settles whether VAT rounds per line or per order.
