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

#  ── DATABASE-BACKED GATES ───────────────────────────────────────────
#  These two need a real schema and cannot live in
#  tests/verify_source_governance.js, which provisions nothing. They run
#  here, after the migration chain, against the database this script just
#  built — and they refuse any URL that is not localhost.
#
#  Added 2026-08-24 with their two pure siblings. All four had been
#  written, run by hand, reported green, and wired to NOTHING, which put
#  them among the 255 of 292 test files the wave-3 audit found invoked by
#  nothing. A gate nobody runs is not a gate.
step "standing projection cost"  node tests/gate_standing_projection_cost.js
step "property name resolution"  node tests/gate_property_name_resolution.js
step "utility latest statement ordering" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/utility_latest_statement_ordering.db.js
step "utility usage bound equivalence" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/utility_statement_usage_bound_equivalence.db.js
step "debt observation bound equivalence" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/debt_observation_bound_equivalence.db.js
step "tax obligation state bound" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/tax_obligation_state_bound.db.js
step "contracted service term ordering" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/contracted_service_latest_term_ordering.db.js
step "contracted service observation class" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/contracted_service_observation_classification.db.js
step "contracted service setup temporal" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/contracted_service_setup_state_temporal.db.js

#  ── ASK SPINE · THE CONVERSATIONAL READER (§40.2) ───────────────────
#  A domain is not done until Ask Spine can read it, and §40.11 says that
#  is enforced by something that runs, not by memory. These two are the
#  leasing half of it: the matrix pins which sentence reaches which read
#  on BOTH surfaces (dashboard composer and staff SMS router), and the
#  HTTP proof carries one of those sentences over a real socket with a
#  real session into the real canonical read.
#
#  Added 2026-08-25. Both PIN CURRENT BEHAVIOUR and print a DIVERGENCES
#  report of what they found and did not repair. Green here means the
#  contract is pinned — it does not mean the contract is right; read the
#  report.
step "skyline ask spine sms matrix"  node tests/skyline_ask_spine_sms_matrix.test.js
step "skyline ask spine leasing HTTP" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/skyline_ask_spine_leasing_http.db.js

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
    step "browser: resident signs"   node tests/e2e/resident_signing.browser.js
  else
    echo "── browser: resident signs            SKIPPED (no Chromium)"
    SKIPPED="browser rung"
  fi
  kill "$SERVER_PID" 2>/dev/null
fi
fi

echo "════════════════════════════════════════════════════════════"
[ -n "$SKIPPED" ] && echo "  ⚠ NOT RUN: $SKIPPED — this is not a pass."
if [ "$FAILED" = "0" ]; then echo "  ALL PROOFS PASSED"; else echo "  ✗ VERIFICATION FAILED"; fi
echo "════════════════════════════════════════════════════════════"
exit $FAILED
