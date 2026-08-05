/* ════════════════════════════════════════════════════════════════════
   conversation/work_reference.js — WHICH WORK DID THEY MEAN?

   The fourth shared conversational seam. Pure: it requires nothing,
   queries nothing, and holds no candidate set of its own.

   ── THE ONE RULE ────────────────────────────────────────────────────

   A MESSAGE MAY NEVER ESTABLISH ITS OWN ACTOR OR PROPERTY MERELY BY
   ASSERTING ONE.

   Text can NAME a work order. Naming is a request. Whether that work
   order is the sender's, at a property they operate, in a state that can
   be acted on, is decided against server-derived rows — and this module
   is handed those rows already scoped. It cannot widen them because it
   cannot fetch them.

   So `extractReference` reads an identifier out of text and returns a
   CLAIM, explicitly labelled as unverified. `resolveWorkReference` turns
   a claim into a selection only by finding it inside the authorized set.
   The two are separate functions so that no caller can accidentally treat
   the first as the second.

   ── THE THREE NARROW SOURCES (owner ruling 2026-08-04) ──────────────

     1. explicit    an identifier the technician typed
     2. thread      exactly one active work order already in this thread
     3. assignment  exactly one uniquely eligible assignment

   Tried in that order and STOPPED at the first that produces exactly one.
   Zero matches or several authorized matches produce a narrow
   clarification — never a pick, and never a list of work the sender is
   not authorized to see.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const REFERENCE_SOURCES = ["explicit", "thread", "assignment"];

const RESOLUTION_OUTCOMES = [
  "one",                     // exactly one, authorized
  "none_authorized",         // this technician has no actionable work at all
  "unresolved_claim",        // they named something that is not in their authorized set
  "ambiguous",               // several authorized candidates and nothing distinguishes them
  "no_reference",            // nothing named, nothing uniquely inferable
];

/*  A short work-order reference as a human types it. Deliberately narrow:
 *  a bare number of 2–8 digits, optionally prefixed. Anything longer is a
 *  phone number, a date or a unit; anything shorter is noise. A full uuid
 *  is accepted because a machine-generated reply may quote one back. */
const SHORT_REF_RX = /(?:\b(?:wo|work\s*order|ticket|job)\s*#?\s*|#)(\d{2,8})\b/i;
const BARE_NUMBER_RX = /^\s*#?(\d{2,8})\s*$/;
/*  A standalone number of 3–8 digits anywhere in the message.
 *
 *  DEFECT FIXED 2026-08-04, caught by the route proof: without this,
 *  "accept 1042" — the single most likely thing a technician types —
 *  extracted NOTHING, and the turn fell through to the assignment source.
 *  With exactly one open item that silently produced the right answer, so
 *  the first run of the route proof was green for the wrong reason.
 *
 *  THREE digits, not two, and that bound is not arbitrary: migration 133
 *  starts work_order_ref_seq at 1000, so no reference is ever shorter than
 *  four digits, while counts people actually write in a sentence ("3 units
 *  affected", "2 hours") are one or two. The schema is what makes the
 *  looser match safe.
 *
 *  And when it matches something that is not a reference, the answer is a
 *  CLARIFICATION — resolveWorkReference only ever selects from the
 *  authorized set, so a spurious claim fails toward asking, never toward
 *  acting on the wrong work. */
const LOOSE_NUMBER_RX = /(?:^|[^\d/-])(\d{3,8})(?![\d/-])/;
const UUID_RX = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

class WorkReferenceError extends Error {
  constructor(message, code) { super(message); this.name = "WorkReferenceError"; this.code = code; }
}

/*  ── STEP 1: WHAT THE TEXT CLAIMS ───────────────────────────────────
 *  Returns a CLAIM, never a selection. `verified` is false and stays
 *  false — this function has nothing to verify against.
 */
function extractReference(text) {
  const s = typeof text === "string" ? text : "";
  const uuid = s.match(UUID_RX);
  if (uuid) return Object.freeze({ kind: "uuid", value: uuid[1].toLowerCase(), verified: false });

  const tagged = s.match(SHORT_REF_RX);
  if (tagged) return Object.freeze({ kind: "short_ref", value: tagged[1], verified: false });

  const bare = s.match(BARE_NUMBER_RX);
  if (bare) return Object.freeze({ kind: "short_ref", value: bare[1], verified: false });

  const loose = s.match(LOOSE_NUMBER_RX);
  if (loose) return Object.freeze({ kind: "short_ref", value: loose[1], verified: false });

  return null;
}

/*  ── STEP 2: WHAT THE AUTHORIZED SET ALLOWS ─────────────────────────
 *
 *  `authorized` is the set the caller already scoped to this actor —
 *  offerableWork's output, nothing wider. Each row must carry
 *  work_order_id, obligation_id, property_id and, for short references,
 *  work_order_ref.
 *
 *  `threadWorkOrderIds` are the work orders already active in THIS
 *  conversation. They still have to appear in `authorized` to be
 *  selectable: being discussed in a thread is not authority.
 */
function resolveWorkReference({ authorized, claim = null, threadWorkOrderIds = [] } = {}) {
  if (!Array.isArray(authorized)) {
    throw new WorkReferenceError(
      "authorized must be an array of already-scoped rows — an unreadable set is not an empty one",
      "authorized_not_an_array");
  }
  if (!Array.isArray(threadWorkOrderIds)) {
    throw new WorkReferenceError("threadWorkOrderIds must be an array", "thread_not_an_array");
  }
  if (claim && claim.verified === true) {
    throw new WorkReferenceError(
      "a claim arriving pre-verified is a message asserting its own authority — refused",
      "claim_asserts_verification");
  }

  if (authorized.length === 0) {
    return Object.freeze({ outcome: "none_authorized", selected: null, source: null, candidates: 0 });
  }

  //  1. EXPLICIT. What they typed, matched only inside the authorized set.
  if (claim) {
    const matches = authorized.filter((r) =>
      (claim.kind === "uuid"
        ? String(r.work_order_id).toLowerCase() === claim.value || String(r.obligation_id).toLowerCase() === claim.value
        : String(r.work_order_ref == null ? "" : r.work_order_ref) === String(claim.value)));

    if (matches.length === 1) {
      return Object.freeze({ outcome: "one", selected: matches[0], source: "explicit", candidates: 1 });
    }
    if (matches.length > 1) {
      return Object.freeze({ outcome: "ambiguous", selected: null, source: "explicit", candidates: matches.length });
    }
    //  Named something that is not theirs — or not real. Both get the same
    //  answer, and neither is "you have no work". Falling through to the
    //  thread or assignment source here would act on work they did not name.
    return Object.freeze({ outcome: "unresolved_claim", selected: null, source: "explicit", candidates: 0 });
  }

  //  2. THREAD. Exactly one active work order already in this conversation,
  //     AND authorized. Being discussed is not authority.
  const inThread = authorized.filter((r) => threadWorkOrderIds.includes(r.work_order_id));
  if (inThread.length === 1) {
    return Object.freeze({ outcome: "one", selected: inThread[0], source: "thread", candidates: 1 });
  }
  if (inThread.length > 1) {
    return Object.freeze({ outcome: "ambiguous", selected: null, source: "thread", candidates: inThread.length });
  }

  //  3. ASSIGNMENT. Exactly one uniquely eligible assignment.
  if (authorized.length === 1) {
    return Object.freeze({ outcome: "one", selected: authorized[0], source: "assignment", candidates: 1 });
  }
  return Object.freeze({ outcome: "ambiguous", selected: null, source: "assignment", candidates: authorized.length });
}

/*  ── THE NARROW CLARIFICATION ───────────────────────────────────────
 *  It never lists work the sender is not authorized to see, and it never
 *  invites them to name something outside their own set. `options` is
 *  drawn only from `authorized`, and only when naming them is the actual
 *  question.
 */
function clarificationForReference(resolution, authorized = []) {
  if (!resolution || resolution.outcome === "one") return null;

  if (resolution.outcome === "none_authorized") {
    return Object.freeze({
      reason: "no_authorized_work",
      question: "I don't see any work assigned to you right now. Your manager can assign it.",
      options: Object.freeze([]),
    });
  }
  if (resolution.outcome === "unresolved_claim") {
    return Object.freeze({
      reason: "reference_not_authorized",
      question: "I can't match that to work assigned to you. Which one did you mean?",
      options: Object.freeze(authorized.map(refOption)),
    });
  }
  return Object.freeze({
    reason: resolution.outcome === "ambiguous" ? "work_reference_ambiguous" : "work_reference_absent",
    question: "Which work order is this about?",
    options: Object.freeze(authorized.map(refOption)),
  });
}

//  Only what the technician already has authority over, and only what
//  identifies it. No resident name, no unit, no description.
const refOption = (r) => Object.freeze({
  work_order_id: r.work_order_id,
  work_order_ref: r.work_order_ref == null ? null : String(r.work_order_ref),
  title: r.title || null,
});

module.exports = {
  REFERENCE_SOURCES,
  RESOLUTION_OUTCOMES,
  WorkReferenceError,
  extractReference,
  resolveWorkReference,
  clarificationForReference,
};
