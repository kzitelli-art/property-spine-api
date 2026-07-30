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

// ── CAPTURE STATE — what the board owes, per tour ────────────────────
//  The desk and the end-of-day sweep must agree about what a tour needs.
//  Two surfaces deriving that separately is how they drift, so it is
//  derived once, here.
//
//  THE DEFECT THIS EXISTS TO FIX: today a tour whose phase is 'unknown'
//  (no slot, so no honest end time) falls through every branch of the
//  board's issue logic and renders CALM — identical to a tour that is
//  genuinely fine. The server is honest ('unknown'); the screen quietly
//  translates that into "nothing needed". Until this morning that was 21
//  of 30 tours: a whole board of tours the system could not reason about,
//  all showing as healthy.
//
//  A tour nobody captured and a tour that went averagely are different
//  facts. UNTRACKABLE is its own state and says so.
const CAPTURE_STATE = Object.freeze({
  SETTLED:      "settled",        // outcome recorded — asks for nothing
  JUDGMENT_OWED:"judgment_owed",  // attendance in, standing still missing
  OVERDUE:      "overdue",        // tour ended + grace, nothing captured
  SCHEDULED:    "scheduled",      // future tour, nothing owed yet
  UNTRACKABLE:  "untrackable",    // no slot -> no end time -> cannot tell
});

const CAPTURE_STATE_LABEL = Object.freeze({
  [CAPTURE_STATE.SETTLED]:       "Captured",
  [CAPTURE_STATE.JUDGMENT_OWED]: "Needs your read",
  [CAPTURE_STATE.OVERDUE]:       "Outcome needed",
  [CAPTURE_STATE.SCHEDULED]:     "Scheduled",
  [CAPTURE_STATE.UNTRACKABLE]:   "No time on record",
});

//  Whether the board should show this as WORK. 'untrackable' counts:
//  it is not calm, it is unknown, and unknown is a thing to fix.
const CAPTURE_STATE_IS_WORK = Object.freeze({
  [CAPTURE_STATE.SETTLED]:       false,
  [CAPTURE_STATE.JUDGMENT_OWED]: true,
  [CAPTURE_STATE.OVERDUE]:       true,
  [CAPTURE_STATE.SCHEDULED]:     false,
  [CAPTURE_STATE.UNTRACKABLE]:   true,
});

/**
 * resolveCaptureState — what this tour owes the board, right now.
 *
 *   isTerminal    the outcome is already recorded
 *   attendance    what was captured so far (null if nothing)
 *   standing      the agent's judgment (null if still owed)
 *   tourEndedAt   the SLOT's end time. null means no slot, which means
 *                 there is no honest end time and therefore no honest
 *                 answer to "is this overdue?"
 *   now / graceMinutes
 *
 * Returns { state, label, is_work, reason, capture_due_at }.
 *
 * capture_due_at (S4 ruling): the CONCRETE deadline this resolver measures
 * against — effective end + grace — authored here and nowhere else, so a
 * surface may never say "overdue" without the timestamp that explains it.
 * Present exactly when an honest end time exists (overdue and scheduled);
 * null for settled / judgment-owed / untrackable, where no time gate is the
 * governing fact. Additive: existing consumers read the original four fields.
 */
function resolveCaptureState({ isTerminal = false, attendance = null, standing = null,
                               tourEndedAt = null, occurredAt = null, origin = null,
                               now = null, graceMinutes = 0 } = {}) {
  const out = (state, reason, captureDueAt) => ({
    state, label: CAPTURE_STATE_LABEL[state], is_work: CAPTURE_STATE_IS_WORK[state], reason,
    capture_due_at: captureDueAt || null,
  });

  if (isTerminal) return out(CAPTURE_STATE.SETTLED, "outcome already recorded");

  // Attendance captured, judgment still owed. Real, common, and the whole
  // reason a busy day needs chasing — it is not calm and not overdue.
  if (attendance && ATTENDANCE_HAS_STANDING[attendance] && standing == null) {
    return out(CAPTURE_STATE.JUDGMENT_OWED, "toured, but where they landed is still owed");
  }

  // A WALK-IN HAS NO SLOT AND THAT IS NOT A DEFECT. Somebody in the
  // neighbourhood came in and got toured; there was never a slot to book.
  // What matters is whether a real time is on record, not where it came
  // from — so an actual occurrence time (check-in / arrival) is as honest
  // an end time as a slot's, and is used when the slot has none.
  //
  // This is the distinction 097's `origin` column exists for: a walk-in
  // without a slot is fine, a SCHEDULED tour without one is the defect
  // that made 21 of 30 tours untimeable. Collapsing them would make the
  // untrackable diagnosis useless the moment walk-ins start arriving.
  const effectiveEnd = tourEndedAt || occurredAt || null;

  if (!effectiveEnd) {
    return out(CAPTURE_STATE.UNTRACKABLE,
      origin === "walk_in"
        ? "walk-in with no recorded arrival time — capture it and the time is set"
        : "no slot on this tour, so there is no end time to measure against");
  }

  const end = new Date(effectiveEnd).getTime();
  const nowMs = now ? new Date(now).getTime() : Date.now();
  if (!Number.isFinite(end)) {
    return out(CAPTURE_STATE.UNTRACKABLE, "unreadable end time");
  }
  const captureDueAt = new Date(end + graceMinutes * 60000).toISOString();
  if (nowMs > end + graceMinutes * 60000) {
    return out(CAPTURE_STATE.OVERDUE, "the tour has ended and nothing was captured", captureDueAt);
  }
  return out(CAPTURE_STATE.SCHEDULED, "not yet due", captureDueAt);
}

// ── A STANDING IS NOT A LABEL ─────────────────────────────────────────
//  Fable lock 1 (2026-07-26): keep these two truths apart.
//
//    lifecycle stage    Prospect / Applicant / Resident   — where they ARE
//    post-tour standing Ready to Apply / Hot Lead /        — what one agent
//                       Possible / Not Moving Forward        read, once
//
//  "Hot Lead" is a SOURCED ASSESSMENT from a particular tour on a
//  particular day. It must be superseded by later evidence and disappear
//  when the relationship advances, closes, or changes. Do not permanently
//  brand the person as Hot.
//
//  The risk is concrete and lives in the design contract's own example
//  header — `Applicant · Hot Lead` — where a one-day read sits beside a
//  durable position looking equally permanent. Three weeks later, after an
//  application and two more conversations, that badge is still there
//  telling an agent something nobody has believed since.
//
//  So a standing is only ever displayed WITH its source, and it goes
//  quiet the moment the relationship moves past it.
const STAGE_RANK = Object.freeze({
  tour_followup: 1, applicant_followup: 2, lease_signature_followup: 3,
});

/**
 * standingOptionsForStage — which four words to offer, given where the
 * relationship already is.
 *
 *  Owner: "'Ready to Apply' makes sense before an application; after they
 *  have applied, the equivalent decision may be 'Ready to Sign'… Do not
 *  invent a second lifecycle — just avoid presenting an action that has
 *  already happened."
 *
 *  So the KEYS never change. There is one standing vocabulary and one
 *  ladder. What changes is the WORDS on the button, because
 *  `ready_to_apply` has always meant "ready for the next commitment step"
 *  and that step is different once they have applied.
 *
 *  Offering "Ready to Apply" to someone who applied a week ago is worse
 *  than merely redundant: a rushed agent taps it, and the record now says
 *  the next move is something already done.
 *
 *  A stage this does not know about gets the default set rather than a
 *  guess — an unranked position is not a licence to invent labels.
 */
const STANDING_LABEL_BY_STAGE = Object.freeze({
  applicant_followup: {
    [STANDING.READY_TO_APPLY]: "Ready to Sign",
    [STANDING.HOT_LEAD]:       "Hot — push it",
  },
  lease_signature_followup: {
    // The commitment step is in flight; there is nothing further to
    // declare them ready FOR, so that option is withdrawn entirely
    // rather than relabelled into something meaningless.
    [STANDING.READY_TO_APPLY]: null,
  },
});

function standingOptionsForStage(stage) {
  const overrides = STANDING_LABEL_BY_STAGE[stage] || {};
  return STANDING_VALUES
    .map((key) => {
      const override = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key] : undefined;
      if (override === null) return null;              // withdrawn at this stage
      return {
        key,
        label: override !== undefined ? override : STANDING_LABEL[key],
        help: STANDING_HELP[key],
        relabelled: override !== undefined && override !== null,
      };
    })
    .filter(Boolean);
}

/**
 * resolveStandingDisplay — should this standing still be shown, and how?
 *
 *   standing        the recorded four-word read
 *   standingAt      when that tour was captured
 *   standingStage   the relationship's stage AT capture time (if known)
 *   currentStage    where the relationship is now
 *   relationshipClosed
 *   laterStandingAt a newer tour's standing, if one exists
 *
 * Returns { show, label, qualifier, reason }. `qualifier` is never
 * optional decoration — it is what stops a read becoming a brand.
 */
function resolveStandingDisplay({ standing = null, standingAt = null,
                                  standingStage = null, currentStage = null,
                                  relationshipClosed = false,
                                  laterStandingAt = null, now = null } = {}) {
  const hide = (reason) => ({ show: false, label: null, qualifier: null, reason });
  if (!standing || !STANDING_VALUES.includes(standing)) return hide("no standing on record");

  // A closed relationship has no live read. Whatever the last tour said,
  // it is history now.
  if (relationshipClosed) return hide("relationship is closed — the read is history");

  // A newer tour outranks an older one. The most recent judgment wins;
  // the older stays in history where it belongs.
  if (laterStandingAt && standingAt && new Date(laterStandingAt) > new Date(standingAt)) {
    return hide("superseded by a later tour");
  }

  // THE RELATIONSHIP MOVED PAST IT. Someone read as 'Ready to Apply' who
  // has since applied is not still ready to apply — they did it. Showing
  // it implies work that is already done.
  const then = STAGE_RANK[standingStage];
  const nowRank = STAGE_RANK[currentStage];
  if (then != null && nowRank != null && nowRank > then) {
    return hide(`relationship advanced to ${currentStage} after this read`);
  }

  // Still current — but shown as what it is: one person's read, on a day.
  let qualifier = "from the tour";
  if (standingAt) {
    const d = new Date(standingAt);
    if (!isNaN(d.getTime())) {
      const days = Math.floor(((now ? new Date(now) : new Date()) - d) / 86400000);
      qualifier = days <= 0 ? "from today's tour"
                : days === 1 ? "from yesterday's tour"
                : days <= 14 ? `from the tour ${days} days ago`
                // Past a fortnight a tour read is a stale opinion, not a
                // current signal. Still shown, but dated so nobody mistakes
                // it for fresh.
                : `from a tour ${days} days ago`;
    }
  }
  return { show: true, label: STANDING_LABEL[standing], qualifier, reason: null };
}

/**
 * resolveCapturedStanding — the decision the capture service makes, kept
 * HERE rather than inline in the service so it can be exercised directly
 * instead of copied into a test.
 *
 * Takes the raw feedback body (whatever vocabulary the UI is on) plus the
 * SERVER-DERIVED recorder, and returns exactly what should be written.
 *
 * Two ways to end up with no standing, and they are different facts:
 *   · the value could not be resolved   → reason names the missing distinction
 *   · nobody was attributable           → reason says so
 * Either way the raw value is preserved for the projection, so nothing the
 * agent supplied is silently discarded.
 */
function resolveCapturedStanding({ fb = {}, recordedByUserId = null } = {}) {
  const norm = normalizeStanding({
    standing:       fb.standing || null,
    disposition:    fb.disposition || null,
    sub_read:       fb.sub_read || null,
    future_fit:     fb.future_fit || null,
    interest_level: fb.interest_level || null,
  });

  const raw = (fb.standing || fb.disposition || fb.interest_level) || null;

  if (!norm.resolved) {
    return { standing: null, judged_by: null, source: null, next_move: null,
             unresolved_reason: norm.reason, tour_outcome_value: raw };
  }
  if (!recordedByUserId) {
    // A standing with no attributable human is not a standing. Refuse to
    // record it as one; keep the raw value so the input is not lost.
    return { standing: null, judged_by: null, source: null, next_move: null,
             unresolved_reason: "no server-derived recorder — a judgment with no judge is not a judgment",
             tour_outcome_value: raw };
  }
  return {
    standing: norm.standing,
    judged_by: JUDGED_BY.AGENT,
    source: norm.from,
    next_move: NEXT_MOVE[norm.standing] || null,
    unresolved_reason: null,
    tour_outcome_value: norm.standing,   // the resolved word wins the projection
  };
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
  resolveCapturedStanding,
  CAPTURE_STATE, CAPTURE_STATE_LABEL, CAPTURE_STATE_IS_WORK, resolveCaptureState,
  resolveStandingDisplay, STAGE_RANK,
  standingOptionsForStage, STANDING_LABEL_BY_STAGE,
};
