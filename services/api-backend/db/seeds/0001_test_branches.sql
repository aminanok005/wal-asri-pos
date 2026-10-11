-- 0001_test_branches.sql — Test-only seed for walasri_sync_e2e database.
-- This file is applied by seed_test_db.sh AFTER migrations.
-- DO NOT include in production migrations.

-- HARD RULE: vat_rate_bp MUST be 700 (7.00%).
-- This matches the UI's cash/tax calculation (TypeScript cashRounding, tax.ts).
-- Server re-prices at branch's vat_rate_bp (ingester.go:394).
-- Mismatch → held_for_review (ingest_order.go:428-438).
-- This seed ensures E2E tests exercise the happy path where re-price matches UI.

INSERT INTO branches (id, name, currency, vat_rate_bp, created_at, updated_at)
VALUES (
  '01a12114-8a57-7057-86c4-391860945134',  -- UUIDv7 from Go's uuid.NewV7()
  'Test Branch',
  'THB',
  700,  -- HARD RULE: 7.00% = 700 bp
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  vat_rate_bp = EXCLUDED.vat_rate_bp,
  updated_at = NOW();