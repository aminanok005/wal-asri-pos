# Domain Model — Wal-Asri POS

Authoritative domain model for GreenTable POS. Money is integer satang unless noted; all IDs are client-generated UUIDv7; all write models are append-only. This file covers sections 1–4. Sections 5–8 are appended by a separate author.

## 1. Core Entities

Compact blocks: a 3-row table of key fields (definition + invariant gist) followed by a terse `Fields:` list. Types use `Money` = integer satang. UUIDs are `uuid`; money is `<field>_satang`; timestamps are `timestamptz`.

### Branch
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| name_th | text | Not null, ≤ 64 |
| vat_rate_bp | int | Per-branch VAT, default 700 (=7%) |
- Fields: id uuid; name_th text; code text; settings jsonb; vat_rate_bp int; currency_code text; timezone text; created_at timestamptz; updated_at timestamptz

### Terminal
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches, not null |
| device_serial | text | Unique per branch |
- Fields: id uuid; branch_id uuid; name_th text; device_serial text; is_active boolean; settings jsonb; last_seen_at timestamptz; created_at timestamptz; updated_at timestamptz

### StaffUser
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| role_id | uuid | FK → roles |
- Fields: id uuid; branch_id uuid; role_id uuid; employee_code text; name_th text; name_en text; pin_hash text; auth_provider text; password_hash text; is_active boolean; created_at timestamptz; updated_at timestamptz

### Role
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| name | text | role-scoped, not null |
- Fields: id uuid; branch_id uuid; name text; permissions jsonb; is_system boolean; created_at timestamptz; updated_at timestamptz

### Shift
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id + terminal_id | uuid | One terminal, one branch |
| status | shift_status | closed → opening → open → counting → closed |
- Fields: id uuid; branch_id uuid; terminal_id uuid; staff_user_id uuid; status shift_status; opened_at timestamptz; closed_at timestamptz; opening_cash_satang int; closing_cash_satang int; z_report jsonb; created_at timestamptz; updated_at timestamptz

### DiningTable
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| number | int | Unique per branch |
- Fields: id uuid; branch_id uuid; number int; name_th text; capacity int; status text; x int; y int; created_at timestamptz; updated_at timestamptz

### Order
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| status | order_status | Append-only status ladder |
| branch_id | uuid | Not null, always recorded |
- Fields: id uuid; branch_id uuid; terminal_id uuid; staff_user_id uuid; dining_table_id uuid; customer_id uuid; type order_type; status order_status; source order_source; status_at timestamptz; total_satang int; taxable_satang int; tax_satang int; discount_satang int; service_charge_satang int; discount_type discount_type; loyalty_points_earned int; notes text; created_at timestamptz; updated_at timestamptz

### OrderLine
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| order_id | uuid | FK → orders |
| line_total_satang | int | = quantity × unit_price (integers) |
- Fields: id uuid; order_id uuid; product_variant_id uuid; quantity decimal(10,3); unit_price_satang int; line_total_satang int; tax_satang int; discount_satang int; promotion_id uuid; discount_type discount_type; notes text; sequence int; created_at timestamptz

### OrderLineModifier
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| order_line_id | uuid | FK → order_lines |
| line_total_satang | int | = quantity × unit_price |
- Fields: id uuid; order_line_id uuid; modifier_variant_id uuid; quantity decimal(10,3); unit_price_satang int; line_total_satang int; sequence int; created_at timestamptz

### Payment
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| method | payment_method | cash \| promptpay_qr \| card_edc \| transfer |
| status | payment_status | pending → authorized → captured, or failed/voided/refunded |
- Fields: id uuid; order_id uuid; method payment_method; status payment_status; amount_satang int; change_due_satang int; reference text; terminal_id uuid; staff_user_id uuid; authorized_at timestamptz; captured_at timestamptz; failed_at timestamptz; voided_at timestamptz; created_at timestamptz

### Refund
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| order_id | uuid | FK → orders, never mutated |
| amount_satang | int | ≤ original payment, never negative |
- Fields: id uuid; order_id uuid; payment_id uuid; amount_satang int; reason text; supervisor_id uuid; processed_at timestamptz; created_at timestamptz

### VoidRequest
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| order_id | uuid | FK → orders, append-only |
| decision | text | open → approved \| rejected |
- Fields: id uuid; order_id uuid; reason text; requested_by uuid; requested_at timestamptz; supervisor_id uuid; approved_at timestamptz; decision text; created_at timestamptz

### Receipt
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| receipt_number | text | From ReceiptNumberSeries |
| series_id | uuid | FK → receipt_number_series |
- Fields: id uuid; order_id uuid; receipt_number text; series_id uuid; printed_at timestamptz; printed_by uuid; printer_name text; status text; created_at timestamptz

### ReceiptNumberSeries
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| terminal_id | uuid | One series per terminal |
| last_number | int | Monotonic, never reset |
- Fields: id uuid; terminal_id uuid; prefix text; last_number int; current_year int; reset_year int; created_at timestamptz; updated_at timestamptz

### Customer
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| is_member | boolean | Drives member discount |
- Fields: id uuid; branch_id uuid; name_th text; phone text; email text; is_member boolean; tax_id text; address text; created_at timestamptz; updated_at timestamptz

### LoyaltyAccount
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| customer_id | uuid | 1:1 to customers |
| points_balance | int | ≥ 0 |
- Fields: id uuid; customer_id uuid; tier text; points_balance int; lifetime_points int; created_at timestamptz; updated_at timestamptz

### LoyaltyTransaction
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| loyalty_account_id | uuid | FK → loyalty_accounts |
| points | int | Signed: positive earn, negative redeem |
- Fields: id uuid; loyalty_account_id uuid; order_id uuid; type text; points int; reason text; created_at timestamptz

### LoyaltyReward
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| customer_id | uuid | Eligible redeem target |
| threshold_points | int | Points needed to redeem |
- Fields: id uuid; customer_id uuid; code text; threshold_points int; redeem_for_variant_id uuid; points_cost int; created_at timestamptz; expires_at timestamptz

### Category
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| parent_id | uuid | Self-ref for hierarchy |
- Fields: id uuid; branch_id uuid; name_th text; name_en text; parent_id uuid; sequence int; is_active boolean; created_at timestamptz; updated_at timestamptz

### Product
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| is_combo | boolean | If true, uses combo_components |
- Fields: id uuid; branch_id uuid; category_id uuid; name_th text; name_en text; is_active boolean; is_combo boolean; recipe_id uuid; image_url text; created_at timestamptz; updated_at timestamptz

---

## Money and tax rules

> **Ratified 2026-10-04.** This section is normative: the schema, the Rust
> commands and the TypeScript domain must all agree with it, and a disagreement
> is a defect in the code, not a comment to be updated. It also closes the
> `TODO(TAX-FORMULA)` that used to sit in
> `apps/pos-desktop/src-tauri/migrations/0001_init.sql`.

### Money is integer satang, everywhere

Every monetary value is an integer count of satang (`฿1 = 100 satang`), stored
as a `bigint` in TypeScript and `INTEGER` in SQLite. There is no float, no
decimal point, and no currency symbol on the wire. The column name always ends
in `_satang` when the value is money.

`3 × 0.1 = 0.30000000000000004`, so a float in the tax path would put a wrong
number on a tax document, where it cannot later be quietly corrected.

### VAT is INCLUSIVE — the tax is extracted, not added

**The price shown to the customer already contains the VAT.** ฿45.50 on the menu
is the amount paid, and ฿2.98 of it is tax. The tax is therefore *extracted* from
a known gross, not computed forward from a net:

```
net = round_half_up( gross × 10000 / (10000 + vat_rate_bp) )
tax = gross − net
```

Worked example at 7% (700 bp) on ฿45.50:

| step | value |
|---|---|
| gross | `4550` (฿45.50) |
| net = round_half_up(4550 × 10000 / 10700) = round_half_up(4252.336) | `4252` (฿42.52) |
| tax = 4550 − 4252 | `298` (฿2.98) |

**The direction is not interchangeable.** Forward VAT on the same sale would give
`4550 × 700 / 10000 = 318.5 → 319` (฿3.19) — a different amount of money,
wrong on every single sale. And because the tax is *inside* the price, 7% VAT is
worth **7/107 = 6.542%** of an inclusive price, not 7%. A ฿10,000 sale contains
฿654.21 of VAT, not ฿700.

### The tax rate is integer basis points

`vat_rate_bp` holds basis points: `700` = 7.00%. Basis points rather than a
float percentage, so the rate is exact integer arithmetic and 7 percent is
`700`, not `6.999999999`. `0` is a legitimate zero-rated state and yields
exactly zero tax. `10000` (100%) is refused — it is what a field receives when
someone types `100` meaning 100%, and it would make the net zero.

### Rounding happens ONCE, per order

The extraction is applied to the **order subtotal only**. It is never applied per
line.

Rounding per line rounds once per line — up to seven times on a seven-line
order — and the sum of those separately-rounded parts does not equal the VAT
actually owed on the receipt. The daily sales-tax report (ภ.พ.30) is filed on
the receipt totals, so the figure the shop declares has to be the figure the
receipt shows. One rounding point, one figure, one number to audit.

Rounding is **half-up** (a half-satang resolves upward, the commercial
convention). It is implemented with `bigint` division inside `Money`, never with
`Math.round` on a `number`.

### The identity that must always hold

```
taxable (net) + tax === total (the amount charged)
```

Derived by subtraction rather than by two independent divisions, so the two
halves cannot drift apart. A receipt whose parts do not sum to its total is a
defect regardless of how the rounding fell.

### Service charge is always zero

This is a café/retail till, not a restaurant. `service_charge_satang` is always
written as `0`. The column is retained rather than dropped so the storage
contract does not change shape, but it is not a supported feature and no business
rule depends on it.

### The database enforces all of the above

`migrations/0001_init.sql` is not a passive container. It re-derives the tax and
refuses any row that does not match, so a bug in the cart maths fails at COMMIT
inside the §2.2 transaction instead of becoming an unbalanced receipt:

```sql
CHECK (discount_satang <= subtotal_satang),
CHECK (total_satang = subtotal_satang - discount_satang
                     + service_charge_satang + rounding_adjustment_satang),
CHECK (taxable_satang + tax_satang
       = total_satang - service_charge_satang - rounding_adjustment_satang),
CHECK (tax_satang = gross - round_half_up(gross * 10000 / (10000 + vat_rate_bp)))
```

where `gross = subtotal_satang - discount_satang`. Note what is **absent**: any
term adding tax to the total. Under inclusive pricing the tax is already inside
the amount charged, and including it would bill the customer twice — the exact
failure that the removed `taxable = subtotal - discount` identity used to allow.

`local_order_lines.line_tax_satang` is constrained to `0`, since rounding is
per order (see above) and a per-line figure would be a second, differently
rounded copy of money the order total already contains.

### Where this is implemented

| Concern | Location |
|---|---|
| Extraction maths (pure) | `apps/pos-desktop/src/features/sales/domain/tax.ts` |
| Applied to a cart | `calculateTax` / `calculateOrderTotals` in `.../sales/domain/cart.ts` |
| Value object | `Money` in `.../payments/domain/money.ts` (integer satang) |
| Storage contract | `migrations/0001_init.sql` — `local_orders`, `local_order_lines` |
| Tests | `tax.test.ts` — maths, incl. the ฿45.50 worked example and a true half-up tie |
| Schema vs domain | `test/migrations.test.ts` — replays every split the domain can produce through the real `CHECK`s |

> The schema and the domain encode the VAT rule twice, in two languages. The test
> `0001_init.sql — the schema agrees with sales/domain/tax.ts` exists purely to
> stop those two copies drifting: it feeds the domain's own output into the real
> constraints and requires every split to be accepted, and every perturbed split
> to be refused. Without it, the failure mode is late and quiet — every unit test
> green, UI receipt correct, then checkout rejected at COMMIT.

### The plain-satang boundary signature

`splitInclusiveTax(gross: Satang, vatRateBp: BasisPoints): TaxSplit` exposes the
same rule with bare `bigint` instead of `Money`, for the ESC/POS receipt
blueprint where satang cross the Tauri invoke boundary as plain numbers.

It is an **adapter, not a second implementation** — it delegates to
`splitInclusive` and performs no arithmetic of its own. That is a deliberate
decision, and the reason is drift: a second copy of the formula would be a second
encoding of one accounting rule. The domain suite would keep testing the first
copy, the SQL `CHECK` would be derived from the second, and checkout would start
failing at COMMIT by a satang with no failing test anywhere.

Delegating also keeps the guards that a from-scratch version drops:

| Guard | Why it must survive |
|---|---|
| Negative `gross` throws `TaxError` | A refund entered as −฿45.50 is bad input, not a ฿0.00 sale. Returning `{0n, 0n}` would launder it into a zero-value order that only surfaces as a COMMIT rejection. |
| `vatRateBp = 10000` refused | The value a text field receives when someone types `100` meaning 100%. Unvalidated it computes a net near half the price instead of zero. |
| Non-`bigint` refused | Satang must never enter the money path as a JS `number`. |
| `splitInclusive`'s reconciliation guard | Runs on every call through the wrapper. |

`tax.test.ts` asserts the wrapper agrees with `splitInclusive` across 11 amounts
× 6 rates, so the delegation is a *checked* property rather than a comment.

---

## Offline receipt printing (ESC/POS) — blueprint

> **Planned, not implemented.** No printer code exists yet. This section records
> the agreed architecture so the next phase starts from a decision rather than a
> discussion.

### Architecture

```
UI / CartView ──► Application / PrintUseCase
                         │ (TypeScript interface)
                         ▼
                  Domain / receiptLayout
                         │ (Tauri invoke bridge)
                         ▼
                  Native Adapter / Rust ESC/POS crate
                         │ (hardware port)
                         ▼
                  Thermal printer / cash drawer
```

The receipt is printable **offline**: layout and byte compilation are local, so a
cash drawer opens and a receipt prints with no network and no Go backend.

### Test gates

| Gate | Layer | Proves |
|---|---|---|
| **A** | TypeScript unit | `receiptLayout` turns a cart + `TaxSplit` into a neutral IR (JSON). Asserts shop name, receipt number, the ฿45.50 total and the VAT line are all present and correct. |
| **B** | Rust `cargo test` | The IR compiles to the exact ESC/POS byte stream: `1B 40` (init), `1B 74 14` (Thai code page), `1D 56 42 00` (full cut), `1B 70 00 19 FA` (cash drawer kick). Plus Thai byte-offset assertions — see below. |
| **C** | Monorepo guard | `layers.test.ts` forbids any printer library or native API inside `domain/`. |

### Thai is ONE byte per character — Gate B must test bytes, not characters

**Corrected 2026-10-10.** This section previously claimed "Thai is two bytes per
glyph in CP874/CP256" and specified a Gate B test asserting that a 10-glyph Thai
name occupies 20 bytes. That was wrong. `windows-874` is a **single-byte** code
page: every character — Thai consonant, vowel, tone mark, `฿`, or ASCII — is
exactly one byte. `src/thai_coverage.rs` proves it, including that Thai digits
๐–๙ (U+0E50–U+0E59) map to `F0`–`F9`, one byte each.

The claim mattered beyond pedantry. A layout assuming two bytes per Thai glyph
would pad receipt lines at half the necessary width, pushing totals off the
right edge of an 80mm roll — receipts visibly torn in a way no type check
catches. With one byte per character, column arithmetic becomes **exact**: the
encoded byte length of a string *is* its width in printer character cells, so
`padding = 48 − width` is simply correct.

So Gate B asserts the compiled byte stream with the corrected rule: a 10-glyph
Thai name occupies **10 bytes**, and column offsets are computed in bytes.

**What the byte compiler does not do:** it does not visually stack Thai marks
over their consonants. In Unicode a vowel is stored *after* its consonant
(`เกาะ` = เ ก า ะ, four code points); CP874 has no combining mechanism, so each
mark occupies its own cell and the printer's built-in font table decides how it
renders. Gate B therefore asserts that all code points survive **in order, one
byte each** — not a stacking behaviour that lives in the printer's ROM.

| Term | Bytes | Printer columns |
|---|---|---|
| `ก` consonant | 1 | 1 |
| `้` tone mark (U+0E49) | 1 | 1 |
| `๙` Thai digit nine | 1 (`F9`) | 1 |
| `สิทธิ์` (6 code points) | 6 | 6 |
| `฿` baht sign | 1 (`DF`) | 1 |

### Layer rules for `receiptLayout`

`layers.test.ts` guards **every** `domain/*.ts` module from one shared allowlist
(not one hand-written test per file, which is how new modules escape). Allowed:
`Money`, `@wasri/api-types` as types only, and sibling domain modules. Forbidden:
`escpos`, `serialport`, `@tauri-apps/*`, `react`, `fetch`, `node:`, `bun:sqlite`,
and **`Intl.*`**.

`Intl` deserves its own line: money is integer satang, so ฿45.50 *is* the integer
4550. Rendering it through `Intl.NumberFormat` reintroduces a float and makes the
output depend on the machine's locale data. The byte stream is native and belongs
behind the invoke bridge.

### ProductVariant
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| product_id | uuid | FK → products |
| sku | text | Unique per branch |
- Fields: id uuid; product_id uuid; sku text; name_th text; name_en text; size text; image_url text; created_at timestamptz; updated_at timestamptz

### PriceList
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| version | int | Server wins by version (last-write-wins) |
- Fields: id uuid; branch_id uuid; name text; version int; effective_from timestamptz; effective_to timestamptz; is_active boolean; created_at timestamptz; updated_at timestamptz

### PriceListEntry
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| price_list_id | uuid | FK → price_lists |
| unit_price_satang | int | Price server-sourced, integer satang |
- Fields: id uuid; price_list_id uuid; product_variant_id uuid; unit_price_satang int; currency_code text; created_at timestamptz

### Promotion
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| code | text | Unique per branch |
| type | promotion_type | percent \| fixed_amount \| bundle \| buy_x_get_y \| points_exchange |
- Fields: id uuid; branch_id uuid; code text; name_th text; type promotion_type; version int; priority int; starts_at timestamptz; ends_at timestamptz; min_spend_satang int; max_discount_satang int; is_active boolean; created_at timestamptz; updated_at timestamptz

### PromotionRule
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| promotion_id | uuid | FK → promotions |
| rule_type | text | trigger \| reward \| exclusion |
- Fields: id uuid; promotion_id uuid; rule_type text; operator text; value text; target_variant_id uuid; target_category_id uuid; target_product_id uuid; quantity int; reward_variant_id uuid; reward_quantity decimal(10,3); created_at timestamptz

### ComboComponent
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| product_id | uuid | Combo parent FK → products |
| component_variant_id | uuid | FK → product_variants |
- Fields: id uuid; product_id uuid; component_variant_id uuid; quantity decimal(10,3); sequence int; created_at timestamptz

### InventoryItem
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| product_variant_id | uuid | 1:1 when tracked |
- Fields: id uuid; branch_id uuid; product_variant_id uuid; sku text; name_th text; unit text; track_stock boolean; is_raw boolean; created_at timestamptz; updated_at timestamptz

### Recipe
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| product_variant_id | uuid | FK → product_variants |
| is_active | boolean | Drives menu recipe stock consumption |
- Fields: id uuid; product_variant_id uuid; yield_unit text; yield_quantity decimal(10,3); is_active boolean; created_at timestamptz; updated_at timestamptz

### RecipeComponent
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| recipe_id | uuid | FK → recipes |
| inventory_item_id | uuid | Consumed component |
- Fields: id uuid; recipe_id uuid; inventory_item_id uuid; quantity decimal(10,3); unit text; created_at timestamptz

### StockMovement
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| inventory_item_id | uuid | FK → inventory_items |
| type | stock_movement_type | sale \| refund \| waste \| purchase \| adjustment_in/out \| transfer_* \| count_correction \| combo_component |
- Fields: id uuid; inventory_item_id uuid; branch_id uuid; type stock_movement_type; quantity decimal(10,3); satang_value int; reference_order_line_id uuid; reference_stock_adjustment_id uuid; created_at timestamptz; created_by uuid; source text

### StockBalance
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| inventory_item_id | uuid | FK → inventory_items |
| on_hand | decimal | Derived server-side |
- Fields: id uuid; inventory_item_id uuid; branch_id uuid; on_hand decimal(12,3); reserved decimal(12,3); last_movement_id uuid; updated_at timestamptz

### StockAdjustment
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| inventory_item_id | uuid | FK → inventory_items |
| type | text | adjustment_in \| adjustment_out only |
- Fields: id uuid; inventory_item_id uuid; branch_id uuid; quantity decimal(10,3); reason text; created_at timestamptz; approved_by uuid; approved_at timestamptz

### Supplier
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| name_th | text | Not null |
- Fields: id uuid; branch_id uuid; name_th text; name_en text; contact_phone text; tax_id text; address text; created_at timestamptz; updated_at timestamptz

### OutboxItem
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| action | sync_action | push_order \| push_shift \| pull_catalog \| pull_customers \| pull_settings |
| status | outbox_status | pending → in_flight → done, or failed_permanent |
- Fields: id uuid; entity_id uuid; entity_type text; action sync_action; payload jsonb; status outbox_status; attempt_count int; last_error text; created_at timestamptz; due_at timestamptz; processed_at timestamptz

### IdempotencyKey
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| key_hash | text | Hash of client key + tenant |
| expires_at | timestamptz | 24 h window |
- Fields: id uuid; key_hash text; response jsonb; expires_at timestamptz; created_at timestamptz

### SyncCursor
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| terminal_id | uuid | FK → terminals |
| entity_type | text | Orders, catalog, settings |
- Fields: id uuid; terminal_id uuid; entity_type text; last_seen_id uuid; last_seen_at timestamptz; created_at timestamptz

### SyncConflict
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| entity_id | uuid | FK to conflicted entity |
| resolution | sync_conflict_status | open → resolved_* |
- Fields: id uuid; entity_id uuid; entity_type text; entity_json jsonb; detection_reason text; resolution sync_conflict_status; resolved_by uuid; resolved_at timestamptz; created_at timestamptz

### NeedsAttentionItem
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| entity_id | uuid | FK to flagged entity |
| severity | int | 1 low → 5 critical |
- Fields: id uuid; entity_id uuid; entity_type text; reason text; severity int; created_at timestamptz; resolved_at timestamptz; resolved_by uuid

### AuditLog
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| entity_id | uuid | FK to audited entity |
| action | text | create \| update \| status_change \| approve |
- Fields: id uuid; branch_id uuid; entity_type text; entity_id uuid; action text; actor_id uuid; before_json jsonb; after_json jsonb; created_at timestamptz

### Settings
| Field | Definition | Invariant |
|---|---|---|
| id | uuid v7 | PK, client-generated |
| branch_id | uuid | FK → branches |
| key | text | Unique per branch |
- Fields: id uuid; branch_id uuid; key text; value jsonb; updated_by uuid; updated_at timestamptz

