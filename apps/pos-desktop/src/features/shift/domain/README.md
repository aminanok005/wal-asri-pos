# shift / domain

**Layer:** innermost (client domain) · **Runtime:** pure TypeScript, no I/O

Open/close shift, cash count, X/Z report rules.

## Boundary

Same rule as `sales/domain` — **no** React, Tauri, or SQL imports.

## State machine

```
closed → opening → open → counting → closed
```

Transitions belong here as pure functions. Persisting the state is the
application layer's job.

## Money rule

`opening_cash_satang` / `closing_cash_satang` are **integer satang**. Any
variance calculation must be integer — a float difference on cash count is a
defect, not a rounding concern.

## Entities

`Shift`
