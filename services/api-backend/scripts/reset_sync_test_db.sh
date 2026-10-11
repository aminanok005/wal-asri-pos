#!/usr/bin/env bash
# Reset sync E2E test database (walasri_sync_e2e)
# Truncates data tables but preserves seeded branches table, then re-seeds
# Usage: ./reset_sync_test_db.sh
#
# SAFETY: This script ONLY operates on walasri_sync_e2e. It rejects any
# DATABASE_URL that points to a different database. It does NOT accept
# DATABASE_URL from the environment — the DB name is hardcoded.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Hardcoded test database name — DO NOT CHANGE
readonly EXPECTED_DB_NAME="walasri_sync_e2e"

# Reject external DATABASE_URL if provided
if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "ERROR: This script does not accept DATABASE_URL from environment." >&2
    echo "The test database name is hardcoded to: $EXPECTED_DB_NAME" >&2
    exit 1
fi

echo "Resetting database: $EXPECTED_DB_NAME"
echo "Preserving: branches (seeded)"
echo "Truncating: orders, order_lines, sync_outbox_items, idempotency_keys"

# Execute truncate
sudo nerdctl --namespace walasri exec wasri-postgres psql -U wasri_user -d "$EXPECTED_DB_NAME" -v ON_ERROR_STOP=1 -c "
TRUNCATE TABLE
    orders,
    order_lines,
    sync_outbox_items,
    idempotency_keys
RESTART IDENTITY CASCADE;"

echo "Verification counts after truncate:"
sudo nerdctl --namespace walasri exec wasri-postgres psql -U wasri_user -d "$EXPECTED_DB_NAME" -v ON_ERROR_STOP=1 -c "
SELECT 'orders' AS table_name, count(*) FROM orders
UNION ALL SELECT 'order_lines', count(*) FROM order_lines
UNION ALL SELECT 'sync_outbox_items', count(*) FROM sync_outbox_items
UNION ALL SELECT 'idempotency_keys', count(*) FROM idempotency_keys
UNION ALL SELECT 'branches', count(*) FROM branches;"

# Re-seed the test branch (vat_rate_bp = 700)
echo "Re-seeding test branch..."
"$SCRIPT_DIR/seed_test_db.sh"

echo "Done. branches seeded, data tables empty."