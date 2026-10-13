-- Migration 0007: add cloud reconciliation cursor and cloud quantity caching

-- Add cloud_updated_at column: server’s clock for each StockBalance row.
-- This is the new cursor for incremental pulls (MAX(cloud_updated_at)).
ALTER TABLE stock_balances ADD COLUMN cloud_updated_at TEXT;

-- Add conflict_cloud_quantity_milli column: store the cloud’s quantity when a
-- conflict is detected (requires_reconcile = 1). Cleared by resolve.
ALTER TABLE stock_balances ADD COLUMN conflict_cloud_quantity_milli INTEGER;

-- Backfill: for existing rows, set cloud_updated_at = updated_at (old cursor).
UPDATE stock_balances SET cloud_updated_at = updated_at;

PRAGMA user_version = 7;
