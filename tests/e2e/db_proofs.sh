#!/bin/bash
# ════════════════════════════════════════════════════════════════════
#  THE DATABASE PROOFS, RUN — the population CURRENT_STATE #17 said
#  "nothing runs", made unavoidable the same way verify_all.sh made the
#  e2e proofs unavoidable: ONE script, run identically by a developer and
#  by CI.
#
#  It builds a disposable database from the REAL migration chain, points
#  HARNESS_DATABASE_URL at it with DATABASE_URL deliberately UNSET (the
#  same-target guard in tests/_run_receipt.js is then satisfied for the
#  right reason), and runs every proof in tests/proofs/db_proofs.manifest:
#
#    run      a failure FAILS this script
#    backlog  reported, never fatal — and a backlog proof that PASSES is
#             named at the end so it can be promoted
#
#  Proofs COMMIT their fixtures and never clean up, so the database is
#  dropped and rebuilt on every invocation. Order is the manifest's order.
#
#      ./tests/e2e/db_proofs.sh
#      PROOF_DATABASE_URL=postgres://... ./tests/e2e/db_proofs.sh
# ════════════════════════════════════════════════════════════════════
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT" || exit 1
PROOF_DATABASE_URL="${PROOF_DATABASE_URL:-postgres://postgres:spineproof@127.0.0.1:5432/spine_proofs}"
BASE="${PROOF_DATABASE_URL%%\?*}"
ADMIN="${BASE%/*}/postgres"
DBNAME="$(basename "$BASE")"
MANIFEST="tests/proofs/db_proofs.manifest"

echo "════════════════════════════════════════════════════════════"
echo "  PROPERTY SPINE — DATABASE PROOFS"
echo "  database: $BASE  (dropped and rebuilt from the migration chain)"
echo "════════════════════════════════════════════════════════════"

psql "$ADMIN" -q -c "drop database if exists $DBNAME" >/dev/null 2>&1
psql "$ADMIN" -q -c "create database $DBNAME" >/dev/null 2>&1 || { echo "  ✗ could not create $DBNAME"; exit 1; }
if ! E2E_DATABASE_URL="$PROOF_DATABASE_URL" ./tests/e2e/apply_migrations.sh > /tmp/db_proofs_schema.log 2>&1; then
  echo "  ✗ schema from the migration chain FAILED"; tail -8 /tmp/db_proofs_schema.log | sed 's/^/      /'; exit 1
fi
echo "── schema from the migration chain      $(tail -1 /tmp/db_proofs_schema.log)"

#  DATABASE_URL must NOT be set here. A proof that reads it would be an
#  unguarded consumer (gate_harness_isolation), and the guard refuses a
#  harness whose target equals DATABASE_URL — which, in CI, it would.
unset DATABASE_URL
export HARNESS_DATABASE_URL="$PROOF_DATABASE_URL"
export OPERATOR_KEY="${OPERATOR_KEY:-proof-operator-key}"
export NODE_ENV="${NODE_ENV:-test}"

RUN_FAIL=0; RUN_PASS=0; BACKLOG_FAIL=0; BACKLOG_PASS=""; FAILED_RUN=""
mkdir -p /tmp/db_proofs
while IFS=$'\t' read -r mode file reason; do
  case "$mode" in run|backlog) ;; *) continue ;; esac
  [ -f "tests/proofs/$file" ] || { echo "── $file  MISSING (manifest names a file that is not on disk)"; RUN_FAIL=1; FAILED_RUN="$FAILED_RUN $file"; continue; }
  start=$(date +%s)
  timeout 300 node "tests/proofs/$file" > "/tmp/db_proofs/${file%.db.js}.log" 2>&1; ec=$?
  secs=$(( $(date +%s) - start ))
  if [ "$ec" = "0" ]; then verdict="PASS"; else verdict="FAIL($ec)"; fi
  printf '── %-8s %-48s %-8s %3ss\n' "$mode" "$file" "$verdict" "$secs"
  if [ "$mode" = "run" ]; then
    if [ "$ec" = "0" ]; then RUN_PASS=$((RUN_PASS+1)); else RUN_FAIL=1; FAILED_RUN="$FAILED_RUN $file"
      grep -E "FAIL|Cause|Error|REFUSED" "/tmp/db_proofs/${file%.db.js}.log" | grep -v "✗ FAIL —" | head -6 | sed 's/^/      /'; fi
  else
    if [ "$ec" = "0" ]; then BACKLOG_PASS="$BACKLOG_PASS $file"; else BACKLOG_FAIL=$((BACKLOG_FAIL+1)); fi
  fi
done < <(grep -vE '^\s*#|^\s*$' "$MANIFEST")

# ── SECTION 2: the unguarded population (tests/proofs/unguarded_proofs.manifest) ──
#  These read DATABASE_URL directly. A SECOND disposable database is built for
#  them so DATABASE_URL and HARNESS_DATABASE_URL name different targets and the
#  same-target guard passes for the right reason. Never point DATABASE_URL at
#  anything real here.
NP_URL="${BASE}_unguarded${PROOF_DATABASE_URL#$BASE}"
NP_NAME="$(basename "${NP_URL%%\?*}")"
psql "$ADMIN" -q -c "drop database if exists $NP_NAME" >/dev/null 2>&1
psql "$ADMIN" -q -c "create database $NP_NAME" >/dev/null 2>&1 || { echo "  ✗ could not create $NP_NAME"; RUN_FAIL=1; }
if E2E_DATABASE_URL="$NP_URL" ./tests/e2e/apply_migrations.sh > /tmp/db_proofs_schema2.log 2>&1; then
  echo "── schema for the unguarded section     $(tail -1 /tmp/db_proofs_schema2.log)"
  export DATABASE_URL="$NP_URL"
  while IFS=$'\t' read -r mode file reason; do
    case "$mode" in run|backlog) ;; *) continue ;; esac
    [ -f "tests/$file" ] || { echo "── $file  MISSING (manifest names a file that is not on disk)"; RUN_FAIL=1; FAILED_RUN="$FAILED_RUN $file"; continue; }
    start=$(date +%s)
    timeout 300 node "tests/$file" > "/tmp/db_proofs/$(basename "${file%.js}").log" 2>&1; ec=$?
    for pid in $(pgrep -f "^node server\.js$"); do kill "$pid" 2>/dev/null; done   # a proof that spawned the server and died
    secs=$(( $(date +%s) - start ))
    if [ "$ec" = "0" ]; then verdict="PASS"; else verdict="FAIL($ec)"; fi
    printf '── %-8s %-48s %-8s %3ss\n' "$mode" "$file" "$verdict" "$secs"
    if [ "$mode" = "run" ]; then
      if [ "$ec" = "0" ]; then RUN_PASS=$((RUN_PASS+1)); else RUN_FAIL=1; FAILED_RUN="$FAILED_RUN $file"
        grep -E "FAIL|Cause|Error|REFUSED" "/tmp/db_proofs/$(basename "${file%.js}").log" | grep -v "✗ FAIL —" | head -6 | sed 's/^/      /'; fi
    else
      if [ "$ec" = "0" ]; then BACKLOG_PASS="$BACKLOG_PASS $file"; else BACKLOG_FAIL=$((BACKLOG_FAIL+1)); fi
    fi
  done < <(grep -vE '^\s*#|^\s*$' tests/proofs/unguarded_proofs.manifest)
  unset DATABASE_URL
else
  echo "  ✗ schema for the unguarded section FAILED"; tail -8 /tmp/db_proofs_schema2.log | sed 's/^/      /'; RUN_FAIL=1
fi

echo "════════════════════════════════════════════════════════════"
echo "  run proofs passed: $RUN_PASS   backlog still failing: $BACKLOG_FAIL"
[ -n "$BACKLOG_PASS" ] && echo "  ⚠ BACKLOG PROOFS THAT PASSED — promote them to \`run\`:$BACKLOG_PASS"
if [ "$RUN_FAIL" = "0" ]; then echo "  ALL \`run\` DATABASE PROOFS PASSED"; else echo "  ✗ DATABASE PROOFS FAILED:$FAILED_RUN"; fi
echo "════════════════════════════════════════════════════════════"
exit $RUN_FAIL
