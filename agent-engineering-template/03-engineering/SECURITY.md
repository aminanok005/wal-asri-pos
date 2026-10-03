# Security — [Product Name]

> **Status**: Draft
> **Last Updated**: [Date]
> **Owner**: [Security Owner]

---

## 1. Authentication

| Aspect | Decision |
|--------|----------|
| **Primary auth** | [e.g., No authentication — single-device, local user] |
| **Passphrase** | [e.g., Optional passphrase to encrypt exported backups] |
| **Biometric** | [e.g., Optional Touch ID / Windows Hello to unlock app] |
| **External providers** | [e.g., None in v1] |

---

## 2. Authorization & Roles

[Product Name] is a single-user device app. RBAC is scoped to:

| Role | Permissions |
|------|-------------|
| [e.g., Owner / Default User] | Full access to all data on the device |

If multi-user is added in the future, document roles and permissions here.

---

## 3. Tenant Isolation

| Multi-tenant? | [Yes / No] |
|---------------|------------|
| Isolation mechanism | [e.g., N/A — single user per device] |
| If yes | [e.g., `tenant_id` column on all tables; enforced at query layer] |

---

## 4. Input Validation

- **All Tauri command arguments must be validated on the Rust side.**
- Use typed structs with serde and custom validators.
- Reject: empty titles, oversized payloads (>1 MB), non-UTF-8 strings.
- String length limits documented in `API.md`.

### Example (Rust)

```rust
#[derive(Deserialize)]
struct AddTaskRequest {
    title: String,
}

#[ttauri::command]
fn add_task(req: AddTaskRequest) -> Result<Task, String> {
    if req.title.trim().is_empty() {
        return Err("title must not be empty".into());
    }
    // ...
}
```

---

## 5. Output Handling (XSS Prevention)

- React escapes all text by default. Never use `dangerouslySetInnerHTML` without sanitization.
- If HTML rendering is ever needed: use a allowlist sanitizer (e.g., `dompurify`).
- Content Security Policy: [e.g., `default-src 'self'` — tighten if external scripts are added.]

---

## 6. Secrets Management

| Secret | Where Stored | Rotation |
|--------|--------------|----------|
| API keys | OS keychain or environment (never in source) | [Policy] |
| Backup passphrase | [Never persisted — used locally, cleared from memory] | [N/A] |
| DB encryption key | [e.g., Derived from passphrase; not stored] | [N/A] |

**Rules:**
- `.env` and `.env.*` are in `.gitignore`.
- Secrets must never be logged, printed, or sent in error messages.
- Use the Tauri `tauri-plugin-positioner` / OS keychain API for secrets at rest.

---

## 7. Session Management

[e.g., No server-side sessions. The app runs continuously in the tray or a window. If biometric gating is added, a re-lock timer after N minutes of inactivity.]

---

## 8. Vulnerability Coverage

| Threat | Mitigation | Status |
|--------|------------|--------|
| **CSRF** | N/A — no server-rendered forms or cookies | Not applicable |
| **XSS** | React auto-escaping + CSP | In place |
| **SQL Injection** | Parameterized queries only (`?` placeholders) | In place |
| **Path traversal** | All file access constrained to `tauri::api::path::app_data_dir()` | In place |
| **Insecure file upload** | No file uploads from untrusted sources in v1 | N/A |
| **Rate limiting** | Enforced on external API clients | In place |

---

## 9. File Upload & Storage Security

[If file handling is added later:]

| Concern | Policy |
|---------|--------|
| Allowed types | [e.g., `.json`, `.png` only] |
| Max size | [e.g., 5 MB] |
| Storage location | [App data dir; no user-controlled path] |
| Validation | [Content-type + magic bytes check] |

---

## 10. Sensitive Data Handling

| Data Type | Handling |
|-----------|----------|
| Journal text | Encrypted at rest if option enabled |
| Task descriptions | Plain in SQLite (device-only) |
| Passwords/passphrases | Never stored; used in-memory only |
| Analytics | Only aggregate, anonymised metrics if opted-in |

---

## 11. Logging Restrictions

| Allowed in logs | Not allowed in logs |
|-----------------|---------------------|
| Operation names | User content (task text, journal entries) |
| Stack traces | Credentials, tokens, passphrases |
| Error codes | DB file paths, user identifiers |

---

## 12. Dependency Security

- Run `cargo audit` (Rust) and `npm audit` / `bun audit` regularly.
- Enable Dependabot / Renovate in `.github/`.
- Pin critical dependencies; review transitive deps quarterly.

---

## 13. Known Gaps & TODO

| Gap | Risk | Plan |
|-----|------|------|
| [e.g., No automated SAST gate in CI] | [Missed vulnerabilities] | [Add CodeQL / Semgrep in CI] |
| [e.g., No penetration testing scheduled] | [Unknown exposure] | [Schedule review for v1 release] |

---

*Review this document before handling any data-touching feature.*
