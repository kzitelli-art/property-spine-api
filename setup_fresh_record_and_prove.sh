#!/usr/bin/env bash
# Fresh QA record → accepted_term_required, then the LIVE two-phase concurrency
# proof, all through the real gated routes with a real staff session.
# Run in Render Shell. Requires: STAFF_SESSION (token from establisher), $OPERATOR_KEY.
set -e

# Production-write guard. This script inserts a person, classifies it and
# mutates lease_applications through psql "$DATABASE_URL" — production in the
# Render Shell — and never cleans up. Sourcing also sets pipefail, so the
# curl pipelines below can no longer report success on a failed request.
. "$(dirname "$0")/_db_target_guard.sh"

API="http://localhost:$PORT"
DEMO="a50fbdd0-3642-431e-b532-0dcd6ab8a4fe"
KEY="$OPERATOR_KEY"
SESS="$STAFF_SESSION"
[ -z "$SESS" ] && { echo "Set STAFF_SESSION to the token from establish_qa_staff_session.js"; exit 1; }

# Refuses unless the database target parses, the property is the pinned Demo
# Building, and a per-run acknowledgement names both. The guard checks $DEMO
# against its own pin — editing the line above does not widen this.
pspine_require_db_target PSPINE_WRITE_ACK_FRESH_PROVE "$DEMO" \
  "a QA person, an internal_qa classification and lease_application mutations"

NAME="QA Anchor Live $(date +%H%M%S)"
UNIT=$(psql "$DATABASE_URL" -tAc "select id from units where property_id='$DEMO' order by created_at limit 1")
echo "unit=$UNIT  name=$NAME"

# 1) application (creates the record; person_id may be null → we fix next)
APP_RESP=$(curl -s -X POST "$API/properties/$DEMO/applications" -H "Content-Type: application/json" -H "x-operator-key: $KEY" \
  -d "{\"applicant_name\":\"$NAME\",\"unit_id\":\"$UNIT\",\"rent\":2900,\"deposit\":2900}")
# grep -m1 rather than `| head -1`: head exits early and SIGPIPEs the producer,
# which under pipefail would fail the pipeline. A missing id now fails loudly
# here instead of leaving APP empty and corrupting every later step.
APP=$(printf '%s' "$APP_RESP" | grep -o -m1 '"id":"[0-9a-f-]\{36\}"' | grep -o '[0-9a-f-]\{36\}')
echo "application=$APP"

# 2) ensure the application has a person, and classify that person internal_qa
PH="+1724555$(printf '%04d' $((RANDOM % 10000)))"
psql "$DATABASE_URL" -c "
  with ins as (
    insert into persons (name, phone, primary_phone_e164, lifecycle_status, source)
    values ('$NAME', '$PH', '$PH', 'prospect', 'qa_anchor_live')
    returning id
  )
  update lease_applications set person_id = coalesce(person_id, (select id from ins)) where id='$APP';
"
psql "$DATABASE_URL" -c "
  insert into person_property_classifications (person_id, property_id, record_class, classification_source)
  select person_id, property_id, 'internal_qa', 'system' from lease_applications where id='$APP';
"
echo "classified internal_qa"

# 3) approve (operator-key gated, not perimeter) → lease_ready
curl -s -X POST "$API/applications/$APP/approve" -H "Content-Type: application/json" -H "x-operator-key: $KEY" \
  -d "{\"approved_by\":\"QA Live\"}" >/dev/null && echo "approved"

# 4) sign applicant → tenant_signed
curl -s -X POST "$API/applications/$APP/sign" -H "Content-Type: application/json" -H "x-operator-key: $KEY" \
  -d "{\"party\":\"applicant\",\"signature\":\"QA\",\"signed_by\":\"$NAME\"}" >/dev/null && echo "signed"

# 5) COUNTERSIGN — now through the PERIMETER (operator-key + staff-session both).
#    This is a real gated-route call: proves the perimeter admits the authorized session.
echo "── countersign (perimeter-gated) ──"
COUNTER_RESP=$(curl -s -X POST "$API/applications/$APP/countersign" -H "Content-Type: application/json" \
  -H "x-operator-key: $KEY" -H "x-staff-session: $SESS" \
  -d "{\"countersigned_by\":\"QA Live\"}")
printf '%s\n' "${COUNTER_RESP:0:300}"

# final state should be accepted_term_required
echo "── state ──"
psql "$DATABASE_URL" -tAc "select 'status='||status from lease_applications where id='$APP'"
echo
echo "════════════════════════════════════════════"
echo "APP_ID=$APP  — ready for the concurrency proof:"
echo "  APP_ID=$APP STAFF_SESSION=\$STAFF_SESSION node prove_confirm_term_concurrency.js"
echo "════════════════════════════════════════════"
