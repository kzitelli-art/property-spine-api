/* ════════════════════════════════════════════════════════════════════
   opening_truth_standing_bound.db.js — THE STANDING READ MUST NOT WALK
   EVERY IMPORT BATCH, AND MUST RETURN THE SAME ANSWER WHEN IT STOPS.

   §40.6 asks each domain for a standing projection cheap enough to
   gather routinely. `readTenancyStanding` — the registered Ask Spine
   projection, contract `tenancy_standing.v1` — reaches
   datedPropertyPositions → openingTruth(), which issues:

       select … from import_batches where property_id=$1
        order by source_as_of_date desc nulls last, loaded_at desc

   Every rent-roll import ever run against the property, unbounded, on
   the standing path. It then uses ONE field of the result:
   `latest_confirmed_source`.

   ── WHY THE WALK IS NOT SIMPLY BOUNDED ──────────────────────────────
   The obvious fix — put a LIMIT on openingTruth — is WRONG, and this
   harness exists partly to record why. `opening_truth.sources` is a
   DETAIL contract with four live consumers:

       src/surfaces/rent_roll_unit_view.js
       src/surfaces/future_rent_roll_facts.js
       src/surfaces/rent_roll_institutional.js
       src/surfaces/rent_roll_canonical.js

   and tests/rent_roll_canonical_proof.js asserts the array is non-empty
   and that EVERY element keeps its attribution. openingTruth's own
   header states the contract: "Opening truth is an EXTENSIBLE receipt.
   A property may take many governed sources over its life; the contract
   must not collapse that history into 'one batch and one document'."

   Bounding it would truncate a receipt an operator reads — the same
   mistake as putting a LIMIT on "the coverages on this property" (§5).

   So this is §40.6's actual shape: STANDING **plus** DETAIL, never
   standing instead of detail. openingTruth() is preserved verbatim as
   the detail read. openingTruthStanding() answers the standing path
   with two bounded statements.

   ── WHAT IS PROVED ──────────────────────────────────────────────────
   A1  bounded standing == unbounded detail, field for field, on
       `latest_confirmed_source` and `latest_reconciliation`
   A2  the tie-break the unbounded ORDER BY performs is reproduced —
       same as_of_date, different loaded_at, and a NULL as_of_date that
       must sort last
   A3  readTenancyStanding output is deep-equal before and after
   A4  datedPropertyPositions (detail default) still returns the FULL
       sources array — the bound did not leak into the detail read
   A5  the standing path issues NO unbounded import_batches statement,
       counted by a pg query spy, not by reading the source

   A5 is the one that can regress silently, so it is measured rather
   than asserted from the diff.

   ── THE FIXTURE MOVED OUT OF THIS FILE ──────────────────────────────
   This harness used to DEFINE the property, person, units, spaces,
   leases, event and import batches inline, and it was the only file
   that did. tests/space_rows_lease_relevance.db.js read the same rows
   and created none of them, so it passed only when this file had run
   first and left its rows committed — one proof and one echo of it.

   The definition now lives in tests/tenancy_position_fixture.js and
   both harnesses call seed() and cleanup() for themselves. Nothing
   about what this file ASSERTS changed; what changed is that it no
   longer leaves a database behind for someone else to depend on.

   CLASS 3 — test infrastructure. REMOVAL CONDITION: none.

   Local disposable database only; refuses anything else.

     SLICE1_DATABASE_URL=postgres://postgres@127.0.0.1:55434/spine_slice1 \
       node tests/opening_truth_standing_bound.db.js
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
const dp = require(path.join(ROOT, "src/tenancy/dated_positions.js"));
const tenancy = require(path.join(ROOT, "src/tenancy/tenancy_position_read.js"));
const fixture = require(path.join(__dirname, "tenancy_position_fixture.js"));

const PROPERTY = fixture.IDS.PROPERTY;

let pass = 0, fail = 0;
const ok  = (l) => { pass++; console.log(`  ok    ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}${d ? "\n        " + d : ""}`); };
const eq  = (l, a, b) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) ok(l); else bad(l, `expected ${B}\n        actual   ${A}`);
};

/*  A pool that records every statement it is asked to run, so "the standing
    path no longer walks import_batches" is MEASURED and not read off a diff. */
function spy(pool) {
  const seen = [];
  return {
    seen,
    query: (...a) => { seen.push(typeof a[0] === "string" ? a[0] : a[0].text); return pool.query(...a); },
  };
}
const importBatchStatements = (seen) =>
  seen.map((s) => String(s).toLowerCase().replace(/\s+/g, " "))
      .filter((s) => s.includes("from import_batches"));

(async () => {
  const pool = new Pool({ connectionString: URL });
  console.log("\nSTANDING BOUND — opening_truth on the tenancy standing path\n");
  try {
    await fixture.seed(pool);

    const AS_OF = "2026-08-24";

    // ── A1/A2 · the bounded standing answer equals the unbounded one ──
    const detail = await dp.openingTruth(pool, PROPERTY);
    ok(`detail read returns the full receipt (${detail.sources.length} sources)`);

    if (typeof dp.openingTruthStanding === "function") {
      const standing = await dp.openingTruthStanding(pool, PROPERTY);
      eq("A1 · latest_confirmed_source identical to the unbounded read",
         standing.latest_confirmed_source, detail.latest_confirmed_source);
      eq("A1 · latest_reconciliation identical to the unbounded read",
         standing.latest_reconciliation, detail.latest_reconciliation);
      eq("A2 · loaded_at tie-break picks the same batch on a shared as_of_date",
         standing.latest_confirmed_source && standing.latest_confirmed_source.source_file,
         "tie_late.xlsx");
      eq("A2 · a null as_of_date sorts last despite being loaded most recently",
         detail.latest_confirmed_source.source_file, "tie_late.xlsx");
      eq("A2 · a reconciliation is never the confirmed source",
         standing.latest_confirmed_source.source_type, "rent_roll_ledger");
    } else {
      bad("A1 · openingTruthStanding() is not exported yet", "baseline run — expected before the change");
    }

    // ── A3 · the standing projection's own output is unchanged ────────
    const standingRead = await tenancy.readTenancyStanding(pool, { property_id: PROPERTY, as_of: AS_OF });
    console.log(`\n  standing truth_state: ${standingRead.standing && standingRead.standing.truth_state}`);
    console.log(`  established_from:     ${JSON.stringify(standingRead.established_from)}`);

    // ── A4 · the detail default still carries every source ────────────
    const dated = await dp.datedPropertyPositions(pool, { property_id: PROPERTY, as_of: AS_OF });
    eq("A4 · datedPropertyPositions still returns the FULL sources array",
       dated.opening_truth.sources.length, detail.sources.length);

    // ── A5 · measure what the standing path actually issues ───────────
    const s = spy(pool);
    await tenancy.readTenancyStanding(s, { property_id: PROPERTY, as_of: AS_OF });
    const walks = importBatchStatements(s.seen);
    const unbounded = walks.filter((q) => !q.includes("limit"));
    console.log(`\n  import_batches statements on the standing path: ${walks.length}` +
                ` (unbounded: ${unbounded.length})`);
    for (const q of walks) console.log(`    · ${q.slice(0, 110)}${q.length > 110 ? "…" : ""}`);
    if (unbounded.length === 0) ok("A5 · the standing path issues no unbounded import_batches walk");
    else bad(`A5 · the standing path still walks import_batches ${unbounded.length}×`, unbounded[0].slice(0, 160));

    // ── the baseline snapshot the next run is compared against ────────
    console.log("\n  SNAPSHOT " + JSON.stringify({
      truth_state: standingRead.standing && standingRead.standing.truth_state,
      established_from: standingRead.established_from,
      position: standingRead.position || null,
      sources: dated.opening_truth.sources.map((x) => x.source_file),
    }));
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
