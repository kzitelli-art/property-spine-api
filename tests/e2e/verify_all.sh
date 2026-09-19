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
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT" || exit 1
export E2E_DATABASE_URL="${E2E_DATABASE_URL:-postgres://postgres:spineproof@127.0.0.1:5432/spine_verify}"
RUN_DIR=$(mktemp -d "${RUNNER_TEMP:-/tmp}/spine-proof-XXXXXXXX") || exit 1
if [ -n "${GITHUB_ENV:-}" ]; then echo "SPINE_PROOF_LOG_DIR=$RUN_DIR" >> "$GITHUB_ENV"; fi
export E2E_PROOF_MANIFEST="$RUN_DIR/ownership.json"
export E2E_SMS_LOG="$RUN_DIR/sms.log" E2E_ANTHROPIC_LOG="$RUN_DIR/anthropic.log" E2E_EGRESS_LOG="$RUN_DIR/egress.log"
export E2E_SESSION_LOG="$RUN_DIR/sessions.log"
SERVER_PID=""
PARENT_WORKTREE=""
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
  if [ -n "$PARENT_WORKTREE" ] && [ -e "$PARENT_WORKTREE/.git" ]; then
    git worktree remove --force "$PARENT_WORKTREE" || result=1
    PARENT_WORKTREE=""
  fi
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

# ── THE OPERATOR APP PIN ────────────────────────────────────────────
#  tests/e2e/app_pin.txt is the ONE declared statement of which
#  property-spine-app commit these proofs may assume. It is read here and
#  by .github/workflows/verify.yml; nothing else infers an app version.
#
#  THE POINT OF THE COMPARISON: a browser rung that runs against an app
#  commit the API never declared reports green about a surface nobody
#  pinned. That is worse than the SKIPPED line it replaces. So a present
#  checkout whose HEAD differs from the pin is a FAILURE that names both
#  commits, and a checkout whose HEAD cannot be read is a failure too —
#  "I could not tell" is not "it matched".
APP_PIN_FILE="$ROOT/tests/e2e/app_pin.txt"
APP_PIN_SHA=""; APP_PIN_BRANCH=""
if [ -f "$APP_PIN_FILE" ]; then
  APP_PIN_SHA=$(awk '$1=="sha"{print $2; exit}' "$APP_PIN_FILE")
  APP_PIN_BRANCH=$(awk '$1=="branch"{print $2; exit}' "$APP_PIN_FILE")
fi
APP_ROOT="${E2E_APP_ROOT:-$ROOT/../property-spine-app}"
APP_PIN_STATE="no_checkout"; APP_OBSERVED_SHA=""
if [ -f "$APP_ROOT/index.html" ]; then
  APP_OBSERVED_SHA=$(git -C "$APP_ROOT" rev-parse HEAD 2>/dev/null || true)
  if   [ -z "$APP_PIN_SHA" ];                        then APP_PIN_STATE="no_pin_declared"
  elif [ -z "$APP_OBSERVED_SHA" ];                   then APP_PIN_STATE="unreadable"
  elif [ "$APP_OBSERVED_SHA" = "$APP_PIN_SHA" ];     then APP_PIN_STATE="matched"
  else                                                    APP_PIN_STATE="drifted"; fi
fi
APP_PIN_SHORT="${APP_PIN_SHA:0:7}"
export APP_ROOT APP_PIN_SHA APP_PIN_BRANCH APP_PIN_STATE

#  Every rung that needs the shipped app asks THIS, so the three call
#  sites cannot drift apart from each other either.
app_rung_ready () {
  [ -x "${CHROMIUM:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}" ] || return 1
  [ "$APP_PIN_STATE" = "matched" ] || return 1
  return 0
}
app_rung_skip_reason () {
  if [ ! -x "${CHROMIUM:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}" ]; then
    echo "no Chromium"
  elif [ "$APP_PIN_STATE" = "no_checkout" ]; then
    echo "no E2E_APP_ROOT checkout of the pinned app"
  else
    echo "app pin $APP_PIN_STATE"
  fi
}

echo "════════════════════════════════════════════════════════════"
echo "  PROPERTY SPINE — FULL VERIFICATION"
echo "  database: fresh owned disposable target (credentials omitted)"
echo "════════════════════════════════════════════════════════════"

printf '── %-34s ' "operator app pin"
case "$APP_PIN_STATE" in
  matched)
    echo "$APP_PIN_SHORT ($APP_PIN_BRANCH) — checkout agrees" ;;
  no_checkout)
    echo "$APP_PIN_SHORT declared; no checkout on this runner (app rungs will skip by name)" ;;
  drifted)
    echo "FAIL"
    echo "      THE APP CHECKOUT IS NOT THE COMMIT THIS REPOSITORY DECLARED."
    echo "      declared (tests/e2e/app_pin.txt): $APP_PIN_SHA"
    echo "      checked out at $APP_ROOT:         $APP_OBSERVED_SHA"
    echo "      Move the pin deliberately, or check the app out at the pin."
    exit 1 ;;
  unreadable)
    echo "FAIL"
    echo "      An app checkout is present at $APP_ROOT but its HEAD could not be read,"
    echo "      so the declared pin $APP_PIN_SHA could not be confirmed. Not proven is not passed."
    exit 1 ;;
  no_pin_declared)
    echo "FAIL"
    echo "      An app checkout is present at $APP_ROOT but tests/e2e/app_pin.txt declares no sha."
    exit 1 ;;
esac

# ── proofs that need no database ────────────────────────────────────
step "proof boundary refusal checks" node tests/e2e/proof_boundary.test.js
step "source governance gates"   node tests/verify_source_governance.js
step "next-action oracle"        node src/shared/proof_next_action_resolver.js
step "application review actions" node tests/unit/application_review_action_contract.test.js
step "application offer writer and read locks" node tests/unit/application_offer_terms.test.js
step "application review offer projection" node tests/unit/application_review_offer.test.js
step "historical pending offer read locks" node tests/unit/proposed_terms_read_lock.test.js
step "two-step packet eligibility basis" node tests/unit/two_step_packet_eligibility.test.js
step "migration 194-198 release contract" node tests/unit/migration_194_198_predeploy_contract.test.js
step "debt vocabulary subject routing" node tests/unit/debt_vocabulary_subject.test.js
step "compliance ask spine projection" node tests/unit/compliance_ask_spine.test.js
step "ask spine entitlement matrix" node tests/proofs/ask_spine_entitlement_matrix.test.js
step "migration 194-198 reviewed hashes are the git blobs" node tests/unit/migration_194_198_reviewed_hashes.test.js
step "inventory correction door contract" node tests/unit/inventory_correction_contract.test.js
step "leasing agent context resolution" node tests/unit/leasing_context_resolver.test.js
step "shared web/SMS conversational path" node tests/unit/shared_conversational_path.test.js
step "property line identity and inbound doors" node tests/unit/property_line_identity.test.js
#  The operator must be able to RECOVER a lost lead from the app, not from
#  developer tools. Component proof: a real browser drives the real functions
#  lifted out of the app's index.html. No API and no database, so it runs here
#  with the unit steps rather than in the coupled browser rung.
#  app_rung_ready is THE question every app rung asks — it checks Chromium
#  AND the declared pin together, "so the three call sites cannot drift apart
#  from each other either". This step first asked only whether index.html
#  existed, which would have run it against an app nobody pinned and with no
#  browser: a rung that reports green about an undeclared surface is worse
#  than one that skips by name.
if app_rung_ready; then
  step "browser: retained inquiry is recoverable in the app (app $APP_PIN_SHORT)" \
    env CHROMIUM="${CHROMIUM:-}" node "$APP_ROOT/retained_inquiry_dom.test.js"
  #  ── THREE RUNGS NOT REGISTERED HERE, AND EXACTLY WHY ───────────────
  #  The Rent Roll x Person Spine convergence build (CURRENT_STATE
  #  135-138) added three pure-function app rungs:
  #
  #      person_identity_ingress.test.js            40 assertions
  #      forward_semantics_are_the_servers.test.js  34 assertions
  #      forward_occupancy_unresolved.test.js       24 assertions
  #
  #  They were registered here and CI went red twice (runs 693, 694):
  #  MODULE_NOT_FOUND, because a rung registered by the API must exist at
  #  the DECLARED PIN, and the pin is not the app those proofs were
  #  written against.
  #
  #  Measured, with the full app history fetched (a shallow clone makes
  #  `git merge-base` return nothing and invites a much worse conclusion):
  #  both app branches fork from app main c6769ba. The declared pin
  #  2e8199a is 116 commits past main; the convergence app 2bbdb63 is 10
  #  commits past main. Neither contains the other. The pinned index.html
  #  contains none of psCanonicalForward, pcPersonRefusal,
  #  openCanonicalPersonFromRelationship, _rrLeasingCycle or "Not
  #  projectable", so these rungs cannot pass at the pin by construction.
  #
  #  Moving the pin to 2bbdb63 was tried and rejected: it drops ~45 proof
  #  files that exist only on the pin's lineage, starting with the
  #  retained_inquiry_dom rung registered immediately above. Trading 45
  #  rungs for 3 is not a fix.
  #
  #  So the honest state is: the app lines must converge first. A trial
  #  merge of 2bbdb63 onto 2e8199a conflicts in 6 hunks of index.html and
  #  nowhere else, so it is tractable — but it is an app-integration
  #  decision with its own browser re-proof, not a line in this file.
  #
  #  WHAT RE-REGISTERS THEM: one app commit that contains both lineages.
  #  Move the pin to it and restore the three `step` lines below. Until
  #  then these three rungs run in the app repo's own suite
  #  (run_harnesses.sh: 39 harnesses, 1607 assertions, green), which is
  #  where they are green today, and NOT in this one.
  #
  #  step "app: nothing unestablished opens a Person Card" \
  #    node "$APP_ROOT/person_identity_ingress.test.js"
  #  step "app: forward semantics belong to the server" \
  #    node "$APP_ROOT/forward_semantics_are_the_servers.test.js"
  #  step "app: unknown forward is not a percentage" \
  #    node "$APP_ROOT/forward_occupancy_unresolved.test.js"
else
  echo "── browser: retained inquiry          SKIPPED ($(app_rung_skip_reason))"
  SKIPPED="retained inquiry app proof"
  FAILED=1
fi
step "terms preparation attribution" node tests/unit/terms_confirmation_attribution.test.js
step "current packet execution decision attribution" node tests/unit/execution_decision_read.test.js
step "terms attribution model boundary" node tests/unit/terms_attribution_model_boundary.test.js
step "leasing knowledge coverage" node tests/unit/leasing_knowledge_coverage.test.js
step "prospect first response question grounding" node tests/unit/first_response_conversation.test.js
step "leasing grain not established refuses" node tests/unit/leasing_grain_not_established.test.js
step "property operating day is the building's" node tests/unit/property_operating_today.test.js
step "management-read reads the grain, never infers it" node tests/unit/management_read_grain_label.test.js
step "management-read vacancy is a classification, not a remainder" node tests/unit/management_read_vacant_is_not_a_remainder.test.js
step "a resident identifier is never a rent-roll status" node tests/unit/rent_roll_status_not_identity.test.js
step "occupied is not contractually occupied" node tests/unit/rent_roll_occupied_is_not_contractual.test.js
#  Found unregistered while working row 143: DB-free, green, and it guards
#  the §40.8 assertion that an unentitled question never reaches a READ
#  (proved by the reader never being called, not by inspecting the answer).
#  Free to run and it was defending nothing in CI.
step "tenancy is readable by Ask Spine, entitled before it is read" node tests/unit/tenancy_ask_spine.test.js
step "rent roll source adapter"  node tests/unit/rent_roll_source_adapter.test.js
step "rent roll source totals reconcile" node tests/unit/rent_roll_source_totals.test.js
step "institutional rent projection" node tests/unit/rent_roll_institutional_projection.test.js
step "rent roll space identity" node --test tests/unit/rent_roll_space_identity.test.js
step "availability occupancy basis" node --test tests/unit/availability_occupancy_basis.test.js
step "match decision strength" node tests/unit/match_decision_strength.test.js
step "match caller reaches the predicate" node tests/unit/match_caller_reaches_predicate.test.js
step "match ordering rule" node tests/unit/match_ordering.test.js

# ── build the schema from the REAL chain ────────────────────────────
node tests/e2e/proof_boundary.js create >"$RUN_DIR/env.sh" || exit 1
. "$RUN_DIR/env.sh"
step "schema from the migration chain"  ./tests/e2e/apply_migrations.sh
step "governed property display name" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/property_display_name_command.db.js
step "negative contract rent unavailable" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" PROOF_HTTP_PORT=3353 node tests/proofs/negative_contract_rent_unavailable.db.js
step "leasing identity conflict retains the inquiry" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/leasing_identity_conflict_http.db.js
step "conversational consistency across web and SMS" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/conversational_consistency.db.js
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

# Retirement is an owner-authorized contract change after the reviewed repairs.
# Witness the immediate unchanged parent, not a crash in an older dependency.
RETIREMENT_PARENT=1283f40ed058d78ec271e2b05f077cc7fb618502
mkdir "$RUN_DIR/retirement-parent" || exit 1
git archive "$RETIREMENT_PARENT" | tar -x -C "$RUN_DIR/retirement-parent" || exit 1
ln -s "$ROOT/node_modules" "$RUN_DIR/retirement-parent/node_modules" || exit 1
E2E_SERVER_ROOT="$RUN_DIR/retirement-parent" E2E_EXPECT_SERVER_COMMIT="$RETIREMENT_PARENT" ./tests/e2e/boot.sh >"$RUN_DIR/retirement-parent-server.log" 2>&1 &
SERVER_PID=$!
if ! node tests/e2e/proof_boundary.js wait "$E2E_API_BASE" "$SERVER_PID"; then
  tail -40 "$RUN_DIR/retirement-parent-server.log"
  exit 1
fi
step "parent legacy ingestion open" env PROOF_EXPECT_LEGACY_OPEN=1 E2E_EXPECT_SERVER_COMMIT="$RETIREMENT_PARENT" node tests/e2e/legacy_ingestion_retired.e2e.js
stop_owned_server || exit 1

# The onboarding witnesses inspect the real git identity and cleanliness of
# the business source they load. Keep the pinned parent as a detached worktree
# rather than an archive so those checks remain meaningful.
ONBOARDING_PARENT=e09c5411e2c072c3452e48b434a9f8a8250ce1bb
PARENT_WORKTREE="$RUN_DIR/onboarding-parent"
git worktree add --detach "$PARENT_WORKTREE" "$ONBOARDING_PARENT" >"$RUN_DIR/onboarding-parent-worktree.log" 2>&1 || {
  tail -40 "$RUN_DIR/onboarding-parent-worktree.log"
  exit 1
}
ln -s "$ROOT/node_modules" "$PARENT_WORKTREE/node_modules" || exit 1
# The parent onboarding witnesses intentionally run against the exact physical
# 197 claim index. The normal chain is already beyond 198 here, so reconstruct
# that historical index/ledger state for the parent run. Temporarily remove
# every later ledger entry as well, whatever the chain has grown to since —
# the canonical runner refuses a ledger with a gap below its ceiling (198
# missing while a higher version sits at the top). Restore the whole numbered
# suffix through the migration runner immediately afterwards; do not
# hand-author successor DDL.
#
# THE SUCCESSOR SUFFIX IS DERIVED FROM migrations/ ON DISK, NOT HARDCODED.
# This block was hand-extended twice already (198->199 in commit 3b92d652,
# 199->200 in commit de9b199e) and each time the DELETE and the assertions
# kept the OLD ceiling as a literal, so the next migration above the last one
# named here broke the rehearsal again with the exact same "RELEASE REFUSED —
# you expected ceiling 197; the database says <newer>" message. Reading the
# migrations directory for RECONSTRUCT_FILES means a migration landing above
# 200 does not require this block to be hand-edited a third time. 198 itself,
# and 197 as its fixed numeric predecessor, stay literals below: this block
# exists to rehearse migration 198's own reviewed claim-index policy — that
# is the reviewed SUBJECT under test, not an artifact of chain length.
RECONSTRUCT_FILES=$(ls migrations/*.sql | xargs -n1 basename | awk 'substr($0,1,3)+0>=198' | sort)
if [ -z "$RECONSTRUCT_FILES" ]; then
  echo "FATAL: no migration >= 198 found under migrations/ — expected at least 198_proposed_source_claim_identity.sql" >&2
  exit 1
fi
RECONSTRUCT_VERSIONS_SQL=""
RECONSTRUCT_ASSERT_SQL=""
RESTORE_ASSERT_SQL=""
while IFS= read -r f; do
  v=$(printf '%s' "$f" | cut -c1-3)
  stripped=$(printf '%s' "$f" | sed -E 's/^[0-9]{3}_//; s/\.sql$//')
  RECONSTRUCT_VERSIONS_SQL="$RECONSTRUCT_VERSIONS_SQL'$v',"
  RECONSTRUCT_ASSERT_SQL="$RECONSTRUCT_ASSERT_SQL
    if not exists (select 1 from schema_migrations where version='$v' and name in ('$stripped','$f')) then
      raise exception 'expected numbered $v ledger row before parent witness';
    end if;"
  RESTORE_ASSERT_SQL="$RESTORE_ASSERT_SQL
    if not exists (select 1 from schema_migrations where version='$v' and name in ('$stripped','$f')) then
      raise exception 'numbered $v ledger row was not restored';
    end if;"
  NEWEST_MIGRATION_VERSION="$v"
done <<EOF
$RECONSTRUCT_FILES
EOF
RECONSTRUCT_VERSIONS_SQL="${RECONSTRUCT_VERSIONS_SQL%,}"
step "reconstruct exact 197 claim index" psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "
  do \$\$ begin
    if not exists (select 1 from pg_indexes where schemaname='public' and indexname='uq_proposed_natural'
                   and indexdef = 'CREATE UNIQUE INDEX uq_proposed_natural ON public.proposed_records USING btree (activation_id, target_type, natural_key) WHERE ((natural_key IS NOT NULL) AND (import_source_row_id IS NULL))') then
      raise exception 'expected exact 198 natural-key index before parent witness';
    end if;
    $RECONSTRUCT_ASSERT_SQL
  end \$\$;
  delete from schema_migrations where version in ($RECONSTRUCT_VERSIONS_SQL);
  drop index uq_proposed_natural;
  create unique index uq_proposed_natural
    on proposed_records (activation_id, target_type, natural_key)
    where natural_key is not null;
"
step "parent onboarding source defects" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" PROOF_BUSINESS_ROOT="$PARENT_WORKTREE" PROOF_EXPECT_DEFECT=1 node tests/proofs/canonical_onboarding_source.db.js
step "parent onboarding lifecycle defect" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" PROOF_BUSINESS_ROOT="$PARENT_WORKTREE" PROOF_EXPECT_DEFECT=1 node tests/proofs/canonical_onboarding_lifecycle.db.js
step "parent onboarding snapshot defects" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" PROOF_BUSINESS_ROOT="$PARENT_WORKTREE" PROOF_EXPECT_DEFECT=1 node tests/proofs/canonical_onboarding_snapshot.db.js
step "restore numbered 198-$NEWEST_MIGRATION_VERSION ledger" env DATABASE_URL="$E2E_DATABASE_URL" MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=197 node migrations/migrate.js --apply
step "verify restored 198 claim index" psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -c "
  do \$\$ begin
    $RESTORE_ASSERT_SQL
    if (select pg_get_indexdef(i.indexrelid) from pg_index i
       where i.indexrelid=to_regclass('public.uq_proposed_natural')) is distinct from
       'CREATE UNIQUE INDEX uq_proposed_natural ON public.proposed_records USING btree (activation_id, target_type, natural_key) WHERE ((natural_key IS NOT NULL) AND (import_source_row_id IS NULL))' then
      raise exception 'restored 198 index definition is not exact';
    end if;
  end \$\$;
"
git worktree remove --force "$PARENT_WORKTREE" || exit 1
PARENT_WORKTREE=""

# Migration 198 owns the claim-index policy in the numbered chain. Its witness
# reconstructs 197 only inside this nonce database, then drives the real runner
# through lock-failure, apply and repeat branches. No pending schema is applied.
step "numbered source claim-index migration" node tests/proofs/onboarding_claim_index_dependency.db.js

# ── lease / guarantor database proofs ───────────────────────────────
# These use the repository's production-refusing harness boundary. CI's
# E2E database is disposable and becomes the explicit harness target;
# there is no fallback to DATABASE_URL.
step "canonical onboarding source" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/canonical_onboarding_source.db.js
step "canonical onboarding ledger" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/canonical_onboarding_ledger.db.js
step "canonical onboarding lifecycle" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/canonical_onboarding_lifecycle.db.js
step "canonical onboarding snapshot" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/canonical_onboarding_snapshot.db.js
step "governing lease execution" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/governing_lease_execution.db.js
step "canonical lease execution" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/spine_lease_execution.db.js
step "lease guarantor signing"   env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/lease_guarantor_signing.db.js
step "pricing authority grants union" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/pricing_authority_grants_union.db.js
step "opening claim identity"     node tests/proofs/opening_claim_identity.db.js
step "opening claim relay edges"  node tests/proofs/opening_claim_relay_edges.db.js
step "opening claim unattached"   node tests/proofs/opening_claim_unattached.db.js
step "availability readiness axis" node tests/proofs/availability_readiness_axis.db.js
step "a governed move-out is a vacancy fact" node tests/proofs/vacated_position_basis.db.js
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
  step "mixed-grain onboarding writer" node tests/proofs/mixed_grain_writer_challenge.db.js
  step "retained source authority" node tests/proofs/retained_source_authority_observation.db.js
  step "leasing occupancy retirement" node tests/proofs/leasing_occupancy_retirement.db.js
  step "canonical occupancy under holds" node tests/proofs/canonical_occupancy_holds.db.js
  step "Management reconciled zero" node tests/proofs/management_zero_counts.db.js
  step "availability uncorroborated claim" node tests/proofs/availability_uncorroborated_claim.db.js
  step "authority chain"             node tests/e2e/authority_chain.e2e.js
  step "extracted route bindings"    node tests/e2e/extracted_route_bindings.e2e.js
  step "ingest property authority"   node tests/e2e/ingest_property_authority.e2e.js
  step "legacy ingestion retired" env E2E_EXPECT_SERVER_COMMIT="$(git rev-parse HEAD)" node tests/e2e/legacy_ingestion_retired.e2e.js
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
  step "inventory date boundaries"   node tests/unit/prospect_inventory_dates.test.js
  step "explicit prospect unit confirmation" node tests/unit/prospect_confirmation.test.js
  step "prospect confirmation agent persistence" node tests/proofs/prospect_confirmation.db.js
  step "possession effective dates"   node tests/unit/possession_as_of.test.js
  step "agent inventory dates"       node tests/proofs/prospect_inventory_dates.db.js
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
  step "turnover sibling occupancy" node tests/proofs/turnover_sibling_cache.db.js
  step "required work standing" node tests/unit/required_work_standing.test.js
  step "required work target" node tests/proofs/triage_work_scope.db.js
  step "turn expected date stays on its exact home" node tests/proofs/availability_turn_date_scope.db.js
  step "when a turn slips, leasing sees it" node tests/proofs/turn_slip_visible_to_leasing.db.js
  step "one readiness truth feeds every gate" node tests/proofs/readiness_one_truth.db.js
  step "legacy decision writes closed" node tests/e2e/legacy_decision_writes_disabled.e2e.js
  step "greenery staff onboarding" node tests/proofs/greenery_staff_onboarding.db.js
  step "source-to-home identity review and Greenery inventory contract" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/source_home_identity_review.db.js
  step "current rent-roll reconciliation into an onboarded property" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/current_rent_roll_reconciliation.db.js
  step "application-to-lease handoff is owed durably and safe to retry" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/lease_handoff_durable.db.js
  #  The other two proofs of the same slice. Both were written with the
  #  handoff and both passed locally for days while CI never ran them —
  #  evidence that exists but is not ENFORCED protects nothing from the next
  #  change. Both need the owned server: they sign through the real public
  #  signer routes rather than stamping the signature fact themselves.
  step "a signed-for home is held, and released when it should be" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" E2E_API_BASE="$E2E_API_BASE" node tests/proofs/application_inventory_hold.db.js
  step "application to lease, end to end, with rejection and failed delivery" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" E2E_API_BASE="$E2E_API_BASE" node tests/proofs/application_to_lease_journey.db.js
  #  Matching is retrieval on a declared basis (MATCHING_BASIS_RULING_20260914,
  #  MB-1..MB-9). It establishes its OWN governed inventory and its own
  #  published pricing, so it does not depend on the Skyline fixture or on
  #  anything an earlier step left behind — an earlier version did, and went
  #  red in CI the moment the rent-roll proof above consumed Skyline's one
  #  eligible target. It runs here because it needs the owned server for its
  #  staff door and its Ask Spine composer call.
  step "prospect match basis" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/proofs/prospect_match_basis.db.js
  #  ── THE SAME RECONCILIATION, THROUGH THE SHIPPED OPERATOR UI ──────
  #  The step above proves the API. This one proves the screen a person
  #  actually touches, against the SAME owned server — and it had only
  #  ever been run by hand, which is why both of this week's first reds
  #  (the "Choose a property" layer above Deal Setup) were of a class CI
  #  could not see.
  #
  #  The app's proof is NOT edited and NOT copied here. It is loaded
  #  through the app's own transport runner with `node --require`, on the
  #  env contract that runner documents: SP (playwright), APP_ROOT, API,
  #  TLS_PORT, SHOTS — plus API_ROOT and CHROME, which the app proof
  #  itself reads. SP and API_ROOT are both this checkout: the app proof
  #  borrows this repository's playwright and pg.
  #
  #  TLS_PORT is derived from the nonce-allocated proof port so two runs
  #  on one machine cannot collide on 8443.
  if app_rung_ready; then
    COUPLED_SHOTS="$RUN_DIR/coupled-rent-roll"
    mkdir -p "$COUPLED_SHOTS"
    step "browser: coupled rent-roll (app $APP_PIN_SHORT)" \
      env SP="$ROOT" API_ROOT="$ROOT" APP_ROOT="$APP_ROOT" \
          API="$E2E_API_BASE" TLS_PORT="${E2E_COUPLED_TLS_PORT:-$((PORT + 5000))}" \
          CHROME="${CHROMIUM:-}" SHOTS="$COUPLED_SHOTS" \
          E2E_DATABASE_URL="$E2E_DATABASE_URL" \
      node --require "$APP_ROOT/tools/coupled_browser_runner.cjs" \
           "$APP_ROOT/current_rent_roll_reconciliation.browser.js"
    step "coupled transport receipt (app $APP_PIN_SHORT)" node tests/e2e/coupled_runner_receipt.js "$COUPLED_SHOTS"
  else
    echo "── browser: coupled rent-roll         SKIPPED ($(app_rung_skip_reason))"
    SKIPPED="coupled app browser rung"
    FAILED=1
  fi
  stop_owned_server || exit 1
fi
fi

if [ "$FAILED" = "0" ]; then
  E2E_WITHOUT_OPERATOR_KEY=1 ./tests/e2e/boot.sh >"$RUN_DIR/unconfigured-key-server.log" 2>&1 &
  SERVER_PID=$!
  node tests/e2e/proof_boundary.js wait "$E2E_API_BASE" "$SERVER_PID" || exit 1
  step "legacy ingestion key unconfigured" env E2E_WITHOUT_OPERATOR_KEY=1 E2E_EXPECT_SERVER_COMMIT="$(git rev-parse HEAD)" node tests/e2e/legacy_ingestion_retired.e2e.js
  stop_owned_server || exit 1
fi

# Separate server configuration: do not prospect-activate the shared fixture
# while the earlier historical/internal-QA proofs are running.
if [ "$FAILED" = "0" ]; then
  step "real intake inactive property fixture" psql "$E2E_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f tests/e2e/real_intake_fixture.sql
  E2E_INTAKE_INACTIVE_PROPERTY_ID=$(psql "$E2E_DATABASE_URL" -tAX -v ON_ERROR_STOP=1 -c "select id from properties where name='Real Intake Inactive E2E'") || exit 1
  export E2E_INTAKE_INACTIVE_PROPERTY_ID
  REAL_INTAKE_ACTIVE_ID=$(psql "$E2E_DATABASE_URL" -tAX -v ON_ERROR_STOP=1 -c "select id from properties where name='Skyline E2E'") || exit 1
  [ -n "$E2E_INTAKE_INACTIVE_PROPERTY_ID" ] && [ -n "$REAL_INTAKE_ACTIVE_ID" ] || exit 1
  E2E_PROSPECT_ACTIVATION_PROPERTY_IDS="$REAL_INTAKE_ACTIVE_ID" ./tests/e2e/boot.sh >"$RUN_DIR/real-intake-server.log" 2>&1 &
  SERVER_PID=$!
  node tests/e2e/proof_boundary.js wait "$E2E_API_BASE" "$SERVER_PID" || exit 1
  step "real inquiry classification without consent" node tests/proofs/real_intake_classification.db.js
  step "authenticated intake delivery replay" node tests/proofs/intake_delivery_idempotency.db.js
  step "website inquiry visibility" node tests/proofs/website_inquiry_visibility.db.js
  step "website inquiry state and authority" node tests/proofs/website_inquiry_state.db.js
  step "website capture-only intake" node tests/proofs/website_capture_only.db.js
  step "attributed external email reply" node tests/proofs/external_email_reply.db.js
  step "staff inquiry ownership and response" node tests/proofs/conversation_takeover_owner.db.js
  step "staff inquiry native tour booking" node tests/proofs/staff_conversation_tour.db.js
  step "unsent application draft correction" node tests/e2e/draft_offer_correction.e2e.js
  step "canonical application draft recovery" node tests/proofs/application_draft_recovery.db.js
  step "manual email application preparation" node tests/proofs/manual_email_application.db.js
  step "staff-assisted journey (Skyline shape)" env JOURNEY_SHAPE=skyline node tests/e2e/staff_assisted_journey.e2e.js
  step "historical application projections" node tests/proofs/proposed_terms_read_lock.db.js
  step "no-consent two-person journey" node tests/e2e/no_consent_two_person_journey.e2e.js
  step "two-step leasing: author and execute" node tests/e2e/two_step_leasing.e2e.js
  step "governed inventory correction" node tests/e2e/inventory_correction.e2e.js
  step "inventory relationship policy coverage" env HARNESS_DATABASE_URL="$E2E_DATABASE_URL" node tests/gates/gate_inventory_relationship_policy.db.js
  step "inventory correction hardening" node tests/e2e/inventory_correction_hardening.e2e.js
  if app_rung_ready; then
    step "browser: inventory correction (app $APP_PIN_SHORT)" node tests/e2e/inventory_correction.browser.js
  else
    echo "── browser: inventory correction      SKIPPED ($(app_rung_skip_reason))"
    SKIPPED="app browser rungs"
    FAILED=1
  fi
  step "two-step preparation and execution attribution" node tests/proofs/two_step_attribution_read.db.js
  #  The operator app is a separate repository. CI now checks it out at the
  #  commit tests/e2e/app_pin.txt declares, so this rung RUNS in CI instead
  #  of printing SKIPPED in every run. Where no checkout exists (a laptop
  #  without one) it still skips by name — and the label carries the app
  #  commit, so a log line can never be read as covering an app version it
  #  did not run against.
  if app_rung_ready; then
    step "browser: two-step execute (app $APP_PIN_SHORT)"  node tests/e2e/two_step_execute.browser.js
  else
    echo "── browser: two-step execute          SKIPPED ($(app_rung_skip_reason))"
    SKIPPED="app browser rungs"
    FAILED=1
  fi
  stop_owned_server || exit 1
  unset E2E_INTAKE_INACTIVE_PROPERTY_ID
fi

# Greenery deliberately has no eligible home. Use its own synthetic property
# ID and server allowlists; never copy Skyline inventory/configuration into it.
# The preceding server is stopped before boot, and the same nonce-owned run
# boundary and EXIT cleanup cover this separate phase.
if [ "$FAILED" = "0" ]; then
  GREENERY_JOURNEY_ID=$(node -e 'console.log(require("node:crypto").randomUUID())') || exit 1
  [ -n "$GREENERY_JOURNEY_ID" ] || exit 1
  E2E_INTAKE_INACTIVE_PROPERTY_ID="$GREENERY_JOURNEY_ID" E2E_PROSPECT_ACTIVATION_PROPERTY_IDS="$GREENERY_JOURNEY_ID" ./tests/e2e/boot.sh >"$RUN_DIR/greenery-journey-server.log" 2>&1 &
  SERVER_PID=$!
  node tests/e2e/proof_boundary.js wait "$E2E_API_BASE" "$SERVER_PID" || exit 1
  step "staff-assisted journey (empty Greenery shape)" env JOURNEY_SHAPE=greenery PROOF_GREENERY_ID="$GREENERY_JOURNEY_ID" PROOF_EVIDENCE_LABEL="greenery-$GREENERY_JOURNEY_ID" node tests/e2e/staff_assisted_journey.e2e.js
  stop_owned_server || exit 1
fi

echo "════════════════════════════════════════════════════════════"
echo "  operator app: $APP_PIN_STATE at ${APP_PIN_SHA:-<none declared>}"
[ -n "$SKIPPED" ] && echo "  ⚠ NOT RUN: $SKIPPED — this is not a pass."
if [ "$FAILED" = "0" ]; then echo "  ALL REQUIRED ASSERTIONS PASSED — cleanup must also succeed"; else echo "  ✗ VERIFICATION FAILED"; fi
echo "════════════════════════════════════════════════════════════"
exit $FAILED
