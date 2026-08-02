// ════════════════════════════════════════════════════════════════════
//  slice9_application_target_authority_proof.js
//
//  Commit A. Proves the ONE authority that answers "may an application be
//  aimed at this unit, and which exact space would it land on?" against a
//  REAL Postgres schema with deterministic, transaction-scoped fixtures.
//
//  Run: DATABASE_URL=... node tests/slice9_application_target_authority_proof.js
//
//  Everything happens inside ONE transaction that is ROLLED BACK. It seeds
//  its own scratch property and never reads Demo Building.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const { seedInventory } = require("./fixtures/slice9_inventory_fixture");
const {
  resolveApplicationTarget, evaluateOfferability, REFUSAL,
} = require(path.join(REPO, "src/applications/application_target_authority"));

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
  let seeded;
  try {
    await c.query("begin");
    seeded = await seedInventory(c);
    const P = seeded.property_id;
    const U = seeded.units;

    console.log("\n── FIXTURE POPULATION (assert BEFORE behaviour) ──────────");
    const popn = (await c.query(
      `select count(distinct u.id)::int units, count(s.id)::int spaces
         from units u left join spaces s on s.unit_id=u.id where u.property_id=$1`, [P])).rows[0];
    ok(popn.units === 19, `19 fixture units exist (got ${popn.units})`);
    ok(popn.spaces === 19, `19 spaces exist — 17 sole + 2 on the two-space unit, 0 on the zero-space unit (got ${popn.spaces})`);
    ok(!!U["A-marketable"] && !!U["S-two-space"] && !!U["R-zero-space"], "every named fixture this proof needs exists");

    console.log("\n── SOLE-SPACE RESOLUTION ────────────────────────────────");
    const a = await resolveApplicationTarget(c, { property_id: P, unit_id: U["A-marketable"].unit_id });
    ok(a.ok === true, "a marketable sole-space unit resolves");
    ok(a.offerable === true, "and is offerable");
    ok(a.resolution_basis === "sole_space_unit", "resolution_basis is sole_space_unit");
    ok(String(a.resolved_space_id) === String(U["A-marketable"].space_id),
      "resolved_space_id is the unit's ONE space, derived server-side");
    ok(a.marketing_state === "marketable_now", `marketing_state carried (${a.marketing_state})`);
    ok(a.availability_confidence === "confirmed", "availability_confidence carried");
    ok(a.rentable_space_count === 1, "space count reported");
    ok(a.refusal_code === null, "no refusal code on an offerable target");

    console.log("\n── MULTI-SPACE: THE CONTROLLED REFUSAL ──────────────────");
    const m = await resolveApplicationTarget(c, { property_id: P, unit_id: U["S-two-space"].unit_id });
    ok(m.ok === false, "a two-space unit refuses");
    ok(m.refusal_code === REFUSAL.MULTI_SPACE, `refusal_code is space_grain_not_supported (${m.refusal_code})`);
    ok(m.httpStatus === 409, "carries 409");
    ok(m.rentable_space_count === 2, "reports the real space count");
    ok(m.resolved_space_id === null, "NO space is selected — not first, not marketable, none");
    ok(/not supported/i.test(m.refusal_reason || ""), "operator copy says unsupported, not 'select a space'");
    ok(!/space_grain/i.test(m.refusal_reason || ""), "no internal code leaks into operator copy");

    console.log("\n── ZERO-SPACE AND PROPERTY WALL ─────────────────────────");
    const z = await resolveApplicationTarget(c, { property_id: P, unit_id: U["R-zero-space"].unit_id });
    ok(z.ok === false && z.refusal_code === REFUSAL.UNCONFIGURED,
      `zero-space unit is unconfigured, distinct from not-found (${z.refusal_code})`);
    ok(z.rentable_space_count === 0, "zero is reported as zero, not as missing");

    const other = (await c.query(
      `insert into properties (name, leasing_basis) values ('Slice 9 other property','unknown') returning id`)).rows[0].id;
    const foreign = await resolveApplicationTarget(c, { property_id: other, unit_id: U["A-marketable"].unit_id });
    ok(foreign.ok === false && foreign.refusal_code === REFUSAL.NOT_AT_PROPERTY,
      "a unit at another property refuses with not_at_property");
    ok(foreign.httpStatus === 404, "carries 404");
    const ghost = await resolveApplicationTarget(c, {
      property_id: P, unit_id: "00000000-0000-0000-0000-000000000000" });
    ok(ghost.refusal_code === REFUSAL.NOT_AT_PROPERTY, "a nonexistent unit refuses the same way");

    console.log("\n── UNTARGETED ───────────────────────────────────────────");
    const un = await resolveApplicationTarget(c, { property_id: P, unit_id: null });
    ok(un.ok === true && un.targeted === false, "untargeted is an explicit result, not an error");
    ok(un.resolution_basis === "untargeted", "resolution_basis is untargeted");
    ok(un.resolved_space_id === null, "untargeted resolves no space");
    ok(un.offerable === false, "nothing is claimed offerable when nothing is targeted");

    console.log("\n── OFFERABILITY POLICY, AGAINST REAL CLASSIFIED STATE ───");
    const cases = [
      ["G-occupied",                 "occupied"],
      ["H-activation-pending",       "activation_pending"],
      ["I-future-pending",           "successor_pending"],
      ["J-future-locked",            "successor_locked"],
      ["K-future-confirmed-opening", "successor_pending"],
      ["L-successor-pending",        "successor_pending"],
      ["M-successor-locked",         "successor_locked"],
      ["O-conflict",                 "contested"],
      ["D-model",                    "not_marketable_use"],
      ["E-down",                     "down"],
      ["F-evidence-disagrees",       "evidence_disagrees"],
      ["P-readiness-unknown",        "readiness_unknown"],
      ["Q-certified-but-committed",  "successor_locked"],
    ];
    for (const [name, expectState] of cases) {
      const r = await resolveApplicationTarget(c, { property_id: P, unit_id: U[name].unit_id });
      ok(r.marketing_state === expectState,
        `${name} classifies as ${expectState}` + (r.marketing_state === expectState ? "" : ` (got ${r.marketing_state})`));
      ok(r.ok === false && r.offerable === false,
        `${name} is REFUSED for application targeting`);
    }

    console.log("\n── CANCELLED FUTURE LEASE CREATES NO COMMITMENT ─────────");
    const canc = await resolveApplicationTarget(c, { property_id: P, unit_id: U["N-future-cancelled"].unit_id });
    ok(canc.marketing_state === "marketable_now",
      `a cancelled future lease leaves the position marketable (got ${canc.marketing_state})`);
    ok(canc.ok === true, "and offerable — terminal leases hold no inventory");

    console.log("\n── FORWARD OFFERS: THE GOVERNED-DATE RULE ───────────────");
    const upNoDate = await resolveApplicationTarget(c, { property_id: P, unit_id: U["B-upcoming"].unit_id });
    ok(upNoDate.marketing_state === "upcoming", `on-notice unit is upcoming (got ${upNoDate.marketing_state})`);
    ok(upNoDate.ok === false && upNoDate.refusal_code === REFUSAL.MOVE_IN_REQUIRED,
      "upcoming refuses with no intended move-in — it is not available today");

    const farOut = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const upFar = await resolveApplicationTarget(c, {
      property_id: P, unit_id: U["B-upcoming"].unit_id, intended_move_in: farOut });
    ok(upFar.ok === true && upFar.offerable === true,
      "upcoming IS offerable for a move-in after its governed available_from");
    ok(upFar.availability_confidence === "incomplete",
      "and the incomplete confidence is carried, never upgraded to confirmed");

    const tooSoon = new Date(Date.now() + 1 * 86400000).toISOString().slice(0, 10);
    const upSoon = await resolveApplicationTarget(c, {
      property_id: P, unit_id: U["B-upcoming"].unit_id, intended_move_in: tooSoon });
    ok(upSoon.ok === false && upSoon.refusal_code === REFUSAL.NOT_READY_BY_MOVE_IN,
      "and refused for a move-in BEFORE the governed date");

    const turn = await resolveApplicationTarget(c, {
      property_id: P, unit_id: U["C-turnover"].unit_id, intended_move_in: farOut });
    ok(turn.marketing_state === "turnover_required", `turn in progress classifies as turnover_required (got ${turn.marketing_state})`);
    ok(turn.ok === false && turn.refusal_code === REFUSAL.DATE_NOT_GOVERNED,
      "a turn record alone does NOT create an availability date — refused even with a far move-in");

    console.log("\n── require_offerable=false REPORTS WITHOUT REFUSING ─────");
    const soft = await resolveApplicationTarget(c, {
      property_id: P, unit_id: U["G-occupied"].unit_id, require_offerable: false });
    ok(soft.ok === true, "policy refusal is reported, not raised, when not required");
    ok(soft.offerable === false && soft.refusal_code === REFUSAL.NOT_OFFERABLE,
      "and the refusal is still stated honestly");
    const softGrain = await resolveApplicationTarget(c, {
      property_id: P, unit_id: U["S-two-space"].unit_id, require_offerable: false });
    ok(softGrain.ok === false && softGrain.refusal_code === REFUSAL.MULTI_SPACE,
      "but a STRUCTURAL grain refusal still refuses — it is not a policy opinion");

    console.log("\n── THE ALLOWLIST IS CLOSED ──────────────────────────────");
    const unknown = evaluateOfferability({ marketing_state: "a_state_from_the_future", available_from: "2020-01-01" }, "2030-01-01");
    ok(unknown.offerable === false, "an unrecognised marketing state is NOT offerable");
    ok(unknown.refusal_code === REFUSAL.NOT_OFFERABLE, "it refuses rather than falling through");

    console.log("\n── NO LEGACY AVAILABILITY DEPENDENCY ────────────────────");
    const src = require("fs").readFileSync(
      path.join(REPO, "src/applications/application_target_authority.js"), "utf8");
    ok(!/require\(["'].*tenancy\/availability["']\)/.test(src),
      "the authority does not import the legacy availability module");
    ok(/surfaces\/availability_read/.test(src), "it reads canonical availability");
    ok(!/lease_applications/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
      "and it never consults application status for inventory");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }

  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`   application-target authority: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
