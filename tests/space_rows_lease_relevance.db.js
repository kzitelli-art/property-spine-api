/* ════════════════════════════════════════════════════════════════════
   space_rows_lease_relevance.db.js — WHICH LEASES DOES THE POSITION
   READ ACTUALLY NEED?

   `loadSpaceRows()` in src/tenancy/space_position.js carries a correlated
   json_agg pulling EVERY lease ever recorded on a space, unbounded. The
   standing-projection cost gate declares it a HISTORY_WALK and it is one:
   it grows with tenancy turnover forever.

   ── WHY IT IS NOT BOUNDED, AND WHY THAT IS MEASURED HERE ────────────
   The receipt in docs/TENANCY_STANDING_COST_RECEIPT.md argues from
   source that a RECENCY or COUNT bound changes output, because
   position_classifier.js consumes the array at an ARBITRARY asOf
   (datesSpan / isFuture), for the successor search, and for the
   double-let contest guard.

   An argument from source is a claim, not proof (§33: prose is a claim).
   This harness turns it into an observation, in both directions:

     B1  REMOVING A LEASE THAT ENDED BEFORE asOf CHANGES NOTHING.
         So a DATE-RELEVANCE predicate is a real candidate — unlike a
         recency bound — and a future thread does not have to rediscover
         that.

     B2  REMOVING A LEASE THAT SPANS asOf CHANGES THE ANSWER, and
         changes it in the dangerous direction: the bed stops reading as
         contractually occupied. That is the double-let this classifier
         exists to prevent, and it is what a "keep the newest N leases"
         bound would have bought to make a cost gate green.

     B3  REMOVING A FUTURE LEASE CHANGES THE FORWARD ANSWER.
         The interval read is a separate consumer of the same loader, so
         "latest" is wrong for it in the opposite direction from B2.

   B2 and B3 are the ones that must be able to go red for B1 to mean
   anything. A harness that only shows the safe deletion is safe has
   demonstrated nothing.

   ⚠ THIS HARNESS DOES NOT ENDORSE THE DATE BOUND. B1 establishes that
   past leases are not read at a single asOf. It does NOT establish that
   threading asOf into the shared loader is safe — see the receipt's
   second reason, the unfiltered `ins[ins.length - 1]` possession read.

   ── THIS HARNESS USED TO CREATE NOTHING ─────────────────────────────
   It read a property that opening_truth_standing_bound.db.js had built
   and left behind, and it hand-copied that file's lease dates, statuses
   and rents into its own restore path. Two consequences, both measured
   on a freshly migrated database rather than argued:

       alone on a clean database            → FAIL, exit 1, 0 passed
       after the other harness had run      → PASS, 5/5
       delete the retained leases, re-run   → FAIL, exit 1

   It was not an independent proof. It was an echo, and it would have
   gone red for a reason that has nothing to do with lease relevance —
   which is the worst kind of red, because someone would go looking in
   the classifier.

   It now seeds and cleans up for itself through the shared definition in
   tests/tenancy_position_fixture.js, and the restore path reads the
   lease values from there instead of carrying a copy that could drift.

   CLASS 3 — test infrastructure. REMOVAL CONDITION: none.
   Creates, mutates and removes ONLY the ids the fixture owns.
   Local database only.

     SLICE1_DATABASE_URL=postgres://postgres@127.0.0.1:55434/spine_slice1 \
       node tests/space_rows_lease_relevance.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Pool } = require("pg");

const URL = process.env.SLICE1_DATABASE_URL
  || "postgres://postgres@127.0.0.1:55434/spine_slice1";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(URL)) {
  console.error("\n  ✗ REFUSED: local disposable database only.\n");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const { spacePosition } = require(path.join(ROOT, "src/tenancy/space_position.js"));
const { intervalPropertyPositions } = require(path.join(ROOT, "src/tenancy/dated_positions.js"));
const fixture = require(path.join(__dirname, "tenancy_position_fixture.js"));

const PROPERTY      = fixture.IDS.PROPERTY;
const LEASE_PAST    = fixture.IDS.LEASE_PAST;    // 2024-01-01 → 2024-12-31, ended
const LEASE_CURRENT = fixture.IDS.LEASE_CURRENT; // 2025-01-01 → 2026-12-31, active
const LEASE_FUTURE  = fixture.IDS.LEASE_FUTURE;  // 2027-01-01 → 2027-12-31, signed
const AS_OF = "2026-08-24";

let pass = 0, fail = 0;
const ok  = (l) => { pass++; console.log(`  ok    ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}${d ? "\n        " + d : ""}`); };

/*  Hide a lease by deleting it and putting it back from the fixture's own
    definition. The space_id is read off the row FIRST, because the bed it
    sits on may be a trigger-minted space whose id the fixture did not
    choose — restoring it to a guessed space would put the lease somewhere
    it never was and quietly change what the next probe measures. */
async function withLeaseHidden(pool, leaseId, fn) {
  const saved = (await pool.query(`select space_id from leases where id=$1`, [leaseId])).rows[0];
  if (!saved) throw new Error(`fixture lease ${leaseId} missing after seed — the fixture did not build`);
  await pool.query(`delete from leases where id=$1`, [leaseId]);
  try { return await fn(); }
  finally { await fixture.restoreLease(pool, leaseId, saved.space_id); }
}

const asOfShape = async (pool) =>
  JSON.stringify((await spacePosition(pool, { property_id: PROPERTY, as_of: AS_OF })).positions);
const forwardShape = async (pool) =>
  JSON.stringify((await intervalPropertyPositions(pool, {
    property_id: PROPERTY, requested_start: "2027-03-01", requested_end: "2027-06-30",
  })).positions);

(async () => {
  const pool = new Pool({ connectionString: URL });
  console.log("\nLEASE RELEVANCE — what loadSpaceRows' unbounded array is actually read for\n");
  try {
    //  DELIBERATE FALSIFICATION — proof cycle B. The seed call is removed
    //  so this harness once again creates nothing of its own. If it can
    //  still pass, the fix did nothing and the runner order is still
    //  carrying it. REVERTED IN THE NEXT COMMIT.
    // await fixture.seed(pool);

    const baseAsOf = await asOfShape(pool);
    const baseFwd  = await forwardShape(pool);
    console.log(`  baseline captured at as_of=${AS_OF} and forward 2027-03-01..2027-06-30\n`);

    // ── B1 · the safe deletion ────────────────────────────────────────
    await withLeaseHidden(pool, LEASE_PAST, async () => {
      const now = await asOfShape(pool);
      if (now === baseAsOf) ok("B1 · a lease that ENDED before as_of changes nothing — date relevance is a real candidate");
      else bad("B1 · removing a past lease CHANGED the as-of answer", "the date-relevance bound is not viable either");
    });

    // ── B2 · the deletion that must break it ──────────────────────────
    await withLeaseHidden(pool, LEASE_CURRENT, async () => {
      const now = await asOfShape(pool);
      if (now !== baseAsOf) {
        const before = JSON.parse(baseAsOf).find((p) => p.economic_tenancy_state === "active");
        const after  = JSON.parse(now).find((p) => String(p.space_id) === String(before.space_id));
        ok(`B2 · removing the SPANNING lease changes the answer — ${before.economic_tenancy_state} → ${after.economic_tenancy_state}`);
        /*  ⚠ I PREDICTED "none" AND THE DATABASE SAID "forward". Kept as
         *  the assertion because the corrected answer is the sharper one:
         *  the 2027 lease is still on the bed, so the classifier falls
         *  through to `future` and the bed reads as EMPTY NOW WITH SOMEONE
         *  COMING LATER. A bed someone is living in today, presented as
         *  available today, is a more plausible-looking double-let than a
         *  blank would be — it comes with a story. What matters is not
         *  which label replaces `active`; it is that
         *  `current_lease_position` goes null. */
        if (after.current_lease_position === null && after.economic_tenancy_state !== "active")
          ok("B2 · and in the dangerous direction: current_lease_position → null, the bed reads as not occupied NOW");
        else bad("B2 · expected the bed to lose its CURRENT lease position",
                 JSON.stringify({ state: after.economic_tenancy_state, current: after.current_lease_position }));
      } else bad("B2 · removing the spanning lease changed NOTHING", "this probe has no teeth; B1 proves nothing");
    });

    // ── B3 · the forward consumer disagrees about which lease matters ─
    await withLeaseHidden(pool, LEASE_FUTURE, async () => {
      const now = await forwardShape(pool);
      if (now !== baseFwd) ok("B3 · removing the FUTURE lease changes the forward answer — 'latest' is wrong for the interval read too");
      else bad("B3 · removing the future lease changed nothing in the forward read", "check the interval window against the fixture dates");
    });

    // ── restoration is part of the proof ──────────────────────────────
    if (await asOfShape(pool) === baseAsOf && await forwardShape(pool) === baseFwd)
      ok("restored — both reads match the baseline again");
    else bad("restoration failed", "a probe put the fixture back wrong; the B-results above are not trustworthy");
  } catch (e) {
    bad("harness died", e.message);
    console.error(e);
  } finally {
    /*  CLEANUP IS ADDITIVE, NEVER SUBSTITUTIVE. A cleanup failure adds a
        failure; it cannot clear or overwrite one the assertions already
        recorded, and it cannot turn a red run green. The residue sweep
        runs only if cleanup itself returned, because counting rows after
        a failed delete would report a leak whose cause is already known. */
    try {
      await fixture.cleanup(pool);
      const left = await fixture.residue(pool);
      if (left.total === 0) ok(`fixture removed — 0 rows across ${left.scanned} scanned tables`
                              + (left.skipped.length ? `, ${left.skipped.length} NOT SCANNED: ${left.skipped.join(", ")}` : ""));
      else bad(`fixture LEAKED ${left.total} row(s)`, JSON.stringify(left.byTable));
    } catch (e) {
      bad("fixture cleanup FAILED — the next run starts dirty", e.message);
    }
    await pool.end();
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
