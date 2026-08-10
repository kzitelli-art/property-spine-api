/* ════════════════════════════════════════════════════════════════════
   maintenance/not_done_reasons.js — WHY WORK STOPPED, AND WHERE IT GOES.

   ── EXTRACTED, NOT COPIED ───────────────────────────────────────────
   This map used to live inside maintenance.js's module closure, where it
   had exactly one reader: the route that writes a not-done. The Work
   Orders read surface now has to say "Waiting on a part" on a board row,
   and it cannot see a closure. The two ways out were to export it or to
   restate the labels in the reader — and restating them is how a preview
   and a write come to disagree, which this repo has already paid for once
   (see the category engine's note in maintenance.js: "Imported, never
   redefined").

   §17 — ONE definition, two readers: the writer that routes a stall, and
   the reader that describes one. If they ever disagree, an operator sees a
   reason on the board that routed somewhere else.

   ── WHAT A TECHNICIAN CHOOSES, AND WHAT SPINE DECIDES ───────────────
   The person in the unit reports ONE fact: what is stopping completion.
   They are not choosing a workflow, an owner, or an escalation path — they
   could not know them, and asking would make them learn the system. Every
   column but `label` is Spine's consequence, derived from their fact:

     label            the only thing the reporter ever sees
     follow_type      the obligation type spawned for the next step
     follow_role      who owns that next step (an org-chart role)
     escalates_to     where it escalates if that owner does not move
     follow_label(wo) the human sentence that owner reads

   THE ROUTING IS WHY THIS MAP MAY NOT BE COLLAPSED. `bigger_job` and
   `second_visit` both sound like "more work required" and go to different
   people — a property manager re-scopes, maintenance simply returns.
   Merging the KEYS would silently hand one of those to the wrong role, and
   nobody would see it happen.

   WHICH IS NOT THE SAME AS OFFERING ALL SEVEN TO A TECHNICIAN. The field
   vocabulary below is a PROJECTION of this map: five plain answers, each of
   which is one of these canonical keys. Nothing is merged, nothing is
   invented, and history keeps its full resolution — a `bigger_job` row
   written last year still says `bigger_job` and still routes to the property
   manager. What changed is only which of them we ask a person to pick from,
   because choosing between "bigger job" and "needs PM approval" is asking
   somebody holding a wrench to predict our workflow.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const NOT_DONE_REASONS = {
  need_part: {
    label: "Waiting on a part",
    follow_type: "supply_followup",
    follow_role: "maintenance",
    escalates_to: "property_manager",
    follow_label: (wo) => `Part needed to finish: ${wo.title || "work order"} — order / track the part`,
  },
  need_vendor: {
    label: "Needs an outside vendor",
    follow_type: "vendor_quote",
    follow_role: "property_manager",
    escalates_to: "owner",
    follow_label: (wo) => `Outside vendor needed for: ${wo.title || "work order"} — get quote / schedule`,
  },
  no_access: {
    label: "Couldn't get access to the unit",
    follow_type: "reschedule_access",
    follow_role: "maintenance",
    escalates_to: "property_manager",
    follow_label: (wo) => `No access — reschedule a return visit for: ${wo.title || "work order"}`,
  },
  needs_approval: {
    label: "Needs PM approval to proceed",
    follow_type: "approval_followup",
    follow_role: "property_manager",
    escalates_to: "owner",
    follow_label: (wo) => `Approval needed before finishing: ${wo.title || "work order"}`,
  },
  bigger_job: {
    label: "Bigger job than expected",
    follow_type: "scope_review",
    follow_role: "property_manager",
    escalates_to: "owner",
    follow_label: (wo) => `Re-scope — larger than expected: ${wo.title || "work order"}`,
  },
  second_visit: {
    label: "Partly done — needs a second visit",
    follow_type: "return_visit",
    follow_role: "maintenance",
    escalates_to: "property_manager",
    follow_label: (wo) => `Return visit to finish: ${wo.title || "work order"}`,
  },
  other: {
    label: "Other (PM to review)",
    follow_type: "not_done_followup",
    follow_role: "property_manager",
    escalates_to: "owner",
    follow_label: (wo) => `Stalled — PM to review: ${wo.title || "work order"}`,
  },
};

/*  The obligation types a not-done can spawn. The read surface uses this to
 *  tell a ROUTED FOLLOW-UP apart from the work order's own accountability
 *  obligation — both are `related_type = 'work_order'` on the same row, and
 *  ordering by created_at only happens to separate them today. Derived from
 *  the map rather than restated, so a new reason cannot be added without the
 *  reader learning about it. */
const FOLLOW_UP_TYPES = Object.freeze(
  Object.values(NOT_DONE_REASONS).map((r) => r.follow_type));

/*  ── WHAT THE FIELD IS ASKED, vs WHAT SPINE STORES ─────────────────
 *
 *  The person standing in the unit answers one question — "what is stopping
 *  completion?" — and the honest set of answers to that question is short.
 *  The seven keys above are Spine's ROUTING vocabulary, and several of them
 *  are distinctions only somebody who knows our schema would draw.
 *
 *  So the field sees five choices, and each one IS a canonical key. Nothing
 *  is translated on the way in, no new key is invented, and history keeps its
 *  full meaning: a row written years ago as `bigger_job` still says
 *  `bigger_job`, and still routes the way it always did.
 *
 *      Need a part           → need_part
 *      Need access           → no_access
 *      More work required    → second_visit
 *      Vendor needed         → need_vendor
 *      Something else        → other
 *
 *  ⚠ ONE JUDGEMENT CALL WORTH REVISITING. "More work required" could route
 *  to `second_visit` (maintenance returns) or `bigger_job` (the property
 *  manager re-scopes). It is mapped to `second_visit` — a return visit keeps
 *  the work inside maintenance and is the lower-ceremony reading of what a
 *  technician means by "there is more here". If the intended meaning is
 *  usually "this needs re-scoping and approval", change this ONE line.
 *
 *  `bigger_job` and `needs_approval` remain canonical, routable, and reachable
 *  through the legacy closeout path. They are simply not offered in the field,
 *  because asking a technician to choose between "bigger job" and "needs PM
 *  approval" is asking them to predict our workflow.
 */
const FIELD_REASON_KEYS = ["need_part", "no_access", "second_visit", "need_vendor", "other"];
const FIELD_LABELS = {
  need_part:    "Need a part",
  no_access:    "Need access",
  second_visit: "More work required",
  need_vendor:  "Vendor needed",
  other:        "Something else",
};

/*  What the OPERATOR surface may show. Key + label only: the routing is
 *  Spine's decision and travels nowhere near the browser, so a client cannot
 *  select a consequence — only report a fact. */
function fieldReasonChoices() {
  return FIELD_REASON_KEYS.map((key) => ({ key, label: FIELD_LABELS[key] }));
}

/*  The FULL routing vocabulary, for the legacy closeout consumer. Unchanged
 *  on purpose: the shared operator key is held outside this repo, so absence
 *  of a caller here is not absence of a caller, and narrowing what that route
 *  returns could silently remove a choice somebody is using. */
function reasonChoices() {
  return Object.entries(NOT_DONE_REASONS).map(([key, v]) => ({ key, label: v.label }));
}

/*  §5 — an unrecognised key is REFUSED, never coerced to `other`. A reason we
 *  cannot route is a stall with no named next step, which is the one outcome
 *  the continuity engine exists to prevent. */
function routeFor(key) {
  return Object.prototype.hasOwnProperty.call(NOT_DONE_REASONS, key)
    ? NOT_DONE_REASONS[key] : null;
}

function labelFor(key) {
  const r = routeFor(key);
  return r ? r.label : null;
}

/*  follow_type → the reason that produced it. The read surface describes a
 *  SPECIFIC open follow-up, and `work_orders.not_done_reason` holds only the
 *  latest key — so a work order stalled twice would have its older follow-up
 *  described with the newer reason. Reversing the routing table answers it
 *  from the obligation actually being described.
 *
 *  Built from the same map, so a new reason cannot appear without this
 *  learning it. Null when a follow_type is not one of ours. */
const BY_FOLLOW_TYPE = Object.freeze(Object.entries(NOT_DONE_REASONS).reduce(
  (acc, [key, v]) => { acc[v.follow_type] = { key, label: v.label }; return acc; }, {}));

function reasonForFollowType(type) {
  return Object.prototype.hasOwnProperty.call(BY_FOLLOW_TYPE, type)
    ? BY_FOLLOW_TYPE[type] : null;
}

module.exports = {
  NOT_DONE_REASONS, FOLLOW_UP_TYPES, reasonChoices, fieldReasonChoices, routeFor, labelFor,
  reasonForFollowType,
};
