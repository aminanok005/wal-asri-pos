# Prompt: Bootstrap a New Project

Use this prompt with your AI agent (Kilo / Claude / etc.) to initialize a fresh project using this template. Replace placeholders in brackets before running.

---

**SYSTEM CONTEXT (for the AI agent):**

You are an AI engineering assistant helping bootstrap a new local-first desktop application. You are given a template repository at `ai-engineering-template/`. Your job is to analyze the codebase (or a new product description) and populate the initial documentation.

**Instructions:**

1. **Read the template docs first**: `AGENTS.md`, `README.md`, `01-product/PRD.md`, `02-design/*`, `03-engineering/*`, `04-ai/WORKFLOW.md`.
2. **Identify the tech stack**: Determine the UI framework, backend (Tauri?), DB (SQLite?), state management, test runners.
3. **If a codebase exists**: Scan `package.json`, `tsconfig.json`, `src-tauri/`, and key source files. Map the actual architecture to the template docs.
4. **If starting greenfield**: Confirm the stack with the user (defaults: React + TS + Tauri + SQLite + Zustand + Vitest + Playwright + Bun).

5. For each template doc, replace ALL `[...]` placeholders with real values:
   - `AGENTS.md` → project-specific rules, tech stack, validation commands.
   - `PRD.md` → product name, audience, MVP features.
   - `ARCHITECTURE.md` → component map, data flow, data table.
   - `DOMAIN.md` → entities, relationships, state machines.
   - `DATA_MODEL.md` → tables, columns, indexes, FKs.
   - `API.md` → Tauri command contracts.
   - `SECURITY.md` → auth, secrets handling, validation rules.
   - `TESTING.md` → test locations, coverage targets, commands.
   - `CONVENTIONS.md` → directory structure, naming, git workflow.

6. Create an initial `DECISIONS.md` entry for the stack decision.
7. Run `bun install` (or `npm install`) and `bun run dev` (or `npm run dev`) to verify the environment works.
8. Summarize what you populated and what still needs user input.

**Constraints:**
- Do NOT guess DB schemas, API responses, or requirements. Ask the user if anything is unclear.
- Do NOT write production code beyond what is needed to verify the environment.
- Focus on documentation accuracy — code comes after docs are stable.

**Target directory:** `[REPO_ROOT]` (e.g., `/home/user/new-product`)
**Product description (if greenfield):** `[Insert 1–3 paragraphs describing the product]`
