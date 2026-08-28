#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  obligation_completion_canonical_proof.db.js
//
//  WHY THIS EXISTS. The unsafe HTTP doors `PATCH /obligations/:id/
//  {satisfy,complete}` were removed — they sat behind the portfolio-wide
//  shared key with no property, module or actor authority, and had no
//  product caller. The deployed smoke suite used to prove completion
//  invariants THROUGH those doors.
//
//  Removing a door must not lower the proof boundary. The BUSINESS proof
//  moves here, against the canonical services and real Postgres. The
//  DEPLOYED boundary proof stays in the smoke suite, where it now proves
//  the legacy doors are gone and the authenticated surface works.
//
//  This harness proves completeObligation and satisfyObligation directly.
//  It creates no HTTP route and asks for none.
//
//  ISOLATION via receipt.harnessConnectionString().
// ════════════════════════════════════════════════════════════════════

"use strict";

const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");

const EXPECTED_ASSERTIONS = 12;
const CONN = receipt.harnessConnectionString();

let pass = 0, fail = 0;
function T(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }

const pool = new Pool({ connectionString: CONN });
const TAG = "oblig-complete-" + process.pid;

//  Run one service call in its own transaction, returning either the
//  result or the thrown error — completion is transactional, so each case
//  must be independent.
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return { ok: true, out };
  } catch (e) {
    try { await c.query("rollback"); } catch (_) {}
    return { ok: false, err: e };
  } finally { c.release(); }
}

(async () => {
  receipt.begin(__filename, { url: CONN, expected: EXPECTED_ASSERTIONS });
  const engine = require("../../src/shared/obligation_engine.js");

  const c = await pool.connect();
  let P, person;
  try {
    await c.query("begin");
    P = (await c.query(`insert into properties (name) values ($1) returning id`, [TAG])).rows[0].id;
    person = (await c.query(
      `insert into persons (name, lifecycle_status, source) values ('Completion Proof','prospect',$1) returning id`,
      [TAG])).rows[0].id;
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  const mkOb = async (over = {}) => {
    const r = await pool.query(
      `insert into obligations (property_id, person_id, module, type, label, owner_type, status, required_inputs, related_id, related_type)
       values ($1,$2,$3,$4,$5,'human','open',$6,$7,$8) returning id`,
      [P, person, over.module || "maintenance", over.type || "smoke_check",
       over.label || "completion proof", over.required_inputs || [],
       over.related_id || null, over.related_type || null]);
    return r.rows[0].id;
  };
  const read = async (id) => (await pool.query(`select * from obligations where id=$1`, [id])).rows[0];

  // ── 1. a plain obligation completes through the canonical engine ───
  {
    const id = await mkOb();
    const r = await tx((cl) => engine.completeObligation(cl, { obligation_id: id, completed_by: "canonical proof" }));
    T("K1  a non-conversion obligation completes via the canonical engine", () => ok(r.ok, r.err && r.err.message));
    const row = await read(id);
    T("K2  the completed record is correct — status and completed_at", () => {
      eq(row.status, "complete");
      ok(row.completed_at, "completed_at must be stamped");
    });
  }

  // ── 2. required inputs BLOCK premature completion ──────────────────
  let gated;
  {
    gated = await mkOb({ required_inputs: ["proof_photo"] });
    const r = await tx((cl) => engine.completeObligation(cl, { obligation_id: gated }));
    T("K3  required inputs BLOCK premature completion", () => {
      ok(!r.ok, "expected a refusal");
      eq(r.err.code, "INPUTS_OUTSTANDING");
    });
    T("K4  the refusal NAMES what is still owed", () => {
      ok(Array.isArray(r.err.outstanding_inputs) && r.err.outstanding_inputs.includes("proof_photo"),
        "outstanding_inputs: " + JSON.stringify(r.err.outstanding_inputs));
    });
    const row = await read(gated);
    T("K5  a blocked completion leaves the row untouched — no partial write", () => {
      eq(row.status, "open");
      ok(!row.completed_at, "completed_at must remain null");
    });
  }

  // ── 3. satisfying the input PERMITS completion ─────────────────────
  {
    const s = await tx((cl) => engine.satisfyObligation(cl, {
      obligation_id: gated, input: "proof_photo", proof: { note: "canonical proof" } }));
    T("K6  satisfying a required input succeeds", () => ok(s.ok, s.err && s.err.message));
    T("K7  nothing remains outstanding afterwards", () => eq(s.out.remaining.length, 0));
    const r = await tx((cl) => engine.completeObligation(cl, { obligation_id: gated }));
    T("K8  completion is now permitted", () => ok(r.ok, r.err && r.err.message));
    eq((await read(gated)).status, "complete");
    pass++; console.log("  ✓ K9  the row is complete after satisfy → complete");
  }

  // ── 4. already-complete behaviour ──────────────────────────────────
  {
    const r = await tx((cl) => engine.completeObligation(cl, { obligation_id: gated }));
    T("K10 completing an already-complete obligation is refused", () => {
      ok(!r.ok); eq(r.err.code, "ALREADY_COMPLETE");
    });
  }

  // ── 5. conversion-linked work refuses the generic path ─────────────
  {
    const hasRail = (await pool.query(
      `select to_regclass('leasing_conversion_obligations') is not null as t`)).rows[0].t;
    if (!hasRail) {
      T("K11 conversion-rail refusal — SKIPPED, table absent in this schema", () => {
        throw new Error("leasing_conversion_obligations missing; this case cannot be proven here");
      });
    } else {
      //  leasing_conversions requires real host/owner users (NOT NULL).
      const host = (await pool.query(
        `insert into users (name,email,phone,role,is_active,status)
         values ('Rail Host',$1,$2,'leasing_agent',true,'active') returning id`,
        [TAG + "-host@proof.test",
         "+1724555" + String(Math.floor(Math.random() * 9000 + 1000))])).rows[0].id;
      const conv = (await pool.query(
        `insert into leasing_conversions
           (person_id, property_id, current_stage, status,
            scheduled_tour_host_user_id, actual_tour_host_user_id,
            feedback_recorded_by_user_id, conversation_owner_user_id)
         values ($1,$2,'tour_followup','active',$3,$3,$3,$3) returning id`, [person, P, host])).rows[0].id;
      const anchor = await mkOb({ module: "leasing", type: "tour_followup",
        label: "rail-linked", related_id: conv, related_type: "leasing_conversion" });
      await pool.query(
        `insert into leasing_conversion_obligations (conversion_id, obligation_id, rung, due_by)
         values ($1,$2,'tour_followup', now() + interval '1 day')`, [conv, anchor]);
      const r = await tx((cl) => engine.completeObligation(cl, { obligation_id: anchor }));
      T("K11 conversion-linked work REFUSES the generic completion path", () => {
        ok(!r.ok, "expected the rail to refuse");
        eq(r.err.code, "CONVERSION_RAIL_REQUIRED");
      });
      const row = await read(anchor);
      T("K12 the rail refusal leaves the obligation open — no partial completion", () => {
        eq(row.status, "open");
        ok(!row.completed_at, "completed_at must remain null after a rail refusal");
      });
    }
  }

  await pool.end();
  process.exit(receipt.complete({
    harness: __filename, passed: pass, failed: fail, expectedAtLeast: EXPECTED_ASSERTIONS,
  }));
})().catch(async (e) => {
  try { await pool.end(); } catch (_) {}
  receipt.died(__filename, e, pass + fail);
  process.exit(1);
});
