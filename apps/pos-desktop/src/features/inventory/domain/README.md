# inventory / domain

**Layer:** innermost (client domain) · **Runtime:** pure TypeScript, no I/O

Stock view and adjustment rules.

## Boundary

Same rule as `sales/domain` — **no** React, Tauri, or SQL imports.

## Critical rule — stock is a ledger

Stock is a **ledger of movements**, never an overwritten number. The server
computes the balance. Writing `UPDATE products SET stock = ?` is a defect:
it destroys history and makes offline sync unresolvable.

## Conflict rule

Inventory is the one area where offline writes genuinely conflict — the same
units may be sold on two terminals before either syncs. The server owns
reconciliation. See `ARCHITECTURE-DEMO.md` §9 "Conflict rules".

## Entities

`InventoryItem` · `StockMovement` · `StockBalance` · `StockAdjustment` · `Supplier`
