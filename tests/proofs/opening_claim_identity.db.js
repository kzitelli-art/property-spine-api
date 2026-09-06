/* ════════════════════════════════════════════════════════════════════
   opening_claim_identity.db.js — A HISTORICAL CLAIM NEVER ACQUIRES A NEW
   IDENTITY.

   The canonical space reader (space_position.js) answers "what did the
   opening position say about THIS bed" by matching a proposal's natural
   key — unit number text, or unit|room text — against today's inventory,
   and a bare unit key against any unit that holds exactly one space today.
   Text and a current count are not identity. Confirmation writes durable
   lineage (import_source_rows.produced_unit_id / produced_space_id); the
   reader must prefer it, and must not let a claim made against inventory
   that was later retired re-attach to the unit that replaced it.

   TWO MODES.  PROOF_EXPECT_DEFECT=1 asserts the observed drift on the
   unrepaired reader; the default asserts the successor. Each case is its
   own synthetic property in the caller-owned proof database. Nothing here
   is a confirmation path; history is replayed by direct insert.
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
const retirement = require(path.join(root, "src/tenancy/inventory_retirement.js"));

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
  console.log(`IDENTITY_PROOF_MODE=${parent ? "positive_parent_defect" : "successor"}`);
  try {
    const tag = `claim-identity-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const user = await one(`insert into users(name,email,is_active,status,platform_role,organization_id)
      values('Synthetic Identity Operator',$1,true,'active','super_admin',$2) returning id`,
      [`${tag}@example.invalid`, org.id]);
    const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`, [tag, org.id]);

    /*  One synthetic property per case, established from one baseline.
     *  `claims` = [{ key, json, unit, space, linked }]: `linked` writes an
     *  import_source_rows row with produced_unit_id/produced_space_id (the
     *  lineage confirmation writes); null-lineage claims carry no evidence
     *  row at all, which is the legacy shape the pending index still admits. */
    async function property(name, units, claims, opts = {}) {
      const p = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
        values($1,$1,$2,$3) returning id`, [`${tag}-${name}`, org.id, opts.basis || "bed"]);
      await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id, p.id]);
      const unitIds = {}, spaceIds = {};
      for (const [number, labels] of Object.entries(units)) {
        const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, number]);
        unitIds[number] = u.id;
        const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
        for (let i = 0; i < labels.length; i++) {
          const label = labels[i];
          const s = i === 0 && placeholder
            ? await one("update spaces set space_label=$2 where id=$1 returning id", [placeholder.id, label])
            : await one("insert into spaces(unit_id,space_label) values($1,$2) returning id", [u.id, label]);
          spaceIds[`${number}|${label}`] = s.id;
        }
        //  A governed use type, so availability can classify rather than
        //  stop at use_not_configured. Grain is left to the label: the
        //  reader derives it exactly as dated_positions does.
        await pool.query("update spaces set use_type='residential' where unit_id=$1", [u.id]);
      }
      const batch = await one(`insert into import_batches
        (property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
        values($1,'rent_roll_ledger',$2,$3,$4,'confirmed','committed') returning id`,
        [p.id, `${name}.csv`, opts.as_of || AS_OF, opts.basis || "bed"]);
      const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
        values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, p.id, opts.as_of || AS_OF, batch.id, user.id]);
      let row = 0;
      const proposalIds = [];
      for (const c of claims) {
        let evidenceId = null;
        if (c.linked) {
          row += 1;
          evidenceId = (await one(`insert into import_source_rows
            (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
            values($1,$2,$3,'synthetic identity evidence',$4,$5) returning id`,
            [batch.id, row, JSON.stringify(c.json), c.unit ? unitIds[c.unit] : null, c.space ? spaceIds[c.space] : null])).id;
        }
        const pr = await one(`insert into proposed_records
          (activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
          values($1,$2,'leasing','lease',$3,$4,$5,$6,$7,now()) returning id`,
          [act.id, p.id, c.key, JSON.stringify({ section: "current", ...c.json }), c.status || "promoted", evidenceId, String(user.id)]);
        proposalIds.push(pr.id);
      }
      await one(`insert into opening_tenancy_positions
        (property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
         positions_established,positions_unresolved,source_rows_read,
         established_by_user_id,authority_basis,status)
        values($1,$2,$3,$4,$5,$6,0,$6,$7,'platform_role:super_admin','established') returning id`,
        [p.id, deal.id, act.id, batch.id, opts.as_of || AS_OF, claims.length, user.id]);
      return { id: p.id, unitIds, spaceIds, proposalIds, activation: act.id, batch: batch.id };
    }
    const positionsOf = async (p, as_of = AS_OF) => (await datedPropertyPositions(pool, { property_id: p.id, as_of })).positions;
    const basisOf = (positions, label) => {
      const pos = positions.find((x) => x.space_label === label);
      return pos ? { state: pos.basis_state, type: pos.basis_type, claim: pos.occupancy_claim || null,
        proposal: pos.basis_ref && pos.basis_ref.proposal_id || null } : null;
    };
    async function retireAndReplace(p, number) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await retirement.retireInventoryUnits(client, {
          property_id: p.id, unit_ids: [p.unitIds[number]],
          rationale: "Synthetic proof: the source modelled this unit under an obsolete inventory interpretation.",
          actor: { system: "opening_claim_identity_proof" },
        });
        await client.query("commit");
      } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
      //  uq_unit_per_property forbids two live rows with one number, so a
      //  replacement with the same number requires the retired row to be
      //  renamed first — the retirement row keeps original_unit_number. The
      //  canonical loader already excludes the retired unit at every as_of;
      //  the rename only satisfies the constraint.
      await pool.query("update units set unit_number = unit_number || ' (retired)' where id=$1", [p.unitIds[number]]);
      const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, number]);
      await pool.query("update spaces set use_type='residential' where unit_id=$1", [u.id]);
      return u.id;
    }

    // ── A. REPLACED UNIT, SAME NUMBER, NULL LINEAGE ─────────────────────
    //  A bare-unit vacancy confirmed under the old writer against unit 101
    //  (one space). The unit is retired for superseded grain and a new 101
    //  is created. The claim was about inventory that is now history.
    const A = await property("replaced-null", { "101": ["(whole unit)"] },
      [{ key: "101", json: { unit_number: "101", is_vacant: true }, linked: false }], { basis: "unit" });
    ok("A: before replacement the whole-unit claim answers for its one position",
      basisOf(await positionsOf(A), "(whole unit)").type === "opening_claim_vacant");
    await retireAndReplace(A, "101");
    const aAfter = basisOf(await positionsOf(A), "(whole unit)");
    evidence.push({ case: "A_replaced_unit_null_lineage", after: aAfter });
    if (parent) {
      ok("A (defect): the claim re-attaches to the replacement unit by unit-number text",
        aAfter && aAfter.type === "opening_claim_vacant", JSON.stringify(aAfter));
    } else {
      ok("A: the replacement unit inherits no claim from the retired one",
        aAfter && aAfter.state === "not_established" && !aAfter.proposal, JSON.stringify(aAfter));
    }

    // ── B. REPLACED UNIT, SAME NUMBER, LINKED LINEAGE ──────────────────
    //  Same shape, but the confirmation carried produced_unit_id and
    //  produced_space_id for the OLD unit's space.
    const B = await property("replaced-linked", { "101": ["(whole unit)"] },
      [{ key: "101", json: { unit_number: "101", is_vacant: true }, linked: true, unit: "101", space: "101|(whole unit)" }], { basis: "unit" });
    ok("B: before replacement the linked claim answers for its position",
      basisOf(await positionsOf(B), "(whole unit)").type === "opening_claim_vacant");
    await retireAndReplace(B, "101");
    const bAfter = basisOf(await positionsOf(B), "(whole unit)");
    evidence.push({ case: "B_replaced_unit_linked_lineage", after: bAfter });
    if (parent) {
      ok("B (defect): durable lineage is ignored; the claim follows the unit number",
        bAfter && bAfter.type === "opening_claim_vacant", JSON.stringify(bAfter));
    } else {
      ok("B: lineage names a retired space, so the replacement inherits nothing",
        bAfter && bAfter.state === "not_established" && !bAfter.proposal, JSON.stringify(bAfter));
    }

    // ── C. CHANGED ROOM LABEL — linked survives, null-lineage stays unknown ──
    const C = await property("relabel", { "102": ["Room1", "Room2"] }, [
      { key: "102|Room1", json: { unit_number: "102", space_label: "Room1", is_vacant: true }, linked: true, unit: "102", space: "102|Room1" },
      { key: "102|Room2", json: { unit_number: "102", space_label: "Room2", is_vacant: true }, linked: false },
    ]);
    const cBefore = await positionsOf(C);
    ok("C: both named claims answer before the relabel",
      basisOf(cBefore, "Room1").type === "opening_claim_vacant" && basisOf(cBefore, "Room2").type === "opening_claim_vacant");
    await pool.query("update spaces set space_label='Bed A' where id=$1", [C.spaceIds["102|Room1"]]);
    await pool.query("update spaces set space_label='Bed B' where id=$1", [C.spaceIds["102|Room2"]]);
    const cAfter = await positionsOf(C);
    const cLinked = basisOf(cAfter, "Bed A"), cNull = basisOf(cAfter, "Bed B");
    evidence.push({ case: "C_relabel", linked: cLinked, null_lineage: cNull });
    if (parent) {
      ok("C (defect): a linked claim is lost the moment its room is relabelled",
        cLinked && cLinked.state === "not_established", JSON.stringify(cLinked));
    } else {
      ok("C: the linked claim follows its durable space through a relabel",
        cLinked && cLinked.type === "opening_claim_vacant" && cLinked.proposal === C.proposalIds[0], JSON.stringify(cLinked));
    }
    ok("C: a null-lineage named claim stays unknown after a relabel — labels are not identity",
      cNull && cNull.state === "not_established" && !cNull.proposal, JSON.stringify(cNull));

    // ── D. MULTI-ROOM BECOMING SINGLE-ROOM ─────────────────────────────
    //  A bare-unit vacancy promoted under the old writer against a 3-bed
    //  unit (no space attached, lineage at the unit only). No product
    //  writer deletes a space — retirement is unit-level and only
    //  seed_snapshot deletes spaces — so the shrink is synthetic here.
    //
    //  RECORDED, NOT A DEFECT THE READER CAN SEE. canonical_onboarding_ledger
    //  froze the ruling that a unit-key current claim answers for a unit's
    //  sole position whatever its label. Without an inventory history a
    //  unit that shrank to one bed is indistinguishable from a unit that
    //  always had one, and the reader does not use creation timestamps as
    //  history. So the claim attaches after the shrink in both modes; the
    //  identity anchor is still the durable unit (rule 2), never the number.
    const D = await property("shrink", { "103": ["Room1", "Room2", "Room3"] },
      [{ key: "103", json: { unit_number: "103", is_vacant: true }, linked: true, unit: "103", space: null }]);
    const dBefore = await positionsOf(D);
    ok("D: a bare-unit claim on a 3-bed unit answers for no bed",
      ["Room1", "Room2", "Room3"].every((l) => basisOf(dBefore, l).state === "not_established"));
    await pool.query("delete from spaces where id = any($1::uuid[])", [[D.spaceIds["103|Room2"], D.spaceIds["103|Room3"]]]);
    const dAfter = basisOf(await positionsOf(D), "Room1");
    evidence.push({ case: "D_shrink_to_single_bed", after: dAfter });
    ok("D (both modes, recorded): once the unit holds one position the bare-unit claim answers for it — the sole-position ruling, not identity drift",
      dAfter && dAfter.type === "opening_claim_vacant", JSON.stringify(dAfter));

    // ── E. VALID SINGLE-POSITION CONFIRMATIONS KEEP ANSWERING ───────────
    //  A whole-unit position (by-unit property) with a linked bare-unit
    //  claim; a whole-unit position with a legacy null-lineage bare-unit
    //  claim and no retirement history; and a by-bed unit whose ONE bed was
    //  confirmed by bed. All three are legitimate and must still resolve.
    const E = await property("valid", { "104": ["(whole unit)"], "105": ["(whole unit)"], "106": ["Room1"] }, [
      { key: "104", json: { unit_number: "104", is_vacant: true }, linked: true, unit: "104", space: "104|(whole unit)" },
      { key: "105", json: { unit_number: "105", is_vacant: true }, linked: false },
      { key: "106|Room1", json: { unit_number: "106", space_label: "Room1", is_vacant: true }, linked: true, unit: "106", space: "106|Room1" },
    ]);
    const e = await positionsOf(E);
    const eBy = (n, l) => e.find((x) => x.unit_number === n && x.space_label === l);
    ok("E: linked whole-unit claim resolves", eBy("104", "(whole unit)").basis_type === "opening_claim_vacant");
    ok("E: legacy null-lineage whole-unit claim resolves when no retired unit ever carried the number",
      eBy("105", "(whole unit)").basis_type === "opening_claim_vacant");
    ok("E: a bed confirmed by bed resolves", eBy("106", "Room1").basis_type === "opening_claim_vacant");
    evidence.push({ case: "E_valid_confirmations", basis: [eBy("104", "(whole unit)").basis_type, eBy("105", "(whole unit)").basis_type, eBy("106", "Room1").basis_type] });

    // ── F. TEMPORAL BASELINE SELECTION AND LEASE PRIORITY ──────────────
    //  Two baselines on one property: June says 107 vacant, July says 107
    //  occupied. A read dated between them answers from June; after July,
    //  from July. An operative lease outranks either claim.
    const F = await property("temporal", { "107": ["(whole unit)"], "108": ["(whole unit)"] },
      [{ key: "107", json: { unit_number: "107", is_vacant: true }, linked: true, unit: "107", space: "107|(whole unit)" },
       { key: "108", json: { unit_number: "108", is_vacant: true }, linked: true, unit: "108", space: "108|(whole unit)" }],
      { basis: "unit", as_of: "2026-06-30" });
    {
      const batch2 = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
        values($1,'rent_roll_ledger','july.csv','2026-07-31','unit','confirmed','committed') returning id`, [F.id]);
      const act2 = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
        values($1,$2,'activated','2026-07-31',$3,$4) returning id`, [deal.id, F.id, batch2.id, user.id]);
      const ev2 = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,1,'{}','synthetic',$2,$3) returning id`, [batch2.id, F.unitIds["107"], F.spaceIds["107|(whole unit)"]]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease','107',$3,'promoted',$4,$5,now())`,
        [act2.id, F.id, JSON.stringify({ section: "current", unit_number: "107", tenant_name: "Synthetic July Resident", actual_rent: 900 }), ev2.id, String(user.id)]);
      //  The same order establishOpeningPosition uses, in one transaction:
      //  supersede the prior baseline, insert the successor, then let the
      //  prior name it. Migration 159's deferred trigger validates both rows
      //  at commit and its unique index admits one current baseline.
      const tx = await pool.connect();
      try {
        await tx.query("begin");
        const prior = (await tx.query("select id from opening_tenancy_positions where property_id=$1 and status='established'", [F.id])).rows[0];
        await tx.query("update opening_tenancy_positions set status='superseded', superseded_at=now() where id=$1", [prior.id]);
        const july = (await tx.query(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
          positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
          values($1,$2,$3,$4,'2026-07-31',1,0,1,$5,'platform_role:super_admin','established') returning id`, [F.id, deal.id, act2.id, batch2.id, user.id])).rows[0];
        await tx.query("update opening_tenancy_positions set superseded_by_id=$2 where id=$1", [prior.id, july.id]);
        await tx.query("commit");
      } catch (e) { await tx.query("rollback"); throw e; } finally { tx.release(); }
      await pool.query(`insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status)
        values($1,$2,'{}',850,'2026-01-01','2027-12-31','active')`, [F.id, F.spaceIds["108|(whole unit)"]]);
    }
    const fJune = await positionsOf(F, "2026-07-15");
    const fJuly = await positionsOf(F, "2026-08-01");
    const f107 = (ps) => ps.find((x) => x.unit_number === "107").basis_type;
    const f108 = (ps) => ps.find((x) => x.unit_number === "108").basis_type;
    ok("F: a read between baselines answers from the June baseline (vacant)", f107(fJune) === "opening_claim_vacant", f107(fJune));
    ok("F: a read after July answers from the July baseline (occupied)", f107(fJuly) === "opening_claim_occupied", f107(fJuly));
    ok("F: an operative lease outranks the opening claim at every date",
      f108(fJune) === "operative_lease" && f108(fJuly) === "operative_lease");
    evidence.push({ case: "F_temporal_and_lease", june: f107(fJune), july: f107(fJuly), leased: f108(fJuly) });

    // ── DOWNSTREAM AGREEMENT on the replaced-unit case ──────────────────
    //  Rent Roll unit view, canonical availability and Ask Spine standing
    //  read the same basis, so they must say the same thing about B.
    const rr = await unitRentRoll(pool, { property_id: B.id, as_of: AS_OF });
    const av = await availabilityRead(pool, { property_id: B.id, as_of: AS_OF });
    const ask = await readTenancyStanding(pool, { property_id: B.id, as_of: AS_OF });
    const agree = {
      rent_roll: { not_established: rr.totals.not_established, open: rr.totals.open },
      availability: { marketable_now: av.headline.marketable_now, occupancy_unknown: av.states.occupancy_unknown ?? null },
      ask: { not_established: ask.position.not_established, open: ask.position.open },
    };
    evidence.push({ case: "B_downstream_agreement", ...agree });
    if (parent) {
      ok("B (defect, downstream): all three readers offer the replacement unit on the retired unit's claim",
        rr.totals.open === 1 && av.headline.marketable_now === 1 && ask.position.open === 1, JSON.stringify(agree));
    } else {
      ok("B (downstream): Rent Roll, availability and Ask Spine agree the replacement unit is not established",
        rr.totals.not_established === 1 && rr.totals.open === 0
        && av.headline.marketable_now === 0 && av.states.occupancy_unknown === 1
        && ask.position.not_established === 1 && ask.position.open === 0, JSON.stringify(agree));
    }

    // ── HISTORY UNTOUCHED ──────────────────────────────────────────────
    const changed = await one(`select count(*)::int as n from proposed_records where property_id = any($1::uuid[]) and updated_at > confirmed_at + interval '1 second'`,
      [[A.id, B.id, C.id, D.id, E.id, F.id]]);
    ok("no proposal row was rewritten by any read", changed.n === 0, String(changed.n));

    if (process.env.PROOF_OUTPUT_DIR) {
      fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `opening-claim-identity-${parent ? "parent" : "successor"}.json`),
        JSON.stringify({ mode: parent ? "positive_defect_witness" : "successor", evidence }, null, 2));
    }
  } finally {
    await pool.end();
  }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
