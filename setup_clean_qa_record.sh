#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
# CANONICAL clean-QA-record setup for the tenancy-anchor live proof.
# Runs in the RENDER SHELL. Walks a FRESH record through the REAL routes
# — intake → application → classify internal_qa → approve → sign →
# countersign — landing it in 'accepted_term_required', the state
# confirm-term needs. No raw inserts of business state; every step is the
# canonical path. Classification is written directly (it's the QA-enrollment
# fact, not business logic) BEFORE approve/countersign, because the perimeter
# requires internal_qa to let those routes run.
#
# Prints the application id at the end — use it as APP_ID for the proof.
# ════════════════════════════════════════════════════════════════════
set -e

# Production-write guard. These steps write persons, classifications and
# lease_applications through psql "$DATABASE_URL" — production in the Render
# Shell — and never clean up. The guard also sets pipefail, so the curl
# pipelines below can no longer report success on a failed request.
. "$(dirname "$0")/_db_target_guard.sh"
pspine_require_db_target "a QA person, an internal_qa classification and a lease application"

API="${API:-http://localhost:$PORT}"
[ -z "$PORT" ] && API="${API:-https://property-spine-api.onrender.com}"
KEY="$OPERATOR_KEY"
DEMO="a50fbdd0-3642-431e-b532-0dcd6ab8a4fe"
PHONE="+17245550${RANDOM:0:3}"   # fresh throwaway phone → fresh person
NAME="QA Anchor $(date +%H%M%S)"

echo "API=$API  property=$DEMO  name=$NAME"

# grab a real, unoccupied-ish unit on Demo Building for the application
UNIT=$(psql "$DATABASE_URL" -tAc "select id from units where property_id='$DEMO' order by created_at limit 1")
echo "unit=$UNIT"

# 1) INTAKE — canonical lead creation (person born here)
echo; echo "── 1. intake ──"
INTAKE_RESP=$(curl -s -X POST "$API/leasing/intake" -H "Content-Type: application/json" \
  -d "{\"property_id\":\"$DEMO\",\"name\":\"$NAME\",\"phone\":\"$PHONE\",\"source\":\"qa_anchor_proof\"}")
printf '%s\n' "${INTAKE_RESP:0:300}"

# get the person_id we just created
PERSON=$(psql "$DATABASE_URL" -tAc "select id from persons where primary_phone_e164='$PHONE' order by created_at desc limit 1")
echo "person=$PERSON"

# 2) CLASSIFY internal_qa on Demo Building (QA-enrollment fact; must precede
#    approve/countersign so the perimeter lets them through)
echo; echo "── 2. classify internal_qa ──"
psql "$DATABASE_URL" -c "insert into person_property_classifications (person_id,property_id,record_class,classification_source) values ('$PERSON','$DEMO','internal_qa','system')" && echo "classified internal_qa"

# 3) APPLICATION — canonical create
echo; echo "── 3. application ──"
APP_RESP=$(curl -s -X POST "$API/properties/$DEMO/applications" -H "Content-Type: application/json" -H "x-operator-key: $KEY" \
  -d "{\"applicant_name\":\"$NAME\",\"unit_id\":\"$UNIT\",\"rent\":2900,\"deposit\":2900}")
# grep -m1 rather than `| head -1`: head exits early and SIGPIPEs the producer,
# which under pipefail would fail the pipeline. A missing id now fails loudly
# here instead of leaving APP empty and corrupting every later step.
APP=$(printf '%s' "$APP_RESP" | grep -o -m1 '"id":"[0-9a-f-]\{36\}"' | grep -o '[0-9a-f-]\{36\}')
echo "application=$APP"

# 4) APPROVE — spawns activation obligation, status → lease_ready
echo; echo "── 4. approve ──"
APPROVE_RESP=$(curl -s -X POST "$API/applications/$APP/approve" -H "Content-Type: application/json" -H "x-operator-key: $KEY" \
  -d "{\"approved_by\":\"QA Anchor Proof\"}")
printf '%s\n' "${APPROVE_RESP:0:200}"

# 5) SIGN (applicant) — satisfies tenant side, status → tenant_signed
echo; echo "── 5. sign (applicant) ──"
SIGN_RESP=$(curl -s -X POST "$API/applications/$APP/sign" -H "Content-Type: application/json" -H "x-operator-key: $KEY" \
  -d "{\"party\":\"applicant\",\"signature\":\"QA\",\"signed_by\":\"$NAME\"}")
printf '%s\n' "${SIGN_RESP:0:200}"

# 6) COUNTERSIGN — Phase 1 acceptance, status → accepted_term_required
echo; echo "── 6. countersign (Phase 1) ──"
COUNTER_RESP=$(curl -s -X POST "$API/applications/$APP/countersign" -H "Content-Type: application/json" -H "x-operator-key: $KEY" \
  -d "{\"countersigned_by\":\"QA Anchor Proof\"}")
printf '%s\n' "${COUNTER_RESP:0:300}"

# confirm final state
echo; echo "── final state ──"
psql "$DATABASE_URL" -tAc "select 'status='||status from lease_applications where id='$APP'"
echo
echo "════════════════════════════════════════════════"
echo "CLEAN QA RECORD READY.  APP_ID=$APP"
echo "Next: APP_ID=$APP node prove_confirm_term_concurrency.js"
echo "════════════════════════════════════════════════"
