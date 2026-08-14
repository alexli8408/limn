#!/usr/bin/env bash
#
# Applies every migration to a throwaway database and asserts the behaviour that
# the application cannot enforce for itself.
#
# Worth running against plain Postgres rather than only against a hosted
# Supabase project: a hosted project grants `anon`/`authenticated` broad default
# privileges, which masks a migration that forgot to grant anything at all.
#
#   ./supabase/tests/run.sh              # uses a local postgres on :5432
#   PGHOST=... PGPORT=... ./run.sh       # or point it anywhere
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${LIMN_TEST_DB:-limn_validate}"
PSQL=(psql -q -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "${PGUSER:-$USER}")

echo "==> recreating $DB"
"${PSQL[@]}" -d postgres -c "drop database if exists $DB;" -c "create database $DB;" >/dev/null

echo "==> installing Supabase schema stubs"
"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/00_supabase_stubs.sql" >/dev/null

echo "==> applying migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '    %s\n' "$(basename "$f")"
  "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$f" 2>&1 | grep -v 'skipping' || true
done

echo "==> running assertions"
OUT="$("${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/01_access_and_concurrency.sql" 2>&1)"
echo "$OUT"

if grep -q 'UNEXPECTED' <<<"$OUT"; then
  echo "FAIL: a security assertion did not hold" >&2
  exit 1
fi
if grep -qE '^psql:.*ERROR' <<<"$OUT"; then
  echo "FAIL: unexpected SQL error" >&2
  exit 1
fi

echo "PASS"
