/* ══════════════════════════════════════════════════════════════════════════
   management_read_grain_label.test.js — /management-read GUESSED THE GRAIN.

   WHAT WAS WRONG
   --------------
   src/surfaces/management_read.js computed the building's leasing grain from
   the shape of its own rows:

       const basis = maxSpaces > 1 ? "bed" : "unit";

   Migration 026 created `leasing_basis = 'unknown'` for the express purpose
   of preventing that, in its own words: the declared basis lets the system
   "flag declared-vs-observed mismatches instead of silently guessing from
   row patterns." This route was the guess. Consequences, all real:

     · A by-the-bed building whose beds are not materialized yet has
       maxSpaces === 1, so the read labelled its counts "units" — in
       contradiction of the property's own declared 'bed', with nothing
       anywhere saying so.
     · It could never report "not established". Every property got a noun.
     · It never read properties.leasing_basis at all, so this route and
       every other reader of the grain could disagree by construction.

   WHAT THIS PROTECTS, AND WHAT IT DELIBERATELY DOES NOT
   -----------------------------------------------------
   The basis in this route is LABEL ONLY — verified: no total, percentage or
   classification depends on it. So the correction is a labelling one and the
   read is NOT refused: counts of spaces are true whether or not anybody has
   declared what a leasable position is. What changes is that an undeclared
   grain now says 'spaces' and carries basis_state 'not_established' plus a
   sayable receipt, instead of borrowing a noun from row shape.

   The route handler is EXECUTED here against a stub pool — not scanned. A
   source scan is what let a missing require ship five commits in this repo
   (CURRENT_STATE row 125).

   Run:  node tests/unit/management_read_grain_label.test.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const assert = require("assert");
const { grainCountLabel } = require("../../src/tenancy/leasing_grain");
const managementRead = require("../../src/surfaces/management_read");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

console.log("\n== the count noun has THREE answers, because the column has three states ==");
ok(grainCountLabel("bed") === "beds", "'bed' counts beds");
ok(grainCountLabel("unit") === "units", "'unit' counts units");
ok(grainCountLabel("unknown") === "spaces", "'unknown' counts SPACES — it does not borrow 'units'");
ok(grainCountLabel(null) === "spaces", "null counts spaces");
ok(grainCountLabel("") === "spaces", "empty counts spaces");
ok(grainCountLabel("BED") === "beds", "case does not change the answer");

/*  One unit, one space — the shape that used to be inferred as 'unit'
 *  whatever the property said. Enough columns for the classification loop. */
const SPACE_ROW = {
  unit_id: "u1", unit_number: "101", space_id: "s1", space_label: "Room1",
  market_rent: "900.00", cur_lease_id: null, cur_rent: null, cur_balance: null,
  cur_status: null, cur_tenant: null, fut_lease_id: null,
};

/*  A pool whose client answers the two queries the route makes, in order:
 *  the space rows, then properties.leasing_basis. Recorded so the test can
 *  assert the column is actually read rather than assumed. */
function stubPool(leasingBasis, rows) {
  const seen = [];
  return {
    seen,
    connect: async () => ({
      query: async (sql, params) => {
        seen.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
        if (/from properties/.test(sql)) return { rows: [{ leasing_basis: leasingBasis }] };
        return { rows: rows === undefined ? [SPACE_ROW] : rows };
      },
      release: () => {},
    }),
  };
}

/*  Drive the REAL express handler. No HTTP, no database — but the actual
 *  function body, so a missing binding or a stale identifier is a failure
 *  here and not a surprise in production. */
async function callRoute(leasingBasis, rows) {
  const pool = stubPool(leasingBasis, rows);
  const router = managementRead({ pool });
  const layer = router.stack.find(l => l.route && /management-read/.test(l.route.path));
  assert(layer, "the /management-read route was not found on the router");
  let body = null, status = 200;
  const res = { json: (b) => { body = b; }, status: (s) => { status = s; return res; } };
  await new Promise((resolve, reject) => {
    layer.route.stack[0].handle({ params: { id: "p1" }, query: {} }, res, (e) => e ? reject(e) : resolve());
    setTimeout(resolve, 0);
  });
  // the handler is async; wait for the json call
  for (let i = 0; i < 50 && body === null; i++) await new Promise(r => setImmediate(r));
  return { body, status, pool };
}

(async () => {
  console.log("\n== the route READS properties.leasing_basis ==");
  {
    const { body, pool } = await callRoute("bed");
    ok(pool.seen.some(q => /select leasing_basis from properties/.test(q.sql)),
      "the column is queried (it was never read before this change)");
    ok(pool.seen.some(q => /from properties/.test(q.sql) && q.params && q.params[0] === "p1"),
      "and queried FOR THIS PROPERTY, not globally");
    ok(body && body.basis === "bed",
      "a declared 'bed' is reported as 'bed' — on a one-space-per-unit shape that " +
      "the old inference would have called 'unit' (got " + (body && body.basis) + ")");
    ok(body.unit_label === "beds", "and the counts are called beds");
    ok(body.basis_state === "declared", "basis_state says the property declared it");
    ok(body.basis_receipt === null, "no receipt is needed when it is declared");
  }

  console.log("\n== a declared 'unit' is honoured even on a multi-space shape ==");
  {
    const many = [SPACE_ROW,
      Object.assign({}, SPACE_ROW, { space_id: "s2", space_label: "Room2" }),
      Object.assign({}, SPACE_ROW, { space_id: "s3", space_label: "Room3" })];
    const { body } = await callRoute("unit", many);
    ok(body.basis === "unit", "the property's answer wins over the row pattern");
    ok(body.unit_label === "units", "and the noun follows the declaration");
    ok(body.occupancy.total_spaces === 3,
      "the COUNTS are unchanged — they were always counts of spaces (got " +
      body.occupancy.total_spaces + ")");
  }

  console.log("\n== 'unknown' says so, and does not borrow a noun ==");
  {
    const { body } = await callRoute("unknown");
    ok(body.basis === null, "basis is null, not 'unit'");
    ok(body.basis_state === "not_established", "basis_state names the silence");
    ok(body.unit_label === "spaces", "the counts are called spaces");
    ok(/has not been established as leasing by bed or by unit/.test(body.basis_receipt || ""),
      "the receipt is sayable to a person");
    ok(/Choose the property grain/.test(body.basis_receipt || ""),
      "and it names the next step (a refusal a user can see is product copy)");
    ok(body.occupancy && body.occupancy.total_spaces === 1,
      "the read still ANSWERS — space counts are true whether or not the grain is declared");
  }

  console.log("\n== the read does not fall over when the property row is missing ==");
  {
    const pool = { connect: async () => ({
      query: async (sql) => (/from properties/.test(sql) ? { rows: [] } : { rows: [SPACE_ROW] }),
      release: () => {} }) };
    const router = managementRead({ pool });
    const layer = router.stack.find(l => l.route && /management-read/.test(l.route.path));
    let body = null;
    const res = { json: (b) => { body = b; }, status: () => res };
    layer.route.stack[0].handle({ params: { id: "p1" }, query: {} }, res, () => {});
    for (let i = 0; i < 50 && body === null; i++) await new Promise(r => setImmediate(r));
    ok(body && body.basis === null && body.unit_label === "spaces",
      "no property row reads as not established, not as a crash and not as 'unit'");
  }

  console.log("\n== " + pass + " passed, " + fail + " failed ==\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(2); });
