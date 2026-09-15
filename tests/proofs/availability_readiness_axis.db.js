/* ════════════════════════════════════════════════════════════════════
   availability_readiness_axis.db.js — WHAT AVAILABILITY SAYS ABOUT
   PHYSICAL READINESS, AGAINST WHAT THE READINESS OWNERS SAY.

   Readiness has owners: a certified final walk (BUILD 4,
   unit_readiness_certifications, revocable), a confirmed initial triage
   (BUILD 1, unit_triage_confirmations, deriveReadiness), an assigned but
   unfinished walk (an open initial_unit_walk obligation), and a turn in
   progress (turnovers.status). The classifier's own axis says only
   `turning` or `ready` — `ready` meaning "no turn in progress", not that
   anyone looked. Availability overlays the owners per unit when they hold
   a row and otherwise inherits the classifier's default.

   This proof seeds one position per readiness shape, all with an
   established vacancy basis so occupancy is never the blocker, and
   records what availability says beside what deriveReadiness — the one
   governed rule — says for the same unit. It asserts observed behaviour;
   it changes no policy. Where the two disagree, the disagreement is the
   finding, and the options are a product ruling recorded in the receipt.

   Synthetic, in the caller-owned proof database, no writer exercised.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const { deriveReadiness } = require(path.join(root, "src/maintenance/unit_triage_service.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const AS_OF = "2026-07-31";

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  try {
    const tag = `readiness-axis-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const user = await one(`insert into users(name,email,is_active,status,platform_role,organization_id)
      values('Synthetic Readiness Operator',$1,true,'active','super_admin',$2) returning id`, [`${tag}@example.invalid`, org.id]);
    const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`, [tag, org.id]);
    const p = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'unit') returning id`, [tag, org.id]);
    await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id, p.id]);

    //  Seven whole-unit positions, one per readiness shape.
    const SHAPES = [
      ["301", "nothing_recorded"],
      ["302", "walk_assigned_not_done"],
      ["303", "walked_no_blocker"],
      ["304", "walked_not_ready"],
      ["305", "certified_ready"],
      ["306", "certified_then_revoked"],
      ["307", "turn_completed"],
    ];
    const unitIds = {}, spaceIds = {};
    for (const [n] of SHAPES) {
      const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, n]);
      unitIds[n] = u.id;
      spaceIds[n] = (await one("update spaces set use_type='residential' where unit_id=$1 returning id", [u.id])).id;
    }
    //  One baseline: every position confirmed vacant with lineage, so the
    //  occupancy basis is established everywhere and readiness is the only
    //  axis in play.
    const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger','readiness.csv',$2,'unit','confirmed','committed') returning id`, [p.id, AS_OF]);
    const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
      values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, p.id, AS_OF, batch.id, user.id]);
    let row = 0;
    for (const [n] of SHAPES) {
      row += 1;
      const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,$2,$3,'synthetic readiness evidence',$4,$5) returning id`, [batch.id, row, JSON.stringify({ unit_number: n, is_vacant: true }), unitIds[n], spaceIds[n]]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`,
        [act.id, p.id, n, JSON.stringify({ section: "current", unit_number: n, is_vacant: true }), ev.id, String(user.id)]);
    }
    await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
      positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
      values($1,$2,$3,$4,$5,7,0,7,$6,'platform_role:super_admin','established') returning id`, [p.id, deal.id, act.id, batch.id, AS_OF, user.id]);

    //  The readiness shapes, through the owners' own tables.
    const observation = async (n) => (await one(`insert into unit_observations(property_id,unit_id,observed_by_user_id,original_text)
      values($1,$2,$3,'synthetic initial walk') returning id`, [p.id, unitIds[n], user.id])).id;
    const triage = async (n, vacancy, condition) => pool.query(`insert into unit_triage_confirmations
      (observation_id,property_id,unit_id,confirmed_by_user_id,vacancy_observation,initial_condition)
      values($1,$2,$3,$4,$5,$6)`, [await observation(n), p.id, unitIds[n], user.id, vacancy, condition]);
    await pool.query(`insert into obligations(property_id,unit_id,module,type,status,label) values($1,$2,'maintenance','initial_unit_walk','open','walk 302')`, [p.id, unitIds["302"]]);
    await triage("303", "vacant", "normal_turn");
    await triage("304", "vacant", "severe");
    const walk = async (n) => (await one(`insert into unit_readiness_walks(property_id,unit_id,walked_by_user_id,outcome,
        work_complete_confirmed,cleaning_acceptable_confirmed,appliances_present_confirmed,appliance_function_confirmed,
        no_repair_blocker_confirmed,keys_accounted_confirmed,condition_acceptable_confirmed,no_unknowns_confirmed)
      values($1,$2,$3,'ready',true,true,true,true,true,true,true,true) returning id`, [p.id, unitIds[n], user.id])).id;
    const certify = async (n) => (await one(`insert into unit_readiness_certifications(walk_id,property_id,unit_id,certified_by_user_id,walked_by_user_id,state)
      values($1,$2,$3,$4,$4,'ready') returning id`, [await walk(n), p.id, unitIds[n], user.id])).id;
    await certify("305");
    const revokedOriginal = await certify("306");
    await pool.query(`insert into unit_readiness_certifications(walk_id,property_id,unit_id,certified_by_user_id,walked_by_user_id,state,supersedes_id,correction_reason)
      select walk_id,property_id,unit_id,certified_by_user_id,walked_by_user_id,'revoked',id,'synthetic: certification revoked' from unit_readiness_certifications where id=$1`, [revokedOriginal]);
    await pool.query(`insert into turnovers(property_id,unit_id,status,ready_date) values($1,$2,'completed',$3)`, [p.id, unitIds["307"], AS_OF]);

    const av = await availabilityRead(pool, { property_id: p.id, as_of: AS_OF });
    const rows = Object.fromEntries(av.rows.map((r) => [r.unit_number, r]));
    const owner = {
      nothing_recorded: deriveReadiness({ confirmation: null }),
      walk_assigned_not_done: deriveReadiness({ confirmation: null }),
      walked_no_blocker: deriveReadiness({ confirmation: { vacancy_observation: "vacant", initial_condition: "normal_turn", inspection_completeness: "initial_triage" } }),
      walked_not_ready: deriveReadiness({ confirmation: { vacancy_observation: "vacant", initial_condition: "severe", inspection_completeness: "initial_triage" } }),
      certified_ready: { readiness: "ready", readiness_reason: "certified_final_walk" },
      certified_then_revoked: deriveReadiness({ confirmation: null }),
      turn_completed: deriveReadiness({ confirmation: null }),
    };
    const table = SHAPES.map(([n, shape]) => ({
      unit: n, shape,
      availability: rows[n].marketing_state, blocking: rows[n].blocking_reason,
      row_physical_readiness: rows[n].physical_readiness, row_certified: rows[n].certified_ready,
      owner_readiness: owner[shape].readiness, owner_reason: owner[shape].readiness_reason,
    }));
    for (const t of table) console.log("  " + JSON.stringify(t));

    ok("every position has an established vacancy basis, so readiness is the only axis in play",
      av.rows.every((r) => r.basis_state === "established"));
    //  OFFERS ARE THE SAME IN BOTH MODES — this proof takes no policy.
    ok("offers: 301, 305, 306, 307 marketable; 302, 303 readiness_unknown; 304 not_ready_confirmed",
      ["301","305","306","307"].every((n) => rows[n].marketing_state === "marketable_now")
      && ["302","303"].every((n) => rows[n].marketing_state === "readiness_unknown")
      && rows["304"].marketing_state === "not_ready_confirmed");
    if (parent) {
      ok("(defect) every row says physical_readiness ready — including the one this read calls not ready and the two it calls unknown",
        av.rows.every((r) => r.physical_readiness === "ready"));
    } else {
      const axis = Object.fromEntries(av.rows.map((r) => [r.unit_number, [r.physical_readiness, r.readiness_basis]]));
      ok("rows say what the readiness owners say, and name which one answered",
        JSON.stringify(axis) === JSON.stringify({
          "301": ["unknown", "none"], "302": ["unknown", "walk_assigned_not_done"], "303": ["unknown", "initial_triage"],
          "304": ["not_ready", "initial_triage"], "305": ["ready", "certification"], "306": ["unknown", "none"], "307": ["unknown", "none"] }),
        JSON.stringify(axis));
    }
    ok("nothing recorded: availability offers the unit as marketable (policy unchanged in both modes)",
      rows["301"].marketing_state === "marketable_now");
    ok("nothing recorded: the readiness owner says unknown — no initial walk recorded",
      owner.nothing_recorded.readiness === "unknown" && owner.nothing_recorded.readiness_reason === "no_initial_walk_recorded");
    ok("walk assigned but not done: availability holds the unit as readiness_unknown",
      rows["302"].marketing_state === "readiness_unknown" && rows["302"].blocking_reason === "initial_inspection_pending");
    ok("walked, no blocker: availability holds the unit as readiness_unknown (a triage is not a readiness inspection)",
      rows["303"].marketing_state === "readiness_unknown");
    ok("walked, severe: availability holds the unit as not_ready_confirmed",
      rows["304"].marketing_state === "not_ready_confirmed");
    ok("certified ready: availability offers the unit and carries the certification",
      rows["305"].marketing_state === "marketable_now" && rows["305"].certified_ready === true);
    ok("certified then revoked: the certification is gone from the row",
      rows["306"].certified_ready === false);
    ok("certified then revoked: availability offers the unit exactly as if nobody had ever looked (policy, both modes)",
      rows["306"].marketing_state === "marketable_now");
    ok("turn completed: availability offers the unit (policy, both modes) — completion is not certification",
      rows["307"].marketing_state === "marketable_now" && owner.turn_completed.readiness === "unknown");
    ok("the three shapes the readiness owner calls unknown and availability still offers are 301, 306 and 307 — the ruling owed",
      ["301", "306", "307"].every((n) => rows[n].marketing_state === "marketable_now" && owner[SHAPES.find(([u]) => u === n)[1]].readiness === "unknown"));

    if (process.env.PROOF_OUTPUT_DIR) {
      fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, "availability-readiness-axis.json"),
        JSON.stringify({ mode: parent ? "positive_defect_witness" : "successor", as_of: AS_OF, table }, null, 2));
    }
  } finally {
    await pool.end();
  }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
