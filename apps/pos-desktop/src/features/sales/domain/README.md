# sales / domain

**Layer:** innermost (client domain) · **Runtime:** pure TypeScript, no I/O

Cart, checkout, refund, hold/recall rules. Pure business logic.

## Boundary — enforced, not aspirational

This directory may **only** import from:
- itself (`./`, `../`)
- other `features/*/domain/` modules
- `packages/api-types` (generated contract types)

It must **never** import:

```ts
// ❌ all of these are defects here
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Database } from '@tauri-apps/plugin-sql';
import { apiClient } from '../../platform/http';
```

Inner layers state what they need; outer layers supply it. A domain module that
reaches for the network or the DOM is a bug, not a shortcut — express the
dependency as a port instead:

```ts
export interface CartPort {
  saveOrder(order: Order, idempotencyKey: string): Promise<void>;
}
```

## Money rule

`Money` value object, integer satang. **Never `float`.** `3 × 0.1 = 0.30000000000000004`.

## Next step (SOP §4 Step 5)

Local Zustand store + TanStack Query hooks + SQLite outbox transaction.
The order row and its outbox row are written in **one local transaction**.
