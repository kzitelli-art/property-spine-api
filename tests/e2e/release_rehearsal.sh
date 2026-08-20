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

#  ── THE RELEASE SET GOES IN THROUGH THE REAL RELEASE COMMAND ────────
#  The ceiling above is simulated history and raw psql is right for it.
#  The release set is the thing UNDER TEST, so it must arrive the way it
#  will arrive in production — through migrate.js --apply, with its
#  ceiling pin, its sha pin, and its refusals. Applying it with psql here
#  would rehearse everything except the command we are about to run.
START_CEILING=$(psql "$E" -tAc 'select max(version::int) from schema_migrations')
#  The entry COUNT is captured here, before anything is applied, because
#  the --after verdict asserts the ledger grew by exactly the release set
#  and nothing else rode along. Hardcoding it would make the assertion
#  true by construction at every ceiling except the one it was written for.
START_ENTRIES=$(psql "$E" -tAc 'select count(*) from schema_migrations')
echo "── releasing $RELEASE through migrate.js --apply (ceiling $START_CEILING, $START_ENTRIES entries) ──"

#  The BEFORE gate is part of the ceremony, so it is part of the rehearsal.
if ! node tests/e2e/verify_release_182_187.js --db "$E" --before >/tmp/rehearse_before.log 2>&1; then
  echo "   ✗ NOT SAFE TO APPLY"; tail -12 /tmp/rehearse_before.log | sed 's/^/        /'; exit 1
fi
echo "   before gate: safe to apply"

#  EXPECTED_SHA is only meaningful over a clean tree — migrate.js refuses
#  a pin that does not describe the working tree, and it is RIGHT to. In a
#  rehearsal a dirty tree is normal, so the pin is passed when it can be
#  honoured and its absence is stated rather than papered over.
SHA_ARG=""
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  SHA_ARG="EXPECTED_SHA=$(git rev-parse HEAD)"
  echo "   pinning $(git rev-parse --short HEAD)"
else
  echo "   NOT PINNED — working tree is dirty (fine here, refused in production)"
fi

if ! env DATABASE_URL="$E" MIGRATION_RELEASE=1 \
     EXPECTED_LEDGER_CEILING="$START_CEILING" $SHA_ARG \
     node migrations/migrate.js --apply > /tmp/rehearse_release.log 2>&1; then
  echo "   ✗ RELEASE REFUSED"; tail -20 /tmp/rehearse_release.log | sed 's/^/        /'; exit 1
fi
grep -E '^  (→|    ✓)' /tmp/rehearse_release.log | sed 's/^/   /'
echo "   new ceiling: $(psql "$E" -tAc 'select max(version::int) from schema_migrations')"

#  ── THE PROOFS. NOT AN INSTRUCTION TO RUN THEM ──────────────────────
#  This script used to end by PRINTING "now seed fixtures and run the same
#  proofs". A sentence telling a person to verify something is not
#  verification, and a rehearsal that stops one step short of the only
#  question that matters — does the UPGRADED schema behave like the one we
#  proved? — is a rehearsal of the easy half.
echo
echo "── the same proofs, against the upgraded schema ──"
FAILED=0
rstep () { local label="$1"; shift
  printf '   %-30s ' "$label"
  if "$@" >/tmp/rehearse_step.log 2>&1; then echo "PASS"; else
    echo "FAIL"; FAILED=1; tail -12 /tmp/rehearse_step.log | sed 's/^/        /'; fi
}

export E2E_DATABASE_URL="$E"
rstep "property fixture"   psql "$E" -q -v ON_ERROR_STOP=1 -f tests/e2e/property_fixture.sql
rstep "pricing fixture"    psql "$E" -q -v ON_ERROR_STOP=1 -f tests/e2e/fixtures.sql
rstep "instrument fixture" node tests/e2e/instrument_fixture.js

. ./tests/e2e/port_guard.sh
if port_busy 3000; then
  echo "   ✗ port 3000 already in use — refusing to rehearse against a server we did not start"
  port_busy_message 3000 | sed 's/^/     /'
  exit 1
fi
./tests/e2e/boot.sh > /tmp/rehearse_server.log 2>&1 &
BOOT_PID=$!
#  The liveness check is the point: if boot.sh refused the port, health
#  will still answer — from the server we did NOT start, against a schema
#  this rehearsal knows nothing about.
UP=0
for _ in $(seq 1 40); do
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then break; fi
  curl -sf --noproxy '*' http://127.0.0.1:3000/health >/dev/null 2>&1 && { UP=1; break; }
  sleep 0.5
done
if [ "$UP" != "1" ]; then
  echo "   ✗ our server never came up — NOT trusting whatever else may answer"
  tail -15 /tmp/rehearse_server.log | sed 's/^/        /'
  kill $BOOT_PID 2>/dev/null; exit 1
fi

rstep "release verdict"    env EXPECTED_START_ENTRIES="$START_ENTRIES" node tests/e2e/verify_release_182_187.js --db "$E" --after
for t in leasing_path leasing_hostile leasing_standing_probe leasing_ask_spine leasing_reconciliation; do
  rstep "$t" node "tests/e2e/${t}.e2e.js"
done
kill $BOOT_PID 2>/dev/null

echo
if [ "$FAILED" -eq 0 ]; then
  echo "   ✓ REHEARSAL GREEN — the upgraded schema carries the proven behaviour."
  echo "     This proves the MECHANISM. It cannot prove production's DATA:"
  echo "     run release_reconcile.js preflight against production for that."
else
  echo "   ✗ REHEARSAL FAILED — do not release."
fi
exit "$FAILED"
