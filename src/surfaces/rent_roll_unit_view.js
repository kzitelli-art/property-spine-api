// ════════════════════════════════════════════════════════════════════
//  rent_roll_unit_view.js — THE RENT ROLL AS AN OPERATOR READS IT
//
//  The fifth interpretation of datedPropertyPositions, and the first one
//  shaped by how a person thinks rather than how the data is stored:
//
//      Mike thinks in UNITS. The truth is bed-grained.
//      So the unit is the row, and its rentable positions nest inside it.
//
//  Each position answers two questions and no more:
//
//      CURRENT   who is in it, for how much, through when
//      NEXT      what is known to happen to it after that
//
//  Everything else — institutional columns, deposits, balances, proof
//  bases — is available on the same rows for a detail view, but is not
//  what the default read leads with. A rent roll that opens at
//  institutional density is a spreadsheet; the point of this one is that
//  a person can scan 72 units and see where the building stands.
//
//  ── NO SECOND TRUTH MODEL, AND NO SECOND DERIVATION ─────────────────
//  Nothing here computes a position. `current` and `next` both arrive
//  already decided by classifyPosition — `next` is the classifier's own
//  successor / future_commitment, which is why the classifier now carries
//  the commitment's tenants and rent rather than only its date. A surface
//  that re-queried `leases` to find "who is next" would be deciding a
//  second time, and two derivations of one fact drift.
//
//  Current and Future are the SAME read at two dates (§ the model proof).
//  This takes an `as_of` for exactly that reason and does nothing special
//  when the date is in the future.
//
//  ── HONEST BLANK ────────────────────────────────────────────────────
//  A rent the source never carried is `null` with a stated reason, never
//  0. A position with no known next is `next: null` — not "Open", because
//  "open" is a marketing claim this read is not entitled to make
//  (availability_read owns that, and it needs readiness and turnover
//  facts this read deliberately does not consult).
//
//  CLASSIFICATION: Class 1 — permanent product primitive. READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions, rentRollBuckets } = require("../tenancy/dated_positions");

const money = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
const firstTenant = (tenants) =>
  (Array.isArray(tenants) && tenants.length && tenants[0]) || null;

/*  WHY a rent is missing, so the surface can say it rather than render a
 *  bare dash and let the operator guess whether the import failed.  */
function rentOf(lease) {
  if (!lease) return { amount: null, state: "no_lease" };
  if (lease.rent == null) return { amount: null, state: "not_in_source" };
  return { amount: money(lease.rent), state: "known" };
}

/*  The one line that matters, per rentable position.
 *
 *  `next` is whichever governed future commitment the classifier found —
 *  a successor after the current lease, or a standalone future lease on a
 *  position nothing currently spans. They are the same fact to a reader
 *  ("what happens to this bed next"), and the classifier already treats
 *  them as one shape.  */
function positionLine(p) {
  const current = p.lease
    ? {
        resident: p.resident ? p.resident.name : null,
        //  STABLE IDENTITY, carried but not displayed. A surface that shows a
        //  resident's name and cannot say WHICH person record it is has made
        //  the name the key, and names are not keys (§ the identity refusal).
        //  This is what lets a row open the Person Card without the browser
        //  matching on a string.
        person_id: (p.resident && p.resident.person_id) || null,
        lease_id: p.lease.lease_id || null,
        rent: rentOf(p.lease),
        through: p.lease.end_date || null,
        started: p.lease.start_date || null,
        proof_basis: p.proof_basis || null,
      }
    : null;

  const commitment =
    p.successor && p.successor.state !== "none" ? p.successor
      : (p.future_commitment && p.future_commitment.state !== "none" ? p.future_commitment : null);

  const nextTenant = commitment ? firstTenant(commitment.tenants) : null;
  const next = commitment
    ? {
        resident: nextTenant ? nextTenant.name : null,
        person_id: nextTenant ? nextTenant.person_id : null,
        lease_id: commitment.lease_id || null,
        starts: commitment.start_date || null,
        through: commitment.end_date || null,
        rent: rentOf(commitment),
        //  locked vs pending is the PROOF the commitment carries, not a
        //  softer word for the same thing. Carried, never collapsed.
        state: commitment.state,
        proof_basis: commitment.proof_basis || null,
      }
    : null;

  return {
    space_id: p.space_id,
    label: p.space_label,
    position_kind: p.position_kind,
    //  The position's own standing, in the vocabulary the classifier owns.
    tenancy_state: p.tenancy_state,
    economics_state: p.economics_state,
    evidence_state: p.evidence_state,
    conflict_state: p.conflict_state,
    current,
    next,
    //  Institutional detail lives on the same row for the expanded view.
    //  Carried here so opening a row costs NOTHING — a detail view that
    //  fetched would issue one request per curious click, and could disagree
    //  with the row above it about the date.
    //
    //  What is deliberately NOT here: move-out, market rent, deposit and
    //  ledger balance. None is carried by the dated position service, and
    //  inventing a null for each would let a surface print "Not recorded" —
    //  a claim about the PROPERTY — when the true claim is that this read
    //  does not carry them. The surface says that instead.
    detail: {
      unit_type: p.unit_type,
      use_type: p.use_type,
      square_feet: p.square_feet,
      imported_occupancy_claim: p.imported_occupancy_claim,
      notice_state: p.notice_state,
      //  The DATE, not just the state. "On notice" without a date cannot be
      //  acted on, and the classifier already carries it.
      notice_date: p.notice_date || null,
      //  Possession, in the operator's words: when they actually moved in.
      //  A lease start is a contract date; a move-in is a recorded event, and
      //  they are routinely not the same day.
      moved_in: (p.current_possession && p.current_possession.since) || null,
      possession_state: p.possession_state || null,
      is_down: p.is_down,
      contributes_trusted_rent: p.contributes_trusted_rent,
    },
  };
}

/*  unitRentRoll — the operator Rent Roll for one property at one date.
 *
 *  property_id  server-derived by the caller, never from the browser
 *  as_of        the date the whole read is taken at. Current and Future
 *               are this same call at two dates.
 */
async function unitRentRoll(pool, { property_id, as_of = null } = {}) {
  if (!property_id) throw new Error("unitRentRoll requires property_id");
  const dp = await datedPropertyPositions(pool, { property_id, as_of });

  const byUnit = new Map();
  for (const p of dp.positions) {
    if (!byUnit.has(p.unit_id)) {
      byUnit.set(p.unit_id, {
        unit_id: p.unit_id,
        unit_number: p.unit_number,
        unit_type: p.unit_type,
        positions: [],
      });
    }
    byUnit.get(p.unit_id).positions.push(positionLine(p));
  }

  const units = [...byUnit.values()].map((u) => {
    const t = rentRollBuckets(u.positions);
    const committed = u.positions.filter((x) => x.next).length;
    return {
      ...u,
      //  A unit-level summary a person reads before opening the unit.
      //  Counts only — no percentage, because a percentage of three beds
      //  is a number that looks more precise than it is.
      rentable_positions: u.positions.length,
      occupied: t.occupied,
      activation_pending: t.activation_pending,
      open: t.open,
      needs_review: t.needs_review,
      with_next_known: committed,
    };
  }).sort((a, b) => String(a.unit_number).localeCompare(String(b.unit_number), undefined, { numeric: true }));

  const positions = units.flatMap((u) => u.positions);
  const totals = rentRollBuckets(positions);
  const withNext = positions.filter((p) => p.next).length;
  const rentUnknown = positions.filter(
    (p) => p.current && p.current.rent.state === "not_in_source").length;

  return {
    property_id: dp.property_id,
    as_of: dp.as_of,
    opening_truth: dp.opening_truth,
    totals: {
      units: units.length,
      rentable_positions: positions.length,
      occupied: totals.occupied,
      //  Committed and awaiting economic activation. Spoken for, and never
      //  Open — offering one of these to a prospect is the expensive
      //  mistake the subtraction used to make silently.
      activation_pending: totals.activation_pending,
      //  NOT "vacant". A position with no lease spanning this date is open
      //  ON THIS DATE; whether it can be marketed is a different question
      //  with different inputs, and this read does not answer it.
      //
      //  And NOT `positions.length - occupied`. That subtraction was the
      //  defect: it swept committed, contested and unreconciled beds into
      //  Open because they were not Occupied. Open is now a state a
      //  position is classified INTO, so it can never absorb a bed nobody
      //  classified.
      open: totals.open,
      //  Contested claims and beds whose accepted opening evidence
      //  contradicts the lease record. Spine has no basis to choose, and
      //  will not.
      needs_review: totals.needs_review,
      with_next_known: withNext,
      //  Stated rather than hidden: on a source that carries no forward
      //  rents this is most of the building, and an operator seeing many
      //  blank rents deserves to know the count is expected.
      rent_not_in_source: rentUnknown,
    },
    units,
  };
}

module.exports = { unitRentRoll, positionLine };
