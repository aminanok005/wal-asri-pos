#!/usr/bin/env bash
# Seed walasri_sync_e2e with test branch (vat_rate_bp = 700)
# Run AFTER migrations, BEFORE E2E tests.
# Usage: ./seed_test_db.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

readonly DB_NAME="walasri_sync_e2e"
readonly SEED_FILE="$PROJECT_ROOT/db/seeds/0001_test_branches.sql"

# Assert vat_rate_bp = 700 is explicitly in the seed file (allows inline comment)
if ! grep -q "700" "$SEED_FILE"; then
    echo "ERROR: Seed file must contain '700' for vat_rate_bp" >&2
    echo "Checked file: $SEED_FILE" >&2
    exit 1
fi

echo "Seeding database: $DB_NAME"
echo "Using seed file: $SEED_FILE"

# Apply seed via postgres container (pipe SQL content)
sudo nerdctl --namespace walasri exec -i wasri-postgres psql -U wasri_user -d "$DB_NAME" < "$SEED_FILE"

# Verify the seed took effect
echo "Verification:"
sudo nerdctl --namespace walasri exec wasri-postgres psql -U wasri_user -d "$DB_NAME" -c "
SELECT id, name, vat_rate_bp FROM branches WHERE vat_rate_bp = 700;"

echo "Seed complete."