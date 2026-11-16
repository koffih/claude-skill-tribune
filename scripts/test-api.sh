#!/usr/bin/env bash
# AC2 / AC4: API rules against a throwaway PostgreSQL.  --only backlog runs the backlog test alone.
set -euo pipefail
cd "$(dirname "$0")/../service"
URL=$(bash ../scripts/test-db.sh)
DB=tribune_api_$$
psql "$URL" -qc "create database $DB" >/dev/null
trap 'psql "$URL" -qc "drop database if exists $DB with (force)" >/dev/null' EXIT
export DATABASE_URL="${URL%/*}/$DB" TRIBUNE_SECRET=test-secret MAIL_MODE=file MAIL_DIR="$(mktemp -d)" TRIBUNE_JOBS=0
[ "${1:-}" = "--only" ] && export ONLY="$2"
node --import tsx --test --test-concurrency=1 --test-reporter=spec test/api.test.ts
