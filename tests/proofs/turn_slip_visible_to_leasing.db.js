/* ════════════════════════════════════════════════════════════════════
   turn_slip_visible_to_leasing.db.js — WHEN A TURN SLIPS, LEASING SEES IT.

   Found by the operating-loop audit (CURRENT_STATE row 150, break 2): the
   expected-ready date is stated once at move-out and had no writer until
   the turn closed. A walk that then confirmed a dead HVAC left the
   availability row saying `expected` on the old date, and the application
   authority kept promising a move-in on it. Nothing signalled leasing
   unless a committed move-in already existed.

   THE RULE THIS PINS (row 152):
     · the plan date is `expected` only while no schedule-controlling
       finding — the triage service's OWN test, scheduleAtRisk — post-dates
       the instant the date was last stated;
     · when one does, the date is still carried but confidence is
       `incomplete` with blocking_fact `turn_scope_exceeds_plan`, and the
       application authority refuses (application_ready_date_not_governed);
     · the manager re-states the date through the existing move-out
       authority (POST /operator/units/:unitId/turn-target, with a reason),
       which is an event, moves the move-out obligation's due date, and
       restores `expected` — the finding is now priced in;
     · ordinary turn work (findings without a long lead, required items) is
       the plan, not a slip; a finding confirmed BEFORE the date was stated
       was already priced in.

   Synthetic, in the caller-owned proof database, through the REAL turnover
   writer, the REAL triage writer, the REAL availability read, the REAL
   application authority and the REAL operator door over loopback HTTP.

   Run:      E2E_API_BASE=… node tests/proofs/turn_slip_visible_to_leasing.db.js
   Witness:  PROOF_EXPECT_DEFECT=1 on the unmodified tree
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");
const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const API = process.env.E2E_API_BASE;
assert.match(String(API || ""), /^http:\/\/127\.0\.0\.1:\d+$/, "owned HTTP server required");
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const target = require(path.join(root, "src/applications/application_target_authority.js"));
const { rankTurnPriority } = require(path.join(root, "src/maintenance/turn_priority.js"));
const engine = require(path.join(root, "src/shared/obligation_engine.js"));
const { recordEffectivePossession } = require(path.join(root, "src/tenancy/space_position.js"));
const { makeUnitTriageService } = require(path.join(root, "src/maintenance/unit_triage_service.js"));
const { makeTurnoverService } = require(path.join(root, "src/maintenance/turnover_service.js"));
const staffSessions = require(path.join(root, "src/identity/staff_session_service.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const DAY = 86400000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const D = (n) => ymd(Date.now() + n * DAY);

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const tag = `turn-slip-${randomUUID().slice(0, 8)}`;
  const unitTriageService = makeUnitTriageService({ spawnObligationFromEvent: engine.spawnObligationFromEvent });
  const turnoverService = makeTurnoverService({
    spawnObligationFromEvent: engine.spawnObligationFromEvent, recordEffectivePossession, unitTriageService });

  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const pm = await one(`insert into users(name,email,role,is_active,status,account_kind,organization_id)
    values('Turn Slip Manager',$1,'property_manager',true,'active','internal_qa',$2) returning id`, [tag + "@example.invalid", org.id]);
  const person = (await one("insert into persons(name,lifecycle_status) values('Turn Slip Resident','tenant') returning id")).id;
  async function property(name) {
    const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`, [name, org.id]);
    const p = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'unit') returning id`, [name, org.id]);
    await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id, p.id]);
    await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,active)
      values($1,$2,'Property Manager','property','{management,maintenance,leasing}','{management}',true)`, [p.id, pm.id]);
    return { id: p.id, deal_id: deal.id };
  }
  async function unit(P, n) {
    const u = (await one("insert into units(property_id,unit_number) values($1,$2) returning id", [P, n])).id;
    const s = (await one("update spaces set use_type='residential', position_kind='unit' where unit_id=$1 returning id", [u])).id;
    return { unit_id: u, space_id: s };
  }
  async function opening(P, deal_id, asOf, claims) {
    const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger','slip.csv',$2,'unit','confirmed','committed') returning id`, [P, asOf]);
    const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
      values($1,$2,'activated',$3,$4,$5) returning id`, [deal_id, P, asOf, batch.id, pm.id]);
    let ix = 0;
    for (const c of claims) {
      ix += 1;
      const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,$2,$3,'turn slip evidence',$4,$5) returning id`,
        [batch.id, ix, JSON.stringify({ unit_number: c.unit_number, tenant_name: c.tenant_name, is_vacant: false }), c.unit_id, c.space_id]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`,
        [act.id, P, c.unit_number, JSON.stringify({ section: "current", unit_number: c.unit_number, tenant_name: c.tenant_name, is_vacant: false }), ev.id, String(pm.id)]);
    }
    await pool.query(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
      positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
      values($1,$2,$3,$4,$5,$6,0,$6,$7,'platform_role:super_admin','established')`, [P, deal_id, act.id, batch.id, asOf, claims.length, pm.id]);
  }
  const lease = async (P, space_id) => (await one(`insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status,source_type,confidence)
    values($1,$2,$3,1200,$4,$5,'active','historical_snapshot','confirmed') returning id`, [P, space_id, [person], D(-400), D(-1)])).id;
  const tx = async (fn) => {
    const c = await pool.connect();
    try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
    catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  const door = (P, unit_id, outgoing_lease_id, expected) => tx((c) => turnoverService.openTurnover(c, {
    property_id: P, unit_id, outgoing_lease_id, needs: ["clean"], expected_ready_date: expected, actor_user_id: pm.id }));
  const walk = (P, unit_id, spec) => tx((c) => unitTriageService.confirmTriage(c, {
    property_id: P, unit_id, actor_user_id: pm.id, vacancy_observation: "vacant", ...spec }));
  const row = async (P, space_id) => (await availabilityRead(pool, { property_id: P })).rows.find((r) => String(r.space_id) === String(space_id));
  const ask = async (P, unit_id, start, end) => {
    const t = await target.resolveApplicationTarget(pool, { property_id: P, unit_id, intended_move_in: start, requested_end: end });
    return { offerable: !!t.offerable, code: t.refusal_code, from: t.available_from, confidence: t.availability_confidence };
  };
  const line = (r) => `state=${r.marketing_state} from=${r.available_from}/${r.availability_confidence} fact=${r.blocking_fact} plan=${r.turnover && r.turnover.plan_state}`;

  try {
    const A = await property(tag); const P = A.id;
    const u401 = await unit(P, "401"), u402 = await unit(P, "402"), u403 = await unit(P, "403"), u404 = await unit(P, "404");
    await opening(P, A.deal_id, D(-60), [
      { unit_number: "401", ...u401, tenant_name: "Resident 401" }, { unit_number: "402", ...u402, tenant_name: "Resident 402" },
      { unit_number: "403", ...u403, tenant_name: "Resident 403" }, { unit_number: "404", ...u404, tenant_name: "Resident 404" }]);
    const L = { 401: await lease(P, u401.space_id), 402: await lease(P, u402.space_id), 403: await lease(P, u403.space_id), 404: await lease(P, u404.space_id) };

    console.log("\n== 401: door with expected " + D(14) + ", prospect asks " + D(20) + ", THEN the walk finds a dead HVAC ==");
    const t401 = await door(P, u401.unit_id, L[401], D(14));
    let a = await ask(P, u401.unit_id, D(20), D(385));
    ok("before the walk: offerable for " + D(20) + " on the expected date", a.offerable && a.from === D(14), JSON.stringify(a));
    const triage401 = await walk(P, u401.unit_id, { original_text: "401 empty, HVAC dead, full replacement",
      initial_condition: "severe", findings: [{ finding_text: "HVAC dead", long_lead_kind: "hvac_failure" }] });
    let r = await row(P, u401.space_id);
    a = await ask(P, u401.unit_id, D(20), D(385));
    if (parent) {
      console.log("== WITNESS (unmodified tree) ==");
      ok("after the walk the row still says expected on the old date", r.availability_confidence === "expected" && r.available_from === D(14), line(r));
      ok("and a prospect can still be promised " + D(20), a.offerable, JSON.stringify(a));
    } else {
      console.log("== SUCCESSOR ==");
      ok("the date is still carried — it is what the manager said", r.available_from === D(14), line(r));
      ok("but it is no longer `expected`: turn_scope_exceeds_plan", r.availability_confidence === "incomplete" && r.blocking_fact === "turn_scope_exceeds_plan", line(r));
      ok("the turnover on the row says why: plan_state exceeded", r.turnover && r.turnover.plan_state === "exceeded", line(r));
      ok("the application authority refuses the old promise", !a.offerable && a.code === "application_ready_date_not_governed", JSON.stringify(a));
      ok("the turn is still in Turn Priority (a slip does not hide work)", (await rankTurnPriority(pool, P)).turns.some((t) => String(t.unit_id) === String(u401.unit_id)));
      ok("no committed move-in, so no protect obligation was raised — the availability row is the signal",
        !triage401.move_in_risk_obligation);

      console.log("\n== the manager re-states the target through the operator door ==");
      const session = (await staffSessions.issueStaffSession(pool, { userId: pm.id, propertyId: P, purpose: "bootstrap_invite" })).session_token;
      const post = async (unitId, body, headers = { "x-staff-session": session }) => {
        const res = await fetch(API + "/operator/units/" + unitId + "/turn-target", { method: "POST",
          headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, data: await res.json() };
      };
      const noReason = await post(u401.unit_id, { expected_ready_date: D(30) });
      ok("a re-statement without a reason is refused", noReason.status === 400 && noReason.data.code === "REASON_REQUIRED", JSON.stringify(noReason.data));
      const anon = await post(u401.unit_id, { expected_ready_date: D(30), reason: "x" }, {});
      ok("anonymous is refused", anon.status === 401, String(anon.status));
      const noTurn = await post(u403.unit_id, { expected_ready_date: D(30), reason: "no turn here" });
      ok("a unit with no turn in progress is refused", noTurn.status === 409 && noTurn.data.code === "NO_ACTIVE_TURNOVER", JSON.stringify(noTurn.data));
      const restated = await post(u401.unit_id, { expected_ready_date: D(30), reason: "HVAC vendor confirmed install " + D(28) });
      ok("the re-statement is accepted", restated.status === 200 && restated.data.expected_ready_date === D(30) && restated.data.previous_ready_date === D(14), JSON.stringify(restated.data).slice(0, 300));
      ok("it is an event a reader can point at", restated.data.event && restated.data.event.type === "turn_ready_date_restated");
      const due = await one("select due_at from obligations where module='turnover' and type='move_out' and related_id=$1", [t401.turnover.id]);
      ok("the move-out obligation's due date moved with it", due && ymd(due.due_at) === D(30), JSON.stringify(due));
      r = await row(P, u401.space_id);
      ok("availability now reads expected on the new date — the finding is priced in", r.available_from === D(30) && r.availability_confidence === "expected" && r.turnover.plan_state === "holds", line(r));
      a = await ask(P, u401.unit_id, D(20), D(385));
      ok("the old promise is refused as before the new date", !a.offerable && a.code === "application_move_in_before_expected_ready", JSON.stringify(a));
      a = await ask(P, u401.unit_id, D(35), D(400));
      ok("a move-in after the new date is offerable", a.offerable && a.from === D(30), JSON.stringify(a));
      const again = await walk(P, u401.unit_id, { original_text: "401 re-walked: asbestos found in the ceiling",
        initial_condition: "severe", findings: [{ finding_text: "asbestos abatement", long_lead_kind: "major_repair" }],
        supersedes_id: triage401.confirmation.id, correction_reason: "second walk found more" });
      r = await row(P, u401.space_id);
      ok("a NEW finding after the re-statement exceeds the plan again", again.confirmation && r.availability_confidence === "incomplete" && r.turnover.plan_state === "exceeded", line(r));
    }

    console.log("\n== controls ==");
    await door(P, u402.unit_id, L[402], D(14));
    await walk(P, u402.unit_id, { original_text: "402 empty, normal turn: paint, clean, patch a door", initial_condition: "normal_turn",
      findings: [{ finding_text: "door dinged" }], required_work: [{ work_text: "patch bedroom door" }] });
    r = await row(P, u402.space_id);
    ok("402: ordinary turn work is the plan, not a slip — still expected", r.availability_confidence === "expected" && r.available_from === D(14), line(r));
    ok("402: still offerable after the expected date", (await ask(P, u402.unit_id, D(20), D(385))).offerable);
    await door(P, u403.unit_id, L[403], D(14));
    r = await row(P, u403.space_id);
    ok("403: no walk yet — expected (the walk is owed, but nothing found controls the schedule)", r.availability_confidence === "expected", line(r));
    await walk(P, u404.unit_id, { original_text: "404: pest treatment needed", initial_condition: "severe",
      findings: [{ finding_text: "roaches", long_lead_kind: "pest_treatment" }] });
    await door(P, u404.unit_id, L[404], D(21));
    r = await row(P, u404.space_id);
    ok("404: a finding confirmed BEFORE the date was stated was priced in — expected", r.availability_confidence === "expected" && r.available_from === D(21), line(r));
  } finally {
    console.log(`\n${passed} passed, ${failed} failed${parent ? " (witness mode)" : ""}`);
    await pool.end();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS:", e.stack || e.message); process.exit(2); });
