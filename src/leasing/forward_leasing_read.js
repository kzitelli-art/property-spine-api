/* ════════════════════════════════════════════════════════════════════
   forward_leasing_read.js — THE 160-BED FORWARD LEASING LEDGER

   The operating question Mike opens a spreadsheet to answer:

       2026–27 LEASING
       144 / 160 committed · 16 remaining
       SIGNED 140    PENDING 4

   and underneath, the exact bed-by-bed ledger. This read produces both,
   from canonical dated lease truth and nothing else.

   ── WHAT IT IS, STRUCTURALLY ────────────────────────────────────────

       intervalPropertyPositions   which beds carry a governed dated
             (11b0bb1)             right overlapping the cycle
                    ↓
       COMMITMENT STATE            signed · pending · remaining ·
                                   unresolved — from lease_status, not
                                   from a flag anyone types
                    ↓
       THE LEDGER + THE HEADLINE

   There is NO forward store. No `preleased` column, no tracker status,
   no editable committed flag. A lease signed today moves this read
   because it moved `leases`; a lease cancelled today moves it the same
   way. That is the whole point, and it is what a spreadsheet cannot do.

   ── THE COMMITMENT BASIS ────────────────────────────────────────────

   A bed is committed for a cycle when a non-terminal governed lease
   OVERLAPS the cycle window. Measured against Mike's live tracker on
   2026-08-16 (docs/FORWARD_RENT_TRACE.md §1.3): 126 of 126 beds where
   Spine had evidence agreed, and ZERO beds were classified differently.
   The residue was 17 beds signed after the rent roll's as-of date —
   absent data, not disagreement.

   ⚠ IT IS THE WORKING BASIS, NOT A FROZEN ONE. Freezing it needs one
   rent roll dated after the last signing. The read carries the basis in
   its payload so no screen can show the count without it.

   ── SIGNED ≠ PENDING, AND NEITHER IS OCCUPANCY ──────────────────────

   `pending` is a real governed lease status (the tenancy anchor writes
   it) and it is NEVER folded into signed. An operator headline may add
   them — Mike's does — but the proof distinction stays underneath, so
   "how much is actually signed?" has an answer that is not the
   committed total.

   And none of this is occupancy. Occupancy is who is physically in the
   building today; this is how much of a future cycle has been sold.
   `datedPropertyPositions` answers the first. They are never added,
   subtracted, or quoted as each other.

   READ-ONLY. Authors nothing.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { intervalPropertyPositions } = require("../tenancy/dated_positions");

/*  Lease statuses that mean "signed" versus "not yet signed". A status
 *  Spine does not recognise is NOT quietly treated as signed — it lands
 *  in `unrecognised` and is reported, because a new status arriving from
 *  a future writer must not silently inflate a committed count. */
const SIGNED_STATUSES = new Set(["active", "current", "executed", "signed", "renewed"]);
const PENDING_STATUSES = new Set(["pending", "pending_signature", "out_for_signature"]);

/*  A TERM SHAPE IS DERIVED, NEVER STORED (docs/FORWARD_RENT_TRACE.md §1.5).
 *  Mike's `Full Year` / `Fall Only` labels reproduce from the lease end
 *  date alone — 43 of 44 bed-for-bed, with both differences explained by
 *  known defects. So Spine computes the label and does not add a column
 *  that could disagree with the dates beside it. */
function termShape(lease, cycle_start, cycle_end) {
  if (!lease || !lease.end_date) return "open_ended";
  const end = String(lease.end_date).slice(0, 10);
  const cs = String(cycle_start).slice(0, 10);
  const ce = String(cycle_end).slice(0, 10);
  //  A third of the way in is not a magic number — it is "ends nearer the
  //  start of the cycle than the end of it", which is what a fall-only
  //  term is. The threshold is REPORTED in the payload so a reader can
  //  see the rule rather than infer it from the label.
  const span = Date.parse(ce) - Date.parse(cs);
  const at = Date.parse(end) - Date.parse(cs);
  if (at <= span * 0.45) return "first_half_only";
  if (at >= span * 0.9) return "full_cycle";
  return "partial_cycle";
}

async function forwardLeasingPosition(pool, {
  property_id, cycle_start, cycle_end, cycle_label = null,
} = {}) {
  if (!property_id) throw new Error("forwardLeasingPosition requires property_id");
  if (!cycle_start || !cycle_end) {
    const e = new Error("forwardLeasingPosition requires cycle_start and cycle_end");
    e.code = "CYCLE_REQUIRED";
    throw e;
  }

  const iv = await intervalPropertyPositions(pool, {
    property_id, requested_start: cycle_start, requested_end: cycle_end,
  });

  const ledger = [];
  const unrecognised = [];
  for (const p of iv.positions) {
    //  The governing right for THIS cycle. `colliding_rights` is exactly
    //  the set of non-terminal leases overlapping the window — the basis,
    //  already computed by the classifier. Not re-derived here.
    const rights = p.colliding_rights || [];
    const signed = rights.filter((l) => SIGNED_STATUSES.has(String(l.lease_status || "").toLowerCase()));
    const pending = rights.filter((l) => PENDING_STATUSES.has(String(l.lease_status || "").toLowerCase()));
    const other = rights.filter((l) =>
      !SIGNED_STATUSES.has(String(l.lease_status || "").toLowerCase()) &&
      !PENDING_STATUSES.has(String(l.lease_status || "").toLowerCase()));
    other.forEach((l) => unrecognised.push({
      space_id: p.space_id, unit_number: p.unit_number, space_label: p.space_label,
      lease_status: l.lease_status,
    }));

    let commitment_state;
    if (p.interval_state === "unresolved") commitment_state = "unresolved";
    else if (signed.length) commitment_state = "signed";
    else if (pending.length) commitment_state = "pending";
    else if (other.length) commitment_state = "unresolved";      // never "signed" by default
    else commitment_state = "remaining";

    //  The governing lease, when there is exactly one. More than one
    //  non-terminal right overlapping a cycle is not an economics
    //  question, it is a conflict, and it is reported as one.
    const governing = signed[0] || pending[0] || null;
    const contended = (signed.length + pending.length) > 1;

    ledger.push({
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,
      space_label: p.space_label,
      commitment_state,
      //  ⚠ RENT IS NULL WHEN UNKNOWN, NEVER 0 AND NEVER MARKET RENT.
      //  On the 07/31 import 121 of 122 cycle leases carry no rent,
      //  because a rent roll reports what is being COLLECTED on its
      //  as-of date and an August lease collects nothing in July.
      //  Coercing that to 0 would understate committed rent by the
      //  whole amount and look like a real number.
      contracted_rent: governing && governing.rent != null && Number(governing.rent) !== 0
        ? Number(governing.rent) : null,
      rent_state: !governing ? "not_applicable"
        : (governing.rent != null && Number(governing.rent) !== 0 ? "established" : "NOT_ESTABLISHED"),
      resident: governing && governing.tenants && governing.tenants.length
        ? governing.tenants.map((t) => t.name).filter(Boolean).join(", ") || null : null,
      term_start: governing ? governing.start_date : null,
      term_end: governing ? governing.end_date : null,
      term_shape: governing ? termShape(governing, cycle_start, cycle_end) : null,
      proof_basis: governing ? governing.proof_basis : null,
      contract_position: p.interval_state,
      contended,
      conflicting_lease_ids: p.conflicting_lease_ids || [],
    });
  }

  const count = (s) => ledger.filter((r) => r.commitment_state === s).length;
  const signedRows = ledger.filter((r) => r.commitment_state === "signed");
  const pendingRows = ledger.filter((r) => r.commitment_state === "pending");
  const sum = (rows) => rows.reduce((a, r) => a + (r.contracted_rent || 0), 0);
  const missing = (rows) => rows.filter((r) => r.rent_state === "NOT_ESTABLISHED").length;

  const positions = ledger.length;
  const committed = count("signed") + count("pending");

  return {
    property_id,
    cycle: { label: cycle_label, start: String(cycle_start).slice(0, 10), end: String(cycle_end).slice(0, 10) },

    /*  THE BASIS TRAVELS WITH THE NUMBER. A committed count is not a
     *  fact until it says what committed means (§40.10). No screen and
     *  no sentence may show the headline without this. */
    commitment_basis: {
      rule: "a non-terminal governed lease overlapping the cycle window",
      status: "WORKING — not frozen",
      evidence: "reproduced Mike's live tracker on every bed where Spine had evidence " +
                "(126/126 agree, 0 classified differently); 17 beds untested because they " +
                "were signed after the rent roll's as-of date",
      freezes_when: "one rent roll dated after the last signing resolves the untested beds",
    },

    headline: {
      positions,
      signed: count("signed"),
      pending: count("pending"),
      committed,
      remaining: count("remaining"),
      unresolved: count("unresolved"),
      committed_pct: positions ? Number(((100 * committed) / positions).toFixed(1)) : null,
    },

    economics: {
      //  Four numbers, never merged. "How much is actually signed" must
      //  not be answerable only as the committed total.
      signed_rent: sum(signedRows),
      pending_rent: sum(pendingRows),
      committed_rent: sum(signedRows) + sum(pendingRows),
      //  …and the honesty beside them. A rent total computed from rows
      //  where most rents are unknown is not a small error, it is a
      //  different number, so the count of unknowns rides along and a
      //  consumer that ignores it is publishing a fiction.
      rent_not_established: missing(signedRows) + missing(pendingRows),
      rent_established: signedRows.length + pendingRows.length - (missing(signedRows) + missing(pendingRows)),
      complete: (missing(signedRows) + missing(pendingRows)) === 0,
    },

    term_shapes: ledger.reduce((m, r) => {
      if (r.term_shape) m[r.term_shape] = (m[r.term_shape] || 0) + 1;
      return m;
    }, {}),

    //  Reported, never absorbed. A lease status this read does not
    //  recognise must not become "signed" by falling through a default.
    unrecognised_lease_statuses: unrecognised,

    ledger,

    does_not_establish: [
      "Physical occupancy. This is how much of a future cycle has been sold, not who is " +
      "in the building today — datedPropertyPositions answers that, and the two are never " +
      "added, subtracted or quoted as each other.",
      "Whether a remaining bed can be marketed, shown or offered. That is operating " +
      "availability and it is availability_read's answer.",
      "Projected gross rent. Committed rent is contracted truth; filling open beds at an " +
      "asking rent is an assumption and belongs to a separate, explicit composition.",
      "Pace against a prior cycle. When each bed BECAME committed is not recorded for any " +
      "imported population and cannot be reconstructed — see LEASING_CYCLE_AND_PACE_TRACE §5.",
    ],
  };
}

module.exports = { forwardLeasingPosition, _internal: { termShape, SIGNED_STATUSES, PENDING_STATUSES } };
