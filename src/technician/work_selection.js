/* ════════════════════════════════════════════════════════════════════
   technician/work_selection.js — WHAT WORK MAY BE OFFERED, SELECTED AND
   ACCEPTED. Pure. No database, no transport, no model.

   Phase 2, milestone 1: an authenticated technician on an operations line
   asks for their assigned actionable work, names ONE of it, and accepts
   it. This module makes every one of those decisions and performs none of
   them.

   ── WHY IT IS PURE ──────────────────────────────────────────────────

   Because every decision here is a refusal waiting to happen, and a
   refusal that can only be exercised against a provisioned database is a
   refusal nobody has ever seen fire. These decisions are proven
   exhaustively over rows, today, with no credentials.

   The caller fetches rows under an explicit scope; this module VERIFIES
   them and never widens them. It cannot fetch a property, a user, an
   assignment or an obligation, so it cannot quietly acquire one.

   ── THE THREE THINGS IT MAY NEVER DO ────────────────────────────────

   · Derive the actor's scope. `actor.assignedPropertyIds` is supplied by
     the caller from the actor's OWN assignments (communication_lines.js
     resolvePropertyContextForStaff is the canonical derivation). This
     module checks membership. An empty scope offers nothing — it never
     falls back to the organization's property list.

   · Choose work the technician did not name. One offerable item is not
     evidence that they meant that one. This is the same rule that stops
     an organization number choosing a building: the shortcut is right
     until the second row exists, and then it silently acts on the wrong
     work. An explicit reference is required, always.

   · Turn a stale row into a successful action. Eligibility is decided
     against the row as read; the canonical service re-decides against the
     row as LOCKED. Both call this same function, so the offer a
     technician saw and the write that follows it cannot disagree.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  Why a candidate is not offerable. Each is a distinct repair. */
const INELIGIBILITY = [
  "not_assigned_to_actor",         // somebody else's obligation
  "property_outside_actor_scope",  // a building this technician does not work at
  "not_work_order_related",        // an obligation about something else entirely
  "not_actionable_status",         // complete or escalated — nothing to take on
];

/*  Why an acceptance is refused, or why it is a no-op. */
const ACCEPTANCE_VERDICTS = [
  "eligible",
  "already_accepted_by_actor",     // NOT an error: the same person, again
  "already_accepted_by_another",   // a genuine conflict
  "not_open",                      // in flight or finished, without an acceptance record
  "not_assigned_to_actor",
  "property_outside_actor_scope",
  "not_work_order_related",
];

const SELECTION_OUTCOMES = [
  "one",                     // exactly one, explicitly named
  "none_offerable",          // there is no assigned actionable work at all
  "no_reference",            // work exists; the technician named none of it
  "reference_not_offerable", // they named something that is not theirs to take
  "ambiguous_reference",     // what they named matches more than one
];

class WorkSelectionError extends Error {
  constructor(message, code) { super(message); this.name = "WorkSelectionError"; this.code = code; }
}

/*  The actor is server-derived in full or not accepted at all. A partial
 *  actor is the shape that lets an unscoped read look like a scoped one. */
function assertActor(actor) {
  if (!actor || typeof actor !== "object") {
    throw new WorkSelectionError("actor is required — work is never selected without a resolved actor", "actor_missing");
  }
  if (!actor.userId) throw new WorkSelectionError("actor.userId is required", "actor_missing");
  if (!actor.organizationId) {
    throw new WorkSelectionError(
      "actor.organizationId is required — the line established the organization and the scope must state it",
      "actor_organization_missing");
  }
  if (!Array.isArray(actor.assignedPropertyIds)) {
    throw new WorkSelectionError(
      "actor.assignedPropertyIds must be an array derived from the actor's OWN assignments — an absent scope is not an open scope",
      "actor_scope_missing");
  }
}

function ineligibilityOf(actor, row) {
  if (!row || typeof row !== "object") {
    throw new WorkSelectionError("candidate row is not an object", "row_malformed");
  }
  if (!row.obligation_id) throw new WorkSelectionError("candidate row has no obligation_id", "row_malformed");
  if (row.related_type !== "work_order" || !row.work_order_id) return "not_work_order_related";
  if (row.assigned_user_id !== actor.userId) return "not_assigned_to_actor";
  //  Cross-property refusal. Scope membership, not organization membership:
  //  belonging to the same company is not authority over every building in it.
  if (!actor.assignedPropertyIds.includes(row.property_id)) return "property_outside_actor_scope";
  if (row.status !== "open" && row.status !== "in_progress") return "not_actionable_status";
  return null;
}

/*  ── WHAT MAY BE OFFERED ────────────────────────────────────────────
 *  Every candidate is classified. Nothing is dropped silently: a row that
 *  is not offerable appears in `refused` with the reason, so a caller can
 *  say why a technician's work is not showing rather than showing nothing.
 */
function offerableWork({ actor, candidates } = {}) {
  assertActor(actor);
  if (!Array.isArray(candidates)) {
    throw new WorkSelectionError(
      "candidates must be an array — an unreadable candidate set is not an empty one", "candidates_not_an_array");
  }

  const offerable = [], refused = [];
  for (const row of candidates) {
    const reason = ineligibilityOf(actor, row);
    if (reason) refused.push(Object.freeze({ obligation_id: row && row.obligation_id, reason }));
    else offerable.push(row);
  }
  return Object.freeze({
    offerable: Object.freeze(offerable.slice()),
    refused: Object.freeze(refused),
    // Stated separately from `offerable.length === 0`: "you have nothing" and
    // "you have things, none of which you may take" are different answers.
    hasCandidatesButNoneOfferable: candidates.length > 0 && offerable.length === 0,
  });
}

/*  ── WHAT THE TECHNICIAN NAMED ──────────────────────────────────────
 *  `reference` is what their message picked out, already extracted by the
 *  caller: { workOrderId } or { obligationId }. Nothing else selects.
 *
 *  There is deliberately NO ordinal reference ("the first one") and NO
 *  single-item shortcut. An ordinal depends on a list this module never
 *  sent and cannot prove the technician saw; a shortcut acts on work
 *  nobody named. Both are how the wrong work order gets accepted.
 */
function selectReferencedWork({ offerable, reference } = {}) {
  if (!Array.isArray(offerable)) {
    throw new WorkSelectionError("offerable must be an array", "offerable_not_an_array");
  }
  if (offerable.length === 0) {
    return Object.freeze({ outcome: "none_offerable", selected: null, matches: 0 });
  }

  const woId = reference && reference.workOrderId;
  const obId = reference && reference.obligationId;
  if (!woId && !obId) {
    return Object.freeze({ outcome: "no_reference", selected: null, matches: 0 });
  }
  if (woId && obId) {
    throw new WorkSelectionError(
      "a reference names a work order OR an obligation, never both — two names are two selections",
      "ambiguous_reference_shape");
  }

  const matches = offerable.filter((r) => (woId ? r.work_order_id === woId : r.obligation_id === obId));
  if (matches.length === 1) return Object.freeze({ outcome: "one", selected: matches[0], matches: 1 });
  if (matches.length > 1) {
    return Object.freeze({ outcome: "ambiguous_reference", selected: null, matches: matches.length });
  }
  //  Named something real, but not theirs to take — or not real at all. Both
  //  are the same answer to the technician and neither is "you have no work".
  return Object.freeze({ outcome: "reference_not_offerable", selected: null, matches: 0 });
}

/*  ── MAY THIS BE ACCEPTED ───────────────────────────────────────────
 *  Decided against the row as supplied. The canonical service calls this
 *  again against the row as LOCKED, so a row that changed between the
 *  offer and the write is refused there rather than half-applied.
 *
 *  `already_accepted_by_actor` is a VERDICT, not an error: the same
 *  technician accepting the same work again has changed nothing, and
 *  saying so is the honest answer to a redelivered message.
 */
function acceptanceEligibility({ actor, row } = {}) {
  assertActor(actor);
  const structural = ineligibilityOf(actor, row);
  if (structural && structural !== "not_actionable_status") {
    return Object.freeze({ verdict: structural, eligible: false, isNoop: false });
  }

  if (row.accepted_by_user_id) {
    const mine = row.accepted_by_user_id === actor.userId;
    return Object.freeze({
      verdict: mine ? "already_accepted_by_actor" : "already_accepted_by_another",
      eligible: false,
      isNoop: mine,          // nothing to do, and nothing wrong
    });
  }
  if (row.status !== "open") {
    return Object.freeze({ verdict: "not_open", eligible: false, isNoop: false });
  }
  return Object.freeze({ verdict: "eligible", eligible: true, isNoop: false });
}

module.exports = {
  INELIGIBILITY,
  ACCEPTANCE_VERDICTS,
  SELECTION_OUTCOMES,
  WorkSelectionError,
  offerableWork,
  selectReferencedWork,
  acceptanceEligibility,
};
