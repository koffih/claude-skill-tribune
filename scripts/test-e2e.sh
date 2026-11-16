#!/usr/bin/env bash
# AC3 / AC7: real browser journey through a host page, the widget, the portal and the admin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT/service"
URL=$(bash ../scripts/test-db.sh)
DB=tribune_e2e_$$
psql "$URL" -qc "create database $DB" >/dev/null
TP=${E2E_PORT:-58791}; HP=${E2E_HOST_PORT:-58799}
export DATABASE_URL="${URL%/*}/$DB" TRIBUNE_SECRET=e2e-secret MAIL_MODE=log TRIBUNE_PUBLIC_URL="http://127.0.0.1:$TP" PORT=$TP TRIBUNE_JOBS=0
export SHOTS_DIR="${SHOTS_DIR:-$ROOT/.proof/shots}"; mkdir -p "$SHOTS_DIR"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; psql "$URL" -qc "drop database if exists $DB with (force)" >/dev/null; }
trap cleanup EXIT
[ -f dist/server/main.js ] && [ "$(find src web -newer dist/server/main.js -type f | wc -l)" = 0 ] || npm run -s build >/dev/null
node dist/server/main.js > /tmp/tribune-e2e-$$.log 2>&1 & PIDS+=($!)
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$TP/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
SITE=e2e
OUT=$(node dist/server/cli.js create-site $SITE "Démo Tribune" --domains "http://127.0.0.1:$HP" 2>/dev/null)
SECRET=$(echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).jwt_secret))')
sign() { node dist/server/cli.js sign $SITE "$1"; }
SEED=$(curl -fsS -X POST -H 'content-type: application/json' "http://127.0.0.1:$TP/api/v1/sites/$SITE/auth/identify" \
  -d "{\"token\":\"$(sign '{"sub":"seed","email":"seed@example.com","name":"Nadia"}')\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
for t in "Export des factures en PDF" "Mode sombre" "Connexion avec Google"; do
  curl -fsS -X POST -H 'content-type: application/json' -H "authorization: Bearer $SEED" "http://127.0.0.1:$TP/api/v1/sites/$SITE/boards/idees/posts" \
    -d "{\"title\":\"$t\",\"body\":\"Idée de départ pour la démonstration.\"}" >/dev/null
done
export MOD_TOKEN=$(sign '{"sub":"mod-1","email":"equipe@example.com","name":"Équipe produit","role":"admin"}')
TRIBUNE_URL="http://127.0.0.1:$TP" TRIBUNE_SITE=$SITE TRIBUNE_JWT_SECRET="$SECRET" PORT=$HP node ../examples/host-node.mjs >/dev/null 2>&1 & PIDS+=($!)
sleep 0.5
TRIBUNE_URL="http://127.0.0.1:$TP" HOST_URL="http://127.0.0.1:$HP" TRIBUNE_SITE=$SITE npx playwright test -c playwright.config.mjs
