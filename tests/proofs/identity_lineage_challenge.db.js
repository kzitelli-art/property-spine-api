/* ════════════════════════════════════════════════════════════════════
   identity_lineage_challenge.db.js — THREE QUESTIONS ABOUT DURABLE
   IDENTITY, ANSWERED BY RUNNING THE WRITERS.

   1. LINEAGE SHAPES. What does the activation ingest actually write to
      import_source_rows for a bare unit row, on a sole bed, on a bed set,
      and on a by-unit property? Then: given a promoted row, can the
      reader tell a valid original sole-position confirmation from an old
      unit-level promotion that was ambiguous when it was made — without an
      inventory-history table and without creation time?
   2. REVERSAL + REPLACEMENT. A unit retired for superseded grain, renamed,
      replaced by a new unit with the same number, then the retirement is
      reversed. Does the null-lineage claim cross onto the replacement?
   3. NAMED OR LINKED PLACEHOLDER. A '(whole unit)' placeholder retained
      beside real beds, claimed by NAME or by durable link (not by bare
      key). Is the phantom offered?

   Observation proof: every assertion states current behaviour on the
   tree it runs against. Real writers where a writer exists (openActivation,
   ingestRentRoll, confirmProposal, retireInventoryUnits,
   reinstateInventoryUnit); direct inserts only to replay history the old
   writer produced. Caller-owned proof database, no production path.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const activation = require(path.join(root, "src/onboarding/activation_service.js"));
const artifacts = require(path.join(root, "src/onboarding/source_artifact_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
const retirement = require(path.join(root, "src/tenancy/inventory_retirement.js"));
const { datedPropertyPositions } = require(path.join(root, "src/tenancy/dated_positions.js"));
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));

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
  const all = async (sql, args = []) => (await pool.query(sql, args)).rows;
  try {
    const tag = `identity-challenge-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const person = await one("insert into persons(name) values('Synthetic Identity Operator') returning id");
    const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values('Synthetic Identity Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`, [`${tag}@example.test`, org.id, person.id]);

    //  A property through the real writers: deal, property, team seat,
    //  optional pre-existing inventory, then a rent roll ingested through
    //  openActivation + ingestRentRoll.
    async function ingested(name, basis, units, csv) {
      const deal = await deals.createDeal(pool, { user_id: user.id, deal_name: `${tag}-${name}`, creation_source: "deal_setup_console" });
      const p = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,$3) returning id", [`${tag}-${name}`, org.id, basis]);
      await deals.addProperty(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: p.id });
      await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof Manager','{management,leasing}',true)", [p.id, user.id]);
      const unitIds = {}, spaceIds = {};
      for (const [number, labels] of Object.entries(units)) {
        const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, number]);
        unitIds[number] = u.id;
        const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
        for (let i = 0; i < labels.length; i++) {
          const s = i === 0 && labels[i] !== "(whole unit)"
            ? await one("update spaces set space_label=$2 where id=$1 returning id", [placeholder.id, labels[i]])
            : (i === 0 ? placeholder : await one("insert into spaces(unit_id,space_label) values($1,$2) returning id", [u.id, labels[i]]));
          spaceIds[`${number}|${labels[i]}`] = s.id;
        }
      }
      const act = (await activation.openActivation(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: p.id })).activation;
      const artifact = await artifacts.store(pool, { scope_type: "property", scope_id: p.id, filename: `${name}.csv`, mimetype: "text/csv",
        buffer: Buffer.from(csv), uploaded_by_user_id: user.id, source_as_of_date: AS_OF });
      await activation.ingestRentRoll(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: p.id, activation_id: act.id,
        source_artifact_id: artifact.id, source_as_of_date: AS_OF });
      const proposals = (await activation.readActivation(pool, { user_id: user.id, activation_id: act.id })).proposals;
      const lineage = await all(`select r.row_index, r.produced_unit_id is not null as unit_linked, r.produced_space_id as space_id,
          (select space_label from spaces where id = r.produced_space_id) as space_label
         from import_source_rows r join import_batches b on b.id = r.import_batch_id
        where b.property_id = $1 order by r.row_index`, [p.id]);
      const spaces = await all("select u.unit_number, s.space_label, s.position_kind from spaces s join units u on u.id=s.unit_id where u.property_id=$1 order by 1,2", [p.id]);
      return { id: p.id, deal: deal.id, act: act.id, unitIds, spaceIds, proposals, lineage, spaces };
    }
    const positions = async (p) => (await datedPropertyPositions(pool, { property_id: p.id, as_of: AS_OF })).positions;
    const basisOf = (ps, unit, label) => { const x = ps.find((q) => q.unit_number === unit && q.space_label === label); return x ? { state: x.basis_state, type: x.basis_type, key: x.basis_ref && x.basis_ref.natural_key } : null; };

    // ── 1. WHAT INGEST WRITES ──────────────────────────────────────────
    const soleBed = await ingested("sole-bed", "bed", { "101": ["Room1"] }, "Unit,Resident,Market Rent\n101,VACANT,900\n");
    const bedSet = await ingested("bed-set", "bed", { "102": ["Room1", "Room2", "Room3"] }, "Unit,Resident,Market Rent\n102,VACANT,900\n");
    const byUnit = await ingested("by-unit", "unit", { "103": ["(whole unit)"] }, "Unit,Resident,Market Rent\n103,VACANT,900\n");
    evidence.ingest = { sole_bed: { lineage: soleBed.lineage, spaces: soleBed.spaces }, bed_set: { lineage: bedSet.lineage, spaces: bedSet.spaces }, by_unit: { lineage: byUnit.lineage, spaces: byUnit.spaces } };
    for (const [n, f] of [["sole bed", soleBed], ["bed set", bedSet], ["by unit", byUnit]]) console.log(`  ${n}: lineage=${JSON.stringify(f.lineage)} spaces=${JSON.stringify(f.spaces.map((s) => s.space_label))}`);
    ok("1: ingest links every bare row to its unit", [soleBed, bedSet, byUnit].every((f) => f.lineage[0].unit_linked));
    ok("1: ingest does not manufacture a position for a bare row on a bed set (still three beds)",
      bedSet.spaces.length === 3 && bedSet.spaces.every((s) => /^Room/.test(s.space_label)));
    ok("1: ingest does not manufacture a position for a bare row on a sole bed (still one)", soleBed.spaces.length === 1);
    const ingestSpace = { sole: soleBed.lineage[0].space_label, set: bedSet.lineage[0].space_label, unit: byUnit.lineage[0].space_label };
    console.log("  produced_space at ingest: " + JSON.stringify(ingestSpace));

    //  Confirm through the current writer where the writer allows it.
    const confirm = async (f) => { try { return { ok: await activation.confirmProposal(pool, { user_id: user.id, proposed_id: f.proposals[0].id }) }; } catch (e) { return { err: String(e.publicMessage || e.message || e) }; } };
    const cSole = await confirm(soleBed), cSet = await confirm(bedSet), cUnit = await confirm(byUnit);
    const after = async (f) => (await one(`select r.produced_space_id is not null as space_linked, (select space_label from spaces where id=r.produced_space_id) as label, pr.status
      from proposed_records pr join import_source_rows r on r.id = pr.import_source_row_id where pr.id=$1`, [f.proposals[0].id]));
    const aSole = await after(soleBed), aSet = await after(bedSet), aUnit = await after(byUnit);
    evidence.confirm = { sole: { result: cSole, lineage: aSole }, set: { result: cSet, lineage: aSet }, unit: { result: cUnit, lineage: aUnit } };
    ok("1: the current writer confirms the sole-bed bare row and links the bed", !cSole.err && aSole.space_linked && aSole.label === "Room1");
    ok("1: the current writer refuses the bed-set bare row as ambiguous and links nothing", /which bed/i.test(cSet.err || "") && !aSet.space_linked && aSet.status === "needs_review");
    ok("1: the current writer confirms the by-unit bare row and links the whole-unit position", !cUnit.err && aUnit.space_linked);

    //  THE QUESTION: replay the OLD writer on the bed set (promoted, space
    //  still null) and on a fresh sole bed (promoted, space null). Same
    //  lineage shape — present-null. Can the reader tell them apart?
    await activation.establishOpeningPosition(pool, { user_id: user.id, activation_id: soleBed.act });
    await pool.query("update proposed_records set status='promoted', confirmed_by=$2, confirmed_at=now() where id=$1", [bedSet.proposals[0].id, String(user.id)]);
    await activation.establishOpeningPosition(pool, { user_id: user.id, activation_id: bedSet.act });
    const oldSole = await ingested("old-sole", "bed", { "104": ["Room1"] }, "Unit,Resident,Market Rent\n104,VACANT,900\n");
    await pool.query("update proposed_records set status='promoted', confirmed_by=$2, confirmed_at=now() where id=$1", [oldSole.proposals[0].id, String(user.id)]);
    await activation.establishOpeningPosition(pool, { user_id: user.id, activation_id: oldSole.act });
    const shapes = {
      new_sole: basisOf(await positions(soleBed), "101", "Room1"),
      old_bed_set: (await positions(bedSet)).map((q) => q.basis_state),
      old_sole: basisOf(await positions(oldSole), "104", "Room1"),
      old_sole_lineage: await one("select r.produced_unit_id is not null as unit_linked, r.produced_space_id is null as space_null from proposed_records pr join import_source_rows r on r.id=pr.import_source_row_id where pr.id=$1", [oldSole.proposals[0].id]),
    };
    evidence.shapes = shapes;
    ok("1: a valid original sole-position confirmation (current writer) reads vacant", shapes.new_sole.type === "opening_claim_vacant");
    ok("1: an old unit-level promotion on a bed set reads not established on every bed", shapes.old_bed_set.every((s) => s === "not_established"));
    ok("1: an old unit-level promotion on a sole bed also reads vacant — by the sole-position ruling, from present-null lineage",
      shapes.old_sole.type === "opening_claim_vacant" && shapes.old_sole_lineage.unit_linked && shapes.old_sole_lineage.space_null);
    ok("1: therefore present-null lineage alone does NOT separate 'valid sole-position' from 'ambiguous at confirmation' — ingest links the unit and never the space for a bare row, on a sole bed and on a bed set alike",
      ingestSpace.sole === null && ingestSpace.set === null);

    // ── 2. REVERSAL + REPLACEMENT ──────────────────────────────────────
    const rev = await ingested("reversal", "bed", { "201": ["Room1"] }, "Unit,Resident,Market Rent\n201,VACANT,900\n");
    await pool.query("update proposed_records set status='promoted', confirmed_by=$2, confirmed_at=now() where id=$1", [rev.proposals[0].id, String(user.id)]);
    await activation.establishOpeningPosition(pool, { user_id: user.id, activation_id: rev.act });
    //  Null lineage at the space, as the old writer left it; then retire,
    //  rename, replace, and reverse through the real writers.
    const oldUnit = rev.unitIds["201"];
    const tx = async (fn) => { const c = await pool.connect(); try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
    await tx((c) => retirement.retireInventoryUnits(c, { property_id: rev.id, unit_ids: [oldUnit], rationale: "Synthetic proof: superseded inventory grain, replaced by a new unit.", actor: { user_id: user.id } }));
    await pool.query("update units set unit_number='201 (retired)' where id=$1", [oldUnit]);
    const replacement = await one("insert into units(property_id,unit_number) values($1,'201') returning id", [rev.id]);
    await pool.query("update spaces set use_type='residential' where unit_id in ($1,$2)", [oldUnit, replacement.id]);
    const beforeReversal = basisOf(await positions(rev), "201", "(whole unit)");
    ok("2: while the retirement stands, the replacement inherits nothing", beforeReversal && beforeReversal.state === "not_established");
    const reversal = await tx((c) => retirement.reinstateInventoryUnit(c, { unit_id: oldUnit, actor: { user_id: user.id }, reason: "Synthetic proof: reversal while a replacement carries the number." }));
    const afterReversal = await positions(rev);
    const onReplacement = basisOf(afterReversal, "201", "(whole unit)");
    const onReinstated = basisOf(afterReversal, "201 (retired)", "Room1");
    evidence.reversal = { reversal, before: beforeReversal, after_replacement: onReplacement, after_reinstated: onReinstated, live_units: afterReversal.map((q) => q.unit_number) };
    ok("2: the reversal is accepted with no check that live inventory already carries the original number", reversal.reinstated === true);
    ok("2 (unit-linked, observed): after reversal the claim follows its DURABLE unit — the reinstated one — and the replacement inherits nothing",
      onReinstated && onReinstated.type === "opening_claim_vacant" && onReplacement && onReplacement.state === "not_established", JSON.stringify({ onReplacement, onReinstated }));

    //  The same sequence with a NULL-lineage claim (no evidence row at all —
    //  the legacy shape the pending index still admits), replayed directly.
    const revNull = await ingested("reversal-null", "bed", { "202": ["Room1"] }, "Unit,Resident,Market Rent\n202,VACANT,900\n");
    await pool.query("update proposed_records set status='rejected' where id=$1", [revNull.proposals[0].id]);
    await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,confirmed_by,confirmed_at)
      values($1,$2,'leasing','lease','202',$3,'promoted',$4,now())`, [revNull.act, revNull.id, JSON.stringify({ section: "current", unit_number: "202", is_vacant: true }), String(user.id)]);
    await activation.establishOpeningPosition(pool, { user_id: user.id, activation_id: revNull.act });
    const oldNull = revNull.unitIds["202"];
    ok("2 (null lineage): before anything, the claim attaches to its sole bed by text", basisOf(await positions(revNull), "202", "Room1").type === "opening_claim_vacant");
    await tx((c) => retirement.retireInventoryUnits(c, { property_id: revNull.id, unit_ids: [oldNull], rationale: "Synthetic proof: superseded inventory grain, replaced by a new unit.", actor: { user_id: user.id } }));
    await pool.query("update units set unit_number='202 (retired)' where id=$1", [oldNull]);
    const replNull = await one("insert into units(property_id,unit_number) values($1,'202') returning id", [revNull.id]);
    await pool.query("update spaces set use_type='residential' where unit_id in ($1,$2)", [oldNull, replNull.id]);
    ok("2 (null lineage): while the retirement stands, the replacement inherits nothing", basisOf(await positions(revNull), "202", "(whole unit)").state === "not_established");
    await tx((c) => retirement.reinstateInventoryUnit(c, { unit_id: oldNull, actor: { user_id: user.id }, reason: "Synthetic proof: reversal while a replacement carries the number." }));
    const nullAfter = await positions(revNull);
    const nullRepl = basisOf(nullAfter, "202", "(whole unit)"), nullReinst = basisOf(nullAfter, "202 (retired)", "Room1");
    evidence.reversal_null_lineage = { after_replacement: nullRepl, after_reinstated: nullReinst };
    ok("2 (null lineage, observed): after reversal the text-only claim crosses onto the REPLACEMENT, and the reinstated unit it was confirmed against gets nothing",
      nullRepl && nullRepl.type === "opening_claim_vacant" && nullReinst && nullReinst.state === "not_established", JSON.stringify({ nullRepl, nullReinst }));

    // ── 3. NAMED OR LINKED PLACEHOLDER BESIDE BEDS ─────────────────────
    const ph = await ingested("placeholder", "bed", { "301": ["(whole unit)", "Room1", "Room2", "Room3"], "302": ["(whole unit)", "Room1", "Room2"] },
      "Unit,Room,Resident,Market Rent\n301,(whole unit),VACANT,900\n302,Room1,Synthetic Resident,900\n");
    //  301: a NAMED '(whole unit)' claim, replayed as an old promotion (null space);
    //  302: a claim LINKED by produced_space_id to the placeholder.
    await pool.query("update proposed_records set status='promoted', confirmed_by=$2, confirmed_at=now() where id=$1", [ph.proposals.find((q) => q.natural_key === "301|(whole unit)").id, String(user.id)]);
    const linked = ph.proposals.find((q) => q.natural_key === "302|Room1");
    await pool.query("update import_source_rows set produced_space_id=$2 where id=$1", [linked.import_source_row_id, ph.spaceIds["302|(whole unit)"]]);
    await pool.query("update proposed_records set status='promoted', natural_key='302', normalized_json = normalized_json - 'space_label' || '{\"is_vacant\":true}'::jsonb, confirmed_by=$2, confirmed_at=now() where id=$1", [linked.id, String(user.id)]);
    await activation.establishOpeningPosition(pool, { user_id: user.id, activation_id: ph.act });
    await pool.query("update spaces set use_type='residential' where unit_id in (select id from units where property_id=$1)", [ph.id]);
    const phPositions = await positions(ph);
    const av = await availabilityRead(pool, { property_id: ph.id, as_of: AS_OF });
    const phantom = (u) => av.rows.find((r) => r.unit_number === u && /whole\s*unit/i.test(r.space_label));
    evidence.placeholder = { positions: phPositions.length, named: basisOf(phPositions, "301", "(whole unit)"), linked: basisOf(phPositions, "302", "(whole unit)"),
      marketing: { "301": phantom("301").marketing_state, "302": phantom("302").marketing_state }, headline: av.headline.marketable_now };
    ok("3: seven positions for five real beds — both placeholders are counted", phPositions.length === 7);
    ok("3 (observed): a NAMED '(whole unit)' claim attaches to the placeholder beside three beds", evidence.placeholder.named.type === "opening_claim_vacant");
    ok("3 (observed): a claim LINKED to the placeholder by produced_space_id attaches to it", evidence.placeholder.linked.type === "opening_claim_vacant");
    ok("3 (observed): both phantoms are offered as marketable_now — the bare-key refusal does not cover name or link",
      phantom("301").marketing_state === "marketable_now" && phantom("302").marketing_state === "marketable_now");

    if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, "identity-lineage-challenge.json"), JSON.stringify({ mode: "observation", evidence }, null, 2));
  } finally { await pool.end(); }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
