# Lane 3 Contract Requests — Ecosystem Views Data Mapping

> **Date:** 2026-10-07 (rewritten same day — see Corrections below)  
> **Author:** Lue 3 (UI+Docs)  
> **Status:** Audit complete — re-verified against the live contract

> ## ⚠️ Corrections to the first draft
>
> The first version of this document claimed that `GET /api/v1/reports/summary`
> and a branch-ranking endpoint **did not exist** and had to be requested.
> **That was wrong.** The audit was taken against a stale snapshot; by the time
> it was written the contract already carried the whole Reporting tag. Every
> "(ข) missing endpoint" row below that concerned reporting has been re-checked
> and reclassified. The genuinely-missing entities are unchanged and are listed
> under (ค).

---

## Executive Summary

The contract supports the **sales transaction lifecycle** *and* a **reporting
tag** that was added after the first audit:

| Group | What it means | Count |
|---|---|---|
| (ก) | Readable from local SQLite on this terminal | 7 widgets |
| (ข) | **Already exists** in the contract + Go service — just not wired to the UI | 4 widgets |
| (ค) | No entity anywhere in the contract — must not be invented | 11 widgets |

**The headline correction:** the ecosystem views are not blocked on new
endpoints for money. Revenue, order count, VAT and branch ranking all have
contract-defined endpoints with a Go implementation in
`services/api-backend/internal/reporting/`. They are (ข) *not wired*, not (ข)
*missing*.

---

## Ecosystem Views Data Mapping

| Widget | Current Value | Current Source | Real Source | Group |
|---|---|---|---|---|
| **CEOView** | | | | |
| Total Revenue | "฿2.84M" | `ECO_BRANCHES[0].revenue` | `GET /reports/summary` → `revenue_total_satang` | (ข) exists |
| Net Profit | "฿680K" | `ECO_MONTHLY` | — | (ค) no cost entity |
| Total Orders | "4,821" | hardcoded | `GET /reports/summary` → `order_count`, or `COUNT(*) FROM local_orders` | (ข)/(ก) |
| New Customers | "847" | `ECO_STAFF` (**counts staff, not customers**) | — | (ค) no customer entity |
| Revenue vs Expenses | monthly bars | `ECO_MONTHLY` | revenue: `GET /reports/revenue-series`; **expenses: nothing** | (ค) half unfounded |
| Predictive Analytics | forecast bars | computed from `ECO_MONTHLY` | — | (ค) no model |
| Branch Ranking | name/revenue/orders/score | `ECO_BRANCHES` | `GET /reports/revenue-by-branch` → name, revenue, order_count. **`score` is not in the response** | (ข) exists, `score` (ค) |
| Recent Activity | timestamp + text | `ECO_ACTIVITY` | `sync_outbox` / `local_orders.created_at` on this terminal | (ก) |
| **ManagerView** | | | | |
| Order count badges | "New (2)", "Cooking (3)" | filter on `ECO_INITIAL_ORDERS` | `local_orders.status`, all 8 states | (ก) |
| Order details | customer/table/items/total | `ECO_INITIAL_ORDERS` | `local_orders` + `local_order_lines` | (ก) |
| Menu display | menu items | `ECO_MENU` | catalog cache | (ก) |
| Staff skills | skillPct bar | `ECO_STAFF` | — | (ค) |
| **StaffView** | | | | |
| Clock-in time | "08:02" | hardcoded | — | (ค) |
| Staff name | "Kai Chen" | hardcoded | — | (ค) no user entity |
| Shift info | "Morning shift 08:00–16:00" | `SLOTS` array | — | (ค) |
| AI Coach | "Level 3 → 4 · 72%" | hardcoded | — | (ค) |
| **POSView** | | | | |
| Menu items | name/emoji/price/**kcal**/**mins** | `ECO_MENU` | name+price from catalog; **kcal/mins have no contract field** | (ก)/(ค) |
| Cart totals | subtotal/tax/total | component arithmetic | `calculateOrderTotals(cart, vatRateBp)` | (ก) |
| Payment method | Cash/Card/QR | `pay` state | `PaymentMethod` = `[cash, qr_promptpay]` — **no card** | (ก) contract exists |
| Order type | Dine In/Take Away/Delivery | `mode` state | `OrderType` = `[dine_in, takeaway, delivery]` | (ก) contract exists |

---

## (ก) Local SQLite Read — ready now

Read-only from this terminal's own database:

| Widget | Source |
|---|---|
| Order count badges | `local_orders.status` — 8 states, see below |
| Order details | `local_orders` + `local_order_lines` |
| Recent Activity | `sync_outbox` / `local_orders.created_at`, this terminal only |
| Menu display | catalog cache |
| Cart totals | `calculateOrderTotals()` from `sales/domain/cart.ts` |

### The 8 lifecycle states

`local_orders.status` CHECK:
```
draft · submitted · in_preparation · ready · served
· completed · void_requested · voided
```

### Money rule

VAT is **inclusive**. `calculateOrderTotals()` returns `subtotal` (what the
customer pays), `net`, `tax`, and `total === subtotal`. The UI must **not** add
tax on top, and must not format money itself — use `Money.toString()`.

---

## (ข) Endpoints that already exist — wiring work, not new work

These are defined in `contracts/openapi.yaml` under the `Reporting` tag and
implemented in `services/api-backend/internal/reporting/`:

| Endpoint | Gives | Serves |
|---|---|---|
| `GET /branches` | `Branch[]` — id, name, currency, **vat_rate_bp** | Branch names; the per-branch VAT rate |
| `GET /reports/summary` | `revenue_total_satang`, `vat_satang`, `order_count`, `voided_count`, `as_of` | Total Revenue, Total Orders |
| `GET /reports/revenue-by-branch` | `branch_id`, `name`, `revenue_satang`, `order_count`, ordered desc | Branch Ranking (revenue column) |
| `GET /reports/revenue-series` | revenue + order count by day or month | Revenue vs Expenses chart — revenue half |
| `GET /terminals` | terminal + last sync time | freshness indicator |

**Revenue definition, from the contract:** excludes `draft` and `voided`,
**includes** `void_requested`. Dates are bucketed in `Asia/Bangkok`.

**Auth stub (Phase 1):** all four require `REPORTS_TOKEN` in the environment,
an `X-Report-Token` header matching, and a localhost caller. Without it they
answer `503 auth_stub_required`. This is a real constraint on any UI wiring —
these are not reachable from a terminal on the LAN as the contract stands.

### Still genuinely missing even for reporting

| Field | Why it cannot be derived |
|---|---|
| `score` on Branch Ranking | no scoring field in `RevenueByBranchItem` |
| Expenses / cost | `grep -icE "profit\|expense\|cost"` over the contract returns **0** |
| Net Profit | needs expenses |

---

## (ค) Unfounded — must not be invented

No entity, field or endpoint anywhere in the contract backs these. Each renders
as a fixed fallback labelled:

```
ข้อมูลตัวอย่าง — รอ backend contract extension
```

| Field | View | Why it is unfounded |
|---|---|---|
| `kcal` | POSView menu | `ProductVariant` has no nutrition field |
| `mins` (prep time) | POSView menu | same |
| `BESTSELLER` / `TRENDING` tags | POSView menu | no contract field; a hardcoded string is a number no system computed |
| `-25%` promo badge | POSView menu | a discount is resolved at checkout, not on the tile |
| Net Profit | CEOView | no cost data |
| Expenses series | CEOView | no expense entity |
| Predictive Analytics | CEOView | no model |
| Branch `score` | CEOView | not in `RevenueByBranchItem` |
| Staff name / skills / shift | StaffView, ManagerView | **no User or Staff entity exists at all** |
| Clock-in time | StaffView | no attendance entity |
| AI Coach | StaffView | no skill entity |
| Staff turnover risk | CEOView | no HR data |

---

## Blockers before UI wiring

1. **The reporting auth stub is localhost-only.** A POS terminal on the LAN
   cannot call `/reports/*` under the current Phase-1 rule. This needs a
   decision before any dashboard is wired.
2. **No User/Staff entity.** Everything in `StaffView`, and the staff cards in
   `ManagerView`, has nothing to bind to. This is the single largest gap.
3. **Card payments do not exist.** `PaymentMethod` is
   `[cash, qr_promptpay]`. `POSView` currently offers a Card button.

---

## Action Items

| Priority | Task | Owner |
|---|---|---|
| 🔴 High | Decide how a LAN terminal authenticates to `/reports/*` past the localhost stub | Lue Main |
| 🔴 High | Add a User/Staff entity to the contract | Lue Main |
| 🟡 Medium | Decide whether Branch Ranking needs a `score`, or drops the column | Lue Main |
| 🟡 Medium | Remove the Card button, or extend `PaymentMethod` | pending Lue 2 |
| 🟢 Low | Money abbreviation (M/K) — none exists in the domain | Lue Main |

---

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-10-07 | Lue 3 | Initial audit — **wrong about missing reporting endpoints** |
| 2026-10-07 | Lue 3 | Rewritten against the live contract; (ข) reclassified as *exists, not wired* |

---

*End of document*