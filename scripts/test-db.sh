#!/usr/bin/env bash
# Start (or reuse) a throwaway PostgreSQL 17 for tests, print its URL.
set -euo pipefail
NAME=tribune-test-pg
PORT=${TRIBUNE_TEST_PG_PORT:-55433}
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test -p 127.0.0.1:$PORT:5432 postgres:17-alpine >/dev/null
fi
for i in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1
done
docker exec "$NAME" pg_isready -U postgres >/dev/null
echo "postgres://postgres:test@127.0.0.1:$PORT/postgres"
