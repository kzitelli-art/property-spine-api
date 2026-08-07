#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  RELEASE 0 — FALSIFY THE GATE 4 / 8 / 9 TOOLS
#
#  ⚠ ISOLATED POSTGRES ONLY. Runs against the scale-harness baseline
#    (ledger ceiling 136 + harness sentinel) and REFUSES anything else.
#
#  Every tool is exercised in both directions:
#    · the positive case passes for the RIGHT reason
#    · each negative case FAILS the run — a checker that cannot fail
#      is decoration, and this repo has shipped two of those.
#
#  usage:
#    bash tools/scale/setup_baseline.sh        # once
#    FALSIFY_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
#      bash tools/activation/gate_tools_falsify.sh
# ════════════════════════════════════════════════════════════════════
set -uo pipefail

DB="${FALSIFY_DATABASE_URL:?set FALSIFY_DATABASE_URL to the ISOLATED baseline}"
API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$API_DIR"

#  The same identity-not-location rule as the scale harness: the sentinel
#  row, not the port, is what proves this is not production.
SENTINEL=$(psql "$DB" -tAc "select count(*) from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'" 2>/dev/null | tr -d ' ')
if [ "$SENTINEL" != "1" ]; then
  echo "REFUSED: the harness sentinel is absent. This is not the isolated baseline."
  exit 2
fi

PASS=0; FAIL=0
expect() {  # expect <0|1> <label> <command...>
  local want="$1"; shift
  local label="$1"; shift
  "$@" >/tmp/gate_falsify_last.log 2>&1
  local got=$?
  if { [ "$want" = "0" ] && [ "$got" = "0" ]; } || { [ "$want" != "0" ] && [ "$got" != "0" ]; }; then
    PASS=$((PASS+1)); printf '  ok    %s\n' "$label"
  else
    FAIL=$((FAIL+1)); printf '  FAIL  %s   (exit %s, wanted %s)\n' "$label" "$got" "$want"
    tail -12 /tmp/gate_falsify_last.log | sed 's/^/          /'
  fi
}

TESTER_PHONE='+15415550111'
export DATABASE_URL="$DB" TEST_FROM="$TESTER_PHONE"

echo "SEEDING THE FIXTURE (org, property, tester, WO 1006, obligation, lines)"
psql "$DB" -q -v ON_ERROR_STOP=1 <<'SQL'
delete from work_order_proof_attachments where true;
delete from work_order_progress where true;
delete from events where type='work_order_assigned';
delete from comm_events where channel='sms';
delete from obligations where related_type='work_order';
delete from work_orders where work_order_ref=1006;
delete from communication_lines where true;
delete from property_team_assignments where true;
delete from persons where phone like '%555%';
delete from users where phone like '%555%';

insert into organizations (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a','R0 Falsify Org')
  on conflict (id) do nothing;
insert into properties (id, name, organization_id) values
  ('bbbbbbbb-0000-0000-0000-00000000000b','R0 Falsify Property','aaaaaaaa-0000-0000-0000-00000000000a')
  on conflict (id) do update set organization_id=excluded.organization_id;

insert into users (id, name, phone, role, is_active) values
  ('cccccccc-0000-0000-0000-00000000000c','Tia Tester','+15415550111','maintenance',true),
  ('dddddddd-0000-0000-0000-00000000000d','Oscar Operator','+15415550999','property_manager',true);
insert into property_team_assignments (user_id, property_id, role_title, active)
  values ('cccccccc-0000-0000-0000-00000000000c','bbbbbbbb-0000-0000-0000-00000000000b','Maintenance Tech',true);

insert into work_orders (id, property_id, title, status, work_order_ref, source)
  values ('eeeeeeee-0000-0000-0000-00000000000e','bbbbbbbb-0000-0000-0000-00000000000b',
          'RELEASE 0 CONTROLLED FIXTURE — do not close','open',1006,'release_0_control');

insert into obligations (id, property_id, related_id, related_type, module, type, label, status)
  values ('ffffffff-0000-0000-0000-00000000000f','bbbbbbbb-0000-0000-0000-00000000000b',
          'eeeeeeee-0000-0000-0000-00000000000e','work_order','maintenance','work_order_routing',
          'route WO 1006','open');

insert into communication_lines
  (id, e164, line_type, authority_ceiling, permitted_audience,
   inbound_enabled, outbound_enabled, outbound_policy, status, organization_id)
values
  ('11111111-0000-0000-0000-000000000011','+15415558509','operations','operational','staff',
   true,true,'reply_only','active','aaaaaaaa-0000-0000-0000-00000000000a');
insert into communication_lines
  (id, e164, line_type, authority_ceiling, permitted_audience,
   inbound_enabled, outbound_enabled, outbound_policy, status, property_id)
values
  ('22222222-0000-0000-0000-000000000022','+15415552021','property_facing','external',
   'residents_and_prospects',true,true,'proactive','active','bbbbbbbb-0000-0000-0000-00000000000b');
SQL
echo "  seeded"

# ════ GATE 4 ══════════════════════════════════════════════════════════
echo
echo "GATE 4 — technician_fixture_proof"
expect 0 "G4-1  clean fixture: --pre PASSES" \
  node tools/activation/technician_fixture_proof.js --pre

#  TWO users sharing one phone is STRUCTURALLY IMPOSSIBLE — the partial
#  unique index uq_users_phone_normalized refuses the second insert, which
#  the first draft of this control discovered by silently seeding nothing
#  and then "failing" because the tool correctly passed. The reachable
#  identity failure is a DEACTIVATED tester: the resolver returns 'none'.
UQ=$(psql "$DB" -tAc "select count(*) from pg_indexes where tablename='users' and indexname='uq_users_phone_normalized'" | tr -d ' ')
if [ "$UQ" = "1" ]; then
  PASS=$((PASS+1)); echo "  ok    G4-2a phone ambiguity is refused by the SCHEMA (uq_users_phone_normalized)"
else
  FAIL=$((FAIL+1)); echo "  FAIL  G4-2a uq_users_phone_normalized is missing — ambiguity is now reachable"
fi
psql "$DB" -q -c "update users set is_active=false where id='cccccccc-0000-0000-0000-00000000000c';"
expect 1 "G4-2b tester DEACTIVATED: --pre REFUSES (resolver returns none)" \
  node tools/activation/technician_fixture_proof.js --pre
psql "$DB" -q -c "update users set is_active=true where id='cccccccc-0000-0000-0000-00000000000c';"

psql "$DB" -q -c "insert into persons (id,name,phone) values ('99999999-0000-0000-0000-000000000099','Rita Resident','+15415550111');"
expect 1 "G4-3  a resident shares the phone: --pre REFUSES" \
  node tools/activation/technician_fixture_proof.js --pre
psql "$DB" -q -c "delete from persons where id='99999999-0000-0000-0000-000000000099';"

expect 1 "G4-4  --post before any assignment REFUSES" \
  node tools/activation/technician_fixture_proof.js --post

#  A bare SQL assignment — obligation updated, NO governed event. The
#  read-back must refuse: this is exactly the two-half-actions failure
#  class that produced the surprise live rail.
psql "$DB" -q -c "update obligations set assigned_user_id='cccccccc-0000-0000-0000-00000000000c', ownership_origin='operator_assigned' where id='ffffffff-0000-0000-0000-00000000000f';"
expect 1 "G4-5  SQL-only assignment (no governed event): --post REFUSES" \
  node tools/activation/technician_fixture_proof.js --post

#  Now the governed receipt, exactly as operator_actions.assignWork writes it.
psql "$DB" -q -c "insert into events (property_id, type, note) values ('bbbbbbbb-0000-0000-0000-00000000000b','work_order_assigned',
  '{\"work_order_id\":\"eeeeeeee-0000-0000-0000-00000000000e\",\"obligation_id\":\"ffffffff-0000-0000-0000-00000000000f\",\"assigned_user_id\":\"cccccccc-0000-0000-0000-00000000000c\",\"assigned_by_user_id\":\"dddddddd-0000-0000-0000-00000000000d\",\"idempotency_key\":null}');"
expect 0 "G4-6  governed assignment with receipt event: --post PASSES" \
  node tools/activation/technician_fixture_proof.js --post

# ════ GATE 8 ══════════════════════════════════════════════════════════
echo
echo "GATE 8 — evidence_ingress_proof"
expect 0 "G8-1  --before PASSES on the assigned fixture" \
  node tools/activation/evidence_ingress_proof.js --before
T0=$(grep -oP "T0\s+\K[0-9T:.Z-]+" /tmp/gate_falsify_last.log | head -1)
[ -n "$T0" ] || { echo "  FAIL  could not capture T0"; FAIL=$((FAIL+1)); }

expect 1 "G8-2  --verify with nothing sent REFUSES" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0"

#  The real thing: one bound event, one stored attachment, no completion
#  language. Content is 4 bytes; sha256 matches those bytes.
psql "$DB" -q -v ON_ERROR_STOP=1 <<'SQL'
insert into comm_events (id, channel, direction, body, communication_line_id, actor_user_id, sms_sid, needs_human, occurred_at)
  values ('33333333-0000-0000-0000-000000000033','sms','inbound','wo 1006 valve photo attached',
          '11111111-0000-0000-0000-000000000011','cccccccc-0000-0000-0000-00000000000c','SMfalsify001',true, now());
insert into work_order_proof_attachments
  (id, work_order_id, property_id, uploaded_by_user_id, source_comm_event_id,
   provider, provider_media_id, mime_type, storage_state, byte_size, sha256, content, stored_at)
values
  ('44444444-0000-0000-0000-000000000044','eeeeeeee-0000-0000-0000-00000000000e',
   'bbbbbbbb-0000-0000-0000-00000000000b','cccccccc-0000-0000-0000-00000000000c',
   '33333333-0000-0000-0000-000000000033','twilio','MEfalsify001','image/jpeg','stored',
   4, encode(sha256('\x01020304'::bytea),'hex'), '\x01020304'::bytea, now());
SQL
expect 0 "G8-3  one bound event + one stored attachment: --verify PASSES" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0"
grep -q "sha256" /tmp/gate_falsify_last.log && grep -q "GATE 10 RECEIPT" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    G8-3b receipt fields printed on the clean pass"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  G8-3b receipt fields missing"; }

#  Completion language — same shape, forbidden word. Fresh T0 so only
#  this event is in the window.
T0B=$(psql "$DB" -tAc "select now()" | tr -d ' ')
psql "$DB" -q -v ON_ERROR_STOP=1 <<'SQL'
insert into comm_events (id, channel, direction, body, communication_line_id, actor_user_id, sms_sid, needs_human, occurred_at)
  values ('35555555-0000-0000-0000-000000000035','sms','inbound','wo 1006 all done, photo attached',
          '11111111-0000-0000-0000-000000000011','cccccccc-0000-0000-0000-00000000000c','SMfalsify002',true, now());
insert into work_order_proof_attachments
  (id, work_order_id, property_id, uploaded_by_user_id, source_comm_event_id,
   provider, provider_media_id, mime_type, storage_state, byte_size, sha256, content, stored_at)
values
  ('45555555-0000-0000-0000-000000000045','eeeeeeee-0000-0000-0000-00000000000e',
   'bbbbbbbb-0000-0000-0000-00000000000b','cccccccc-0000-0000-0000-00000000000c',
   '35555555-0000-0000-0000-000000000035','twilio','MEfalsify002','image/jpeg','stored',
   4, encode(sha256('\x01020304'::bytea),'hex'), '\x01020304'::bytea, now());
SQL
expect 1 "G8-4  completion language in the message: --verify REFUSES" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0B"
psql "$DB" -q -c "delete from work_order_proof_attachments where id='45555555-0000-0000-0000-000000000045'; delete from comm_events where id='35555555-0000-0000-0000-000000000035';"

#  storage_state='referenced' — the pre-fix production behaviour. The
#  stored-is-complete constraint forces the durable fields null.
T0C=$(psql "$DB" -tAc "select now()" | tr -d ' ')
psql "$DB" -q -v ON_ERROR_STOP=1 <<'SQL'
insert into comm_events (id, channel, direction, body, communication_line_id, actor_user_id, sms_sid, needs_human, occurred_at)
  values ('36666666-0000-0000-0000-000000000036','sms','inbound','wo 1006 second photo',
          '11111111-0000-0000-0000-000000000011','cccccccc-0000-0000-0000-00000000000c','SMfalsify003',true, now());
insert into work_order_proof_attachments
  (id, work_order_id, property_id, uploaded_by_user_id, source_comm_event_id,
   provider, provider_media_id, mime_type, storage_state)
values
  ('46666666-0000-0000-0000-000000000046','eeeeeeee-0000-0000-0000-00000000000e',
   'bbbbbbbb-0000-0000-0000-00000000000b','cccccccc-0000-0000-0000-00000000000c',
   '36666666-0000-0000-0000-000000000036','twilio','MEfalsify003','image/jpeg','referenced');
SQL
expect 1 "G8-5  attachment referenced-not-stored: --verify REFUSES" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0C"
psql "$DB" -q -c "delete from work_order_proof_attachments where id='46666666-0000-0000-0000-000000000046'; delete from comm_events where id='36666666-0000-0000-0000-000000000036';"

#  A completion row appearing is the one thing the whole build exists to
#  prevent. Replay the CLEAN case, plus one completed progress event.
psql "$DB" -q -c "insert into work_order_progress (id, work_order_id, property_id, kind, reported_by_user_id, occurred_at)
  values ('47777777-0000-0000-0000-000000000047','eeeeeeee-0000-0000-0000-00000000000e','bbbbbbbb-0000-0000-0000-00000000000b','completed','cccccccc-0000-0000-0000-00000000000c', now());"
expect 1 "G8-6  a completed progress event exists: --verify REFUSES (completion safety)" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0"
psql "$DB" -q -c "delete from work_order_progress where id='47777777-0000-0000-0000-000000000047';"

#  Two bound events in one window — ambiguous, not creditable.
psql "$DB" -q -c "insert into comm_events (id, channel, direction, body, communication_line_id, actor_user_id, sms_sid, needs_human, occurred_at)
  values ('38888888-0000-0000-0000-000000000038','sms','inbound','wo 1006 another angle',
          '11111111-0000-0000-0000-000000000011','cccccccc-0000-0000-0000-00000000000c','SMfalsify004',true, now());"
expect 1 "G8-7  TWO bound events after T0: --verify REFUSES (ambiguous run)" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0"
psql "$DB" -q -c "delete from comm_events where id='38888888-0000-0000-0000-000000000038';"

# ════ GATE 9 ══════════════════════════════════════════════════════════
echo
echo "GATE 9 — supersede_operations_line"
export LINE_ID='11111111-0000-0000-0000-000000000011'

expect 1 "G9-1  --execute without CONFIRM_SUPERSEDE REFUSES" \
  node tools/activation/supersede_operations_line.js --execute

expect 0 "G9-2  --dry-run PASSES and rolls back" \
  node tools/activation/supersede_operations_line.js --dry-run
STATE=$(psql "$DB" -tAc "select status from communication_lines where id='$LINE_ID'" | tr -d ' ')
[ "$STATE" = "active" ] \
  && { PASS=$((PASS+1)); echo "  ok    G9-2b line is STILL ACTIVE after the dry run"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  G9-2b dry run leaked a write: status=$STATE"; }

expect 1 "G9-3  wrong target (property-facing line) REFUSES" \
  env LINE_ID='22222222-0000-0000-0000-000000000022' CONFIRM_SUPERSEDE=yes \
  node tools/activation/supersede_operations_line.js --execute
STATE=$(psql "$DB" -tAc "select status from communication_lines where id='22222222-0000-0000-0000-000000000022'" | tr -d ' ')
[ "$STATE" = "active" ] \
  && { PASS=$((PASS+1)); echo "  ok    G9-3b property-facing line untouched by the refusal"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  G9-3b property-facing line CHANGED: $STATE"; }

expect 0 "G9-4  --execute with CONFIRM supersedes and proves it" \
  env CONFIRM_SUPERSEDE=yes node tools/activation/supersede_operations_line.js --execute
read -r ST SA PF <<<"$(psql "$DB" -tAc "select
  (select status from communication_lines where id='$LINE_ID'),
  (select (superseded_at is not null)::text from communication_lines where id='$LINE_ID'),
  (select status from communication_lines where id='22222222-0000-0000-0000-000000000022')" | tr '|' ' ')"
[ "$ST" = "retired" ] && [ "$SA" = "true" ] && [ "$PF" = "active" ] \
  && { PASS=$((PASS+1)); echo "  ok    G9-4b retired+timestamped, property-facing still active"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  G9-4b state: $ST $SA property_facing=$PF"; }

expect 1 "G9-5  a second --execute REFUSES (nothing active to supersede)" \
  env CONFIRM_SUPERSEDE=yes node tools/activation/supersede_operations_line.js --execute

echo
echo "════════════════════════════════════════════════════════════════"
echo "  passed $PASS   failed $FAIL"
[ "$FAIL" = "0" ] && echo "  Every tool passes for the right reason and REFUSES when it should."
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
