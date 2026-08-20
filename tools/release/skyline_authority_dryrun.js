#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    skyline_authority_dryrun.js — WHAT STANDS BETWEEN YOU AND SKYLINE
    PRICING AUTHORITY, ASKED THROUGH THE CANONICAL MECHANISM.

    READ ONLY. resolveAuthority is called with apply = false, which its own
    code answers as "dry_run_no_write_performed". It writes nothing.

    WHY THIS AND NOT AN INSERT. src/identity/authority_resolution.js is the
    governed door for conferring pricing authority: seven preconditions, a
    receipt, and exactly one write when it does apply. An insert into
    `assignments` would produce the same row while skipping every check —
    the precise defect class the audit named, where the canonical mechanism
    exists and the real path goes around it.

    IT HAS NO HTTP ROUTE. Nothing in the server reaches resolveAuthority, so
    this script is currently the only way to ask it anything. That gap is
    worth recording; going around the resolver because it lacks a door is
    not.

        DATABASE_URL="..." node tools/release/skyline_authority_dryrun.js
        DATABASE_URL="..." PERSON_QUERY=zitelli node tools/release/skyline_authority_dryrun.js
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { resolveAuthority, ASSIGNABLE_ROLES } = require(path.join(ROOT, "src/identity/authority_resolution.js"));

//  NO HARDCODED UUID. The first version carried one transcribed by eye off
//  a screenshot, and a single wrong character made it "no such property".
//  A 36-character identifier copied by a human is a transcription risk, and
//  the right answer was already available from evidence: among the rows
//  labelled skyline, the real asset is the one with a street address and
//  committed rent-roll imports. The script finds it and says why.
const SKYLINE_OVERRIDE = process.env.SKYLINE_ID || null;
const QUERY   = process.env.PERSON_QUERY || "zitelli";
const ROLE    = process.env.REQUESTED_ROLE || "asset_manager";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(64); }
let ssl = { rejectUnauthorized: false };
try { const h = new URL(url).hostname;
      if (["127.0.0.1","localhost","::1",""].includes(h)) ssl = false; } catch (_) {}
const pool = new Pool({ connectionString: url, ssl });

const L = (s="") => console.log(s);
const rule = () => L("════════════════════════════════════════════════════════════════");

(async () => {
  rule(); L("  SKYLINE PRICING AUTHORITY — DRY RUN  ·  writes nothing"); rule();

  let prop;
  if (SKYLINE_OVERRIDE) {
    prop = (await pool.query("select id, name, address from properties where id=$1", [SKYLINE_OVERRIDE])).rows[0];
    if (!prop) { L(`  no property ${SKYLINE_OVERRIDE}`); await pool.end(); return; }
  } else {
    const cands = (await pool.query(`
      select p.id, p.name, p.address,
             (select count(*)::int from import_batches b
               where b.property_id = p.id and b.status = 'committed') as committed_imports,
             (select count(*)::int from units u where u.property_id = p.id) as units,
             (select count(*)::int from leases l where l.property_id = p.id) as leases
        from properties p
       where p.name ilike '%skyline%'
       order by committed_imports desc, leases desc, units desc`)).rows;
    if (!cands.length) { L("  no property matching 'skyline'"); await pool.end(); return; }
    L("  ── candidates carrying the label, ranked by evidence ──");
    for (const c of cands)
      L(`     ${c.id}  ${String(c.name).padEnd(20)} imports=${c.committed_imports} units=${c.units} leases=${c.leases}  ${c.address || "(no address)"}`);
    prop = cands[0];
    if (!prop.address || prop.committed_imports === 0) {
      L("\n  ✗ REFUSING TO GUESS — the best candidate has no address or no committed");
      L("    rent-roll import. Identity is address and provenance; pass SKYLINE_ID");
      L("    explicitly if you know which row is the real asset.");
      await pool.end(); return;
    }
    L(`\n  selected by evidence: address present and ${prop.committed_imports} committed import(s).`);
  }
  const SKYLINE = prop.id;
  L(`  property   ${prop.name}  —  ${prop.address || "(no address)"}`);
  L(`  id         ${prop.id}`);
  L(`  role asked ${ROLE}   (authority-bearing roles: ${[...ASSIGNABLE_ROLES].join(", ")})`);
  L(`  searching for people matching "${QUERY}"\n`);

  //  ── FIND THE IDENTITIES BY PROVEN AUTHORITY, NOT BY NAME ──────────
  //  Name matching failed once already: four person rows carry "Zitelli"
  //  (one a tenant, two duplicate staff rows, one a different human) and
  //  the login is called "KZ", so a name search found no login at all.
  //  A person who ALREADY holds an authority-bearing assignment somewhere
  //  is governed-staff by evidence rather than by spelling.
  const authPeople = (await pool.query(`
    select p.id as person_id, p.name as person_name, p.email, p.lifecycle_status,
           pr.name as holds_on, a.role,
           u.id as user_id, u.name as user_name, u.account_kind, u.is_active
      from assignments a
      join persons p on p.id = a.person_id
      join properties pr on pr.id = a.property_id
      left join users u on u.person_id = p.id
     where a.is_active and a.role in ('owner','asset_manager')
     order by p.name`)).rows;

  L("  ── people who already hold authority somewhere (governed by evidence) ──");
  if (!authPeople.length) L("     (nobody holds an authority-bearing assignment anywhere)");
  for (const r of authPeople)
    L(`     ${r.person_name || "(unnamed)"} — ${r.role} on ${r.holds_on}\n` +
      `        person ${r.person_id}  [${r.lifecycle_status}]  ${r.email || ""}\n` +
      `        login  ${r.user_id ? r.user_id + "  " + (r.user_name || "") + "  kind=" + r.account_kind : "NOT LINKED TO ANY LOGIN"}`);

  //  Optional name searches, kept for context only.
  const persons = (await pool.query(
    `select id, name, email, lifecycle_status from persons
      where name ilike $1 or coalesce(email,'') ilike $1 order by name limit 10`,
    [`%${QUERY}%`])).rows;
  const uq = process.env.USER_QUERY || QUERY;
  const users = (await pool.query(
    `select id, name, email, account_kind, person_id, is_active from users
      where name ilike $1 or coalesce(email,'') ilike $1 order by name limit 10`,
    [`%${uq}%`])).rows;
  L(`\n  ── persons matching "${QUERY}" ──`);
  if (!persons.length) L("     (none)");
  for (const p2 of persons) L(`     ${p2.id}  ${p2.name || "(unnamed)"}  ${p2.email || ""}  [${p2.lifecycle_status}]`);
  L(`  ── logins matching "${uq}" ──`);
  if (!users.length) L("     (none)");
  for (const u of users)
    L(`     ${u.id}  ${u.name || "(unnamed)"}  ${u.email || ""}  kind=${u.account_kind} person_id=${u.person_id || "NONE"}`);

  //  Prefer a linked pair that already holds authority somewhere.
  let pair = null;
  const linked = authPeople.find((r) => r.user_id);
  if (linked) pair = { u: { id: linked.user_id, name: linked.user_name }, p: { id: linked.person_id, name: linked.person_name } };
  if (!pair) {
    const u2 = users.find((u) => u.person_id);
    if (u2) {
      const p3 = (await pool.query("select id, name from persons where id=$1", [u2.person_id])).rows[0];
      if (p3) pair = { u: u2, p: p3 };
    }
  }
  if (!pair) {
    L("\n  ✗ CANNOT FORM A (login, person) PAIR.");
    L("    Nobody holding authority is linked to a login, and no searched");
    L("    login carries a person_id. THIS IS THE FINDING: pricing authority");
    L("    resolves through a person, and the account that would exercise it");
    L("    is not governed-linked to one. That link is a separate,");
    L("    attributable write — it is not something this dry run can assume.");
    await pool.end(); return;
  }

  L(`\n  asking about: login ${pair.u.name || pair.u.id}  ×  person ${pair.p.name || pair.p.id}\n`);

  let out;
  try {
    out = await resolveAuthority(pool, {
      spec: { user_id: pair.u.id, person_id: pair.p.id, property_id: SKYLINE,
              requested_role: ROLE, reviewer_user_id: pair.u.id,
              reason: "dry run: establish Skyline pricing authority" },
      apply: false,
    });
  } catch (e) { L(`  resolveAuthority threw: ${e.message}`); await pool.end(); return; }

  L("  ── the resolver's verdict ──");
  L(`     mode         ${out.mode}`);
  L(`     disposition  ${out.disposition}`);
  L(`     WOULD APPLY  ${out.would_apply ? "YES" : "NO"}`);
  if ((out.blocking || []).length) L(`     blocking     ${out.blocking.join(", ")}`);

  const ev = (out.receipt && out.receipt.evidence) || [];
  if (ev.length) {
    L("\n  ── every precondition, and why ──");
    for (const c of ev) L(`     ${c.passed ? "✓" : "✗"} ${String(c.id).padEnd(30)} ${c.detail || ""}`);
  }
  if ((out.outstanding_sequence_steps || []).length) {
    L("\n  ── what must happen first, in order ──");
    out.outstanding_sequence_steps.forEach((s, i) => L(`     ${i + 1}. ${s}`));
  }

  L(); rule(); L("  dry run complete — nothing was written."); rule();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
