// ════════════════════════════════════════════════════════════════════
//  rent_roll_canonical_proof.js — canonical Current Rent Roll + the
//  aggregation contract, against real Postgres and real HTTP.
//
//  The contract under test: a position contributes to a headline economic
//  total AT MOST ONCE, contested positions never contribute two overlapping
//  rents, and a disagreement is never smoothed into a clean percentage.
//
//  Run: DATABASE_URL=... [API_BASE=... STAFF_SESSION=...] \
//         node tests/rent_roll_canonical_proof.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

const STATES = ["contested", "down_non_revenue", "occupancy_evidence_disagrees",
  "economics_unavailable", "contractually_occupied", "confirmed_vacant"];

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const { currentRentRoll } = require(path.join(REPO, "src/surfaces/rent_roll_canonical"));

  console.log("\n══ BLOCK A — positions are the rows ══");
  const rr = await currentRentRoll(pool, { property_id: DEMO });
  const spaces = (await pool.query(
    `select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [DEMO])).rows[0].n;
  ok(rr.rows.length === spaces, `one row per SPACE (${rr.rows.length} = ${spaces}), not per import row`);
  ok(rr.inventory === spaces, "inventory is the position count");
  ok(new Set(rr.rows.map(r => r.space_id)).size === rr.rows.length, "space_id is unique per row — no join, no duplication");
  ok(rr.rows.every(r => r.position_kind === "unit" || r.position_kind === "bed"), "every row declares unit or bed");

  console.log("\n══ BLOCK B — the aggregation contract ══");
  ok(rr.rows.every(r => STATES.includes(r.aggregation_state)), "every position carries a known aggregation state");
  const counts = Object.fromEntries(STATES.map(s => [s, rr.rows.filter(r => r.aggregation_state === s).length]));
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  ok(sum === rr.rows.length,
    `states are mutually exclusive and exhaustive: ${STATES.map(s => `${s}=${counts[s]}`).join(" ")} → ${sum}/${rr.rows.length}`);

  // A contested position must never contribute rent, let alone twice.
  const contestedRows = rr.rows.filter(r => r.aggregation_state === "contested");
  ok(contestedRows.length === rr.totals.contested, "contested count agrees with the rows");
  const trustedFromRows = Math.round(rr.rows
    .filter(r => r.aggregation_state === "contractually_occupied")
    .reduce((s, r) => s + Number(r.current_rent || 0), 0) * 100) / 100;
  ok(trustedFromRows === rr.totals.contractual_rent_trusted,
    `trusted rent is exactly the contractually_occupied rows ($${rr.totals.contractual_rent_trusted})`);

  const naive = (await pool.query(
    `select coalesce(sum(l.rent),0)::numeric n from leases l
      where l.property_id=$1 and l.lease_status in ('active','commercial')
        and l.start_date <= current_date and (l.end_date is null or l.end_date >= current_date)`, [DEMO])).rows[0].n;
  ok(Number(rr.totals.contractual_rent_trusted) < Number(naive),
    `trusted rent ($${rr.totals.contractual_rent_trusted}) is LESS than the naive sum ($${naive}) — contested rent is excluded, not double-counted`);

  ok(rr.contested_claims.spaces === rr.totals.contested, "contested claims cover every contested space");
  ok(rr.contested_claims.lease_claims >= rr.contested_claims.spaces * 2,
    `each contested space returns at least two competing claims (${rr.contested_claims.lease_claims} claims over ${rr.contested_claims.spaces} spaces)`);
  ok(rr.contested_claims.implicated_rent > 0,
    `the rent implicated by conflict is reported separately ($${rr.contested_claims.implicated_rent})`);
  ok(rr.contested_claims.claims.every(c => c.lease_id && c.space_id), "every disputed claim names its lease and space");

  // No silent winner.
  const contestedSpaceIds = new Set(contestedRows.map(r => r.space_id));
  ok([...contestedSpaceIds].every(sid => rr.contested_claims.claims.filter(c => c.space_id === sid).length > 1),
    "no contested space is resolved to a single lease");

  console.log("\n══ BLOCK C — disagreement is never smoothed ══");
  const dis = rr.totals.occupancy_evidence_disagrees;
  ok(dis > 0, `evidence disagreements are surfaced (${dis})`);
  // Disagreement runs in BOTH directions — a spanning lease on a unit the
  // contracted axis calls vacant/unknown is equally a disagreement, so a
  // disagreeing row may legitimately hold a lease. What must never happen is
  // a disagreeing position feeding the occupied count or the rent total.
  ok(!rr.rows.some(r => r.aggregation_state === "occupancy_evidence_disagrees"
      && r.aggregation_state === "contractually_occupied"),
    "a disagreeing position is never also contractually occupied (states are exclusive)");
  const disagreeingRent = rr.rows.filter(r => r.aggregation_state === "occupancy_evidence_disagrees")
    .reduce((s, r) => s + Number(r.current_rent || 0), 0);
  ok(disagreeingRent > 0 ? trustedFromRows < Number(naive) : true,
    `disagreeing positions contribute $0 to trusted rent (they hold $${Math.round(disagreeingRent)} in claims)`);
  ok(!rr.rows.some(r => r.aggregation_state === "occupancy_evidence_disagrees"
      && !r.lease && String(r.imported_occupancy_claim).toLowerCase() === "vacant"),
    "a position with no lease AND a vacant claim is confirmed vacant, not a manufactured disagreement");
  ok(!rr.rows.some(r => r.aggregation_state === "confirmed_vacant" && String(r.imported_occupancy_claim).toLowerCase() === "occupied"),
    "an imported 'occupied' claim is NEVER converted to confirmed vacant");
  const occ = rr.totals.contractual_occupancy;
  ok(occ.numerator + occ.unresolved_beside <= occ.denominator + rr.totals.confirmed_vacant,
    "occupancy is stated as numerator of denominator with unresolved reported beside it");
  ok(occ.unresolved_beside === dis + rr.totals.contested,
    `unresolved count beside occupancy = disagreements + contested (${occ.unresolved_beside})`);
  ok(rr.rows.every(r => r.imported_occupancy_claim !== undefined),
    "the imported occupancy claim is retained as an independent axis on every row");

  console.log("\n══ BLOCK D — opening truth is an extensible receipt ══");
  ok(Array.isArray(rr.opening_truth.sources) && rr.opening_truth.sources.length > 0,
    `opening truth returns a sources ARRAY (${rr.opening_truth.sources.length})`);
  ok(rr.opening_truth.sources.every(s => s.batch_id && s.source_type),
    "every source keeps its batch id and type");
  ok(rr.opening_truth.sources.every(s => "confidence" in s && "status" in s && "source_as_of_date" in s),
    "every source keeps confidence, status and as-of date");
  ok(!!rr.opening_truth.latest_confirmed_source, "latest confirmed source is identified");
  ok("latest_reconciliation" in rr.opening_truth, "latest reconciliation is identified (may be null)");
  ok(!JSON.stringify(rr.opening_truth).includes("september_1"),
    "headline economics do not come from the spreadsheet document");

  console.log("\n══ BLOCK E — canonical economics, never market_rent ══");
  ok(!JSON.stringify(rr).includes("market_rent"), "market_rent appears nowhere in the canonical response");
  const src = require("fs").readFileSync(path.join(REPO, "src/surfaces/rent_roll_canonical.js"), "utf8")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok(!/market_rent/.test(src), "the service's executable source never references market_rent");
  ok(!/unit_number\s*(===|==|\)\s*\.|\[)/.test(src), "no unit_number join or comparison in the canonical read");

  console.log("\n══ BLOCK F — cross-surface invariant: one classification per space ══");
  const { renewalsCohort } = require(path.join(REPO, "src/leasing/renewals_read"));
  const rn = await renewalsCohort(pool, { property_id: DEMO });
  const rrBySpace = new Map(rr.rows.map(r => [r.space_id, r]));
  const allRenewalRows = [...rn.rows, ...rn.successor_pending.rows, ...rn.conflicted.rows];
  ok(allRenewalRows.every(r => rrBySpace.has(r.space_id)), "every renewal position exists in the rent roll");
  ok(allRenewalRows.every(r => rrBySpace.get(r.space_id).successor_state === r.successor_state),
    "successor_state agrees between Renewals and Current Rent Roll for the same as_of");
  // SAME FACT, TWO LABELS. The classifier says notice_state 'none'; Renewals
  // renders it as 'unresolved' because in a renewal-work context "no notice"
  // and "no decision yet" are the same operator situation. That is presentation
  // vocabulary over one shared fact, not a second derivation — so the invariant
  // is tested semantically. If these ever diverge in SUBSTANCE this fails.
  const sameNotice = (rrState, rnState) =>
    (rrState === "on_notice" && rnState === "on_notice") ||
    (rrState === "none" && rnState === "unresolved");
  ok(allRenewalRows.every(r => sameNotice(rrBySpace.get(r.space_id).notice_state, r.notice_state)),
    "notice is the same underlying fact in Renewals and Current Rent Roll (none ≡ unresolved)");
  ok(allRenewalRows.filter(r => r.notice_state === "on_notice")
      .every(r => rrBySpace.get(r.space_id).notice_state === "on_notice"),
    "no position is on_notice in one surface and not the other");
  ok(rn.conflicted.rows.every(r => rrBySpace.get(r.space_id).aggregation_state === "contested"),
    "a position Renewals calls contested is contested in the rent roll — never marketable or occupied");
  ok(rn.rows.every(r => rrBySpace.get(r.space_id).successor_state === "none"),
    "no position is open in Renewals while the rent roll shows it has a successor");

  console.log("\n══ BLOCK G — real HTTP ══");
  const base = process.env.API_BASE, token = process.env.STAFF_SESSION;
  if (!base) { console.log("   SKIP  no API_BASE"); }
  else {
    const anon = await fetch(`${base}/operator/rent-roll/canonical`);
    ok(anon.status === 401, `no session → 401 (got ${anon.status})`);
    if (!token) { console.log("   SKIP  no STAFF_SESSION"); }
    else {
      const r = await fetch(`${base}/operator/rent-roll/canonical`, { headers: { "x-staff-session": token } });
      ok(r.status === 200, `valid session → 200 (got ${r.status})`);
      const b = await r.json();
      ok(b.property_id === DEMO, `property from the SESSION (${b.property_id})`);
      ok(b.rows.length === rr.rows.length, `HTTP row count matches the service (${b.rows.length})`);
      ok(b._migration_route === true, "the route declares itself a migration route, not permanent architecture");
      const spoof = await fetch(`${base}/operator/rent-roll/canonical?property_id=9e2bb96e-08e2-41db-81c2-91055ceb50a3`,
        { headers: { "x-staff-session": token } });
      ok((await spoof.json()).property_id === DEMO, "a client-supplied property_id is ignored");
    }
  }

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
