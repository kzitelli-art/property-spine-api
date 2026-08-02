// ════════════════════════════════════════════════════════════════════
//  slice9_cross_domain_matrix.js
//
//  Twenty scenarios. For each, NINE domain answers asserted INDEPENDENTLY.
//
//  The point is that they are not compressed into one overall state. A
//  position can simultaneously be application-ineligible, packet-eligible,
//  commitment-pending and economically inactive — those are four different
//  questions about four different things, and collapsing them is how a
//  disagreement becomes a clean-looking number.
//
//  UNSUPPORTED / UNKNOWN / CONFLICT / refusal are all valid cells. No cell is
//  smoothed to make a row look complete.
//
//  Run: DATABASE_URL=... node tests/slice9_cross_domain_matrix.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const { seedInventory } = require("./fixtures/slice9_inventory_fixture");
const authority = require(path.join(REPO, "src/applications/application_target_authority"));
const packet = require(path.join(REPO, "src/applications/lease_packet_eligibility"));
const { rankTurnPriority } = require(path.join(REPO, "src/maintenance/turn_priority"));
const { availabilityRead } = require(path.join(REPO, "src/surfaces/availability_read"));

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl });
  const c = await pool.connect();
  const rows = [];

  try {
    await c.query("begin");
    const s = await seedInventory(c);
    const P = s.property_id, U = s.units;
    const far = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

    // ── EXTRA SCENARIOS the base fixture does not carry ────────────────
    const app = async (status, unit_id, extra = {}) => (await c.query(
      `insert into lease_applications
         (property_id, unit_id, applicant_name, status, person_id, approved_at,
          terms_review_obligation_id, proposed_terms_confirmation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [P, unit_id, extra.name || "Matrix applicant", status, s.person_id,
       extra.approved_at || null, extra.gate || null, extra.terms || null])).rows[0];

    const ob = (await c.query(
      `insert into obligations (property_id, type, status) values ($1,'terms_review','open') returning id`,
      [P])).rows[0].id;

    //  Placed on the unit with an IN-PROGRESS TURN. The claim is that an approved
    //  application creates no turn deadline, so it must be tested where a turn
    //  ranking actually exists — otherwise the assertion passes vacuously.
    const appApproved   = await app("approved", U["C-turnover"].unit_id, { approved_at: new Date().toISOString() });
    const appLeaseReady = await app("lease_ready", U["C-turnover"].unit_id, { approved_at: new Date().toISOString() });

    // A REAL proposed-terms confirmation. It references the application, so the
    // application is created first and the pointer written back — the same
    // order the production write uses. A bare uuid is not a stand-in: the
    // column carries a foreign key.
    const confirmFor = async (application_id) => {
      const ev = (await c.query(
        `insert into events (property_id, type, note) values ($1,'terms_confirmed','matrix fixture') returning id`,
        [P])).rows[0].id;
      const cf = (await c.query(
        `insert into application_proposed_terms_confirmations
           (application_id, property_id, actor_user_id, event_id, rent, security_deposit,
            lease_start_date, lease_end_date, concession_status, source, authority_basis,
            idempotency_key, payload_hash)
         values ($1,$2,$3,$4,1500,1500,current_date,$5,'none','operator_proposed_terms','role_authority',$6,'hash')
         returning id`,
        [application_id, P, s.user_id, ev, far, "idem-" + application_id])).rows[0].id;
      await c.query(
        `update lease_applications set proposed_terms_confirmation_id=$1, terms_review_obligation_id=$2 where id=$3`,
        [cf, ob, application_id]);
      return (await c.query(`select * from lease_applications where id=$1`, [application_id])).rows[0];
    };

    const appPacketOk   = await confirmFor(
      (await app("lease_ready", U["A-marketable"].unit_id, { approved_at: new Date().toISOString() })).id);
    const appHistorical = await confirmFor(
      (await app("withdrawn", U["A-marketable"].unit_id, { approved_at: new Date().toISOString() })).id);

    // wrong-property lease: a lease on ANOTHER property's space
    const otherProp = (await c.query(
      `insert into properties (name, leasing_basis) values ('Matrix other property','unknown') returning id`)).rows[0].id;
    const otherUnit = (await c.query(
      `insert into units (property_id, unit_number) values ($1,'OTHER-1') returning id`, [otherProp])).rows[0].id;
    const otherSpace = (await c.query(`select id from spaces where unit_id=$1`, [otherUnit])).rows[0].id;
    await c.query(
      `insert into leases (property_id, space_id, lease_status, start_date, end_date, rent)
       values ($1,$2,'pending',current_date + 30, $3, 1500)`, [otherProp, otherSpace, far]);

    // turns: pending successor, and a COMPLETED turn beside a locked successor
    await c.query(`insert into turnovers (property_id, unit_id, status) values ($1,$2,'in_progress')`,
      [P, U["I-future-pending"].unit_id]);
    // Scenario 19 deliberately uses a COMPLETED turn. rankTurnPriority ranks
    // in_progress turns only, so this unit correctly has NO row in the ranking
    // — a finished turn is not work to prioritise. That absence is the answer,
    // not a gap, and it is asserted as such below.
    await c.query(`insert into turnovers (property_id, unit_id, status) values ($1,$2,'ready')`,
      [P, U["J-future-locked"].unit_id]);
    // Units whose scenarios assert a RANKING need a turn that is actually in
    // progress, or the assertion would be about an empty ranking.
    //  NOT A-marketable: an in-progress turn would make it turnover_required and
    //  scenario 1 would no longer be testing a marketable unit at all.
    for (const n of ["O-conflict", "M-successor-locked"]) {
      await c.query(`insert into turnovers (property_id, unit_id, status) values ($1,$2,'in_progress')`,
        [P, U[n].unit_id]);
    }

    const avail = await availabilityRead(c, { property_id: P });
    const availByUnit = new Map(avail.rows.map((r) => [String(r.unit_id), r]));
    const turnOut = await rankTurnPriority(c, P);
    const turnByUnit = new Map(turnOut.turns.map((t) => [String(t.unit_id), t]));

    // ── THE NINE INDEPENDENT ANSWERS ───────────────────────────────────
    async function cell(label, { unit_id = null, application = null }) {
      const a = unit_id ? await authority.resolveApplicationTarget(c, { property_id: P, unit_id }) : null;
      const sub = unit_id ? await authority.resolveSubmissionTarget(c, { property_id: P, unit_id }) : null;
      const av = unit_id ? availByUnit.get(String(unit_id)) : null;
      const tp = unit_id ? turnByUnit.get(String(unit_id)) : null;
      const pk = application
        ? packet.assessLeasePacketEligibility(application, { expectedPropertyId: P })
        : null;
      // ── EVERY N/A CARRIES ITS JUSTIFICATION ────────────────────────
      //  A blank cell would be indistinguishable from an untested one. These
      //  say WHY the question does not apply to this scenario.
      const NA_NO_UNIT = "n/a — scenario is about an application, not a position";
      const NA_NO_APP  = "n/a — no application under test";
      const NA_NO_POS  = "n/a — no classified position at this property";
      const positioned = !!av;
      const r = {
        scenario: label,
        application_target: a ? (a.ok ? "eligible" : a.refusal_code) : NA_NO_UNIT,
        invitation_creation: a ? (a.ok ? "permitted" : "refused") : NA_NO_UNIT,
        submission: sub ? (sub.ok ? "permitted" : sub.refusal_code) : NA_NO_UNIT,
        packet: pk ? (pk.eligible ? "eligible" : pk.reason_code) : NA_NO_APP,
        future_commitment: positioned ? av.future_commitment.state
          : (unit_id ? NA_NO_POS : NA_NO_UNIT),
        marketing_state: positioned ? av.marketing_state
          : (unit_id ? NA_NO_POS : NA_NO_UNIT),
        turn_priority: tp ? tp.demand_tier_key : "no_turn_in_progress",
        economic_tenancy: positioned ? (av.current_lease ? "active" : "none")
          : (unit_id ? NA_NO_POS : NA_NO_UNIT),
        refusal_reason: a && !a.ok ? a.refusal_code
          : (sub && !sub.ok ? sub.refusal_code : "none — not refused"),
      };
      rows.push(r);
      return r;
    }

    console.log("\n── BUILDING THE MATRIX ──────────────────────────────────");
    const M = {};
    M[1]  = await cell("1 sole-space marketable",            { unit_id: U["A-marketable"].unit_id });
    M[2]  = await cell("2 sole-space upcoming, governed date",{ unit_id: U["B-upcoming"].unit_id });
    M[3]  = await cell("3 sole-space turnover, unknown date", { unit_id: U["C-turnover"].unit_id });
    M[4]  = await cell("4 multi-space unit",                  { unit_id: U["S-two-space"].unit_id });
    M[5]  = await cell("5 zero-space unit",                   { unit_id: U["R-zero-space"].unit_id });
    M[6]  = await cell("6 approved application, no lease",    { unit_id: U["C-turnover"].unit_id, application: appApproved });
    M[7]  = await cell("7 lease-ready application, no lease", { unit_id: U["C-turnover"].unit_id, application: appLeaseReady });
    M[8]  = await cell("8 packet-eligible application",       { application: appPacketOk });
    M[9]  = await cell("9 packet-ineligible historical approval", { application: appHistorical });
    M[10] = await cell("10 pending future lease",             { unit_id: U["I-future-pending"].unit_id });
    M[11] = await cell("11 locked future lease",              { unit_id: U["M-successor-locked"].unit_id });
    M[12] = await cell("12 activation-pending lease",         { unit_id: U["H-activation-pending"].unit_id });
    M[13] = await cell("13 active economic tenancy",          { unit_id: U["G-occupied"].unit_id });
    M[14] = await cell("14 cancelled future lease",           { unit_id: U["N-future-cancelled"].unit_id });
    M[15] = await cell("15 overlapping leases",               { unit_id: U["O-conflict"].unit_id });
    M[16] = await cell("16 wrong-property lease",             { unit_id: otherUnit });
    M[17] = await cell("17 wrong-space lease (sibling bed committed)", { unit_id: U["S-two-space"].unit_id });
    M[18] = await cell("18 pending turn with pending successor", { unit_id: U["I-future-pending"].unit_id });
    M[19] = await cell("19 completed turn with locked successor", { unit_id: U["J-future-locked"].unit_id });
    // 20: prepared while sole-space, then the unit gains a second space
    const split = U["K-future-confirmed-opening"].unit_id;
    const before20 = await authority.resolveApplicationTarget(c, {
      property_id: P, unit_id: split, require_offerable: false });
    await c.query(`insert into spaces (unit_id, space_label, position_kind, use_type)
                   values ($1,'Bed 2','bed','residential')`, [split]);
    M[20] = await cell("20 prepared sole-space, then became multi-space", { unit_id: split });

    console.log("\n── EVERY ROW IS COMPLETE ────────────────────────────────");
    ok(rows.length === 20, `20 scenarios recorded (${rows.length})`);
    const FIELDS = ["application_target","invitation_creation","submission","packet",
                    "future_commitment","marketing_state","turn_priority","economic_tenancy"];
    ok(rows.every((r) => FIELDS.every((f) => r[f] !== undefined && r[f] !== null)),
      "every scenario answers all eight domains — no cell left undefined");

    console.log("\n── THE ANSWERS ARE NOT ONE COMPRESSED STATE ─────────────");
    const distinct = (f) => new Set(rows.map((r) => String(r[f]).startsWith("n/a") ? "n/a" : r[f])).size;
    for (const f of FIELDS) ok(distinct(f) > 1, `${f} varies across scenarios (${distinct(f)} distinct)`);
    //  The load-bearing one: two scenarios that agree on marketing state must
    //  still be free to disagree elsewhere.
    const byMarketing = new Map();
    for (const r of rows) {
      if (String(r.marketing_state).startsWith("n/a")) continue;
      if (!byMarketing.has(r.marketing_state)) byMarketing.set(r.marketing_state, new Set());
      byMarketing.get(r.marketing_state).add(r.turn_priority);
    }
    const independent = [...byMarketing.entries()].filter(([, turns]) => turns.size > 1);
    ok(independent.length > 0,
      `positions sharing a marketing state still differ on turn priority — the axes are independent`
      + ` (${independent.map(([m, t]) => `${m}: ${[...t].join("|")}`).join("; ")})`);

    console.log("\n── SPOT ASSERTIONS PER SCENARIO ─────────────────────────");
    ok(M[1].application_target === "eligible" && M[1].marketing_state === "marketable_now",
      "1 marketable: application-eligible");
    ok(M[2].application_target === "intended_move_in_required" && M[2].submission === "permitted",
      "2 upcoming: refused a same-day offer, still submittable as a forward offer");
    ok(M[3].application_target === "intended_move_in_required" && M[3].future_commitment === "none",
      "3 turnover: no commitment, no invented date");
    ok(M[4].application_target === "space_grain_not_supported" && M[4].invitation_creation === "refused",
      "4 multi-space: UNSUPPORTED is the honest answer");
    ok(M[5].application_target === "application_target_unconfigured",
      "5 zero-space: unconfigured, distinct from not-found");
    ok(M[6].packet === "no_open_terms_or_activation_gate",
      `6 approved application: NOT packet-eligible on approval alone (${M[6].packet})`);
    ok(M[6].future_commitment === "none" && M[6].turn_priority === "raw_vacancy",
      `6 and it creates NO commitment and NO turn deadline (commit=${M[6].future_commitment}, turn=${M[6].turn_priority})`);
    ok(M[7].packet === "no_open_terms_or_activation_gate" && M[7].future_commitment === "none",
      "7 lease-ready application: still no inventory");
    ok(M[8].packet === "eligible", `8 packet-eligible application is eligible (${M[8].packet})`);
    ok(M[9].packet === "application_terminal",
      `9 historical approval on a withdrawn application is NOT packet-eligible (${M[9].packet})`);
    ok(M[10].future_commitment === "pending" && M[10].turn_priority === "pending_commitment",
      "10 pending future lease: pending everywhere, never locked");
    ok(M[11].future_commitment === "locked" && M[11].turn_priority === "committed_start",
      `11 locked future lease: committed in BOTH domains (commit=${M[11].future_commitment}, turn=${M[11].turn_priority})`);
    ok(M[12].marketing_state === "activation_pending" && M[12].economic_tenancy === "none",
      "12 activation-pending: committed but NOT economically active");
    ok(M[13].economic_tenancy === "active" && M[13].application_target === "not_offerable",
      "13 active tenancy: not offerable");
    ok(M[14].marketing_state === "marketable_now" && M[14].future_commitment === "none",
      "14 cancelled future lease holds nothing");
    ok(M[15].marketing_state === "contested" && M[15].turn_priority === "conflicted_commitment",
      `15 overlapping leases: CONFLICT surfaced in BOTH domains (marketing=${M[15].marketing_state}, turn=${M[15].turn_priority})`);
    ok(M[16].application_target === "not_at_property",
      "16 wrong-property lease: the unit is refused by the property wall");
    ok(M[17].application_target === "space_grain_not_supported",
      "17 wrong-space: a sibling bed's commitment cannot be attributed, so the unit refuses");
    ok(M[18].turn_priority === "pending_commitment",
      `18 an IN-PROGRESS turn with a pending successor ranks pending_commitment (${M[18].turn_priority})`);
    //  Scenario 19's turn is COMPLETE. Turn priority ranks in-progress turns
    //  only, so it is absent from the ranking entirely — finished work is not
    //  work to prioritise. Its locked commitment is still visible in the
    //  commitment domain, which is exactly the independence this matrix exists
    //  to demonstrate.
    ok(M[19].turn_priority === "no_turn_in_progress",
      `19 a COMPLETED turn is not ranked at all (${M[19].turn_priority})`);
    ok(M[19].future_commitment === "locked",
      "19 yet its locked commitment is still reported — the domains are independent");
    //  The claim is about GRAIN, so it is tested at grain level: the unit was
    //  resolvable to ONE space before the split. It was not offerable even
    //  then (it carries a confirmed-opening future commitment), and conflating
    //  those two facts would make the assertion say something it does not mean.
    ok(before20.refusal_code !== "space_grain_not_supported",
      `20 the unit resolved to a single space BEFORE the split (${before20.refusal_code || "resolved"})`);
    ok(M[20].application_target === "space_grain_not_supported",
      "20 and refuses on grain AFTER it gained a second space");
    ok(M[20].submission === "application_target_became_ambiguous",
      `20 and submission refuses with its OWN code (${M[20].submission})`);

    console.log("\n── UNSUPPORTED / UNKNOWN / CONFLICT ARE REAL OUTCOMES ───");
    const unsupported = rows.filter((r) => r.application_target === "space_grain_not_supported").length;
    const conflicts = rows.filter((r) => r.marketing_state === "contested"
                                      || r.turn_priority === "conflicted_commitment").length;
    const refusals = rows.filter((r) => r.invitation_creation === "refused").length;
    ok(unsupported >= 3, `UNSUPPORTED appears as a real outcome (${unsupported} scenarios)`);
    ok(conflicts >= 1, `CONFLICT appears as a real outcome (${conflicts} scenarios)`);
    ok(refusals >= 10, `refusal is the majority outcome, not an edge case (${refusals} of 20)`);

    console.log("\n── THE MATRIX · 20 SCENARIOS × 9 DOMAINS ────────────────");
    const COLS = [
      ["application_target",  "APPLICATION TARGET"],
      ["invitation_creation", "INVITATION"],
      ["submission",          "SUBMISSION"],
      ["packet",              "PACKET"],
      ["future_commitment",   "FUTURE COMMITMENT"],
      ["marketing_state",     "MARKETING"],
      ["turn_priority",       "TURN PRIORITY"],
      ["economic_tenancy",    "ECONOMIC TENANCY"],
      ["refusal_reason",      "REFUSAL REASON"],
    ];
    for (const r of rows) {
      console.log(`\n  ${r.scenario}`);
      for (const [k, label] of COLS) {
        console.log(`      ${label.padEnd(20)} ${r[k]}`);
      }
    }

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   cross-domain matrix: ${pass} passed, ${fail} failed · ${rows.length} scenarios × 9 domains`);
  process.exit(fail === 0 ? 0 : 1);
})();
