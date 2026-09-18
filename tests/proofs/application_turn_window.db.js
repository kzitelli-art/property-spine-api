"use strict";
// Class 3: synthetic historical shape, owned disposable database only.
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { seedInventory } = require("../fixtures/slice9_inventory_fixture");
const { intervalPropertyPositions } = require("../../src/tenancy/dated_positions");
const authority = require("../../src/applications/application_target_authority");
const { leaseableApplicationTargets } = require("../../src/applications/application_target_read");

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const f = await seedInventory(c);
    const home = f.units["B-upcoming"];
    const start = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    await c.query("insert into turnovers(property_id,unit_id,status,ready_date,outgoing_lease_id) values($1,$2,'in_progress',$3,$4)", [f.property_id, home.unit_id, start,f.ids.upcoming_lease]);
    const input = { property_id: f.property_id, unit_id: home.unit_id, space_id: home.space_id, intended_move_in: start, requested_end: end };
    const iv = await intervalPropertyPositions(c, { property_id: f.property_id, requested_start: start, requested_end: end });
    assert.equal(iv.positions.find(p => p.space_id === home.space_id).interval_state, "term_blocked");
    const offered = await authority.resolveApplicationTarget(c, input);
    console.log(JSON.stringify({ case: "turn-ready date overlaps outgoing lease", interval: "term_blocked", application_offerable: offered.offerable }));
    assert.equal(offered.offerable, false, "a turn-ready estimate must not override the outgoing resident's dated rights");
    assert.equal(offered.refusal_code, "application_term_not_free");
    const menu = await leaseableApplicationTargets(c, { property_id: f.property_id });
    assert.equal(menu.eligible_targets.some(t => t.space_id === home.space_id), false, "the staff menu must exclude the same contradictory target");
    assert.equal(menu.excluded_targets.find(t=>t.space_id===home.space_id).refusal_code,"application_term_not_free","the menu preserves the dated authority's reason");
    // The correction is to the actual contractual record, never to the reader.
    const previousDay = new Date(Date.parse(start + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    await c.query("update leases set end_date=$2 where id=$1", [f.ids.upcoming_lease, previousDay]);
    assert.equal((await authority.resolveApplicationTarget(c, input)).offerable, true, "a turn after the outgoing term remains eligible");
    assert.equal((await authority.resolveSubmissionTarget(c, input)).offerable, true, "submission uses the same dated rights check");
    assert.equal((await authority.resolveApplicationTarget(c, { ...input, intended_move_in: previousDay })).offerable, false, "move-in before expected readiness remains refused");
    // Commit only this owned synthetic property to exercise the actual HTTP
    // menu. The outer runner drops the entire owned database after this proof.
    const staff = (await c.query("insert into persons(name) values('Owned turn-window operator') returning id")).rows[0];
    await c.query("update users set person_id=$2,account_kind='human_staff' where id=$1", [f.user_id,staff.id]);
    await c.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof operator','{leasing}',true)", [f.property_id,f.user_id]);
    const session = (await require("../../src/identity/staff_session_service").issueStaffSession(c, { userId:f.user_id,propertyId:f.property_id,purpose:"sms_otp" })).session_token;
    await c.query("commit");
    async function httpMenu(term = null) {
      const query = term ? "?" + new URLSearchParams(term) : "";
      const response = await fetch(process.env.E2E_API_BASE + "/operator/leasing/leaseable-units" + query, { headers:{"x-staff-session":session} });
      assert.equal(response.status,200);
      return response.json();
    }
    assert.equal((await httpMenu()).eligible_targets.some(t => t.space_id === home.space_id),true,"HTTP menu retains the feasible home");
    const requested={requested_start:previousDay,requested_end:end};
    assert.equal((await httpMenu(requested)).eligible_targets.some(t=>t.space_id===home.space_id),false,"HTTP menu excludes a home ready after the prospect's move-in");
    const excluded=(await httpMenu(requested)).excluded_targets.find(t=>t.space_id===home.space_id);
    assert.equal(excluded.refusal_code,"application_move_in_before_expected_ready");
    assert.equal(excluded.available_from,start);
    assert.equal(excluded.availability_confidence,"expected");
    assert.equal(excluded.offerable,false);
    assert.equal(excluded.resolved_space_id,undefined);
    assert.equal(excluded.refusal_reason,authority.REFUSAL_TEXT[excluded.refusal_code]);
    const fitting=await httpMenu({requested_start:start,requested_end:end});
    assert.equal(fitting.selection_basis,"requested_term");
    assert.equal(fitting.eligible_targets.find(t=>t.space_id===home.space_id).requested_end,end,"HTTP menu carries the full requested term");
    await c.query("update leases set end_date=$2 where id=$1", [f.ids.upcoming_lease,end]);
    assert.equal((await httpMenu()).eligible_targets.some(t => t.space_id === home.space_id),false,"HTTP menu removes the contradictory home on reread");
    await c.query("update leases set end_date=$2 where id=$1", [f.ids.upcoming_lease,previousDay]);
    await require("../e2e/application_turn_offer_http")({c,f,session,start,end,previousDay});
    const prospect=await require("../e2e/prospect_vitals_http")({c,f,session});
    await require("../e2e/application_target_dates_browser")({base:process.env.E2E_API_BASE,session,start,end,spaceId:home.space_id,outgoingEnd:previousDay,personId:prospect.personId});
    console.log("application turn window: DB/HTTP date controls and real picker-function browser proof passed");
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
