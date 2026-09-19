/* ════════════════════════════════════════════════════════════════════
   readiness_one_truth.db.js — ONE PHYSICAL-READINESS TRUTH, FED TO EVERY
   GATE THAT ASKS FOR IT.

   Found by the operating-loop audit (CURRENT_STATE row 150, break 3): three
   things could say a unit was physically ready.
     · turnovers.status, closed by the certification OR by the legacy
       POST /turnovers/:id/ready behind the shared operator key, which
       needed only move-out photos and a deposit review — so a unit nobody
       had walked read turn-complete;
     · unit_readiness_certifications, the one path readiness_service.js
       calls "the ONLY module permitted to make a unit physically ready";
     · the move-in `readiness` obligation in movein.js, whose approval is
       what feeds `unit_ready` into the lease's delivery gate — and the
       certification never fed it, so the key handoff asked for a second
       inspection of a unit already certified.

   THE RULE THIS PINS (row 153):
     · the legacy ready route refuses (READINESS_NOT_CERTIFIED) unless the
       unit carries a live certification; a certified walk closes the turn
       on its own, so the route can only confirm what certification
       already established;
     · a `ready` certification satisfies `unit_ready` on every open
       move_in_delivery obligation for a lease on the unit's spaces — the
       incoming resident's key handoff reads the same readiness the turn
       queue and availability read; keys and funds stay their own gates;
     · a certification on a unit with no incoming lease feeds nothing and
       claims nothing.

   Synthetic, in the caller-owned proof database, through the REAL
   turnover writer, triage, scope and readiness services (with the REAL
   delivery helper) and the legacy route over loopback HTTP.

   Run:      E2E_API_BASE=… node tests/proofs/readiness_one_truth.db.js
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
const engine = require(path.join(root, "src/shared/obligation_engine.js"));
const { recordEffectivePossession } = require(path.join(root, "src/tenancy/space_position.js"));
const { makeUnitTriageService } = require(path.join(root, "src/maintenance/unit_triage_service.js"));
const { makeUnitTurnScopeService } = require(path.join(root, "src/maintenance/unit_turn_scope_service.js"));
const { makeWorkAcceptanceService } = require(path.join(root, "src/maintenance/work_acceptance_service.js"));
const { makeWorkProofAttachmentService } = require(path.join(root, "src/maintenance/work_proof_attachment_service.js"));
const { makeReadinessService } = require(path.join(root, "src/maintenance/readiness_service.js"));
const { makeTurnoverService } = require(path.join(root, "src/maintenance/turnover_service.js"));
const makeDelivery = require(path.join(root, "src/comms/delivery.js"));

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
  const tag = `readiness-one-${randomUUID().slice(0, 8)}`;

  //  Wired as server.js wires them, including the ONE delivery helper.
  const spawnObligationFromEvent = engine.spawnObligationFromEvent;
  const deliveryHelper = makeDelivery({ satisfyObligation: engine.satisfyObligation, completeObligation: engine.completeObligation });
  const unitTriageService = makeUnitTriageService({ spawnObligationFromEvent });
  const unitTurnScopeService = makeUnitTurnScopeService({ spawnObligationFromEvent });
  const workAcceptanceService = makeWorkAcceptanceService({ spawnObligationFromEvent, attachmentService: makeWorkProofAttachmentService() });
  const readinessService = makeReadinessService({ spawnObligationFromEvent, workAcceptanceService, deliveryHelper });
  const turnoverService = makeTurnoverService({ spawnObligationFromEvent, recordEffectivePossession, unitTriageService });

  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const pm = await one(`insert into users(name,email,role,is_active,status,account_kind,organization_id)
    values('Readiness One Manager',$1,'property_manager',true,'active','internal_qa',$2) returning id`, [tag + "@example.invalid", org.id]);
  const person = (await one("insert into persons(name,lifecycle_status) values('Readiness One Resident','tenant') returning id")).id;
  const incoming = (await one("insert into persons(name,lifecycle_status) values('Readiness One Incoming','prospect') returning id")).id;
  const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
    values('existing_asset','classified',$1,$2) returning id`, [tag, org.id]);
  const P = (await one(`insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'unit') returning id`, [tag, org.id])).id;
  await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id, P]);
  await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,active)
    values($1,$2,'Property Manager','property','{management,maintenance,leasing}','{management}',true)`, [P, pm.id]);
  async function unit(n) {
    const u = (await one("insert into units(property_id,unit_number) values($1,$2) returning id", [P, n])).id;
    const s = (await one("update spaces set use_type='residential', position_kind='unit' where unit_id=$1 returning id", [u])).id;
    return { unit_id: u, space_id: s };
  }
  const u501 = await unit("501"), u502 = await unit("502"), u503 = await unit("503");
  //  Opening position: all three occupied at the opening date.
  const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
    values($1,'rent_roll_ledger','readiness.csv',$2,'unit','confirmed','committed') returning id`, [P, D(-60)]);
  const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
    values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, P, D(-60), batch.id, pm.id]);
  let ix = 0;
  for (const [n, u] of [["501", u501], ["502", u502], ["503", u503]]) {
    ix += 1;
    const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
      values($1,$2,$3,'readiness one evidence',$4,$5) returning id`, [batch.id, ix, JSON.stringify({ unit_number: n, tenant_name: "R" + n, is_vacant: false }), u.unit_id, u.space_id]);
    await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
      values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`, [act.id, P, n, JSON.stringify({ section: "current", unit_number: n, tenant_name: "R" + n, is_vacant: false }), ev.id, String(pm.id)]);
  }
  await pool.query(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
    positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
    values($1,$2,$3,$4,$5,3,0,3,$6,'platform_role:super_admin','established')`, [P, deal.id, act.id, batch.id, D(-60), pm.id]);
  const lease = async (space_id, who, { status = "active", start = D(-400), end = D(-1) } = {}) => (await one(
    `insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status,source_type,confidence)
     values($1,$2,$3,1200,$4,$5,$6,'historical_snapshot','confirmed') returning id`, [P, space_id, [who], start, end, status])).id;
  const tx = async (fn) => {
    const c = await pool.connect();
    try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
    catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  const door = (u, l) => tx((c) => turnoverService.openTurnover(c, { property_id: P, unit_id: u.unit_id, outgoing_lease_id: l, needs: ["clean"], expected_ready_date: D(14), actor_user_id: pm.id }));
  const certify = async (u) => {
    const triage = await tx((c) => unitTriageService.confirmTriage(c, { property_id: P, unit_id: u.unit_id, actor_user_id: pm.id,
      original_text: "walked: empty, normal turn", vacancy_observation: "vacant", initial_condition: "normal_turn" }));
    await tx((c) => unitTurnScopeService.confirmScope(c, { property_id: P, unit_id: u.unit_id, actor_user_id: pm.id,
      triage_confirmation_id: triage.confirmation.id, paint_level: "none", cleaning_level: "none", keys_status: "accounted_for",
      inspection_completeness: "complete_turn_scope" }));
    return tx((c) => readinessService.recordWalk(c, { property_id: P, unit_id: u.unit_id, actor_user_id: pm.id, outcome: "ready",
      confirmations: { work_complete_confirmed: true, cleaning_acceptable_confirmed: true, appliances_present_confirmed: true,
        appliance_function_confirmed: true, no_repair_blocker_confirmed: true, keys_accounted_confirmed: true,
        condition_acceptable_confirmed: true, no_unknowns_confirmed: true }, note: "readiness one truth" }));
  };
  const hdr = { "content-type": "application/json", "x-operator-key": "e2e-key" };
  const legacy = async (turnover_id, p) => {
    const r = await fetch(API + "/turnovers/" + turnover_id + "/" + p, { method: "POST", headers: hdr, body: JSON.stringify(p === "ready" ? {} : { gate: p.split("=")[1], proof: { note: "x" } }) });
    return { status: r.status, data: await r.json() };
  };
  const turnStatus = async (id) => (await one("select status from turnovers where id=$1", [id])).status;
  const certs = async (u) => Number((await one("select count(*)::int as n from unit_readiness_certifications where unit_id=$1 and state='ready'", [u.unit_id])).n);

  try {
    const L = { 501: await lease(u501.space_id, person), 502: await lease(u502.space_id, person), 503: await lease(u503.space_id, person) };
    const t501 = await door(u501, L[501]), t502 = await door(u502, L[502]), t503 = await door(u503, L[503]);

    console.log("\n== 501: an incoming lease with its move-in delivery obligation, as confirm-term writes it ==");
    const L2 = await lease(u501.space_id, incoming, { status: "pending", start: D(20), end: D(385) });
    const delivery = await tx((c) => spawnObligationFromEvent(c, { property_id: P, unit_id: u501.unit_id, person_id: incoming,
      related_id: L2, related_type: "lease", module: "leasing", type: "move_in_delivery", label: "Deliver 501 to incoming resident",
      owner_type: "human", assigned_role: "property_manager", status: "open", required_inputs: ["unit_ready", "keys_access_ready"] }));
    ok("delivery obligation starts with unit_ready and keys_access_ready outstanding",
      delivery.required_inputs.includes("unit_ready") && delivery.required_inputs.includes("keys_access_ready"), JSON.stringify(delivery.required_inputs));
    const walk501 = await certify(u501);
    const after = await one("select required_inputs, status from obligations where id=$1", [delivery.id]);
    ok("the certification closed the turn", walk501.closed_turnovers.length === 1 && (await turnStatus(t501.turnover.id)) === "ready");
    if (parent) {
      console.log("== WITNESS (unmodified tree) ==");
      ok("the delivery gate still asks for unit_ready after a certification", after.required_inputs.includes("unit_ready"), JSON.stringify(after.required_inputs));
    } else {
      console.log("== SUCCESSOR ==");
      ok("the certification satisfied the delivery gate's unit_ready input", !after.required_inputs.includes("unit_ready"), JSON.stringify(after.required_inputs));
      ok("keys stay their own gate", after.required_inputs.includes("keys_access_ready") && after.status !== "complete", JSON.stringify(after));
      ok("the walk result names what it fed", Array.isArray(walk501.delivery_inputs_satisfied)
        && walk501.delivery_inputs_satisfied.some((d) => String(d.lease_id) === String(L2) && d.satisfied), JSON.stringify(walk501.delivery_inputs_satisfied));
      const proof = await one("select proof from obligation_inputs where obligation_id=$1 and input='unit_ready'", [delivery.id]).catch(() => null);
      if (proof) ok("the proof names the certification", proof.proof && String(proof.proof.certification_id) === String(walk501.certification.id), JSON.stringify(proof.proof));
    }
    const av501 = (await availabilityRead(pool, { property_id: P })).rows.find((r) => String(r.space_id) === String(u501.space_id));
    ok("availability reads the same readiness: certified", av501.readiness_basis === "certification" && av501.physical_readiness === "ready",
      av501.physical_readiness + "/" + av501.readiness_basis);

    console.log("\n== 502: the legacy door with administrative proof only ==");
    for (const g of ["moveout_photos", "deposit_review"]) {
      const s = await legacy(t502.turnover.id, "satisfy?gate=" + g);
      ok("legacy gate " + g + " satisfied", s.status === 200, String(s.status));
    }
    const closed = await legacy(t502.turnover.id, "ready");
    if (parent) {
      ok("the legacy door closed the turn with zero certifications", closed.status === 200 && (await certs(u502)) === 0 && (await turnStatus(t502.turnover.id)) === "ready", String(closed.status));
    } else {
      ok("the legacy door refuses without a certification", closed.status === 409 && closed.data.error === "READINESS_NOT_CERTIFIED", JSON.stringify(closed.data));
      ok("the turn is still in progress", (await turnStatus(t502.turnover.id)) === "in_progress");
      ok("the refusal says what to do", /final readiness walk/i.test(closed.data.receipt || ""), closed.data.receipt);
      const walk502 = await certify(u502);
      ok("a certified walk closes the turn on its own", walk502.closed_turnovers.length === 1 && (await turnStatus(t502.turnover.id)) === "ready");
      const again = await legacy(t502.turnover.id, "ready");
      ok("the legacy door then has nothing left to do", again.status === 409 && /already ready/.test(again.data.error || ""), JSON.stringify(again.data));
      ok("502 fed no delivery gate — no incoming lease", (walk502.delivery_inputs_satisfied || []).length === 0);
    }

    console.log("\n== 503: certification with no incoming lease claims nothing ==");
    const walk503 = await certify(u503);
    ok("turn closed", walk503.closed_turnovers.length === 1 && (await turnStatus(t503.turnover.id)) === "ready");
    ok("nothing fed, nothing claimed", (walk503.delivery_inputs_satisfied || []).length === 0);
  } finally {
    console.log(`\n${passed} passed, ${failed} failed${parent ? " (witness mode)" : ""}`);
    await pool.end();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS:", e.stack || e.message); process.exit(2); });
