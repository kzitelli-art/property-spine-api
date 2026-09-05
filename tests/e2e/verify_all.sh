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
#      E2E_DISPOSABLE_POSTGRES=1 E2E_DATABASE_URL=postgres://... ./tests/e2e/verify_all.sh
#  The target must be a separately provisioned disposable loopback instance;
#  the existing CI PostgreSQL service meets this contract. No ambient DB is reset.
#
#  Requires a reachable Postgres. The browser rung additionally needs
#  Chromium; when it is absent the rung is reported SKIPPED — loudly, and
#  named in the summary — never silently passed.
# ════════════════════════════════════════════════════════════════════
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT" || exit 1
export E2E_DATABASE_URL="${E2E_DATABASE_URL:-postgres://postgres:spineproof@127.0.0.1:5432/spine_verify}"
RUN_DIR=$(mktemp -d) || exit 1
export E2E_PROOF_MANIFEST="$RUN_DIR/ownership.json"
export E2E_SMS_LOG="$RUN_DIR/sms.log" E2E_ANTHROPIC_LOG="$RUN_DIR/anthropic.log" E2E_EGRESS_LOG="$RUN_DIR/egress.log"
export E2E_SESSION_LOG="$RUN_DIR/sessions.log"
SERVER_PID=""
stop_owned_server () {
  local result=0
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep .1; done
    if kill -0 "$SERVER_PID" 2>/dev/null; then kill -KILL "$SERVER_PID" 2>/dev/null; result=1; fi
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    node tests/e2e/proof_boundary.js port-free "${PORT:-3000}" || result=1
  fi
  return "$result"
}
cleanup () {
  local result=$?
  trap - EXIT INT TERM
  stop_owned_server || result=1
  if [ -f "$E2E_PROOF_MANIFEST" ]; then
    node tests/e2e/proof_boundary.js cleanup || result=1
  fi
  if [ -s "$E2E_EGRESS_LOG" ]; then echo "FAIL: attempted nonloopback proof egress"; result=1; fi
  node tests/e2e/proof_boundary.js port-free "${PORT:-3000}" || result=1
  if [ "$result" != 0 ]; then echo "Verification incomplete/failed; owned-run evidence: $RUN_DIR"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

FAILED=0; SKIPPED=""
step () {  # $1 = label, rest = command
  local label="$1"; shift
  printf '── %-34s ' "$label"
  if "$@" >"$RUN_DIR/step.log" 2>&1; then echo "PASS"; cat "$RUN_DIR/step.log"; else
    echo "FAIL"; FAILED=1
    sed 's/^/      /' "$RUN_DIR/step.log" | tail -40
    exit 1
  fi
}

echo "════════════════════════════════════════════════════════════"
echo "  PROPERTY SPINE — FULL VERIFICATION"
echo "  database: fresh owned disposable target (credentials omitted)"
echo "════════════════════════════════════════════════════════════"

# ── proofs that need no database ────────────────────────────────────
step "proof boundary refusal checks" node tests/e2e/proof_boundary.test.js
step "source governance gates"   node tests/verify_source_governance.js
step "next-action oracle"        node src/shared/proof_next_action_resolver.js
step "application review actions" node tests/unit/application_review_action_contract.test.js

# ── build the schema from the REAL chain ────────────────────────────
node tests/e2e/proof_boundary.js create >"$RUN_DIR/env.sh" || exit 1
. "$RUN_DIR/env.sh"
step "schema from the migration chain"  ./tests/e2e/apply_migrations.sh
step "property fixture"     psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f tests/e2e/property_fixture.sql
step "pricing fixture"      psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f tests/e2e/fixtures.sql
step "instrument fixture"   node tests/e2e/instrument_fixture.js

# Same new behavioral oracles, unchanged defective server source. Source is
# archived from the pinned git object; only the test preloads come from here.
BASELINE=f95344977b6c7cacacd40f503bed452f501227a0
mkdir "$RUN_DIR/baseline" || exit 1
git archive "$BASELINE" | tar -x -C "$RUN_DIR/baseline" || exit 1
ln -s "$ROOT/node_modules" "$RUN_DIR/baseline/node_modules" || exit 1
E2E_SERVER_ROOT="$RUN_DIR/baseline" E2E_EXPECT_SERVER_COMMIT="$BASELINE" ./tests/e2e/boot.sh >"$RUN_DIR/baseline-server.log" 2>&1 &
SERVER_PID=$!
if ! node tests/e2e/proof_boundary.js wait "$E2E_API_BASE" "$SERVER_PID"; then
  tail -40 "$RUN_DIR/baseline-server.log"
  exit 1
fi
step "parent notice defect observed" env PROOF_EXPECT_DEFECT=1 E2E_EXPECT_SERVER_COMMIT="$BASELINE" node tests/e2e/notice_supersede_space_identity.e2e.js
step "parent deposit defect observed" env PROOF_EXPECT_DEFECT=1 node tests/e2e/deposit_attribution_serialized.e2e.js
step "parent comparison defect observed" env PROOF_EXPECT_DEFECT=1 node tests/e2e/shadow_other_property_entitled.e2e.js
stop_owned_server || exit 1

# ── lease / guarantor database proofs ───────────────────────────────
# These use the repository's production-refusing harness boundary. CI's
# E2E database is disposable and becomes the explicit harness target;
# there is no fallback to DATABASE_URL.
step "governing lease execution" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/governing_lease_execution.db.js
step "canonical lease execution" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/spine_lease_execution.db.js
step "lease guarantor signing"   env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/lease_guarantor_signing.db.js
step "pricing authority grants union" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/pricing_authority_grants_union.db.js
step "canonical Deal Setup HTTP" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/deal_setup_http.db.js

# ── the real server, the real HTTP door ─────────────────────────────
#  ASK BEFORE LAUNCHING. Polling /health afterwards cannot distinguish
#  our server from a stale one — see tests/e2e/port_guard.sh.
. ./tests/e2e/port_guard.sh
if port_busy "$PORT"; then
  echo "── server                             FAIL (proof port already in use)"
  port_busy_message "$PORT" | sed 's/^/      /'
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
node tests/e2e/proof_boundary.js wait "$E2E_API_BASE" "$SERVER_PID" && UP=1
if [ "$UP" != "1" ]; then
  echo "── server                             FAIL (did not become healthy)"
  tail -25 /tmp/verify_server.log | sed 's/^/      /'
  FAILED=1
else
  echo "── server                             UP (owned PID, run nonce, database marker)"
  step "authority chain"             node tests/e2e/authority_chain.e2e.js
  step "extracted route bindings"    node tests/e2e/extracted_route_bindings.e2e.js
  step "ingest property authority"   node tests/e2e/ingest_property_authority.e2e.js
  step "work order person columns"   node tests/e2e/work_order_person_columns.e2e.js
  step "read ai connection authority" node tests/e2e/read_ai_connection_authority.e2e.js
  step "notice space column"         node tests/e2e/notice_space_column.e2e.js
  step "notice correction identity" node tests/e2e/notice_supersede_space_identity.e2e.js
  step "move-in lease on unit"       node tests/e2e/movein_lease_on_unit.e2e.js
  step "org roster scope"            node tests/e2e/org_roster_scope.e2e.js
  step "operator build gate"         node tests/e2e/operator_build_gate.e2e.js
  step "read ai webhook empty body"  node tests/e2e/read_ai_webhook_empty_body.e2e.js
  step "demo intake health gate"     node tests/e2e/demo_intake_health_gate.e2e.js
  step "deposit attribution bound"   node tests/e2e/deposit_attribution_bound.e2e.js
  step "deposit attribution serialized" node tests/e2e/deposit_attribution_serialized.e2e.js
  step "authority grants union"      node tests/e2e/authority_grants_union.e2e.js
  step "pricing term names its months" node tests/e2e/pricing_term_requires_months.e2e.js
  step "shadow comparison removed" node tests/e2e/shadow_other_property_entitled.e2e.js
  step "evidence upload name key"    node tests/e2e/evidence_upload_name_key.e2e.js
  step "outbound text approval instant" node tests/e2e/outbound_text_approval_instant.e2e.js
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
    FAILED=1
  fi
  step "invite-to-guarantor lease"  env E2E_DISPOSABLE_DATABASE=true node tests/e2e/tour_application_lease.e2e.js
  step "legacy decision writes closed" node tests/e2e/legacy_decision_writes_disabled.e2e.js
  stop_owned_server || exit 1
fi
fi

echo "════════════════════════════════════════════════════════════"
[ -n "$SKIPPED" ] && echo "  ⚠ NOT RUN: $SKIPPED — this is not a pass."
if [ "$FAILED" = "0" ]; then echo "  ALL REQUIRED ASSERTIONS PASSED — cleanup must also succeed"; else echo "  ✗ VERIFICATION FAILED"; fi
echo "════════════════════════════════════════════════════════════"
exit $FAILED
