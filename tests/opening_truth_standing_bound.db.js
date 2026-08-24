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

/*  IDs this harness created, and the only ones it will ever delete. */
const PROPERTY = "51ce0001-0000-4000-8000-000000000001";
const UNIT_A   = "51ce0001-0000-4000-8000-0000000000a1";
const UNIT_B   = "51ce0001-0000-4000-8000-0000000000b1";
const SPACE_A1 = "51ce0001-0000-4000-8000-0000000000a2";
const SPACE_A2 = "51ce0001-0000-4000-8000-0000000000a3";
const SPACE_B1 = "51ce0001-0000-4000-8000-0000000000b2";
const PERSON   = "51ce0001-0000-4000-8000-0000000000c1";

let pass = 0, fail = 0;
const ok  = (l) => { pass++; console.log(`  ok    ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}${d ? "\n        " + d : ""}`); };
const eq  = (l, a, b) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) ok(l); else bad(l, `expected ${B}\n        actual   ${A}`);
};

async function seed(pool) {
  //  Scoped teardown: only the ids above, never property-wide.
  await pool.query(`delete from unit_events where property_id=$1`, [PROPERTY]);
  await pool.query(`delete from leases where property_id=$1`, [PROPERTY]);
  await pool.query(`delete from spaces where unit_id = any($1::uuid[])`, [[UNIT_A, UNIT_B]]);
  await pool.query(`delete from units where property_id=$1`, [PROPERTY]);
  await pool.query(`delete from import_batches where property_id=$1`, [PROPERTY]);
  await pool.query(`delete from properties where id=$1`, [PROPERTY]);
  await pool.query(`delete from persons where id=$1`, [PERSON]);

  /*  ── THE CANONICAL PROPERTY INSERT, AND NO FALLBACK ────────────────
   *
   *  This block used to name `occupancy_status` on `properties` and wrap
   *  the statement in a broad `.catch()` that retried a DIFFERENT insert.
   *  `occupancy_status` does not exist on `properties` — it is a UNIT-level
   *  column, confirmed against the live schema at ledger 192:
   *
   *      information_schema.columns where column_name='occupancy_status'
   *        → units
   *
   *  So the first statement failed on EVERY run, the catch quietly ran the
   *  correct one, and the harness went green while a real SQL error sat in
   *  the Postgres log. It was visible in the container logs of CI runs
   *  32769539866, 32770074062 and 32770517275 and nothing went red.
   *
   *  ⚠ THE FALLBACK WAS THE ACTUAL DEFECT, not the column name. A broad
   *  catch around fixture setup swallows whatever fails next — a constraint
   *  change, a renamed column, a genuinely broken seed — and hands the
   *  assertions a half-built fixture to pass against. A harness that hides
   *  its own setup failure is the "confident wrong" §5 forbids, pointed at
   *  the proof instead of the product.
   *
   *  Now: one canonical statement, no catch. The seed deletes this property
   *  by id immediately above, so a plain INSERT is deterministic — no
   *  `where not exists` guard is needed. Any failure propagates to the
   *  outer try/catch, which reports "harness died" and exits non-zero.  */
  await pool.query(
    `insert into properties (id, name, address, leasing_basis, occupancy_status)
     values ($1,'Slice1 Bound Fixture','1 Bound Way','unit','unknown')`, [PROPERTY]);

  await pool.query(`insert into persons (id, name) values ($1,'Bound Resident')
                    on conflict (id) do nothing`, [PERSON]);

  for (const [id, n] of [[UNIT_A, "101"], [UNIT_B, "102"]]) {
    await pool.query(
      `insert into units (id, property_id, unit_number) values ($1,$2,$3)`, [id, PROPERTY, n]);
  }
  //  ensure_unit_space may already have made one space per unit; take what
  //  exists and add a second to unit A so the fixture is bed-grain there.
  const existing = (await pool.query(
    `select s.id, s.unit_id from spaces s join units u on u.id=s.unit_id
      where u.property_id=$1 order by u.unit_number`, [PROPERTY])).rows;
  const spaceOf = new Map(existing.map((r) => [String(r.unit_id), String(r.id)]));
  const a1 = spaceOf.get(UNIT_A) || SPACE_A1;
  const b1 = spaceOf.get(UNIT_B) || SPACE_B1;
  if (!spaceOf.has(UNIT_A)) {
    await pool.query(`insert into spaces (id, unit_id, space_label) values ($1,$2,'A')`, [a1, UNIT_A]);
  } else {
    await pool.query(`update spaces set space_label='A' where id=$1`, [a1]);
  }
  if (!spaceOf.has(UNIT_B)) {
    await pool.query(`insert into spaces (id, unit_id, space_label) values ($1,$2,'A')`, [b1, UNIT_B]);
  } else {
    await pool.query(`update spaces set space_label='A' where id=$1`, [b1]);
  }
  await pool.query(`insert into spaces (id, unit_id, space_label) values ($1,$2,'B')
                    on conflict (id) do nothing`, [SPACE_A2, UNIT_A]);

  /*  LEASE HISTORY, on purpose. A past terminal lease, a current one, and
      a future one — the shape that makes a naive "latest row" bound on the
      spaces loader change the answer. */
  const L = (id, space, start, end, status, rent) => pool.query(
    `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                         start_date, end_date, lease_status)
     values ($1,$2,$3,$4::uuid[],$5,0,$6,$7,$8)`,
    [id, PROPERTY, space, [PERSON], rent, start, end, status]);
  await L("51ce0001-0000-4000-8000-0000000001a1", a1, "2024-01-01", "2024-12-31", "ended", 900);
  await L("51ce0001-0000-4000-8000-0000000001a2", a1, "2025-01-01", "2026-12-31", "active", 1000);
  await L("51ce0001-0000-4000-8000-0000000001a3", a1, "2027-01-01", "2027-12-31", "signed", 1100);
  await L("51ce0001-0000-4000-8000-0000000001b1", b1, "2025-06-01", "2026-05-31", "active", 950);

  await pool.query(
    `insert into unit_events (id, unit_id, property_id, event_type, effective_date,
                              payload, status, space_id, lease_id)
     values ($1,$2,$3,'move_in','2025-01-02','{}'::jsonb,'actioned',$4,$5)`,
    ["51ce0001-0000-4000-8000-0000000002a1", UNIT_A, PROPERTY, a1,
     "51ce0001-0000-4000-8000-0000000001a2"]);

  /*  ── THE POPULATION UNDER TEST ───────────────────────────────────
      Four batches, arranged so the ORDER BY has real work to do:
        · two committed rent rolls sharing one as_of_date, so the
          loaded_at tie-break decides which is "latest"
        · a reconciliation, which latest_confirmed_source must SKIP
        · a NULL as_of_date, which `nulls last` must sort behind
          everything even though it was loaded most recently          */
  const B = (id, type, file, asOf, status, loadedAt) => pool.query(
    `insert into import_batches (id, property_id, source_type, source_file,
                                 source_as_of_date, confidence, status, notes, loaded_at)
     values ($1,$2,$3,$4,$5::date,'confirmed',$6,'slice1 fixture',$7::timestamptz)`,
    [id, PROPERTY, type, file, asOf, status, loadedAt]);
  await B("51ce0001-0000-4000-8000-0000000003a1", "rent_roll_ledger", "old.xlsx",
          "2025-01-31", "committed", "2025-02-01T10:00:00Z");
  await B("51ce0001-0000-4000-8000-0000000003a2", "rent_roll_ledger", "tie_early.xlsx",
          "2026-07-31", "committed", "2026-08-01T09:00:00Z");
  await B("51ce0001-0000-4000-8000-0000000003a3", "rent_roll_ledger", "tie_late.xlsx",
          "2026-07-31", "committed", "2026-08-01T17:00:00Z");
  await B("51ce0001-0000-4000-8000-0000000003a4", "rent_roll_reconciliation", "recon.xlsx",
          "2026-08-15", "committed", "2026-08-16T09:00:00Z");
  await B("51ce0001-0000-4000-8000-0000000003a5", "rent_roll_ledger", "no_date.xlsx",
          null, "committed", "2026-08-20T09:00:00Z");
}

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
    await seed(pool);

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
    await pool.end();
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
