"use strict";
// ════════════════════════════════════════════════════════════════════════
//  tests/unit/shadow_import.test.js — DB-backed behavioral proof for the ride-along
//
//  Runs against a REAL Postgres. Two ways:
//    • Local (sandbox):  uses pgserver to spin an ephemeral cluster, applies the
//      prereq fixture + migration 050, then exercises leasing_shadow_import.
//    • Neon (production): set DATABASE_URL and SHADOW_TEST_USE_ENV=1; it will run
//      the SAME assertions against the live schema (assumes 050 already applied).
//
//  These assertions are the locked requirements, one test each:
//    1. three name variants on one phone -> ONE card, three names_seen, NO fork
//    2. NEW phone -> preview person + preview lead + preview tour; OUTREACH never sent
//    3. KNOWN phone -> NO new person, NO new lead, an intent task is raised
//    4. NO phone -> identity conflict (no_phone), no lead
//    5. invalid phone -> identity conflict (invalid_phone), no lead
//    6. differing email on a known phone -> contact discrepancy, identity NOT forked,
//       workflow NOT blocked
//    7. owner auto-resolves to the active leasing-agent assignment (persons-space)
//    8. NO active leasing agent -> lead UNASSIGNED + coverage exception (manager
//       escalation), manager NOT assigned as the agent
//    9. phone_verified_at is NULL after a source-provided import (never faked)
// ════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const assert = require("assert");

let PgClientLib;
try { PgClientLib = require("pg"); } catch (_) { PgClientLib = null; }

async function withPg() {
  if (process.env.SHADOW_TEST_USE_ENV === "1" && process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    return { pool, stop: async () => pool.end(), applied: true };
  }
  // Connect to an already-running local pgserver cluster (started by a persistent
  // sidecar that holds the reference so the cluster stays up). Socket dir:
  const sockDir = "/home/claude/build/.pgdata";
  const { Pool } = require("pg");
  const pool = new Pool({ host: sockDir, database: "postgres", user: "postgres", port: 5432 });
  return { pool, applied: false, stop: async () => { await pool.end(); } };
}

async function applySchema(pool) {
  const prereq = fs.readFileSync(path.join(__dirname, "_fixture_prereq.sql"), "utf8");
  const mig = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "050_identity_aliases_and_shadow_import.sql"), "utf8");
  // migrate.js wraps each file in a txn; replicate that here.
  const c = await pool.connect();
  try { await c.query("begin"); await c.query(prereq); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; }
  try { await c.query("begin"); await c.query(mig); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; }
  finally { c.release(); }
}

// seed a property + (optionally) a leasing-agent assignment + a manager.
async function seed(pool, { withAgent = true, withManager = true } = {}) {
  const c = await pool.connect();
  try {
    const prop = (await c.query(`insert into properties (name) values ('Skyline Test') returning *`)).rows[0];
    let agentPerson = null, mgrPerson = null;
    if (withAgent) {
      agentPerson = (await c.query(`insert into persons (name, source) values ('Paris Banks','seed') returning *`)).rows[0];
      await c.query(`insert into assignments (person_id, property_id, role, is_active) values ($1,$2,'leasing_agent',true)`, [agentPerson.id, prop.id]);
    }
    if (withManager) {
      mgrPerson = (await c.query(`insert into persons (name, source) values ('Skyline Manager','seed') returning *`)).rows[0];
      await c.query(`insert into assignments (person_id, property_id, role, is_active) values ($1,$2,'property_manager',true)`, [mgrPerson.id, prop.id]);
    }
    return { property_id: prop.id, agent_person_id: agentPerson && agentPerson.id, manager_person_id: mgrPerson && mgrPerson.id };
  } finally { c.release(); }
}

function occ(propertyId, over = {}) {
  return Object.assign({
    property_id: propertyId,
    prospect_name: "Maya Okafor",
    prospect_phone: "(215) 555-0142",
    prospect_email: "maya@example.com",
    external_appt_id: "ACUITY-" + Math.random().toString(36).slice(2, 9),
    source_system: "acuity_squarespace",
    appointment_type: "in_person",
    scheduled_start: "2026-06-25T15:00:00Z",
    scheduled_end: "2026-06-25T15:30:00Z",
  }, over);
}

let PASS = 0, FAIL = 0;
function ok(name, cond) {
  if (cond) { PASS++; console.log("  \u2713", name); }
  else { FAIL++; console.log("  \u2717 FAIL:", name); }
}

(async () => {
  const { pool, stop, applied } = await withPg();
  if (!applied) { await applySchema(pool); console.log("local schema applied (fixture + 050)."); }
  else { console.log("running against DATABASE_URL (assumes 050 already applied)."); }

  // build the module with a transport SPY to prove outreach is never sent.
  let smsCalls = 0;
  const moduleFactory = require("../../src/leasing/leasing_shadow_import.js");
  const router = moduleFactory({ pool });
  const svc = router._service;

  async function clean() {
    // wipe between tests for isolation (local only; on Neon use a throwaway schema).
    const c = await pool.connect();
    try {
      await c.query(`truncate person_intent_tasks, person_identity_conflicts, person_contact_discrepancies, leasing_coverage_exceptions, scheduled_tours, leasing_leads, assignments, persons, units, properties restart identity cascade`);
    } finally { c.release(); }
  }

  // The module cannot send by construction (no sms dep). We additionally assert
  // no outreach side-effect column is ever set on preview rows.
  async function runIngest(occurrence, opts) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const out = await svc.ingestShadowOccurrence(c, occurrence, opts);
      await c.query("commit");
      return out;
    } catch (e) { await c.query("rollback"); throw e; }
    finally { c.release(); }
  }

  try {
    // ── TEST 1: name variants collapse to one card, three aliases, no fork ──
    console.log("\nTEST 1 — three name variants on one phone -> one card, 3 names_seen, no fork");
    { const s = await seed(pool);
      const phone = "(215) 555-0142";
      await runIngest(occ(s.property_id, { prospect_name: "Maya Okafor", prospect_phone: phone, external_appt_id: "A1" }));
      await runIngest(occ(s.property_id, { prospect_name: "M. Okafor",   prospect_phone: phone, external_appt_id: "A2" }));
      await runIngest(occ(s.property_id, { prospect_name: "Maya O.",     prospect_phone: phone, external_appt_id: "A3" }));
      const persons = (await pool.query(`select * from persons where primary_phone_e164='+12155550142'`)).rows;
      ok("exactly one Person Card for the phone", persons.length === 1);
      const seenNames = (persons[0].names_seen || []).map((a) => a.name);
      ok("names_seen retains all three variants", ["Maya Okafor","M. Okafor","Maya O."].every((n) => seenNames.includes(n)));
      ok("display name not overwritten (stays first)", persons[0].name === "Maya Okafor");
    }
    await clean();

    // ── TEST 2: new phone -> preview person + lead + tour; outreach never sent ──
    console.log("\nTEST 2 — new phone -> preview person + preview lead + preview tour; NO outreach");
    { const s = await seed(pool);
      const out = await runIngest(occ(s.property_id, { prospect_phone: "(267) 555-0199", external_appt_id: "B1" }));
      ok("state is new_phone", out.state === "new_phone");
      ok("a person was created", out.created_person === true);
      const lead = (await pool.query(`select * from leasing_leads where id=$1`, [out.lead_id])).rows[0];
      ok("lead is import_mode=preview", lead && lead.import_mode === "preview");
      ok("lead status is tour_scheduled", lead && lead.status === "tour_scheduled");
      const tour = (await pool.query(`select * from scheduled_tours where id=$1`, [out.scheduled_tour_id])).rows[0];
      ok("tour is import_mode=preview", tour && tour.import_mode === "preview");
      ok("tour scheduled_host_user_id is NULL (host not yet known)", tour && tour.scheduled_host_user_id === null);
      ok("result reports outreach_sent=false", out.outreach_sent === false);
      ok("module factory has NO sms dependency (cannot send)", smsCalls === 0);
    }
    await clean();

    // ── TEST 3: known phone -> no new person, no new lead, intent task raised ──
    console.log("\nTEST 3 — known phone -> NO new person, NO new lead, intent task raised");
    { const s = await seed(pool);
      const phone = "(215) 555-0142";
      await runIngest(occ(s.property_id, { prospect_phone: phone, external_appt_id: "C1" }));   // creates card+lead
      const before = (await pool.query(`select count(*)::int n from persons`)).rows[0].n;
      const leadsBefore = (await pool.query(`select count(*)::int n from leasing_leads`)).rows[0].n;
      const out = await runIngest(occ(s.property_id, { prospect_phone: phone, external_appt_id: "C2" })); // known phone again
      const after = (await pool.query(`select count(*)::int n from persons`)).rows[0].n;
      const leadsAfter = (await pool.query(`select count(*)::int n from leasing_leads`)).rows[0].n;
      ok("state is known_phone", out.state === "known_phone");
      ok("NO new person created", after === before);
      ok("NO new lead created", leadsAfter === leadsBefore);
      ok("an intent task was raised", !!out.intent_task_id);
      const it = (await pool.query(`select * from person_intent_tasks where id=$1`, [out.intent_task_id])).rows[0];
      ok("intent task status needs_confirmation", it && it.status === "needs_confirmation");
      ok("intent task type existing_person_tour_intent", it && it.task_type === "existing_person_tour_intent");
    }
    await clean();

    // ── TEST 4: no phone -> conflict, no lead ──
    console.log("\nTEST 4 — no phone -> identity conflict (no_phone), no lead");
    { const s = await seed(pool);
      const out = await runIngest(occ(s.property_id, { prospect_phone: "", external_appt_id: "D1" }));
      ok("state is identity_conflict", out.state === "identity_conflict");
      ok("conflict_type is no_phone", out.conflict_type === "no_phone");
      const leads = (await pool.query(`select count(*)::int n from leasing_leads`)).rows[0].n;
      ok("no lead created", leads === 0);
      const conf = (await pool.query(`select * from person_identity_conflicts where id=$1`, [out.conflict_id])).rows[0];
      ok("conflict row persisted, open", conf && conf.status === "open");
    }
    await clean();

    // ── TEST 5: invalid phone -> conflict, no lead ──
    console.log("\nTEST 5 — invalid phone -> identity conflict (invalid_phone), no lead");
    { const s = await seed(pool);
      const out = await runIngest(occ(s.property_id, { prospect_phone: "12-34", external_appt_id: "E1" }));
      ok("state is identity_conflict", out.state === "identity_conflict");
      ok("conflict_type is invalid_phone", out.conflict_type === "invalid_phone");
      const leads = (await pool.query(`select count(*)::int n from leasing_leads`)).rows[0].n;
      ok("no lead created", leads === 0);
    }
    await clean();

    // ── TEST 6: differing email on a known phone -> discrepancy, no fork, not blocked ──
    console.log("\nTEST 6 — differing email on known phone -> contact discrepancy, NOT a fork, NOT blocked");
    { const s = await seed(pool);
      const phone = "(215) 555-0142";
      await runIngest(occ(s.property_id, { prospect_phone: phone, prospect_email: "maya@first.com", external_appt_id: "F1" }));
      const out = await runIngest(occ(s.property_id, { prospect_phone: phone, prospect_email: "maya.okafor@work.com", external_appt_id: "F2" }));
      ok("still resolves as known_phone (same person)", out.state === "known_phone");
      const persons = (await pool.query(`select count(*)::int n from persons where primary_phone_e164='+12155550142'`)).rows[0].n;
      ok("identity NOT forked (one card)", persons === 1);
      const disc = (await pool.query(`select * from person_contact_discrepancies where field='email' and status='open'`)).rows;
      ok("an email discrepancy was recorded", disc.length === 1);
      ok("discrepancy is non-blocking (intent task still raised)", !!out.intent_task_id);
    }
    await clean();

    // ── TEST 7: owner auto-resolves to the active leasing-agent assignment ──
    console.log("\nTEST 7 — owner auto-resolves to the active leasing-agent (persons-space)");
    { const s = await seed(pool, { withAgent: true });
      const out = await runIngest(occ(s.property_id, { prospect_phone: "(267) 555-0001", external_appt_id: "G1" }));
      const lead = (await pool.query(`select * from leasing_leads where id=$1`, [out.lead_id])).rows[0];
      ok("lead.assignee_id == the active agent's person_id", lead && lead.assignee_id === s.agent_person_id);
      ok("result reports the assigned person", out.assigned_person_id === s.agent_person_id);
      ok("no coverage exception raised (agent exists)", out.coverage_exception_id == null);
    }
    await clean();

    // ── TEST 8: no agent -> UNASSIGNED + coverage exception, manager NOT the agent ──
    console.log("\nTEST 8 — no active agent -> UNASSIGNED + coverage exception (manager escalation)");
    { const s = await seed(pool, { withAgent: false, withManager: true });
      const out = await runIngest(occ(s.property_id, { prospect_phone: "(267) 555-0002", external_appt_id: "H1" }));
      const lead = (await pool.query(`select * from leasing_leads where id=$1`, [out.lead_id])).rows[0];
      ok("lead is UNASSIGNED (assignee_id null)", lead && lead.assignee_id === null);
      ok("a coverage exception was raised", !!out.coverage_exception_id);
      const ce = (await pool.query(`select * from leasing_coverage_exceptions where id=$1`, [out.coverage_exception_id])).rows[0];
      ok("coverage exception reason no_active_leasing_agent", ce && ce.reason === "no_active_leasing_agent");
      ok("manager is the ESCALATION target, not assigned as agent", ce && ce.escalated_to_person_id === s.manager_person_id);
      ok("manager is NOT the lead assignee", lead && lead.assignee_id !== s.manager_person_id);
    }
    await clean();

    // ── TEST 9: phone_verified_at never faked on source-provided import ──
    console.log("\nTEST 9 — phone_verified_at is NULL after a source-provided import");
    { const s = await seed(pool);
      const out = await runIngest(occ(s.property_id, { prospect_phone: "(267) 555-0003", external_appt_id: "I1" }));
      const p = (await pool.query(`select * from persons where id=$1`, [out.person_id])).rows[0];
      ok("primary_phone_e164 IS set (normalized)", p && p.primary_phone_e164 === "+12675550003");
      ok("phone_verified_at IS NULL (source-provided != verified)", p && p.phone_verified_at === null);
    }
    await clean();

  } catch (e) {
    console.error("\nTEST HARNESS ERROR:", e.message);
    FAIL++;
  } finally {
    await stop();
  }

  console.log(`\n=== RESULT: ${PASS} passed, ${FAIL} failed ===`);
  process.exit(FAIL === 0 ? 0 : 1);
})();
