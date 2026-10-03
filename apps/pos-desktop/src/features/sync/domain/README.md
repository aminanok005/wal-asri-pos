# sync / domain

**Layer:** innermost (client domain) · **Runtime:** pure TypeScript, no I/O

Outbox state machine, cursor logic, and conflict classification — all pure.

## Boundary

Same rule as `sales/domain` — **no** React, Tauri, or SQL imports.

⚠️ **Orchestration vs. domain.** This folder holds the *rules* only. The
background **worker** that actually drains the outbox lives in Rust
(`src-tauri/src/sync/`) — it is an adapter, and it contains no business rules
(`SKILL.md` §2.3).

| Lives here (pure) | Lives in `src-tauri/src/sync/` (Rust adapter) |
|---|---|
| `pending → in_flight → done` transition rules | The timer that triggers a drain |
| Retry/backoff *policy* as pure functions | The actual HTTP call to `/sync/push` |
| Conflict classification | Writing `synced` back to local SQLite |

## The atomicity invariant

The order row and its outbox row are written in **one local transaction**.
That is the entire guarantee of "no order without a sync record" — if these
two writes can be separated by a crash, an order can exist that will never sync.

```sql
BEGIN TRANSACTION;
INSERT INTO orders (id, total_satang, status, created_at) VALUES (...);
INSERT INTO outbox_events (id, event_type, payload, idempotency_key, synced) VALUES (...);
COMMIT;
```

## Retry state

```
pending → in_flight → done
                  ↘ failed_permanent  → NeedsAttentionItem queue (visible in UI)
```

Permanent failures must surface in the UI. Silently dropping them is a defect.

## Entities

`OutboxItem` · `SyncCursor` · `IdempotencyKey` · `SyncConflict` · `NeedsAttentionItem`

## 🔴 Server leg is BLOCKED

`/sync/push` and `/sync/pull` are served by `services/api-backend`, which needs
the **`grit` CLI** — unavailable (404 on the Go proxy, GitHub, and the GitHub
API). The client-side half of sync is fully buildable; the server half is not.
Do not substitute another framework.
