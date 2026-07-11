#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  tools/seed_demo_inventory.js — DEMO BUILDING INVENTORY (the curtain)
//
//  Class 3 demo staging infrastructure. NOT the onboarding engine.
//  demo_solo_full_v1: full Solo-shaped residential inventory transcribed
//  from the REAL May 2026 rent roll (as-of 2026-05-31) — units only,
//  ZERO resident PII. occupancy_status carries the OPERATING conclusion
//  (pre-leased ⇒ 'occupied'); the manifest's availability_basis carries
//  the source truth. availableUnits filters vacant ∧ not-down ONLY, so
//  model/down/uncertain rows are seeded never-offerable by construction.
//
//  Provenance is HONEST: source_type='demo_qa_inventory',
//  source_as_of_date = the ROLL's as-of date (2026-05-31), not today.
//  Solo (9e2bb96e…) is never queried as a target, never written.
//
//    node tools/seed_demo_inventory.js --dry-run
//    node tools/seed_demo_inventory.js --confirm
//    node tools/seed_demo_inventory.js --reset --dataset demo_solo_full_v1 --yes
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const SOLO = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";

const MANIFEST = require(path.join(__dirname, "data", "demo_solo_full_v1.json"));
const DATASET = MANIFEST.dataset; // demo_solo_full_v1
const AS_OF = MANIFEST.source_as_of; // 2026-05-31

// seedable = every residential row; commercial stays excluded.
const rows = MANIFEST.units.filter(u => u.availability_basis !== "commercial_excluded");

function datasetHash() {
  return crypto.createHash("sha256").update(JSON.stringify(MANIFEST.units)).digest("hex").slice(0, 16);
}

(async () => {
  const dry = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");
  const reset = process.argv.includes("--reset");
  const yes = process.argv.includes("--yes");

  const hash = datasetHash();
  const offerable = rows.filter(r => r.occupancy_status === "vacant" && !r.is_down);
  const basisCounts = {};
  MANIFEST.units.forEach(u => { basisCounts[u.availability_basis] = (basisCounts[u.availability_basis] || 0) + 1; });

  if (!dry && !confirm && !reset) {
    console.error("Usage: --dry-run | --confirm | --reset --dataset demo_solo_full_v1 --yes");
    process.exit(1);
  }

  if (dry) {
    console.log(`── DRY RUN · dataset ${DATASET} · as-of ${AS_OF} · hash ${hash} ──`);
    console.log(`manifest rows: ${MANIFEST.units.length} (seedable residential: ${rows.length})`);
    console.log("availability_basis:", JSON.stringify(basisCounts));
    console.log(`OFFERABLE NOW (vacant ∧ not-down): ${offerable.length} →`,
      offerable.map(r => `${r.unit_number}(${r.bedrooms}bd $${r.market_rent})`).join(" "));
    const byType = {};
    rows.forEach(r => { const k = `${r.bedrooms}bd/${r.bathrooms}ba`; byType[k] = (byType[k] || 0) + 1; });
    console.log("by type:", JSON.stringify(byType));
    console.log("target:", DEMO, "(Demo Building — Solo is NEVER written)");
    process.exit(0);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL && /neon|render/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false });
  const client = await pool.connect();
  try {
    if (DEMO === SOLO) throw new Error("target equals Solo — refusing."); // HARD WALL

    const hasApps = (await client.query("select to_regclass('applications') is not null as x")).rows[0].x;
    const refUnion = [
      "select unit_id from leasing_leads where unit_id is not null",
      "select unit_id from application_invitations where unit_id is not null",
      hasApps ? "select unit_id from applications where unit_id is not null" : null,
    ].filter(Boolean).join(" union ");

    if (reset) {
      const owned = (await client.query(
        `select id, unit_number from units where property_id=$1 and source_type='demo_qa_inventory'`, [DEMO])).rows;
      console.log(`RESET plan · dataset rows currently in Demo Building: ${owned.length}`);
      owned.slice(0, 10).forEach(u => console.log("  will remove unit", u.unit_number));
      if (owned.length > 10) console.log(`  … and ${owned.length - 10} more`);
      if (!yes) process.exit(1);
      await client.query("begin");
      const gone = await client.query(
        `delete from units where property_id=$1 and source_type='demo_qa_inventory'
          and id not in (${refUnion})`, [DEMO]);
      await client.query("commit");
      console.log(`RESET: removed ${gone.rowCount} unreferenced dataset units (referenced units retained + listed):`);
      const kept = (await client.query(`select unit_number from units where property_id=$1 and source_type='demo_qa_inventory'`, [DEMO])).rows;
      kept.forEach(u => console.log("  RETAINED (referenced):", u.unit_number));
      process.exit(0);
    }

    // ── CONFIRM: prune strays, then upsert the full manifest ──
    await client.query("begin");

    // pre-existing non-dataset unit(s): governed keep, recorded (unchanged behavior)
    const preexisting = (await client.query(
      `select id, unit_number, occupancy_status, market_rent, source_type from units
        where property_id=$1 and (source_type is distinct from 'demo_qa_inventory')`, [DEMO])).rows;
    for (const p of preexisting) {
      const refs = (await client.query(
        `select
           (select count(*) from leasing_leads where unit_id=$1)::int as leads,
           (select count(*) from application_invitations where unit_id=$1)::int as invites,
           ${hasApps ? "(select count(*) from applications where unit_id=$1)::int" : "0"} as apps,
           (select count(*) from spaces where unit_id=$1)::int as spaces`, [p.id])).rows[0];
      const preOff = p.occupancy_status === "vacant"; // is_down read below for the warning
      const pd = (await client.query(`select coalesce(is_down,false) as d from units where id=$1`, [p.id])).rows[0].d;
      console.log(`PRE-EXISTING unit ${p.unit_number} (source=${p.source_type || "(null)"}, occupancy=${p.occupancy_status}, is_down=${pd}): refs leads=${refs.leads} invites=${refs.invites} apps=${refs.apps} spaces=${refs.spaces} → RETAINED outside the dataset (governed keep; not adopted into ${DATASET}).`);
      if (preOff && !pd) console.log(`  ⚠ FLAG 4a: this retained unit is VACANT ∧ not-down → it WILL appear in availableUnits at $${p.market_rent}. Governed decision required (mark occupied/down, adopt, or delete).`);
    }

    // PRUNE: prior-dataset rows whose unit_number is NOT in this manifest
    // (e.g. leftover synthetic numbers). FK-referenced rows are RETAINED + named.
    const manifestNums = rows.map(r => String(r.unit_number));
    const stray = await client.query(
      `delete from units where property_id=$1 and source_type='demo_qa_inventory'
         and unit_number <> all($2)
         and id not in (${refUnion})
       returning unit_number`, [DEMO, manifestNums]);
    if (stray.rowCount) console.log(`PRUNED ${stray.rowCount} prior-dataset units not in ${DATASET}:`, stray.rows.map(r => r.unit_number).join(" "));
    const strayKept = (await client.query(
      `select unit_number from units where property_id=$1 and source_type='demo_qa_inventory'
         and unit_number <> all($2)`, [DEMO, manifestNums])).rows;
    strayKept.forEach(u => console.log("  STRAY RETAINED (referenced):", u.unit_number));

    let created = 0, updated = 0;
    for (const r of rows) {
      const existing = (await client.query(
        `select id from units where property_id=$1 and unit_number=$2`, [DEMO, String(r.unit_number)])).rows[0];
      if (existing) {
        await client.query(
          `update units set bedrooms=$2, bathrooms=$3, square_feet=$4, market_rent=$5,
                  occupancy_status=$6, is_down=$7, operating_use=$8,
                  source_type='demo_qa_inventory', source_as_of_date=$9,
                  confidence='demo_qa', updated_at=now()
            where id=$1`,
          [existing.id, r.bedrooms, r.bathrooms, r.square_feet, r.market_rent,
           r.occupancy_status, !!r.is_down, r.operating_use, AS_OF]);
        updated++;
      } else {
        await client.query(
          `insert into units (property_id, unit_number, bedrooms, bathrooms, square_feet, market_rent,
                              occupancy_status, is_down, operating_use, source_type, source_as_of_date, confidence)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'demo_qa_inventory',$10,'demo_qa')`,
          [DEMO, String(r.unit_number), r.bedrooms, r.bathrooms, r.square_feet, r.market_rent,
           r.occupancy_status, !!r.is_down, r.operating_use, AS_OF]);
        created++;
      }
    }
    await client.query("commit");

    const after = (await client.query(`select count(*)::int as n from units where property_id=$1`, [DEMO])).rows[0].n;
    const offNow = (await client.query(
      `select unit_number, bedrooms, market_rent from units
        where property_id=$1 and occupancy_status='vacant' and coalesce(is_down,false)=false
        order by market_rent`, [DEMO])).rows;
    const soloAfter = (await client.query(`select count(*)::int as n from units where property_id=$1`, [SOLO])).rows[0].n;
    console.log(`── RECEIPT · dataset ${DATASET} · as-of ${AS_OF} · hash ${hash} ──`);
    console.log(`created ${created} · updated ${updated} · pruned ${stray.rowCount} · Demo total now ${after}`);
    console.log(`availability_basis (manifest): ${JSON.stringify(basisCounts)}`);
    console.log(`OFFERABLE in DB now (vacant ∧ not-down): ${offNow.length} →`, offNow.map(u => `${u.unit_number}(${u.bedrooms}bd $${u.market_rent})`).join(" "));
    console.log(`Solo untouched check: ${soloAfter} units (must equal its pre-run count — 282).`);
    console.log(`provenance: source_type=demo_qa_inventory · confidence=demo_qa · as_of=${AS_OF}`);
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    console.error("SEED FAILED (nothing partial kept):", e.message);
    process.exit(1);
  } finally { client.release(); await pool.end(); }
})();
