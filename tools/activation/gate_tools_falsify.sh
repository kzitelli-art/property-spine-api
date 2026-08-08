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

#  ── REACHABILITY, NOT MERE EXISTENCE ────────────────────────────────
#  T3 originally failed on ANY same-phone persons row, and that failed
#  the real production fixture on a dormant boardroom_demo record the
#  inbound resolvers could never reach. The corrected check asks whether
#  a COMPETING OPERATING IDENTITY exists. These three controls pin both
#  ends of that distinction, so the check can never silently drift back
#  to either extreme.

#  G4-3a  DORMANT — a same-phone person with no lease, no invite, no
#  lead. Exactly the production boardroom_demo shape. Must PASS.
psql "$DB" -q -c "insert into persons (id,name,phone,source) values ('99999999-0000-0000-0000-000000000099','Rita Dormant','+15415550111','boardroom_demo');"
expect 0 "G4-3a dormant same-phone person (no reachable path): --pre PASSES" \
  node tools/activation/technician_fixture_proof.js --pre
grep -q "DORMANT same-phone person" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    G4-3b and it is REPORTED as a hygiene item, not hidden"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  G4-3b dormant record passed silently — it must still be surfaced"; }

#  G4-3c  REACHABLE VIA PROSPECT — the same row, now carrying an open
#  leasing lead. Production would resolve an inbound to it. Must REFUSE.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "insert into leasing_leads (id,person_id,property_id,status,received_at,import_mode)
  values ('9a000000-0000-0000-0000-00000000009a','99999999-0000-0000-0000-000000000099','bbbbbbbb-0000-0000-0000-00000000000b','new',now(),'live');"
expect 1 "G4-3c same person made reachable via OPEN LEAD: --pre REFUSES" \
  node tools/activation/technician_fixture_proof.js --pre
#  ...and a TERMINAL lead is not reachable — 'lost' must not block.
psql "$DB" -q -c "update leasing_leads set status='lost' where id='9a000000-0000-0000-0000-00000000009a';"
expect 0 "G4-3d the same lead CLOSED ('lost'): --pre PASSES again" \
  node tools/activation/technician_fixture_proof.js --pre
psql "$DB" -q -c "delete from leasing_leads where id='9a000000-0000-0000-0000-00000000009a';"

#  G4-3e  REACHABLE VIA RESIDENT — active lease naming the person, plus a
#  USED tenant invite. Both halves are required by production, so both
#  are seeded and the half-configured case is proven not to block.
#
#  ⚠ NO `|| fallback` HERE, AND THE SEED IS ASSERTED. The first version
#  chained `psql ... 2>/dev/null || psql ...`; spaces requires a unit_id
#  and units was empty, so BOTH arms inserted nothing and the chain
#  reported success. G4-3e then "passed" describing a lease that did not
#  exist, and only G4-3f's failure revealed it. A seed that silently does
#  nothing turns every control built on it into decoration.
psql "$DB" -q -v ON_ERROR_STOP=1 <<'SQL3'
insert into units (id, property_id, unit_number)
  values ('9e000000-0000-0000-0000-00000000009e','bbbbbbbb-0000-0000-0000-00000000000b','F1');
insert into spaces (id, unit_id)
  values ('9b000000-0000-0000-0000-00000000009b','9e000000-0000-0000-0000-00000000009e');
insert into leases (id, property_id, space_id, tenant_ids, balance, lease_status)
  values ('9c000000-0000-0000-0000-00000000009c','bbbbbbbb-0000-0000-0000-00000000000b',
          '9b000000-0000-0000-0000-00000000009b',
          array['99999999-0000-0000-0000-000000000099']::uuid[], 0, 'active');
SQL3
SEEDED=$(psql "$DB" -tAc "select count(*) from leases where id='9c000000-0000-0000-0000-00000000009c' and lease_status='active' and '99999999-0000-0000-0000-000000000099' = any(tenant_ids)" | tr -d ' ')
if [ "$SEEDED" = "1" ]; then PASS=$((PASS+1)); echo "  ok    G4-3e0 the active lease really exists (the next control is not vacuous)";
else FAIL=$((FAIL+1)); echo "  FAIL  G4-3e0 lease seed did not land — G4-3e/f would prove nothing"; fi
expect 0 "G4-3e active lease but NO used invite: --pre still PASSES (production needs both)" \
  node tools/activation/technician_fixture_proof.js --pre
psql "$DB" -q -v ON_ERROR_STOP=1 -c "insert into tenant_invites (id,person_id,property_id,token,status,expires_at)
  values ('9d000000-0000-0000-0000-00000000009d','99999999-0000-0000-0000-000000000099','bbbbbbbb-0000-0000-0000-00000000000b','tok-falsify','used', now() + interval '30 days');"
expect 1 "G4-3f lease + USED invite → reachable RESIDENT: --pre REFUSES" \
  node tools/activation/technician_fixture_proof.js --pre
psql "$DB" -q -c "delete from tenant_invites where id='9d000000-0000-0000-0000-00000000009d';
                  delete from leases where id='9c000000-0000-0000-0000-00000000009c';
                  delete from spaces where id='9b000000-0000-0000-0000-00000000009b';
                  delete from units where id='9e000000-0000-0000-0000-00000000009e';
                  delete from persons where id='99999999-0000-0000-0000-000000000099';"

# ════ TESTER SEARCH ═══════════════════════════════════════════════════
#  The route AROUND an identity collision, rather than through production
#  data. Every control here pins the difference between "eligible" and
#  "collision-free", and between "usable" and "already the assignee".
echo
echo "TESTER SEARCH — find_collision_free_tester"

#  Tia is eligible and clean; Oscar is eligible but has no team assignment
#  at the property, so the picker never offers him. One clean candidate.
expect 0 "TS-1  a clean eligible technician is FOUND" \
  node tools/activation/find_collision_free_tester.js
grep -q "CANDIDATE FOUND" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    TS-1b and it says so explicitly"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  TS-1b no CANDIDATE FOUND banner"; }

#  A DORMANT same-phone person must NOT disqualify — that is the whole
#  H-1 correction, restated here so the two tools cannot drift apart.
psql "$DB" -q -c "insert into persons (id,name,phone,source) values ('99999999-0000-0000-0000-000000000099','Rita Dormant','+15415550111','boardroom_demo');"
expect 0 "TS-2  a DORMANT same-phone person does not disqualify" \
  node tools/activation/find_collision_free_tester.js
grep -q "dormant same-phone person record" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    TS-2b and the dormant record is reported anyway"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  TS-2b dormant record not surfaced"; }

#  Give that person an OPEN lead and the candidate is no longer clean.
#  With no other eligible technician, the tool must BLOCK — not fall back
#  to "closest available", which is how a proof quietly runs on the wrong
#  identity.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "insert into leasing_leads (id,person_id,property_id,status,received_at,import_mode)
  values ('9a000000-0000-0000-0000-00000000009a','99999999-0000-0000-0000-000000000099','bbbbbbbb-0000-0000-0000-00000000000b','tour_scheduled',now(),'live');"
expect 1 "TS-3  the ONLY candidate becomes reachable → BLOCKED, no fallback" \
  node tools/activation/find_collision_free_tester.js
grep -q "RELEASE 0 TESTER IDENTITY BLOCKED" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    TS-3b returns the exact BLOCKED verdict"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  TS-3b wrong or missing blocked verdict"; }

#  A SECOND eligible technician on a clean phone rescues it — proving the
#  block was about the collision and not about the search being broken.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "insert into users (id,name,phone,role,is_active) values ('cccccccc-0000-0000-0000-0000000000c3','Nina Clean','+15415550222','maintenance',true);
  insert into property_team_assignments (user_id,property_id,role_title,active) values ('cccccccc-0000-0000-0000-0000000000c3','bbbbbbbb-0000-0000-0000-00000000000b','Maintenance Tech',true);"
expect 0 "TS-4  a second CLEAN eligible technician is found instead" \
  node tools/activation/find_collision_free_tester.js
grep -q "Nina Clean" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    TS-4b and it is the clean one that is offered"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  TS-4b clean candidate not offered"; }

#  A technician with NO phone cannot receive an attributed inbound.
psql "$DB" -q -c "update users set phone=null where id='cccccccc-0000-0000-0000-0000000000c3';"
expect 1 "TS-5  a phoneless technician is not a tester → BLOCKED again" \
  node tools/activation/find_collision_free_tester.js
psql "$DB" -q -c "update users set phone='+15415550222' where id='cccccccc-0000-0000-0000-0000000000c3';"

#  ALREADY-ASSIGNED is not usable: assignWork short-circuits on an
#  unchanged assignee and writes no event, so it cannot produce a freshly
#  attributed receipt.
psql "$DB" -q -c "delete from leasing_leads where id='9a000000-0000-0000-0000-00000000009a';
                  delete from property_team_assignments where user_id='cccccccc-0000-0000-0000-0000000000c3';
                  delete from users where id='cccccccc-0000-0000-0000-0000000000c3';
                  update obligations set assigned_user_id='cccccccc-0000-0000-0000-00000000000c' where id='ffffffff-0000-0000-0000-00000000000f';"
expect 1 "TS-6  the only clean candidate is ALREADY the assignee → BLOCKED" \
  node tools/activation/find_collision_free_tester.js
grep -qi "already the assignee" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    TS-6b and it names the unchanged-assignee reason"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  TS-6b did not explain the no-event short-circuit"; }

#  Restore the fixture for the gates that follow.
psql "$DB" -q -c "update obligations set assigned_user_id=null, ownership_origin=null where id='ffffffff-0000-0000-0000-00000000000f';
                  delete from persons where id='99999999-0000-0000-0000-000000000099';"
RESTORED=$(psql "$DB" -tAc "select count(*) from obligations where id='ffffffff-0000-0000-0000-00000000000f' and assigned_user_id is null" | tr -d ' ')
if [ "$RESTORED" = "1" ]; then PASS=$((PASS+1)); echo "  ok    TS-7  fixture restored UNASSIGNED for the gates that follow";
else FAIL=$((FAIL+1)); echo "  FAIL  TS-7  fixture NOT restored — later gates would prove nothing"; fi


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

# ── THE BINDING, ONE AXIS AT A TIME ──────────────────────────────────
#  Each case inserts an event that differs from the bound shape in exactly
#  ONE field. The verify must see ZERO matches and refuse — if any of
#  these were creditable, Gate 8 could pass on the wrong message.
for CASE in wrong_tester wrong_line outbound missing_sid; do
  TX=$(psql "$DB" -tAc "select now()" | tr -d ' ')
  ACTOR="'cccccccc-0000-0000-0000-00000000000c'"
  LINE="'11111111-0000-0000-0000-000000000011'"
  DIR="'inbound'"; SID="'SMaxis'"
  case $CASE in
    wrong_tester) ACTOR="'dddddddd-0000-0000-0000-00000000000d'";;
    wrong_line)   LINE="'22222222-0000-0000-0000-000000000022'";;
    outbound)     DIR="'outbound'";;
    missing_sid)  SID="null";;
  esac
  psql "$DB" -q -v ON_ERROR_STOP=1 -c "insert into comm_events (channel, direction, body, communication_line_id, actor_user_id, sms_sid, needs_human, occurred_at)
    values ('sms',$DIR,'wo 1006 axis case',$LINE,$ACTOR,$SID,true, now());"
  expect 1 "G8-8  one-axis mismatch ($CASE): --verify REFUSES" \
    node tools/activation/evidence_ingress_proof.js --verify --t0 "$TX"
  psql "$DB" -q -c "delete from comm_events where body='wo 1006 axis case';"
done

#  Attachment bound to the RIGHT event but the WRONG work order.
TX=$(psql "$DB" -tAc "select now()" | tr -d ' ')
psql "$DB" -q -v ON_ERROR_STOP=1 <<'SQL2'
insert into work_orders (id, property_id, title, status, work_order_ref, source)
  values ('e2000000-0000-0000-0000-0000000000e2','bbbbbbbb-0000-0000-0000-00000000000b',
          'decoy work order','open',1007,'release_0_control');
insert into comm_events (id, channel, direction, body, communication_line_id, actor_user_id, sms_sid, needs_human, occurred_at)
  values ('4b000000-0000-0000-0000-0000000000b4','sms','inbound','wo 1006 photo',
          '11111111-0000-0000-0000-000000000011','cccccccc-0000-0000-0000-00000000000c','SMax5',true, now());
insert into work_order_proof_attachments
  (id, work_order_id, property_id, uploaded_by_user_id, source_comm_event_id,
   provider, provider_media_id, mime_type, storage_state, byte_size, sha256, content, stored_at)
values
  ('4c000000-0000-0000-0000-0000000000c4','e2000000-0000-0000-0000-0000000000e2',
   'bbbbbbbb-0000-0000-0000-00000000000b','cccccccc-0000-0000-0000-00000000000c',
   '4b000000-0000-0000-0000-0000000000b4','twilio','MEax5','image/jpeg','stored',
   4, encode(sha256('\x01020304'::bytea),'hex'), '\x01020304'::bytea, now());
SQL2
expect 1 "G8-9  attachment landed on ANOTHER work order: --verify REFUSES" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$TX"
psql "$DB" -q -c "delete from work_order_proof_attachments where id='4c000000-0000-0000-0000-0000000000c4';
                  delete from comm_events where id='4b000000-0000-0000-0000-0000000000b4';
                  delete from work_orders where id='e2000000-0000-0000-0000-0000000000e2';"

# ── CORRUPT STORED ROWS, WITH THE CONSTRAINTS REMOVED ────────────────
#  ck_wopa_stored_is_complete and the MIME check would normally refuse
#  these rows at insert. The TOOL must refuse them independently — a
#  proof that leans on a constraint is blind the day a migration relaxes
#  it. Constraints are dropped in THIS ISOLATED DATABASE ONLY, the
#  corrupt shapes are proven refused by the tool, and the constraints are
#  re-added from their saved definitions before anything else runs.
DEF_STORED=$(psql "$DB" -tAc "select pg_get_constraintdef(oid) from pg_constraint where conname='ck_wopa_stored_is_complete'")
DEF_MIME=$(psql "$DB" -tAc "select pg_get_constraintdef(oid) from pg_constraint where conname='work_order_proof_attachments_mime_type_check'")
DEF_SIZE=$(psql "$DB" -tAc "select pg_get_constraintdef(oid) from pg_constraint where conname='ck_wopa_size_matches_content'")
psql "$DB" -q -v ON_ERROR_STOP=1 -c "alter table work_order_proof_attachments drop constraint ck_wopa_stored_is_complete;
                  alter table work_order_proof_attachments drop constraint work_order_proof_attachments_mime_type_check;
                  alter table work_order_proof_attachments drop constraint ck_wopa_size_matches_content;"

for CORRUPT in no_sha no_content no_size no_stored_at bad_mime; do
  TX=$(psql "$DB" -tAc "select now()" | tr -d ' ')
  SHA="encode(sha256('\x01020304'::bytea),'hex')"; CONTENT="'\x01020304'::bytea"; SIZE=4; STORED="now()"; MIME="'image/jpeg'"
  case $CORRUPT in
    no_sha)       SHA=null;;
    no_content)   CONTENT=null;;
    no_size)      SIZE=null;;
    no_stored_at) STORED=null;;
    bad_mime)     MIME="'application/pdf'";;
  esac
  psql "$DB" -q -v ON_ERROR_STOP=1 -c "
    insert into comm_events (id, channel, direction, body, communication_line_id, actor_user_id, sms_sid, needs_human, occurred_at)
      values ('4d000000-0000-0000-0000-0000000000d4','sms','inbound','wo 1006 corrupt case',
              '11111111-0000-0000-0000-000000000011','cccccccc-0000-0000-0000-00000000000c','SMax6',true, now());
    insert into work_order_proof_attachments
      (id, work_order_id, property_id, uploaded_by_user_id, source_comm_event_id,
       provider, provider_media_id, mime_type, storage_state, byte_size, sha256, content, stored_at)
    values
      ('4e000000-0000-0000-0000-0000000000e4','eeeeeeee-0000-0000-0000-00000000000e',
       'bbbbbbbb-0000-0000-0000-00000000000b','cccccccc-0000-0000-0000-00000000000c',
       '4d000000-0000-0000-0000-0000000000d4','twilio','MEax6',$MIME,'stored',$SIZE,$SHA,$CONTENT,$STORED);"
  expect 1 "G8-10 corrupt stored row ($CORRUPT): the TOOL refuses without the constraint" \
    node tools/activation/evidence_ingress_proof.js --verify --t0 "$TX"
  psql "$DB" -q -c "delete from work_order_proof_attachments where id='4e000000-0000-0000-0000-0000000000e4';
                    delete from comm_events where id='4d000000-0000-0000-0000-0000000000d4';"
done

psql "$DB" -q -v ON_ERROR_STOP=1 -c "alter table work_order_proof_attachments add constraint ck_wopa_stored_is_complete $DEF_STORED;
                  alter table work_order_proof_attachments add constraint work_order_proof_attachments_mime_type_check $DEF_MIME;
                  alter table work_order_proof_attachments add constraint ck_wopa_size_matches_content $DEF_SIZE;"
RESTORED=$(psql "$DB" -tAc "select count(*) from pg_constraint where conname in ('ck_wopa_stored_is_complete','work_order_proof_attachments_mime_type_check','ck_wopa_size_matches_content')" | tr -d ' ')
if [ "$RESTORED" = "3" ]; then PASS=$((PASS+1)); echo "  ok    G8-10b all three constraints restored from saved definitions";
else FAIL=$((FAIL+1)); echo "  FAIL  G8-10b constraints NOT restored ($RESTORED of 3)"; fi

#  A completion CLAIM (not just a completed event) must also refuse.
psql "$DB" -q -c "insert into work_order_progress (id, work_order_id, property_id, kind, reported_by_user_id, occurred_at)
  values ('4f000000-0000-0000-0000-0000000000f4','eeeeeeee-0000-0000-0000-00000000000e','bbbbbbbb-0000-0000-0000-00000000000b','completion_claimed','cccccccc-0000-0000-0000-00000000000c', now());"
expect 1 "G8-11 a completion CLAIM exists: --verify REFUSES" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0"
psql "$DB" -q -c "delete from work_order_progress where id='4f000000-0000-0000-0000-0000000000f4';"

#  The proof-evaluation table appearing means a migration ran — a stop
#  condition. Existence itself is the failure.
psql "$DB" -q -c "create table work_order_proof_evaluations (id uuid primary key default gen_random_uuid());"
expect 1 "G8-12 proof-evaluation table EXISTS: --verify REFUSES (migration ran)" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0"
psql "$DB" -q -c "drop table work_order_proof_evaluations;"

#  The work order leaving 'open' fails completion safety even with a
#  perfect attachment in the window.
psql "$DB" -q -c "update work_orders set status='in_progress' where id='eeeeeeee-0000-0000-0000-00000000000e';"
expect 1 "G8-13 status is NOT open: --verify REFUSES" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0"
psql "$DB" -q -c "update work_orders set status='open' where id='eeeeeeee-0000-0000-0000-00000000000e';"

#  Two bound events in one window — ambiguous, not creditable.
psql "$DB" -q -c "insert into comm_events (id, channel, direction, body, communication_line_id, actor_user_id, sms_sid, needs_human, occurred_at)
  values ('38888888-0000-0000-0000-000000000038','sms','inbound','wo 1006 another angle',
          '11111111-0000-0000-0000-000000000011','cccccccc-0000-0000-0000-00000000000c','SMfalsify004',true, now());"
expect 1 "G8-7  TWO bound events after T0: --verify REFUSES (ambiguous run)" \
  node tools/activation/evidence_ingress_proof.js --verify --t0 "$T0"
psql "$DB" -q -c "delete from comm_events where id='38888888-0000-0000-0000-000000000038';"

# ════ GATE 10 ═════════════════════════════════════════════════════════
#  MUST run before Gate 9: the receipt requires an ACTIVE operations
#  line, and the Gate 9 section ends with the fixture line retired.
echo
echo "GATE 10 — release0_final_receipt"
RIN="${TMPDIR:-/tmp}/r0_receipt_input.json"
cat > "$RIN" <<JSON
{
  "credential_rotation": { "proven": true, "comm_event_id": "818fbb08-fals-ifyx-0000-000000000000", "old_token_invalidated": true },
  "exposure_audit": { "property_facing_wired": "yes — pre-existing, untouched", "property_facing_touched": "no" },
  "deployment": {
    "pr_number": 46, "pr_head_sha": "fals1fy0000", "merge_sha": "fals1fy0001",
    "render_checkout_sha": "fals1fy0002", "deploy_event": "dep-falsify", "deployed_at": "2026-08-07T00:00:00Z",
    "boot_ok": true,
    "digest_sms": "15a03280ab081fa41fe81dcbdc914bb8209e87c7ddd8e21b7a e7067c5d9a60e",
    "digest_evidence": "619d6ccc89616994ec24e35b545e93f47ec3ffe0ee27b2d6f94ec6a95b435c22"
  },
  "signature_controls": {
    "unsigned":  { "http": 403, "wrote_rows": false },
    "signed":    { "accepted": true, "comm_event_id": "ctrl-b-event" },
    "wrong_url": { "http": 403, "wrote_rows": false },
    "duplicate": { "suppressed": true }
  },
  "rollback_drill": { "dry_run_ran": true, "rolled_back": true },
  "gate8": { "t0": "$T0" }
}
JSON
#  The digest_sms above contains a DELIBERATE space — first prove the
#  input-claim axis refuses, then fix it and prove the clean pass.
expect 1 "G10-0 corrupted digest claim in input: receipt REFUSES" \
  node tools/activation/release0_final_receipt.js --input "$RIN"
jq '.deployment.digest_sms = "15a03280ab081fa41fe81dcbdc914bb8209e87c7ddd8e21b7ae7067c5d9a60e"' "$RIN" > "$RIN.t" && mv "$RIN.t" "$RIN"
#  ⚠ that string is STILL wrong (one char short) — the real digest comes
#  from the file itself, proving the claim axis is compared to the
#  AUTHORIZED constant, not to whatever the input says twice.
expect 1 "G10-0b still-wrong digest claim: receipt REFUSES" \
  node tools/activation/release0_final_receipt.js --input "$RIN"
GOODSMS=$(sha256sum src/comms/sms.js | cut -d' ' -f1)
jq --arg d "$GOODSMS" '.deployment.digest_sms = $d' "$RIN" > "$RIN.t" && mv "$RIN.t" "$RIN"

expect 0 "G10-1 complete input + live database: receipt PASSES" \
  node tools/activation/release0_final_receipt.js --input "$RIN"
grep -q "RELEASE 0 EVIDENCE INGRESS PROVEN" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    G10-1b the proven banner appears only here"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  G10-1b banner missing from the clean pass"; }

for MISSING in "del(.deployment.merge_sha)|G10-2 deployed SHA removed" \
               "del(.signature_controls.signed)|G10-3 signature POSITIVE control omitted" \
               "del(.signature_controls.wrong_url)|G10-4 wrong-URL control omitted" \
               ".signature_controls.signed.accepted=false|G10-5 only the unsigned negative passed" \
               "del(.rollback_drill)|G10-6 rollback drill absent" \
               "del(.gate8.t0)|G10-7 binding window absent" \
               "del(.credential_rotation.comm_event_id)|G10-8 rotation event absent"; do
  FILTER="${MISSING%%|*}"; LABEL="${MISSING##*|}"
  jq "$FILTER" "$RIN" > "$RIN.mut"
  expect 1 "$LABEL: receipt REFUSES" \
    node tools/activation/release0_final_receipt.js --input "$RIN.mut"
done
#  G10-3 must also show the negatives were NOT credited — the refusal
#  reason matters, not just the exit code.
jq 'del(.signature_controls.signed)' "$RIN" > "$RIN.mut"
node tools/activation/release0_final_receipt.js --input "$RIN.mut" >/tmp/gate_falsify_last.log 2>&1
grep -q "NOT CREDITED" /tmp/gate_falsify_last.log \
  && { PASS=$((PASS+1)); echo "  ok    G10-3b unsigned/wrong-URL are explicitly NOT CREDITED without the positive"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL  G10-3b negatives were not de-credited"; }

#  Database-side holes: the receipt re-derives, so mutating the DATABASE
#  must refuse a receipt whose INPUT is perfect.
psql "$DB" -q -c "delete from events where type='work_order_assigned';"
expect 1 "G10-9 assignment event deleted from the DATABASE: receipt REFUSES" \
  node tools/activation/release0_final_receipt.js --input "$RIN"
psql "$DB" -q -c "insert into events (property_id, type, note) values ('bbbbbbbb-0000-0000-0000-00000000000b','work_order_assigned',
  '{\"work_order_id\":\"eeeeeeee-0000-0000-0000-00000000000e\",\"obligation_id\":\"ffffffff-0000-0000-0000-00000000000f\",\"assigned_user_id\":\"cccccccc-0000-0000-0000-00000000000c\",\"assigned_by_user_id\":\"dddddddd-0000-0000-0000-00000000000d\",\"idempotency_key\":null}');"

psql "$DB" -q -c "update work_orders set status='complete' where id='eeeeeeee-0000-0000-0000-00000000000e';"
expect 1 "G10-10 status changed to complete: receipt REFUSES" \
  node tools/activation/release0_final_receipt.js --input "$RIN"
psql "$DB" -q -c "update work_orders set status='open' where id='eeeeeeee-0000-0000-0000-00000000000e';"

psql "$DB" -q -c "insert into work_order_progress (id, work_order_id, property_id, kind, reported_by_user_id, occurred_at)
  values ('50000000-0000-0000-0000-000000000050','eeeeeeee-0000-0000-0000-00000000000e','bbbbbbbb-0000-0000-0000-00000000000b','completed','cccccccc-0000-0000-0000-00000000000c', now());"
expect 1 "G10-11 completion event injected: receipt REFUSES" \
  node tools/activation/release0_final_receipt.js --input "$RIN"
psql "$DB" -q -c "delete from work_order_progress where id='50000000-0000-0000-0000-000000000050';"

rm -f "$RIN" "$RIN.mut"

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
