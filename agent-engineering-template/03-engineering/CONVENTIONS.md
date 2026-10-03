# Conventions — [Product Name]

> **Status**: Draft
> **Last Updated**: [Date]

---

## 1. Directory Structure

```
src/
├── App.tsx              # Root component, router
├── main.tsx             # React entry
├── routes/              # Page components (1 per route)
├── features/            # Per-domain folders (feature-sliced)
│   └── timer/
│       ├── timer-types.ts
│       ├── use-timer-store.ts
│       ├── timer-engine.ts
│       ├── timer-helpers.ts
│       └── timer-notifications.ts
├── components/          # Shared UI
│   ├── ui/              # Design-system primitives
│   └── ...              # Domain-agnostic components
├── lib/                  # Utilities, DB layer
│   ├── db/               # One file per aggregate (store)
│   └── utils/
├── styles/               # Global CSS, tokens
└── test/                 # Unit test files
e2e/                       # Playwright E2E tests
src-tauri/                 # Tauri/Rust backend
  ├── src/
  │   ├── commands/       # One file per command
  │   └── lib.rs          # Command registration
  └── migrations/          # DB migration SQL files
```

---

## 2. Naming

| Scope | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `timer-engine.ts`, `timer-controls.tsx` |
| Components | PascalCase | `TimerControls` |
| Hooks | `use-` prefix | `useTimerStore` |
| Stores | `use-<domain>-store` | `use-timer-store.ts` |
| Types | kebab-case file, PascalCase exports | `timer-types.ts` → `TimerPhase` |
| Tests | mirror file + `.test.ts` | `timer-helpers.test.ts` |
| E2E | `<flow>.spec.ts` | `task-crud.spec.ts` |
| Tauri commands | snake_case | `get_tasks`, `add_task` |

---

## 3. File Naming Quick Reference

- Components: `kebab-case.tsx`
- Store hooks: `use-<name>-store.ts`
- Types: `<name>-types.ts`
- Services: `<name>-service.ts`
- Helpers: `<name>-helpers.ts`
- Tests: `<name>.test.ts` (unit) or `<name>.spec.ts` (e2e)

---

## 4. Component Conventions

- Use function components with TypeScript.
- Props interface ends in `Props`:
  ```tsx
  interface TimerControlsProps { ... }
  export function TimerControls({ ... }: TimerControlsProps) { ... }
  ```
- Use design tokens for colors/spacing: `sahara-surface`, `sahara-primary`, etc.
- Never hardcode colors or pixel values that should be tokens.

---

## 5. Service Conventions

- Services contain pure business logic or orchestrate Tauri calls.
- Named exports, no class components.
- Return typed results, never `any`.

---

## 6. Repository (Store) Conventions

- One Zustand store per domain.
- Structure:
  ```ts
  interface DomainState { items: T[]; loading: boolean; error: string | null; }
  interface DomainActions { loadItems(): Promise<void>; ... }
  export const useDomainStore = create<DomainState & DomainActions>((set, get) => ({ ... }));
  ```
- Components never call DB directly — always via stores.
- Loading + error state tracked per-action in the store.

---

## 7. API / Tauri Command Conventions

- Commands use PascalCase request structs, snake_case command names.
- All arguments validated with serde + custom checks.
- Return `Result<T, String>` for simple errors, or a typed `ErrorResponse`.
- Register commands in `src-tauri/src/lib.rs` via `tauri::generate_handler![...]`.

---

## 8. Database / SQL Conventions

- Tables: snake_case (e.g., `tasks`, `sessions`).
- Columns: snake_case (`created_at`, `category_id`).
- Primary key: `id INTEGER PRIMARY KEY AUTOINCREMENT`.
- Foreign keys named `<table>_id`.
- Always use `?` placeholders — never interpolate user input.
- Enable `PRAGMA foreign_keys = ON`.

---

## 9. Error Handling

- Tauri commands return `Result<T, E>`; frontend handles `Err`.
- User-facing errors are localized and actionable.
- Unrecoverable errors show a dialog with a support/GitHub link.
- Never swallow errors silently.

---

## 10. Logging

- Production logging is minimal; logs sensitive data must be excluded (see Security.md).
- Use structured logging where possible.

---

## 11. TypeScript Conventions

- Strict mode enabled.
- No `any`; use `unknown` + type guards when needed.
- Prefer `type` over `interface` for object shapes (team preference).
- Use `as const` for literal unions.

---

## 12. Import Conventions

| Alias | Path |
|-------|------|
| `@/*` | `src/*` |
| `@@/*` | `src/lib/*` (rarely used) |
| `./` | relative |

Prefer aliased imports over deep relative paths.

---

## 13. Git Conventions

| Item | Rule |
|------|------|
| Branch | `feature/<name>`, `fix/<name>`, `chore/<name>` |
| Commit | Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:` |
| Merge | PR required; at least 1 review |
| Squash | Squash-and-merge to keep history clean |

---

## 14. Code Style

- Linter: ESLint + Prettier (config in repo root).
- Auto-format on save.
- Max line length: 100 chars.
- 2-space indent.

---

*This file codifies team-wide rules. Update when conventions change.*
