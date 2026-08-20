#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  apply_unit_type_mapping.js — THE REVIEWED CLASSIFICATION RECEIPT
//
//  Populates the durable classification created by migration 100 from an
//  OWNER-APPROVED mapping, never from a runtime string pattern.
//
//    source code  → governed property_unit_types row
//    position     → unit_type_id, via the DURABLE source-row relationship
//                   (import_source_rows.produced_space_id), never a
//                   unit_number string match
//
//  WHY A TOOL AND NOT A MIGRATION: a migration would bake one property's
//  vocabulary into schema history and would run unreviewed on every deploy.
//  Classification is DATA with provenance, approved per property, and every
//  row it writes records who approved it, when, and from what source code.
//
//  RULINGS ENCODED HERE (2026-07-27):
//   · The eight residential floorplan codes → use_type 'residential'.
//     'comm' → 'commercial'.
//   · DOWN IS NOT A USE. A down position keeps its residential use_type;
//     being out of service is a physical/availability condition, not a
//     durable purpose, and collapsing them would make a temporary state
//     permanent.
//   · THE MODEL UNIT IS NOT AUTO-CLASSIFIED non_revenue from its status
//     string. It follows its floorplan code and is REPORTED as an
//     unresolved operating-designation question.
//   · A position with no deterministic source code stays NULL —
//     'Not configured' — rather than being inferred from bedrooms or sqft.
//   · Occupancy denominators are NOT changed here. Commercial, model and
//     down exclusions need explicit explainable rules, decided separately.
//
//  IDEMPOTENT. Safe to re-run: types are upserted by (property_id, code)
//  and assignments are skipped when already correct.
//
//  Usage:
//    DATABASE_URL=... node tools/apply_unit_type_mapping.js --property <uuid>            (dry run)
//    DATABASE_URL=... node tools/apply_unit_type_mapping.js --property <uuid> --apply
// ════════════════════════════════════════════════════════════════════

"use strict";
const { Client } = require("pg");

//  ── RULINGS, ONE BLOCK PER PROPERTY VOCABULARY ───────────────────────
//  This was a single module-level MAPPING for one property's floorplan
//  codes. A second property with a different vocabulary could not be
//  classified at all — the tool refused every code as unapproved, which
//  was the right refusal and the wrong dead end.
//
//  The mapping IS the ruling record, so a second property gets a second
//  ruling block with its own receipt and date, and neither can silently
//  become the other. Selection is by COVERAGE, not by a flag: the tool
//  picks the one ruling whose codes cover every code the property's source
//  actually carries, refuses when none does (naming the unmapped codes, as
//  before), and refuses when more than one does rather than guessing.
const RULINGS = [
  {
    receipt: "reviewed_mapping_receipt_2026-07-27",
    note: "Eight residential floorplan codes plus commercial. See header.",
    //  This property's source codes ARE its canonical codes — that is how it
    //  was approved and nothing here changes it. source_code is stated
    //  explicitly so the two roles are visible even where they coincide.
    codes: [
      { source_code: "S.1UN_02", code: "S.1UN_02", label: "Studio",            sort: 10, use: "residential" },
      { source_code: "S.1FN_02", code: "S.1FN_02", label: "Furnished Studio",  sort: 20, use: "residential" },
      { source_code: "1.1UN_02", code: "1.1UN_02", label: "1 Bed",             sort: 30, use: "residential" },
      { source_code: "1.1FN_02", code: "1.1FN_02", label: "Furnished 1 Bed",   sort: 40, use: "residential" },
      { source_code: "1.1DN_02", code: "1.1DN_02", label: "1 Bed + Den",       sort: 50, use: "residential" },
      { source_code: "2.2UN_02", code: "2.2UN_02", label: "2 Bed / 2 Bath",    sort: 60, use: "residential" },
      { source_code: "3.2UN_02", code: "3.2UN_02", label: "3 Bed / 2 Bath",    sort: 70, use: "residential" },
      { source_code: "3.3UN_02", code: "3.3UN_02", label: "3 Bed / 3 Bath",    sort: 80, use: "residential" },
      { code: "comm",     label: "Commercial Space",  sort: 90, use: "commercial"  },
    ],
  },
  {
    //  ⚠ BASIS: OWNER STATEMENT. SOURCE CORROBORATION WAS RUN AND FAILED.
    //
    //  What the committed source DOES establish, and it is not nothing:
    //    · the room grain — STU00016 carries Room1/Room2, STU00015 and
    //      STU00017 carry Room1/Room2/Room3 — which is why the bed counts
    //      reconcile to 112 / 36 / 12 exactly;
    //    · is_commercial = false on every row, supporting `residential`;
    //    · the April rent roll agrees, but only by repeating the SAME code.
    //
    //  What it does NOT establish, checked rather than assumed:
    //    · units.bedrooms and units.bathrooms are NULL for all 72 units;
    //    · square footage is null/0 throughout;
    //    · the rent roll's column is literally "Unit/Room Type" and carries
    //      the bare code with no expansion, legend or lookup anywhere;
    //    · nothing separates STU00015 from STU00017. Both are three-room,
    //      both non-commercial, both carrying market_rent 875 in sample rows.
    //
    //  So "1 Bath" vs "1.5 Bath" is the OWNER'S KNOWLEDGE, recorded as such.
    //  It is not a derivation, and this file must not let a later reader
    //  mistake it for one. If the distinction ever needs to be defended from
    //  evidence, the evidence is not in the rent roll.
    receipt: "skyline_owner_statement_2026-08-20_source_silent_on_bath_distinction",
    note: "Skyline (1417 N 15th), bed-grained. Room grain corroborated by source; bath distinction is owner knowledge, not in the source.",
    //  ── OUR VOCABULARY, NOT THE VENDOR'S ──────────────────────────
    //  STU00015/16/17 are Yardi's "Unit/Room Type" strings. They are how the
    //  SOURCE names a floorplan; they are not how Spine should. A canonical
    //  identity inherited from an export is a vendor's opaque handle sitting
    //  in the middle of our own vocabulary, and it becomes load-bearing the
    //  moment anything reads or displays it.
    //
    //  So the two roles are separated: source_code is matched against
    //  raw->>'unit_type' and is recorded as provenance in source_note; code
    //  is ours and is what the rest of the system carries. Nothing is lost —
    //  the line back to RentRoll07_1417.xlsx is explicit rather than implied
    //  by a shared string.
    //
    //  SKYLINE IS PRICED PER BED, ALWAYS. 72 units are an inventory fact;
    //  160 rentable positions are the economic unit, and no surface should
    //  imply a per-unit price for this property.
    codes: [
      { source_code: "STU00016", code: "2BR",       label: "2 Bedroom",            sort: 10, use: "residential" },
      { source_code: "STU00015", code: "3BR-1BA",   label: "3 Bedroom / 1 Bath",   sort: 20, use: "residential" },
      { source_code: "STU00017", code: "3BR-1.5BA", label: "3 Bedroom / 1.5 Bath", sort: 30, use: "residential" },
    ],
  },
];

//  Chosen per run, below. Declared here so the rest of the file reads the
//  same as it always did.
let MAPPING = null;
let RECEIPT = null;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

(async () => {
  const propertyId = arg("--property");
  const apply = process.argv.includes("--apply");
  const actor = arg("--actor") || null;   // optional users.id for attribution
  if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL."); process.exit(2); }
  if (!propertyId) { console.error("Set --property <uuid>."); process.exit(2); }

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log(`\n${apply ? "APPLYING" : "DRY RUN"}`);
  console.log(`property ${propertyId}\n`);

  // ── what the source deterministically says, via the durable relationship ──
  const src = (await c.query(
    `select r.raw->>'unit_type' as code, s.id as space_id, u.id as unit_id, u.unit_number
       from import_source_rows r
       join import_batches b on b.id = r.import_batch_id
       join spaces s on s.id = r.produced_space_id
       join units  u on u.id = s.unit_id
      where b.property_id = $1 and r.raw->>'unit_type' is not null
      group by 1,2,3,4`, [propertyId]
  )).rows;

  const byCode = new Map();
  for (const r of src) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }

  //  ── SELECT THE RULING BY COVERAGE, NEVER BY GUESS ────────────────
  const present = [...byCode.keys()];
  if (!present.length) {
    console.error("REFUSING: no source row carries a 'unit_type' code for this property.");
    await c.end(); process.exit(1);
  }
  const covering = RULINGS.filter((r) => present.every((k) => r.codes.some((m) => m.source_code === k)));
  if (covering.length === 0) {
    const near = RULINGS.map((r) => `${r.receipt}: missing ${present.filter((k) => !r.codes.some((m) => m.source_code === k)).join(", ")}`);
    console.error("REFUSING: no approved ruling covers this property's source codes.");
    console.error("  present: " + present.join(", "));
    near.forEach((n) => console.error("  " + n));
    await c.end(); process.exit(1);
  }
  if (covering.length > 1) {
    console.error("REFUSING: more than one ruling covers these codes — ambiguous, and this tool does not guess.");
    covering.forEach((r) => console.error("  " + r.receipt));
    await c.end(); process.exit(1);
  }
  MAPPING = covering[0].codes;
  RECEIPT = covering[0].receipt;
  console.log(`ruling: ${RECEIPT}`);
  console.log(`        ${covering[0].note}\n`);

  // A position claimed by two different codes is a conflict, not a mapping.
  const bySpace = new Map();
  for (const r of src) {
    if (!bySpace.has(r.space_id)) bySpace.set(r.space_id, new Set());
    bySpace.get(r.space_id).add(r.code);
  }
  const conflicted = [...bySpace.entries()].filter(([, codes]) => codes.size > 1);
  if (conflicted.length) {
    console.error(`REFUSING: ${conflicted.length} position(s) carry more than one source code.`);
    await c.end(); process.exit(1);
  }

  const allSpaces = (await c.query(
    `select s.id, u.unit_number, u.bedrooms from spaces s join units u on u.id=s.unit_id where u.property_id=$1`,
    [propertyId])).rows;
  const unmapped = allSpaces.filter((s) => !bySpace.has(s.id));

  for (const m of MAPPING) {
    const rows = byCode.get(m.source_code) || [];
    console.log(`  source ${m.source_code.padEnd(10)} → ${m.code.padEnd(10)} ${m.label.padEnd(22)} ${String(rows.length).padStart(3)} positions   use_type=${m.use}`);
  }
  console.log(`\n  positions with a deterministic code : ${bySpace.size}`);
  console.log(`  positions left "Not configured"      : ${unmapped.length}`
    + (unmapped.length ? "  → " + unmapped.map((u) => `${u.unit_number} (${u.bedrooms} bed)`).join(", ") : ""));

  // The model unit: reported, never auto-classified from its status string.
  const model = (await c.query(
    `select distinct u.unit_number
       from import_source_rows r join import_batches b on b.id=r.import_batch_id
       join spaces s on s.id=r.produced_space_id join units u on u.id=s.unit_id
      where b.property_id=$1 and lower(r.raw->>'status')='model'`, [propertyId])).rows;
  if (model.length) {
    console.log(`\n  UNRESOLVED OPERATING DESIGNATION: unit(s) ${model.map((m) => m.unit_number).join(", ")} are`);
    console.log( "  marked 'model' in the opening source. They follow their floorplan use_type here;");
    console.log( "  whether a model unit is a durable non-revenue use is an open question and is NOT");
    console.log( "  decided from the status string.");
  }

  if (!apply) { console.log("\nDry run only. Re-run with --apply to write.\n"); await c.end(); return; }

  await c.query("begin");
  try {
    const typeIdByCode = new Map();
    for (const m of MAPPING) {
      const r = await c.query(
        `insert into property_unit_types (property_id, code, label, sort_order, source_note, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (property_id, code) do update
           set label = excluded.label, sort_order = excluded.sort_order,
               source_note = excluded.source_note, updated_at = now()
         returning id`,
        [propertyId, m.code, m.label, m.sort,
         //  PROVENANCE, EXPLICIT. The vendor's string lives here, where it is
         //  a recorded origin, rather than in `code`, where it would be our
         //  identity for a thing we did not name.
         `${RECEIPT}: source code ${m.source_code}`, actor]);
      //  keyed by SOURCE code — that is what the rows carry.
      typeIdByCode.set(m.source_code, r.rows[0].id);
    }

    let assigned = 0, kinded = 0, used = 0;
    for (const [code, rows] of byCode) {
      const typeId = typeIdByCode.get(code);
      const use = MAPPING.find((m) => m.source_code === code).use;
      for (const row of rows) {
        const u = await c.query(
          `update units set unit_type_id=$1, unit_type_source=$2,
                            unit_type_assigned_by_user_id=$3, unit_type_assigned_at=now()
            where id=$4 and (unit_type_id is distinct from $1)`,
          [typeId, `${RECEIPT}: ${code}`, actor, row.unit_id]);
        assigned += u.rowCount;
        // position_kind: structural receipt — one canonical space per unit and
        // no bed labels anywhere in the source.
        const s = await c.query(
          `update spaces set position_kind='unit', use_type=$1,
                             classification_source=$2, classified_by_user_id=$3, classified_at=now()
            where id=$4 and (position_kind is distinct from 'unit' or use_type is distinct from $1)`,
          [use, `${RECEIPT}: ${code}`, actor, row.space_id]);
        kinded += s.rowCount; used += s.rowCount;
      }
    }
    await c.query("commit");
    console.log(`\nAPPLIED — ${typeIdByCode.size} governed unit types, ${assigned} units assigned, ${kinded} positions classified.`);
    console.log(`Provenance recorded on every row: ${RECEIPT}\n`);
  } catch (e) {
    await c.query("rollback");
    console.error("ROLLED BACK: " + e.message);
    process.exit(1);
  }
  await c.end();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
