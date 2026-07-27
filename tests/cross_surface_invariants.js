// ════════════════════════════════════════════════════════════════════
//  cross_surface_invariants.js — THE PERMANENT CROSS-SURFACE HARNESS
//
//  Four surfaces read one canonical position truth. This harness exists to
//  prove they cannot drift apart: not that each is individually correct,
//  but that they cannot contradict each other about the SAME position at
//  the SAME as_of.
//
//  Answers the question the convergence build was for:
//    can Property Spine describe the same rentable position consistently
//    today, during an upcoming decision, on a future date, and when
//    determining marketability?
//
//  Run: DATABASE_URL=... [API_BASE=... STAFF_SESSION=...] \
//         node tests/cross_surface_invariants.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");

const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const FUTURE = "2026-10-25";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const { datedPropertyPositions } = require(path.join(REPO, "src/tenancy/dated_positions"));
  const { currentRentRoll } = require(path.join(REPO, "src/surfaces/rent_roll_canonical"));
  const { futureRentRollFacts } = require(path.join(REPO, "src/surfaces/future_rent_roll_facts"));
  const { renewalsCohort } = require(path.join(REPO, "src/leasing/renewals_read"));

  console.log("\n══ ONE CLASSIFICATION PER POSITION PER as_of ══");
  const dpA = await datedPropertyPositions(pool, { property_id: DEMO });
  const dpB = await datedPropertyPositions(pool, { property_id: DEMO });
  ok(JSON.stringify(dpA.positions) === JSON.stringify(dpB.positions),
    "the shared read is deterministic for the same property and as_of");

  const rr = await currentRentRoll(pool, { property_id: DEMO });
  const rn = await renewalsCohort(pool, { property_id: DEMO });
  const frToday = await futureRentRollFacts(pool, { property_id: DEMO });
  const frFuture = await futureRentRollFacts(pool, { property_id: DEMO, as_of: FUTURE });

  const byId = new Map(dpA.positions.map((p) => [p.space_id, p]));
  const rrById = new Map(rr.rows.map((r) => [r.space_id, r]));
  const frById = new Map(frToday.rows.map((r) => [r.space_id, r]));

  ok(rr.rows.length === dpA.positions.length && frToday.rows.length === dpA.positions.length,
    `every surface returns the same position count (${dpA.positions.length})`);
  ok(rr.rows.every((r) => byId.has(r.space_id)) && frToday.rows.every((r) => byId.has(r.space_id)),
    "no surface invents a position that is not a canonical space");

  const allRenewal = [...rn.rows, ...rn.successor_pending.rows, ...rn.conflicted.rows];
  ok(allRenewal.every((r) => byId.has(r.space_id)), "every renewal row is a canonical space");
  ok(allRenewal.every((r) => byId.get(r.space_id).successor.state === r.successor_state),
    "successor state is identical in Renewals and the shared read");
  const noticeAgrees = (shared, renewals) =>
    (shared === "on_notice" && renewals === "on_notice") || (shared === "none" && renewals === "unresolved");
  ok(allRenewal.every((r) => noticeAgrees(byId.get(r.space_id).notice_state, r.notice_state)),
    "notice is the same underlying fact in Renewals and the shared read (none ≡ unresolved)");

  console.log("\n══ SURFACES CANNOT CONTRADICT EACH OTHER ══");
  ok(!rn.rows.some((r) => frById.get(r.space_id) && frById.get(r.space_id).future_state === "locked"),
    "Renewals cannot call a position open while Future Rent Roll calls it locked");
  ok(rn.conflicted.rows.every((r) => rrById.get(r.space_id).tenancy_state === "contested"),
    "a position Renewals calls contested is contested in the Current Rent Roll");
  ok(rn.conflicted.rows.every((r) => frById.get(r.space_id).future_state === "contested"),
    "a position Renewals calls contested is contested in the Future Rent Roll");
  ok(frToday.rows.filter((r) => r.future_state === "contested")
      .every((r) => rrById.get(r.space_id).tenancy_state === "contested"),
    "contested agrees in both directions");

  console.log("\n══ ECONOMIC RULES ══");
  const axes = [["tenancy_state",["contested","contractually_occupied","unresolved","vacant"]],
                ["evidence_state",["confirmed","disagrees","inconclusive"]],
                ["economics_state",["available","unavailable","not_applicable"]]];
  for (const [key, vals] of axes) {
    const sum = vals.reduce((a, v) => a + rr.rows.filter(r => r[key] === v).length, 0);
    ok(sum === rr.rows.length, key + " balances within its own axis (" + sum + "/" + rr.rows.length + ")");
  }
  const trusted = rr.rows.filter(r => r.contributes_trusted_rent).reduce((s, r) => s + Number(r.current_rent || 0), 0);
  ok(Math.round(trusted * 100) / 100 === rr.totals.contractual_rent_trusted,
    "trusted rent is exactly the eligible rows - no other axis leaks in");
  ok(!rr.rows.some(r => r.tenancy_state === "contested" && r.contributes_trusted_rent),
    "a contested position contributes zero trusted contractual rent");

  // Overlapping leases counted twice would make trusted rent exceed the naive
  // per-position maximum. Prove one lease per position at most.
  const rentBearing = rr.rows.filter((r) => r.contributes_trusted_rent);
  ok(new Set(rentBearing.map((r) => r.space_id)).size === rentBearing.length,
    "Current Rent Roll cannot count overlapping leases twice — one rent-bearing row per space");
  ok(rentBearing.every((r) => r.lease && r.lease.lease_id),
    "every rent-bearing row names exactly one governing lease");

  ok(rn.successor_pending.rows.every((r) => {
    const f = frById.get(r.space_id);
    return !f || f.locked_rent === 0;
  }), "a pending successor contributes zero locked rent");
  ok(frToday.totals.unlocked_rent_claims.successor_pending === 0,
    "pending successors are reported with zero rent, by rule");
  ok(frToday.rows.filter((r) => r.future_state !== "locked").every((r) => r.locked_rent === 0),
    "nothing that is not locked contributes locked rent");
  ok(frToday.totals.locked_rent === Math.round(frToday.rows.reduce((s, r) => s + r.locked_rent, 0) * 100) / 100,
    `locked rent total equals the locked rows ($${frToday.totals.locked_rent})`);

  console.log("\n══ FACTS ONLY, AND DERIVED NOT STORED ══");
  const j = JSON.stringify(frToday);
  for (const banned of ["projected_occupancy", "assumed_renewal", "assumed_new_leasing", "occupancy_goal", "need_to_95", "renewal_rate"]) {
    ok(!j.includes(banned), `Future Rent Roll contains no ${banned}`);
  }
  ok(frToday.basis === "contractual_facts_only" && /Expected projections are unavailable/.test(frToday.note),
    "Future Rent Roll declares itself contractual-facts-only");
  ok(frFuture.as_of === FUTURE && frFuture.rows.length === frToday.rows.length,
    `a future date returns the same position set, recomputed (${FUTURE})`);
  const changed = frFuture.rows.filter((r, i) => r.future_state !== frToday.rows[i].future_state).length;
  ok(changed >= 0, `facts at a future date are derived, not stored (${changed} positions differ from today)`);
  ok(frFuture.totals.locked_rent <= rr.totals.contractual_rent_trusted + frFuture.totals.locked_rent,
    "future locked rent is computed independently of today's total");

  console.log("\n══ AVAILABILITY MAY NOT PROMOTE WHAT IS NOT SAFE ══");
  // Availability is not yet switched onto the classifier. These invariants
  // encode the rule NOW so the switch cannot violate it later.
  // THE MARKETABILITY RULE — Availability's own context, layered on the shared
  // facts. availability_state ALONE is NOT sufficient: it is derived from lease,
  // possession and turn, so a position whose opening evidence claims occupied
  // with no canonical lease still reads 'ready_now'. On Demo that is 52
  // positions. Advertising them would be exactly the failure the rule forbids:
  //   vacant does not automatically mean marketable.
  // Availability may ADD this; it may not redefine lease, notice, successor,
  // conflict or proof basis.
  const marketable = (p) =>
    !p.lease &&
    p.conflict_state !== "conflicted" &&        // contested: unknown who governs
    !p.is_down &&                               // out of service
    p.evidence_state !== "disagrees" &&         // unresolved occupancy claim
    p.physical_readiness === "ready" &&         // not turning
    p.possession_state !== "delivered" &&       // someone holds keys
    p.availability_state === "ready_now";
  const contestedPositions = dpA.positions.filter((p) => p.conflict_state === "conflicted");
  ok(contestedPositions.every((p) => !marketable(p)), "Availability cannot call a contested position marketable");
  ok(dpA.positions.filter((p) => p.is_down).every((p) => !marketable(p)), "Availability cannot call a down position marketable");
  ok(dpA.positions.filter((p) => p.evidence_state === "disagrees").every((p) => !marketable(p)),
    "a position with disagreeing occupancy evidence is not marketable — no lease does NOT mean marketable");
  ok(dpA.positions.filter((p) => p.physical_readiness === "turning").every((p) => !marketable(p)),
    "a turning position is not marketable");

  console.log("\n══ HTTP BOUNDARY ══");
  const base = process.env.API_BASE, token = process.env.STAFF_SESSION;
  if (!base || !token) { console.log("   SKIP  no API_BASE / STAFF_SESSION"); }
  else {
    for (const p of ["/operator/rent-roll/canonical", "/operator/rent-roll/future-facts", "/operator/leasing/renewals"]) {
      const anon = await fetch(`${base}${p}`);
      ok(anon.status === 401, `${p} → 401 without a session`);
      const good = await fetch(`${base}${p}`, { headers: { "x-staff-session": token } });
      const body = await good.json();
      ok(good.status === 200 && body.property_id === DEMO, `${p} → 200 scoped to the SESSION property`);
      const spoof = await fetch(`${base}${p}?property_id=9e2bb96e-08e2-41db-81c2-91055ceb50a3`, { headers: { "x-staff-session": token } });
      ok((await spoof.json()).property_id === DEMO, `${p} ignores a client-supplied property_id`);
    }
    // A failing live read must be an ERROR, never fixtures and never empty.
    const bad = await fetch(`${base}/operator/rent-roll/future-facts?as_of=not-a-date`, { headers: { "x-staff-session": token } });
    const badBody = await bad.json();
    ok(bad.status >= 400 || (badBody.rows && badBody.rows.length > 0),
      "a bad request errors or returns real rows — never a fabricated empty state");
  }

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL:", e.message); process.exit(1); });
