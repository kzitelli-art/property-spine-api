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
export E2E_SMS_LOG="${E2E_SMS_LOG:-/tmp/property_spine_e2e_sms.log}"
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
step "application review actions" node tests/unit/application_review_action_contract.test.js

# ── build the schema from the REAL chain ────────────────────────────
psql "$ADMIN" -q -c "drop database if exists $(basename "${E2E_DATABASE_URL%%\?*}")" >/dev/null 2>&1
psql "$ADMIN" -q -c "create database $(basename "${E2E_DATABASE_URL%%\?*}")"        >/dev/null 2>&1
step "schema from the migration chain"  ./tests/e2e/apply_migrations.sh
step "property fixture"     psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f tests/e2e/property_fixture.sql
step "pricing fixture"      psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f tests/e2e/fixtures.sql
step "instrument fixture"   node tests/e2e/instrument_fixture.js

# ── lease / guarantor database proofs ───────────────────────────────
# These use the repository's production-refusing harness boundary. CI's
# E2E database is disposable and becomes the explicit harness target;
# there is no fallback to DATABASE_URL.
step "governing lease execution" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/governing_lease_execution.db.js
step "canonical lease execution" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/spine_lease_execution.db.js
step "lease guarantor signing"   env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/lease_guarantor_signing.db.js

# ── the real server, the real HTTP door ─────────────────────────────
#  ASK BEFORE LAUNCHING. Polling /health afterwards cannot distinguish
#  our server from a stale one — see tests/e2e/port_guard.sh.
. ./tests/e2e/port_guard.sh
if port_busy 3000; then
  echo "── server                             FAIL (port 3000 already in use)"
  port_busy_message 3000 | sed 's/^/      /'
  FAILED=1; SERVER_PID=""
else
./tests/e2e/boot.sh > /tmp/verify_server.log 2>&1 &
SERVER_PID=$!
#  A 200 FROM /health IS NOT ENOUGH. It says a server answered, not that
#  OUR server answered — and a stale one on the same port, pointed at a
#  different database, will answer just as cheerfully and let this whole
#  suite report green about a schema it never touched. boot.sh now refuses
#  an occupied port; this loop's job is to notice that it did, instead of
#  polling happily against the impostor.
UP=0
for _ in $(seq 1 30); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health 2>/dev/null)" = "200" ] && { UP=1; break; }
  sleep 1
done
if [ "$UP" != "1" ]; then
  echo "── server                             FAIL (did not become healthy)"
  tail -25 /tmp/verify_server.log | sed 's/^/      /'
  FAILED=1
else
  echo "── server                             UP  ($(curl -s http://localhost:3000/health | head -c 120))"
  step "authority chain"             node tests/e2e/authority_chain.e2e.js
  step "skyline unit-type mapping"   node tests/e2e/skyline_unit_type_mapping.e2e.js
  step "governed pricing publication" node tests/e2e/skyline_pricing_publication.e2e.js
  step "agent pricing wall"          node tests/e2e/agent_pricing_wall.e2e.js
  step "leasing clean path"          node tests/e2e/leasing_path.e2e.js
  step "hostile falsifications"      node tests/e2e/leasing_hostile.e2e.js
  step "cross-surface reconciliation" node tests/e2e/leasing_reconciliation.e2e.js
  step "standing vs review"          node tests/e2e/leasing_standing_probe.e2e.js
  step "ask spine facts"             node tests/e2e/leasing_ask_spine.e2e.js

  if [ -x "${CHROMIUM:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}" ]; then
    step "browser: staff invite accepts" node tests/e2e/staff_invite_acceptance.browser.js
    step "browser: resident signs"   node tests/e2e/resident_signing.browser.js
  else
    echo "── browser: resident signs            SKIPPED (no Chromium)"
    SKIPPED="browser rung"
  fi
  step "invite-to-guarantor lease"  env E2E_DISPOSABLE_DATABASE=true node tests/e2e/tour_application_lease.e2e.js
  kill "$SERVER_PID" 2>/dev/null
fi
fi

echo "════════════════════════════════════════════════════════════"
[ -n "$SKIPPED" ] && echo "  ⚠ NOT RUN: $SKIPPED — this is not a pass."
if [ "$FAILED" = "0" ]; then echo "  ALL PROOFS PASSED"; else echo "  ✗ VERIFICATION FAILED"; fi
echo "════════════════════════════════════════════════════════════"
exit $FAILED
