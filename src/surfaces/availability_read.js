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
// ONE readiness definition, shared with the triage service. A second copy here
// is exactly how a read and a write come to disagree.
const { deriveReadiness } = require("../maintenance/unit_triage_service");

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
// PROOF-AWARE PENDING LANGUAGE.
//
// "awaiting execution and funding" is true of a lease that entered natively and
// has not finished those steps. It is FALSE of a confirmed opening import,
// which is governed operating truth that never took the native path at all —
// telling an operator it is "waiting" for steps it will never take is a
// confident-wrong label, not a harmless simplification.
function pendingReason(commitment) {
  const basis = commitment && commitment.proof_basis;
  if (basis === "confirmed_opening_import") return "future_commitment_confirmed_opening_truth";
  if (basis === "unproven") return "future_commitment_native_proof_or_funding_incomplete";
  return "future_commitment_proof_unavailable";
}

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
    return { state: "successor_pending", reason: pendingReason(p.successor) };

  // Committed to a future resident even though nothing spans today.
  //
  // This branch previously returned successor_locked UNCONDITIONALLY. The
  // `successor` tests above only fire when a governing lease exists, so a
  // STANDALONE future lease on a vacant position never reached them and every
  // such position — funded or not — was reported locked. Suppression was
  // right; the label was stronger than the proof.
  //
  // The canonical future_commitment now answers it, using the same governed
  // locked rule (executed AND funded). No availability state may claim more
  // proof than the lease carries.
  if (p.availability_state === "committed_future") {
    const fc = p.future_commitment;
    if (fc && fc.state === "locked")
      return { state: "successor_locked", reason: "committed_to_a_future_start_date" };
    if (fc && fc.state === "pending")
      return { state: "successor_pending", reason: pendingReason(fc) };
    // committed_future with no carried commitment object means the projection
    // did not supply one. Marketing stays suppressed — the position IS
    // committed — but it is never upgraded to locked on missing evidence.
    return { state: "successor_pending", reason: "future_commitment_proof_unavailable" };
  }

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

  // ══════════════════════════════════════════════════════════════════
  //  BUILD 1 TRIAGE OVERLAY — SCOPED TO TRIAGE EVIDENCE, NOTHING ELSE
  //
  //  THIS PROTECTS THE NEW SLICE. IT DOES NOT REPAIR THE HISTORICAL
  //  READINESS ARCHITECTURE, AND IT MUST NOT TRY TO.
  //
  //  The entire block is inside `if (p.triage)`. A position with no BUILD 1
  //  triage fact falls straight through to the preexisting behavior,
  //  unchanged. Legacy units, occupied positions, completed turns and units
  //  that have never been walked are NOT reinterpreted here.
  //
  //  An earlier draft added a GENERIC `physical_readiness === "unknown"`
  //  guard outside this block, paired with a classifier change. Both were
  //  reverted. The reason is structural: completed turns cannot reach the
  //  classifier at all — space_position.js filters turn_status to
  //  'in_progress' — so `unknown` would have covered essentially every
  //  position and marketable_now would have gone to zero portfolio-wide,
  //  while cross_surface_invariants passed VACUOUSLY on an empty set.
  //
  //  The underlying defect — absence of a turnover row reading as `ready` —
  //  is real, is NOT fixed here, and is tracked as a separate unresolved
  //  architecture issue in docs/archive/MAINTENANCE_UNIT_STATUS_SOURCE_COMPARISON.md.
  //  BUILD 1 does not own the portfolio-wide repair.
  //
  //  `triage` is overlaid by availabilityRead the same way operating_use is —
  //  a UNIT fact the position classifier does not own.
  // ══════════════════════════════════════════════════════════════════
  if (p.triage) {
    // ── CERTIFIED PHYSICALLY READY (BUILD 4) ─────────────────────────
    //  The ONLY thing in this system that raises the readiness axis to
    //  `ready`, and it exists only because a named human signed a
    //  certification. It is NOT derived from an empty task list.
    //
    //  It FALLS THROUGH rather than returning. That is the whole boundary:
    //  certification settles the PHYSICAL READINESS axis and nothing else, so
    //  the remaining guards still run and still win. Every guard that outranks
    //  this block — contested, down, operating designation, evidence
    //  disagreement, activation pending, successor commitments, a spanning
    //  lease, possession not returned — has ALREADY returned above, so a
    //  certified unit carrying any of them never reaches here and never reads
    //  marketable. Returning `marketable_now` from inside this block would
    //  have let a certification override another axis; falling through cannot.
    if (p.triage.certified_ready) {
      // deliberate no-op: continue to the use-type guards below
    } else {
    //  A confirmed walk that found a blocker outranks everything below: a
    //  human stood in the unit and reported it. The reason names the
    //  confirmed blocker rather than a generic unavailability.
    if (p.triage.readiness === "not_ready")
      return { state: "not_ready_confirmed", reason: p.triage.readiness_reason || "confirmed_physical_blocker" };

    //  Move-out confirmed, walk assigned, walk not yet done. Nobody has
    //  looked, so nothing may claim this position is ready.
    if (p.triage.pending_walk)
      return { state: "readiness_unknown", reason: "initial_inspection_pending" };

    //  Walked, no blocker found — still not readiness. Initial triage is not
    //  a complete readiness inspection. Saying "no inspection recorded" here
    //  would be a wrong statement about a unit a tech just walked, so the two
    //  unknowns stay distinct.
    return { state: "readiness_unknown", reason: "walked_no_blocker_found_readiness_unconfirmed" };
    }
  }

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
// ── ONE DATE NORMALIZER ──────────────────────────────────────────────
//  Dates reach this file in TWO shapes and the difference is invisible until
//  it corrupts a value. Lease dates arrive through json_agg in
//  space_position, so they are already 'YYYY-MM-DD' STRINGS. notice_date is
//  selected as a bare `date` column, so node-pg parses it into a JS DATE.
//
//  `String(d).slice(0, 10)` is correct for the first and silently wrong for
//  the second: String(new Date(...)) is 'Sat Aug 22 2026 …', whose first ten
//  characters are 'Sat Aug 22'. Every `upcoming` position was returning that
//  as available_from, and `within_horizon` then compared it lexically against
//  a real ISO date — so it was ALWAYS false and expected_within_horizon
//  silently undercounted. Found by Slice 9's deterministic fixtures.
function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function availableFrom(p, state, asOf) {
  if (state === "marketable_now") {
    return { available_from: asOf, availability_confidence: "confirmed", blocking_fact: null };
  }
  if (state === "upcoming") {
    // Notice gives a governed move-out date. What happens between move-out
    // and marketable is the turn, and its duration is not governed.
    const d = p.available_from || (p.lease ? p.lease.end_date : null);
    return {
      available_from: ymd(d),
      availability_confidence: "incomplete",
      blocking_fact: "no_governed_turnover_duration",
    };
  }
  if (state === "turnover_required") {
    return { available_from: null, availability_confidence: "incomplete", blocking_fact: "turnover_completion_not_scheduled" };
  }
  // Both BUILD 1 states refuse a date, for different honest reasons: one has
  // confirmed blockers whose cure time nobody has estimated, the other has no
  // inspection at all. Neither invents a ready date.
  if (state === "not_ready_confirmed") {
    return { available_from: null, availability_confidence: "incomplete", blocking_fact: "confirmed_physical_work_outstanding" };
  }
  //  Only reachable from BUILD 1 triage evidence, so p.triage is always
  //  present here. The two cases are genuinely different facts: nobody has
  //  walked it yet, versus somebody walked it and the detailed inspection is
  //  still owed.
  if (state === "readiness_unknown") {
    return {
      available_from: null,
      availability_confidence: "incomplete",
      blocking_fact: (p.triage && p.triage.pending_walk)
        ? "initial_walk_not_completed"
        : "detailed_inspection_not_completed",
    };
  }
  if (state === "occupied") {
    const d = p.lease ? ymd(p.lease.end_date) : null;
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
  not_ready_confirmed: "Not ready — confirmed physical blockers",
  readiness_unknown: "Readiness unknown — initial inspection pending",
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

  // ── CONFIRMED TRIAGE OVERLAY (BUILD 1) ─────────────────────────────
  //  Triage is a UNIT fact, like operating_use, so it is overlaid here rather
  //  than widening what the pure classifier must load. Current truth is the
  //  latest confirmation nothing supersedes.
  //
  //  FAIL-SOFT, NEVER FAKE-ZERO — the rule exposure.js already set: if
  //  migration 112 has not run in this database yet (Postgres 42P01), the
  //  overlay is simply absent and every position falls back to the
  //  classifier's own honest `unknown`. It does NOT invent readiness, and it
  //  does not take the whole availability read down with it.
  const triageByUnit = new Map();
  try {
    const tq = await pool.query(
      `with latest as (
         select distinct on (c.unit_id) c.*
           from unit_triage_confirmations c
           join units u on u.id = c.unit_id
          where u.property_id = $1
            and not exists (select 1 from unit_triage_confirmations s where s.supersedes_id = c.id)
          order by c.unit_id, c.created_at desc
       )
       select l.unit_id, l.vacancy_observation, l.initial_condition, l.inspection_completeness,
              coalesce(array_remove(array_agg(distinct w.work_text)
                       filter (where w.status = 'required'), null), '{}') as open_scope,
              count(distinct f.id) filter (where f.withdrawn_at is null) as live_finding_count
         from latest l
         left join unit_triage_required_work w on w.confirmation_id = l.id
         left join unit_triage_findings     f on f.confirmation_id = l.id
        group by l.unit_id, l.vacancy_observation, l.initial_condition, l.inspection_completeness`,
      [property_id]
    );
    for (const r of tq.rows) {
      const openScope = r.open_scope || [];
      // ONE definition of readiness, imported — not a second copy that can
      // drift from the service's. Shapes are minimal but real.
      const d = deriveReadiness({
        confirmation: r,
        findings: Array.from({ length: Number(r.live_finding_count) || 0 }, () => ({ withdrawn_at: null })),
        requiredWork: openScope.map((t) => ({ status: "required", work_text: t })),
      });
      triageByUnit.set(String(r.unit_id), { ...d, open_scope: openScope, pending_walk: false });
    }

    // ── WALK ASSIGNED BUT NOT DONE ───────────────────────────────────
    //  Move-out confirmed spawns an initial_unit_walk obligation. Until it is
    //  answered there is no confirmation row, so the query above returns
    //  nothing for that unit — yet somebody has been asked to look and has
    //  not, which is affirmative BUILD 1 evidence that readiness is unknown.
    //
    //  Only units NOT already carrying a confirmation are added: a completed
    //  walk supersedes a pending one, and a stale open obligation must not
    //  override a real confirmed answer.
    const wq = await pool.query(
      `select distinct o.unit_id
         from obligations o
         join units u on u.id = o.unit_id
        where u.property_id = $1
          and o.type = 'initial_unit_walk'
          and o.status in ('open','in_progress')
          and o.unit_id is not null`,
      [property_id]
    );
    // ── LIVE READINESS CERTIFICATIONS (BUILD 4) ──────────────────────
    //  A certification nothing supersedes, in state 'ready'. Revoked and
    //  corrected rows are superseded by construction and never appear here, so
    //  a revocation removes readiness by the same mechanism that granted it.
    const cq = await pool.query(
      `select c.unit_id, c.id, c.certified_at, c.certified_by_user_id
         from unit_readiness_certifications c
         join units u on u.id = c.unit_id
        where u.property_id = $1 and c.state = 'ready'
          and not exists (select 1 from unit_readiness_certifications s where s.supersedes_id = c.id)`,
      [property_id]);
    for (const r of cq.rows) {
      const k = String(r.unit_id);
      const prior = triageByUnit.get(k) || { open_scope: [], pending_walk: false };
      triageByUnit.set(k, {
        ...prior,
        readiness: "ready",
        readiness_reason: "certified_by_authorized_human",
        readiness_label: "Physically ready — certified",
        certified_ready: true,
        certification_id: r.id,
        certified_at: r.certified_at,
      });
    }

    for (const r of wq.rows) {
      const k = String(r.unit_id);
      if (triageByUnit.has(k)) continue;
      triageByUnit.set(k, {
        readiness: "unknown",
        readiness_reason: "initial_inspection_pending",
        readiness_label: "Readiness unknown — initial inspection pending",
        open_scope: [],
        pending_walk: true,
      });
    }
  } catch (e) {
    if (e.code !== "42P01") throw e;   // only a missing table is tolerated
  }

  const horizonEnd = new Date(new Date(`${asOf}T00:00:00Z`).getTime() + horizon_days * 86400000)
    .toISOString().slice(0, 10);

  const rows = dp.positions.map((p) => {
    const withOps = {
      ...p,
      operating_use: ops.get(String(p.space_id)) || null,
      triage: triageByUnit.get(String(p.unit_id)) || null,
    };
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

      // ── WHY, not just THAT (BUILD 1) ──
      //  The row can now name the open scope rather than only stating a
      //  blocking reason, so a manager does not reconstruct a unit's condition
      //  from work-order notes. Empty array when no confirmed walk exists —
      //  an honest blank, never a fabricated "nothing needed".
      certified_ready: !!(withOps.triage && withOps.triage.certified_ready),
      readiness_certification_id: withOps.triage ? (withOps.triage.certification_id || null) : null,
      triage_readiness: withOps.triage ? withOps.triage.readiness : null,
      triage_readiness_label: withOps.triage ? withOps.triage.readiness_label : null,
      open_scope: withOps.triage ? withOps.triage.open_scope : [],
      initial_inspection_recorded: !!withOps.triage,

      // consumed, never re-derived — carried so the row can explain itself
      lease_id: p.lease ? p.lease.lease_id : null,
      lease_end: p.lease ? p.lease.end_date : null,
      resident: p.resident,
      notice_state: p.notice_state,
      successor_state: p.successor.state,
      successor_lease_id: p.successor.lease_id,

      // ── THE FROZEN CANONICAL COMMITMENT CONTRACT ──────────────────
      // Three INDEPENDENT dated positions, never one ladder. A position can
      // hold a current lease AND a future commitment simultaneously; flattening
      // them into a single commitment_state made that unrepresentable and
      // implied "all commitment on this position" when the value only ever
      // described the future one.
      //
      // The earlier flattened fields also carried a dead fallback:
      // classifyFutureCommitment(null) returns a truthy {state:'none'} object,
      // so `p.future_commitment ? … : p.successor` could never reach the
      // successor branch. Removed rather than repaired — the objects below make
      // the fallback unnecessary.
      future_commitment: p.future_commitment || {
        state: "none", lease_id: null, start_date: null, proof_basis: null },
      activation_pending: p.activation_pending_lease_position ? {
        lease_id: p.activation_pending_lease_position.lease_id,
        start_date: p.activation_pending_lease_position.start_date,
        proof_basis: p.activation_pending_lease_position.proof_basis || null,
      } : null,
      current_lease: p.lease ? {
        lease_id: p.lease.lease_id,
        start_date: p.lease.start_date,
        end_date: p.lease.end_date,
        proof_basis: p.proof_basis || null,
      } : null,
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
      not_ready_confirmed: inState("not_ready_confirmed").length,
      readiness_unknown: inState("readiness_unknown").length,
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
