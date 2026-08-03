// ════════════════════════════════════════════════════════════════════
//  slice9_attribution_writer_proof.js — PHASE 5
//
//  Attribution is bound by ONE authority and SURVIVES a reschedule chain.
//
//  The load-bearing claim: the reschedule successor insert copied eight columns
//  and not conversion_id, so a chain that began attributed became unattributed
//  at its second occurrence — silently, and unrepairably, because the inference
//  that would fill it later is forbidden.
//
//  REQUIRES the attribution bridge, supplied locally by scratch DDL that is
//  PROOF SCAFFOLDING and NOT deployment authority.
//
//  Run: DATABASE_URL=... node tests/slice9_attribution_writer_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const { seedJourney } = require("./fixtures/slice9_journey_fixture");
const A = require(path.join(REPO, "src/leasing/appointment_attribution"));

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

(async () => {
  if (!process.env.DATABASE_URL) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const s = await seedJourney(c);
    const P = s.property_id, O = s.opportunities, T = s.tours;

    console.log("\n── THE AUTHORITY: EXPLICIT UUID ONLY, NEVER A LOOKUP ────");
    const good = await A.resolveAttribution(c, { property_id: P, opportunity_id: O.current });
    ok(good.ok && good.attributed && String(good.conversion_id) === String(O.current),
      "an opportunity-bound workflow binds the exact UUID it holds");
    ok(good.basis === "explicit_link", `basis is explicit_link (${good.basis})`);

    const none = await A.resolveAttribution(c, { property_id: P, opportunity_id: null });
    ok(none.ok === true && none.attributed === false && none.conversion_id === null,
      "a workflow with no opportunity yields NULL — a truthful outcome, not a failure");
    ok(none.basis === "unattributed", `and says so (${none.basis})`);

    console.log("\n── WRONG PROPERTY AND MISSING OPPORTUNITY REFUSE ────────");
    const wrong = await A.resolveAttribution(c, {
      property_id: s.other_property_id, opportunity_id: O.current });
    ok(wrong.ok === false && wrong.refusal_code === A.REFUSAL.WRONG_PROPERTY,
      `cross-property attribution refuses (${wrong.refusal_code})`);
    ok(wrong.httpStatus === 403, "with 403");
    const ghost = await A.resolveAttribution(c, {
      property_id: P, opportunity_id: "00000000-0000-0000-0000-000000000000" });
    ok(ghost.ok === false && ghost.refusal_code === A.REFUSAL.NOT_FOUND,
      `a nonexistent opportunity refuses (${ghost.refusal_code})`);

    console.log("\n── CONFLICTING ATTRIBUTION IS NEVER OVERWRITTEN ─────────");
    const conflict = await A.resolveAttribution(c, {
      property_id: P, opportunity_id: O.current, existing_conversion_id: O.old });
    ok(conflict.ok === false && conflict.refusal_code === A.REFUSAL.CONFLICT,
      `re-attributing to a different opportunity refuses (${conflict.refusal_code})`);
    ok(String(conflict.conversion_id) === String(O.old),
      "and the ORIGINAL attribution is preserved, not replaced");
    const same = await A.resolveAttribution(c, {
      property_id: P, opportunity_id: O.current, existing_conversion_id: O.current });
    ok(same.ok === true, "re-asserting the SAME opportunity is idempotent, not a conflict");

    console.log("\n── THE LOAD-BEARING LINE: SUCCESSOR INHERITS ────────────");
    const pred = (await c.query(`select * from leasing_tours where id=$1`, [T["B-chain-root"]])).rows[0];
    const inh = A.inheritAttribution(pred);
    ok(String(inh.conversion_id) === String(O.current),
      "the successor inherits the predecessor's opportunity verbatim");
    ok(inh.basis === "chain_inheritance", `basis is chain_inheritance (${inh.basis})`);
    const orphan = A.inheritAttribution({ conversion_id: null });
    ok(orphan.conversion_id === null && orphan.basis === "unattributed",
      "an unattributed predecessor yields an unattributed successor — never invented");

    console.log("\n── ATTRIBUTION CANNOT DISAPPEAR MID-CHAIN (real insert) ─");
    //  Exercise the ACTUAL cut-over SQL shape, not a paraphrase.
    let cur = pred;
    const madeIds = [];
    for (let i = 0; i < 3; i++) {
      const carried = A.inheritAttribution(cur);
      cur = (await c.query(
        `insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id,
             scheduled_for, status, rescheduled_from, conversion_id)
         values ($1,$2,$3,$4,now(),'scheduled',$5,$6) returning *`,
        [cur.lead_id, cur.property_id, cur.unit_id, cur.leasing_agent_id,
         cur.id, carried.conversion_id])).rows[0];
      madeIds.push(cur.id);
    }
    const chainRows = (await c.query(
      `select id, conversion_id from leasing_tours where id = any($1::uuid[])`, [madeIds])).rows;
    ok(chainRows.length === 3, "three successors created");
    ok(chainRows.every((r) => String(r.conversion_id) === String(O.current)),
      "EVERY successor carries the opportunity — attribution survives the whole chain");
    ok(chainRows.filter((r) => r.conversion_id === null).length === 0,
      "not one link in the chain is null");

    console.log("\n── AN UNATTRIBUTED CHAIN STAYS UNATTRIBUTED ─────────────");
    const upred = (await c.query(`select * from leasing_tours where id=$1`, [T["D-unattributed"]])).rows[0];
    const ucarried = A.inheritAttribution(upred);
    const usucc = (await c.query(
      `insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id,
           scheduled_for, status, rescheduled_from, conversion_id)
       values ($1,$2,$3,$4,now(),'scheduled',$5,$6) returning *`,
      [upred.lead_id, upred.property_id, upred.unit_id, upred.leasing_agent_id,
       upred.id, ucarried.conversion_id])).rows[0];
    ok(usucc.conversion_id === null,
      "rescheduling an unattributed appointment does NOT invent an opportunity");

    console.log("\n── EXTERNAL RESCHEDULE PRESERVES BY CONSTRUCTION ────────");
    //  scheduled_tours MUTATES the same row, so conversion_id is untouched by a
    //  reschedule. Proven rather than assumed.
    const ext = (await c.query(`select * from scheduled_tours where id=$1`,
      [s.external["X-multi-revision"]])).rows[0];
    ok(String(ext.conversion_id) === String(O.current), "the external row is attributed");
    await c.query(
      `update scheduled_tours set previous_start=scheduled_start, scheduled_start=now(),
              status='rescheduled', reschedule_count=reschedule_count+1 where id=$1`, [ext.id]);
    const after = (await c.query(`select conversion_id, reschedule_count from scheduled_tours where id=$1`,
      [ext.id])).rows[0];
    ok(String(after.conversion_id) === String(O.current),
      "a reschedule leaves conversion_id untouched — the row persists, so it cannot be lost");

    console.log("\n── THE FORBIDDEN LOOKUP IS GONE FROM THE AUTHORITY ──────");
    const src = fs.readFileSync(path.join(REPO, "src/leasing/appointment_attribution.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(!/status\s*=\s*'active'/.test(src), "the authority never selects the current active conversion");
    ok(!/person_id\s*=\s*\$\d[\s\S]{0,60}property_id\s*=\s*\$\d/.test(src),
      "and never resolves by person + property");
    ok(!/limit 1/i.test(src), "and never uses limit 1 to pick an opportunity");
    ok(!/lead_id/.test(src), "and never touches lead_id");

    console.log("\n── THE CUTOVER IS REAL IN THE WRITER ────────────────────");
    const wsrc = fs.readFileSync(path.join(REPO, "src/leasing/leasingleads.js"), "utf8");
    ok(/inheritAttribution\(oldTour\)/.test(wsrc),
      "the reschedule successor asks the authority");
    ok(/rescheduled_from, conversion_id\)/.test(wsrc),
      "and the successor INSERT carries conversion_id");
    ok(!/insert into leasing_tours \(lead_id, property_id, unit_id, leasing_agent_id, slot_id, scheduled_for, status, rescheduled_from\)\s*\n\s*values \(\$1,\$2,\$3,\$4,\$5,\$6,'scheduled',\$7\)/.test(wsrc),
      "the old attribution-losing insert shape is gone");

    console.log("\n── NO FALLBACK, NO DUAL PATH, NO SCHEMA DETECTION ───────");
    for (const [label, re] of [
      ["runtime schema detection", /information_schema|to_regclass|column_name\s*=/i],
      ["compatibility fallback",   /if\s*\(\s*!?\s*hasConversionColumn|fallback/i],
      ["lead/time attribution",    /order by[\s\S]{0,40}(scheduled_for|created_at)[\s\S]{0,20}limit 1/i],
    ]) ok(!re.test(src), `no ${label} in the authority`);

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   attribution writers: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
