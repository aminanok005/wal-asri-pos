# Data Model — [Product Name]

> **Status**: Draft
> **Last Updated**: [Date]
> **Database**: SQLite (local, on-device)

---

## 1. Tables

> Conventions: snake_case for columns, `id` as integer primary key (autoincrement), `created_at` / `updated_at` in all user-facing tables, soft-delete via `deleted_at`, foreign keys enforced at table definition.

### `[table_name]`

| Column | Type | PK | FK | Nullable | Unique | Default | Description |
|--------|------|----|-----|----------|--------|---------|-------------|
| `id` | INTEGER | ✅ | | No | | AUTOINCREMENT | Primary key |
| `...` | TEXT/NUMBER/INTEGER | | | [Yes/No] | [Yes/No] | [...] | [...] |
| `created_at` | TEXT | | | No | | `CURRENT_TIMESTAMP` | ISO-8601 UTC |
| `updated_at` | TEXT | | | No | | `CURRENT_TIMESTAMP` | ISO-8601 UTC |
| `deleted_at` | TEXT | | | Yes | | NULL | Soft-delete marker |

---

### Sample Table: `tasks`

| Column | Type | PK | FK | Nullable | Unique | Default | Description |
|--------|------|----|-----|----------|--------|---------|-------------|
| `id` | INTEGER | ✅ | | No | | AUTOINCREMENT | Primary key |
| `title` | TEXT | | | No | | | Task title |
| `description` | TEXT | | | Yes | | NULL | Optional details |
| `priority` | TEXT | | | No | | `'medium'` | low / medium / high |
| `category_id` | INTEGER | | ✅ → `categories.id` | No | | | Owning category |
| `completed` | INTEGER | | | No | | `0` | 0 = open, 1 = done |
| `due_date` | TEXT | | | Yes | | NULL | ISO-8601 date |
| `repeat` | TEXT | | | Yes | | NULL | Repeat rule |
| `created_at` | TEXT | | | No | | `CURRENT_TIMESTAMP` | ISO-8601 UTC |
| `updated_at` | TEXT | | | No | | `CURRENT_TIMESTAMP` | ISO-8601 UTC |
| `deleted_at` | TEXT | | | Yes | | NULL | Soft-delete marker |

---

## 2. Indexes

| Table | Columns | Type | Reason |
|-------|---------|------|--------|
| `tasks` | `(category_id)` | B-tree | Foreign-key lookups |
| `tasks` | `(completed)` | B-tree | Filter for open/completed lists |
| `tasks` | `(due_date)` | B-tree | Sort by due date |
| `sessions` | `(task_id)` | B-tree | Task → sessions joins |
| `sessions` | `(date(recorded_at))` | B-tree | Daily aggregation |

---

## 3. Relationships & Foreign Keys

| From Table | Column | → To Table | Column | On Delete |
|------------|--------|------------|--------|-----------|
| `tasks` | `category_id` | `categories` | `id` | RESTRICT |
| `sessions` | `task_id` | `tasks` | `id` | SET NULL |
| `journal_entries` | `session_id` | `sessions` | `id` | CASCADE |

---

## 4. Soft Delete Strategy

- All user-facing tables include a nullable `deleted_at` column.
- Deleted rows are filtered via `WHERE deleted_at IS NULL` in every query.
- A "trash" UI restores rows by setting `deleted_at = NULL`.
- Hard deletion is not exposed to end users (admin/migration-only).

---

## 5. Audit Fields

- `created_at` — set on insert.
- `updated_at` — refreshed on every update.
- `deleted_at` — set when soft-deleted.

---

## 6. Multi-Tenancy

[If multi-user or multi-tenant:] Each tenant's data is partitioned by a `tenant_id` column on every table. All queries include `WHERE tenant_id = :currentTenant`.

[If single-user:] This field is not applicable. Data is device-local.

---

## 7. Data Integrity Rules

| Rule | Enforcement |
|------|-------------|
| Foreign keys must reference existing rows | SQLite `FOREIGN KEY ... REFERENCES` |
| `tasks.category_id` must point to a non-deleted category | Application-layer check before insert/update |
| `sessions.duration_sec > 0` | DB `CHECK (duration_sec > 0)` |
| `settings.key` is unique | `UNIQUE` constraint |

---

## 8. Migration Strategy

- Migrations run sequentially on app startup via the Tauri SQL plugin or a custom migration runner.
- Each migration is a numbered SQL file in `src-tauri/migrations/`.
- Migration downgrades are **not** supported in v1 (forward-only).
- Migration filenames: `YYYYMMDDHHMMSS_description.sql`.

---

## 9. Backup & Restore

- **Export**: All tables serialized to a timestamped JSON file.
- **Import**: Merges with conflict resolution (last-write-wins or user prompt).
- **Encryption**: Optional passphrase-based AES encryption of the export.

---

*This document is the source of truth for the SQLite schema. Any schema change must update this file and add a migration.*
