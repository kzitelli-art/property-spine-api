// ════════════════════════════════════════════════════════════════════
//  CAPTURE RECEIPT — what changed in the relationship, in plain English.
//
//  Class 1, pure. No I/O. Turns the result of a capture into the two
//  sentences an operator actually needs, and keeps the ids somewhere they
//  can be looked up without being read aloud.
//
//  ── WHY ──────────────────────────────────────────────────────────────
//  Fable lock 4 (2026-07-26). The live receipt today says:
//
//    "Outcome recorded — tour given. Follow-up rail opened — outcome ·
//     owner set to the actual host."
//
//  That is the machinery describing itself. "Rail", "outcome", "set to the
//  actual host" are all true and none of them tell a leasing agent what
//  happens next. What they need is:
//
//    Tour saved
//    Hot Lead · Quiet and price mattered.
//    Kandice will follow up tomorrow with quieter options.
//    Person Card updated.
//
//  The operator should see the CONSEQUENCE. The ids exist in the technical
//  receipt and the logs, where they belong.
//
//  ── THE HONESTY RULE STILL APPLIES ───────────────────────────────────
//  Plain language is not permission to smooth over a gap. If nobody owns
//  the follow-up, the receipt SAYS nobody owns it — in words, not by
//  omitting the line. A receipt that reads well because it left out the
//  missing owner is exactly the confident-wrong this product refuses.
// ════════════════════════════════════════════════════════════════════

const { STANDING_LABEL, ATTENDANCE } = require("./tour_outcome");

const HEADLINE = Object.freeze({
  [ATTENDANCE.TOURED]:      "Tour saved",
  [ATTENDANCE.NO_SHOW]:     "No-show recorded",
  [ATTENDANCE.RESCHEDULED]: "Tour rescheduled",
  [ATTENDANCE.CANCELLED]:   "Tour cancelled",
});

//  "tomorrow" beats a date an operator has to decode. Anything past a week
//  gets the actual date, because "in 12 days" is not a plan.
function whenPhrase(dueAt, now) {
  if (!dueAt) return null;
  const d = new Date(dueAt), n = now ? new Date(now) : new Date();
  if (isNaN(d.getTime())) return null;
  const days = Math.round((d.setHours(0, 0, 0, 0) - new Date(n).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 6) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

//  "Quiet and price mattered." — an English list, not "quiet, price".
function listPhrase(items) {
  const xs = (items || []).map(x => String(x || "").trim()).filter(Boolean);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/**
 * composeCaptureReceipt — the operator sentence, and the technical one.
 *
 *   attendance, standing        what was captured
 *   whatMattered  [labels]      the chips they tapped
 *   nothingClear  bool          they said they could not read it
 *   nextMoveSummary             the proposed action, in words
 *   ownerName / ownerUnassigned who will do it
 *   dueAt
 *   ids { tour_id, conversion_id, obligation_id }
 *
 * Returns { receipt, lines[], technical }.
 */
function composeCaptureReceipt({
  attendance = null, standing = null, whatMattered = [], nothingClear = false,
  nextMoveSummary = null, ownerName = null, ownerUnassigned = false,
  dueAt = null, now = null, ids = {},
} = {}) {
  const lines = [];

  lines.push(HEADLINE[attendance] || "Saved");

  // What the agent read, and what they said mattered — one sentence.
  const bits = [];
  if (standing && STANDING_LABEL[standing]) bits.push(STANDING_LABEL[standing]);
  const mattered = listPhrase(whatMattered);
  if (mattered) bits.push(`${mattered} mattered`);
  else if (nothingClear) bits.push("nothing clear yet");
  if (bits.length) lines.push(bits.join(" · ") + ".");

  // What happens next. The whole point of the capture.
  if (ownerUnassigned || (!ownerName && nextMoveSummary)) {
    // NEVER quietly drop the owner line. An unowned follow-up is the thing
    // most likely to rot, so it is stated, not omitted.
    lines.push(nextMoveSummary
      ? `Nobody owns this yet — ${lowerFirst(nextMoveSummary)}`
      : "Nobody owns the follow-up yet.");
  } else if (ownerName && nextMoveSummary) {
    //  If the proposed move ALREADY says when ("follow up tomorrow with
    //  quieter options"), leave it exactly as written. Lifting the time
    //  word out and re-appending it produced "will follow up with quieter
    //  options tomorrow" — grammatically fine, natural to nobody.
    //  Only add a date when the summary does not carry one.
    const when = carriesTime(nextMoveSummary) ? null : whenPhrase(dueAt, now);
    lines.push(`${ownerName} will ${lowerFirst(nextMoveSummary)}`.replace(/\.$/, "")
      + (when ? ` ${when}.` : "."));
  } else if (nextMoveSummary) {
    lines.push(nextMoveSummary.endsWith(".") ? nextMoveSummary : nextMoveSummary + ".");
  }

  lines.push("Person Card updated.");

  //  The ids live here — available, not recited.
  const technical = Object.entries(ids)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  return { receipt: lines.join("\n"), lines, technical: technical || null };
}

function lowerFirst(s) {
  const t = String(s || "").trim();
  return t ? t[0].toLowerCase() + t.slice(1) : t;
}
//  Does the proposed move already say when? If so the date is not appended,
//  so a receipt never reads "…in a few days Wednesday."
function carriesTime(s) {
  return /\b(today|tomorrow|tonight|this (week|morning|afternoon)|next week|in a few days|in \d+ days?|on (mon|tue|wed|thu|fri|sat|sun))/i
    .test(String(s || ""));
}

module.exports = { composeCaptureReceipt, whenPhrase, listPhrase, carriesTime };
