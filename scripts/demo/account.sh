#!/usr/bin/env bash
#
# Makes the throwaway account the capture signs in as.
#
# Needed because there is deliberately no way around signing in: anonymous
# sign-ins are off, and the debug route that used to mint sessions was removed
# for being exactly the hole it looks like.
#
# The confirmation mail is never read, so the row is confirmed directly through
# the Management API. That needs the Supabase CLI to be logged in.
#
#   ./scripts/demo/account.sh
#   export DEMO_EMAIL=... DEMO_PASSWORD=...
#
# Delete the account when the demo is recorded; it owns real boards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
set -a && source "$ROOT/.env" && set +a

REF="$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https://([^.]+).*#\1#')"
EMAIL="${DEMO_EMAIL:-limn-demo-capture@axli.me}"
PASSWORD="Demo-$(openssl rand -hex 12)"

curl -fsS -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/signup" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"data\":{\"display_name\":\"Demo\"}}" \
  > /dev/null || true

TOKEN="$(security find-generic-password -s 'Supabase CLI' -w)"
curl -fsS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"query\":\"update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where email = '$EMAIL'\"}" \
  > /dev/null

echo "export DEMO_EMAIL='$EMAIL'"
echo "export DEMO_PASSWORD='$PASSWORD'"
