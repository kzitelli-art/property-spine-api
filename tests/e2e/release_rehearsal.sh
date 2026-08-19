#!/bin/bash
# ════════════════════════════════════════════════════════════════════
#  RELEASE REHEARSAL — prove the release set BEFORE touching production.
#
#  Builds a schema to a SIMULATED LIVE CEILING, then applies only the
#  proposed release set on top, then runs the existing proofs against it.
#
#      ./tests/e2e/release_rehearsal.sh 181 182,183,184,185,186,187
#                                        ^ceiling  ^release set
#
#  WHY THIS IS NOT THE SAME AS THE E2E DATABASE. The e2e schema is built
#  from empty straight through to the top, so a migration is never applied
#  to a schema that stopped somewhere else first. Production HAS stopped
#  somewhere else. This rehearsal is the only way to find a migration that
#  applies fine in sequence but not onto the ceiling production is at.
#
#  ⚠ WHAT IT STILL DOES NOT PROVE. The rehearsal schema is EMPTY of
#  production data, so it cannot exercise the three things that can refuse
#  a migration against real rows — a UNIQUE index over existing
#  duplicates, a NOT NULL added to a populated table, a CHECK over rows
#  that already violate it. Those are what `release_reconcile.js`
#  generates preflight queries for, and they must be run against
#  PRODUCTION. A green rehearsal plus unrun preflight queries is not a
#  release decision.
# ════════════════════════════════════════════════════════════════════
set -u
CEILING="${1:?usage: release_rehearsal.sh <live-ceiling> <comma-separated release set>}"
RELEASE="${2:?usage: release_rehearsal.sh <live-ceiling> <comma-separated release set>}"
DB="${REHEARSAL_DB:-spine_rehearsal}"
SUPER="${SUPER_URL:-postgres://postgres:spineproof@127.0.0.1:5432/postgres}"
E="${REHEARSAL_URL:-postgres://postgres:spineproof@127.0.0.1:5432/$DB}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT" || exit 1

echo "── rebuilding $DB to ceiling $CEILING ──"
psql "$SUPER" -q -c "drop database if exists $DB" >/dev/null 2>&1
psql "$SUPER" -q -c "create database $DB" >/dev/null 2>&1 || { echo "cannot create $DB"; exit 1; }
psql "$E" -q -f migrations/000_schema_migrations.sql >/dev/null 2>&1

apply () {  # $1 = file
  local v; v=$(basename "$1" | cut -c1-3)
  psql "$E" -tAc "select 1 from schema_migrations where version='$v'" 2>/dev/null | grep -q 1 && return 0
  #  DATA-DEPENDENT MIGRATIONS. A few refuse unless rows already exist —
  #  correct behaviour for a backfill or an authority grant, and the reason
  #  a from-empty build stops where production sails past. The precondition
  #  fixture for a version, if there is one, is applied immediately before
  #  it. See tests/e2e/preconditions/README.md.
  local pre="$ROOT/tests/e2e/preconditions/$v.sql"
  #  A PRECONDITION THAT FAILS SILENTLY IS WORSE THAN NONE: the migration
  #  then refuses for its own reason and the real cause is invisible. Errors
  #  are surfaced, and the fixture must satisfy the schema AS IT IS AT THIS
  #  POINT IN THE CHAIN — not as it looks at the top.
  if [ -f "$pre" ]; then
    if ! psql "$E" -q -v ON_ERROR_STOP=1 -f "$pre" >/tmp/pre.log 2>&1; then
      echo "   PRECONDITION FAILED for $v"
      grep -oE 'ERROR:.*' /tmp/pre.log | head -2 | sed 's/^/        /'
    fi
  fi
  if psql "$E" -q -v ON_ERROR_STOP=1 -f "$1" >/tmp/reh.log 2>&1; then
    psql "$E" -q -c "insert into schema_migrations (version,name) values ('$v','$(basename "$1")') on conflict do nothing" >/dev/null 2>&1
    return 0
  fi
  grep -q "duplicate key value.*schema_migrations_pkey" /tmp/reh.log && return 0
  echo "   STOP $(basename "$1")"; grep -oE 'ERROR:.*' /tmp/reh.log | head -1 | sed 's/^/        /'
  return 1
}

for f in $(ls migrations/*.sql | grep -vE '000_schema_migrations' | sort); do
  v=$(basename "$f" | cut -c1-3)
  [ "$((10#$v))" -le "$((10#$CEILING))" ] || continue
  apply "$f" || exit 1
done
echo "   at ceiling: $(psql "$E" -tAc 'select max(version::int) from schema_migrations')"

echo "── applying the release set: $RELEASE ──"
IFS=',' read -ra SET <<< "$RELEASE"
for v in "${SET[@]}"; do
  f=$(ls migrations/${v}_*.sql 2>/dev/null | head -1)
  [ -z "$f" ] && { echo "   no file for $v"; exit 1; }
  apply "$f" || exit 1
  echo "   applied $(basename "$f")"
done
echo "   new ceiling: $(psql "$E" -tAc 'select max(version::int) from schema_migrations')"
echo
echo "Now seed fixtures and run the SAME proofs against $E."
echo "The release candidate must reproduce the behaviour already proven — not a lighter version of it."
