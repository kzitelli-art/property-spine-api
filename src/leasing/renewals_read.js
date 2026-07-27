// ════════════════════════════════════════════════════════════════════
//  renewals_read.js — R1: THE LIVE RENEWAL-WORK COHORT (read-only)
//
//  Answers ONE question: which leases need renewal attention in the next
//  90 days? Canonical leases and expiration dates only. No fixtures, no
//  spreadsheet reconciliation, no forecast.
//
//  WRITES NOTHING, and DERIVES NOTHING THAT IS SHARED. Lease-spanning,
//  successor state, notice, conflict, availability and proof basis all
//  come from the ONE canonical dated derivation (tenancy/space_position).
//  This module adds only what is specific to the renewal WORK view:
//  urgency banding, days remaining, ordering, and conversation context.
//
//  Rev 2 (owner review, 2026-07-27) corrected two long-term defects found
//  while the slice was still small:
//
//   1. NO SUCCESSOR AWARENESS. The cohort was "any lease expiring in 90
//      days", so 49 of 92 positions that ALREADY had a next lease were
//      shown as open renewal decisions. That is the replacement rule
//      failing at its first opportunity. A position must never appear
//      more certain — or more available — than the evidence supports.
//
//   2. A THIRD NOTICE QUERY. notice_given was being re-derived here, in
//      availability.js and in space_position.js. Shared facts are derived
//      once; each surface adds context, not a new meaning.
//
//  THE THREE PERMANENT OUTCOMES for an expiring position:
//    successor_state = none    → OPEN RENEWAL DECISION (the work list)
//    successor_state = pending → SUCCESSOR PENDING, NOT LOCKED
//                                (zero locked rent, zero projected rent,
//                                 visible as unresolved exposure — never
//                                 silently removed, never counted as open)
//    successor_state = locked  → LOCKED FUTURE POSITION (leaves this door;
//                                 feeds the Future Rent Roll)
//  A date-conflicted lease is NOT a successor. It is a contested position
//  and is excluded with an explicit conflict reason, appearing in neither
//  the open nor the pending set.
//
//  'locked' uses the SAME governed rule as everywhere else — executed AND
//  funded. A 'pending' lease_status alone never closes the economic
//  position.
//
//  FACT BOUNDARIES (owner rulings) — each a place a plausible wrong answer
//  was available and is refused:
//   · current rent comes ONLY from leases.rent. Never units.market_rent,
//     which disagrees with in-place rent in 105 of 114 studios measured.
//   · notice comes ONLY from a governed notice_given unit_event. Silence
//     is 'unresolved' — NOT "waiting for a response", because we have not
//     asked.
//   · no renewed state. Separating a signed renewal from a signed new
//     lease needs lease-origin classification, which does not exist.
//   · identity absence ≠ accountability absence. A missing resident is
//     "Resident not linked". UNASSIGNED is only ever the work owner.
//
//  OWNERSHIP is a stated product fact, not a failed lookup: no renewal
//  obligation exists, so there is no candidate source. We do not call
//  resolveEligibleOwner with an empty list to be told what we know. When
//  R2 creates governed renewal obligations they carry candidates and the
//  canonical resolver replaces this constant.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { spacePosition } = require("../tenancy/space_position");

const DEFAULT_HORIZON_DAYS = 90;
const R1_OWNER_STATE = "UNASSIGNED";
const R1_OWNER_REASON = "renewal_work_not_created";

function ymd(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function daysBetween(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const b = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}
function band(days) {
  return days < 30 ? "d0_30" : days < 60 ? "d31_60" : "d61_90";
}

async function renewalsCohort(pool, { property_id, horizon_days = DEFAULT_HORIZON_DAYS } = {}) {
  if (!property_id) throw new Error("renewalsCohort requires property_id");
  const horizon = Number.isFinite(Number(horizon_days)) ? Number(horizon_days) : DEFAULT_HORIZON_DAYS;

  // THE SHARED TRUTH. Everything positional comes from here.
  const sp = await spacePosition(pool, { property_id });
  const asOf = sp.as_of;
  const horizonEnd = ymd(new Date(new Date(`${asOf}T00:00:00Z`).getTime() + horizon * 86400000));

  // Presentation-only context: the Person Card thread for this resident at
  // this property. Not a shared fact — nothing else classifies on it.
  const convRows = (await pool.query(
    `select person_id, min(id::text) as conversation_id
       from conversations where property_id=$1 and person_id is not null group by person_id`,
    [property_id]
  )).rows;
  const convByPerson = new Map(convRows.map((r) => [String(r.person_id), r.conversation_id]));

  const expiring = [];
  for (const p of sp.positions) {
    const cur = p.current_lease_position;
    if (!cur || !cur.end_date) continue;
    const ends = ymd(cur.end_date);
    if (!ends || ends < asOf || ends >= horizonEnd) continue;

    const tenant = (cur.tenants || [])[0] || null;
    const days = daysBetween(asOf, ends);
    expiring.push({
      lease_id: cur.lease_id,
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,
      space_label: p.space_label || null,
      person_id: tenant ? tenant.person_id : null,
      resident_name: tenant ? (tenant.name || null) : null,   // null ⇒ "Resident not linked"
      resident_count: (cur.tenants || []).length,
      conversation_id: tenant ? (convByPerson.get(String(tenant.person_id)) || null) : null,
      current_rent: cur.rent == null ? null : Number(cur.rent),  // null ⇒ "Current rent unavailable"
      expires_on: ends,
      days_until_expiration: days,
      band: band(days),
      notice_state: p.notice_state === "on_notice" ? "on_notice" : "unresolved",
      conflict_state: p.conflict_state,
      successor_state: p.conflict_state === "conflicted" ? "none" : p.successor.state,
      successor_lease_id: p.conflict_state === "conflicted" ? null : p.successor.lease_id,
      successor_proof_basis: p.conflict_state === "conflicted" ? null : p.successor.proof_basis,
      owner_user_id: null,
      owner_state: R1_OWNER_STATE,
      owner_reason: R1_OWNER_REASON,
      proof_basis: cur.proof_basis,
    });
  }

  // Ordering (server-authored): unresolved before on_notice, soonest first,
  // lease_id as a stable tie-break so equal dates never shuffle between reads.
  const order = (rows) => rows.sort((a, b) => {
    const rank = (x) => (x.notice_state === "unresolved" ? 0 : 1);
    return rank(a) - rank(b)
      || a.days_until_expiration - b.days_until_expiration
      || String(a.lease_id).localeCompare(String(b.lease_id));
  });

  // A position lands in EXACTLY ONE bucket.
  const conflicted = order(expiring.filter((r) => r.conflict_state === "conflicted"));
  const rest = expiring.filter((r) => r.conflict_state !== "conflicted");
  const open = order(rest.filter((r) => r.successor_state === "none"));
  const successorPending = order(rest.filter((r) => r.successor_state === "pending"));
  const lockedSuccessor = rest.filter((r) => r.successor_state === "locked");

  const inBand = (b) => open.filter((r) => r.band === b).length;
  const unresolved = open.filter((r) => r.notice_state === "unresolved").length;

  return {
    property_id,
    as_of: asOf,
    horizon_days: horizon,
    horizon_end: horizonEnd,

    // THE PRIMARY WORK LIST — open renewal decisions only.
    count: open.length,
    breakdown: { d0_30: inBand("d0_30"), d31_60: inBand("d31_60"), d61_90: inBand("d61_90") },
    states: { unresolved, on_notice: open.length - unresolved },
    rows: open,

    // SECONDARY CONTEXT — visible, never mixed into the work list, and
    // contributing zero locked and zero projected rent.
    successor_pending: {
      count: successorPending.length,
      note: "A successor lease exists but is not executed and funded. Not a locked position, and not an open renewal decision.",
      rows: successorPending,
    },
    locked_future: {
      count: lockedSuccessor.length,
      note: "Executed and funded successor. Leaves renewal work and feeds the Future Rent Roll.",
    },
    conflicted: {
      count: conflicted.length,
      reason: "overlapping_operative_lease",
      note: "Two non-terminal leases overlap on this position; which lease governs is unknown. Excluded from both open and pending.",
      rows: conflicted,
    },

    totals: { expiring_in_horizon: expiring.length },

    // PAGE-LEVEL TRUTH. When every open row shares a state that is ONE fact
    // about the property, not N warnings. Computed here so the page and the
    // rows can never disagree about what is uniform.
    uniform: {
      all_unresolved: open.length > 0 && unresolved === open.length,
      no_owner_anywhere: open.length > 0 && open.every((r) => !r.owner_user_id),
      owner_reason: open.length > 0 ? R1_OWNER_REASON : null,
    },
  };
}

module.exports = { renewalsCohort, DEFAULT_HORIZON_DAYS };
