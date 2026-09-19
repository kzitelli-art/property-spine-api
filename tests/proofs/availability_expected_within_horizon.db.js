/* ════════════════════════════════════════════════════════════════════
   availability_expected_within_horizon.db.js — THE HEADLINE, NOT JUST
   THE STATE.

   Defect (browser rung, 2026-09-19): headline.expected_within_horizon
   counted only rows in marketing_state 'upcoming'. A 'turnover_required'
   row carries a governed expected ready date from the SAME active turn
   plan an 'upcoming' row reads, and was silently dropped — a page showed
   "0 expected within 90 days" above two rows dated inside 90 days.

   This proof seeds four positions and asserts the headline counts exactly
   the ones availability_confidence 'expected' and within_horizon true,
   regardless of marketing_state, and excludes an 'incomplete' date even
   when that date sits inside the horizon — Spine cannot stand behind a
   date it will not confirm.

   Synthetic, in the caller-owned proof database, no writer exercised.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const assert = require("node:assert/strict");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { Pool } = require("pg");
const { availabilityRead } = require("../../src/surfaces/availability_read");

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};

const AS_OF = "2026-09-11";          // horizon_end (default 90d) = 2026-12-10

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  try {
    const p = await one("insert into properties(name) values('Expected-within-horizon headline proof') returning id");

    // ── CASE A: marketing_state 'upcoming', availability_confidence
    //    'expected', inside the horizon — COUNTED before and after this
    //    change (positive control: the pre-existing case must not break).
    const uA = await one("insert into units(property_id,unit_number) values($1,'A-upcoming-expected') returning id", [p.id]);
    await pool.query("delete from spaces where unit_id=$1", [uA.id]);
    const sA = await one("insert into spaces(unit_id,space_label,use_type) values($1,'(whole unit)','residential') returning id", [uA.id]);
    const leaseA = await one(
      "insert into leases(property_id,space_id,start_date,end_date,lease_status) values($1,$2,'2026-01-01','2026-10-01','active') returning id",
      [p.id, sA.id]);
    await pool.query(
      "insert into unit_events(unit_id,property_id,space_id,event_type,effective_date,status) values($1,$2,$3,'notice_given','2026-10-01','scheduled')",
      [uA.id, p.id, sA.id]);
    await pool.query(
      "insert into turnovers(property_id,unit_id,outgoing_lease_id,status,ready_date) values($1,$2,$3,'in_progress','2026-10-01')",
      [p.id, uA.id, leaseA.id]);

    // ── CASE B (THE NEW CASE): marketing_state 'turnover_required',
    //    availability_confidence 'expected', inside the horizon — a plain
    //    active turn plan with no lease spanning as_of and no scheduling
    //    finding. Before this change, silently excluded from the headline.
    const uB = await one("insert into units(property_id,unit_number) values($1,'B-turnover-expected') returning id", [p.id]);
    await pool.query("delete from spaces where unit_id=$1", [uB.id]);
    const sB = await one("insert into spaces(unit_id,space_label,use_type) values($1,'(whole unit)','residential') returning id", [uB.id]);
    await pool.query(
      "insert into turnovers(property_id,unit_id,status,ready_date) values($1,$2,'in_progress','2026-10-15')",
      [p.id, uB.id]);

    // ── CASE C: marketing_state 'turnover_required', but a confirmed
    //    schedule-controlling finding (long-lead) post-dates the stated
    //    plan — turnPlanExceeded() is true, availability_confidence
    //    'incomplete', blocking_fact 'turn_scope_exceeds_plan'. Date sits
    //    INSIDE the horizon and must still NOT be counted.
    const uC = await one("insert into units(property_id,unit_number) values($1,'C-turnover-incomplete') returning id", [p.id]);
    await pool.query("delete from spaces where unit_id=$1", [uC.id]);
    const sC = await one("insert into spaces(unit_id,space_label,use_type) values($1,'(whole unit)','residential') returning id", [uC.id]);
    await pool.query(
      "insert into turnovers(property_id,unit_id,status,ready_date,created_at) values($1,$2,'in_progress','2026-11-01',now() - interval '5 days')",
      [p.id, uC.id]);
    const user = await one("insert into users(name,is_active,status) values('Synthetic Triage Operator',true,'active') returning id");
    const obs = await one(
      "insert into unit_observations(property_id,unit_id,observed_by_user_id,original_text) values($1,$2,$3,'synthetic walk') returning id",
      [p.id, uC.id, user.id]);
    const conf = await one(
      `insert into unit_triage_confirmations(observation_id,property_id,unit_id,confirmed_by_user_id,vacancy_observation,initial_condition,created_at)
       values($1,$2,$3,$4,'vacant','normal_turn',now()) returning id`,
      [obs.id, p.id, uC.id, user.id]);
    await pool.query(
      `insert into unit_triage_findings(confirmation_id,property_id,unit_id,finding_text,long_lead_kind)
       values($1,$2,$3,'HVAC replacement quoted','hvac_failure')`,
      [conf.id, p.id, uC.id]);

    // ── CASE D: marketing_state 'turnover_required', availability_confidence
    //    'expected', but the ready date sits OUTSIDE the 90-day horizon —
    //    must not be counted.
    const uD = await one("insert into units(property_id,unit_number) values($1,'D-turnover-outside-horizon') returning id", [p.id]);
    await pool.query("delete from spaces where unit_id=$1", [uD.id]);
    const sD = await one("insert into spaces(unit_id,space_label,use_type) values($1,'(whole unit)','residential') returning id", [uD.id]);
    await pool.query(
      "insert into turnovers(property_id,unit_id,status,ready_date) values($1,$2,'in_progress','2027-06-01')",
      [p.id, uD.id]);

    const av = await availabilityRead(pool, { property_id: p.id, as_of: AS_OF });
    const bySpace = Object.fromEntries(av.rows.map((r) => [r.space_id, r]));
    const rowA = bySpace[sA.id], rowB = bySpace[sB.id], rowC = bySpace[sC.id], rowD = bySpace[sD.id];

    console.log("  " + JSON.stringify({
      A: { state: rowA.marketing_state, conf: rowA.availability_confidence, from: rowA.available_from, wh: rowA.within_horizon },
      B: { state: rowB.marketing_state, conf: rowB.availability_confidence, from: rowB.available_from, wh: rowB.within_horizon },
      C: { state: rowC.marketing_state, conf: rowC.availability_confidence, from: rowC.available_from, wh: rowC.within_horizon, fact: rowC.blocking_fact },
      D: { state: rowD.marketing_state, conf: rowD.availability_confidence, from: rowD.available_from, wh: rowD.within_horizon },
    }));

    ok("case A: upcoming, expected, inside horizon (fixture sanity)",
      rowA.marketing_state === "upcoming" && rowA.availability_confidence === "expected" && rowA.within_horizon === true);
    ok("case B: turnover_required, expected, inside horizon (fixture sanity — the new case)",
      rowB.marketing_state === "turnover_required" && rowB.availability_confidence === "expected" && rowB.within_horizon === true);
    ok("case C: turnover_required, incomplete via turn_scope_exceeds_plan, date inside horizon (fixture sanity)",
      rowC.marketing_state === "turnover_required" && rowC.availability_confidence === "incomplete"
      && rowC.blocking_fact === "turn_scope_exceeds_plan" && rowC.within_horizon === true);
    ok("case D: turnover_required, expected, OUTSIDE horizon (fixture sanity)",
      rowD.marketing_state === "turnover_required" && rowD.availability_confidence === "expected" && rowD.within_horizon === false);

    ok("headline.expected_within_horizon counts A and B, excludes C (incomplete) and D (outside horizon)",
      av.headline.expected_within_horizon === 2,
      `got ${av.headline.expected_within_horizon}`);

    ok("headline.expected_within_horizon does NOT merely equal the upcoming-only count (the old, defective scope)",
      av.headline.expected_within_horizon !== av.states.upcoming || av.states.upcoming === 2,
      `upcoming=${av.states.upcoming}`);

    // Precise re-derivation: exactly the rows with availability_confidence
    // 'expected' AND within_horizon true, independent of marketing_state.
    const expected = av.rows.filter((r) => r.availability_confidence === "expected" && r.within_horizon).length;
    ok("headline.expected_within_horizon matches an independent recount over ALL rows, not just 'upcoming'",
      av.headline.expected_within_horizon === expected, `headline=${av.headline.expected_within_horizon} recount=${expected}`);

  } finally {
    await pool.end();
  }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
