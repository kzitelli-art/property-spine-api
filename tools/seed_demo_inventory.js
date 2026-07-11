#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  tools/seed_demo_inventory.js — DEMO BUILDING INVENTORY (the curtain)
//
//  Class 3 demo staging infrastructure. Deliberately uninteresting:
//  deterministic, idempotent, obviously demo-labeled, easy to recreate,
//  easy to remove. NOT the future onboarding engine; NOT rent-roll
//  transcription (structural shape follows Katie's Solo rent roll
//  RANGES; occupancy is deliberately simulated high-availability).
//
//  Provenance is HONEST: source_type='demo_qa_inventory'. Demo-shaped
//  ≠ Solo operating history — Solo is never queried, never written.
//
//    node tools/seed_demo_inventory.js --dry-run
//    node tools/seed_demo_inventory.js --confirm
//    node tools/seed_demo_inventory.js --reset --dataset demo_solo_v1 --yes
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const crypto = require("crypto");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const SOLO = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";
const DATASET = "demo_solo_v1";

// ── the deterministic dataset (fixed; same output every run) ──────────
// Shape follows the real Solo type mix + rent/sqft ranges (Katie's 4233
// rent roll). ~48 units, majority vacant (Kameron: plenty to tour/apply).
function buildDataset() {
  const mk = (unit_number, bd, ba, sqft, rent, occ) =>
    ({ unit_number: String(unit_number), bedrooms: bd, bathrooms: ba, square_feet: sqft, market_rent: rent, occupancy_status: occ });
  const rows = [];
  // Studios (~$1,420, 363–523 sqft): floors 2–4, 16 units, 12 vacant
  const studios = [203,207,219,221,230,238,303,307,319,321,330,338,403,407,419,421];
  studios.forEach((n, i) => rows.push(mk(n, 0, 1, 380 + (i % 5) * 28, 1420, i % 4 === 3 ? "occupied" : "vacant")));
  // 1x1 (~$1,700–1,760, 482–526 sqft): 16 units, 12 vacant
  const one1 = [204,206,208,210,304,306,308,310,404,406,408,410,504,506,508,510];
  one1.forEach((n, i) => rows.push(mk(n, 1, 1, 482 + (i % 4) * 12, n >= 500 ? 1760 : 1700, i % 4 === 2 ? "occupied" : "vacant")));
  // 1x1 Den (713 sqft, $1,760): 4 units, 3 vacant
  [217, 317, 417, 517].forEach((n, i) => rows.push(mk(n, 1, 1, 713, 1760, i === 1 ? "occupied" : "vacant")));
  // 2x2 (~$1,900, 935–969 sqft): 8 units, 6 vacant
  const two2 = [227, 302, 325, 327, 402, 425, 427, 502];
  two2.forEach((n, i) => rows.push(mk(n, 2, 2, 935 + (i % 3) * 17, 1900, i % 4 === 1 ? "occupied" : "vacant")));
  // 3x2 (~$3,010, 1241–1246 sqft): 4 units, 3 vacant
  [250, 350, 450, 550].forEach((n, i) => rows.push(mk(n, 3, 2, 1241 + (i % 2) * 5, 3010, i === 2 ? "occupied" : "vacant")));
  return rows;
}

function datasetHash(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

(async () => {
  const dry = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");
  const reset = process.argv.includes("--reset");
  const yes = process.argv.includes("--yes");

  const rows = buildDataset();
  const hash = datasetHash(rows);
  const vac = rows.filter(r => r.occupancy_status === "vacant").length;

  if (!dry && !confirm && !reset) {
    console.error("Usage: --dry-run | --confirm | --reset --dataset demo_solo_v1 --yes");
    process.exit(1);
  }

  if (dry) {
    console.log(`── DRY RUN · dataset ${DATASET} · hash ${hash} ──`);
    console.log(`units: ${rows.length} (${vac} vacant / ${rows.length - vac} occupied)`);
    const byType = {};
    rows.forEach(r => { const k = `${r.bedrooms}bd/${r.bathrooms}ba`; byType[k] = (byType[k] || 0) + 1; });
    console.log("by type:", JSON.stringify(byType));
    console.log(`rent range: $${Math.min(...rows.map(r => r.market_rent))}–$${Math.max(...rows.map(r => r.market_rent))}`);
    console.log("target:", DEMO, "(Demo Building — Solo is NEVER written)");
    process.exit(0);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL && /neon|render/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false });
  const client = await pool.connect();
  try {
    // HARD WALL
    if (DEMO === SOLO) throw new Error("target equals Solo — refusing.");

    if (reset) {
      if (!yes) { console.error("--reset requires --yes after reviewing what will be removed:"); }
      const owned = (await client.query(
        `select id, unit_number from units where property_id=$1 and source_type='demo_qa_inventory'`, [DEMO])).rows;
      console.log(`RESET plan · dataset rows currently in Demo Building: ${owned.length}`);
      owned.slice(0, 10).forEach(u => console.log("  will remove unit", u.unit_number));
      if (owned.length > 10) console.log(`  … and ${owned.length - 10} more`);
      if (!yes) process.exit(1);
      await client.query("begin");
      const hasApps = (await client.query("select to_regclass('applications') is not null as x")).rows[0].x;
      const refUnion = [
        "select unit_id from leasing_leads where unit_id is not null",
        "select unit_id from application_invitations where unit_id is not null",
        hasApps ? "select unit_id from applications where unit_id is not null" : null,
      ].filter(Boolean).join(" union ");
      const gone = await client.query(
        `delete from units where property_id=$1 and source_type='demo_qa_inventory'
          and id not in (${refUnion})`,
        [DEMO]);
      await client.query("commit");
      console.log(`RESET: removed ${gone.rowCount} unreferenced dataset units (referenced units retained + listed):`);
      const kept = (await client.query(`select unit_number from units where property_id=$1 and source_type='demo_qa_inventory'`, [DEMO])).rows;
      kept.forEach(u => console.log("  RETAINED (referenced):", u.unit_number));
      process.exit(0);
    }

    // ── CONFIRM: the load ──
    await client.query("begin");

    // the pre-existing unit(s): decide DELIBERATELY, record the decision
    const preexisting = (await client.query(
      `select id, unit_number, occupancy_status, market_rent, source_type from units
        where property_id=$1 and (source_type is distinct from 'demo_qa_inventory')`, [DEMO])).rows;
    for (const p of preexisting) {
      const hasApps2 = (await client.query("select to_regclass('applications') is not null as x")).rows[0].x;
      const refs = (await client.query(
        `select
           (select count(*) from leasing_leads where unit_id=$1)::int as leads,
           (select count(*) from application_invitations where unit_id=$1)::int as invites,
           ${hasApps2 ? "(select count(*) from applications where unit_id=$1)::int" : "0"} as apps,
           (select count(*) from spaces where unit_id=$1)::int as spaces`, [p.id])).rows[0];
      console.log(`PRE-EXISTING unit ${p.unit_number} (source=${p.source_type || "(null)"}): refs leads=${refs.leads} invites=${refs.invites} apps=${refs.apps} spaces=${refs.spaces} → RETAINED outside the dataset (governed decision: keep; it is not adopted into ${DATASET}).`);
    }

    let created = 0, updated = 0;
    for (const r of rows) {
      const existing = (await client.query(
        `select id from units where property_id=$1 and unit_number=$2`, [DEMO, r.unit_number])).rows[0];
      if (existing) {
        await client.query(
          `update units set bedrooms=$2, bathrooms=$3, square_feet=$4, market_rent=$5,
                  occupancy_status=$6, is_down=false, operating_use='residential',
                  source_type='demo_qa_inventory', source_as_of_date=current_date,
                  confidence='demo_qa', updated_at=now()
            where id=$1`,
          [existing.id, r.bedrooms, r.bathrooms, r.square_feet, r.market_rent, r.occupancy_status]);
        updated++;
      } else {
        await client.query(
          `insert into units (property_id, unit_number, bedrooms, bathrooms, square_feet, market_rent,
                              occupancy_status, is_down, operating_use, source_type, source_as_of_date, confidence)
           values ($1,$2,$3,$4,$5,$6,$7,false,'residential','demo_qa_inventory',current_date,'demo_qa')`,
          [DEMO, r.unit_number, r.bedrooms, r.bathrooms, r.square_feet, r.market_rent, r.occupancy_status]);
        created++;
      }
    }
    await client.query("commit");

    const after = (await client.query(`select count(*)::int as n from units where property_id=$1`, [DEMO])).rows[0].n;
    const soloAfter = (await client.query(`select count(*)::int as n from units where property_id=$1`, [SOLO])).rows[0].n;
    console.log(`── RECEIPT · dataset ${DATASET} · hash ${hash} ──`);
    console.log(`created ${created} · updated ${updated} · Demo total now ${after} · vacant ${vac}/${rows.length}`);
    console.log(`Solo untouched check: ${soloAfter} units (must equal its pre-run count).`);
    console.log(`provenance: source_type=demo_qa_inventory · confidence=demo_qa · as_of=today`);
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    console.error("SEED FAILED (nothing partial kept):", e.message);
    process.exit(1);
  } finally { client.release(); await pool.end(); }
})();
