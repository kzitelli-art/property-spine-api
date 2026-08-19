#!/bin/bash
# ════════════════════════════════════════════════════════════════════
#  EVERY PROOF THAT MATTERS, IN ONE COMMAND.
#
#  ONE script, TWO callers: a developer runs it directly, CI runs the same
#  file. A CI pipeline that lists the steps itself drifts from what a
#  person runs locally, and then "green in CI" and "green on my machine"
#  stop meaning the same thing.
#
#  It exits non-zero if ANY proof fails. That is the whole point: this
#  repository accumulates intent faster than executable proof, and every
#  significant defect found in the leasing work was invisible in source
#  and obvious the moment something ran.
#
#      ./tests/e2e/verify_all.sh
#      E2E_DATABASE_URL=postgres://... ./tests/e2e/verify_all.sh
#
#  Requires a reachable Postgres. The browser rung additionally needs
#  Chromium; when it is absent the rung is reported SKIPPED — loudly, and
#  named in the summary — never silently passed.
# ════════════════════════════════════════════════════════════════════
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT" || exit 1
export E2E_DATABASE_URL="${E2E_DATABASE_URL:-postgres://postgres:spineproof@127.0.0.1:5432/spine_verify}"
ADMIN="${E2E_DATABASE_URL%/*}/postgres"

FAILED=0; SKIPPED=""
step () {  # $1 = label, rest = command
  local label="$1"; shift
  printf '── %-34s ' "$label"
  if "$@" >/tmp/verify_step.log 2>&1; then echo "PASS"; else
    echo "FAIL"; FAILED=1
    sed 's/^/      /' /tmp/verify_step.log | tail -25
  fi
}

echo "════════════════════════════════════════════════════════════"
echo "  PROPERTY SPINE — FULL VERIFICATION"
echo "  database: ${E2E_DATABASE_URL%%\?*}"
echo "════════════════════════════════════════════════════════════"

# ── proofs that need no database ────────────────────────────────────
step "source governance gates"   node tests/verify_source_governance.js
step "next-action oracle"        node src/shared/proof_next_action_resolver.js

# ── build the schema from the REAL chain ────────────────────────────
psql "$ADMIN" -q -c "drop database if exists $(basename "${E2E_DATABASE_URL%%\?*}")" >/dev/null 2>&1
psql "$ADMIN" -q -c "create database $(basename "${E2E_DATABASE_URL%%\?*}")"        >/dev/null 2>&1
step "schema from the migration chain"  ./tests/e2e/apply_migrations.sh
step "property fixture"     psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f tests/e2e/property_fixture.sql
step "pricing fixture"      psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f tests/e2e/fixtures.sql
step "instrument fixture"   node tests/e2e/instrument_fixture.js

# ── the real server, the real HTTP door ─────────────────────────────
./tests/e2e/boot.sh > /tmp/verify_server.log 2>&1 &
SERVER_PID=$!
UP=0
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health 2>/dev/null)" = "200" ] && { UP=1; break; }
  sleep 1
done
if [ "$UP" != "1" ]; then
  echo "── server                             FAIL (did not become healthy)"
  tail -25 /tmp/verify_server.log | sed 's/^/      /'
  FAILED=1
else
  echo "── server                             UP  ($(curl -s http://localhost:3000/health | head -c 120))"
  step "leasing clean path"          node tests/e2e/leasing_path.e2e.js
  step "hostile falsifications"      node tests/e2e/leasing_hostile.e2e.js
  step "cross-surface reconciliation" node tests/e2e/leasing_reconciliation.e2e.js
  step "standing vs review"          node tests/e2e/leasing_standing_probe.e2e.js
  step "ask spine facts"             node tests/e2e/leasing_ask_spine.e2e.js

  if [ -x "${CHROMIUM:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}" ]; then
    step "browser: resident signs"   node tests/e2e/resident_signing.browser.js
  else
    echo "── browser: resident signs            SKIPPED (no Chromium)"
    SKIPPED="browser rung"
  fi
  kill "$SERVER_PID" 2>/dev/null
fi

echo "════════════════════════════════════════════════════════════"
[ -n "$SKIPPED" ] && echo "  ⚠ NOT RUN: $SKIPPED — this is not a pass."
if [ "$FAILED" = "0" ]; then echo "  ALL PROOFS PASSED"; else echo "  ✗ VERIFICATION FAILED"; fi
echo "════════════════════════════════════════════════════════════"
exit $FAILED
