#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    skyline_canonical_inventory.js — SKYLINE THROUGH THE GOVERNED READ.

    READ ONLY.

    WHY THIS EXISTS. A prior report stated "231 units / 319 beds" from raw
    `count(*)` on units and spaces, and offered it as evidence that the
    right Skyline had been picked. That was wrong in exactly the way that
    is hardest to notice: the number was plausible, internally consistent,
    and produced by a query that ran perfectly.

    Raw rows include inventory the canonical read deliberately EXCLUDES.
    Skyline was re-grained from whole-unit placeholders to beds, and the
    superseded unit rows were RETIRED — preserved as history, not deleted,
    which is why they still answer count(*). This repository's own comment
    on that work says an already-bed-grained Skyline "would have put its 72
    placeholders straight back".

    So this asks the canonical loader instead: datedPropertyPositions,
    which excludes retired inventory and — importantly — REPORTS what it
    excluded rather than silently shortening the row set.

        DATABASE_URL="..." node tools/release/skyline_canonical_inventory.js
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { datedPropertyPositions } = require(path.join(ROOT, "src/tenancy/dated_positions.js"));

const EXPECT_UNITS = Number(process.env.EXPECT_UNITS || 72);
const EXPECT_BEDS  = Number(process.env.EXPECT_BEDS  || 160);

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(64); }
let ssl = { rejectUnauthorized: false };
try { const h = new URL(url).hostname;
      if (["127.0.0.1","localhost","::1",""].includes(h)) ssl = false; } catch (_) {}
const pool = new Pool({ connectionString: url, ssl });

const L = (s="") => console.log(s);
const rule = () => L("════════════════════════════════════════════════════════════════");
const NOT_RETIRED = `not exists (select 1 from inventory_retirements ir
                                  where ir.unit_id = u.id and ir.reversed_at is null)`;

(async () => {
  rule(); L("  SKYLINE THROUGH THE CANONICAL READ  ·  read only"); rule();
  L(`  expecting ${EXPECT_UNITS} units / ${EXPECT_BEDS} beds\n`);

  const ids = process.env.PROPERTY_IDS
    ? process.env.PROPERTY_IDS.split(",").map((x) => x.trim()).filter(Boolean)
    : (await pool.query("select id from properties where name ilike '%skyline%' order by name, id")).rows.map((r) => r.id);

  for (const id of ids) {
    const p = (await pool.query(
      `select name, display_name, address, city, state, leasing_basis, created_at
         from properties where id=$1`, [id])).rows[0];
    L("────────────────────────────────────────────────────────────────");
    if (!p) { L(`  ${id}   NO SUCH PROPERTY`); continue; }
    L(`  ${id}`);
    L(`  ${p.display_name || p.name}   —   ${p.address || "(no address)"}${p.city ? ", " + p.city : ""}${p.state ? " " + p.state : ""}`);
    L(`  leasing_basis ${p.leasing_basis || "—"}   created ${p.created_at ? String(p.created_at).slice(0,10) : "—"}`);
    L("────────────────────────────────────────────────────────────────");

    //  ── raw, shown ONLY so the difference is visible ────────────────
    const raw = (await pool.query(`
      select (select count(*)::int from units u where u.property_id=$1) as units,
             (select count(*)::int from spaces s join units u on u.id=s.unit_id
               where u.property_id=$1) as spaces`, [id])).rows[0];

    //  ── current, non-retired ────────────────────────────────────────
    const cur = (await pool.query(`
      select (select count(*)::int from units u
               where u.property_id=$1 and ${NOT_RETIRED}) as units,
             (select count(*)::int from spaces s join units u on u.id=s.unit_id
               where u.property_id=$1 and ${NOT_RETIRED}) as spaces`, [id])).rows[0];

    //  ── the space grain of what remains ─────────────────────────────
    const grain = (await pool.query(`
      select coalesce(s.position_kind,'(unclassified)') as kind,
             count(*)::int as n,
             count(*) filter (where s.classification_source is null)::int as unclassified_source
        from spaces s join units u on u.id = s.unit_id
       where u.property_id=$1 and ${NOT_RETIRED}
       group by 1 order by n desc`, [id])).rows;

    L("  ── inventory ──");
    L(`     raw rows (INCLUDES retired history)   units ${raw.units}   spaces ${raw.spaces}`);
    L(`     CURRENT, non-retired                  units ${cur.units}   spaces ${cur.spaces}`);
    L("     current spaces by grain:");
    if (!grain.length) L("        (none)");
    for (const g of grain)
      L(`        ${String(g.kind).padEnd(16)} ${String(g.n).padStart(5)}` +
        (g.unclassified_source ? `   (${g.unclassified_source} with no classification_source — provisional/placeholder)` : ""));

    //  ── the canonical loader ────────────────────────────────────────
    let pos = null;
    try { pos = await datedPropertyPositions(pool, { property_id: id }); }
    catch (e) { L(`\n     datedPropertyPositions threw: ${e.message}`); }
    if (pos) {
      L("  ── canonical tenancy loader (datedPropertyPositions) ──");
      L(`     as_of                    ${pos.as_of}`);
      L(`     CURRENT RENTABLE POSITIONS ${pos.count}`);
      const rx = pos.retired_excluded || {};
      L(`     retired units excluded   ${rx.units ?? "—"}` +
        (rx.leases_on_retired ? `   ⚠ ${rx.leases_on_retired} lease(s) attached to retired inventory` : "") +
        (rx.conflict ? "   ⚠ CONFLICT" : ""));
      const ob = pos.opening_baseline;
      L("  ── established opening position ──");
      if (!ob) L("     none — no opening tenancy position established (honest blank, not an error)");
      else L(`     as_of ${ob.as_of_date}  status ${ob.status}  established ${ob.positions_established}  unresolved ${ob.positions_unresolved}  source rows ${ob.source_rows_read}`);
    }

    //  ── rent-roll lineage ───────────────────────────────────────────
    const imp = (await pool.query(`
      select source_type, leasing_model, status, source_as_of_date, source_file
        from import_batches where property_id=$1
       order by coalesce(source_as_of_date, loaded_at::date) desc nulls last limit 5`, [id])).rows;
    L("  ── rent-roll lineage ──");
    if (!imp.length) L("     (no import batches)");
    for (const b of imp)
      L(`     ${b.source_as_of_date || "—"}  ${b.source_type}/${b.leasing_model || "—"}  ${b.status}  ${b.source_file || ""}`);

    //  ── the verdict ─────────────────────────────────────────────────
    const u = cur.units, b = pos ? pos.count : cur.spaces;
    const match = u === EXPECT_UNITS && b === EXPECT_BEDS;
    L("  ── verdict ──");
    L(`     expected ${EXPECT_UNITS} / ${EXPECT_BEDS}   ·   canonical ${u} / ${b}   ·   ${match ? "✓ MATCH" : "✗ DOES NOT MATCH"}`);
    if (!match && u === EXPECT_UNITS)
      L("     units match but rentable positions do not — check grain and placeholders above.");
    L("");
  }

  rule(); L("  read complete — nothing was written."); rule();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
