// ════════════════════════════════════════════════════════════════════
//  availability_canonical_proof.js — Availability over the shared classifier
//
//  The rule this file exists to defend:
//        vacant  ≠  ready  ≠  marketable
//  Absence of a lease is not evidence of availability. Every position that
//  cannot be marketed must say, in one reason, what prevents it.
//
//  Run: DATABASE_URL=... [API_BASE=... STAFF_SESSION=...] \
//         node tests/availability_canonical_proof.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const { seedInventory } = require("./fixtures/slice9_inventory_fixture");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

// Local Postgres speaks no SSL; Neon requires it. Deciding from the URL keeps
// one harness runnable in both places.
const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl });
  const pg = await pool.connect();
  await pg.query("begin");
  const seeded = await seedInventory(pg);
  const DEMO = seeded.property_id;   // the SCRATCH property, seeded by this proof
  const { availabilityRead, marketingState } = require(path.join(REPO, "src/surfaces/availability_read"));
  const { datedPropertyPositions } = require(path.join(REPO, "src/tenancy/dated_positions"));
  const { currentRentRoll } = require(path.join(REPO, "src/surfaces/rent_roll_canonical"));
  const { renewalsCohort } = require(path.join(REPO, "src/leasing/renewals_read"));
  const { futureRentRollFacts } = require(path.join(REPO, "src/surfaces/future_rent_roll_facts"));

  const av = await availabilityRead(pg, { property_id: DEMO });
  const dp = await datedPropertyPositions(pg, { property_id: DEMO });
  const rr = await currentRentRoll(pg, { property_id: DEMO });
  const rn = await renewalsCohort(pg, { property_id: DEMO });
  const fr = await futureRentRollFacts(pg, { property_id: DEMO });
  const byId = new Map(dp.positions.map(p => [p.space_id, p]));

  // ══════════════════════════════════════════════════════════════
  //  POPULATION FIRST — assert the fixtures EXIST before asserting how they
  //  behave. This proof previously hardcoded Demo Building and seeded nothing,
  //  so on a database where that property has no spaces it failed 4 assertions
  //  that were really reading an empty set. An empty-population failure and a
  //  real defect are indistinguishable in that shape, and the mirror image is
  //  worse: the same proof passes VACUOUSLY when every filtered list is empty.
  // ══════════════════════════════════════════════════════════════
  console.log("\n== FIXTURE POPULATION ==");
  ok(!!DEMO, "a scratch property was created by this proof");
  const popn = (await pg.query(
    `select (select count(*) from units where property_id=$1)::int u,
            (select count(*) from spaces s join units n on n.id=s.unit_id
              where n.property_id=$1)::int s`, [DEMO])).rows[0];
  ok(popn.u === 20, `20 units seeded (${popn.u})`);
  ok(popn.s === 20, `20 spaces seeded — 18 sole + 2 on the two-space unit, 0 on the zero-space unit (${popn.s})`);

  console.log("\n== ONE POSITION, ONE STATE ==");
  ok(av.count === dp.positions.length, `one row per canonical position (${av.count})`);
  ok(av.rows.every(r => byId.has(r.space_id)), "availability invents no position");
  const sum = Object.values(av.states).reduce((a, b) => a + b, 0);
  ok(sum === av.count, `states are exclusive and exhaustive (${sum}/${av.count})`);
  ok(av.rows.every(r => r.marketing_state === "marketable_now" ? !r.blocking_reason : !!r.blocking_reason),
    "every non-marketable position states exactly one blocking reason");
  ok(av.rows.every(r => r.blocking_label), "every state has operator-readable language");

  // Every state this proof goes on to assert about must actually be present.
  // Without this, "a contested position is never marketable" passes when there
  // is no contested position at all.
  console.log("\n== EXPECTED STATE POPULATIONS ARE NONZERO ==");
  for (const st of ["marketable_now", "upcoming", "occupied", "turnover_required",
                    "successor_locked", "successor_pending", "activation_pending",
                    "contested", "evidence_disagrees", "down", "not_marketable_use",
                    "readiness_unknown"]) {
    ok(av.states[st] > 0, `${st} is populated (${av.states[st]})`);
  }

  console.log("\n== vacant != ready != marketable ==");
  const marketable = av.rows.filter(r => r.marketing_state === "marketable_now");
  const noLease = av.rows.filter(r => !r.lease_id);
  ok(marketable.length < noLease.length,
    `${noLease.length} positions have no spanning lease, but only ${marketable.length} are marketable`);
  ok(marketable.every(r => !r.lease_id), "a marketable position is never contractually occupied");
  ok(marketable.every(r => r.conflict_state !== "conflicted"), "a contested position is never marketable");
  ok(marketable.every(r => r.evidence_state !== "disagrees"), "an evidence-disagreement position is never marketable");
  ok(marketable.every(r => !r.is_down), "a down position is never marketable");
  ok(marketable.every(r => r.successor_state === "none"), "a position with any successor is never marketable");
  ok(marketable.every(r => r.physical_readiness === "ready"), "a turning position is never marketable");
  ok(marketable.every(r => r.possession_state !== "delivered"), "a position still in possession is never marketable");
  ok(marketable.every(r => r.operating_use === "standard"), "a non-standard operating designation is never marketable");
  ok(marketable.every(r => r.use_type), "a position with no governed use type is never marketable");

  console.log("\n== the positions that must stay blocked ==");
  const disagree = av.rows.filter(r => r.marketing_state === "evidence_disagrees");
  ok(disagree.length === rr.exceptions.evidence_disagrees,
    `every evidence-disagreement position is blocked (${disagree.length})`);
  ok(disagree.every(r => r.blocking_reason === "opening_source_claims_occupied_without_lease"),
    "and each says exactly why");
  const contested = av.rows.filter(r => r.marketing_state === "contested");
  ok(contested.length === rr.exceptions.contested, `every contested position is blocked (${contested.length})`);
  const model = av.rows.find(r => r.operating_use === "model");
  ok(model && model.marketing_state === "not_marketable_use",
    `the model unit is blocked by operating designation (${model ? model.unit_number : "none"})`);
  ok(model && model.use_type === "residential",
    "and keeps its durable residential use - an operating designation is not a use");
  const activation = av.rows.filter(r => r.marketing_state === "activation_pending");
  ok(activation.length > 0 && activation.every(r => !r.lease_id),
    `a commenced-but-unactivated lease blocks marketing (${activation.map(r => r.unit_number).join(", ")})`);

  console.log("\n== available_from is honest ==");
  ok(marketable.every(r => r.available_from === av.as_of && r.availability_confidence === "confirmed"),
    "a marketable position is available today, confirmed");
  ok(av.rows.filter(r => r.marketing_state === "occupied").every(r => r.available_from === null),
    "a lease expiration is NOT an availability date");
  ok(av.rows.filter(r => r.marketing_state === "occupied").every(r => /^lease_runs_to_|no_lease_end_date/.test(r.blocking_fact || "")),
    "an occupied position names the fact that blocks a date");
  ok(av.rows.filter(r => r.available_from === null).every(r => r.availability_confidence === "incomplete"),
    "no date means incomplete confidence, never a silent gap");
  const src = require("fs").readFileSync(path.join(REPO, "src/surfaces/availability_read.js"), "utf8")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok(!/\b(5|7|14|21|30)\s*\*\s*86400000/.test(src) && !/turnover_days|TURN_DAYS/.test(src),
    "no invented standard turnover duration exists in the source");
  ok(!/market_rent|pricing|concession/i.test(src), "no pricing, market rent or concession anywhere in Availability");

  console.log("\n== consumes, never re-derives ==");
  ok(!/notice_given/.test(src), "no independent notice query");
  ok(!/lease_status/.test(src), "no independent lease-status logic");
  ok(!/rangesOverlap|conflicting_lease_ids\s*=/.test(src), "no independent conflict derivation");
  ok(/datedPropertyPositions/.test(src), "reads the shared classifier");
  ok(av.rows.every(r => r.successor_state === byId.get(r.space_id).successor.state),
    "successor meaning is identical to the shared read");
  ok(av.rows.every(r => r.notice_state === byId.get(r.space_id).notice_state),
    "notice meaning is identical to the shared read");
  ok(av.rows.every(r => r.conflict_state === byId.get(r.space_id).conflict_state),
    "conflict meaning is identical to the shared read");

  console.log("\n== cross-surface agreement ==");
  const rrById = new Map(rr.rows.map(r => [r.space_id, r]));
  const frById = new Map(fr.rows.map(r => [r.space_id, r]));
  ok(marketable.every(r => rrById.get(r.space_id).tenancy_state !== "contractually_occupied"),
    "nothing marketable is contractually occupied in the Current Rent Roll");
  ok(marketable.every(r => frById.get(r.space_id).future_state !== "contractually_locked"),
    "a locked future position is never shown as available for the same date");
  const rnPending = new Set(rn.successor_pending.rows.map(r => r.space_id));
  ok([...rnPending].every(id => {
    const a = av.rows.find(x => x.space_id === id);
    return !a || a.marketing_state !== "marketable_now";
  }), "a pending successor is never open inventory");
  ok(rn.conflicted.rows.every(r => {
    const a = av.rows.find(x => x.space_id === r.space_id);
    return a && a.marketing_state === "contested";
  }), "Renewals and Availability agree on contested");

  console.log("\n== turnover blocks marketing, not tenancy ==");
  const turning = dp.positions.filter(p => p.physical_readiness === "turning");
  ok(turning.every(p => {
    const a = av.rows.find(x => x.space_id === p.space_id);
    const c = rrById.get(p.space_id);
    // A turn may block marketing; it must not change what the rent roll says
    // about the contract.
    return c.tenancy_state === (p.lease ? "contractually_occupied" : c.tenancy_state);
  }), `a turnover block does not rewrite contractual tenancy (${turning.length} turning)`);

  console.log("\n== a failed live read is UNAVAILABLE, never vacancy ==");
  const failed = marketingState({}, false);
  ok(failed.state === "unavailable" && failed.reason === "live_read_failed",
    "a failed read returns unavailable");
  ok(failed.state !== "marketable_now" && failed.state !== "vacant",
    "a failed read never produces marketable inventory or vacancy");

  console.log("\n== unit-level conditions reach beds only by explicit rule ==");
  ok(/operating_use/.test(src) && /join units u on u.id=s.unit_id/.test(src),
    "operating_use is loaded per space FROM its unit - an explicit propagation, not an assumption");

  console.log("\n== HTTP ==");
  //  The fixtures live in an UNCOMMITTED transaction, so a separate HTTP
  //  connection cannot see them. The HTTP contract is exercised against a
  //  deployed property when one is supplied; it is honestly skipped otherwise,
  //  and skipping is never counted as a pass.
  const base = process.env.API_BASE, token = process.env.STAFF_SESSION,
        httpProperty = process.env.HTTP_PROPERTY_ID;
  if (!base || !token || !httpProperty) {
    console.log("   SKIP  no API_BASE / STAFF_SESSION / HTTP_PROPERTY_ID — the seeded fixture is transaction-scoped and unreachable over HTTP");
  } else {
    const DEMO = httpProperty;
    const anon = await fetch(`${base}/operator/leasing/availability-canonical`);
    ok(anon.status === 401, "no session -> 401");
    const r = await fetch(`${base}/operator/leasing/availability-canonical`, { headers: { "x-staff-session": token } });
    const b = await r.json();
    ok(r.status === 200 && b.property_id === DEMO, "session-scoped 200");
    ok(b.headline.marketable_now === av.headline.marketable_now, "HTTP headline matches the service");
    const spoof = await fetch(`${base}/operator/leasing/availability-canonical?property_id=9e2bb96e-08e2-41db-81c2-91055ceb50a3`,
      { headers: { "x-staff-session": token } });
    ok((await spoof.json()).property_id === DEMO, "a client-supplied property_id is ignored");
  }

  await pg.query("rollback");   // the scratch property never persists
  pg.release();
  await pool.end();
  console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log("FATAL:", e.message, "\n", e.stack); process.exit(1); });
