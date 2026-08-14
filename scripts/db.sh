#!/usr/bin/env bash
#
# Runs a Supabase CLI database command over the connection pooler instead of the
# direct database host.
#
#   ./scripts/db.sh push
#   ./scripts/db.sh pull
#   ./scripts/db.sh push --dry-run
#
# Why this exists
# ---------------
# `supabase db push` connects to db.<ref>.supabase.co, which since 2024 resolves
# only over IPv6 (IPv4 on that host is a paid add-on). Any network that cannot
# carry IPv6 to it fails with:
#
#     failed to connect to postgres: ... Connection terminated unexpectedly
#
# which reads like an auth or provisioning problem and is neither. It is
# particularly likely behind a fake-IP proxy, Clash, Shadowrocket, sing-box,
# where every hostname resolves to a synthetic 198.18.x.x address and only the
# proxied protocols actually reach anywhere. TCP still completes a handshake
# against the local proxy, so even a port check looks healthy.
#
# The pooler (aws-N-<region>.pooler.supabase.com) is reachable over IPv4 and
# works in all of those situations. `supabase link` already caches its URL; this
# just injects the password and hands it to the CLI.
#
# Port 5432 is session mode, which is what migrations need, transaction mode on
# 6543 does not support the advisory locks and prepared statements the CLI uses.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POOLER_FILE="$ROOT/supabase/.temp/pooler-url"

if [[ $# -eq 0 ]]; then
  echo "usage: ./scripts/db.sh <push|pull|...> [args]" >&2
  exit 64
fi

if [[ ! -f "$POOLER_FILE" ]]; then
  echo "No cached pooler URL at supabase/.temp/pooler-url." >&2
  echo "Run 'supabase link --project-ref <ref>' first, link writes it." >&2
  exit 1
fi

BASE_URL="$(tr -d '[:space:]' < "$POOLER_FILE")"

# The cached URL has no password: postgresql://user@host:5432/db
if [[ ! "$BASE_URL" =~ ^postgresql://([^@]+)@(.+)$ ]]; then
  echo "Unrecognised pooler URL: $BASE_URL" >&2
  exit 1
fi
DB_USER="${BASH_REMATCH[1]}"
DB_HOST="${BASH_REMATCH[2]}"

if [[ -z "${SUPABASE_DB_PASSWORD:-}" ]]; then
  # Read from the terminal, not stdin, so this still works when piped.
  read -r -s -p "Database password for ${DB_USER}: " SUPABASE_DB_PASSWORD < /dev/tty
  echo
fi

if [[ -z "$SUPABASE_DB_PASSWORD" ]]; then
  echo "No password given. Reset it at Project Settings → Database if you lost it." >&2
  exit 1
fi

# Percent-encode: a password containing @ / : ? # would otherwise corrupt the URL.
ENCODED="$(
  SUPABASE_DB_PASSWORD="$SUPABASE_DB_PASSWORD" python3 -c \
    'import os, urllib.parse; print(urllib.parse.quote(os.environ["SUPABASE_DB_PASSWORD"], safe=""))'
)"

SUBCOMMAND="$1"; shift

echo "→ supabase db ${SUBCOMMAND} via ${DB_HOST%%/*}"
exec supabase db "$SUBCOMMAND" --db-url "postgresql://${DB_USER}:${ENCODED}@${DB_HOST}" "$@"
