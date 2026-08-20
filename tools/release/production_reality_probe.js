#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    production_reality_probe.js — WHAT IS ACTUALLY TRUE IN PRODUCTION.

    READ ONLY. Every statement is a SELECT, and the three app modules it
    calls were checked to contain zero insert/update/delete before this
    was written. It changes nothing and can be run at any time.

    It exists because "production behaviour" has been a total blank: the
    schema is right and the deployed SHA is known, but nobody has ever
    asked the live system a question. It also checks one thing that has
    only ever been measured on a LOCAL FIXTURE — pricing authority — and
    a local fixture is not production.

        DATABASE_URL="..." node tools/release/production_reality_probe.js
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
function load(m) { try { return require(path.join(ROOT, m)); } catch (e) { return { __err: e.message }; } }
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(64); }
let ssl = { rejectUnauthorized: false };
try { const h = new URL(url).hostname;
      if (["127.0.0.1","localhost","::1",""].includes(h)) ssl = false; } catch (_) {}
const pool = new Pool({ connectionString: url, ssl });

const line = (s="") => console.log(s);
const rule = () => line("════════════════════════════════════════════════════════════════");
const q = async (sql, p=[]) => { try { return (await pool.query(sql, p)).rows; }
                                 catch (e) { return [{ __err: e.message }]; } };
const one = async (sql, p=[]) => { const r = await q(sql, p); return r[0] || {}; };

(async () => {
  rule(); line("  PROPERTY SPINE — PRODUCTION REALITY  ·  read only"); rule();

  const led = await one("select max(version::int)::int c, count(*)::int n from schema_migrations");
  line(`  ledger              ceiling ${led.c} · ${led.n} entries`);

  line();
  line("── inventory ──");
  for (const [label, sql] of [
    ["properties",            "select count(*)::int n from properties"],
    ["units",                 "select count(*)::int n from units"],
    ["spaces",                "select count(*)::int n from spaces"],
    ["leases (any status)",   "select count(*)::int n from leases"],
    ["leases active",         "select count(*)::int n from leases where lease_status='active'"],
    ["persons",               "select count(*)::int n from persons"],
    ["users",                 "select count(*)::int n from users"],
  ]) { const r = await one(sql); line(`     ${label.padEnd(24)} ${r.__err ? "READ FAILED: "+r.__err : r.n}`); }

  line();
  line("── the pricing wall, in production ──");
  for (const [label, sql] of [
    ["pricing versions",      "select count(*)::int n from property_pricing_versions"],
    ["  published",           "select count(*)::int n from property_pricing_versions where status='published'"],
    ["pricing_terms",         "select count(*)::int n from pricing_terms"],
    ["properties w/ lease_config", "select count(*)::int n from properties where lease_config is not null"],
  ]) { const r = await one(sql); line(`     ${label.padEnd(24)} ${r.__err ? "READ FAILED: "+r.__err : r.n}`); }

  line();
  line("── WHO MAY PUBLISH PRICING (measured here for the first time) ──");
  const pa = load("src/money/pricing_authority.js");
  if (pa.__err) line(`     module load failed: ${pa.__err}`);
  else {
    try {
      const inv = await pa.authorityInventory(pool, {});
      const s = inv.summary || {};
      line(`     properties total                ${s.properties_total}`);
      line(`     properties with publish authority ${s.properties_with_publish_authority}`);
      line(`     active grants                   ${s.grants_total}`);
      if ((inv.by_assignment || []).length) {
        line("     by assignment:");
        for (const r of inv.by_assignment.slice(0, 10))
          line(`        ${String(r.property_name || r.property_id).slice(0,28).padEnd(30)} ${r.name || "(unnamed)"} — ${r.role}`);
      } else line("     by assignment: (none)");
      if ((inv.by_grant || []).length) {
        line("     by grant:");
        for (const r of inv.by_grant.slice(0, 10))
          line(`        ${String(r.property_name || r.property_id).slice(0,28).padEnd(30)} ${r.name || "(unnamed)"}`);
      } else line("     by grant: (none)");
    } catch (e) { line(`     authorityInventory threw: ${e.message}`); }
  }

  line();
  line("── the identity seam: do users resolve to persons? ──");
  const seam = await one(`
    select (select count(*)::int from users where is_active) as active_users,
           (select count(*)::int from users u
              where u.is_active and exists (
                select 1 from persons p
                 where lower(btrim(p.email)) = lower(btrim(u.email)) and coalesce(u.email,'') <> '')
           ) as users_matching_a_person_by_email`);
  if (seam.__err) line(`     READ FAILED: ${seam.__err}`);
  else {
    line(`     active users                      ${seam.active_users}`);
    line(`     of those, matching a person by email ${seam.users_matching_a_person_by_email}`);
    line("     (email match is indicative, not the app's own linkage rule)");
  }

  line();
  line("── does the pricing wall actually REFUSE on a real space? ──");
  const sp = await one(`
    select s.id space_id, u.property_id, u.unit_number, s.space_label
      from spaces s join units u on u.id = s.unit_id
     order by s.created_at desc limit 1`);
  if (sp.__err || !sp.space_id) line(`     no space available to test (${sp.__err || "none found"})`);
  else {
    const ep = load("src/money/effective_pricing.js");
    if (ep.__err) line(`     module load failed: ${ep.__err}`);
    else {
      try {
        const econ = await ep.resolveSpaceEconomics(pool, { property_id: sp.property_id, space_id: sp.space_id });
        line(`     space ${sp.unit_number || "?"} / ${sp.space_label || "(whole unit)"}`);
        line(`     → ${JSON.stringify(econ).slice(0, 340)}`);
      } catch (e) { line(`     resolveSpaceEconomics threw: ${e.message}`); }
    }
  }

  line();
  line("── does the composed leasing read work on real data? ──");
  const pr = await one(`
    select p.id person_id, l.property_id
      from persons p join leasing_leads l on l.person_id = p.id
     order by l.created_at desc limit 1`);
  if (pr.__err || !pr.person_id) line(`     no lead-linked person to test (${pr.__err || "none found"})`);
  else {
    const ls = load("src/leasing/leasing_standing_read.js");
    if (ls.__err) line(`     module load failed: ${ls.__err}`);
    else {
      try {
        const st = await ls.readLeasingStanding(pool, { person_id: pr.person_id, property_id: pr.property_id });
        line(`     bands returned: ${Object.keys(st || {}).join(", ")}`);
        line(`     → ${JSON.stringify(st).slice(0, 400)}`);
      } catch (e) { line(`     readLeasingStanding threw: ${e.message}`); }
    }
  }

  line(); rule(); line("  read complete — nothing was written."); rule();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
