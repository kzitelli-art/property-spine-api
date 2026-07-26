// ════════════════════════════════════════════════════════════════════
//  TOUR OUTCOME — the vocabulary, and what each word makes happen.
//
//  Class 1, permanent product primitive. ONE definition, many readers
//  (capture surface, desk, Person Card, follow-up, later scoring). Pure:
//  no database, no I/O, no writes. Same shape as relationship_stage.js —
//  a resolver whose job is to stop four different surfaces inventing four
//  slightly different answers.
//
//  ── WHY THIS FILE EXISTS ─────────────────────────────────────────────
//  Live vocabulary before this: 'interested' 27, 'start_application' 5,
//  'keep_working' 1, null 7. `interested` is 82% of every recorded
//  outcome — not because 82% of tours went the same way, but because it
//  was the only word available for anything that was not a clear yes.
//
//  A word that swallows four distinct truths is the same defect as
//  merging consent with classification, or relationship owner with
//  obligation owner: things that usually coincide, collapsed into one
//  field, so the times they differ become invisible. That is where the
//  lie lives. Splitting it is not presentation — it is the difference
//  between a record you can act on and one you can only skim.
//
//  ── TWO QUESTIONS, NOT ONE ───────────────────────────────────────────
//  ATTENDANCE is what physically happened. STANDING is where the person
//  landed. They are different facts with different sources, and standing
//  only exists when a tour actually occurred. Asking "how did it go?"
//  about a no-show is how forms lose people's patience.
//
//  ── WHOSE JUDGMENT ───────────────────────────────────────────────────
//  Standing is the ONE thing only the agent knows. The AI was not in the
//  room; it did not see the face. It may prepare, propose, and pre-stage
//  everything around this answer, and it may never supply the answer
//  itself. `judgedBy` carries who decided, and 'agent' and 'ai' are never
//  interchangeable. A missing capture resolves to null — an honest blank,
//  never a neutral default that quietly reads as fine.
// ════════════════════════════════════════════════════════════════════

// ── STEP 1: what happened ────────────────────────────────────────────
const ATTENDANCE = Object.freeze({
  TOURED:      "toured",
  NO_SHOW:     "no_show",
  RESCHEDULED: "rescheduled",
  CANCELLED:   "cancelled",
});
const ATTENDANCE_VALUES = Object.freeze(Object.values(ATTENDANCE));

// Only a tour that HAPPENED has a standing to record.
const ATTENDANCE_HAS_STANDING = Object.freeze({
  [ATTENDANCE.TOURED]:      true,
  [ATTENDANCE.NO_SHOW]:     false,
  [ATTENDANCE.RESCHEDULED]: false,
  [ATTENDANCE.CANCELLED]:   false,
});

// ── STEP 2: where they left it ───────────────────────────────────────
//  Ordered strongest → weakest. The agent's single most valuable output.
const STANDING = Object.freeze({
  READY_TO_APPLY:     "ready_to_apply",
  HOT_LEAD:           "hot_lead",
  POSSIBLE:           "possible",
  NOT_MOVING_FORWARD: "not_moving_forward",
});
const STANDING_VALUES = Object.freeze(Object.values(STANDING));

const STANDING_LABEL = Object.freeze({
  [STANDING.READY_TO_APPLY]:     "Ready to Apply",
  [STANDING.HOT_LEAD]:           "Hot Lead",
  [STANDING.POSSIBLE]:           "Possible",
  [STANDING.NOT_MOVING_FORWARD]: "Not Moving Forward",
});

// What the agent is actually being asked, in their words. Kept here so the
// SMS prompt and the on-screen buttons cannot drift apart.
const STANDING_HELP = Object.freeze({
  [STANDING.READY_TO_APPLY]:     "They are ready for the application.",
  [STANDING.HOT_LEAD]:           "Strong opportunity. Actively deciding — good follow-up could win the lease.",
  [STANDING.POSSIBLE]:           "They may move forward, but something meaningful needs to change.",
  [STANDING.NOT_MOVING_FORWARD]: "Unlikely to become a lease.",
});

// ── WHO DECIDED ──────────────────────────────────────────────────────
//  Not decoration. 'agent' is a human who was present; 'ai' is a machine
//  that read a transcript. They are never merged, and the AI may never be
//  recorded as the source of a STANDING.
const JUDGED_BY = Object.freeze({ AGENT: "agent", AI: "ai" });

// ── WHAT EACH STANDING MAKES HAPPEN ──────────────────────────────────
//  The point of splitting the vocabulary. Each word routes somewhere
//  different — otherwise there was no reason to have four.
const NEXT_MOVE = Object.freeze({
  [STANDING.READY_TO_APPLY]: {
    key: "send_application",
    urgency: "now",
    summary: "Send the application today.",
    closes_lead: false,
  },
  [STANDING.HOT_LEAD]: {
    key: "follow_up_today",
    urgency: "today",
    summary: "Follow up today, while the tour is still fresh.",
    closes_lead: false,
  },
  [STANDING.POSSIBLE]: {
    key: "nurture_on_condition",
    urgency: "watch",
    summary: "Nurture. Watch for the thing that has to change.",
    closes_lead: false,
  },
  [STANDING.NOT_MOVING_FORWARD]: {
    key: "close_with_reason",
    urgency: "close",
    // A closed lead is not a failure to record — it is the only way the
    // funnel ever tells the truth about itself. `interested` at 82% is
    // partly the absence of any word for this.
    summary: "Close the lead and record why.",
    closes_lead: true,
  },
});

// Attendance that is not a tour still routes — just not through standing.
const ATTENDANCE_NEXT_MOVE = Object.freeze({
  [ATTENDANCE.NO_SHOW]:     { key: "no_show_recovery", urgency: "today",
                              summary: "Reach out — a no-show is not a no.", closes_lead: false },
  [ATTENDANCE.RESCHEDULED]: { key: "await_new_slot",   urgency: "watch",
                              summary: "Rebooked. Nothing owed until the new time.", closes_lead: false },
  [ATTENDANCE.CANCELLED]:   { key: "close_with_reason", urgency: "close",
                              summary: "Close the lead and record why.", closes_lead: true },
});

/**
 * resolveTourOutcome — the ONE interpretation of a captured tour.
 *
 * Returns a shape every surface can read without re-deriving anything:
 *   { captured, attendance, standing, judged_by, next_move, needs_standing,
 *     valid, refusal }
 *
 * HONEST BLANK: no capture returns captured:false and next_move:null. It
 * never invents a neutral outcome, because a tour nobody captured is not
 * the same as a tour that went averagely, and a screen that shows them
 * identically is lying quietly.
 */
function resolveTourOutcome({ attendance = null, standing = null, judgedBy = null } = {}) {
  const blank = {
    captured: false, attendance: null, standing: null, judged_by: null,
    next_move: null, needs_standing: false, valid: true, refusal: null,
  };

  if (attendance == null) return blank;

  if (!ATTENDANCE_VALUES.includes(attendance)) {
    return { ...blank, valid: false, refusal: `unknown attendance '${attendance}'` };
  }

  const needs_standing = ATTENDANCE_HAS_STANDING[attendance];

  // A standing on a tour that never happened is a contradiction, not a
  // detail to tolerate. Refuse rather than silently drop it.
  if (!needs_standing && standing != null) {
    return { ...blank, valid: false,
             refusal: `attendance '${attendance}' cannot carry a standing` };
  }

  if (needs_standing) {
    if (standing == null) {
      // Attendance recorded, judgment still owed. This is a real, common,
      // half-finished state on a busy day — not an error. It routes
      // nowhere until the agent supplies the one thing only they know.
      return { captured: true, attendance, standing: null, judged_by: null,
               next_move: null, needs_standing: true, valid: true, refusal: null };
    }
    if (!STANDING_VALUES.includes(standing)) {
      return { ...blank, valid: false, refusal: `unknown standing '${standing}'` };
    }
    if (judgedBy !== JUDGED_BY.AGENT) {
      // The hard line. The AI did not attend and cannot supply this.
      return { ...blank, valid: false,
               refusal: "a standing must be judged by the agent who was present" };
    }
    return { captured: true, attendance, standing, judged_by: JUDGED_BY.AGENT,
             next_move: NEXT_MOVE[standing], needs_standing: true, valid: true, refusal: null };
  }

  return { captured: true, attendance, standing: null, judged_by: judgedBy || null,
           next_move: ATTENDANCE_NEXT_MOVE[attendance] || null,
           needs_standing: false, valid: true, refusal: null };
}

// ── THREE VOCABULARIES, ONE MEANING ──────────────────────────────────
//  This surface has been written three times and nothing ever migrated:
//
//    v1 (live, what the UI still sends)  tour_outcome free text:
//         'interested' 27 · 'start_application' 5 · 'keep_working' 1 · null 7
//    v2 (built, never adopted by the UI) disposition + sub_read:
//         start_application | keep_working | needs_change | close_watch
//         × hot | warm | exploring
//    v3 (this file, the owner's design)  ONE four-value standing.
//
//  v3 is deliberately FLATTER: disposition-then-sub_read is two decisions
//  on a screen the agent has ten seconds for. One tap, four words.
//
//  normalizeStanding exists so all three land on one meaning and the UI
//  can move at its own pace without the record forking. It is the bridge,
//  not a fourth vocabulary.
//
//  ── WHAT IT REFUSES TO DO ────────────────────────────────────────────
//  'interested' and a bare 'keep_working' are genuinely AMBIGUOUS between
//  hot_lead and possible. The distinction was never captured, so it does
//  not exist in the record and cannot be recovered by mapping. Guessing
//  would manufacture a judgment the agent never made — the same defect as
//  letting the AI supply a standing.
//
//  So they resolve to null WITH A REASON. 27 historical rows stay honestly
//  unresolved rather than becoming confidently wrong. Backfilling meaning
//  that was never captured is how a record starts lying about its own past.
const LEGACY_STANDING_MAP = Object.freeze({
  // unambiguous — the word already meant exactly one thing
  start_application: STANDING.READY_TO_APPLY,
  needs_change:      STANDING.POSSIBLE,
  // v2 two-level, resolvable only WITH the sub_read
  // (handled below; listed here for readers)
});

function normalizeStanding({ standing = null, disposition = null,
                             sub_read = null, future_fit = null,
                             interest_level = null } = {}) {
  const unresolved = (reason, from) => ({ standing: null, resolved: false, reason, from });

  // v3 — already the target vocabulary
  if (standing != null) {
    return STANDING_VALUES.includes(standing)
      ? { standing, resolved: true, reason: null, from: "v3" }
      : unresolved(`unknown standing '${standing}'`, "v3");
  }

  // v2 — disposition (+ sub_read for the one that needs it)
  if (disposition != null) {
    if (disposition === "close_watch") {
      // future_fit decides: 'close' is a real no, 'keep' is still possible
      if (future_fit === "close") return { standing: STANDING.NOT_MOVING_FORWARD, resolved: true, reason: null, from: "v2" };
      if (future_fit === "keep")  return { standing: STANDING.POSSIBLE,           resolved: true, reason: null, from: "v2" };
      return unresolved("close_watch without future_fit is ambiguous between possible and not_moving_forward", "v2");
    }
    if (disposition === "keep_working") {
      if (sub_read === "hot") return { standing: STANDING.HOT_LEAD, resolved: true, reason: null, from: "v2" };
      if (sub_read === "warm" || sub_read === "exploring")
        return { standing: STANDING.POSSIBLE, resolved: true, reason: null, from: "v2" };
      return unresolved("keep_working without sub_read is ambiguous between hot_lead and possible", "v2");
    }
    if (LEGACY_STANDING_MAP[disposition])
      return { standing: LEGACY_STANDING_MAP[disposition], resolved: true, reason: null, from: "v2" };
    return unresolved(`unknown disposition '${disposition}'`, "v2");
  }

  // v1 — the free-text field that is 68% one word
  if (interest_level != null) {
    if (LEGACY_STANDING_MAP[interest_level])
      return { standing: LEGACY_STANDING_MAP[interest_level], resolved: true, reason: null, from: "v1" };
    // 'interested' lands here, and stays here.
    return unresolved(
      `legacy value '${interest_level}' cannot be resolved to a standing — the distinction was never captured`,
      "v1");
  }

  return unresolved("nothing to normalize", null);
}

/**
 * captureLatencyMinutes — how long the fresh judgment sat before it was
 * recorded. Null when the tour has no slot (no honest end time exists) or
 * no capture happened. Never guessed: an unmeasurable latency reads as
 * unmeasurable, which is what makes it usable for accountability later.
 */
function captureLatencyMinutes({ tourEndedAt = null, capturedAt = null } = {}) {
  if (!tourEndedAt || !capturedAt) return null;
  const end = new Date(tourEndedAt).getTime();
  const cap = new Date(capturedAt).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(cap)) return null;
  return Math.round((cap - end) / 60000);
}

module.exports = {
  ATTENDANCE, ATTENDANCE_VALUES, ATTENDANCE_HAS_STANDING,
  STANDING, STANDING_VALUES, STANDING_LABEL, STANDING_HELP,
  JUDGED_BY, NEXT_MOVE, ATTENDANCE_NEXT_MOVE,
  resolveTourOutcome, captureLatencyMinutes, normalizeStanding,
};
