/* ════════════════════════════════════════════════════════════════════
   opening_claim_unattached.db.js — A RETAINED CLAIM THAT ATTACHES TO NO
   POSITION STAYS INTELLIGIBLE.

   Three historical shapes leave a confirmed source row that no rentable
   position reads: a bare-unit vacancy confirmed on a multi-bed unit under
   the old writer; a source row naming a room the unit does not have; and a
   whole-unit placeholder left beside real beds by a pre-materialization
   load. In every one the activation's tally counts the row as established,
   every position reads not established, and nothing says why — "no fact
   supplied" and "a retained claim could not be attached" collapse into one
   silence.

   The successor names the gap on the tenancy standing projection (Ask
   Spine) and the Rent Roll unit view, by the key the source gave the row.
   It never attaches the claim to a bed by inference, never broadcasts one
   claim to N beds, and never counts the row as a position.

   TWO MODES. PROOF_EXPECT_DEFECT=1 asserts the silence on the unrepaired
   readers; the default asserts the successor. Synthetic, in the
   caller-owned proof database, no confirmation path exercised.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const { datedPropertyPositions } = require(path.join(root, "src/tenancy/dated_positions.js"));
const { unitRentRoll } = require(path.join(root, "src/surfaces/rent_roll_unit_view.js"));
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const { gatherFacts } = require(path.join(root, "src/agent/ask_spine_answer.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const AS_OF = "2026-07-31";
const evidence = [];

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  console.log(`UNATTACHED_PROOF_MODE=${parent ? "positive_parent_defect" : "successor"}`);
  try {
    const tag = `claim-unattached-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const user = await one(`insert into users(name,email,is_active,status,platform_role,organization_id)
      values('Synthetic Unattached Operator',$1,true,'active','super_admin',$2) returning id`, [`${tag}@example.invalid`, org.id]);
    const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`, [tag, org.id]);

    //  One property, three units, one baseline. Units:
    //    201  Room1..Room3, bare-unit vacancy confirmed (unit-linked, no space)
    //    202  Room1..Room2, "202|Room4" vacancy confirmed (unit-linked, no space)
    //    203  '(whole unit)' placeholder beside Room1..Room3 (legacy phantom),
    //         bare-unit vacancy confirmed (unit-linked, no space)
    //  plus 204, a legitimate whole-unit vacancy that attaches, as control.
    const p = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'bed') returning id`, [tag, org.id]);
    await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id, p.id]);
    await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active)
      values($1,$2,'Proof Manager','{management,leasing}',true)`, [p.id, user.id]);
    const unitIds = {};
    async function unit(number, labels, keepPlaceholder = false) {
      const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, number]);
      unitIds[number] = u.id;
      const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
      for (let i = 0; i < labels.length; i++) {
        if (i === 0 && placeholder && !keepPlaceholder) {
          await pool.query("update spaces set space_label=$2 where id=$1", [placeholder.id, labels[i]]);
        } else {
          await pool.query("insert into spaces(unit_id,space_label) values($1,$2)", [u.id, labels[i]]);
        }
      }
      await pool.query("update spaces set use_type='residential' where unit_id=$1", [u.id]);
    }
    await unit("201", ["Room1", "Room2", "Room3"]);
    await unit("202", ["Room1", "Room2"]);
    await unit("203", ["Room1", "Room2", "Room3"], true);
    await unit("204", []);   // the placeholder IS the position
    await pool.query("update spaces set use_type='residential' where unit_id=$1", [unitIds["204"]]);

    const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger','unattached.csv',$2,'bed','confirmed','committed') returning id`, [p.id, AS_OF]);
    const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
      values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, p.id, AS_OF, batch.id, user.id]);
    const claims = [
      { key: "201", unit: "201", json: { unit_number: "201", is_vacant: true } },
      { key: "202|Room4", unit: "202", json: { unit_number: "202", space_label: "Room4", is_vacant: true } },
      { key: "203", unit: "203", json: { unit_number: "203", is_vacant: true } },
      { key: "204", unit: "204", json: { unit_number: "204", is_vacant: true } },
    ];
    let row = 0;
    for (const c of claims) {
      row += 1;
      const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,$2,$3,'synthetic unattached evidence',$4,null) returning id`, [batch.id, row, JSON.stringify(c.json), unitIds[c.unit]]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`,
        [act.id, p.id, c.key, JSON.stringify({ section: "current", ...c.json }), ev.id, String(user.id)]);
    }
    //  The activation's own tally, as establishOpeningPosition writes it:
    //  four promoted rows, four "established".
    await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
      positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
      values($1,$2,$3,$4,$5,4,0,4,$6,'platform_role:super_admin','established') returning id`, [p.id, deal.id, act.id, batch.id, AS_OF, user.id]);

    const dp = await datedPropertyPositions(pool, { property_id: p.id, as_of: AS_OF });
    const byUnit = (n) => dp.positions.filter((x) => x.unit_number === n);
    const tally = await one("select positions_established from opening_tenancy_positions where property_id=$1", [p.id]);

    ok("the activation tally counts all four confirmed rows as established", tally.positions_established === 4);
    ok("201: a bare-unit claim on a three-bed unit attaches to no bed and is broadcast to none",
      byUnit("201").every((x) => x.basis_state === "not_established" && !(x.basis_ref && x.basis_ref.proposal_id)));
    ok("202: a named room the unit does not have attaches to nothing",
      byUnit("202").every((x) => x.basis_state === "not_established"));
    const ph = byUnit("203").find((x) => /whole\s*unit/i.test(x.space_label || ""));
    ok("203: the placeholder beside real beds is still counted as a position (inventory inflation, recorded)",
      byUnit("203").length === 4 && !!ph);
    if (parent) {
      ok("203 (defect): the bare-unit claim attaches to the placeholder beside real beds, inflating marketable inventory",
        ph.basis_type === "opening_claim_vacant", ph.basis_type);
    } else {
      ok("203: the bare-unit claim never attaches to the placeholder beside beds",
        ph.basis_state === "not_established", ph.basis_type);
    }
    ok("204: a legitimate whole-unit vacancy attaches (control)",
      byUnit("204")[0].basis_type === "opening_claim_vacant");

    const standing = await readTenancyStanding(pool, { property_id: p.id, as_of: AS_OF });
    const rr = await unitRentRoll(pool, { property_id: p.id, as_of: AS_OF });
    const av = await availabilityRead(pool, { property_id: p.id, as_of: AS_OF });
    const client = await pool.connect(); let facts;
    try {
      await client.query("begin isolation level repeatable read read only");
      facts = await gatherFacts(client, { property_id: p.id, allowed_modules: ["management"], subject: "tenancy" });
      await client.query("rollback");
    } finally { client.release(); }

    const summary = {
      tally_established: tally.positions_established,
      positions: dp.positions.length,
      not_established: standing.position.not_established,
      open: standing.position.open,
      unknowns: standing.unknowns,
      unattached: standing.unattached_source_rows || null,
      rent_roll_totals: rr.totals,
      availability: { marketable_now: av.headline.marketable_now, occupancy_unknown: av.states.occupancy_unknown ?? null },
      ask_unknowns: facts.tenancy && facts.tenancy.unknowns,
      ask_unattached: facts.tenancy && facts.tenancy.unattached_source_rows,
    };
    evidence.push(summary);

    if (parent) {
      ok("(defect) ten positions are recorded and two read established — the control and the phantom placeholder",
        dp.positions.length === 10 && standing.position.established === 2);
      ok("(defect) availability offers the phantom placeholder beside the control",
        av.headline.marketable_now === 2 && av.states.occupancy_unknown === 8);
    } else {
      ok("ten positions are recorded and one is established", dp.positions.length === 10 && standing.position.established === 1);
      ok("availability offers exactly the control and refuses the rest as unknown",
        av.headline.marketable_now === 1 && av.states.occupancy_unknown === 9);
    }

    if (parent) {
      ok("(defect) the standing projection carries no name for the three retained-but-unattached rows",
        !("confirmed_source_rows_not_attached_to_a_position" in (standing.unknowns || {})) && !standing.unattached_source_rows);
      ok("(defect) the Rent Roll unit view carries no name for them either",
        !("confirmed_rows_not_attached" in rr.totals) && !rr.unattached_source_rows);
      //  Eight, not nine: on the unrepaired reader the phantom placeholder
      //  reads established on the bare-unit claim (asserted above).
      ok("(defect) Ask Spine is told eight positions are not established and nothing about the confirmed rows",
        facts.tenancy.position.not_established === 8 && !("confirmed_source_rows_not_attached_to_a_position" in facts.tenancy.unknowns));
    } else {
      ok("standing: three confirmed source rows are named as not attached to any position",
        standing.unknowns.confirmed_source_rows_not_attached_to_a_position === 3
        && standing.unknowns.held_source_rows_not_attached_to_a_position === 0);
      ok("standing: they are listed by the key the source gave them, never by a bed",
        JSON.stringify((standing.unattached_source_rows || []).map((r) => r.source_key).sort()) === JSON.stringify(["201", "202|Room4", "203"]));
      ok("standing: positions are still not established — no relationship was invented",
        standing.position.not_established === 9 && standing.position.open === 1);
      ok("Rent Roll unit view carries the same three, from the same read",
        rr.totals.confirmed_rows_not_attached === 3 && rr.unattached_source_rows.length === 3);
      ok("Ask Spine carries the count and the source keys, and no record id",
        facts.tenancy.unknowns.confirmed_source_rows_not_attached_to_a_position === 3
        && Array.isArray(facts.tenancy.unattached_source_rows) && facts.tenancy.unattached_source_rows.length === 3
        && !JSON.stringify(facts.tenancy.unattached_source_rows).match(/[0-9a-f]{8}-[0-9a-f]{4}-/));
    }
    const changed = await one("select count(*)::int as n from proposed_records where property_id=$1 and updated_at > confirmed_at + interval '1 second'", [p.id]);
    ok("no proposal row was rewritten by any read", changed.n === 0);

    if (process.env.PROOF_OUTPUT_DIR) {
      fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `opening-claim-unattached-${parent ? "parent" : "successor"}.json`),
        JSON.stringify({ mode: parent ? "positive_defect_witness" : "successor", evidence }, null, 2));
    }
  } finally {
    await pool.end();
  }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
