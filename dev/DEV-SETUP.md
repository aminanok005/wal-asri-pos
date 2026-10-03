# DEV-SETUP — running two POS stacks on one host

> Applies to `wal-asri-pos` (this repo, namespace `walasri`).
> Sibling project `pos-walasri` uses namespace `default` and is **not**
> documented here — that is its own concern.

---

## 1. TL;DR

```bash
cd /home/nisreen/yt-project/wal-asri-pos
cp .env.example .env          # once

./dev/wasri compose up -d     # start THIS project's stack
./dev/wasri compose ps        # status
./dev/wasri compose down      # stop
```

Never run a bare `nerdctl compose` in this repo. Always `./dev/wasri`.

---

## 2. Why the wrapper script

Three facts about this host, all verified:

| Fact | Consequence |
|---|---|
| `systemctl is-active docker` → **failed** | The `docker` CLI is a Docker **Desktop** client pointed at a GUI socket that is not running. `docker` cannot work. |
| `systemctl is-active containerd` → **active** | The real engine is native containerd, and it is healthy. `nerdctl` talks to it directly. |
| No rootless containerd socket | `nerdctl` **without** `sudo` fails: `fatal: rootless containerd not running?`. `sudo` is mandatory. |

`nerdctl` is not a workaround here — it is the *correct* client. The containers
have been running under containerd for 9+ days; only the Desktop wrapper is broken.

---

## 3. The isolation contract (why the two projects cannot collide)

The host containerd serves both projects. Three independent layers keep them apart:

### Layer 1 — containerd namespace

```
sudo nerdctl namespace ls

NAME        CONTAINERS  IMAGES  VOLUMES
default     3           3       23       ← pos-walasri (NOT OURS)
walasri     0           0       0        ← this project
```

A namespace is a hard boundary: containers, images, volumes, and networks in
`walasri` are invisible to `default`. Even a duplicate name cannot collide.

### Layer 2 — container names

| Service | pos-walasri | wal-asri-pos |
|---|---|---|
| PostgreSQL | `pos-postgres` | `wasri-postgres` |
| Redis | `pos-redis` | `wasri-redis` |
| Qdrant | `pos-qdrant` | *(not used)* |

### Layer 3 — ports, databases, credentials

| | pos-walasri | wal-asri-pos |
|---|---|---|
| Postgres port | 5432 | **5433** |
| Redis port | 6379 | **6380** |
| Postgres DB | `pos_db` | `walasri_db` |
| Postgres user | `pos_user` | `wasri_user` |
| Redis password | `pos_redis_password` | `walasri_redis_pw` |
| Network | `pos-walasri_pos_network` | `wal-asri-pos_walasri_network` |
| Volume | `pos-walasri_postgres_data` | `wal-asri-pos_postgres_data` |

> Volumes and networks are **already** isolated by compose's project-name
> prefix, so those two were never at risk. Ports and container names were the
> real collision surfaces, and both are now disjoint.

Both stacks can run simultaneously. Nothing in this repo touches `default`.

---

## 4. Connecting to the services

`psql` is not installed on the host, so use the container:

```bash
# PostgreSQL
./dev/wasri exec wasri-postgres psql -U wasri_user -d walasri_db

# Redis (password required)
./dev/wasri exec wasri-redis redis-cli -a walasri_redis_pw --no-auth-warning ping
# → PONG
```

The Go backend connects over the host ports instead, via `DATABASE_URL` /
`REDIS_URL` in `.env`.

---

## 5. Migrations

Per SKILL.md §3.2, migrations use **goose**, not psql-on-host:

```bash
# once goose is installed
goose -dir migrations postgres "$DATABASE_URL" up
```

`sqlc` generates type-safe Go from the queries in `services/api-backend/db/queries/`.

---

## 6. Toolchain status

| Tool | Required by | Status |
|---|---|---|
| Go | SKILL.md §3.1 (>= 1.22) | ✅ installed — go1.25.1 |
| Node | SKILL.md §3.1 (>= 20) | ✅ installed — v22.23.2 |
| **Bun** | SKILL.md §3.1 (>= 1.3.14) | ✅ **installed — 1.3.14** (package manager) |
| Rust / cargo | SKILL.md §3.1 (>= 1.75) | ✅ installed |
| golangci-lint | SKILL.md §3.2 | ✅ installed |
| **Turborepo** | — | ⛔ **not used** (dropped by decision) |
| pnpm | — | ⛔ **superseded by Bun** — never installed |
| corepack | — | ⛔ **not used** — no pnpm activation |
| **grit** | SKILL.md §3.2 / §3.4 | 🔴 **BLOCKED** — see below |
| sqlc | SKILL.md §3.2 | ⏸️ HELD — pending grit |
| goose | SKILL.md §3.2 | ⏸️ HELD — pending grit |

### Bun — the package manager

Bun `1.3.14` is already installed at `/home/nisreen/.bun/bin/bun`. It replaces
pnpm entirely: install, add, run, filter, test, and lockfile generation.

```bash
bun --version              # 1.3.14
bun install                # install across all workspaces
bun add <pkg>              # add a dependency
bun add -D -w <pkg>        # add a root devDependency
bun add --filter <name> <pkg>   # add to one workspace
bun run <script>           # run a package script
bun run --filter '*' <script>   # run across all workspaces
bunx <tool>                # one-off binary (bunx tsc --noEmit)
bun test                   # test runner
```

**Workspaces** are declared in the root `package.json` under `"workspaces"`.
Bun does **not** read `pnpm-workspace.yaml`, and there is no `turbo.json`.

> ⚠️ Pin Bun. Bun `1.4+` writes `bun.lock` with `lockfileVersion: 2`, which
> tooling expecting the v1 format (what Bun `1.3.x` produces) may fail to
> parse — losing the workspace graph silently. Once a `package.json` exists,
> declare `"packageManager": "bun@1.3.14"` and avoid auto-update.

### Turborepo — dropped

Not installed, not required. Monorepo orchestration uses Bun workspace
filtering and root scripts (SKILL.md §3.5). Reconsider only if the repository
later needs remote caching or build orchestration.

### grit — BLOCKED (required tool, no substitution)

SKILL.md §3.2 specifies:

```bash
go install github.com/aminanok005/grit/cmd/grit@latest
```

**This cannot be installed.** Both halves of the path fail:

```
go list -m -versions github.com/aminanok005/grit
  → 404 Not Found: module github.com/aminanok005/grit

curl -o /dev/null -w '%{http_code}' https://github.com/aminanok005/grit
  → 404

curl -o /dev/null -w '%{http_code}' https://api.github.com/repos/aminanok005/grit
  → 404
```

`proxy.golang.org` cannot read the module, and the GitHub page itself returns
404. The repository is **private, renamed, or deleted**. Because the request
prompts for GitHub credentials and fails, this is **not** a network or proxy
problem on this machine (`GOPROXY=https://proxy.golang.org,direct`,
`GOPRIVATE` empty).

The GitHub account `aminanok005` itself resolves (HTTP 200) and has 6 public
repositories, none of which is `grit` — so the author identity is valid and
the grit module simply is not public.

`grit` is a **hard dependency of the whole workflow** — SKILL.md §4 Step 3 is
`grit generate resource <module>` inside `/services/api-backend`. Until it is
resolved, backend scaffolding cannot start.

**Standing instruction — no substitution:**
- Do **NOT** install a similarly-named public package. The name is generic and
  a wrong install would silently diverge from the intended framework.
- Do **NOT** substitute a different framework.
- Do **NOT** recreate grit by hand.

Backend scaffolding stays **BLOCKED** until a human provides the correct grit
source, path, or access. `sqlc` and `goose` remain **HELD** for the same
reason.

---

## 7. Architecture notes for this project

Monorepo + Clean Architecture, designed from the start (not retrofitted):

```
services/api-backend/        Go modular monolith (Grit framework — ⛔ BLOCKED)
  internal/{feature}/domain/   pure domain — no http, no SQL
  db/queries/*.sql             sqlc sources (⏸️ HELD)
apps/pos-desktop/              Tauri 2 + React + SQLCipher SQLite
apps/pos-mobile/               Expo + TanStack Query
apps/admin-web/                Next.js
contracts/openapi.yaml         OpenAPI 3.0 — source of truth
packages/api-types/            generated TS types
```

Money is **integer satang** everywhere (`int64` in Go, a `Money` value object
in TypeScript). No `float`, no `float32/float64`.

---

## 8. Troubleshooting

**`fatal: rootless containerd not running?`**
You dropped the `sudo`, or ran `nerdctl` directly. Use `./dev/wasri`.

**`Cannot connect to the Docker daemon`**
You ran `docker`. It is a Desktop client and the daemon is down by design here.
Use `./dev/wasri`.

**`port is already allocated` on 5433/6380**
Something outside compose took the port. Check `ss -ltnp | grep 5433`.
Never "fix" this by moving back to 5432 — that is the other project's port.

**A container in the wrong namespace**
You used bare `nerdctl`. Verify with `sudo nerdctl namespace ls` — this
project's containers must only appear under `walasri`.
