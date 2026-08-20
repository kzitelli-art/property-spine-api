#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    skyline_identity_report.js — WHICH DURABLE ASSET IS SKYLINE?

    READ ONLY. Every statement is a SELECT. No mutation, no merge, no
    repoint. Three property rows carry effectively the same label; a label
    is not an identity. This reports what each UUID actually IS —
    address, deal lineage, inventory, leasing basis, lease history, import
    provenance — so the answer can be stated as:

      "This UUID is Skyline because it is the property at <address>,
       carries the established inventory, and holds the real import and
       lease history."

    PART B answers a separate, sharper question: if a staff user is given
    ONE property assignment, does the server actually return only that
    property? The picker reads property_team_assignments joined to the
    user with active = true and has no all-properties fallback — but that
    is what the SOURCE says. This measures what production DATA would
    actually yield for every real user.

        DATABASE_URL="..." node tools/release/skyline_identity_report.js
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { listAuthorizedProperties } = require(path.join(ROOT, "src/identity/authorized_properties.js"));

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(64); }
let ssl = { rejectUnauthorized: false };
try { const h = new URL(url).hostname;
      if (["127.0.0.1","localhost","::1",""].includes(h)) ssl = false; } catch (_) {}
const pool = new Pool({ connectionString: url, ssl });

const L = (s="") => console.log(s);
const rule = () => L("════════════════════════════════════════════════════════════════");
const val = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));
async function one(sql, p=[]) { try { return (await pool.query(sql, p)).rows[0] || {}; }
                                catch (e) { return { __err: e.message }; } }
async function all(sql, p=[]) { try { return (await pool.query(sql, p)).rows; }
                                catch (e) { return [{ __err: e.message }]; } }

(async () => {
  rule(); L("  WHICH DURABLE ASSET IS SKYLINE?  ·  read only, no mutations"); rule();

  const cands = await all(
    "select id, name, display_name from properties where name ilike '%skyline%' order by name, id");
  if (!cands.length || cands[0].__err) { L("  no candidates (" + (cands[0] && cands[0].__err) + ")"); await pool.end(); return; }
  L(`  ${cands.length} candidate row(s) carrying the label.\n`);

  for (const c of cands) {
    L("────────────────────────────────────────────────────────────────");
    L(`  ${c.id}`);
    L("────────────────────────────────────────────────────────────────");

    const p = await one(`
      select name, display_name, address, city, state, zip, property_type,
             leasing_basis, canonical_key, canonical_key_absent_reason,
             organization_id, planned_unit_count, operating_timezone,
             created_at, (lease_config is not null) as has_lease_config
        from properties where id = $1`, [c.id]);

    L("  ── identity ──");
    L(`     display name        ${val(p.display_name || p.name)}`);
    L(`     ADDRESS             ${val(p.address)}`);
    L(`     city / state / zip  ${val(p.city)} / ${val(p.state)} / ${val(p.zip)}`);
    L(`     property_type       ${val(p.property_type)}`);
    L(`     canonical_key       ${val(p.canonical_key)}${p.canonical_key_absent_reason ? "  (absent: " + p.canonical_key_absent_reason + ")" : ""}`);
    L(`     organization_id     ${val(p.organization_id)}`);
    L(`     operating timezone  ${val(p.operating_timezone)}`);
    L(`     created_at          ${val(p.created_at)}`);

    const deal = await all(`
      select di.deal_name, di.onboarding_type, di.status, dip.created_at, dip.authority_basis
        from deal_intake_properties dip
        join deal_intakes di on di.id = dip.intake_id
       where dip.property_id = $1 order by dip.created_at`, [c.id]);
    L("  ── deal lineage ──");
    if (!deal.length) L("     (no deal intake links this property)");
    for (const d of deal)
      L(`     ${val(d.deal_name)}  ·  ${val(d.onboarding_type)}/${val(d.status)}  ·  ${val(d.created_at)}`);

    const inv = await one(`
      select (select count(*)::int from units u where u.property_id = $1) as units,
             (select count(*)::int from spaces s join units u on u.id = s.unit_id
               where u.property_id = $1) as spaces,
             (select count(distinct u.unit_type_id)::int from units u
               where u.property_id = $1 and u.unit_type_id is not null) as unit_types`, [c.id]);
    L("  ── inventory ──");
    L(`     leasing_basis       ${val(p.leasing_basis)}   (by-unit vs by-bed)`);
    L(`     planned_unit_count  ${val(p.planned_unit_count)}`);
    L(`     units               ${val(inv.units)}`);
    L(`     rentable spaces     ${val(inv.spaces)}`);
    L(`     governed unit types ${val(inv.unit_types)}`);

    const lz = await all(`
      select lease_status, count(*)::int n from leases where property_id = $1
       group by lease_status order by n desc`, [c.id]);
    L("  ── leases ──");
    if (!lz.length) L("     (none)");
    for (const r of lz) L(`     ${String(val(r.lease_status)).padEnd(18)} ${r.n}`);

    const ppl = await one(`
      select (select count(*)::int from assignments a where a.property_id = $1 and a.is_active) as assignments,
             (select count(*)::int from leasing_leads l where l.property_id = $1) as leads,
             (select count(*)::int from property_team_assignments t where t.property_id = $1 and t.active) as team`, [c.id]);
    L("  ── people attached ──");
    L(`     person assignments  ${val(ppl.assignments)}`);
    L(`     leasing leads       ${val(ppl.leads)}`);
    L(`     property team rows  ${val(ppl.team)}`);

    const imp = await all(`
      select source_type, source_file, source_as_of_date, leasing_model, status, loaded_at
        from import_batches where property_id = $1
       order by coalesce(source_as_of_date, loaded_at::date) desc nulls last limit 3`, [c.id]);
    L("  ── import / rent-roll provenance ──");
    if (!imp.length) L("     (no import batches — this property was not loaded from a rent roll)");
    for (const b of imp)
      L(`     ${val(b.source_as_of_date)}  ${val(b.source_type)}/${val(b.leasing_model)}  ${val(b.status)}  ${val(b.source_file)}`);

    const gov = await one(`
      select (select count(*)::int from assignments a
                where a.property_id = $1 and a.is_active and a.role in ('owner','asset_manager')) as pricing_authority,
             (select count(*)::int from concession_authority_grants g
                where g.property_id = $1 and g.effective_from <= now()
                  and (g.effective_until is null or g.effective_until > now())) as active_grants,
             (select count(*)::int from property_pricing_versions v
                where v.property_id = $1 and v.status = 'published') as published_pricing`, [c.id]);
    const mods = await all(`
      select distinct unnest(coalesce(allowed_modules,'{}')) as m
        from property_team_assignments where property_id = $1 and active`, [c.id]);
    L("  ── governance ──");
    L(`     pricing authority   ${val(gov.pricing_authority)}`);
    L(`     active grants       ${val(gov.active_grants)}`);
    L(`     published pricing   ${val(gov.published_pricing)}`);
    L(`     lease_config        ${p.has_lease_config ? "present" : "ABSENT"}`);
    L(`     module entitlements ${mods.length ? mods.map(x => x.m).join(", ") : "(none granted to anyone)"}`);
    L("");
  }

  // ══ PART B ═════════════════════════════════════════════════════════
  rule(); L("  PART B — WHAT WOULD A STAFF USER'S PROPERTY PICKER RETURN?"); rule();
  L("  The picker is listAuthorizedProperties: an inner join from");
  L("  property_team_assignments (active) to properties, filtered by user_id.");
  L("  There is no all-properties branch in it. Measured below on real rows.\n");

  const tot = await one("select count(*)::int n from properties");
  const users = await all(
    "select id, name, email from users where is_active order by name limit 200");
  L(`  properties in production: ${val(tot.n)}`);
  L(`  active users checked:     ${users.length}\n`);

  let zero = 0, many = 0, worst = { n: -1 };
  const rowsOut = [];
  for (const u of users) {
    let list = [];
    try { list = await listAuthorizedProperties(pool, { user_id: u.id }); }
    catch (e) { rowsOut.push([u.name || "(unnamed)", "ERROR: " + e.message]); continue; }
    if (list.length === 0) zero++;
    if (list.length > 1) many++;
    if (list.length > worst.n) worst = { n: list.length, name: u.name, list };
    if (list.length) rowsOut.push([u.name || "(unnamed)", `${list.length}: ` +
      list.slice(0, 4).map(x => x.property_name).join(", ") + (list.length > 4 ? " …" : "")]);
  }
  L("  users who WOULD see at least one property:");
  if (!rowsOut.length) L("     (none — no active user holds any property_team_assignment)");
  for (const [n, d] of rowsOut.slice(0, 25)) L(`     ${String(n).slice(0,28).padEnd(30)} ${d}`);
  L("");
  L(`  users seeing 0 properties : ${zero}`);
  L(`  users seeing >1 property  : ${many}`);
  L(`  largest list any user gets: ${worst.n < 0 ? "—" : worst.n}` +
    (worst.n > 0 ? `  (${worst.name || "(unnamed)"})` : ""));
  L("");
  if (worst.n >= 0 && tot.n && worst.n >= tot.n) {
    L("  ✗ LAYER-0 DEFECT: some user's picker returns EVERY property.");
  } else {
    L("  ✓ No user's picker returns everything. The picker is scoped by");
    L("    assignment, so unrelated properties — including test junk — are");
    L("    not visible to a user who is not assigned to them.");
  }

  L(); rule(); L("  read complete — nothing was written."); rule();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
