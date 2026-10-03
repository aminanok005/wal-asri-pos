# API Contract — [Product Name]

> **Status**: Draft
> **Last Updated**: [Date]
> **Note**: [Product Name] is a local-first desktop app. "API" here refers to internal **Tauri commands** exposed from the Rust backend to the React frontend. If the app also calls external HTTP APIs, document those in section 2.

---

## 1. Tauri (Native) Commands

> All commands are invoked from the frontend via `invoke('@tauri-apps/api/tauri')`. Every command MUST validate its arguments and NEVER interpolate user input into SQL.

### `get_tasks`

| Field | Value |
|-------|-------|
| **Description** | Returns all non-deleted tasks, optionally filtered. |
| **Auth** | Local user only (no auth in v1) |
| **Method** | `invoke('get_tasks', {...})` |
| **Request** | `{ filter?: 'all' \| 'open' \| 'completed' }` |
| **Response** | `{ tasks: Task[] }` |
| **Errors** | `500` if DB error |
| **Idempotent** | Yes |

### `add_task`

| Field | Value |
|-------|-------|
| **Description** | Creates a new task. |
| **Auth** | Local user only |
| **Method** | `invoke('add_task', {...})` |
| **Request** | `{ title: string, description?: string, priority?: string, category_id?: number }` |
| **Response** | `{ id: number }` |
| **Errors** | `400` if `title` missing |
| **Idempotency-Key** | Not required (local) |

### `update_task`

| Field | Value |
|-------|-------|
| **Description** | Patches an existing task. |
| **Method** | `invoke('update_task', {...})` |
| **Request** | `{ id: number, patch: Partial<Task> }` |
| **Response** | `{ success: boolean }` |
| **Errors** | `404` if task not found, `400` invalid field |

### `delete_task`

| Field | Value |
|-------|-------|
| **Description** | Soft-deletes a task. |
| **Method** | `invoke('delete_task', {...})` |
| **Request** | `{ id: number }` |
| **Response** | `{ deleted: number }` (rows affected) |
| **Errors** | `404` if not found |

> **Add more commands following this template.**

---

## 2. External HTTP APIs

| Service | Endpoint | Auth | Notes |
|---------|----------|------|-------|
| [e.g., Prayer Times] | `GET https://api.pray.zone/v3/times/date` | API Key | Cached in DB for 24h |

---

### Error Response Format (HTTP)

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": { "field": "title", "issue": "must not be empty" }
  }
}
```

| HTTP Status | Meaning | When |
|-------------|---------|------|
| 200 | OK | Successful read |
| 201 | Created | Successful create |
| 400 | Bad Request | Validation failure |
| 401 | Unauthorized | Missing/invalid credentials |
| 403 | Forbidden | Not authorized for resource |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | State conflict (e.g., duplicate) |
| 429 | Too Many Requests | Rate limited |
| 500 | Internal Server Error | Unexpected failure |

---

## 3. Validation Rules

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `title` | string | Yes | 1–200 chars |
| `description` | string | No | ≤5000 chars |
| `priority` | enum | No | `'low' \| 'medium' \| 'high'` |

---

## 4. Pagination

- All list endpoints accept `?page=1&limit=50`.
- Response includes `meta: { page, limit, total, totalPages }`.
- Default: `page=1`, `limit=50`.

---

## 5. Filtering & Sorting

- Filter via query params: `?filter=completed`, `?category=5`.
- Sort via: `?sort=-created_at` (`-` = descending).

---

## 6. Rate Limiting

| Scope | Limit | Window |
|-------|-------|--------|
| External API | 60 req | 1 hour |
| [If applicable] | | |

---

## 7. Idempotency

Create commands MAY accept an `idempotency_key`. If repeated within 24 hours, returns the cached result instead of duplicating.

---

## 8. Versioning

- URL: `/api/v1/...` or command name (e.g., `v1_add_task`).
- Breaking changes require bumping the version and a deprecation notice.

---

*Update each command's contract here before changing the Rust handler or the frontend call site.*
