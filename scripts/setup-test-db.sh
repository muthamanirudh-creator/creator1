#!/usr/bin/env bash
# Creates the PostgreSQL role/databases that test-phase2.js expects (govcareer / govcareer_test).
# Usage: bash scripts/setup-test-db.sh   (needs a local PostgreSQL and sudo/postgres access)
set -euo pipefail
PSQL="psql"; command -v sudo >/dev/null && id postgres >/dev/null 2>&1 && PSQL="sudo -u postgres psql"
$PSQL -tc "SELECT 1 FROM pg_roles WHERE rolname='govcareer'" | grep -q 1 || $PSQL -c "CREATE USER govcareer WITH PASSWORD 'govcareer' SUPERUSER;"
for db in govcareer govcareer_test; do
  $PSQL -tc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || $PSQL -c "CREATE DATABASE $db OWNER govcareer;"
done
echo "Test databases ready. Run: npm test"
