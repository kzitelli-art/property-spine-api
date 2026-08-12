/* ════════════════════════════════════════════════════════════════════
   legal_entity.db.js — "1850 N 18TH HOLDINGS LLC IS A REAL LEGAL ENTITY
   RELATED TO THIS PROPERTY", proven against real PostgreSQL.

   The primitive exists because BIRT and NPT belong to the TAXPAYER, not
   the property — and because ownership and debt work will need the same
   object. It is deliberately narrow, and several assertions below exist
   to prove what it does NOT do.

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/legal_entity.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const URL_ = receipt.harnessConnectionString();
const entities = require("../src/entity/legal_entity_service.js");

const EXPECTED_ASSERTIONS = 28;
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
async function refuses(label, fn, code) {
  try { await fn(); ok(label, false, "it was ACCEPTED"); }
  catch (e) { ok(label, !code || e.code === code, `code=${e.code} msg=${e.message}`); }
}

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "legal_ent_" + Date.now();
  let c;
  try {
    await pool.query(`create schema ${schema}`);
    c = await pool.connect();
    await c.query(`set search_path to ${schema}`);
    await c.query(`
      create extension if not exists pgcrypto;
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(),
        original_filename text not null, artifact_kind text not null default 'other');
    `);
    let mig = fs.readFileSync(
      path.join(__dirname, "..", "migrations", "164_legal_entities.sql"), "utf8");
    mig = mig.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "")
             .replace(/alter table source_artifacts drop constraint[\s\S]*$/m, "");
    await c.query(mig);

    const uid = (await c.query(`insert into users (name) values ('Asset Ops') returning id`)).rows[0].id;
    const prop = (await c.query(
      `insert into properties (name) values ('1850 N 18th') returning id`)).rows[0].id;
    const prop2 = (await c.query(
      `insert into properties (name) values ('4233 Chestnut') returning id`)).rows[0].id;
    const art = (await c.query(
      `insert into source_artifacts (original_filename, artifact_kind)
       values ('1850 operating agreement.pdf','operating_agreement') returning id`)).rows[0].id;

    console.log("\n── 1. THE ENTITY ─────────────────────────────────────");

    await refuses("an entity with no provenance is refused",
      () => entities.establishEntity(c, { legal_name: "X", user_id: uid }),
      "PROVENANCE_REQUIRED");
    await refuses("an entity with no name is refused",
      () => entities.establishEntity(c, { provenance_note: "x", user_id: uid }), "BAD_INPUT");
    await refuses("an unrecognised entity_type is refused rather than stored",
      () => entities.establishEntity(c, { legal_name: "X", entity_type: "limited liability co",
        provenance_note: "x", user_id: uid }), "BAD_INPUT");

    const holdings = await entities.establishEntity(c, {
      legal_name: "1850 N 18th Holdings LLC", entity_type: "llc",
      formation_jurisdiction: "Delaware",
      source_artifact_id: art, user_id: uid });
    ok("a legal entity is established from its formation document",
       holdings.legal_name === "1850 N 18th Holdings LLC");
    ok("…recording the jurisdiction it was FORMED in, which need not be where it operates",
       holdings.formation_jurisdiction === "Delaware");

    console.log("\n── 2. THE RELATIONSHIP IS NAMED, NOT ASSUMED ─────────");

    await refuses("an unnamed relationship is refused",
      () => entities.relateToProperty(c, { legal_entity_id: holdings.id, property_id: prop,
        effective_from: "2024-01-01", provenance_note: "x", user_id: uid }), "BAD_INPUT");
    await refuses("…and so is one Spine does not have a word for",
      () => entities.relateToProperty(c, { legal_entity_id: holdings.id, property_id: prop,
        relationship_type: "manages_sort_of", effective_from: "2024-01-01",
        provenance_note: "x", user_id: uid }), "BAD_INPUT");
    await refuses("relating an entity that does not exist is refused by name",
      () => entities.relateToProperty(c, {
        legal_entity_id: "00000000-0000-0000-0000-000000000000", property_id: prop,
        relationship_type: "owner", effective_from: "2024-01-01",
        provenance_note: "x", user_id: uid }), "NOT_FOUND");

    const own = await entities.relateToProperty(c, {
      legal_entity_id: holdings.id, property_id: prop, relationship_type: "owner",
      effective_from: "2024-01-01", source_artifact_id: art, user_id: uid });
    ok("an OWNER relationship is recorded, dated and evidenced",
       own.relationship_type === "owner" && !!own.source_artifact_id);

    //  OWNER and OPERATING_ENTITY are DIFFERENT FACTS about the same pair.
    //  A tax obligation may attach to one and not the other.
    await entities.relateToProperty(c, {
      legal_entity_id: holdings.id, property_id: prop, relationship_type: "operating_entity",
      effective_from: "2024-01-01", provenance_note: "management agreement", user_id: uid });
    const both = await entities.readForProperty(c, { property_id: prop, as_of: "2025-06-01" });
    ok("one entity can be OWNER and OPERATING ENTITY at once — two facts, two rows",
       both.length === 2 && new Set(both.map((r) => r.relationship_type)).size === 2,
       JSON.stringify(both.map((r) => r.relationship_type)));

    //  …but not the owner twice over the same period.
    let dup = false;
    try {
      await c.query(
        `insert into legal_entity_properties (legal_entity_id, property_id,
           relationship_type, effective_from, provenance_note, recorded_by_user_id)
         values ($1,$2,'owner','2024-06-01','x',$3)`, [holdings.id, prop, uid]);
    } catch (e) { dup = /uq_lep_live_relationship/.test(e.message); }
    ok("the same entity cannot be the live OWNER twice over one property", dup);

    console.log("\n── 3. A TRANSFER CLOSES, IT DOES NOT DELETE ──────────");

    const newco = await entities.establishEntity(c, {
      legal_name: "Chestnut Propco LLC", entity_type: "llc",
      provenance_note: "deed", user_id: uid });
    await entities.relateToProperty(c, {
      legal_entity_id: newco.id, property_id: prop2, relationship_type: "owner",
      effective_from: "2024-01-01", provenance_note: "deed", user_id: uid });
    await entities.relateToProperty(c, {
      legal_entity_id: newco.id, property_id: prop2, relationship_type: "owner",
      effective_from: "2026-01-01", provenance_note: "restated deed", user_id: uid });

    const closed = (await c.query(
      `select effective_from, effective_to from legal_entity_properties
        where legal_entity_id = $1 and property_id = $2 order by effective_from`,
      [newco.id, prop2])).rows;
    ok("a new dated relationship CLOSES the prior one rather than replacing it",
       closed.length === 2 && entities.isoDay(closed[0].effective_to) === "2026-01-01",
       JSON.stringify(closed));
    const back = await entities.readForProperty(c, { property_id: prop2, as_of: "2025-06-01" });
    ok("…and asking about 2025 still returns the relationship that governed 2025",
       back.length === 1 && back[0].effective_from === "2024-01-01", JSON.stringify(back));
    const fwd = await entities.readForProperty(c, { property_id: prop2, as_of: "2026-06-01" });
    ok("…while 2026 returns the current one", fwd.length === 1
       && fwd[0].effective_from === "2026-01-01", JSON.stringify(fwd));

    console.log("\n── 4. WHAT THIS PRIMITIVE REFUSES TO BE ──────────────");

    //  Every one of these is a real thing somebody will want to add, and
    //  every one belongs to the later ownership/debt onboarding stage.
    const cols = (await c.query(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name in
              ('legal_entities','legal_entity_properties')`, [schema])).rows
      .map((r) => r.column_name);
    for (const forbidden of ["ownership_percent", "percent", "waterfall", "cap_table",
                             "beneficial_owner", "signature", "signatory"]) {
      ok(`no \`${forbidden}\` column — that is the reserved onboarding stage`,
         !cols.some((c2) => c2.includes(forbidden)), cols.join(", "));
    }
    //  A tax identifier is how ONE JURISDICTION names this entity, not
    //  what the entity IS. Same distinction 161 draws for policy numbers.
    for (const forbidden of ["ein", "tax_id", "tax_account"]) {
      ok(`no \`${forbidden}\` — tax identifiers stay in Taxes`,
         !cols.some((c2) => c2 === forbidden || c2.startsWith(forbidden + "_")),
         cols.join(", "));
    }

    //  ⚠ THE TRAP THIS PRIMITIVE MUST NOT SPRING.
    //  Philadelphia exempts corporations from NPT. entity_type is
    //  EVIDENCE for that question and must never be the ANSWER — an
    //  applicability finding is governed and recorded, never read off an
    //  attribute. So this service offers no way to ask.
    const api = Object.keys(entities);
    ok("the service exposes NO applicability or eligibility function",
       !api.some((k) => /applicab|eligib|exempt|liable|owes/i.test(k)), api.join(", "));
    ok("…and no tax vocabulary at all in its API",
       !api.some((k) => /tax|birt|npt/i.test(k)), api.join(", "));

    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "entity", "legal_entity_service.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    ok("its CODE names no tax table — Taxes references entities, never the reverse",
       !/\btax_[a-z_]+\b/.test(src));
    ok("…and it imports nothing, so it cannot reach any domain",
       !/require\s*\(\s*["'`]\./.test(src));

  } catch (e) {
    console.error("\nHARNESS DIED:", e); process.exitCode = 1;
  } finally {
    if (c) c.release();
    try { await pool.query(`drop schema ${schema} cascade`); } catch (_) {}
    await pool.end();
  }

  const total = pass + fail;
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${total} assertions · ${pass} passed · ${fail} failed`);
  if (total < EXPECTED_ASSERTIONS) {
    console.log(`  ✗ RUN INVALID — expected ${EXPECTED_ASSERTIONS}, ran ${total}.`);
    process.exit(1);
  }
  console.log("════════════════════════════════════════════════════════");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
