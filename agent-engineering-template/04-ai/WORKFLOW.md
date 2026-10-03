# AI Engineering Workflow

> **Status**: Draft
> **Last Updated**: [Date]

This document describes the step-by-step workflow AI agents MUST follow when contributing to [Product Name]. It is a living guide and must be read in full before starting any implementation task.

---

## Prerequisites

- [ ] Read `AGENTS.md` in full.
- [ ] Read `README.md`.
- [ ] Read all docs in `02-design/` and `03-engineering/`.
- [ ] Read relevant entries in `04-ai/DECISIONS.md`.
- [ ] Ensure dependencies installed (`bun install`).

---

## Phase 1 — Read Docs

Before writing **any** code:

1. Read `AGENTS.md`, `PRD.md`, `ARCHITECTURE.md`, `DOMAIN.md`, `DATA_MODEL.md`, `API.md`, `SECURITY.md`, `TESTING.md`, `CONVENTIONS.md`.
2. Identify the feature's domain and locate its folder under `src/features/`.
3. Identify the store pattern (`use-<domain>-store.ts`), DB file, and test locations.

**Checkpoint**: Can you describe the data flow for this feature? If not, ask.

---

## Phase 2 — Plan

1. Create a feature breakdown using `features/FEATURE_TEMPLATE.md`.
2. For each sub-task:
   - Identify affected files.
   - Identify required Tauri commands (add to `API.md` first).
   - Identify tests needed.
3. Record any new decisions in `04-ai/DECISIONS.md`.
4. Present the plan and **get user confirmation** before implementing.

**Checkpoint**: Plan is small enough to fit a Thin Slice (end-to-end in one layer stack).

---

## Phase 3 — Implement (Thin Slice First)

Follow the Thin Slice approach: prove end-to-end (DB → store → component → test) with **one small feature** before expanding.

1. **DB / Tauri**: Add schema, migration, command.
2. **Store**: Add state, action, loading/error handling.
3. **Component**: Wire up to store; render skeleton/error states.
4. **Test**: Write unit + E2E for the critical path.
5. Run `bun run build` after each slice.

---

## Phase 4 — Test

1. Run `bun test` — all unit tests pass.
2. Run `bun run test:e2e` — critical flows pass.
3. If a bug is found, follow **Disciplined Debugging** (below).
4. Ensure coverage thresholds are met (see `TESTING.md`).

---

## Phase 5 — Document

1. Update `API.md` if command contracts changed.
2. Update `DOMAIN.md` / `DATA_MODEL.md` if entities changed.
3. Update `SECURITY.md` if data handling changed.
4. Add an entry to `04-ai/DECISIONS.md`.
5. Update `PRD.md` roadmap / history if feature ships.

---

## Decision-Making Guidelines

| Situation | Guidance |
|-----------|----------|
| Ambiguous requirement | **Ask the user** — do not guess. |
| Unspecified schema/API | **Ask** — never invent. |
| Conflicting docs | Flag conflict; ask user to reconcile. |
| New dependency needed | Justify in a decision; must be reviewed. |
| Security-sensitive change | Escalate; read `SECURITY.md` first. |

---

## Disciplined Debugging

When a bug is reported:

1. **Investigate root cause** — read logs, trace the call stack, write a failing test.
2. **Do NOT Vibe-Patch** — no random null-checks or speculative edits.
3. **Fix at the root** — the actual bug location.
4. **Scan the system** — check for the same pattern elsewhere.
5. **Verify** — the new test passes and no regression occurs.

---

## Review Checklist (Before Completing a Task)

- [ ] Code follows `CONVENTIONS.md` (naming, types, imports).
- [ ] No direct DB calls in components; all via stores.
- [ ] All new Tauri commands validate args.
- [ ] No secrets logged or hardcoded.
- [ ] All tests pass (`bun test`, `bun run test:e2e`).
- [ ] `bun run build` succeeds with no type errors.
- [ ] Docs updated (`API.md`, `DOMAIN.md`, etc.).
- [ ] Decision log updated.
- [ ] PRD roadmap / history updated if shipping.

---

## Validation Steps (Commands)

```bash
bun install          # 1. Install deps
bun run dev          # 2. Smoke-test frontend
bun run tauri dev    # 3. Run full desktop app
bun test             # 4. Unit tests
bun run test:e2e     # 5. E2E tests
bun run build        # 6. Production build (type-check + compile)
bun run tauri build  # 7. Package binaries
```

---

## Handling Uncertainty

- **Never invent requirements, environment variables, DB schemas, or API responses.**
- If a value is unspecified, **pause** and ask the user.
- Document any assumption you make in `DECISIONS.md` under "Assumptions (pending confirmation)."

---

*This workflow is mandatory. Following it reduces regressions and keeps the codebase coherent across AI sessions.*
