# Testing — [Product Name]

> **Status**: Draft
> **Last Updated**: [Date]

---

## 1. Testing Strategy

| Layer | Tool | Scope | Run Command |
|-------|------|-------|-------------|
| Unit | Vitest | Pure logic: score calc, time formatting, session utils, store logic | `bun test` |
| Integration | Vitest | DB layer + store interactions (mocked Tauri) | `bun test` |
| E2E | Playwright | Full app flow via Tauri test mode | `bun run test:e2e` |
| Visual Regression | Playwright | [Optional — screenshot diffs] | [TBD] |

---

## 2. Test Locations

| Type | Directory | Naming |
|------|-----------|--------|
| Unit | `src/test/` | `<name>.test.ts` |
| Store logic | `src/features/<domain>/` | `use-<name>-store.test.ts` |
| Helpers | `src/lib/` | `<name>-helpers.test.ts` |
| E2E | `e2e/` | `<flow>.spec.ts` |
| Fixtures | `src/test/fixtures/` | `<domain>.fixture.ts` |
| Mocks | `e2e/mocks/` | `db-mock.ts`, `notification-plugin-mock.ts` |

---

## 3. Naming Conventions

- Test files mirror the file under test, suffixed `.test.ts`.
- E2E spec files use `.spec.ts`.
- Test descriptions use `describe`/`it` with readable English sentences.

---

## 4. Fixtures & Factories

```typescript
// src/test/fixtures/session.fixture.ts
import type { Session } from "@/features/timer/timer-types";

export const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 1,
  taskId: 1,
  startedAt: "2026-01-01T09:00:00Z",
  endedAt: "2026-01-01T09:25:00Z",
  durationSec: 1500,
  quality: 3,
  ...overrides,
});
```

---

## 5. Mocking Strategy

| What | How |
|------|-----|
| Tauri `invoke` | Mock the `@tauri-apps/api/tauri` module in Vitest |
| Notifications | Mock `Notification` API or Tauri plugin |
| Date / timers | `vi.useFakeTimers()` + `vi.setSystemTime()` |
| DB | In-memory SQLite (`:memory:`) in unit tests; mocked invoke in E2E |

---

## 6. Database Testing

- Unit tests: Use SQLite `:memory:` with the same schema migrations.
- E2E tests: Use a temporary test DB; reset between tests.
- Each test must start from a known clean state.

---

## 7. Critical User Flows (E2E)

| Flow | Spec File | Status |
|------|-----------|--------|
| Start & complete a focus session | `e2e/timer-flow.spec.ts` | ✅ Must pass |
| Add / edit / delete a task | `e2e/task-crud.spec.ts` | ✅ Must pass |
| Export & restore a backup | `e2e/backup-restore.spec.ts` | ✅ Must pass |
| Theme switch (light → dark) | `e2e/theme.spec.ts` | ✅ Must pass |

---

## 8. Coverage Requirements

| Layer | Minimum Coverage |
|-------|-----------------|
| Business logic (stores, helpers, services) | 80% |
| Tauri command handlers | 70% |
| UI components (non-primitive) | 50% (E2E covers integration) |

---

## 9. Required Checks Before Merge / Deploy

```bash
bun install                # deps installed
bun run build             # type-check + compile
bun test                  # unit + integration
bun run test:e2e          # E2E critical flows
# cargo audit            # (Tauri) check Rust deps for vulnerabilities
```

All tests must pass. Coverage thresholds must be met. Review the security doc for any secrets-related changes.

---

## 10. Test Data Lifecycle

- Tests must not touch real user data.
- After each test run, the temp DB is deleted.
- Test artifacts (screenshots) go to `e2e/report/`.

---

*Keep this document in sync with your CI configuration.*
