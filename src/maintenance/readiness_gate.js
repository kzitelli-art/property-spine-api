// ════════════════════════════════════════════════════════════════════
//  readiness_gate.js — MAY THE FINAL WALK HAPPEN, AND WHAT BLOCKS IT
//
//  Class 1, permanent product primitive. PURE: no database, no I/O, no clock.
//
//  ── ONE RULE, STATED TWICE BECAUSE IT IS THE WHOLE BUILD ────────────
//
//      THE ABSENCE OF OPEN WORK IS NOT READINESS.
//
//  This module decides whether the final walk may BEGIN. It never decides
//  readiness. Passing every check here means "a human may now go and look" —
//  nothing more. `ready` comes from a certification a named person signed,
//  and there is no code path in this file that can produce it.
//
//  ── AND IT NAMES THE EXACT BLOCKER ──────────────────────────────────
//  "Not yet" is useless to an operator standing in a hallway. Every refusal
//  carries the specific thing in the way and, where it exists, the item.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { STAGE } = require("./turn_sequence");

/**
 * readinessGate — PURE. Can the final readiness walk start?
 *
 * @param {object} scope        latest non-superseded unit_turn_scopes row
 * @param {Array}  work         all unit_triage_required_work rows for the unit
 * @param {Array}  claims       work_completion_claims rows for the unit
 * @param {Array}  certifications live (non-superseded) certifications
 */
function readinessGate({ scope = null, work = [], claims = [], certifications = [] } = {}) {
  const blockers = [];

  // 1. a confirmed turn scope must exist
  if (!scope) {
    blockers.push({
      code: "no_turn_scope",
      detail: "No turn scope has been confirmed for this unit. There is nothing to walk against.",
      items: [],
    });
  }

  // 2. the turn-scope inspection must be COMPLETE
  if (scope && scope.inspection_completeness !== "complete_turn_scope") {
    blockers.push({
      code: "inspection_incomplete",
      detail: "The turn-scope inspection is partial. Unknown scope remains, so nobody can confirm the unit is acceptable.",
      items: [],
    });
  }

  // 3. no consequential scope item left unstaged or unresolved
  const unplaced = work.filter(
    (w) => w.status === "required" && !w.stage &&
      (w.stage_decision_required === true ||
       (scope && scope.inspection_completeness === "complete_turn_scope")));
  if (unplaced.length) {
    blockers.push({
      code: "inherited_work_not_placed",
      detail: "Work inherited from an earlier capture was never placed in this turn. It must be staged, marked unknown and owed, or withdrawn with a reason.",
      items: unplaced.map((w) => w.work_text),
    });
  }

  // 4. ALL required work completed. This includes reopened work, which is
  //    back to `required` and therefore caught here — a reopened item is an
  //    active blocker, not history.
  const open = work.filter((w) => w.status === "required");
  if (open.length) {
    const reopened = open.filter((w) => w.reopened_count > 0);
    blockers.push({
      code: "work_outstanding",
      detail: reopened.length
        ? `${open.length} item${open.length === 1 ? "" : "s"} still open, including ${reopened.length} that ${reopened.length === 1 ? "was" : "were"} reopened.`
        : `${open.length} required item${open.length === 1 ? "" : "s"} still open.`,
      items: open.map((w) => w.work_text),
    });
  }

  // 5. required proof satisfied for everything claimed complete.
  //    A completed item whose LATEST claim fell short of proof is a completion
  //    somebody asserted and nobody evidenced. It must not pass this gate on
  //    the strength of a status column.
  const byWork = new Map();
  for (const c of claims) {
    const k = String(c.work_id);
    const prev = byWork.get(k);
    if (!prev || new Date(c.created_at) >= new Date(prev.created_at)) byWork.set(k, c);
  }
  const unproven = work.filter((w) => {
    if (w.status !== "complete") return false;
    const c = byWork.get(String(w.id));
    return !c || c.proof_satisfied !== true;
  });
  if (unproven.length) {
    blockers.push({
      code: "proof_unsatisfied",
      detail: "Work is marked complete without satisfied proof.",
      items: unproven.map((w) => w.work_text),
    });
  }

  // 6. final cleaning completed AND proven. Called out separately from
  //    'work_outstanding' because it is the last physical step and an operator
  //    reading "1 item open" deserves to know it is the clean.
  const cleans = work.filter((w) => w.stage === STAGE.FINAL_CLEAN);
  const openCleans = cleans.filter((w) => w.status === "required");
  if (openCleans.length) {
    blockers.push({
      code: "final_cleaning_outstanding",
      detail: "Final cleaning is not complete.",
      items: openCleans.map((w) => w.work_text),
    });
  }

  // 7. an existing live certification means the walk already happened
  const live = certifications.filter((c) => c.state === "ready" );
  if (live.length) {
    blockers.push({
      code: "already_certified",
      detail: "This unit already carries a live readiness certification. Correct or revoke it before walking again.",
      items: [],
    });
  }

  return {
    actionable: blockers.length === 0,
    blockers,
    // The single most-blocking thing, so a surface can say one sentence.
    controlling_blocker: blockers.length ? blockers[0] : null,
    // Said on every result, pass or fail. Passing this gate is permission to
    // look, and nothing else.
    meaning: blockers.length === 0
      ? "The final readiness walk may now be performed. This is NOT readiness — the unit becomes ready only when an authorized human certifies it."
      : "The final readiness walk cannot be performed yet.",
  };
}

// ── THE CONFIRMATION AREAS A `ready` WALK MUST AFFIRM ───────────────
//  Short on purpose. This is not a bureaucratic inspection form — it is the
//  set of things a manager would actually check before letting somebody move
//  in, and every one of them maps to a blocker a resident would notice.
//
//  `appliance_function_confirmed` is conditional: it applies only where the
//  unit has appliances requiring functional confirmation. A unit with none
//  cannot be held on a question that does not apply to it.
const CONFIRMATION_AREAS = Object.freeze([
  { key: "work_complete_confirmed", label: "All confirmed work appears complete", required: true },
  { key: "cleaning_acceptable_confirmed", label: "Final cleaning is acceptable", required: true },
  { key: "appliances_present_confirmed", label: "Required appliances are present", required: true },
  { key: "appliance_function_confirmed", label: "Essential appliance function confirmed", required: false,
    note: "Applies only where the unit has appliances needing functional confirmation." },
  { key: "no_repair_blocker_confirmed", label: "No known unresolved repair or essential-system blocker", required: true },
  { key: "keys_accounted_confirmed", label: "Required keys and access devices are accounted for", required: true },
  { key: "condition_acceptable_confirmed", label: "Unit is acceptable for the incoming resident", required: true },
  { key: "no_unknowns_confirmed", label: "No consequential condition remains unknown", required: true },
]);

const REQUIRED_FOR_READY = Object.freeze(
  CONFIRMATION_AREAS.filter((a) => a.required).map((a) => a.key));

/**
 * missingConfirmations — PURE. What a `ready` walk still has to affirm.
 * An unanswered area is NOT treated as affirmed; that is the whole point.
 */
function missingConfirmations(walk) {
  const w = walk || {};
  return CONFIRMATION_AREAS
    .filter((a) => a.required && w[a.key] !== true)
    .map((a) => ({ key: a.key, label: a.label }));
}

module.exports = { readinessGate, CONFIRMATION_AREAS, REQUIRED_FOR_READY, missingConfirmations };
