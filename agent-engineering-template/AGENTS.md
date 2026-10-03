# AGENTS.md — AI Agent Operating Instructions

> **This file is loaded at the start of every agent session. All AI agents MUST read and follow these conventions.**

## 1. Project Overview

**[Product Name]** is a local-first desktop application built with React + TypeScript + Vite for the frontend and Tauri (Rust) for the native backend. Data is stored locally in SQLite. This AGENTS.md captures the living rules that ensure consistency, prevent regressions, and preserve architectural decisions across AI sessions.

## 2. Documentation Map

Agents **must read** the relevant docs before modifying code. Keep them in sync.

| Document | Purpose | Read Before |
|-----------|---------|-------------|
| `01-product/PRD.md` | Product goals, requirements, roadmap | Feature planning |
| `02-design/ARCHITECTURE.md` | System overview, component boundaries | Any code change |
| `02-design/DOMAIN.md` | Entities, business rules, invariants | Data/model changes |
| `02-design/DATA_MODEL.md` | DB schema, migrations | DB/storage changes |
| `02-design/API.md` | API contracts | API/Tauri command changes |
| `03-engineering/SECURITY.md` | Auth, secrets, input validation | Security-sensitive code |
| `03-engineering/TESTING.md` | Test strategy, coverage | Writing tests |
| `03-engineering/CONVENTIONS.md` | Code style, naming, structure | Writing new code |
| `04-ai/DECISIONS.md` | Architectural decision log | Any significant decision |

## 3. Architecture Rules

1. **Thin store rule** — Components never call DB or Tauri commands directly. All data access goes through Zustand store hooks.
2. **Domain separation** — Each feature owns its domain. Cross-domain calls must go through a well-defined interface (event bus or store action).
3. **No direct DB mutation from the UI thread** — All SQLite writes go through the Tauri command layer.
4. **Single source of truth** — Each piece of state lives in exactly one store.
5. **Local-first** — The app must function offline. Network-dependent features must degrade gracefully.
6. **Avoid unnecessary refactoring** — Do not restructure existing code unless it directly blocks the current task.

## 4. Domain Rules

- Every domain must define its entities, invariants, and state machines in `02-design/DOMAIN.md`.
- Business logic lives in the store or a dedicated service module — not inside React components.
- Domain events (e.g., `sessionCompleted`) should be explicit, not implicit side-effects.

## 5. Coding Conventions

- **English** for all code, comments, commit messages, and docs. (UI text may be localized.)
- **TypeScript strict mode** must be enabled.
- Use the **import aliases** configured in `tsconfig.json` (`@/*` → `src/`, `@@/*` → `src/lib/`).
- Follow the existing component hierarchy: pages → containers → components → primitives.
- Never mutate store state directly — always return new objects in setters.
- Use `sahara-*` named design tokens for colors/spacing — never hardcode values.

## 6. Security Rules

- **Never log secrets** — API keys, tokens, and user data must not appear in logs.
- **Never commit `.env`** — it is in `.gitignore`.
- **Validate all input** — Tauri commands must validate arguments server-side.
- **No unauthorized access** — every native command must check authorization if applicable.
- **File paths** — never allow user-controlled paths to escape the app's data directory.
- **SQL injection** — always use parameterized queries; never interpolate user input into SQL.
- If a security question is uncertain, **stop and ask**.

## 7. Testing Requirements

- **All new code must have tests.** Aim for ≥80% coverage on business logic.
- Run unit tests after every change: `bun test`.
- For UI changes, run the relevant Playwright E2E suite: `bun run test:e2e`.
- Write a **failing test first** when fixing a bug (disciplined debugging).
- Mocks must live in the test directory and be clearly named.

## 8. Dependency Rules

- Only add dependencies after verifying they are already in `package.json` or justified in a decision record.
- Pin major versions. Avoid transitive dependency conflicts.
- Prefer the existing ecosystem (Zustand, Vitest, Playwright, Tauri) over new libraries.

## 9. File Modification Rules

- **Read before edit** — always read the file (and its tests) before changing it.
- **Minimal diffs** — change only what the task requires.
- **Update docs** — if a change affects architecture, domain, or API, update the corresponding doc.
- **Follow the Thin Slice approach** — prove end-to-end (DB → store → component → test) with one small feature first.

## 10. Definition of Done

A task is complete when:

1. ✅ Code follows conventions in `CONVENTIONS.md`.
2. ✅ All tests pass (unit + relevant E2E).
3. ✅ Lint/typecheck passes (`bun run build` or equivalent).
4. ✅ Docs are updated (if the change affects any documented surface).
5. ✅ Decision log is updated if a new architectural or product decision was made.
6. ✅ No secrets are exposed.

## 11. Required Validation Commands

```bash
bun install          # install deps
bun run dev          # start frontend dev server
bun run tauri dev    # start full desktop app
bun test             # unit tests
bun run test:e2e     # E2E tests
bun run build        # type-check + build
bun run tauri build  # package binaries
```

## 12. Handling Uncertainty

- **Never invent requirements.** If a requirement is ambiguous, ask the user.
- **Never guess environment variables, DB schemas, or API responses.**
- If you encounter unspecified values, **return control to the human engineer** with a clear gap description.
- Document any assumption you *do* make in the decision log so it can be challenged.
