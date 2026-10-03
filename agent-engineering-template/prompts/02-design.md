# Prompt: Create Architecture / Domain / Data Model / API Docs

Use this prompt after bootstrapping and reading the codebase. The AI agent should produce the four design documents from real code.

---

**SYSTEM CONTEXT (for the AI agent):**

You are documenting an existing local-first desktop codebase. You have access to the template docs in `02-design/` as skeletons. Your job is to READ the actual codebase and fill them in with accurate, real information — not placeholders.

**Instructions:**

1. Read `AGENTS.md`, `PRD.md`, and `CONVENTIONS.md` to understand project conventions.
2. Scan the source:
   - `src/features/*/timer-types.ts`, `use-*-store.ts`, `*-engine.ts`, `*-helpers.ts` → domain entities, state machines, business rules.
   - `src/lib/db/*` → SQLite tables, queries, migrations (`src-tauri/migrations/`).
   - `src-tauri/src/commands/*` and `src-tauri/src/lib.rs` → Tauri command contracts.
   - `src/components/`, `src/features/*/` → component responsibilities.
3. Fill `02-design/ARCHITECTURE.md`:
   - Components table: name, responsibility, key files.
   - Data flow diagrams (read path, write path) in Mermaid.
   - Deployment architecture (desktop + optional external services).
4. Fill `02-design/DOMAIN.md`:
   - Core entities with keys.
   - Relationships (Mermaid ER diagram).
   - Confirmed business rules (from code/PRD).
   - Assumptions (flag anything uncertain — ask the user before listing as fact).
   - State machines (copy from code or derive).
5. Fill `02-design/DATA_MODEL.md`:
   - For each table: full column list with type, PK/FK, nullable, unique, default.
   - Indexes, foreign-key relationships, soft-delete strategy, audit fields.
6. Fill `02-design/API.md`:
   - Every Tauri command: name, args, return type, validation, errors.
   - External HTTP APIs (if any).
   - Error response format, validation rules, rate limits.
7. Cross-check: the schema in `DATA_MODEL.md` must match `src-tauri/migrations/*` and the Rust struct definitions.
8. If you find discrepancies between the docs and code, flag them — do NOT silently overwrite.

**Constraints:**
- Every fact must be traceable to source code. If you cannot find evidence, mark as an assumption and ASK.
- Do NOT invent tables, columns, or commands that don't exist in the code.
- Mermaid diagrams must be valid.

**Target directory:** `[REPO_ROOT]`
