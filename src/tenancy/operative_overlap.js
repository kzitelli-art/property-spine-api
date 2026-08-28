// ════════════════════════════════════════════════════════════════════
//  operative_overlap.js — ONE SPACE, ONE TENANCY. One definition of it.
//
//  WHY THIS FILE EXISTS
//  --------------------
//  The rule already existed, inline in executed_lease_service §2b, and it
//  was correct there. It was not anywhere else. So `confirmProposal` — the
//  other canonical writer that inserts a lease — had no double-booking
//  check at all, and an activation confirming a newer rent roll would
//  create a second tenancy on a bed that already had one. Nothing in the
//  database would have refused it: `leases` has only a plain index on
//  space_id.
//
//  That hole was found by an operational pre-flight script that carried a
//  COPY of the rule. A copy is how the next hole gets made: the service
//  changes, the copy does not, and the copy is the thing standing between
//  a writer and bad tenancy. So the rule moves here, and both writers
//  import it. There is one place to change it and one place to read it.
//
//  WHAT THE RULE IS
//  ----------------
//      same space
//    + overlapping INCLUSIVE date range
//    + a status that is not retired
//
//  Retired-ness is not redefined here either. `lease_void_service` already
//  owns that list and already says why: "Statuses the overlap check
//  already ignores." This module derives its SQL from that one list rather
//  than restating it, so voiding a lease and ignoring a lease can never
//  come to mean different things.
//
//  It is a DENY-list, and that is load-bearing. An allow-list of
//  ('active','pending') reads as equivalent and is not: `signed` and
//  `commercial` are both in live use and would silently stop counting as
//  occupancy.
//
//  'pending' is operative. Two uncommenced commitments on one bed is
//  already a double-booking — the same ruling executed_lease_service has
//  carried since it was written.
//
//  CLASS 1 — permanent. It is the definition of a conflicting tenancy.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { RETIRED_STATUSES } = require("./lease_void_service.js");

//  The status list becomes SQL exactly once. Every value is checked first:
//  this builds a literal, and a literal built from an unvalidated string is
//  how an injection arrives years later through a "harmless" constant.
const RETIRED_SQL_LIST = RETIRED_STATUSES.map((s) => {
  if (!/^[a-z_]+$/.test(String(s))) {
    throw new Error(`operative_overlap: '${s}' is not a plain status identifier`);
  }
  return `'${s}'`;
}).join(",");

/*  ── THE PREDICATE ──────────────────────────────────────────────────
 *  Parameter order is part of the contract and is pinned by
 *  tests/unit/executed_lease_overlap_contract.test.js:
 *
 *      $1  space_id
 *      $2  lease id to exclude, or null   ← the caller's own lease, never
 *                                           application_id: a stale or
 *                                           duplicate lease carrying the
 *                                           same application must still
 *                                           surface as a conflict
 *      $3  start_date        $4  end_date
 *
 *  A NULL start/end makes daterange unbounded, so a term Spine has no
 *  dates for overlaps everything on that bed. That is deliberate: an
 *  undated claim cannot be shown NOT to conflict, and the honest answer to
 *  "does this conflict?" is then yes-until-someone-says-otherwise.
 */
const OPERATIVE_OVERLAP_SQL = `
    select id, lease_status, start_date, end_date, tenant_ids
      from leases
     where space_id = $1
       and ($2::uuid is null or id <> $2::uuid)
       and lease_status not in (${RETIRED_SQL_LIST})
       and daterange(start_date, end_date, '[]')
           && daterange($3::date, $4::date, '[]')
     order by start_date asc`;

/*  The read both writers use. Takes the CALLER'S client so the check runs
 *  inside the caller's transaction and against the caller's row locks — a
 *  conflict read on a separate connection is a conflict read of a
 *  different moment. */
async function competingOperativeLeases(client, {
  space_id, start_date = null, end_date = null, exclude_lease_id = null,
} = {}) {
  if (!space_id) throw new Error("competingOperativeLeases: space_id is required");
  const q = await client.query(OPERATIVE_OVERLAP_SQL,
    [space_id, exclude_lease_id || null, start_date, end_date]);
  return q.rows;
}

/*  A DATE, printed as one. `String(new Date(...))` yields "Fri Jul 31 2026
 *  00:00:00 GMT+0000" in the middle of a sentence a person reads; the same
 *  defect is commented in establishOpeningPosition. */
const asDate = (v) => (v == null ? "no date" : new Date(v).toISOString().slice(0, 10));

/*  One sentence per competing lease, for a status_reason a human reads and
 *  can act on: which lease, what state it is in, and for what term. */
function describeCompeting(rows) {
  return (rows || []).map((l) =>
    `${l.id} (${l.lease_status}, ${asDate(l.start_date)} → ${asDate(l.end_date)})`).join("; ");
}

module.exports = {
  OPERATIVE_OVERLAP_SQL, competingOperativeLeases, describeCompeting,
  RETIRED_STATUSES, asDate,
};
