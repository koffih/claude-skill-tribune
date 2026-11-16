#!/usr/bin/env bash
# AC5: the image builds, the compose stack starts and the health check answers.
set -euo pipefail
cd "$(dirname "$0")/../service"
P=tribune-ci-$$
export TRIBUNE_PORT=${TRIBUNE_CI_PORT:-58790}
cat > .env.ci <<ENV
TRIBUNE_PUBLIC_URL=http://127.0.0.1:$TRIBUNE_PORT
TRIBUNE_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
MAIL_MODE=log
ENV
set -a; . ./.env.ci; set +a
export TRIBUNE_ENV_FILE=.env.ci
trap 'docker compose -p $P --env-file .env.ci down -v >/dev/null 2>&1; rm -f .env.ci' EXIT
docker compose -p $P --env-file .env.ci up -d --build --quiet-pull 2>&1 | tail -3
for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$TRIBUNE_PORT/healthz" && echo && break; sleep 2; done
curl -fsS "http://127.0.0.1:$TRIBUNE_PORT/healthz" | grep -q '"ok":true'
curl -fsS -o /dev/null "http://127.0.0.1:$TRIBUNE_PORT/widget.js"
docker compose -p $P --env-file .env.ci exec -T tribune node dist/server/cli.js create-site ci "CI" | grep -q jwt_secret
echo "docker ok"
