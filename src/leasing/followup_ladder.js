// ════════════════════════════════════════════════════════════════════
//  FOLLOWUP LADDER — what to send a quiet prospect next, and when.
//
//  Class 1, pure. No database, no sending, no clock of its own. Given what
//  has already happened, it returns the single next follow-up, or null.
//  Callers do the sending and own the send-window check.
//
//  ── THE PROBLEM ──────────────────────────────────────────────────────
//  Whoever stays present while a prospect is deciding gets the signature.
//  Going quiet loses leases. But the property's own template ladder sends
//  six messages that all say "still looking?" — and six of the same message
//  is what makes someone block the number.
//
//  So: persistence is the default, and each touch does a DIFFERENT job.
//  Same cadence, opposite feel.
//
//  ── DORMANT ──────────────────────────────────────────────────────────
//  Nothing calls this yet. It decides; it cannot send. Wiring it to a
//  scheduler is a deliberate, separate act, and the scheduler must ask
//  commsBoundary.withinSendWindow() before every send — a follow-up fires
//  on a timer with nobody watching, which is exactly what quiet hours are
//  for. Removal condition: delete if the ladder is replaced by a
//  per-property configurable sequence.
// ════════════════════════════════════════════════════════════════════

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Each rung does a different job. Order matters; `after` is measured from
// the LAST OUTBOUND, not from lead creation, so a conversation that stalls
// late still gets a full ladder rather than a compressed one.
const LADDER = [
  { rung: 1, after: 2 * HOUR, job: "answer_their_thing",
    intent: "Follow up on the specific thing they last asked about. No new pitch." },
  { rung: 2, after: 1 * DAY, job: "show_the_place",
    intent: "Send the 3D tour for the layout they asked about, or offer a live video tour. This is the rung that carries the Matterport." },
  { rung: 3, after: 3 * DAY, job: "name_the_objection",
    intent: "Address the likely unspoken objection (price, size, timing) with a real fact, including the current concession if one applies." },
  { rung: 4, after: 5 * DAY, job: "make_it_easy",
    intent: "Lower the cost of saying yes: offer to hold a specific time, or a video tour if scheduling is the blocker." },
  { rung: 5, after: 7 * DAY, job: "real_urgency",
    intent: "Only if TRUE and grounded: the unit, the concession deadline, or the lease cycle. Never manufacture urgency." },
  { rung: 6, after: 7 * DAY, job: "close_it_out",
    intent: "Assume they went another direction unless they say otherwise. This is the message that gets replies, because ignoring it has a cost." },
];

// Reasons the ladder stops entirely. A stop is permanent; there is no rung
// after it and no "one more try".
const STOP_REASONS = {
  opted_out: "opted out",
  said_no: "told us no",
  leased_elsewhere: "leased elsewhere",
  human_owns: "a human took the conversation",
  ladder_exhausted: "ladder finished",
};

// nextFollowup — the whole module.
//
//   state = {
//     lastOutboundAt, lastInboundAt   (ms epoch, or null)
//     rungsSent                       (int, default 0)
//     stopped                         (a STOP_REASONS key, or null)
//     tourBooked                      (bool)
//     askedAboutLayout                ("studio" | "one_bedroom" | ... | null)
//   }
//   now = ms epoch (injected; this module never reads the clock)
//
// Returns { send: false, reason } or { send: true, rung, job, intent, layout }.
function nextFollowup(state = {}, now) {
  const {
    lastOutboundAt = null, lastInboundAt = null,
    rungsSent = 0, stopped = null,
    tourBooked = false, askedAboutLayout = null,
  } = state;

  if (stopped) return { send: false, reason: STOP_REASONS[stopped] || stopped };

  // A booked tour is not a quiet lead. Tour reminders are a different job
  // and belong to the conversion ladder, not here.
  if (tourBooked) return { send: false, reason: "tour booked" };

  // They replied after our last message: the ball is ours, not the ladder's.
  // Answering an inbound is a reply, never a follow-up.
  if (lastInboundAt && lastOutboundAt && lastInboundAt > lastOutboundAt) {
    return { send: false, reason: "they replied, owe them an answer" };
  }

  if (!lastOutboundAt) return { send: false, reason: "nothing sent yet" };
  if (rungsSent >= LADDER.length) return { send: false, reason: STOP_REASONS.ladder_exhausted };

  const rung = LADDER[rungsSent];
  const due = lastOutboundAt + rung.after;
  if (now < due) return { send: false, reason: "not due", dueAt: due };

  return {
    send: true,
    rung: rung.rung,
    job: rung.job,
    intent: rung.intent,
    layout: askedAboutLayout, // rung 2 needs this to pick the right tour
  };
}

module.exports = { nextFollowup, LADDER, STOP_REASONS, HOUR, DAY };
