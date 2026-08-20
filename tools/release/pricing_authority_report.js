#!/usr/bin/env node
/*  READ ONLY. Who may publish pricing, on which named property, by what
    basis — and whether Skyline is among them.

    A file rather than a node -e one-liner because PowerShell mangles
    nested quotes, and three rounds of quoting errors is three rounds too
    many.

        DATABASE_URL="..." node tools/release/pricing_authority_report.js  */
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
const line = (s="") => console.log(s);

(async () => {
  line("════════════════════════════════════════════════════════════════");
  line("  WHO MAY PUBLISH PRICING  ·  read only");
  line("════════════════════════════════════════════════════════════════");

  line("\n── every property, and whether anyone holds pricing authority ──");
  const rows = (await pool.query(`
    select pr.id, pr.name,
           (select count(*) from assignments a
              where a.property_id = pr.id and a.is_active = true
                and a.role in ('owner','asset_manager'))::int as full_authority_people,
           (select count(*) from concession_authority_grants g
              where g.property_id = pr.id and g.effective_from <= now()
                and (g.effective_until is null or g.effective_until > now()))::int as active_grants,
           (select count(*) from property_pricing_versions v
              where v.property_id = pr.id and v.status='published')::int as published_pricing,
           (pr.lease_config is not null) as has_lease_config
      from properties pr order by pr.name`)).rows;

  const w = Math.min(38, Math.max(...rows.map(r => (r.name || "").length), 8));
  line(`  ${"property".padEnd(w)}  auth  grants  priced  cfg`);
  line(`  ${"-".repeat(w)}  ----  ------  ------  ---`);
  for (const r of rows) {
    line(`  ${String(r.name || "(unnamed)").slice(0, w).padEnd(w)}  ` +
         `${String(r.full_authority_people).padStart(4)}  ` +
         `${String(r.active_grants).padStart(6)}  ` +
         `${String(r.published_pricing).padStart(6)}  ` +
         `${r.has_lease_config ? " y " : " . "}`);
  }

  line("\n── the people who hold it, by name ──");
  const who = (await pool.query(`
    select pr.name as property, p.name as person, p.id as person_id, a.role
      from assignments a
      join properties pr on pr.id = a.property_id
      join persons p on p.id = a.person_id
     where a.is_active = true and a.role in ('owner','asset_manager')
     order by pr.name, p.name`)).rows;
  if (!who.length) line("     (nobody — no active owner or asset_manager assignment anywhere)");
  for (const r of who)
    line(`     ${String(r.property).slice(0,30).padEnd(32)} ${r.person || "(person row has no name)"}  — ${r.role}`);

  line("\n── anything named like Skyline ──");
  const sky = (await pool.query(
    "select id, name from properties where name ilike '%skyline%' order by name")).rows;
  if (!sky.length) line("     no property matches 'skyline'");
  for (const r of sky) line(`     ${r.name}   ${r.id}`);

  line("\n════════════════════════════════════════════════════════════════");
  line("  read complete — nothing was written.");
  line("════════════════════════════════════════════════════════════════");
  await pool.end();
})().catch((e) => { console.error("DIED:", e.message); process.exit(1); });
