// ════════════════════════════════════════════════════════════════════
//  position_classifier.js — THE SHARED MEANING OF A RENTABLE POSITION
//
//  PURE. No database access, no I/O, no clock. It receives already-loaded
//  data and returns facts. All SQL and assembly stay in space_position.js.
//
//  This exists because four surfaces — Current Rent Roll, Renewals,
//  Availability and Future Rent Roll — are the SAME property truth viewed
//  at different dates. Each may add its own context. None may redefine
//  what these facts MEAN:
//
//      lease spanning · successor state · notice state
//      conflict state · availability state · proof basis
//
//  Extracted 2026-07-27 after `notice_given` was found being independently
//  re-derived in three places (availability.js, space_position.js and the
//  first cut of renewals_read.js) with three vocabularies for one fact.
//  Shared facts are derived once; each surface adds context, not a new
//  meaning. Being pure, this is also the first part of the position read
//  that can be tested without a database.
//
//  BEHAVIOUR-PRESERVING BY CONSTRUCTION: the logic below was moved
//  verbatim from space_position.js. Characterization tests run the
//  pre-extraction implementation and this one against the same live data
//  and assert deep equality, so "no behaviour change" is proven rather
//  than asserted.
// ════════════════════════════════════════════════════════════════════

"use strict";

const TERMINAL_LEASE_STATUSES = new Set([
  "cancelled", "terminated", "rescinded", "void", "expired", "superseded",
]);
const CURRENT_ECONOMIC_STATUSES = new Set(["active", "commercial"]);

function normalizedStatus(lease) {
  return String(lease && lease.lease_status || "").toLowerCase();
}
function leaseIsValid(lease) {
  return !!lease && !TERMINAL_LEASE_STATUSES.has(normalizedStatus(lease));
}
function datesSpan(lease, asOf) {
  return !!(lease && lease.start_date && lease.start_date <= asOf && (!lease.end_date || lease.end_date >= asOf));
}
function isFuture(lease, asOf) {
  return !!(lease && lease.start_date && lease.start_date > asOf);
}
function tenantList(lease, personNames) {
  return (lease.tenant_ids || []).filter(Boolean).map((person_id) => ({
    person_id,
    name: personNames && personNames.has(String(person_id)) ? personNames.get(String(person_id)) : null,
  }));
}

// Two non-terminal leases on one space whose date ranges intersect. An open
// end_date runs forever. This is the ONE definition of a contested position.
function rangesOverlap(a, b) {
  if (!a || !b || !a.start_date || !b.start_date) return false;
  const aEnd = a.end_date ? String(a.end_date) : "9999-12-31";
  const bEnd = b.end_date ? String(b.end_date) : "9999-12-31";
  return String(a.start_date) <= bEnd && String(b.start_date) <= aEnd;
}

// HOW WE KNOW A LEASE IS TRUE — one answer, shared by every surface.
//   native_verified          executed through Spine AND required move-in
//                            funds cleared. The governed locked rule.
//   confirmed_opening_import accepted as the property's opening contractual
//                            truth from a governed source.
//   unproven                 anything else. Never counts as locked.
// Deliberately NOT collapsed: an imported lease is real operating truth, but
// it did not pass proof steps it never passed, and that stays visible.
function proofBasis(lease) {
  if (!lease) return null;
  if (lease.executed_verified && lease.move_in_funds_cleared) return "native_verified";
  if (lease.source_type === "historical_snapshot" && lease.confidence === "confirmed") return "confirmed_opening_import";
  return "unproven";
}

// ── THE CLASSIFIER ───────────────────────────────────────────────────
//  row          one loaded space: { space_id, unit_id, unit_number,
//               space_label, leases[], possession_events[], notice_date,
//               turn_status, compat_occupancy }
//  asOf         'YYYY-MM-DD'
//  personNames  Map(person_id → name) — data, already loaded
function classifyPosition(row, { asOf, personNames } = {}) {
  const leases = (row.leases || []).filter(leaseIsValid);
  const current = leases.find((lease) => CURRENT_ECONOMIC_STATUSES.has(normalizedStatus(lease)) && datesSpan(lease, asOf)) || null;
  const activationPending = leases.find((lease) => normalizedStatus(lease) === "pending" && datesSpan(lease, asOf)) || null;
  const future = leases.find((lease) => isFuture(lease, asOf)) || null;

  const events = row.possession_events || [];
  const ins = events.filter((e) => e.event_type === "move_in");
  const outs = events.filter((e) => e.event_type === "move_out");
  const lastIn = ins.length ? ins[ins.length - 1] : null;
  const lastOut = outs.length ? outs[outs.length - 1] : null;
  const possessed = !!lastIn && (!lastOut || lastOut.effective_date < lastIn.effective_date ||
    (lastOut.effective_date === lastIn.effective_date && String(lastOut.created_at) < String(lastIn.created_at)));
  const turning = row.turn_status === "in_progress";

  let availability_state = "unavailable";
  let available_from = null;
  if (current) {
    availability_state = row.notice_date ? "on_notice" : "unavailable";
    available_from = row.notice_date || null;
  } else if (activationPending) {
    availability_state = "committed_activation_pending";
  } else if (possessed) {
    availability_state = "unavailable";
  } else if (turning) {
    availability_state = "vacant_turning";
  } else if (future) {
    availability_state = "committed_future";
    available_from = future.start_date;
  } else {
    availability_state = "ready_now";
    available_from = asOf;
  }

  let next_required_action = null;
  let reason = null;
  if (activationPending) {
    next_required_action = "economic_tenancy_activation_required";
    reason = `Lease commenced ${activationPending.start_date}, but economic tenancy is not active — confirm and collect required move-in charges before current rent-roll activation.`;
  } else if (current && !possessed) {
    next_required_action = "possession_outstanding";
    reason = `Lease is active from ${current.start_date}; resident is current on the rent-roll axis, but keys/access handoff has not been recorded.`;
  } else if (future && possessed) {
    next_required_action = "review_early_possession";
    reason = `Possession was recorded before the committed lease start ${future.start_date}.`;
  } else if (future && turning) {
    next_required_action = "turn_before_committed_start";
    reason = `Committed for ${future.start_date}, but the unit turn is still in progress.`;
  } else if (!current && !activationPending && !future && possessed) {
    next_required_action = "possession_without_current_lease";
    reason = "Someone is in possession with no active current lease on the space.";
  }

  const shapeLease = (lease) => lease ? {
    lease_id: lease.id,
    lease_status: lease.lease_status,
    start_date: lease.start_date,
    end_date: lease.end_date || null,
    rent: lease.rent == null ? null : Number(lease.rent),
    tenants: tenantList(lease, personNames),
    proof_basis: proofBasis(lease),
  } : null;

  // CONFLICT: a contested position. Which lease governs is unknown, so it
  // must never be silently resolved to the first match.
  const conflicting = [];
  for (let i = 0; i < leases.length; i++) {
    for (let j = i + 1; j < leases.length; j++) {
      if (rangesOverlap(leases[i], leases[j])) conflicting.push(leases[i].id, leases[j].id);
    }
  }
  const conflict_ids = [...new Set(conflicting)];

  // SUCCESSOR of the lease governing as_of: the earliest non-terminal lease
  // starting at or after it ends, that does NOT overlap it (an overlapping
  // lease is a conflict, not a succession).
  const governing = current || activationPending || null;
  let successor = { state: "none", lease_id: null, proof_basis: null, locked: false };
  if (governing && governing.end_date) {
    const next = leases
      .filter((l) => l.id !== governing.id
        && l.start_date && String(l.start_date) >= String(governing.end_date)
        && !rangesOverlap(l, governing))
      .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))[0] || null;
    if (next) {
      // LOCKED uses the SAME governed rule as everywhere else: executed AND
      // funded. A 'pending' lease_status alone never closes the position.
      const locked = !!(next.executed_verified && next.move_in_funds_cleared);
      successor = { state: locked ? "locked" : "pending", lease_id: next.id, proof_basis: proofBasis(next), locked };
    }
  }

  return {
    space_id: row.space_id,
    unit_id: row.unit_id,
    unit_number: row.unit_number,
    space_label: row.space_label,
    current_lease_position: shapeLease(current),
    activation_pending_lease_position: shapeLease(activationPending),
    future_lease_position: shapeLease(future),
    current_possession: possessed ? {
      since: lastIn.effective_date,
      event_recorded_at: lastIn.created_at,
      source: lastIn.source || null,
      details: lastIn.payload || {},
    } : null,
    economic_tenancy_state: current ? "active" : activationPending ? "activation_pending" : future ? "forward" : "none",
    possession_state: possessed ? "delivered" : "pending",
    physical_readiness: turning ? "turning" : "ready",
    availability_state,
    available_from,
    reason,
    next_required_action,
    notice_state: row.notice_date ? "on_notice" : "none",
    notice_date: row.notice_date || null,
    conflict_state: conflict_ids.length ? "conflicted" : "clear",
    conflicting_lease_ids: conflict_ids,
    successor,
    _compat_occupancy: row.compat_occupancy,
  };
}

module.exports = {
  classifyPosition,
  // shared vocabulary, exported so no caller redefines it
  TERMINAL_LEASE_STATUSES,
  CURRENT_ECONOMIC_STATUSES,
  leaseIsValid,
  datesSpan,
  isFuture,
  normalizedStatus,
  rangesOverlap,
  proofBasis,
  tenantList,
};
