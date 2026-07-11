#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  tools/seed_demo_agent_facts.js — DEMO BUILDING AGENT FACTS (curtain)
//
//  Class 3 demo staging. Loads SOURCED Solo leasing facts (2026 Field
//  Guide) into agent_facts for the DEMO BUILDING ONLY, so the demo agent
//  answers like Solo inside the isolated Demo context. Every rendered
//  fact carries its source; NOTHING here is invented — absence stays an
//  honest handoff. Idempotent upsert on (property_id, fact_key) for
//  property-level (space_id null) active rows. Solo is never written.
//
//  Columns used are exactly those the live agent reads (agent.js
//  resolveContext): fact_key, category, rendered_text, source_type,
//  status, property_id, space_id. If Neon holds stricter CHECKs than
//  assumed (category/source_type values), this fails SAFE in one txn —
//  read the constraint message and adjust values; nothing partial kept.
//
//    node tools/seed_demo_agent_facts.js --dry-run
//    node tools/seed_demo_agent_facts.js --confirm
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const path = require("path");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const SOLO = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";
const M = require(path.join(__dirname, "data", "demo_solo_agent_facts_v1.json"));

(async () => {
  const dry = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");
  if (!dry && !confirm) { console.error("Usage: --dry-run | --confirm"); process.exit(1); }

  if (dry) {
    console.log(`── DRY RUN · ${M.dataset} · ${M.facts.length} facts ──`);
    M.facts.forEach(f => console.log(`  ${f.fact_key} [${f.category}] ← ${f.source_type}`));
    console.log("target:", DEMO, "(Demo Building — Solo agent_facts are NEVER written)");
    process.exit(0);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL && /neon|render/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false });
  const client = await pool.connect();
  try {
    if (DEMO === SOLO) throw new Error("target equals Solo — refusing.");
    await client.query("begin");
    let created = 0, updated = 0;
    for (const f of M.facts) {
      const ex = (await client.query(
        `select id from agent_facts
          where property_id=$1 and fact_key=$2 and space_id is null and status='active'`,
        [DEMO, f.fact_key])).rows[0];
      if (ex) {
        await client.query(
          `update agent_facts set category=$2, rendered_text=$3, source_type=$4 where id=$1`,
          [ex.id, f.category, f.rendered_text, f.source_type]);
        updated++;
      } else {
        await client.query(
          `insert into agent_facts (property_id, fact_key, category, rendered_text, source_type, status, space_id)
           values ($1,$2,$3,$4,$5,'active',null)`,
          [DEMO, f.fact_key, f.category, f.rendered_text, f.source_type]);
        created++;
      }
    }
    await client.query("commit");
    const n = (await client.query(
      `select count(*)::int as n from agent_facts where property_id=$1 and status='active' and space_id is null`,
      [DEMO])).rows[0].n;
    const soloN = (await client.query(
      `select count(*)::int as n from agent_facts where property_id=$1`, [SOLO])).rows[0].n;
    console.log(`── RECEIPT · ${M.dataset} · created ${created} · updated ${updated} · Demo active facts now ${n} ──`);
    console.log(`Solo agent_facts untouched check: ${soloN} rows (must equal its pre-run count).`);
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    console.error("FACTS SEED FAILED (nothing partial kept):", e.message);
    process.exit(1);
  } finally { client.release(); await pool.end(); }
})();
