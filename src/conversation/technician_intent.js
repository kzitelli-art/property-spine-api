/* ════════════════════════════════════════════════════════════════════
   conversation/technician_intent.js — WHAT A TECHNICIAN JUST TOLD US.

   Pure. Requires nothing, queries nothing, sends nothing.

   ── THE PRODUCT BAR ─────────────────────────────────────────────────

   A technician is texting an assistant that already understands their
   work. They are not operating software through hidden command syntax.
   So the DESIGNED input is the way they already text:

       "Got it."                      "I'm heading over."
       "Couldn't get in."             "Nobody's home"
       "leak is stopped, needs a valve"
       "All done." + photo            "anything else open here?"

   `accept 1042` and `status blocked` are RECOGNISED — a dispatcher who
   learned them is not punished — but they are not the experience. Nothing
   in here requires a keyword, a number, or an order of words.

   ── WHY A REGEX LAYER AND NOT A MODEL ───────────────────────────────

   This layer decides what CONSEQUENTIAL action to propose. A model that
   is usually right would sometimes close a work order because someone
   said "that's done with" about a phone call. Every verb here is high
   confidence and narrow; anything it cannot read confidently comes back
   `unclear`, and the caller asks one short question rather than guessing.

   Fail-soft direction is always toward asking, never toward acting.

   ── WHAT IT DOES NOT DECIDE ─────────────────────────────────────────
   Which work order (work_reference.js), whether the actor may act
   (work_selection.js), whether anything is written (the canonical
   services), or what to say back (receipt.js). This reads one message.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const INTENTS = [
  "accept",        // taking the job on
  "en_route",      // heading there now
  "no_access",     // could not get in
  "blocked",       // something else stops the work
  "finding",       // what they observed or did
  "complete",      // says the work is finished
  "list_work",     // what's on my plate
  "unclear",       // read nothing consequential — ask
];

/*  Ordered. The FIRST match wins, and the order encodes consequence:
 *  "couldn't get in, heading to the next one" is a no-access report, not
 *  an en-route report. The more consequential, more specific reading is
 *  tested first so a trailing clause cannot overwrite it.
 *
 *  Every pattern is deliberately unanchored — technicians write fragments,
 *  lowercase, no punctuation, often mid-sentence. */
const PATTERNS = [
  ["no_access", [
    /\b(?:no|couldn'?t|could\s*not|cant|can'?t|couldnt)\s*(?:get|got)?\s*(?:in|access|inside|entry)\b/i,
    //  "Nobody's home" — the apostrophe-s is how people actually write it,
    //  and the first cut of this pattern missed exactly that phrasing.
    /\bno\s*(?:one|body)(?:'?s)?\s*(?:is\s*)?(?:home|there|answer|answering)/i,
    /\b(?:locked\s*out|no\s*answer\s*at\s*the\s*door|wouldn'?t\s*answer)\b/i,
    /\b(?:door|unit|apartment)\s*(?:was\s*)?locked\b/i,
    /\bno\s*access\b/i,
  ]],
  ["complete", [
    /\b(?:all\s*)?done\b/i,
    /\b(?:it'?s\s*)?(?:finished|complete|completed)\b/i,
    /\b(?:i\s*)?(?:fixed|repaired|replaced)\s*(?:it|the|that)\b/i,
    /\ball\s*(?:set|good|fixed|wrapped)\b/i,
    /\bwrapped\s*(?:it\s*)?up\b/i,
    /\bfinished\s*(?:up|it)?\b/i,
    /\bgood\s*to\s*go\b/i,
  ]],
  ["blocked", [
    //  "waiting on THE plumber" — an article the first cut did not allow.
    /\b(?:need|needs|waiting\s*(?:on|for)|short\s*a?)\s*(?:a|an|the)?\s*(?:part|parts|permit|vendor|approval|specialist|plumber|electrician|supplier)\b/i,
    /\bcan'?t\s*(?:finish|do|complete|fix)\s*(?:it|this)?\b/i,
    /\b(?:blocked|stuck|held\s*up)\b/i,
    /\bhave\s*to\s*come\s*back\b/i,
    /\bnot\s*(?:able|going)\s*to\s*(?:finish|get\s*it\s*done)\b/i,
  ]],
  ["en_route", [
    /\b(?:on\s*(?:my|the)\s*way|omw|en\s*route|enroute)\b/i,
    /\b(?:heading|headed|going|driving|rolling)\s*(?:over|there|out|to|that\s*way|now)?\b/i,
    /\b(?:be|i'?ll\s*be)\s*there\s*(?:in|shortly|soon)\b/i,
    /\bleaving\s*now\b/i,
    /\bnext\s*stop\b/i,
  ]],
  ["accept", [
    /\b(?:accept|accepted|accepting|i'?ll\s*take|ill\s*take|taking\s*(?:it|this)|take\s*it)\b/i,
    /\b(?:got\s*it|on\s*it|mine|i'?ve\s*got\s*(?:it|this)|i\s*got\s*(?:it|this))\b/i,
    /\b(?:will\s*do|sure|yep|yes)\b/i,
  ]],
  ["list_work", [
    /\b(?:what'?s|whats|anything)\s*(?:else\s*)?(?:open|left|assigned|on\s*my|i\s*have|for\s*me)/i,
    /\bmy\s*(?:work|jobs|list|queue|tickets)\b/i,
    /\bwhat\s*(?:do\s*i|am\s*i)\s*(?:have|working)/i,
    //  "anything else" on its own is the whole question, and needs no object.
    /\banything\s*else\b/i,
    /\bany(?:thing)?\s*(?:else\s*)?(?:here|open)\b/i,
  ]],
];

/*  A FINDING is anything substantive that is not one of the verbs above:
 *  "the leak is stopped but it needs a valve", "shutoff valve is corroded".
 *  It is the honest default for a real sentence, because a technician
 *  describing what they saw should have it RECORDED, not questioned.
 *
 *  The bar is deliberately "a real sentence": enough words to be a report
 *  rather than an acknowledgement, and at least one thing that reads as an
 *  observation. Short fragments fall to `unclear` and get one question. */
const FINDING_MIN_WORDS = 4;
const OBSERVATION_RX = /\b(?:leak|leaking|valve|pipe|drain|heat|heater|furnace|boiler|ac|a\/c|breaker|outlet|wire|wiring|lock|door|window|water|pressure|corroded|cracked|broken|clogged|replaced?|tightened?|reset|patched?|sealed?|stopped|running|working|damaged?|mold|rust)\b/i;

/*  Words that make a message a QUESTION rather than a report. A technician
 *  asking "should I replace the valve?" is not recording a finding. */
const ASKING_RX = /\?\s*$|^\s*(?:should|can|could|do|does|is|are|will|would|who|what|when|where|why|how)\b/i;

class TechnicianIntentError extends Error {
  constructor(message, code) { super(message); this.name = "TechnicianIntentError"; this.code = code; }
}

/*  readIntent — one message, one reading, with the evidence for it.
 *
 *  Returns { intent, matched, confident }. `matched` is the exact text
 *  that produced the reading, so a receipt or a log can show WHY we read
 *  it that way instead of asserting that we did.
 */
function readIntent(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return Object.freeze({ intent: "unclear", matched: null, confident: false });

  for (const [intent, patterns] of PATTERNS) {
    for (const rx of patterns) {
      const m = s.match(rx);
      if (m) return Object.freeze({ intent, matched: m[0], confident: true });
    }
  }

  //  Not a verb. Is it a report?
  const words = s.split(/\s+/).filter(Boolean).length;
  if (!ASKING_RX.test(s) && words >= FINDING_MIN_WORDS && OBSERVATION_RX.test(s)) {
    return Object.freeze({ intent: "finding", matched: s, confident: true });
  }

  return Object.freeze({ intent: "unclear", matched: null, confident: false });
}

/*  ── CONTEXT-DEPENDENT REPLIES ──────────────────────────────────────
 *  "ok", "yes", "that one", "the first" mean nothing on their own and
 *  everything as an answer to a question Spine just asked. Reading them as
 *  a verb out of context would act on a bare acknowledgement; refusing to
 *  read them at all would make a technician repeat something we already
 *  asked about.
 *
 *  So they are recognised SEPARATELY and only the orchestrator — which
 *  knows whether a question is outstanding — may use them. */
const AFFIRMATIVE_RX = /^\s*(?:ok(?:ay)?|yes|yep|yeah|yup|sure|correct|right|that'?s?\s*(?:it|right|the\s*one)|do\s*it|go\s*ahead|please|👍|\+1)\s*[.!]?\s*$/i;
const NEGATIVE_RX = /^\s*(?:no|nope|nah|not\s*(?:that|it|yet)|wrong|neither)\s*[.!]?\s*$/i;

function readAnswerToQuestion(text) {
  const s = typeof text === "string" ? text : "";
  if (AFFIRMATIVE_RX.test(s)) return "affirmative";
  if (NEGATIVE_RX.test(s)) return "negative";
  return null;
}

/*  Does this message carry evidence? The route knows from the provider
 *  payload; this states the contract so callers cannot invent one. */
function hasAttachments(attachments) {
  return Array.isArray(attachments) && attachments.length > 0;
}

/*  What a message MEANS when it arrives with photos and no words. A
 *  technician who sends three pictures and nothing else has reported
 *  something; treating that as unreadable would be the software making
 *  them type. It is evidence, and evidence alone never completes work. */
function readTurn({ text, attachments } = {}) {
  const read = readIntent(text);
  const withMedia = hasAttachments(attachments);
  if (withMedia && read.intent === "unclear") {
    return Object.freeze({ intent: "finding", matched: "(photo)", confident: true, evidenceOnly: true });
  }
  return Object.freeze({ ...read, evidenceOnly: false });
}

module.exports = {
  INTENTS,
  FINDING_MIN_WORDS,
  TechnicianIntentError,
  readIntent,
  readTurn,
  readAnswerToQuestion,
  hasAttachments,
};
