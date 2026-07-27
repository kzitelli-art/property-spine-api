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

// THE APPROVED MAPPING. Distinctions are preserved, not normalised away:
// furnished, den and bath-count variants are real leasing categories.
const MAPPING = [
  { code: "S.1UN_02", label: "Studio",            sort: 10, use: "residential" },
  { code: "S.1FN_02", label: "Furnished Studio",  sort: 20, use: "residential" },
  { code: "1.1UN_02", label: "1 Bed",             sort: 30, use: "residential" },
  { code: "1.1FN_02", label: "Furnished 1 Bed",   sort: 40, use: "residential" },
  { code: "1.1DN_02", label: "1 Bed + Den",       sort: 50, use: "residential" },
  { code: "2.2UN_02", label: "2 Bed / 2 Bath",    sort: 60, use: "residential" },
  { code: "3.2UN_02", label: "3 Bed / 2 Bath",    sort: 70, use: "residential" },
  { code: "3.3UN_02", label: "3 Bed / 3 Bath",    sort: 80, use: "residential" },
  { code: "comm",     label: "Commercial Space",  sort: 90, use: "commercial"  },
];

const RECEIPT = "reviewed_mapping_receipt_2026-07-27";

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

  console.log(`\n${apply ? "APPLYING" : "DRY RUN"} — classification receipt ${RECEIPT}`);
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

  const unknown = [...byCode.keys()].filter((k) => !MAPPING.some((m) => m.code === k));
  if (unknown.length) {
    console.error("REFUSING: source codes with no approved mapping: " + unknown.join(", "));
    await c.end(); process.exit(1);
  }

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
    const rows = byCode.get(m.code) || [];
    console.log(`  ${m.code.padEnd(10)} → ${m.label.padEnd(20)} ${String(rows.length).padStart(3)} positions   use_type=${m.use}`);
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
        [propertyId, m.code, m.label, m.sort, `${RECEIPT}: source code ${m.code}`, actor]);
      typeIdByCode.set(m.code, r.rows[0].id);
    }

    let assigned = 0, kinded = 0, used = 0;
    for (const [code, rows] of byCode) {
      const typeId = typeIdByCode.get(code);
      const use = MAPPING.find((m) => m.code === code).use;
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
