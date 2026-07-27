// ════════════════════════════════════════════════════════════════════
//  rent_roll_canonical_proof.js — canonical Current Rent Roll and the
//  INDEPENDENT-AXIS aggregation contract, against real Postgres and HTTP.
//
//  The contract under test: unrelated facts are not turned into one status.
//  A position may be contractually occupied AND have inconclusive opening
//  evidence AND have unavailable economics — three facts, three axes, each
//  balancing within itself. Forcing them into one enum makes the totals add
//  up by destroying the ability to explain a position.
//
//  Run: DATABASE_URL=... [API_BASE=... STAFF_SESSION=...] \
//         node tests/rent_roll_canonical_proof.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

const TENANCY = ["contested", "contractually_occupied", "unresolved", "vacant"];
const EVIDENCE = ["confirmed", "disagrees", "inconclusive"];
const ECONOMICS = ["available", "unavailable", "not_applicable"];

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const { currentRentRoll } = require(path.join(REPO, "src/surfaces/rent_roll_canonical"));

  console.log("\n== BLOCK A - positions are the rows ==");
  const rr = await currentRentRoll(pool, { property_id: DEMO });
  const spaces = (await pool.query(
    `select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [DEMO])).rows[0].n;
  ok(rr.rows.length === spaces, `one row per SPACE (${rr.rows.length} = ${spaces}), not per import row`);
  ok(new Set(rr.rows.map(r => r.space_id)).size === rr.rows.length, "space_id unique per row - no join, no duplication");
  ok(rr.rows.every(r => r.position_kind === "unit" || r.position_kind === "bed"), "every row declares unit or bed");
  ok(rr.rows.every(r => r.space_id && r.unit_id), "durable ids on every row");

  console.log("\n== BLOCK B - four independent axes, each balancing within itself ==");
  const axis = (name, vals, key) => {
    ok(rr.rows.every(r => vals.includes(r[key])), `every position has a known ${name} state`);
    const c = {};
    for (const v of vals) c[v] = rr.rows.filter(r => r[key] === v).length;
    const sum = vals.reduce((a, v) => a + c[v], 0);
    const shown = vals.map(v => v + "=" + c[v]).join(" ");
    ok(sum === rr.rows.length, `${name} axis balances: ${shown} -> ${sum}/${rr.rows.length}`);
    return c;
  };
  const ten = axis("tenancy", TENANCY, "tenancy_state");
  const evi = axis("evidence", EVIDENCE, "evidence_state");
  const eco = axis("economics", ECONOMICS, "economics_state");

  console.log("\n== BLOCK B2 - the axes do not cancel each other ==");
  const occInconclusive = rr.rows.filter(r => r.tenancy_state === "contractually_occupied" && r.evidence_state === "inconclusive");
  ok(occInconclusive.length > 0,
    `a spanning lease stays contractually occupied even when opening evidence is inconclusive (${occInconclusive.length})`);
  ok(occInconclusive.some(r => r.contributes_trusted_rent),
    "and it still contributes trusted rent when its rent is populated");
  const occNoRent = rr.rows.filter(r => r.tenancy_state === "contractually_occupied" && r.economics_state === "unavailable");
  ok(occNoRent.length === eco.unavailable,
    `a spanning lease with missing rent stays occupied and is separately economics_unavailable (${occNoRent.length})`);
  ok(occNoRent.every(r => r.contributes_trusted_rent === false), "missing rent contributes zero, never a coerced $0");
  ok(rr.rows.filter(r => r.evidence_state === "inconclusive")
      .every(r => r.imported_occupancy_claim === null || String(r.imported_occupancy_claim).toLowerCase() === "unknown"),
    "an unknown claim is inconclusive - it contradicts nothing and is never called disagreement");
  ok(rr.rows.filter(r => r.tenancy_state === "unresolved").every(r => !r.lease),
    "an imported occupied claim with no spanning lease stays unresolved, never vacant");
  ok(rr.rows.filter(r => r.tenancy_state === "vacant").every(r => String(r.imported_occupancy_claim).toLowerCase() === "vacant"),
    "vacant requires the opening claim to agree");

  console.log("\n== BLOCK C - trusted rent ==");
  const eligible = rr.rows.filter(r => r.contributes_trusted_rent);
  ok(eligible.every(r => r.tenancy_state === "contractually_occupied" && r.economics_state === "available"),
    "only uncontested spanning leases with populated rent contribute");
  const computed = Math.round(eligible.reduce((s, r) => s + Number(r.current_rent || 0), 0) * 100) / 100;
  ok(computed === rr.totals.contractual_rent_trusted,
    `trusted rent = $${rr.totals.contractual_rent_trusted} from ${eligible.length} positions`);
  ok(!rr.rows.some(r => r.tenancy_state === "contested" && r.contributes_trusted_rent),
    "a contested position contributes zero trusted rent");
  ok(new Set(eligible.map(r => r.space_id)).size === eligible.length,
    "one rent-bearing row per space - overlapping leases cannot count twice");
  ok(rr.contested_claims.lease_claims >= rr.contested_claims.spaces * 2,
    `contested claims returned separately (${rr.contested_claims.lease_claims} claims over ${rr.contested_claims.spaces} spaces, $${rr.contested_claims.implicated_rent} implicated)`);
  ok(rr.contested_claims.claims.every(c => c.lease_id && c.space_id), "every disputed claim names its lease and space");

  console.log("\n== BLOCK D - occupancy is explainable ==");
  const occ = rr.totals.contractual_occupancy;
  ok(occ.occupied === ten.contractually_occupied, "occupancy numerator is the tenancy axis only");
  ok(occ.of_leasable_resolved === rr.totals.leasable - ten.contested,
    "the denominator excludes down and contested, and says so");
  ok(occ.reported_beside.unresolved_positions === ten.unresolved
     && occ.reported_beside.evidence_disagrees === evi.disagrees
     && occ.reported_beside.evidence_inconclusive === evi.inconclusive,
    "unresolved, disagreeing and inconclusive counts are reported beside the percentage");
  ok(rr.rows.every(r => r.imported_occupancy_claim !== undefined),
    "the imported claim is retained as an independent axis on every row");

  console.log("\n== BLOCK E - balance is read-only context owned by Money ==");
  ok(rr.rows.some(r => r.balance !== null), "balance is visible on the current view");
  ok(rr.rows.filter(r => r.balance !== null).every(r => r.balance_source === "leases.balance" && r.balance_as_of),
    "every balance carries its source and balance_as_of");
  const dated = await currentRentRoll(pool, { property_id: DEMO, as_of: "2026-10-25" });
  ok(dated.rows.every(r => r.balance === null && r.balance_unavailable_reason === "no_dated_balance_history"),
    "a non-current dated view renders balance honestly unavailable, never today's figure");

  console.log("\n== BLOCK F - opening truth is an extensible receipt ==");
  ok(Array.isArray(rr.opening_truth.sources) && rr.opening_truth.sources.length > 0,
    `opening truth returns a sources ARRAY (${rr.opening_truth.sources.length})`);
  ok(rr.opening_truth.sources.every(s => s.batch_id && s.source_type && "confidence" in s && "status" in s && "source_as_of_date" in s),
    "every source keeps batch id, type, as-of, confidence and status");
  ok(rr.opening_truth.sources.every(s => s.attribution), "every source keeps attribution");
  ok(!!rr.opening_truth.latest_confirmed_source && "latest_reconciliation" in rr.opening_truth,
    "latest confirmed source and latest reconciliation are identified");
  ok(!JSON.stringify(rr.totals).includes("september_1"), "no imported document supplies a headline total");

  console.log("\n== BLOCK G - market_rent is gone from operating truth ==");
  ok(!JSON.stringify(rr).includes("market_rent"), "market_rent appears nowhere in the canonical response");
  const src = require("fs").readFileSync(path.join(REPO, "src/surfaces/rent_roll_canonical.js"), "utf8")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok(!/market_rent/.test(src), "the service's executable source never references market_rent");

  console.log("\n== BLOCK H - real HTTP ==");
  const base = process.env.API_BASE, token = process.env.STAFF_SESSION;
  if (!base) { console.log("   SKIP  no API_BASE"); }
  else {
    const anon = await fetch(`${base}/operator/rent-roll/canonical`);
    ok(anon.status === 401, `no session -> 401 (got ${anon.status})`);
    if (!token) { console.log("   SKIP  no STAFF_SESSION"); }
    else {
      const r = await fetch(`${base}/operator/rent-roll/canonical`, { headers: { "x-staff-session": token } });
      ok(r.status === 200, `valid session -> 200 (got ${r.status})`);
      const b = await r.json();
      ok(b.property_id === DEMO, `property from the SESSION (${b.property_id})`);
      ok(b.rows.length === rr.rows.length, `HTTP row count matches the service (${b.rows.length})`);
      ok(b._migration_route === true, "the route declares itself a migration route");
      const spoof = await fetch(`${base}/operator/rent-roll/canonical?property_id=9e2bb96e-08e2-41db-81c2-91055ceb50a3`,
        { headers: { "x-staff-session": token } });
      ok((await spoof.json()).property_id === DEMO, "a client-supplied property_id is ignored");
    }
  }

  await pool.end();
  console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
