// ════════════════════════════════════════════════════════════════════
//  CAPTURE CHASE — who to ask for a tour outcome, when, and how loudly.
//
//  Class 1, pure. No database, no sending, no I/O. Given what is already
//  known about a tour and what has already been asked, it decides the
//  single next thing that should happen. Callers do the asking.
//
//  ── THE PROBLEM IT EXISTS FOR ────────────────────────────────────────
//  Prime season. One agent on duty. Eight tours back to back. The first
//  one goes beautifully — they are ready to move forward — and the moment
//  it ends the next prospect is already in the lobby. Nobody is pulling
//  out a phone to fill in a form.
//
//  The lead does not die because the agent is careless. It dies because
//  the only moment the judgment existed was a moment the agent had no
//  hands free. So the system has to ASK, and asking is not a nicety: the
//  capture gates the follow-up, and the follow-up is the revenue.
//
//  ── WHY THE SYSTEM MAY NOT JUST GUESS ────────────────────────────────
//  The AI was not in the room. It did not see the face. Whatever it reads
//  in a transcript is a different fact from what the agent saw, and the
//  two must never occupy one field. So the chase never answers on the
//  agent's behalf; it only makes answering cost as little as possible.
//
//  ── ONE ROW PER ASK ──────────────────────────────────────────────────
//  Every attempt is a real event, recorded (096). "We asked twice" is a
//  fact, not an update to the first ask — which is exactly what any later
//  accountability has to read. You cannot hold someone to a prompt you
//  have no record of sending.
// ════════════════════════════════════════════════════════════════════

const { CAPTURE_STATE } = require("./tour_outcome");

// ── THE LADDER ───────────────────────────────────────────────────────
//  Deliberately gentle at first and never infinite. A prompt that repeats
//  forever is noise, and noise is how a real signal gets ignored.
//
//  Minutes measured from the END of the tour, not from the last ask —
//  the thing that decays is the agent's memory of the tour, and it does
//  not restart because we sent another text.
const LADDER = Object.freeze([
  { attempt: 1, after_minutes: 5,   channel: "sms", tone: "quiet",
    why: "the walk back to the lobby — the judgment is freshest here" },
  { attempt: 2, after_minutes: 45,  channel: "sms", tone: "quiet",
    why: "a gap between tours, or the end of a back-to-back run" },
  { attempt: 3, after_minutes: 240, channel: "app", tone: "surfaced",
    why: "four hours out: stop texting, put it on the desk where it is visible" },
]);

//  After the last rung, stop asking and let the end-of-day sweep carry it.
//  The tour is not abandoned — it is owed, visibly, until someone answers.
const MAX_ATTEMPTS = LADDER.length;

const ACTION = Object.freeze({
  ASK:        "ask",         // send attempt N now
  WAIT:       "wait",        // owed, but not yet due for the next rung
  SWEEP_ONLY: "sweep_only",  // ladder exhausted; carried by the sweep
  NONE:       "none",        // nothing owed
  BLOCKED:    "blocked",     // cannot ask — say why, never silently skip
});

/**
 * nextChaseAction — the single next thing for ONE tour.
 *
 *   captureState   from tour_outcome.resolveCaptureState()
 *   tourEndedAt    slot end. null = untrackable
 *   hostUserId     who to ask. null = nobody to ask
 *   asks           [{ attempt_no, asked_at, responded_at }] already recorded
 *   now
 *
 * Returns { action, attempt_no, channel, tone, due_at, reason }.
 */
function nextChaseAction({ captureState = null, tourEndedAt = null,
                           hostUserId = null, asks = [], now = null } = {}) {
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const out = (action, extra = {}) => ({
    action, attempt_no: null, channel: null, tone: null, due_at: null, ...extra,
  });

  // Already answered, or nothing owed.
  if (captureState === CAPTURE_STATE.SETTLED)
    return out(ACTION.NONE, { reason: "outcome recorded" });
  if (captureState === CAPTURE_STATE.SCHEDULED)
    return out(ACTION.NONE, { reason: "tour has not happened yet" });

  // Any answered ask ends the chase. The judgment exists.
  if (asks.some(a => a.responded_at))
    return out(ACTION.NONE, { reason: "an ask was already answered" });

  // UNTRACKABLE: no slot, so no end time, so no honest schedule to chase
  // against. Refusing to invent one is the point — a fabricated "tour
  // ended at" would make every downstream minute a lie. It stays visible
  // on the board instead.
  if (captureState === CAPTURE_STATE.UNTRACKABLE || !tourEndedAt)
    return out(ACTION.BLOCKED, {
      reason: "no slot on this tour, so there is no end time to chase from — visible on the board, not chased" });

  // NOBODY TO ASK. Not skipped, not chased into the void: named.
  if (!hostUserId)
    return out(ACTION.BLOCKED, {
      reason: "no host assigned — there is nobody to ask, and an unassigned tour is unscoreable" });

  const attemptsMade = asks.length;
  if (attemptsMade >= MAX_ATTEMPTS)
    return out(ACTION.SWEEP_ONLY, {
      reason: `${attemptsMade} asks made and unanswered — stop texting; the end-of-day sweep carries it` });

  const rung = LADDER[attemptsMade];            // the next un-made attempt
  const endMs = new Date(tourEndedAt).getTime();
  if (!Number.isFinite(endMs))
    return out(ACTION.BLOCKED, { reason: "unreadable tour end time" });

  const dueMs = endMs + rung.after_minutes * 60000;
  if (nowMs < dueMs)
    return out(ACTION.WAIT, {
      attempt_no: rung.attempt, channel: rung.channel, tone: rung.tone,
      due_at: new Date(dueMs).toISOString(),
      reason: `attempt ${rung.attempt} is due ${rung.after_minutes} min after the tour ends — ${rung.why}` });

  return out(ACTION.ASK, {
    attempt_no: rung.attempt, channel: rung.channel, tone: rung.tone,
    due_at: new Date(dueMs).toISOString(),
    reason: rung.why });
}

/**
 * buildPromptText — what the agent actually reads on their phone.
 *
 * The whole design target is that answering costs one thumb and about two
 * seconds, while walking. So: the person's name first (that is what the
 * agent recognises, not a tour id), the unit, the time, then four numbered
 * options. No link to tap, no app to open, no context to reload.
 *
 * The four words are the ONLY thing being asked, because the standing is
 * the only answer that changes what happens next. Everything else the
 * capture wants — what mattered, the next move — can be enriched later or
 * never, and the lead still routes correctly.
 */
function buildPromptText({ prospectName = null, unitLabel = null,
                           timeLabel = null, attempt = 1 } = {}) {
  const who = prospectName || "your tour";
  const where = unitLabel ? ` · ${unitLabel}` : "";
  const when = timeLabel ? ` · ${timeLabel}` : "";
  const nudge = attempt > 1 ? "Still open — " : "";
  return `${nudge}${who}${where}${when}\nWhere'd they land?\n`
       + `1 Ready to apply  2 Hot  3 Possible  4 Not moving`;
}

//  The reply the agent sends back. Kept beside the prompt so the numbers
//  on the phone and the numbers the parser accepts cannot drift apart —
//  a mismatch there would silently record the wrong judgment, which is
//  worse than recording none.
const REPLY_MAP = Object.freeze({
  "1": "ready_to_apply",
  "2": "hot_lead",
  "3": "possible",
  "4": "not_moving_forward",
});

/**
 * parsePromptReply — read the agent's answer, or refuse it.
 * Accepts a bare digit, optionally with surrounding whitespace/punctuation.
 * Anything else is REFUSED rather than guessed: a misread reply would
 * record a judgment the agent did not make.
 */
function parsePromptReply(body) {
  const raw = String(body == null ? "" : body).trim();
  const m = raw.match(/^([1-4])\b[.!)]?$/);
  if (!m) return { standing: null, ok: false,
                   reason: `reply '${raw.slice(0, 24)}' is not one of 1-4 — refusing rather than guessing` };
  return { standing: REPLY_MAP[m[1]], ok: true, reason: null };
}

module.exports = { LADDER, MAX_ATTEMPTS, ACTION, REPLY_MAP,
                   nextChaseAction, buildPromptText, parsePromptReply };
