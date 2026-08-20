/*  ════════════════════════════════════════════════════════════════════
    prospect_pricing_wall.e2e.js — WHAT REACHES A PROSPECT WHO ASKS THE PRICE.

    The adversarial audit's highest-severity finding is that the governed
    pricing machinery exists while the real prospect-facing AI path reads
    the legacy per-unit column directly. Its own header records the
    incident: a legacy rent that "disagreed with the sheet on unit 530 by
    $237 and went to nine real phones."

    THIS DOES NOT READ SOURCE. Source is where that defect hid in the first
    place. It drives POST /agent/inbound — the real prospect-message door —
    against a property shaped like Skyline is TODAY: zero published pricing.

    THE SENTINEL. units.market_rent is set to a value that could not
    plausibly arise any other way. If that number appears anywhere the
    prospect path produced — the facts handed to the model, the drafted
    reply, or a message body — then the legacy column reached the
    prospect path, whatever the architecture says.

    THE CORRECT RESULT with no published pricing is a REFUSAL or an
    omission. Not a plausible number.

    ANTI-VACUITY IS NOT OPTIONAL HERE. "The sentinel did not appear" is
    trivially true if nothing ran. Three times in one afternoon a test in
    this repository reported success while its own setup had silently
    failed. So this proves its setup took, and proves the path actually
    executed, before it believes a clean result.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const { Pool } = require(path.join(__dirname, "..", "..", "node_modules", "pg"));
const sess = require(path.join(__dirname, "..", "..", "src/identity/staff_session_service.js"));

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const KEY  = process.env.OPERATOR_KEY || "e2e-key";
const SENTINEL = "424242";
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0, last = "(nothing)";
const ok  = (l, d="") => { pass++; last = l; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d="") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
function abort(why, detail) {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  ABORTED — the proof could not be established, so it claims nothing.");
  console.log(`  LAST STEP THAT WORKED : ${last}`);
  console.log(`  WHY                   : ${why}`);
  if (detail) console.log(`  DETAIL                : ${String(detail).slice(0, 400)}`);
  console.log("══════════════════════════════════════════════════════════════");
  process.exit(3);
}

async function api(method, p, { token, body } = {}) {
  const h = { "content-type": "application/json", "x-operator-key": KEY };
  if (token) h["x-staff-session"] = token;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

(async () => {
  console.log("\n── SETUP: a property shaped like Skyline today — no published pricing ──");

  const prop = (await pool.query(
    `insert into properties (name, address) values ($1,$2) returning id`,
    ["Pricing Wall Probe", "1 Sentinel Way"])).rows[0].id;
  const unit = (await pool.query(
    `insert into units (property_id, unit_number, bedrooms, bathrooms, market_rent)
     values ($1,'PW1',1,1,$2) returning id`, [prop, SENTINEL])).rows[0].id;

  //  PROVE THE SETUP TOOK. Both halves, from the database, not from the
  //  fact that the inserts did not throw.
  const mr = (await pool.query("select market_rent::text as v from units where id=$1", [unit])).rows[0].v;
  if (!String(mr).startsWith(SENTINEL)) abort("the sentinel rent was not stored", `market_rent=${mr}`);
  ok("sentinel market_rent is really on the unit", `${mr}`);

  const pv = (await pool.query(
    "select count(*)::int n from property_pricing_versions where property_id=$1 and status='published'", [prop])).rows[0].n;
  if (pv !== 0) abort("the probe property has published pricing; it cannot mirror Skyline", `published versions=${pv}`);
  ok("zero published pricing versions — matches Skyline's real state", "published=0");

  const person = (await pool.query(
    `insert into persons (name) values ('Pricing Wall Prospect') returning id`)).rows[0].id;
  const mike = (await pool.query("select id from users where name='Mike Grivna' limit 1")).rows[0].id;
  const c = await pool.connect(); let token;
  try {
    await c.query("begin");
    const s = await sess.issueStaffSession(c, { userId: mike, propertyId: prop, purpose: "bootstrap_invite" });
    token = s.session_token || s.token;
    await c.query("commit");
  } finally { c.release(); }
  ok("operator session issued for the probe property");

  console.log("\n── ACT: a real prospect asks the real door what it costs ──");
  const askedAt = new Date();
  const inbound = await api("POST", "/agent/inbound", { token, body: {
    property_id: prop, person_id: person,
    body: "Hi! What's the rent on that one bedroom? What does it cost per month?" }});
  console.log(`     POST /agent/inbound → ${inbound.status}`);
  if (inbound.status >= 500) abort("the prospect door failed", JSON.stringify(inbound.body).slice(0, 300));
  ok("the prospect message reached the real inbound door", `status ${inbound.status}`);

  console.log("\n── ANTI-VACUITY: prove the path actually ran before believing it ──");
  const conv = (await pool.query(
    "select id from conversations where property_id=$1 and person_id=$2 order by created_at desc limit 1",
    [prop, person])).rows[0];
  if (!conv) abort("no conversation was created — the path did not run, so a clean result proves nothing");
  ok("a conversation exists", conv.id.slice(0, 8));

  const runs = (await pool.query(
    `select id, status, resolved_fact_snapshot_json, ai_operating_context_snapshot_json
       from agent_runs where conversation_id=$1 order by created_at desc`, [conv.id])).rows;
  if (!runs.length) abort("no agent_run was recorded — nothing composed any facts, so there is nothing to check");
  ok("an agent run was recorded", `${runs.length} run(s), latest status=${runs[0].status}`);

  console.log("\n── OBSERVE: everything the prospect path produced ──");
  const drafts = (await pool.query(
    `select d.generated_body from agent_drafts d join agent_runs r on r.id=d.agent_run_id
      where r.conversation_id=$1`, [conv.id])).rows;
  const events = (await pool.query(
    `select direction, body from comm_events where conversation_id=$1 and body is not null`, [conv.id])).rows;

  const surfaces = [
    ["facts handed to the model", JSON.stringify(runs.map(r => r.resolved_fact_snapshot_json))],
    ["operating context snapshot", JSON.stringify(runs.map(r => r.ai_operating_context_snapshot_json))],
    ["drafted replies",            JSON.stringify(drafts.map(d => d.generated_body))],
    ["message bodies on the thread", JSON.stringify(events.map(e => e.body))],
  ];

  let leaked = 0;
  for (const [label, blob] of surfaces) {
    const hit = blob.includes(SENTINEL);
    if (hit) { bad(`${label} CONTAINS the legacy sentinel`, blob.slice(0, 220)); leaked++; }
    else ok(`${label} does not carry the legacy rent`);
  }

  console.log("\n── WHAT THE PROSPECT PATH ACTUALLY SAID ABOUT PRICE ──");
  for (const r of runs) {
    const f = r.resolved_fact_snapshot_json;
    console.log("     facts: " + (f ? JSON.stringify(f).slice(0, 300) : "(none recorded)"));
  }
  for (const d of drafts) console.log("     draft: " + String(d.generated_body || "").slice(0, 300));

  //  Cleanup: this probe invents a property, so it removes it.
  await pool.query("delete from comm_events where conversation_id=$1", [conv.id]);
  await pool.query("delete from agent_drafts where agent_run_id in (select id from agent_runs where conversation_id=$1)", [conv.id]);
  await pool.query("delete from agent_runs where conversation_id=$1", [conv.id]);

  console.log("\n══════════════════════════════════════════════════════════════");
  if (leaked) {
    console.log(`  ✗ THE LEGACY COLUMN REACHES THE PROSPECT PATH — ${leaked} surface(s).`);
    console.log("    A prospect asking the price can be told a number that no");
    console.log("    governed pricing version authorised. This is the audit's");
    console.log("    §3.3 finding, observed rather than argued.");
  } else {
    console.log("  ✓ NO LEGACY RENT REACHED ANY PROSPECT-FACING SURFACE.");
  }
  console.log(`  ${pass} passed · ${fail} failed`);
  console.log("══════════════════════════════════════════════════════════════");
  await pool.end();
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
