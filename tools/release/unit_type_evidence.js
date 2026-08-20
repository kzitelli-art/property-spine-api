#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    unit_type_evidence.js — WHAT THE SOURCE ACTUALLY SAYS ABOUT THE THREE
    SKYLINE CODES.

    READ ONLY. Proposes nothing.

    A business lead exists — "12 are 3 bed 1 bath, 4 are 3 bed 1.5 baths" —
    and a lead is a thing to VERIFY, not a licence to name types. This
    reports, per code, everything the committed source and the governed
    inventory already carry: bedrooms, bathrooms, square footage, the
    commercial flag, statuses, space labels, and the APRIL batch's own
    `type` value for the same units, which is independent corroboration
    from a second rent roll rather than a second look at the same one.

    If the source proves the distinction, it will be visible here. If it
    does not, that is the finding, and the two 3-bed codes go back to you
    as "DISTINGUISHER NOT ESTABLISHED" rather than as invented labels.

        DATABASE_URL="..." node tools/release/unit_type_evidence.js
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(64); }
let ssl = { rejectUnauthorized: false };
try { const h = new URL(url).hostname;
      if (["127.0.0.1","localhost","::1",""].includes(h)) ssl = false; } catch (_) {}
const pool = new Pool({ connectionString: url, ssl });
const L = (s="") => console.log(s);
const rule = () => L("════════════════════════════════════════════════════════════════");
const j = (v) => (v === null || v === undefined ? "—" : String(v));

(async () => {
  rule(); L("  UNIT-TYPE EVIDENCE  ·  read only, proposes nothing"); rule();

  const prop = process.env.PROPERTY_ID || (await pool.query(`
    select p.id from properties p
     where p.name ilike '%skyline%'
       and exists (select 1 from import_batches b where b.property_id=p.id and b.status='committed')
     order by p.created_at limit 1`)).rows.map((r) => r.id)[0];
  if (!prop) { L("  no committed-import skyline property found"); await pool.end(); return; }
  const pr = (await pool.query("select name, address from properties where id=$1",[prop])).rows[0];
  L(`  ${pr.name} — ${pr.address || "(no address)"}\n  ${prop}\n`);

  const codes = (await pool.query(`
    select distinct r.raw->>'unit_type' as code
      from import_source_rows r join import_batches b on b.id=r.import_batch_id
     where b.property_id=$1 and r.raw->>'unit_type' is not null
     order by 1`, [prop])).rows.map((r) => r.code);

  for (const code of codes) {
    L("────────────────────────────────────────────────────────────────");
    L(`  ${code}`);
    L("────────────────────────────────────────────────────────────────");

    //  governed inventory facts for the units this code produced
    const inv = (await pool.query(`
      select u.bedrooms, u.bathrooms, count(distinct u.id)::int as units,
             count(distinct s.id)::int as positions,
             min(u.square_feet)::int as sqft_min, max(u.square_feet)::int as sqft_max
        from import_source_rows r
        join import_batches b on b.id=r.import_batch_id
        join spaces s on s.id = r.produced_space_id
        join units u on u.id = s.unit_id
       where b.property_id=$1 and r.raw->>'unit_type'=$2
       group by u.bedrooms, u.bathrooms
       order by units desc`, [prop, code])).rows;
    L("  ── governed inventory (units table) ──");
    L(`     ${"bed".padStart(4)} ${"bath".padStart(5)} ${"units".padStart(6)} ${"positions".padStart(10)}  sqft`);
    for (const r of inv)
      L(`     ${j(r.bedrooms).padStart(4)} ${j(r.bathrooms).padStart(5)} ${String(r.units).padStart(6)} ${String(r.positions).padStart(10)}  ` +
        `${r.sqft_min === r.sqft_max ? j(r.sqft_min) : j(r.sqft_min) + "–" + j(r.sqft_max)}`);

    //  what the JULY source row itself says
    const raw = (await pool.query(`
      select r.raw->>'sqft' as sqft, r.raw->>'is_commercial' as is_commercial,
             r.raw->>'status' as status, r.raw->>'section' as section,
             r.raw->>'room' as room, count(*)::int as n
        from import_source_rows r join import_batches b on b.id=r.import_batch_id
       where b.property_id=$1 and r.raw->>'unit_type'=$2
       group by 1,2,3,4,5 order by n desc limit 8`, [prop, code])).rows;
    L("  ── july source rows (distinct combinations) ──");
    L(`     ${"sqft".padStart(6)} ${"commercial".padStart(11)} ${"status".padStart(12)} ${"section".padStart(10)} ${"room".padStart(8)}  n`);
    for (const r of raw)
      L(`     ${j(r.sqft).padStart(6)} ${j(r.is_commercial).padStart(11)} ${j(r.status).slice(0,12).padStart(12)} ${j(r.section).slice(0,10).padStart(10)} ${j(r.room).slice(0,8).padStart(8)}  ${r.n}`);

    //  INDEPENDENT CORROBORATION: the April batch uses `type`, not
    //  `unit_type`. Same units, different rent roll, different key.
    const apr = (await pool.query(`
      select ar.raw->>'type' as april_type, count(distinct u.id)::int as units
        from import_source_rows r
        join import_batches b  on b.id  = r.import_batch_id
        join spaces s          on s.id  = r.produced_space_id
        join units  u          on u.id  = s.unit_id
        join spaces s2         on s2.unit_id = u.id
        join import_source_rows ar on ar.produced_space_id = s2.id
        join import_batches ab on ab.id = ar.import_batch_id and ab.id <> b.id
       where b.property_id=$1 and r.raw->>'unit_type'=$2 and ar.raw ? 'type'
       group by 1 order by units desc limit 6`, [prop, code])).rows;
    L("  ── april batch's own `type` for the same units (corroboration) ──");
    if (!apr.length) L("     (no overlapping april rows)");
    for (const r of apr) L(`     ${j(r.april_type).padEnd(24)} ${r.units} unit(s)`);

    //  space labels tell us the bed grain
    const lbl = (await pool.query(`
      select s.space_label, count(*)::int n
        from import_source_rows r
        join import_batches b on b.id=r.import_batch_id
        join spaces s on s.id=r.produced_space_id
       where b.property_id=$1 and r.raw->>'unit_type'=$2
       group by 1 order by 1 limit 8`, [prop, code])).rows;
    L("  ── space labels ──");
    L("     " + (lbl.length ? lbl.map((x) => `${j(x.space_label)}(${x.n})`).join("  ") : "(none)"));

    //  one whole raw row, so nothing is hidden behind my choice of columns
    const sample = (await pool.query(`
      select r.raw from import_source_rows r join import_batches b on b.id=r.import_batch_id
       where b.property_id=$1 and r.raw->>'unit_type'=$2 limit 1`, [prop, code])).rows[0];
    L("  ── one complete raw row, unfiltered ──");
    L("     " + JSON.stringify(sample && sample.raw).slice(0, 700));
    L("");
  }

  rule(); L("  read complete — nothing was written."); rule();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
