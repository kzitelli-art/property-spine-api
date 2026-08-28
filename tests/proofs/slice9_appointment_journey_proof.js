// ════════════════════════════════════════════════════════════════════
//  slice9_appointment_journey_proof.js
//
//  The pure appointment-journey projector, against real Postgres.
//
//  REQUIRES the attribution bridge. Until the numbered migration exists it is
//  supplied locally by scratch DDL, which is PROOF SCAFFOLDING and NOT
//  deployment authority. This proof must be replayed from the real migration
//  once the Neon ledger assigns a number.
//
//  Run: DATABASE_URL=... node tests/proofs/slice9_appointment_journey_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const { seedJourney } = require("./fixtures/slice9_journey_fixture");
const { appointmentJourney, OBSERVED, BASIS } =
  require(path.join(REPO, "src/leasing/appointment_journey"));
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
    const P = s.property_id, T = s.tours, X = s.external, O = s.opportunities;
    const J = await appointmentJourney(c, { property_id: P, opportunity_id: O.current });
    const chainOf = (id) => J.chains.find((ch) => String(ch.chain_root_id) === String(id));
    const occOf = (id) => J.chains.flatMap((x) => x.occurrences)
      .find((o) => String(o.occurrence_id) === String(id));

    console.log("\n── PRECONDITION: THE BRIDGE EXISTS ──────────────────────");
    const cols = (await c.query(
      `select table_name from information_schema.columns
        where column_name='conversion_id' and table_name in ('leasing_tours','scheduled_tours')`
    )).rows.map((r) => r.table_name).sort();
    ok(cols.length === 2, `conversion_id present on both appointment tables (${cols.join(", ")})`);

    console.log("\n── 1 · ATTRIBUTED NATIVE COMPLETED APPOINTMENT ──────────");
    const a = occOf(T["A-completed"]);
    ok(!!a, "the completed appointment appears");
    ok(a.observed_state === OBSERVED.ATTENDED, `observed as attended (${a.observed_state})`);
    ok(a.attribution_basis === BASIS.EXPLICIT, `attributed by explicit link (${a.attribution_basis})`);

    console.log("\n── 12 · HOST AND OUTCOME TIED TO THE EXACT OCCURRENCE ───");
    ok(String(a.actual_host_user_id) === String(s.host_user_id),
      "actual host read from the occurrence's own event, not the opportunity");
    ok(String(a.recorded_by_user_id) === String(s.recorder_user_id), "recorder carried");
    ok(!!a.outcome, `outcome carried (${a.outcome})`);

    console.log("\n── 13 · CORRECTED OUTCOME PRESERVES PRIOR TRUTH ─────────");
    ok(a.outcome === "very_interested", `latest capture wins (${a.outcome})`);
    ok(a.corrections.length === 1, `the superseded capture is RETAINED (${a.corrections.length})`);
    ok(a.corrections[0].outcome === "interested",
      `and still readable (${a.corrections[0].outcome})`);

    console.log("\n── 2 · RESCHEDULE CHAIN CARRIES ONE OPPORTUNITY ─────────");
    const bchain = chainOf(T["B-chain-root"]);
    ok(!!bchain, "the chain resolves to its root");
    ok(bchain.occurrence_count === 3, `all three occurrences preserved (${bchain.occurrence_count})`);
    ok(bchain.occurrences.every((o) => o.attribution_basis === BASIS.EXPLICIT),
      "EVERY successor carries the opportunity — attribution cannot vanish mid-chain");
    ok(bchain.occurrences.filter((o) => o.observed_state === OBSERVED.ATTENDED).length === 1,
      "exactly one occurrence in the chain was attended");

    console.log("\n── 3 · CANCELLED CHAIN + SEPARATE COMPLETED CHAIN ───────");
    const cc = chainOf(T["C-cancelled-root"]), cs = chainOf(T["C-separate-completed"]);
    ok(cc && cs, "both chains are present");
    ok(String(cc.chain_root_id) !== String(cs.chain_root_id),
      "they are SEPARATE chains — a separately booked tour never collapses into another");
    ok(cc.occurrences[0].observed_state === OBSERVED.CANCELLED, "the cancelled chain reads cancelled");
    ok(cs.occurrences[0].observed_state === OBSERVED.ATTENDED, "the separate chain reads attended");

    console.log("\n── 4 · EXTERNAL REVISIONS RECONSTRUCTED, NONE LOST ──────");
    const xc = chainOf(X["X-multi-revision"]);
    ok(!!xc, "the external appointment appears");
    ok(xc.source_type === "scheduled_tours", "carrying its exact source type");
    ok(xc.occurrence_count === 3,
      `all THREE occurrences reconstructed from the revision log (${xc.occurrence_count})`);
    const starts = xc.occurrences.map((o) => o.planned_for).filter(Boolean);
    ok(new Set(starts).size === 3, "each occurrence has its own distinct planned time");
    ok(xc.occurrences.every((o) => o.actual_host_user_id === null && o.outcome === null),
      "external occurrences claim NO host and NO outcome");
    ok(xc.occurrences.every((o) => o.observation_unavailable_reason === "external_source_records_no_attendance"),
      "and each says WHY observation is unavailable");

    console.log("\n── 5/6 · PAST WITH NO OBSERVATION STAYS UNKNOWN ─────────");
    const h = occOf(T["H-past-no-observation"]);
    ok(h.observed_state === OBSERVED.UNKNOWN,
      `a past native appointment with no observation is unknown (${h.observed_state})`);
    ok(h.observed_state !== OBSERVED.NO_SHOW, "and is NEVER promoted to no_show by the clock");
    const xp = chainOf(X["X-past-unobserved"]);
    ok(xp.occurrences[0].observed_state === OBSERVED.UNKNOWN,
      "a past EXTERNAL appointment with no observation is unknown too");

    console.log("\n── FUTURE SCHEDULED IS PENDING, NOT OCCURRED ────────────");
    const fut = occOf(T["I-future-scheduled"]);
    ok(fut.observed_state === OBSERVED.PENDING, `future work is pending (${fut.observed_state})`);
    ok(fut.observed_at === null, "and has no observed time");
    ok(J.evidence_pending === true, "the opportunity reports evidence still pending");

    console.log("\n── 6/7 · TWO OPPORTUNITIES, ONE LEAD ────────────────────");
    ok(O.old !== O.current, "the lead carries two distinct opportunities");
    const older = await appointmentJourney(c, { property_id: P, opportunity_id: O.old });
    ok(older.ok === true, "the earlier opportunity projects independently");
    const currentIds = new Set(J.chains.flatMap((x) => x.occurrences).map((o) => String(o.occurrence_id)));
    const olderIds = older.chains.flatMap((x) => x.occurrences).map((o) => String(o.occurrence_id));
    ok(olderIds.every((id) => !currentIds.has(id)),
      "no occurrence is claimed by BOTH opportunities");

    console.log("\n── 7 · UNATTRIBUTED APPOINTMENT STAYS UNTRACKABLE ───────");
    ok(!occOf(T["D-unattributed"]),
      "an unattributed tour on the same lead is NOT pulled in by lead/person/time");

    console.log("\n── 8 · EXACT HISTORICAL POINTER IS HONOURED ─────────────");
    const legacy = older.chains.flatMap((x) => x.occurrences)
      .find((o) => String(o.occurrence_id) === String(T["L-legacy-pointer"]));
    ok(!!legacy, "a tour claimed only by origin_tour_id is found");
    ok(legacy.attribution_basis === BASIS.ORIGIN_POINTER,
      `and states that exact basis (${legacy && legacy.attribution_basis})`);
    const legacyExt = older.chains.find((ch) => String(ch.chain_root_id) === String(X["L-legacy-external"]));
    ok(legacyExt && legacyExt.attribution_basis === BASIS.SCHEDULED_POINTER,
      `the external legacy pointer states its basis (${legacyExt && legacyExt.attribution_basis})`);

    console.log("\n── 9 · COMPETING OPPORTUNITY LINKS ARE CONFLICT ─────────");
    ok(J.competing_opportunity_links.length === 1,
      `a chain spanning two opportunities is surfaced (${J.competing_opportunity_links.length})`);
    ok(J.competing_opportunity_links[0].reason === "competing_opportunity_link",
      "with an explicit reason");
    ok(!!J.competing_opportunity_links[0].competing_opportunity_id,
      "naming the competing opportunity");
    ok(J.observed_visit === "conflict",
      `and the opportunity roll-up reports conflict, not a winner (${J.observed_visit})`);

    console.log("\n── 10 · RESCHEDULE CYCLE IS UNTRACKABLE ─────────────────");
    const cycles = J.untrackable.filter((u) => u.reason === "reschedule_cycle");
    ok(cycles.length === 2, `both cycle members are untrackable (${cycles.length})`);
    ok(!chainOf(T["F-cycle-a"]), "a cycle produces NO chain — it is never rooted arbitrarily");

    console.log("\n── 11 · WRONG-PROPERTY REFUSAL ──────────────────────────");
    const wrong = await appointmentJourney(c, {
      property_id: s.other_property_id, opportunity_id: O.current });
    ok(wrong.ok === false && wrong.refusal_code === "opportunity_not_at_property",
      `cross-property is refused (${wrong.refusal_code})`);
    ok(!J.chains.some((ch) => ch.occurrences.some((o) => String(o.occurrence_id) === String(T["G-wrong-property"]))),
      "and a tour at another property is never included");

    console.log("\n── THE PROJECTOR ADDS NO FORBIDDEN SURFACE ──────────────");
    const src = require("fs").readFileSync(
      path.join(REPO, "src/leasing/appointment_journey.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [t, re] of [["ranking", /rank|leaderboard|score/i], ["percentages", /percent|rate_|conversion_rate/i],
                           ["calendar", /calendar|ical|timeslot_render/i], ["writes", /\b(insert|update|delete)\s+(into\s+)?[a-z_]+/i]]) {
      ok(!re.test(src), `no ${t} in the projector`);
    }
    ok(!/lead_id\s*=\s*\$/.test(src), "attribution is never gathered by lead_id");

    console.log("\n── ANALYZER BASELINE (pre-bridge measurement) ───────────");
    const R = await analyze(c, { property_id: P });
    const exact = R.exact_native_pointer.length + R.exact_external_pointer.length + R.chain_inheritance.length;
    ok(exact === 2, `exactly 2 appointments are backfillable by exact link (${exact})`);
    ok(R.inference_only.length > 0,
      `and ${R.inference_only.length} are inference-only, therefore untrackable from existing evidence`);

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   appointment journey: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
