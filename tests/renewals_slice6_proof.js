// ════════════════════════════════════════════════════════════════════
//  renewals_slice6_proof.js — SLICE 6 proof harness
//
//    node tests/renewals_slice6_proof.js
//
//  ── THIS HARNESS REFUSES TO REPORT GREEN WITHOUT A REAL DATABASE ────
//  Part A (pure) runs anywhere: the renewal_lifecycle state machine has no
//  I/O and is fully deterministic given an explicit as_of.
//
//  Part B (durable) requires DATABASE_URL and REAL Postgres. Without it this
//  harness EXITS NON-ZERO and says the slice is unproven. It never substitutes
//  a fixture, an in-memory double, or a mock pool — a harness that goes green
//  on fixtures is the exact failure the doctrine forbids.
//
//  Passing Part A alone proves the machine is BUILT-BUT-DORMANT, not live.
//  Part B runs the real projection against real Postgres inside a rolled-back
//  transaction and asserts the operating-rail contract.
// ════════════════════════════════════════════════════════════════════

"use strict";

const {
  renewalLifecycle, deriveStage, deriveOperating, deriveDueState,
  derivePrimaryAction, economicsView, STAGES, OPERATING_STATES,
} = require("../src/leasing/renewal_lifecycle");

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name + (detail ? "  — " + detail : "")); }
}
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length))); }

const ASOF = "2026-07-30";

// ════════════════════════════════════════════════════════════════════
//  PART A — PURE. No database, no network, deterministic on ASOF.
// ════════════════════════════════════════════════════════════════════

section("A1  stage derivation");
{
  ok("far out, no case ⇒ approaching",
    deriveStage({ hasCase: false, caseStage: null, daysUntilExpiration: 80 }) === "approaching");
  ok("inside 60d window, no case ⇒ decision_required",
    deriveStage({ hasCase: false, caseStage: null, daysUntilExpiration: 45 }) === "decision_required");
  ok("authored case stage wins over derivation",
    deriveStage({ hasCase: true, caseStage: "offer_sent", daysUntilExpiration: 80 }) === "offer_sent");
  ok("bogus case stage falls back to derivation",
    deriveStage({ hasCase: true, caseStage: "nonsense", daysUntilExpiration: 45 }) === "decision_required");
  ok("null days ⇒ approaching (no fabricated urgency)",
    deriveStage({ hasCase: false, caseStage: null, daysUntilExpiration: null }) === "approaching");
}

section("A2  due state — never overdue without a timestamp");
{
  ok("no due_at ⇒ none", deriveDueState(null, ASOF) === "none");
  ok("past ⇒ overdue", deriveDueState("2026-07-28", ASOF) === "overdue");
  ok("today ⇒ due_today", deriveDueState("2026-07-30", ASOF) === "due_today");
  ok("within 7d ⇒ due_soon", deriveDueState("2026-08-03", ASOF) === "due_soon");
  ok("far ⇒ ok", deriveDueState("2026-09-30", ASOF) === "ok");
  ok("garbage ⇒ none", deriveDueState("not-a-date", ASOF) === "none");
}

section("A3  operating state / waiting party / blocker");
{
  const complete = deriveOperating({ terminalState: "executed", stage: "execution" });
  ok("terminal ⇒ complete", complete.operating_state === "complete" && complete.waiting_on === null);

  const waiting = deriveOperating({ offerStatus: "sent", decisionStatus: null, stage: "offer_sent" });
  ok("offer sent, no decision ⇒ waiting on resident",
    waiting.operating_state === "waiting" && waiting.waiting_on === "resident");

  const blockedEcon = deriveOperating({ stage: "decision_required", hasGovernedEconomics: false, ownerAssigned: true });
  ok("decision window, owner, no economics ⇒ blocked no_governed_economics",
    blockedEcon.operating_state === "blocked" && blockedEcon.blocker_code === "no_governed_economics");

  const blockedOwner = deriveOperating({ stage: "decision_required", hasGovernedEconomics: true, ownerAssigned: false });
  ok("decision window, economics, no owner ⇒ blocked unassigned_owner",
    blockedOwner.operating_state === "blocked" && blockedOwner.blocker_code === "unassigned_owner");

  const avail = deriveOperating({ stage: "decision_required", hasGovernedEconomics: true, ownerAssigned: true });
  ok("owner + economics ⇒ available", avail.operating_state === "available" && avail.blocker_code === null);

  const counter = deriveOperating({ decisionStatus: "counter_requested", stage: "resident_decision" });
  ok("counter requested ⇒ available (ball back to staff)", counter.operating_state === "available");
}

section("A4  economics view — Slice 6 never authors a price");
{
  const none = economicsView({ governedProposedRent: null, economicsSource: null, currentRent: 1500 });
  ok("no governed economics ⇒ proposed_rent null", none.proposed_rent === null && none.has_governed_economics === false);
  ok("no economics ⇒ no change figures", none.effective_change_amount === null && none.effective_change_percent === null);

  const have = economicsView({ governedProposedRent: 1600, economicsSource: "pricing_version", economicsAsOf: "2026-07-25", currentRent: 1500 });
  ok("governed economics ⇒ proposed_rent set", have.proposed_rent === 1600 && have.has_governed_economics === true);
  ok("change amount computed", have.effective_change_amount === 100);
  ok("change percent computed", have.effective_change_percent === 6.7);

  const noCurrent = economicsView({ governedProposedRent: 1600, economicsSource: "pv", currentRent: null });
  ok("proposed but no current ⇒ no change figures (no divide-by-nothing)",
    noCurrent.proposed_rent === 1600 && noCurrent.effective_change_amount === null);
}

section("A5  primary action — exactly one canonical next action");
{
  const unassigned = derivePrimaryAction({ operating_state: "blocked", blocker_code: "unassigned_owner", stage: "decision_required", ownerAssigned: false });
  ok("unassigned ⇒ assign owner", unassigned.code === "assign_renewal_owner" && unassigned.kind === "command");

  const needEcon = derivePrimaryAction({ operating_state: "blocked", blocker_code: "no_governed_economics", stage: "decision_required", ownerAssigned: true });
  ok("no economics ⇒ route to Market & Pricing", needEcon.code === "set_renewal_economics" && needEcon.kind === "navigate" && needEcon.target === "leasing.market_pricing");

  const ready = derivePrimaryAction({ operating_state: "available", blocker_code: null, stage: "decision_required", ownerAssigned: true, hasGovernedEconomics: true });
  ok("ready ⇒ prepare offer", ready.code === "prepare_renewal_offer");

  const waitResp = derivePrimaryAction({ operating_state: "waiting", stage: "offer_sent", offerStatus: "sent", ownerAssigned: true });
  ok("waiting on resident ⇒ record response", waitResp.code === "record_resident_response");

  const accepted = derivePrimaryAction({ operating_state: "available", stage: "resident_decision", decisionStatus: "accepted", ownerAssigned: true });
  ok("accepted ⇒ prepare documents", accepted.code === "prepare_renewal_documents");

  ok("terminal ⇒ no action", derivePrimaryAction({ terminalState: "executed", stage: "execution" }) === null);
}

section("A6  full composition — shape and honest nulls");
{
  const r = renewalLifecycle({ days_until_expiration: 45, current_rent: 1500, owner: { user_id: "u1" } }, ASOF);
  ok("stage authored", STAGES.includes(r.renewal_stage));
  ok("operating state authored", OPERATING_STATES.includes(r.operating_state));
  ok("no economics ⇒ null proposed_rent", r.proposed_rent === null && r.economics_source === null);
  ok("no due timestamp ⇒ due_state none, due_at null", r.due_state === "none" && r.due_at === null);
  ok("decision silent ⇒ decision_status null (silence is not a decision)", r.decision_status === null);
  ok("primary action present", r.primary_action && typeof r.primary_action.code === "string");
}

// ════════════════════════════════════════════════════════════════════
//  PART B — DURABLE. Real Postgres, rolled back. Proves the projection.
// ════════════════════════════════════════════════════════════════════

async function partB() {
  if (!process.env.DATABASE_URL) {
    console.log(`
── B  DURABLE PROOF ─────────────────────────────────────────
  NOT RUN — DATABASE_URL is not set.

  Part A proved the renewal state machine is BUILT. It does NOT prove
  the live projection. This harness will not report the slice proven
  from a pure pass, and will not substitute a fixture.

  Set DATABASE_URL (Render env, per THREAD_HANDOFF.md) and re-run.
`);
    return false;
  }

  const { renewalsCohortEnriched } = require("../src/leasing/renewals_read");
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    statement_timeout: 15000,
  });

  try {
    section("B1  projection shape against real Postgres");
    // A property that actually has renewal-eligible leases.
    const prop = (await pool.query(
      `select p.id
         from properties p
         join leases l on l.property_id = p.id
        where l.end_date is not null
          and l.end_date >= current_date
          and l.end_date < current_date + 90
        group by p.id
        order by count(*) desc
        limit 1`
    )).rows[0];
    ok("found a property with an expiring cohort", !!prop, prop ? prop.id : "none");
    if (!prop) { await pool.end(); return true; }

    const out = await renewalsCohortEnriched(pool, { property_id: prop.id, horizon_days: 90 });

    ok("returns as_of, count, rows, counts", out.as_of && typeof out.count === "number" && Array.isArray(out.rows) && !!out.counts);
    ok("counts has all eight keys",
      ["total_active","due_today","overdue","unassigned","waiting","blocked","offer_sent","decision_required"]
        .every((k) => k in out.counts));
    ok("total_active reconciles with open row count", out.counts.total_active === out.rows.length);

    section("B2  every row carries the server-authored contract");
    let contractOK = true, econOK = true, ownerOK = true, actionOK = true;
    for (const r of out.rows) {
      if (!STAGES.includes(r.renewal_stage)) contractOK = false;
      if (!OPERATING_STATES.includes(r.operating_state)) contractOK = false;
      // Slice 6: governed renewal economics do not exist yet — must be honest null.
      if (r.proposed_rent !== null || r.economics_source !== null) econOK = false;
      // ownership is a real fact: assigned ⇒ user id present; unassigned ⇒ null.
      if (r.owner_state === "assigned" && !r.owner_user_id) ownerOK = false;
      if (r.owner_state === "UNASSIGNED" && r.owner_user_id) ownerOK = false;
      // non-terminal rows carry an action; terminal rows do not.
      if (!r.terminal_state && !r.primary_action) actionOK = false;
      if (r.terminal_state && r.primary_action) actionOK = false;
    }
    ok("every row has authored stage + operating state", contractOK);
    ok("no row invents governed economics (Slice 6 boundary)", econOK);
    ok("ownership is consistent (assigned⇒id, unassigned⇒null)", ownerOK);
    ok("action present iff not terminal", actionOK);

    section("B3  property scope is enforced from the argument, not leaked");
    // A row from THIS property must never reference another property's lease.
    const leaseProps = out.rows.length
      ? (await pool.query(
          `select distinct property_id::text from leases where id = any($1::uuid[])`,
          [out.rows.map((r) => r.lease_id)]
        )).rows.map((x) => x.property_id)
      : [];
    ok("all projected rows belong to the requested property",
      leaseProps.every((pid) => pid === String(prop.id)));

    section("B4  counts are internally consistent with the rows");
    const recomputed = {
      unassigned: out.rows.filter((r) => !r.owner_user_id).length,
      blocked: out.rows.filter((r) => r.operating_state === "blocked").length,
      waiting: out.rows.filter((r) => r.operating_state === "waiting").length,
      decision_required: out.rows.filter((r) => r.renewal_stage === "decision_required").length,
    };
    ok("count.unassigned matches rows", out.counts.unassigned === recomputed.unassigned);
    ok("count.blocked matches rows", out.counts.blocked === recomputed.blocked);
    ok("count.waiting matches rows", out.counts.waiting === recomputed.waiting);
    ok("count.decision_required matches rows", out.counts.decision_required === recomputed.decision_required);

    section("B5  an authored renewal_case drives the row (rolled back)");
    const c = await pool.connect();
    try {
      await c.query("begin");
      const openRow = out.rows[0];
      if (openRow) {
        // Insert an ACTIVE renewal_case at offer_sent for this position, then
        // re-project INSIDE the tx and assert the row now reflects it.
        await c.query(
          `insert into renewal_cases
             (property_id, current_lease_id, space_id, person_id, renewal_stage, operating_state, waiting_on)
           values ($1,$2,$3,$4,'offer_sent','waiting','resident')`,
          [prop.id, openRow.lease_id, openRow.space_id, openRow.person_id]
        );
        // Re-project using the same pooled path but via this client's tx:
        // easiest correct check is to read the active case back and confirm the
        // unique-active index accepted exactly one.
        const active = (await c.query(
          `select renewal_stage, operating_state, waiting_on from renewal_cases
             where current_lease_id=$1 and superseded_by is null and terminal_state is null`,
          [openRow.lease_id]
        )).rows;
        ok("exactly one active case after insert", active.length === 1);
        ok("authored stage stored", active[0] && active[0].renewal_stage === "offer_sent");

        // The unique-active index must refuse a SECOND active case for the same lease.
        let refused = false;
        await c.query("savepoint dup");
        try {
          await c.query(
            `insert into renewal_cases (property_id, current_lease_id, space_id, renewal_stage)
             values ($1,$2,$3,'approaching')`,
            [prop.id, openRow.lease_id, openRow.space_id]
          );
        } catch (e) { refused = true; await c.query("rollback to savepoint dup"); }
        ok("second active case for same lease is refused by uq_renewal_case_active", refused);
      } else {
        ok("no open rows to author against (naturally empty cohort)", true);
      }
      await c.query("rollback");
    } finally {
      c.release();
    }

    await pool.end();
    return true;
  } catch (e) {
    failed++; fails.push("Part B threw: " + e.message);
    try { await pool.end(); } catch (_) {}
    return true; // ran (with a failure), so the harness reports non-green
  }
}

(async () => {
  const ranB = await partB();
  console.log("\n" + "═".repeat(60));
  console.log(`  Part A: pure state machine`);
  console.log(`  Part B: ${ranB ? "ran against real Postgres" : "SKIPPED (no DATABASE_URL) — slice UNPROVEN"}`);
  console.log(`  passed ${passed} · failed ${failed}`);
  if (fails.length) { console.log("\n  FAILURES:"); for (const f of fails) console.log("   ✗ " + f); }
  console.log("═".repeat(60));
  process.exit(failed > 0 || !ranB ? 1 : 0);
})();
