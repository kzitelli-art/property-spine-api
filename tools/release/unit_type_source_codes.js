#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    unit_type_source_codes.js — WHAT WOULD SKYLINE'S UNIT TYPES BE MADE OF?

    READ ONLY. Decides nothing.

    tools/apply_unit_type_mapping.js is the canonical way a property gets
    governed unit types. It maps a SOURCE CODE to a governed
    property_unit_types row, joined through
    import_source_rows.produced_space_id — never a unit_number string
    match — and it refuses to invent a type for a position whose source
    carries no code. Its MAPPING is an OWNER-APPROVED list, and the one in
    the file today is an apartment floorplan vocabulary (S.1UN_02,
    1.1DN_02, …) approved on 2026-07-27 for a different property.

    Skyline is bed-based. Nobody can approve a Skyline mapping without
    seeing Skyline's actual codes, and nobody should guess them. So this
    reports the codes that are really there, with counts and coverage, and
    stops. Choosing what each one is CALLED is a business ruling.

        DATABASE_URL="..." node tools/release/unit_type_source_codes.js
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

(async () => {
  rule(); L("  UNIT-TYPE SOURCE CODES  ·  read only, decides nothing"); rule();

  const props = process.env.PROPERTY_IDS
    ? process.env.PROPERTY_IDS.split(",").map((x) => x.trim()).filter(Boolean)
    : (await pool.query(`
        select p.id from properties p
         where exists (select 1 from import_batches b
                        where b.property_id = p.id and b.status='committed')
           and p.name ilike '%skyline%'`)).rows.map((r) => r.id);

  if (!props.length) { L("  no committed-import property matching 'skyline'"); await pool.end(); return; }

  for (const id of props) {
    const p = (await pool.query("select name, address, leasing_basis from properties where id=$1", [id])).rows[0];
    L(`\n  ${p.name}  —  ${p.address || "(no address)"}   basis=${p.leasing_basis || "—"}`);
    L(`  ${id}`);

    const batches = (await pool.query(`
      select id, source_type, leasing_model, status, source_as_of_date, source_file
        from import_batches where property_id=$1 order by source_as_of_date desc nulls last`, [id])).rows;
    L("\n  ── import batches ──");
    for (const b of batches)
      L(`     ${b.source_as_of_date || "—"}  ${b.source_type}/${b.leasing_model || "—"}  ${b.status}  ${b.source_file || ""}`);

    const cov = (await pool.query(`
      select count(*)::int as rows,
             count(*) filter (where r.produced_space_id is not null)::int as with_space,
             count(*) filter (where r.raw ? 'unit_type')::int as with_unit_type_key
        from import_source_rows r join import_batches b on b.id = r.import_batch_id
       where b.property_id = $1`, [id])).rows[0];
    L("\n  ── source-row coverage ──");
    L(`     source rows                       ${cov.rows}`);
    L(`     …linked to a rentable position    ${cov.with_space}   (produced_space_id)`);
    L(`     …carrying a 'unit_type' key       ${cov.with_unit_type_key}`);

    //  WHAT KEYS ARE ACTUALLY THERE. If 'unit_type' is absent, the mapping
    //  tool has nothing to read, and knowing which key DOES carry the
    //  floorplan is the real question — not a guess at its name.
    const keys = (await pool.query(`
      select k, count(*)::int n from (
        select jsonb_object_keys(r.raw) as k
          from import_source_rows r join import_batches b on b.id = r.import_batch_id
         where b.property_id = $1 and r.raw is not null) x
      group by k order by n desc, k limit 40`, [id])).rows;
    L("\n  ── keys present in the raw source rows ──");
    L("     " + (keys.length ? keys.map((k) => `${k.k}(${k.n})`).join("  ") : "(none)"));

    const codes = (await pool.query(`
      select r.raw->>'unit_type' as code,
             count(*)::int as rows,
             count(distinct s.unit_id)::int as units,
             count(distinct r.produced_space_id)::int as positions
        from import_source_rows r
        join import_batches b on b.id = r.import_batch_id
        left join spaces s on s.id = r.produced_space_id
       where b.property_id = $1 and r.raw->>'unit_type' is not null
       group by 1 order by positions desc, rows desc`, [id])).rows;
    L("\n  ── DISTINCT unit_type CODES, as they really appear ──");
    if (!codes.length) {
      L("     (none — no source row carries a 'unit_type' key)");
      L("     → the canonical mapping tool cannot classify this property as written.");
      L("       The question is which key carries the floorplan, not what to name it.");
    } else {
      L(`     ${"code".padEnd(24)} ${"rows".padStart(6)} ${"units".padStart(6)} ${"positions".padStart(10)}`);
      for (const c of codes)
        L(`     ${String(c.code).slice(0,24).padEnd(24)} ${String(c.rows).padStart(6)} ${String(c.units).padStart(6)} ${String(c.positions).padStart(10)}`);
      const already = (await pool.query(
        "select code, label from property_unit_types where property_id=$1 order by sort_order", [id])).rows;
      L("\n  ── governed types that already exist ──");
      L("     " + (already.length ? already.map((a) => `${a.code}=${a.label}`).join("  ") : "(none)"));
      L("\n  ── what a mapping would have to decide ──");
      L(`     ${codes.length} code(s) need a human-readable label and a use_type`);
      L("     (residential | commercial | non_revenue | other). That is a business");
      L("     ruling, not a derivation — this tool deliberately proposes nothing.");
    }
  }

  L(); rule(); L("  read complete — nothing was written."); rule();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
