# payments / domain

**Layer:** innermost (client domain) · **Runtime:** pure TypeScript, no I/O

Cash, PromptPay QR, card/EDC payment rules.

## Boundary

Same rule as `sales/domain` — **no** React, Tauri, or SQL imports.

The terminal vendor SDKs and hardware readers are **adapters**, not domain.
Express them as a port:

```ts
export interface PaymentGateway {
  charge(amountSatang: number, method: PaymentMethod): Promise<PaymentResult>;
}
```

## Money rule

All amounts are **integer satang** (`int64` on the server). No float anywhere
in the payment path.

## Entities

`Payment` · `Refund` · `VoidRequest`

## Open question

PromptPay QR confirmation flow is `TODO` (manual confirm vs. bank/gateway
webhook) — `ARCHITECTURE-DEMO.md` §6. Do not invent the flow.
