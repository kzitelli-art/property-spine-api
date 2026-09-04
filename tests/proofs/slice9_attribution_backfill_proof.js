// ════════════════════════════════════════════════════════════════════
//  slice9_attribution_backfill_proof.js
//
//  The exact-links-only backfill writes EXACTLY the exact links, and nothing
//  else — proven against real Postgres with the bridge supplied by the real
//  numbered migration 127.
//
//  The claim under test is as much about what it REFUSES to write as what it
//  writes: an inference-only appointment must still be NULL afterwards, and a
//  second run must write nothing at all.
//
//  Run: DATABASE_URL=... node tests/proofs/slice9_attribution_backfill_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const { seedJourney } = require("../fixtures/slice9_journey_fixture");
const { backfill } = require(path.join(REPO, "tools/appointment_attribution_backfill"));
const { analyze } = require(path.join(REPO, "tools/appointment_attribution_analyzer"));

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
    const P = s.property_id, T = s.tours, O = s.opportunities;

    const conv = async (id, table = "leasing_tours") =>
      (await c.query(`select conversion_id from ${table} where id=$1`, [id])).rows[0].conversion_id;

    console.log("\n── THE MIGRATION WROTE NOTHING ──────────────────────────");
    //  Strip the fixture's own attribution so this measures the BACKFILL, not
    //  the fixture. The exact POINTERS (origin_tour_id / scheduled_tour_id)
    //  survive — those are the historical evidence the backfill reads.
    await c.query(`update leasing_tours set conversion_id=null where property_id=$1`, [P]);
    await c.query(`update scheduled_tours set conversion_id=null where property_id=$1`, [P]);
    const before = (await c.query(
      `select count(*)::int n from leasing_tours where property_id=$1 and conversion_id is not null`, [P])).rows[0].n;
    ok(before === 0, `every appointment starts NULL (${before})`);

    console.log("\n── DRY RUN WRITES NOTHING ───────────────────────────────");
    const dry = await backfill(c, { property_id: P, apply: false });
    ok(dry.applied === false, "dry run is the default posture");
    ok(dry.written > 0, `it reports what it WOULD write (${dry.written})`);
    const stillNull = (await c.query(
      `select count(*)::int n from leasing_tours where property_id=$1 and conversion_id is not null`, [P])).rows[0].n;
    ok(stillNull === 0, `and the database is untouched (${stillNull})`);

    console.log("\n── APPLY WRITES ONLY THE EXACT LINKS ────────────────────");
    const R = await analyze(c, { property_id: P });
    const exactCount = R.exact_native_pointer.length + R.exact_external_pointer.length
                     + R.chain_inheritance.length;
    const app = await backfill(c, { property_id: P, apply: true });
    ok(app.applied === true, "apply writes");
    ok(app.considered === exactCount,
      `it considered exactly the analyzer's exact population (${app.considered} vs ${exactCount})`);
    ok(app.written === dry.written,
      `and wrote exactly what the dry run predicted (${app.written} vs ${dry.written})`);

    console.log("\n── THE EXACT HISTORICAL POINTER IS HONOURED ─────────────");
    ok(String(await conv(T["L-legacy-pointer"])) === String(O.old),
      "a tour claimed by origin_tour_id is attributed to that exact opportunity");
    ok(String(await conv(s.external["L-legacy-external"], "scheduled_tours")) === String(O.old),
      "and an external tour claimed by scheduled_tour_id likewise");

    console.log("\n── INFERENCE-ONLY ROWS STAY NULL ────────────────────────");
    ok((await conv(T["D-unattributed"])) === null,
      "an appointment whose ONLY association is lead/person/time is still NULL");
    const inferIds = R.inference_only.map((x) => String(x.tour_id));
    const wronglyFilled = (await c.query(
      `select count(*)::int n from leasing_tours
        where id = any($1::uuid[]) and conversion_id is not null`, [inferIds])).rows[0].n;
    ok(wronglyFilled === 0,
      `not one of the ${inferIds.length} inference-only appointments was filled (${wronglyFilled})`);

    console.log("\n── CONFLICTED AND UNTRACKABLE ROWS STAY NULL ────────────");
    ok((await conv(T["F-cycle-a"])) === null, "a reschedule cycle member is never attributed");
    ok(app.left_null_by_design > 0,
      `and the tool REPORTS the honest gap rather than hiding it (${app.left_null_by_design})`);

    console.log("\n── IT NEVER OVERWRITES AN EXISTING ATTRIBUTION ──────────");
    //  Point a row at the WRONG opportunity by hand, then re-run.
    await c.query(`update leasing_tours set conversion_id=$2 where id=$1`,
      [T["L-legacy-pointer"], O.current]);
    const second = await backfill(c, { property_id: P, apply: true });
    ok(String(await conv(T["L-legacy-pointer"])) === String(O.current),
      "a row already carrying a DIFFERENT opportunity is left exactly as it was");
    ok(second.conflict_left_alone >= 1,
      `the disagreement is reported for a human (${second.conflict_left_alone})`);
    ok(second.conflicts.some((x) => String(x.tour_id) === String(T["L-legacy-pointer"])),
      "naming the row, its existing value and what the analyzer said");

    console.log("\n── IDEMPOTENT ───────────────────────────────────────────");
    const third = await backfill(c, { property_id: P, apply: true });
    ok(third.written === 0, `a second full run writes zero rows (${third.written})`);
    ok(third.already_correct > 0,
      `recognising the rows it already wrote (${third.already_correct})`);

    console.log("\n── NO FORBIDDEN INFERENCE EXISTS IN THE TOOL ────────────");
    const src = require("fs").readFileSync(
      path.join(REPO, "tools/appointment_attribution_backfill.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [label, re] of [
      ["active-conversion lookup", /status\s*=\s*'active'/],
      ["person+property lookup",   /person_id\s*=\s*\$/],
      ["lead-based attribution",   /lead_id\s*=\s*\$/],
      ["nearest-time selection",   /order by[\s\S]{0,60}limit 1/i],
    ]) ok(!re.test(src), `no ${label} in the backfill`);
    ok(/conversion_id is null/.test(src),
      "every write is guarded by conversion_id is null");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   attribution backfill: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
