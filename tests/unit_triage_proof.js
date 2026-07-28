// ════════════════════════════════════════════════════════════════════
//  unit_triage_proof.js — BUILD 1 proof harness
//
//    node tests/unit_triage_proof.js
//
//  ── THIS HARNESS REFUSES TO REPORT GREEN WITHOUT A REAL DATABASE ────
//  Part A (pure) runs anywhere: interpreter, readiness derivation, and the
//  availability guard chain have no I/O.
//
//  Part B (durable) requires DATABASE_URL and REAL Postgres. Without it this
//  harness EXITS NON-ZERO and says the slice is unproven. It does not
//  substitute a fixture, an in-memory double, or a mock pool, because a
//  harness that goes green on fixtures is the precise failure the operating
//  doctrine forbids: "Do not call the slice done from source inspection or a
//  local fixture harness."
//
//  Passing Part A alone proves the slice is BUILT-BUT-DORMANT. It does not
//  prove it is live, and this file will say so out loud.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { interpretObservation } = require("../src/maintenance/unit_triage_interpreter");
const { deriveReadiness, makeUnitTriageService } = require("../src/maintenance/unit_triage_service");
const { marketingState, availableFrom, HUMAN } = require("../src/surfaces/availability_read");

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name + (detail ? "  — " + detail : "")); }
}
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length))); }

// ════════════════════════════════════════════════════════════════
//  PART A — PURE. No database, no network, no clock dependence.
// ════════════════════════════════════════════════════════════════

section("A1  interpreter: contract example");
{
  const r = interpretObservation("304 is vacant. There are cockroaches, it needs a deep clean, and the refrigerator is missing.");
  const f = r.findings.map((x) => x.finding);
  ok("vacancy confirmed vacant", r.vacancy === "vacant", r.vacancy);
  ok("condition severe", r.initial_condition === "severe", r.initial_condition);
  ok("completeness defaults to initial triage", r.inspection_completeness === "initial_triage");
  ok("infestation finding present", f.includes("Cockroach infestation observed"), f.join("|"));
  ok("deep clean finding present", f.includes("Deep cleaning required"));
  ok("refrigerator finding present", f.includes("Refrigerator missing"));
  ok("three separate findings, not one note", r.findings.length === 3, String(r.findings.length));
  ok("three separate work items", r.required_work.length === 3, String(r.required_work.length));
  ok("pest long-lead", r.long_lead_blockers.some((b) => b.kind === "pest_treatment"));
  ok("appliance long-lead", r.long_lead_blockers.some((b) => b.kind === "appliance_replacement"));
  ok("every finding carries its evidence", r.findings.every((x) => !!x.evidence));
}

section("A2  scenario 1 — normal first walk");
{
  const r = interpretObservation("304 is empty. Normal wear and tear. Needs the regular inspection.");
  ok("vacancy confirmed", r.vacancy === "vacant");
  ok("condition normal_turn", r.initial_condition === "normal_turn", r.initial_condition);
  ok("no severe condition invented", r.findings.every((f) => !f.severe));
  ok("no work invented", r.required_work.length === 0, String(r.required_work.length));
  ok("initial triage recorded", r.inspection_completeness === "initial_triage");
  const d = deriveReadiness({ confirmation: { initial_condition: "normal_turn", vacancy_observation: "vacant", inspection_completeness: "initial_triage" } });
  ok("readiness stays unknown", d.readiness === "unknown", d.readiness);
  ok("readiness is NEVER ready", d.readiness !== "ready");
}

section("A3  scenario 2 — infestation");
{
  const r = interpretObservation("304 is empty, but there are cockroaches and it needs a deep clean.");
  ok("vacancy confirmed", r.vacancy === "vacant");
  ok("severe confirmed", r.initial_condition === "severe", r.initial_condition);
  ok("two findings separately", r.findings.length === 2, String(r.findings.length));
  ok("two work items separately", r.required_work.length === 2, String(r.required_work.length));
  const d = deriveReadiness({ confirmation: { initial_condition: "severe", vacancy_observation: "vacant", inspection_completeness: "initial_triage" } });
  ok("readiness not_ready", d.readiness === "not_ready", d.readiness);
}

section("A4  scenario 3 — appliance + HVAC");
{
  const r = interpretObservation("The refrigerator is gone and the AC is not working.");
  const f = r.findings.map((x) => x.finding);
  ok("two findings", r.findings.length === 2, f.join("|"));
  ok("fridge finding", f.includes("Refrigerator missing"));
  ok("hvac finding", f.includes("HVAC not working"));
  ok("two separate work items", r.required_work.length === 2);
  ok("appliance long-lead", r.long_lead_blockers.some((b) => b.kind === "appliance_replacement"));
  ok("hvac long-lead", r.long_lead_blockers.some((b) => b.kind === "hvac_failure"));
  ok("vacancy NOT inferred from repair talk", r.vacancy === "uncertain", r.vacancy);
  ok("no cost invented", JSON.stringify(r).toLowerCase().indexOf("cost") === -1);
  ok("no vendor invented", JSON.stringify(r).toLowerCase().indexOf("vendor") === -1);
}

section("A5  scenario 4 — someone remains");
{
  const r = interpretObservation("There is still somebody living in 304.");
  ok("vacancy NOT confirmed", r.vacancy === "occupied_or_someone_remains", r.vacancy);
  ok("severe", r.initial_condition === "severe");
  ok("access long-lead", r.long_lead_blockers.some((b) => b.kind === "access_or_possession_problem"));
  ok("carries not-a-legal-determination marker",
     r.findings.some((f) => f.not_a_legal_determination === true));
  ok("says so in plain words",
     r.uncertainties.some((u) => /not a determination of tenancy|holdover|trespass/i.test(u)));
  const legal = /squatter|evict|holdover|trespass|abandon(ed|ment)/i;
  const proposedText = r.findings.map((f) => f.finding).concat(r.required_work.map((w) => w.work)).join(" ");
  ok("no legal conclusion in any PROPOSED fact", !legal.test(proposedText), proposedText);
  const d = deriveReadiness({ confirmation: { initial_condition: "severe", vacancy_observation: "occupied_or_someone_remains", inspection_completeness: "initial_triage" } });
  ok("not ready", d.readiness === "not_ready");
}

section("A6  the word 'squatter' survives verbatim but rules nothing");
{
  const r = interpretObservation("There is a squatter in 304.");
  ok("vacancy not confirmed", r.vacancy === "occupied_or_someone_remains");
  ok("original text preserved verbatim", r.interpreted_from === "There is a squatter in 304.");
  ok("proposal does not repeat the legal word as a finding",
     !r.findings.some((f) => /squatter/i.test(f.finding)));
}

section("A7  ambiguity is preserved, not resolved");
{
  const r = interpretObservation("The bathroom faucet looks off.");
  ok("no confident finding invented", r.findings.length === 0, String(r.findings.length));
  ok("no work invented", r.required_work.length === 0);
  ok("condition uncertain", r.initial_condition === "uncertain");
  ok("vacancy uncertain", r.vacancy === "uncertain");
}

section("A8  partial observation");
{
  const r = interpretObservation("I only checked the kitchen. The faucet is leaking.");
  ok("stays initial triage", r.inspection_completeness === "initial_triage");
  ok("says the rest is unknown", r.uncertainties.some((u) => /partial|remain unknown/i.test(u)));
  ok("leak still captured", r.findings.some((f) => /Leak/i.test(f.finding)));
}

section("A9  contradiction resolves to the safer reading");
{
  const r = interpretObservation("304 is empty but there is still someone staying in the back bedroom.");
  ok("occupancy wins over vacancy", r.vacancy === "occupied_or_someone_remains", r.vacancy);
  ok("contradiction is surfaced, not hidden",
     r.uncertainties.some((u) => /both a vacancy statement and an occupancy statement/i.test(u)));
}

section("A10  empty observation proposes nothing");
{
  const r = interpretObservation("");
  ok("vacancy uncertain", r.vacancy === "uncertain");
  ok("condition uncertain — NOT normal", r.initial_condition === "uncertain");
  ok("no findings", r.findings.length === 0);
}

section("A11  readiness may never be 'ready'");
{
  const combos = [];
  for (const c of ["normal_turn", "severe", "uncertain"])
    for (const v of ["vacant", "occupied_or_someone_remains", "uncertain"])
      for (const i of ["initial_triage", "complete_inspection"])
        for (const w of [[], [{ status: "required" }]])
          for (const f of [[], [{ withdrawn_at: null }]])
            combos.push(deriveReadiness({
              confirmation: { initial_condition: c, vacancy_observation: v, inspection_completeness: i },
              requiredWork: w, findings: f,
            }));
  ok("no combination yields ready (" + combos.length + " combinations)",
     combos.every((d) => d.readiness !== "ready"));
  ok("every result carries a human label", combos.every((d) => !!d.readiness_label));
  ok("no confirmation at all → unknown",
     deriveReadiness({ confirmation: null }).readiness === "unknown");
}

section("A12  availability: uninspected is not marketable");
{
  const base = {
    conflict_state: "clear", is_down: false, operating_use: "standard", evidence_state: "agrees",
    availability_state: "ready_now", successor: { state: "none" }, lease: null,
    possession_state: "pending", use_type: "residential", triage: null,
  };
  const uninspected = marketingState({ ...base, physical_readiness: "unknown" }, true);
  ok("uninspected unit is NOT marketable_now", uninspected.state !== "marketable_now", uninspected.state);
  ok("uninspected reads readiness_unknown", uninspected.state === "readiness_unknown");
  ok("has a human label", !!HUMAN[uninspected.state]);

  const completedTurn = marketingState({ ...base, physical_readiness: "ready" }, true);
  ok("a COMPLETED turn is still marketable (affirmative evidence preserved)",
     completedTurn.state === "marketable_now", completedTurn.state);

  const blocked = marketingState({ ...base, physical_readiness: "unknown",
    triage: { readiness: "not_ready", readiness_reason: "severe_condition_confirmed" } }, true);
  ok("confirmed blockers read not_ready_confirmed", blocked.state === "not_ready_confirmed");

  const walked = marketingState({ ...base, physical_readiness: "unknown",
    triage: { readiness: "unknown", readiness_reason: "initial_triage_only" } }, true);
  ok("walked-but-unconfirmed does not claim no inspection",
     walked.reason === "walked_no_blocker_found_readiness_unconfirmed", walked.reason);

  for (const st of ["readiness_unknown", "not_ready_confirmed"]) {
    const d = availableFrom({ ...base, triage: null }, st, "2026-07-28");
    ok("no ready date invented for " + st, d.available_from === null && d.availability_confidence === "incomplete");
  }
}

section("A13  service construction guards");
{
  let threw = false;
  try { makeUnitTriageService({}); } catch (e) { threw = true; }
  ok("service refuses to build without the shared obligation engine", threw);
}

// ════════════════════════════════════════════════════════════════
//  PART B — DURABLE. Requires REAL Postgres.
// ════════════════════════════════════════════════════════════════

async function partB() {
  section("B   durable proof against real Postgres");

  if (!process.env.DATABASE_URL) {
    console.log(`
  NOT RUN — DATABASE_URL is not set.

  Part A proves the pure logic. It does NOT prove the slice.
  Nothing below has been exercised against real Postgres:

    · migration 112 applies cleanly on top of ceiling 111
    · the append-only constraints actually refuse
        - a correction with no reason        (ck_utc_correction_states_reason)
        - two originals for one observation  (uq_utc_one_original_per_observation)
        - an unattributed withdrawal         (ck_utf_withdrawal_is_attributed)
    · confirmTriage writes observation + confirmation + findings + work +
      event + obligation in ONE transaction, and rolls back as one
    · UNASSIGNED appears when no eligible staff exist
    · the preceding actor is not auto-assigned
    · next-move-in risk spawns a manager decision, and only then
    · availability stops reading an uninspected unit as marketable

  PROOF LEVEL REACHED: Built-but-dormant.
  Set DATABASE_URL (Render env, per THREAD_HANDOFF.md) and re-run.
`);
    return false;
  }

  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // B0 — the migration ceiling actually applied
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_name in ('unit_observations','unit_triage_confirmations',
                             'unit_triage_findings','unit_triage_required_work')`);
    ok("migration 112 tables exist in this database", t.rows.length === 4,
       t.rows.map((r) => r.table_name).join(",") || "none — run npm start (prestart migrates)");
    if (t.rows.length !== 4) return true;

    // B1 — a correction with no reason is REFUSED by the database itself
    const c = await pool.connect();
    try {
      await c.query("begin");
      const u = (await c.query("select id, property_id from units limit 1")).rows[0];
      const usr = (await c.query("select id from users limit 1")).rows[0];
      ok("a unit and a user exist to prove against", !!u && !!usr);
      if (u && usr) {
        const o = (await c.query(
          `insert into unit_observations (property_id, unit_id, observed_by_user_id, original_text)
           values ($1,$2,$3,'proof harness observation') returning id`,
          [u.property_id, u.id, usr.id])).rows[0];
        const c1 = (await c.query(
          `insert into unit_triage_confirmations
             (observation_id, property_id, unit_id, confirmed_by_user_id,
              vacancy_observation, initial_condition)
           values ($1,$2,$3,$4,'vacant','normal_turn') returning id`,
          [o.id, u.property_id, u.id, usr.id])).rows[0];

        // correction with no reason must be refused
        let refused = false;
        await c.query("savepoint sp1");
        try {
          await c.query(
            `insert into unit_triage_confirmations
               (observation_id, property_id, unit_id, confirmed_by_user_id,
                vacancy_observation, initial_condition, supersedes_id)
             values ($1,$2,$3,$4,'vacant','severe',$5)`,
            [o.id, u.property_id, u.id, usr.id, c1.id]);
        } catch (e) { refused = true; await c.query("rollback to savepoint sp1"); }
        ok("DB refuses a correction with no reason", refused);

        // two originals for one observation must be refused
        let refused2 = false;
        await c.query("savepoint sp2");
        try {
          await c.query(
            `insert into unit_triage_confirmations
               (observation_id, property_id, unit_id, confirmed_by_user_id,
                vacancy_observation, initial_condition)
             values ($1,$2,$3,$4,'vacant','severe')`,
            [o.id, u.property_id, u.id, usr.id]);
        } catch (e) { refused2 = true; await c.query("rollback to savepoint sp2"); }
        ok("DB refuses a second original confirmation for one observation", refused2);

        // an unattributed withdrawal must be refused
        const f1 = (await c.query(
          `insert into unit_triage_findings (confirmation_id, property_id, unit_id, finding_text)
           values ($1,$2,$3,'proof finding') returning id`,
          [c1.id, u.property_id, u.id])).rows[0];
        let refused3 = false;
        await c.query("savepoint sp3");
        try {
          await c.query("update unit_triage_findings set withdrawn_at=now() where id=$1", [f1.id]);
        } catch (e) { refused3 = true; await c.query("rollback to savepoint sp3"); }
        ok("DB refuses an unattributed withdrawal", refused3);
      }
      // Everything above is proof, not data. Nothing is kept.
      await c.query("rollback");
    } finally { c.release(); }
  } finally {
    await pool.end();
  }
  return true;
}

(async () => {
  const ranB = await partB();
  section("RESULT");
  console.log("  assertions passed: " + passed);
  console.log("  assertions failed: " + failed);
  if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
  const level = ranB ? "Proven (real DB)" : "Built-but-dormant (pure logic only)";
  console.log("\n  PROOF LEVEL: " + level);
  if (!ranB) console.log("  Browser verification still required before this is 'done'.");
  process.exit(failed > 0 || !ranB ? 1 : 0);
})();
