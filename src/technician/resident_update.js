/* ════════════════════════════════════════════════════════════════════
   technician/resident_update.js — WHAT THE RESIDENT MAY BE TOLD.

   Pure. Requires nothing, queries nothing, sends nothing.

   ── THE RULE THIS FILE EXISTS FOR ───────────────────────────────────

   A TECHNICIAN'S WORDS NEVER REACH A RESIDENT.

   The technician thread and the resident thread are different
   conversations with different audiences. A resident update is DERIVED
   from a committed canonical fact — never forwarded, never quoted, never
   paraphrased from what somebody typed.

   That is why this module takes a `progressKind` and a work order, and
   deliberately does NOT accept the technician's note. There is no
   parameter through which their language could travel, so "we forwarded
   the raw text" is not a mistake that can be made here.

   ── WHICH FACTS ARE RESIDENT-SAFE ───────────────────────────────────

     en_route     yes — someone is coming, which is what they want to know
     no_access    yes — and it asks them to coordinate entry
     completed    yes — ONLY after governed completion, never on a claim
     blocked      NO by default — internal until explicitly classified
     finding      NO by default — internal until explicitly classified

   `completion_claimed` is absent from that list on purpose. "The repair
   has been completed" is allowed only after the completion service closed
   the work order, not because a technician typed "finished".
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  The frozen set. A kind that is not here produces NOTHING — the default
 *  for anything new is internal, so adding a field verb later cannot
 *  accidentally start texting residents. */
const RESIDENT_SAFE_KINDS = ["en_route", "no_access", "completed"];

const INTERNAL_BY_DEFAULT = ["blocked", "finding", "completion_claimed"];

class ResidentUpdateError extends Error {
  constructor(message, code) { super(message); this.name = "ResidentUpdateError"; this.code = code; }
}

/*  What the resident is told, per fact. Verified, appropriate, and about
 *  the work — never about the technician's difficulties, their route, or
 *  anything they observed. `label` is the work order's own subject line,
 *  which the property wrote, not the technician.
 */
function residentTextFor({ progressKind, subject = null } = {}) {
  const about = subject ? ` for the ${subject}` : "";
  switch (progressKind) {
    case "en_route":
      return `Your technician is on the way${about}.`;
    case "no_access":
      return "The technician could not access the unit. Please reply with the best way to coordinate entry.";
    case "completed":
      return "The repair has been completed.";
    default:
      return null;
  }
}

/*  deriveResidentUpdate — a resident-facing intent, or an explicit refusal
 *  to produce one.
 *
 *  `committed` must be the canonical fact that ALREADY happened: a
 *  work_order_progress row. Requiring the row rather than a kind string is
 *  what stops a resident update being composed from an intention.
 */
function deriveResidentUpdate({ committed, workOrder, recipientPersonId = null } = {}) {
  if (!committed || !committed.id || !committed.kind) {
    throw new ResidentUpdateError(
      "a resident update is derived from a COMMITTED field fact — there is no path from an intention",
      "no_committed_fact");
  }
  if (!workOrder || !workOrder.id || !workOrder.property_id) {
    throw new ResidentUpdateError("the work order is required to scope a resident update", "no_work_order");
  }

  if (!RESIDENT_SAFE_KINDS.includes(committed.kind)) {
    return Object.freeze({
      send: false,
      reason: INTERNAL_BY_DEFAULT.includes(committed.kind) ? "internal_by_default" : "not_resident_safe",
      text: null, propertyId: workOrder.property_id, personId: null, derivedFromProgressId: committed.id,
    });
  }

  //  "The repair has been completed" requires the work order to actually
  //  BE complete. A `completed` progress row is written only by the
  //  governed service, and this checks the row it points at anyway —
  //  two independent reasons, neither relying on the other.
  if (committed.kind === "completed" && workOrder.status !== "complete") {
    return Object.freeze({
      send: false, reason: "completion_not_governed", text: null,
      propertyId: workOrder.property_id, personId: null, derivedFromProgressId: committed.id,
    });
  }

  //  Nobody to tell. An honest blank, not an error: plenty of work orders
  //  have no affected resident (a boiler, a roof, a parking gate).
  if (!recipientPersonId) {
    return Object.freeze({
      send: false, reason: "no_resident_to_notify", text: null,
      propertyId: workOrder.property_id, personId: null, derivedFromProgressId: committed.id,
    });
  }

  const text = residentTextFor({ progressKind: committed.kind, subject: subjectOf(workOrder) });
  if (!text) {
    return Object.freeze({
      send: false, reason: "no_resident_safe_wording", text: null,
      propertyId: workOrder.property_id, personId: null, derivedFromProgressId: committed.id,
    });
  }

  return Object.freeze({
    send: true, reason: null, text,
    propertyId: workOrder.property_id,
    personId: recipientPersonId,
    derivedFromProgressId: committed.id,
  });
}

/*  The work order's own subject, lightly normalised. Taken from the title
 *  the PROPERTY recorded when the request was opened — which came from the
 *  resident's own report — never from anything a technician typed. */
function subjectOf(workOrder) {
  const t = (workOrder && workOrder.title) || "";
  const cleaned = String(t).replace(/^EMERGENCY:\s*/i, "").trim();
  if (!cleaned || cleaned.length > 60) return null;
  return cleaned.toLowerCase();
}

module.exports = {
  RESIDENT_SAFE_KINDS, INTERNAL_BY_DEFAULT,
  ResidentUpdateError,
  deriveResidentUpdate, residentTextFor, subjectOf,
};
