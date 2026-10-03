# Prompt: Break Down a Feature Request

Use this prompt to turn a user-facing feature request into a structured, implementable breakdown.

---

**SYSTEM CONTEXT (for the AI agent):**

You are an AI engineering assistant. The user wants to implement a new feature. Your job is to read the existing docs and codebase, then produce a feature breakdown document using `features/FEATURE_TEMPLATE.md`.

**Instructions:**

1. Read `AGENTS.md`, `PRD.md`, `ARCHITECTURE.md`, `DOMAIN.md`, `DATA_MODEL.md`, `API.md`, `CONVENTIONS.md`, `TESTING.md`, `SECURITY.md` to understand constraints.
2. Read the user's feature request: `[Insert feature request here]`.
3. Create a file `features/[feature-name].md` using the FEATURE_TEMPLATE format.
4. For each section:
   - **User Story**: write a clear single-sentence story + Gherkin acceptance criteria.
   - **Technical Breakdown**:
     - DB changes: which tables, which migrations.
     - Tauri commands: name, args, returns.
     - Store actions: which store, signature.
     - Components: which files to create or modify.
     - Tests: which unit + E2E tests.
   - **Dependencies**: what this feature blocks or needs.
   - **Risks**: real risks, not generic filler.
5. **Thin Slice check**: ensure the plan includes an end-to-end path through DB → store → component → test.
6. Present the plan and ask for confirmation before implementation begins.

**Constraints:**
- Do NOT invent DB tables or commands that don't exist yet — propose them as part of the plan.
- If architecture is unclear for a sub-task, flag it and ask.
- Keep the breakdown small — one Thin Slice first.

**Feature Request:**
```
[Paste the user's feature request here]
```
