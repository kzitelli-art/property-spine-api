// ════════════════════════════════════════════════════════════════════
//  availability_read.js — AVAILABILITY, THE LEASING INTERPRETATION
//
//  The fourth and final read over datedPropertyPositions. Availability is
//  NOT a separate inventory model: it is the same position facts with
//  possession, physical readiness and turnover added, answering one
//  question —
//
//    Which positions can honestly be marketed now, which are coming, and
//    what prevents the others from being marketed?
//
//  CONSUMES, NEVER RE-DERIVES: current lease, lease expiration, notice,
//  successor state, conflict state, proof basis, down state, evidence
//  disagreement. Those arrive already decided.
//
//  ADDS ONLY: possession, physical readiness, turnover, expected ready
//  date, earliest marketable date, marketing state, blocking reason.
//
//  NO PRICING. No market rent, no concessions, no projected leasing.
//
//  ── THE PERMANENT RULE ───────────────────────────────────────────────
//        vacant  ≠  ready  ≠  marketable
//
//  A position is marketable_now ONLY when every required fact supports it.
//  Absence of a lease is not evidence of availability — it is absence of
//  evidence. On Demo, 10 positions read 'ready_now' on the availability
//  axis while only 3 can honestly be marketed; the other 7 are held back
//  by occupancy evidence that disagrees, a contest, or being out of
//  service. Advertising those would be the exact failure this file exists
//  to prevent.
//
//  WRITES NOTHING.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions } = require("../tenancy/dated_positions");

// An operating designation is NOT a durable use. A model unit is
// residential by purpose and unmarketable by current designation, and
// collapsing the two would either lose the unit from inventory forever or
// advertise a display suite. units.operating_use is the governed field and
// already carries this (214 = 'model'); use_type carries the purpose.
const MARKETABLE_OPERATING_USE = "standard";
const MARKETABLE_USE_TYPES = new Set(["residential", "commercial"]);

// Ordered most-blocking first. The FIRST match wins and becomes the single
// stated reason, so a row never shows a queue of complaints — and the
// reason shown is the one that must be resolved first.
function marketingState(p, liveOk) {
  if (!liveOk) return { state: "unavailable", reason: "live_read_failed" };

  if (p.conflict_state === "conflicted")
    return { state: "contested", reason: "overlapping_lease_claims" };

  if (p.is_down)
    return { state: "down", reason: "out_of_service" };

  if (p.operating_use && p.operating_use !== MARKETABLE_OPERATING_USE)
    return { state: "not_marketable_use", reason: "operating_designation_" + p.operating_use };

  if (p.evidence_state === "disagrees")
    return { state: "evidence_disagrees", reason: "opening_source_claims_occupied_without_lease" };

  // ACTIVATION PENDING — a lease has COMMENCED on this position but economic
  // tenancy is not active (required move-in funds outstanding). The position
  // has no `current` lease, so every naive check reads it as empty. It is the
  // opposite of empty: it is committed and awaiting activation. This is the
  // exact case of unit 530, which was quoted as available in nine outbound
  // texts while holding a lease that had already started.
  if (p.availability_state === "committed_activation_pending")
    return { state: "activation_pending", reason: "lease_commenced_awaiting_move_in_funds" };

  // A successor removes the position from open inventory whether or not it
  // is locked — a pending successor is not marketable inventory, it is a
  // commitment awaiting proof.
  if (p.successor && p.successor.state === "locked")
    return { state: "successor_locked", reason: "committed_to_a_future_resident" };
  if (p.successor && p.successor.state === "pending")
    return { state: "successor_pending", reason: "successor_awaiting_execution_and_funding" };

  // Committed to a future resident even though nothing spans today.
  if (p.availability_state === "committed_future")
    return { state: "successor_locked", reason: "committed_to_a_future_start_date" };

  if (p.lease) {
    return p.notice_state === "on_notice"
      ? { state: "upcoming", reason: "on_notice" }
      : { state: "occupied", reason: "spanning_lease" };
  }

  // No spanning lease from here down. Still not automatically marketable.
  if (p.possession_state === "delivered")
    return { state: "not_ready", reason: "possession_not_returned" };

  if (p.physical_readiness === "turning")
    return { state: "turnover_required", reason: "turnover_in_progress" };

  if (!p.use_type)
    return { state: "use_not_configured", reason: "no_governed_use_type" };
  if (!MARKETABLE_USE_TYPES.has(p.use_type))
    return { state: "not_marketable_use", reason: "use_type_" + p.use_type };

  return { state: "marketable_now", reason: null };
}

// ── AVAILABLE FROM, HONESTLY ─────────────────────────────────────────
//  Only governed facts may produce a date. A future lease expiration alone
//  does NOT prove the position can be marketed or occupied the next day:
//  the turn between residents is real work, and no approved turnover
//  duration exists as a property fact. So a dated expectation is returned
//  as 'incomplete' with the exact fact that is missing, rather than a
//  confident date the building cannot stand behind.
function availableFrom(p, state, asOf) {
  if (state === "marketable_now") {
    return { available_from: asOf, availability_confidence: "confirmed", blocking_fact: null };
  }
  if (state === "upcoming") {
    // Notice gives a governed move-out date. What happens between move-out
    // and marketable is the turn, and its duration is not governed.
    const d = p.available_from || (p.lease ? p.lease.end_date : null);
    return {
      available_from: d ? String(d).slice(0, 10) : null,
      availability_confidence: "incomplete",
      blocking_fact: "no_governed_turnover_duration",
    };
  }
  if (state === "turnover_required") {
    return { available_from: null, availability_confidence: "incomplete", blocking_fact: "turnover_completion_not_scheduled" };
  }
  if (state === "occupied") {
    const d = p.lease && p.lease.end_date ? String(p.lease.end_date).slice(0, 10) : null;
    return {
      available_from: null,   // an expiration is not an availability date
      availability_confidence: "incomplete",
      blocking_fact: d ? "lease_runs_to_" + d : "no_lease_end_date",
    };
  }
  return { available_from: null, availability_confidence: "incomplete", blocking_fact: "position_not_available" };
}

const HUMAN = {
  contested: "Overlapping lease claims — resolve which lease governs",
  down: "Out of service",
  not_marketable_use: "Not marketable in its current operating designation",
  evidence_disagrees: "Occupancy evidence disagrees — confirm whether this is occupied",
  successor_locked: "Committed to a future resident",
  successor_pending: "Successor pending — not yet executed and funded",
  occupied: "Occupied",
  upcoming: "On notice",
  not_ready: "Possession not returned",
  turnover_required: "Turnover in progress",
  activation_pending: "Lease commenced — awaiting move-in funds",
  use_not_configured: "Use type not configured",
  marketable_now: "Marketable now",
  unavailable: "Live read failed",
};

async function availabilityRead(pool, { property_id, as_of = null, horizon_days = 90 } = {}) {
  const dp = await datedPropertyPositions(pool, { property_id, as_of });
  const asOf = dp.as_of;

  // operating_use is a UNIT fact and is not owned by the classifier.
  const ops = new Map((await pool.query(
    `select s.id space_id, u.operating_use
       from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [property_id]
  )).rows.map((r) => [String(r.space_id), r.operating_use]));

  const horizonEnd = new Date(new Date(`${asOf}T00:00:00Z`).getTime() + horizon_days * 86400000)
    .toISOString().slice(0, 10);

  const rows = dp.positions.map((p) => {
    const withOps = { ...p, operating_use: ops.get(String(p.space_id)) || null };
    const m = marketingState(withOps, true);
    const dates = availableFrom(withOps, m.state, asOf);
    return {
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,
      space_label: p.space_label,
      position_kind: p.position_kind,
      unit_type: p.unit_type,
      square_feet: p.square_feet,

      marketing_state: m.state,
      blocking_reason: m.reason,
      blocking_label: HUMAN[m.state] || null,
      ...dates,
      within_horizon: !!(dates.available_from && dates.available_from <= horizonEnd),

      // Availability's OWN context
      possession_state: p.possession_state,
      physical_readiness: p.physical_readiness,
      turnover_in_progress: p.physical_readiness === "turning",
      operating_use: withOps.operating_use,

      // consumed, never re-derived — carried so the row can explain itself
      lease_id: p.lease ? p.lease.lease_id : null,
      lease_end: p.lease ? p.lease.end_date : null,
      resident: p.resident,
      notice_state: p.notice_state,
      successor_state: p.successor.state,
      successor_lease_id: p.successor.lease_id,
      conflict_state: p.conflict_state,
      evidence_state: p.evidence_state,
      tenancy_state: p.tenancy_state,
      proof_basis: p.proof_basis,
      is_down: p.is_down,
      use_type: p.use_type,
    };
  });

  const inState = (s) => rows.filter((r) => r.marketing_state === s);
  const marketable = inState("marketable_now");
  const upcoming = inState("upcoming");
  const withinHorizon = upcoming.filter((r) => r.within_horizon);

  return {
    property_id, as_of: asOf, horizon_days, horizon_end: horizonEnd,
    count: rows.length,

    headline: {
      marketable_now: marketable.length,
      expected_within_horizon: withinHorizon.length,
      blocked_by_evidence: inState("evidence_disagrees").length,
      contested: inState("contested").length,
    },

    // Each position appears in exactly one state.
    states: {
      marketable_now: marketable.length,
      upcoming: upcoming.length,
      occupied: inState("occupied").length,
      successor_locked: inState("successor_locked").length,
      successor_pending: inState("successor_pending").length,
      turnover_required: inState("turnover_required").length,
      activation_pending: inState("activation_pending").length,
      not_ready: inState("not_ready").length,
      down: inState("down").length,
      evidence_disagrees: inState("evidence_disagrees").length,
      contested: inState("contested").length,
      use_not_configured: inState("use_not_configured").length,
      not_marketable_use: inState("not_marketable_use").length,
    },

    rows,
  };
}

module.exports = { availabilityRead, marketingState, availableFrom, HUMAN };
