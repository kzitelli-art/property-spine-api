/* ════════════════════════════════════════════════════════════════════
   qb_findings_relay.db.js — QB's three relay findings, reproduced on the
   real readers and falsified against the parked patch.

   PARKED beside the patch it proves (docs/handoffs/.../fable-reset2/).
   Ownership of src/ and tests/ sits with QB during integration review, so
   this file is copied to tests/proofs/ only by whoever owns that tree.

     1. zero inventory: every position retired → the standing read returns
        before the unattached relay; Ask loses the retained claim.
     2. selection ≠ attachment: two keys, one claim, one position → one is
        selected and the other is counted as unattached.
     3. truncation: 52 unattached rows → the helper bounds to 50 and sets
        truncated; the readers relay the list and drop the flag.

   TWO MODES. PROOF_EXPECT_DEFECT=1 asserts the current behaviour on the
   unpatched reader; the default asserts the patched successor. Synthetic,
   in the caller-owned proof database, no writer exercised.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("../../../../../tests/e2e/proof_boundary.js");
require("../../../../../tests/e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../../../../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const { datedPropertyPositions } = require(path.join(root, "src/tenancy/dated_positions.js"));
const { unitRentRoll } = require(path.join(root, "src/surfaces/rent_roll_unit_view.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const retirement = require(path.join(root, "src/tenancy/inventory_retirement.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const AS_OF = "2026-07-31";
const evidence = {};

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  console.log(`RELAY_PROOF_MODE=${parent ? "positive_parent_defect" : "successor"}`);
  try {
    const tag = `qb-relay-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const user = await one(`insert into users(name,email,is_active,status,platform_role,organization_id)
      values('Synthetic Relay Operator',$1,true,'active','super_admin',$2) returning id`, [`${tag}@example.invalid`, org.id]);
    const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`, [tag, org.id]);

    //  One property per finding, one baseline each, claims linked at the
    //  unit (and at the space where the finding needs it).
    async function property(name, units, claims) {
      const p = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
        values($1,$1,$2,'bed') returning id`, [`${tag}-${name}`, org.id]);
      await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id, p.id]);
      const unitIds = {}, spaceIds = {};
      for (const [number, labels] of Object.entries(units)) {
        const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, number]);
        unitIds[number] = u.id;
        const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
        for (let i = 0; i < labels.length; i++) {
          const s = i === 0 ? await one("update spaces set space_label=$2 where id=$1 returning id", [placeholder.id, labels[i]])
            : await one("insert into spaces(unit_id,space_label) values($1,$2) returning id", [u.id, labels[i]]);
          spaceIds[`${number}|${labels[i]}`] = s.id;
        }
        await pool.query("update spaces set use_type='residential' where unit_id=$1", [u.id]);
      }
      const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
        values($1,'rent_roll_ledger',$2,$3,'bed','confirmed','committed') returning id`, [p.id, `${name}.csv`, AS_OF]);
      const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
        values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, p.id, AS_OF, batch.id, user.id]);
      let row = 0;
      for (const c of claims) {
        row += 1;
        const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
          values($1,$2,$3,'synthetic relay evidence',$4,$5) returning id`,
          [batch.id, row, JSON.stringify(c.json), unitIds[c.unit], c.space ? spaceIds[c.space] : null]);
        await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
          values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`,
          [act.id, p.id, c.key, JSON.stringify({ section: "current", ...c.json }), ev.id, String(user.id)]);
      }
      await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
        positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
        values($1,$2,$3,$4,$5,$6,0,$6,$7,'platform_role:super_admin','established') returning id`,
        [p.id, deal.id, act.id, batch.id, AS_OF, claims.length, user.id]);
      return { id: p.id, unitIds, spaceIds };
    }
    const reads = async (p) => ({
      dp: await datedPropertyPositions(pool, { property_id: p.id, as_of: AS_OF }),
      rr: await unitRentRoll(pool, { property_id: p.id, as_of: AS_OF }),
      ask: await readTenancyStanding(pool, { property_id: p.id, as_of: AS_OF }),
    });

    // ── 1. ZERO INVENTORY ──────────────────────────────────────────────
    const A = await property("zero-inventory", { "401": ["Room1"] },
      [{ key: "401|Room1", unit: "401", space: "401|Room1", json: { unit_number: "401", space_label: "Room1", is_vacant: true } }]);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await retirement.retireInventoryUnits(client, { property_id: A.id, unit_ids: [A.unitIds["401"]],
        rationale: "Synthetic proof: every unit of this property retired for superseded grain.",
        actor: { system: "qb_findings_relay_proof" } });
      await client.query("commit");
    } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
    const a = await reads(A);
    evidence.zero_inventory = { positions: a.dp.positions.length, helper: a.dp.opening_claims_unattached,
      rent_roll: a.rr.totals && a.rr.totals.confirmed_rows_not_attached, ask_unknowns: a.ask.unknowns, ask_list: a.ask.unattached_source_rows || null };
    ok("1: every position retired — the property has no current inventory", a.dp.positions.length === 0);
    ok("1: the helper still sees the retained claim", a.dp.opening_claims_unattached.promoted === 1);
    ok("1: the Rent Roll unit view carries it", a.rr.totals.confirmed_rows_not_attached === 1 && a.rr.unattached_source_rows.length === 1);
    ok("1: the standing read still says the property is NOT_ESTABLISHED with no inventory",
      a.ask.standing.truth_state === "NOT_ESTABLISHED" && a.ask.position === null);
    if (parent) {
      ok("1 (defect): Ask loses the retained claim — unknowns null, no source list",
        a.ask.unknowns === null && !a.ask.unattached_source_rows);
    } else {
      ok("1: Ask carries the retained claim beside the no-inventory truth",
        a.ask.unknowns && a.ask.unknowns.confirmed_source_rows_not_attached_to_a_position === 1
        && Array.isArray(a.ask.unattached_source_rows) && a.ask.unattached_source_rows[0].source_key === "401|Room1");
    }

    // ── 2. SELECTION IS NOT ATTACHMENT ─────────────────────────────────
    //  Two distinct keys, one claim, one position: "402" (unit-linked) and
    //  "402|Room1" (space-linked) both say vacant about the sole Room1.
    const B = await property("two-keys-one-claim", { "402": ["Room1"] }, [
      { key: "402", unit: "402", json: { unit_number: "402", is_vacant: true } },
      { key: "402|Room1", unit: "402", space: "402|Room1", json: { unit_number: "402", space_label: "Room1", is_vacant: true } },
    ]);
    const b = await reads(B);
    const pos = b.dp.positions[0];
    evidence.two_keys = { basis_type: pos.basis_type, selected_key: pos.basis_ref && pos.basis_ref.natural_key,
      helper: b.dp.opening_claims_unattached, supporting: (pos.basis_ref && pos.basis_ref.supporting_keys) || null };
    ok("2: the position is established vacant from one selected claim",
      pos.basis_type === "opening_claim_vacant" && pos.basis_ref.natural_key === "402|Room1");
    ok("2: no conflict — both claims agree", b.dp.positions.every((x) => x.evidence_state !== "unreconciled"));
    if (parent) {
      ok("2 (defect): the agreeing, unselected claim is counted as unattached",
        b.dp.opening_claims_unattached.promoted === 1 && b.rr.totals.confirmed_rows_not_attached === 1
        && b.ask.unknowns.confirmed_source_rows_not_attached_to_a_position === 1);
    } else {
      ok("2: a claim that matched the position is attached, selected or not — nothing unattached",
        b.dp.opening_claims_unattached.promoted === 0 && b.rr.totals.confirmed_rows_not_attached === 0
        && b.ask.unknowns.confirmed_source_rows_not_attached_to_a_position === 0);
      ok("2: the position names both keys that support it, the selected one first",
        JSON.stringify(pos.basis_ref.supporting_keys) === JSON.stringify(["402|Room1", "402"]));
    }

    // ── 3. TRUNCATION ──────────────────────────────────────────────────
    //  52 distinct named rooms the unit does not have: all unattached, all
    //  legitimate, more than the bound.
    const C = await property("fifty-two", { "403": ["Room1", "Room2"] },
      Array.from({ length: 52 }, (_, i) => ({ key: `403|Missing${i + 1}`, unit: "403",
        json: { unit_number: "403", space_label: `Missing${i + 1}`, is_vacant: true } })));
    const c = await reads(C);
    evidence.truncation = { helper: { promoted: c.dp.opening_claims_unattached.promoted, listed: c.dp.opening_claims_unattached.source_rows.length,
      truncated: c.dp.opening_claims_unattached.truncated, total: c.dp.opening_claims_unattached.total },
      rent_roll_flag: c.rr.unattached_source_rows_truncated, ask_flag: c.ask.unattached_source_rows_truncated };
    ok("3: the helper counts 52, lists 50, and says so", c.dp.opening_claims_unattached.promoted === 52
      && c.dp.opening_claims_unattached.source_rows.length === 50 && c.dp.opening_claims_unattached.truncated === true);
    if (parent) {
      ok("3 (defect): the Rent Roll and Ask relay 50 rows and no truncation flag",
        c.rr.unattached_source_rows.length === 50 && !("unattached_source_rows_truncated" in c.rr)
        && c.ask.unattached_source_rows.length === 50 && !("unattached_source_rows_truncated" in c.ask));
    } else {
      ok("3: the Rent Roll says the list is bounded and how many there are",
        c.rr.unattached_source_rows_truncated === true && c.rr.totals.confirmed_rows_not_attached === 52);
      ok("3: Ask says the same", c.ask.unattached_source_rows_truncated === true
        && c.ask.unknowns.confirmed_source_rows_not_attached_to_a_position === 52);
    }

    const changed = await one("select count(*)::int as n from proposed_records where property_id = any($1::uuid[]) and updated_at > confirmed_at + interval '1 second'", [[A.id, B.id, C.id]]);
    ok("no proposal row was rewritten by any read", changed.n === 0);
    if (process.env.PROOF_OUTPUT_DIR) {
      fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `qb-findings-relay-${parent ? "parent" : "successor"}.json`),
        JSON.stringify({ mode: parent ? "positive_defect_witness" : "successor", evidence }, null, 2));
    }
  } finally { await pool.end(); }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
