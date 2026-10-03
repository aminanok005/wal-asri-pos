# Feature: [Feature Name]

> **Priority**: [P0 / P1 / P2]
> **PRD Link**: [[01-product/PRD.md]]
> **Owner**: [Engineer / AI Agent]

---

## 1. User Story

> As a **[user role]**, I want to **[goal]** so that **[benefit]**.

**Acceptance Criteria (Gherkin)**

```gherkin
Given [precondition]
When [action]
Then [expected outcome]
```

(Repeat for each acceptance criterion.)

---

## 2. Technical Breakdown

### DB Changes

| Table | Change | Migration Needed? |
|-------|--------|-------------------|
| [table] | [e.g., add `quality` column] | Yes / No |

### Tauri Commands

| Command | Args | Returns | Validation |
|---------|------|---------|------------|
| [e.g., `save_session`] | [e.g., `{ sessionId, quality }`] | [e.g., `{ success: boolean }`] | [e.g., quality 1–5] |

### Store Actions

| Store | Action | Signature |
|-------|--------|-----------|
| [e.g., `useTimerStore`] | [e.g., `submitQuality`] | [e.g., `(sessionId: number, quality: number) => Promise<void>`] |

### Components

| Component | File | Responsibility |
|-----------|------|----------------|
| [e.g., `QualitySelector`] | `src/features/timer/quality-selector.tsx` | [Shows 1–5 stars for post-session rating] |

### Tests

| Type | File | Description |
|------|------|-------------|
| Unit | `src/test/timer-helpers.test.ts` | [Duration / rounding logic] |
| Unit | `src/features/timer/use-timer-store.test.ts` | [Phase transitions] |
| E2E | `e2e/timer-flow.spec.ts` | [Start → complete → rate flow] |

---

## 3. Dependencies

- Blocks: [other features this depends on]
- Blocked by: [features blocking this one]

---

## 4. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| [e.g., Timer drift on sleep] | [Medium] | [High] | [Use monotonic clock; handle pause/resume] |

---

## 5. Definition of Done

- [ ] Code written and follows `CONVENTIONS.md`
- [ ] All unit tests pass
- [ ] E2E tests updated and pass
- [ ] `bun run build` succeeds (no type errors)
- [ ] `API.md` updated with any new commands
- [ ] `DOMAIN.md` updated if entities changed
- [ ] `DATA_MODEL.md` updated if schema changed
- [ ] `SECURITY.md` reviewed if data handling changed
- [ ] `DECISIONS.md` updated if a new decision was made
- [ ] PR created with reviewers assigned
