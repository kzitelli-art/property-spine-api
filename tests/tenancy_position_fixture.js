/* ════════════════════════════════════════════════════════════════════
   tenancy_position_fixture.js — THE SHARED TENANCY-POSITION FIXTURE.

   ── WHY THIS FILE EXISTS ────────────────────────────────────────────
   Two harnesses read the same property:

       tests/opening_truth_standing_bound.db.js
       tests/space_rows_lease_relevance.db.js

   Until now the FIRST one owned the entire fixture and the second one
   owned none of it. The second passed only because the first had run
   before it in the same database and left its rows committed. That was
   measured, not inferred — on a freshly migrated database:

       space-rows alone                      → FAIL, exit 1, 0 passed
       space-rows after opening-truth        → PASS, 5/5
       delete the retained leases, re-run    → FAIL, exit 1

   So `verify_all.sh` was not running two independent proofs. It was
   running one proof and one echo of it, and the echo would have gone
   red for a reason that had nothing to do with what it asserts.

   Worse, the second harness had HAND-COPIED the first one's lease dates,
   statuses and rents into its restore path, so the two definitions could
   drift apart silently and the restore would then "restore" a fixture
   that never existed.

   ── WHAT THIS FILE GUARANTEES ───────────────────────────────────────
   ONE definition. Both harnesses call seed() and cleanup() explicitly,
   and neither depends on the other having run.

   OWNERSHIP IS THE WHOLE POINT. Every id below is minted by this file
   under the `51ce0001` prefix, and cleanup() deletes those ids and
   nothing else — never property-wide, never by pattern across a table.
   The one exception is deliberate and narrow: `ensure_unit_space` is a
   trigger on `units` that mints a space row this file did not name. A
   space whose unit_id is one of ours is ours, so cleanup removes it.
   That is the only row this file deletes without having chosen its id.

   ── residue() IS NOT A SPOT CHECK ───────────────────────────────────
   "Cleanup left nothing behind" is a claim about a SEARCH. Counting the
   seven tables the seed happens to write would assert only that the
   seed's own statements were undone — it could not see a row some
   future trigger or cascade put somewhere else, which is exactly the
   class of leak this file was written to end.

   So residue() enumerates the tables from information_schema at runtime:
   every public table carrying `property_id`, every one carrying
   `unit_id`, plus `persons` by id. At ledger 192 that is 162 + 42
   tables, not 7. A harness that reports zero has looked everywhere a
   row could be, and a table added by a later migration is swept the
   day it lands without anyone remembering to add it here. Anything the
   sweep cannot scan is COUNTED and reported rather than dropped.

   CLASS 3 — test infrastructure. REMOVAL CONDITION: none.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  Every id this fixture creates, and the only ones it will ever delete. */
const PROPERTY = "51ce0001-0000-4000-8000-000000000001";
const UNIT_A   = "51ce0001-0000-4000-8000-0000000000a1";
const UNIT_B   = "51ce0001-0000-4000-8000-0000000000b1";
const SPACE_A1 = "51ce0001-0000-4000-8000-0000000000a2";
const SPACE_A2 = "51ce0001-0000-4000-8000-0000000000a3";
const SPACE_B1 = "51ce0001-0000-4000-8000-0000000000b2";
const PERSON   = "51ce0001-0000-4000-8000-0000000000c1";

const LEASE_PAST    = "51ce0001-0000-4000-8000-0000000001a1";
const LEASE_CURRENT = "51ce0001-0000-4000-8000-0000000001a2";
const LEASE_FUTURE  = "51ce0001-0000-4000-8000-0000000001a3";
const LEASE_B       = "51ce0001-0000-4000-8000-0000000001b1";

const MOVE_IN_EVENT = "51ce0001-0000-4000-8000-0000000002a1";

const IDS = {
  PROPERTY, PERSON,
  UNIT_A, UNIT_B, SPACE_A1, SPACE_A2, SPACE_B1,
  LEASE_PAST, LEASE_CURRENT, LEASE_FUTURE, LEASE_B,
  MOVE_IN_EVENT,
};

/*  ── LEASE HISTORY, on purpose ──────────────────────────────────────
    A past terminal lease, a current one, and a future one on the SAME
    bed — the shape that makes a naive "latest row" bound on the spaces
    loader change the answer, in both directions.

    This table is the single definition. space_rows_lease_relevance's
    restore path reads it from here instead of carrying its own copy;
    that duplication is what let the two drift.                        */
const LEASES = {
  [LEASE_PAST]:    { unit: "A", start: "2024-01-01", end: "2024-12-31", status: "ended",  rent: 900 },
  [LEASE_CURRENT]: { unit: "A", start: "2025-01-01", end: "2026-12-31", status: "active", rent: 1000 },
  [LEASE_FUTURE]:  { unit: "A", start: "2027-01-01", end: "2027-12-31", status: "signed", rent: 1100 },
  [LEASE_B]:       { unit: "B", start: "2025-06-01", end: "2026-05-31", status: "active", rent: 950 },
};

/*  ── THE POPULATION UNDER TEST ──────────────────────────────────────
    Four batches, arranged so the ORDER BY has real work to do:
      · two committed rent rolls sharing one as_of_date, so the
        loaded_at tie-break decides which is "latest"
      · a reconciliation, which latest_confirmed_source must SKIP
      · a NULL as_of_date, which `nulls last` must sort behind
        everything even though it was loaded most recently            */
const BATCHES = [
  ["51ce0001-0000-4000-8000-0000000003a1", "rent_roll_ledger",         "old.xlsx",       "2025-01-31", "2025-02-01T10:00:00Z"],
  ["51ce0001-0000-4000-8000-0000000003a2", "rent_roll_ledger",         "tie_early.xlsx", "2026-07-31", "2026-08-01T09:00:00Z"],
  ["51ce0001-0000-4000-8000-0000000003a3", "rent_roll_ledger",         "tie_late.xlsx",  "2026-07-31", "2026-08-01T17:00:00Z"],
  ["51ce0001-0000-4000-8000-0000000003a4", "rent_roll_reconciliation", "recon.xlsx",     "2026-08-15", "2026-08-16T09:00:00Z"],
  ["51ce0001-0000-4000-8000-0000000003a5", "rent_roll_ledger",         "no_date.xlsx",   null,         "2026-08-20T09:00:00Z"],
];

/*  Delete in FK order. Safe to call when nothing exists — every
    statement is scoped to ids this fixture owns, so a no-op run
    deletes zero rows rather than refusing.

    NO try/catch HERE ON PURPOSE. A cleanup that swallows its own
    failure is the same defect as a seed that swallows its own failure:
    it reports a clean database it never verified. Failures propagate to
    the caller, which records them as an ADDITIONAL harness failure.   */
async function cleanup(pool) {
  await pool.query(`delete from unit_events where property_id=$1`, [PROPERTY]);
  await pool.query(`delete from leases where property_id=$1`, [PROPERTY]);
  //  Trigger-minted spaces included: a space under one of our units is ours.
  await pool.query(`delete from spaces where unit_id = any($1::uuid[])`, [[UNIT_A, UNIT_B]]);
  await pool.query(`delete from units where property_id=$1`, [PROPERTY]);
  await pool.query(`delete from import_batches where property_id=$1`, [PROPERTY]);
  await pool.query(`delete from properties where id=$1`, [PROPERTY]);
  await pool.query(`delete from persons where id=$1`, [PERSON]);
}

/*  Build the fixture from empty. Returns the resolved space ids, which
    are not always the ones named above — see the trigger note below.  */
async function seed(pool) {
  await cleanup(pool);

  /*  ── THE CANONICAL PROPERTY INSERT, AND NO FALLBACK ────────────────
   *
   *  This statement used to name `occupancy_status` on `properties` and
   *  sit inside a broad `.catch()` that retried a DIFFERENT insert.
   *  `occupancy_status` does not exist on `properties` — it is a
   *  UNIT-level column, confirmed against the live schema at ledger 192:
   *
   *      information_schema.columns where column_name='occupancy_status'
   *        → units
   *
   *  So the first statement failed on EVERY run, the catch quietly ran
   *  the correct one, and the harness went green while a real SQL error
   *  sat in the Postgres log. It was visible in the container logs of CI
   *  runs 32769539866, 32770074062 and 32770517275 and nothing went red.
   *
   *  ⚠ THE FALLBACK WAS THE ACTUAL DEFECT, not the column name. A broad
   *  catch around fixture setup swallows whatever fails next — a
   *  constraint change, a renamed column, a genuinely broken seed — and
   *  hands the assertions a half-built fixture to pass against. A
   *  harness that hides its own setup failure is the "confident wrong"
   *  §5 forbids, pointed at the proof instead of the product.
   *
   *  Now: one canonical statement, no catch. cleanup() removed this
   *  property by id immediately above, so a plain INSERT is
   *  deterministic — no `where not exists` guard is needed.           */
  await pool.query(
    `insert into properties (id, name, address, leasing_basis)
     values ($1,'Slice1 Bound Fixture','1 Bound Way','unit')`, [PROPERTY]);

  await pool.query(`insert into persons (id, name) values ($1,'Bound Resident')`, [PERSON]);

  for (const [id, n] of [[UNIT_A, "101"], [UNIT_B, "102"]]) {
    await pool.query(
      `insert into units (id, property_id, unit_number) values ($1,$2,$3)`, [id, PROPERTY, n]);
  }

  /*  `ensure_unit_space` has already minted one space per unit, with ids
      it chose. Adopt those rather than fighting the trigger, and fall
      back to our own ids if a future migration removes it. Then add a
      SECOND space to unit A, so the fixture is bed-grain there.       */
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
  await pool.query(`insert into spaces (id, unit_id, space_label) values ($1,$2,'B')`, [SPACE_A2, UNIT_A]);

  const spaceFor = { A: a1, B: b1 };
  for (const [id, L] of Object.entries(LEASES)) {
    await pool.query(
      `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                           start_date, end_date, lease_status)
       values ($1,$2,$3,$4::uuid[],$5,0,$6,$7,$8)`,
      [id, PROPERTY, spaceFor[L.unit], [PERSON], L.rent, L.start, L.end, L.status]);
  }

  await pool.query(
    `insert into unit_events (id, unit_id, property_id, event_type, effective_date,
                              payload, status, space_id, lease_id)
     values ($1,$2,$3,'move_in','2025-01-02','{}'::jsonb,'actioned',$4,$5)`,
    [MOVE_IN_EVENT, UNIT_A, PROPERTY, a1, LEASE_CURRENT]);

  for (const [id, type, file, asOf, loadedAt] of BATCHES) {
    await pool.query(
      `insert into import_batches (id, property_id, source_type, source_file,
                                   source_as_of_date, confidence, status, notes, loaded_at)
       values ($1,$2,$3,$4,$5::date,'confirmed','committed','slice1 fixture',$6::timestamptz)`,
      [id, PROPERTY, type, file, asOf, loadedAt]);
  }

  return { space_a1: a1, space_b1: b1, space_a2: SPACE_A2 };
}

/*  Re-insert one lease from the single definition above. The caller
    supplies the space_id it read off the row before deleting it, so a
    trigger-minted space is restored to the bed it actually sat on.    */
async function restoreLease(pool, leaseId, spaceId) {
  const L = LEASES[leaseId];
  if (!L) throw new Error(`restoreLease: ${leaseId} is not a fixture lease`);
  await pool.query(
    `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                         start_date, end_date, lease_status)
     values ($1,$2,$3,$4::uuid[],$5,0,$6,$7,$8)
     on conflict (id) do nothing`,
    [leaseId, PROPERTY, spaceId, [PERSON], L.rent, L.start, L.end, L.status]);
}

/*  Count every row anywhere in the schema attributable to this fixture.
    Scope is discovered, not listed — see the header. Returns
    { total, byTable } so a non-zero result NAMES where the leak is
    instead of just failing.                                           */
async function residue(pool) {
  /*  Columns are pinned to uuid, and the number NOT pinned is reported.
      Scanning a text-typed property_id would throw and take the whole
      sweep with it; silently dropping it would shrink the search while
      the message still claimed the whole schema. At ledger 192 every one
      of the 162 + 42 columns is uuid and `skipped` is 0 — if a later
      migration lands a differently-typed one, the count says so instead
      of laundering the gap into evidence. */
  const cols = async (col) => (await pool.query(
    `select c.table_name, c.data_type from information_schema.columns c
      join information_schema.tables t
        on t.table_schema=c.table_schema and t.table_name=c.table_name
      where c.table_schema='public' and c.column_name=$1
        and t.table_type='BASE TABLE'
      order by c.table_name`, [col])).rows;

  const byProperty = await cols("property_id");
  const byUnit = await cols("unit_id");
  const skipped = [...byProperty, ...byUnit].filter((r) => r.data_type !== "uuid")
                                            .map((r) => r.table_name);

  const byTable = {};
  const bump = (t, n) => { if (n > 0) byTable[t] = (byTable[t] || 0) + n; };

  for (const r of byProperty) {
    if (r.data_type !== "uuid") continue;
    bump(r.table_name, Number((await pool.query(
      `select count(*)::int as n from "${r.table_name}" where property_id=$1`,
      [PROPERTY])).rows[0].n));
  }
  for (const r of byUnit) {
    if (r.data_type !== "uuid") continue;
    bump(r.table_name, Number((await pool.query(
      `select count(*)::int as n from "${r.table_name}" where unit_id = any($1::uuid[])`,
      [[UNIT_A, UNIT_B]])).rows[0].n));
  }
  bump("properties", Number((await pool.query(
    `select count(*)::int as n from properties where id=$1`, [PROPERTY])).rows[0].n));
  bump("persons", Number((await pool.query(
    `select count(*)::int as n from persons where id=$1`, [PERSON])).rows[0].n));

  const total = Object.values(byTable).reduce((a, b) => a + b, 0);
  const scanned = byProperty.length + byUnit.length - skipped.length + 2;
  return { total, byTable, scanned, skipped };
}

module.exports = { IDS, LEASES, BATCHES, seed, cleanup, restoreLease, residue };
