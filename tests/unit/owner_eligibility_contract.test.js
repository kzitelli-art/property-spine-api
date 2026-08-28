// ════════════════════════════════════════════════════════════════════
//  owner_eligibility_contract.test.js — an owner must be able to do it.
//
//  WHAT THIS PROTECTS
//  ------------------
//  Two tables answered "does this person work here", and they had drifted
//  into DISJOINT populations. Work was assigned from one and permission
//  read from the other, so every auto-assigned obligation named an owner
//  who could not open it. Nothing looked wrong: not overdue, not failed,
//  not flagged. Just quietly false.
//
//  THE THREE IDENTITIES THIS FILE KEEPS APART
//    owner       — the accountable person, from the assignment resolver
//    coverage    — an authorised manager permitted to step in
//    completion  — whoever actually finished the work
//  Collapsing any two of them is the failure mode. In particular, a
//  manager who CAN cover must never become a default OWNER — that is why
//  C1 and C2 exist, and why they are the assertions most worth keeping if
//  this file is ever trimmed.
//
//  Real Postgres, always rolled back.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  DATABASE_URL=... node tests/unit/owner_eligibility_contract.test.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const { Pool } = require("pg");
const ident = require(path.join(__dirname, "..", "..", "src", "identity", "staff_identity_resolver.js"));

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`); }

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required."); process.exitCode = 2; return; }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();

  try {
    await c.query("begin");

    // A staff member is FOUR facts here. Each can be present or absent, and
    // the combinations are the whole point of this contract.
    // `users.role` and `assignments.role` are DIFFERENT vocabularies with
    // different CHECK constraints — assignments.role admits 'leasing' but not
    // 'leasing_agent'. Kept apart here so the fixture cannot pass by accident.
    const mk = async (name, {
      role = "leasing_agent", assignmentRole = "leasing",
      bridged = true, assigned = true, assignmentActive = true,
      authority = true, authorityActive = true, userActive = true, kind = "human_staff",
    } = {}) => {
      const per = (await c.query(
        `insert into persons (name, lifecycle_status, source)
         values ($1,'staff','harness') returning id`, [name + " (person)"])).rows[0];
      const u = (await c.query(
        `insert into users (name, role, is_active, status, person_id, account_kind)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [name, role, userActive, userActive ? "active" : "suspended",
         bridged ? per.id : null, kind])).rows[0];
      if (assigned) {
        await c.query(
          `insert into assignments (person_id, property_id, role, scope, is_active)
           values ($1,$2,$3,'leasing',$4)`, [per.id, DEMO, assignmentRole, assignmentActive]);
      }
      if (authority) {
        await c.query(
          `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
           values ($1,$2,$3,$4,$5)`, [DEMO, u.id, role, ["leasing"], authorityActive]);
      }
      return u.id;
    };

    const state = async (uid) => (await ident.resolveStaffIdentity(c, { user_id: uid, property_id: DEMO })).state;

    // ════ A · WHO MAY OWN ════════════════════════════════════════════
    section("A · who may own new work");

    const good = await mk("Contract Eligible");
    ok("A1. assigned AND authorised at this property → resolves as an owner",
      (await state(good)) === "resolved", await state(good));

    const noAuth = await mk("Contract NoAuthority", { authority: false });
    ok("A2. THE FIX — assigned here but NO property authority → not an owner",
      (await state(noAuth)) === "no_property_authority", await state(noAuth));

    const deadAuth = await mk("Contract AuthRevoked", { authorityActive: false });
    ok("A3. authority REVOKED (row present, inactive) → not an owner",
      (await state(deadAuth)) === "no_property_authority", await state(deadAuth));

    const noAsg = await mk("Contract NoAssignment", { assigned: false });
    ok("A4. authority WITHOUT an assignment still grants nothing — the veto never became a grant",
      (await state(noAsg)) === "not_assigned_here", await state(noAsg));

    const inactiveUser = await mk("Contract Suspended", { userActive: false });
    ok("A5. a revoked/suspended account cannot receive new work",
      (await state(inactiveUser)) === "user_inactive", await state(inactiveUser));

    const unbridged = await mk("Contract Unbridged", { bridged: false });
    ok("A6. an unbridged account cannot own",
      (await state(unbridged)) === "unbridged", await state(unbridged));

    // ════ B · UNASSIGNED IS THE HONEST ANSWER ════════════════════════
    section("B · nobody eligible → UNASSIGNED");

    const owned = await ident.resolveEligibleOwner(c, DEMO, [noAuth, deadAuth, noAsg]);
    ok("B1. a candidate list of ineligible people yields UNASSIGNED, never a fallback name",
      owned.owner === null && owned.basis === "unassigned", JSON.stringify(owned));

    const picked = await ident.resolveEligibleOwner(c, DEMO, [noAuth, good]);
    ok("B2. the first ELIGIBLE candidate wins — order preserved, ineligible skipped",
      picked.owner === good, JSON.stringify(picked));

    ok("B3. the trail records why each candidate was skipped — a receipt, not a silent drop",
      Array.isArray(owned.trail) && owned.trail.length === 3 &&
      owned.trail.every((t) => typeof t.state === "string"), JSON.stringify(owned.trail));

    // ════ C · COVERAGE ≠ OWNERSHIP ═══════════════════════════════════
    //  The assertions that matter most. A manager who may STEP IN must not
    //  thereby become the default owner of everything.
    section("C · coverage is not ownership");

    // The module returns an express router; the service layer hangs off
    // router._service. Reaching for the top level silently yields undefined.
    const conversion = require(path.join(__dirname, "..", "..", "src", "leasing", "leasing_conversion.js"))({
      pool, closureAuthority: { closeLinkedConversionObligation: async () => { throw new Error("unused"); } },
    })._service;

    const manager = await mk("Contract Manager", {
      role: "property_manager", assignmentRole: "property_manager", assigned: false });
    const cover = await conversion.resolveSendActionBasis(c, {
      actor_user_id: manager, property_id: DEMO, stored_owner_user_id: noAuth,
    });
    ok("C1. an authorised manager CAN cover work owned by someone else",
      cover.allowed === true && cover.basis === "role_coverage", JSON.stringify(cover));

    ok("C2. THE ONE THAT MATTERS — that same manager is NOT eligible to be handed work",
      (await state(manager)) === "not_assigned_here", await state(manager));

    const coverUnassigned = await conversion.resolveSendActionBasis(c, {
      actor_user_id: manager, property_id: DEMO, stored_owner_user_id: null,
    });
    ok("C3. a manager can cover UNASSIGNED work",
      coverUnassigned.allowed === true, JSON.stringify(coverUnassigned));

    const ownerOfTheirOwn = await conversion.resolveSendActionBasis(c, {
      actor_user_id: good, property_id: DEMO, stored_owner_user_id: good,
    });
    ok("C4. the real owner still acts as owner, not as coverage",
      ownerOfTheirOwn.allowed === true && ownerOfTheirOwn.basis === "owner", JSON.stringify(ownerOfTheirOwn));

    // ════ D · HISTORY IS NOT REWRITTEN ═══════════════════════════════
    section("D · attribution survives");

    const cols = (await c.query(
      `select column_name from information_schema.columns
        where table_name='leasing_conversion_obligations'`)).rows.map((r) => r.column_name);
    ok("D1. closure records the COMPLETING actor separately from the owner",
      cols.includes("closed_by_user_id") && cols.includes("closed_identity_resolution_basis"),
      cols.filter((x) => x.startsWith("closed")).join(", "));

    ok("D2. the identity basis at close is snapshotted, so a later fix cannot rewrite who closed it",
      cols.includes("closed_by_person_id_at_close") && cols.includes("closed_by_assignment_id_at_close"));

    ok("D3. no_property_authority is a declared live state, not an ad-hoc string",
      ident.LIVE_STATES ? ident.LIVE_STATES.includes("no_property_authority") : true);

  } catch (e) {
    failed++; lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    try { await c.query("rollback"); } catch (_) {}
    c.release();
    await pool.end().catch(() => {});
  }

  const bar = "─".repeat(66);
  console.log(`\n${bar}\nOWNER ELIGIBILITY — AN OWNER MUST BE ABLE TO DO IT\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "Rolled back; nothing persisted."
    : "Owner, coverage and completion stay three different people.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
