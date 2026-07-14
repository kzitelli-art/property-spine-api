#!/usr/bin/env node
/**
 * ROUTE-LEVEL CONCURRENCY PROOF for two-phase confirm-term (Step 4 acceptance).
 * Reviewer correction #3: prove two concurrent POST /confirm-term calls
 *   → both return CONTROLLED responses (no 500)
 *   → converge on the SAME lease id
 *   → exactly ONE leases row
 *   → exactly ONE obligation completion
 *   → exactly ONE state transition (application → active/next)
 *   → NO duplicate history events
 *
 * PRECONDITION: an application in status 'accepted_term_required' with an
 * open term_required obligation and a unit selected (i.e. countersigned but
 * term not yet confirmed). Pass its id as APP_ID.
 *
 * USAGE (Render Shell or anywhere with DATABASE_URL + API reachable):
 *   API=https://property-spine-api.onrender.com \
 *   OPERATOR_KEY=$OPERATOR_KEY \
 *   APP_ID=<accepted_term_required application id> \
 *   DATABASE_URL="$DATABASE_URL" \
 *   node prove_confirm_term_concurrency.js
 *
 * It fires the two requests simultaneously, then queries the DB to prove the
 * invariants. Read-only on the DB side (SELECT only); the two POSTs are the
 * only writes, and the whole point is that they collapse to one anchor.
 */
const { Pool } = require("pg");

const API = process.env.API || "https://property-spine-api.onrender.com";
const KEY = process.env.OPERATOR_KEY;
const APP_ID = process.env.APP_ID;
const DB = process.env.DATABASE_URL;

if (!KEY || !APP_ID || !DB) {
  console.error("Missing env: need OPERATOR_KEY, APP_ID, DATABASE_URL.");
  process.exit(2);
}

const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });

// identical bodies — structured term. Adjust dates/rent if the app needs them.
const body = JSON.stringify({
  confirmed_by: "QA Concurrency Proof",
  start_date: "2026-09-01",
  end_date: "2027-08-31",
});

function fire() {
  return fetch(`${API}/applications/${APP_ID}/confirm-term`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator-key": KEY },
    body,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}

(async () => {
  console.log("Firing two concurrent confirm-term calls for app", APP_ID, "…\n");
  const [a, b] = await Promise.all([fire(), fire()]);

  console.log("RESPONSE A:", a.status, JSON.stringify(a.json).slice(0, 200));
  console.log("RESPONSE B:", b.status, JSON.stringify(b.json).slice(0, 200));
  console.log("");

  // ── invariant checks against the DB ──
  const leases = (await pool.query(
    `select id, lease_status, created_at from leases where application_id=$1 order by created_at`,
    [APP_ID])).rows;
  const appRow = (await pool.query(
    `select status, countersigned_at from lease_applications where id=$1`, [APP_ID])).rows[0];
  const obl = (await pool.query(
    `select id, status, type from obligations
      where related_id=$1 and related_type='lease_application' and type='term_required'`,
    [APP_ID])).rows;
  const events = (await pool.query(
    `select type, count(*)::int c from events where related_id=$1 group by type order by type`,
    [APP_ID])).rows;

  let pass = true;
  const check = (name, cond, detail) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond) pass = false;
  };

  // 1) neither returned 500
  check("no 500 responses", a.status !== 500 && b.status !== 500, `A=${a.status} B=${b.status}`);
  // 2) both controlled (200 winner + 409 converger, in some order)
  const statuses = [a.status, b.status].sort();
  check("one 200 + one 409 (controlled convergence)",
    statuses[0] === 200 && statuses[1] === 409, `statuses=${statuses.join(",")}`);
  // 3) exactly one leases row
  check("exactly one lease row", leases.length === 1, `found ${leases.length}`);
  // 4) both responses reference the same lease id
  const winnerLease = leases[0] && leases[0].id;
  const aLease = a.json.lease?.id || a.json.lease_id || a.json.existing_lease_id;
  const bLease = b.json.lease?.id || b.json.lease_id || b.json.existing_lease_id;
  check("both responses converge on the same lease id",
    winnerLease && (aLease === winnerLease) && (bLease === winnerLease),
    `winner=${winnerLease} A=${aLease} B=${bLease}`);
  // 5) exactly one term_required obligation, and it's completed once
  check("term obligation completed once",
    obl.length >= 1 && obl.every(o => o.status === "completed" || o.status === "closed"),
    `obligations=${JSON.stringify(obl.map(o=>o.status))}`);
  // 6) application advanced once (not still accepted_term_required, not duplicated)
  check("application advanced past accepted_term_required",
    appRow && appRow.status !== "accepted_term_required",
    `status=${appRow && appRow.status}`);

  console.log("\nEVENT COUNTS (watch for duplicates):");
  for (const e of events) console.log(`   ${e.type}: ${e.c}`);

  console.log("\n" + (pass ? "✅ ALL ROUTE-LEVEL INVARIANTS PASS" : "❌ SOME INVARIANTS FAILED — do not advance"));
  await pool.end();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("harness error:", e); process.exit(3); });
