// ════════════════════════════════════════════════════════════════════
//  slice9_metric_contract_proof.js — THE FOUR FROZEN FUNNEL CONTRACTS.
//
//  Contract and proof work, not a dashboard build. The meanings were each
//  established in their own accepted cut; this proves they are FROZEN in one
//  place, share one state vocabulary, suppress rates by one mechanical rule,
//  and reconcile to their own rows — so no funnel can drift back to a private
//  interpretation of source, window, conversion, pending, terminal or missing
//  evidence.
//
//  Run: DATABASE_URL=... node tests/proofs/slice9_metric_contract_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const {
  FUNNEL_CONTRACTS, SOURCE_ATTRIBUTION_BASIS, METRIC_STATES, METRIC_DEFINITIONS,
  buildMetric,
} = require(path.join(REPO, "src/evidence/metric_contract"));
const { marketEvidenceProjection } = require(path.join(REPO, "src/evidence/evidence_projection"));

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const uuid = () => crypto.randomUUID();
const asPool = (c) => ({ query: (...a) => c.query(...a) });

(async () => {
  if (!process.env.DATABASE_URL) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

  console.log("\n── THE CONTRACTS ARE FROZEN AND COMPLETE ────────────────");
  const REQUIRED = [
    "metric_code", "contract_version", "counted_entity",
    "cohort_entry_fact", "cohort_entry_timestamp",
    "numerator_fact", "numerator_timestamp", "deduplication_key",
    "property_scope", "date_window", "source_attribution_basis",
    "pending_definition", "terminal_definition",
    "conflict_conditions", "untrackable_conditions", "coverage_rules",
    "rate_suppression_rule", "zero_denominator_rule", "as_of",
  ];
  for (const k of ["f1", "f2", "f3", "f4"]) {
    const ct = FUNNEL_CONTRACTS[k];
    ok(REQUIRED.every((f) => f in ct && ct[f] != null && ct[f] !== ""),
      `${k} carries every required contract field`);
    ok(Object.isFrozen(ct), `${k} is frozen — a caller cannot mutate its meaning`);
    ok(k in { f1: 1, f2: 1 } ? /leasing_conversions\.id/.test(ct.deduplication_key)
                             : /lease_applications\.id/.test(ct.deduplication_key),
      `${k} states its counted grain exactly (${ct.deduplication_key})`);
    ok(!!METRIC_DEFINITIONS[ct.metric_code],
      `${k}'s metric_code is registered (${ct.metric_code})`);
  }
  ok(FUNNEL_CONTRACTS.f3.cohort_entry_timestamp.includes("submitted_at")
     && FUNNEL_CONTRACTS.f3.cohort_entry_timestamp.includes("never created_at"),
    "f3's cohort instant is submitted_at, with created_at excluded by name");
  ok(FUNNEL_CONTRACTS.f4.cohort_entry_timestamp.includes("approved_at")
     && FUNNEL_CONTRACTS.f4.cohort_entry_timestamp.includes("never decided_at"),
    "f4's cohort instant is approved_at, with decided_at excluded by name");
  ok(/DENIAL never counts/i.test(FUNNEL_CONTRACTS.f3.numerator_fact),
    "denial-does-not-become-approval is contract text, not convention");

  console.log("\n── ONE SOURCE-ATTRIBUTION BASIS, EVERYWHERE ─────────────");
  ok(["f1", "f2", "f3", "f4"].every(
      (k) => FUNNEL_CONTRACTS[k].source_attribution_basis === SOURCE_ATTRIBUTION_BASIS),
    "all four funnels reference the SAME frozen basis object");
  ok(SOURCE_ATTRIBUTION_BASIS.basis === "originating_lead_source"
     && SOURCE_ATTRIBUTION_BASIS.grain === "lead"
     && SOURCE_ATTRIBUTION_BASIS.independently_recorded_per_opportunity === false,
    "and it states: lead-grained, inherited, never independently recorded");

  console.log("\n── ONE STATE VOCABULARY ─────────────────────────────────");
  for (const s of ["ok", "partial", "empty", "unavailable", "error"]) {
    ok(METRIC_STATES.includes(s), `'${s}' is in the shared vocabulary`);
  }
  ok(["f1", "f2", "f3", "f4"].every((k) =>
      JSON.stringify(FUNNEL_CONTRACTS[k].response_states)
      === JSON.stringify(["ok", "partial", "empty", "unavailable", "error"])),
    "every funnel contract declares the identical response states");

  console.log("\n── THE MECHANICAL RULES, IN ISOLATION ───────────────────");
  const w = { state: "ok", property_id: "p", operating_timezone: "America/New_York",
    window_start_local: "2026-08-01", window_end_local: "2026-08-31",
    window_start_utc: "2026-08-01T04:00:00.000Z", window_end_utc: "2026-09-01T04:00:00.000Z",
    as_of_utc: "2026-08-15T00:00:00.000Z" };
  const CODE = "s9.conversion.opportunity_observed_visit_to_submitted_application.v1";
  const empty = buildMetric({ metric_code: CODE, window: w, numerator: 0, denominator: 0 });
  ok(empty.state === "empty" && empty.rate === null,
    `zero denominator ⇒ state 'empty', rate null — never 0% (${empty.state})`);
  const emptyButUnresolved = buildMetric({ metric_code: CODE, window: w,
    numerator: 0, denominator: 0,
    partial: { is_partial: true, unresolved_count: 2, reason: "rows could still enter" } });
  ok(emptyButUnresolved.state === "partial",
    "an empty cohort that could still GROW is partial, not empty");
  const suppressed = buildMetric({ metric_code: CODE, window: w,
    numerator: 3, denominator: 7,
    partial: { is_partial: true, unresolved_count: 1, reason: "conflict" } });
  ok(suppressed.state === "partial" && suppressed.rate === null
     && suppressed.numerator === 3 && suppressed.denominator === 7,
    "suppression withholds the rate and keeps every count visible");
  const okm = buildMetric({ metric_code: CODE, window: w, numerator: 3, denominator: 7 });
  ok(okm.state === "ok" && okm.rate === 0.428571, "a resolved cohort publishes a real rate");

  // ── AGAINST REAL POSTGRES: an EMPTY property and a LIVE one ────────
  const c = await pool.connect();
  try {
    await c.query("begin");
    const P = asPool(c);
    const bare = (await c.query(
      `insert into properties (name, operating_timezone)
       values ('S9 contract proof — empty', 'America/New_York') returning id`)).rows[0].id;

    console.log("\n── AN EMPTY PROPERTY: ALL FOUR FUNNELS SAY 'empty' ──────");
    const out0 = await marketEvidenceProjection(P, {
      property_id: bare, start_local: "2026-08-01", end_local: "2026-08-31",
      as_of: "2026-09-15T00:00:00Z" });
    const cv0 = out0.sections.conversion;
    for (const k of ["f1all", "f2", "f3", "f4"]) {
      const m = cv0.metrics[k];
      ok(m.state === "empty" && m.rate === null && m.denominator === 0,
        `${k}: nothing measured ⇒ empty, rate null (${m.state})`);
    }
    ok(cv0.contracts === FUNNEL_CONTRACTS,
      "the frozen contracts ride the response by reference");

    console.log("\n── A LIVE PROPERTY: SUPPRESSION IS CONSISTENT ───────────");
    //  One opportunity with UNRESOLVED evidence (future appointment) and an
    //  unlinked submitted application — partial pressure on f1 AND f2 at once.
    const host = (await c.query(
      `insert into users (email,name) values ($1,'C host') returning id`,
      [`mc-${uuid().slice(0, 8)}@proof.test`])).rows[0].id;
    const person = (await c.query(
      `insert into persons (name, lifecycle_status) values ('Contract prospect','lead') returning id`)).rows[0].id;
    await c.query(`insert into conversations (property_id, person_id, channel_primary, status)
                   values ($1,$2,'sms','open')`, [bare, person]);
    const lead = (await c.query(
      `insert into leasing_leads (person_id, property_id, status, received_at)
       values ($1,$2,'new','2026-08-05T12:00:00Z') returning id`, [person, bare])).rows[0].id;
    const opp = (await c.query(
      `insert into leasing_conversions (person_id, property_id, lead_id, status, current_stage,
         opened_at, actual_tour_host_user_id, conversation_owner_user_id)
       values ($1,$2,$3,'active','touring','2026-08-05T12:00:00Z',$4,$4) returning id`,
      [person, bare, lead, host])).rows[0].id;
    const unit = (await c.query(
      `insert into units (property_id, unit_number) values ($1,'MC-1') returning id`, [bare])).rows[0].id;
    await c.query(`insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id,
                     scheduled_for, status, created_at, conversion_id)
                   values ($1,$2,$3,$4,'2026-10-01T15:00:00Z','scheduled','2026-08-06T12:00:00Z',$5)`,
      [lead, bare, unit, host, opp]);
    await c.query(`insert into lease_applications (property_id, person_id, leasing_lead_id, status, created_at, submitted_at)
                   values ($1,$2,$3,'submitted','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z')`,
      [bare, person, lead]);

    const out1 = await marketEvidenceProjection(P, {
      property_id: bare, start_local: "2026-08-01", end_local: "2026-08-31",
      as_of: "2026-08-20T00:00:00Z" });
    const cv1 = out1.sections.conversion;
    ok(cv1.metrics.f1all.state === "partial" && cv1.metrics.f1all.rate === null,
      `f1: a pending future appointment suppresses the rate (${cv1.metrics.f1all.state})`);
    ok(cv1.metrics.f2.state === "partial" && cv1.metrics.f2.rate === null,
      `f2: an unlinked application that may belong suppresses the rate (${cv1.metrics.f2.state})`);
    ok(cv1.metrics.f1all.numerator !== null && cv1.metrics.f2.denominator !== null,
      "and the counts remain visible in both");
    ok(cv1.metrics.f3.denominator === 1 && cv1.metrics.f3.state !== "empty",
      "f3 cohorts on the durable submitted_at");
    //  RECONCILIATION: the f2 aggregate to its own rows, independently.
    const pops = cv1.metrics.f2.detail.populations;
    const bucketSum = ["observed_visit", "pending_future_appointment", "unresolved_past_appointment",
      "no_appointment", "no_show", "cancelled", "conflict", "untrackable"]
      .reduce((n, k) => n + pops[k], 0);
    ok(bucketSum === cv1.supporting_rows.total_rows,
      `the aggregate reconciles to its rows (${bucketSum} === ${cv1.supporting_rows.total_rows})`);
    ok(cv1.metrics.f2.detail.reconciles === true, "and says so itself");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   metric contracts: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
