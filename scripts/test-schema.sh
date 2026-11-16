#!/usr/bin/env bash
# AC1: the schema applies on an empty database, then a second time, without error.
set -euo pipefail
cd "$(dirname "$0")/.."
URL=$(bash scripts/test-db.sh)
DB=tribune_schema_$$
psql "$URL" -qc "create database $DB" >/dev/null
trap 'psql "$URL" -qc "drop database if exists $DB" >/dev/null' EXIT
U="${URL%/*}/$DB"
for pass in 1 2; do
  for f in service/sql/*.sql; do PGOPTIONS="-c search_path=tribune,public,extensions -c client_min_messages=warning" psql "$U" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null; done
  echo "pass $pass ok"
done
n=$(psql "$U" -Atc "select count(*) from information_schema.tables where table_schema='tribune' and table_type='BASE TABLE'")
echo "tables: $n"
[ "$n" -ge 17 ]
v=$(psql "$U" -Atc "select tribune.norm('Écrire À Noël')")
echo "norm: $v"
[ "$v" = "ecrire a noel" ]
