# catalog / domain

**Layer:** innermost (client domain) · **Runtime:** pure TypeScript, no I/O

Products, prices, barcodes. Read-mostly, synced down from the server.

## Boundary

Same rule as `sales/domain` — **no** React, Tauri, or SQL imports. Express
dependencies as ports.

## Conflict rule

Catalog and prices are **server-authoritative** (last-write-wins by version).
The client never originates catalog mutations; it only applies pulled deltas.

## Entities

`Category` · `Product` · `ProductVariant` · `PriceList` · `PriceListEntry` ·
`Promotion` · `PromotionRule` · `ComboComponent`

See `docs/02-design/DOMAIN.md` for full field definitions and invariants.
