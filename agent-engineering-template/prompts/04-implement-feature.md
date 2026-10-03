# Prompt: Implement a Feature from Breakdown

Use this prompt to implement a feature that already has a breakdown document.

---

**SYSTEM CONTEXT (for the AI agent):**

You are implementing a feature with a pre-approved breakdown. Follow this workflow strictly.

**Instructions:**

1. **Read everything first** (do not edit until you have read all of these):
   - `AGENTS.md`
   - The feature breakdown: `features/[feature-name].md`
   - `02-design/ARCHITECTURE.md`, `DOMAIN.md`, `DATA_MODEL.md`, `API.md`
   - `03-engineering/CONVENTIONS.md`, `SECURITY.md`, `TESTING.md`
   - Relevant existing source in `src/features/`, `src/lib/db/`, `src-tauri/src/commands/`
   - Existing tests for the domain you're touching

2. **Thin Slice first**: Implement the end-to-end path through DB → store → component → test for ONE small piece. Verify with build + test before expanding.

3. **For each sub-task in the breakdown**:
   - Add DB schema / migration if needed (update `DATA_MODEL.md` too).
   - Add / update the Tauri command (update `API.md` too).
   - Add / update the store action (loading + error states).
   - Add / update the component (skeleton + error states).
   - Write unit tests (Vitest) and E2E tests (Playwright).

4. **Conventions to follow**:
   - Components via stores, never direct DB/Tauri calls.
   - Parameterized SQL only.
   - Design tokens (`sahara-*`) only.
   - Strict TypeScript; no `any`.
   - Alias imports `@/*` and `@@/*`.

5. **Security check**:
   - Validate Tauri command args on the Rust side.
   - Never log secrets.
   - Never hardcode credentials.

6. **Testing**:
   - Run `bun test` after each slice.
   - Run `bun run test:e2e` for the affected flow.
   - Run `bun run build` to type-check.

7. **Documentation**:
   - If you change an API contract, domain concept, or schema → update the corresponding doc.
   - If you make a new architectural/product decision → add an ADR to `04-ai/DECISIONS.md` before continuing.
   - If you discover a discrepancy between docs and code → flag it and pause.

8. **Final validation** (Definition of Done):
   - [ ] All tests pass.
   - [ ] Build succeeds (no type errors).
   - [ ] Docs updated.
   - [ ] Decision log updated (if applicable).
   - [ ] No secrets exposed.

**Feature Breakdown File:** `features/[feature-name].md`
