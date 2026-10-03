# Architectural Decision Log

> A living record of significant decisions made during the development of [Product Name].

---

## Decision Record Template

```markdown
### [ADR-NNN] — [Decision Title]

| Field | Value |
|-------|-------|
| **Date** | YYYY-MM-DD |
| **Status** | Proposed \| Accepted \| Superseded by ADR-NNN |
| **Deciders** | [Name(s)] |

**Context**

[What is the issue / constraint? What forces are at play?]

**Decision**

[What did we decide and why? Keep it concise but complete.]

**Consequences**

- [e.g., Positive: ...
- e.g., Negative: ...
- e.g., Neutral: ...]

**Alternatives Considered**

1. [Alternative A] — [Why not chosen]
2. [Alternative B] — [Why not chosen]

**Related**

- See: `02-design/ARCHITECTURE.md`
- See: `02-design/DATA_MODEL.md`
```

---

## ADR-001 — Use SQLite as the sole local data store

| Field | Value |
|-------|-------|
| **Date** | 2026-09-20 |
| **Status** | Accepted |
| **Deciders** | Product Team |

**Context**

The application is local-first and must function offline. We need a reliable, cross-platform embedded database that Tauri can access natively without a server process.

**Decision**

Use SQLite via the `tauri-plugin-sql` / custom Rust SQLite wrapper. All user data (tasks, sessions, settings, journal) is stored in SQLite tables within the Tauri user data directory.

**Consequences**

- ✅ Simple, reliable, no server to run.
- ✅ Cross-platform, well-supported by Tauri/Rust ecosystem.
- ✅ Easy JSON export/import for backups.
- ❌ No built-in real-time sync (not a v1 goal).
- ❌ Schema migrations must be forward-only and carefully managed.

**Alternatives Considered**

1. **IndexedDB** — Rejected; only works in the webview context, harder to back up, and not native.
2. **Realm** — Rejected; heavier, less idiomatic with Tauri.
3. **JSON file** — Rejected; no ACID guarantees, poor for concurrent access even locally.

**Related**

- See: `02-design/DATA_MODEL.md`
- See: `03-engineering/TESTING.md` (database testing section)

---

## ADR-002 — Zustand for state management

| Field | Value |
|-------|-------|
| **Date** | 2026-09-20 |
| **Status** | Accepted |

**Context**

We need predictable state management that works well with React + TypeScript and integrates cleanly with async Tauri commands.

**Decision**

Use Zustand with one store per domain. Stores encapsulate loading, error, and data states. Components never call DB/Tauri directly — all access goes through the store.

**Consequences**

- ✅ Lightweight, minimal boilerplate.
- ✅ Easy to test stores in isolation by mocking `invoke`.
- ❌ Adds an indirection layer; new contributors must learn the pattern.

**Alternatives Considered**

1. **Redux Toolkit** — More boilerplate; overkill for a desktop app.
2. **React Context + useReducer** — No async helpers built-in; scales poorly.
3. **Jotai / Valtio** — Valid options but Zustand has the established pattern in this codebase.

**Related**

- See: `03-engineering/CONVENTIONS.md`

---

## ADR-003 — Thin store rule (no DB calls in components)

| Field | Value |
|-------|-------|
| **Date** | 2026-09-20 |
| **Status** | Accepted |

**Context**

Components are tightly coupled to view concerns. Direct DB calls in components would blur boundaries, complicate testing, and risk multiple call sites bypassing loading/error handling.

**Decision**

No component may call `invoke()` or access SQLite directly. All data access flows through the Zustand store.

**Consequences**

- ✅ Single place for error/loading handling.
- ✅ Easy to mock data in tests.
- ❌ Slightly more boilerplate to add a new action.

**Alternatives Considered**

1. **Service modules imported by components** — Rejected; inconsistent with store-centric architecture.

**Related**

- See: `AGENTS.md` (Architecture Rules)
- See: `03-engineering/CONVENTIONS.md`

---

*To add a new decision: copy the template above, increment the ADR number, fill in all fields, and commit.*
