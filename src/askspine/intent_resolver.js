// ════════════════════════════════════════════════════════════════════
//  intent_resolver.js — QUESTION → RESOLVED INTENT, AND NOTHING ELSE
//
//  This module decides WHICH governed question was asked. It never
//  decides the answer, never reads operating data, and never touches a
//  database. Its entire output vocabulary is:
//
//      { resolution: "resolved",  intent_slug }
//      { resolution: "clarification_required", candidates: [...] }
//      { resolution: "unsupported", topic }
//
//  ── WHY IT IS DETERMINISTIC ────────────────────────────────────────
//
//  §2.2 lets a model determine what the operator MEANT. It may not state
//  operating truth. A lexicon keeps that boundary structural rather than
//  instructional: there is no model client here to turn off, so "the
//  governed answer still works with the model unavailable" is true by
//  construction rather than by test.
//
//  The technician SMS path already resolves intent this way
//  (`src/conversation/technician_intent.js`), and it has held. This is
//  the same discipline on the operator side.
//
//  A model may LATER produce this same three-value output — the seam is
//  the return shape, not a hook — and the governed executor downstream
//  would not change at all. That is the point of putting the boundary
//  here.
//
//  ── AMBIGUITY IS NOT PERMISSION TO GUESS ───────────────────────────
//
//  "What's wrong with maintenance?" matches both supported intents. The
//  resolver does NOT pick whichever has more records; it returns
//  `clarification_required` with the candidates and lets the operator
//  say which they meant. Clarification is a pre-answer state: it is not
//  decision-grade and earns no read receipt.
//
//  ── THE FRONTIER IS PART OF THE ANSWER ─────────────────────────────
//
//  "What's blocked right now?" is recognised and REFUSED. Blocked work
//  has a governed onset and no governed resolution
//  (docs/build1/INTENT_2_SOURCE_AUDIT.md), so the honest response names
//  the question as unsupported rather than answering it from a stale
//  onset. Recognising the topic is what lets us say so precisely.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

/*  Each supported intent's cue set. Deliberately narrow: a cue that
 *  matches too much produces confident misrouting, which is worse than
 *  asking. */
const SUPPORTED = [
  {
    intent_slug: "maintenance.completion_without_valid_proof",
    label: "completion proof",
    asks: "Which completed maintenance work doesn't have valid proof?",
    cues: [
      /\bproof\b/i,
      /\bevidence\b/i,
      /\bphotos?\b/i,
      /\b(unverified|unproven|not\s+proven)\b/i,
      /\bcomplet\w+\b[\s\S]{0,24}\b(proof|evidence|photo)/i,
      /\b(proof|evidence|photo)\b[\s\S]{0,24}\bcomplet\w+/i,
    ],
  },
  {
    intent_slug: "maintenance.ownership_and_acceptance",
    label: "assignment and acceptance",
    asks: "Who is assigned to maintenance work, and have they accepted it?",
    cues: [
      /\bassign\w*\b/i,
      /\baccept\w*\b/i,
      /\bunassigned\b/i,
      //  An adverb may sit between. "Who actually took the work" is the
      //  same question as "who took the work".
      /\bwho\s+(\w+\s+)?(is|has|had|took|takes|picked|accepted|owns)\b/i,
      /\bnobody\b/i,
      /\bowner\b/i,          // the operator may SAY owns; we still answer in
      /\bowns?\b/i,          // assigned/accepted terms — see the renderer
    ],
  },
];

/*  Topics we can NAME but cannot answer. Recognising them is what turns
 *  "I don't understand" into "that question is not currently supported",
 *  which is a materially more useful thing to tell an operator. */
const UNSUPPORTED_TOPICS = [
  {
    topic: "blocked_work",
    why: "blocked work has a governed onset but no governed resolution, so " +
         "\"what is blocked now\" cannot be answered without guessing",
    cues: [/\bblock\w*\b/i, /\bstuck\b/i, /\bheld\s*up\b/i, /\bwaiting\s+on\b/i],
  },
  {
    topic: "cost",
    why: "spend is not linked to a work order by any governed fact",
    cues: [/\bcost\w*\b/i, /\bspend\w*\b/i, /\bbudget\b/i, /\$\s*\d/],
  },
  {
    topic: "accountability",
    why: "institutional accountability is not modelled; assignment and " +
         "acceptance are not the same thing",
    cues: [/\baccountab\w+\b/i, /\bfault\b/i, /\bto\s+blame\b/i, /\bwhose\s+fault\b/i],
  },
];

/*  Words that ask for a general survey without naming a subject. On
 *  their own they are not enough to choose, and that is the point. */
const VAGUE = [/\bwhat'?s?\s+wrong\b/i, /\bproblems?\b/i, /\bissues?\b/i,
               /\bneeds?\s+attention\b/i, /\bhow\s+are\s+we\b/i, /\bstatus\b/i];

const countMatches = (text, cues) => cues.filter((re) => re.test(text)).length;

/**
 * Resolve a free-text operator question.
 *
 * @param text        what the operator typed
 * @param preferred   an optional intent slug the operator chose in answer
 *                    to a clarification. It is honoured ONLY if it is a
 *                    supported slug — a client cannot introduce an intent
 *                    by naming one.
 */
function resolve(text, { preferred = null } = {}) {
  const q = String(text || "").trim();
  if (!q) return { resolution: "clarification_required", reason: "empty_question",
                   candidates: SUPPORTED.map(publicShape) };

  //  An explicit choice short-circuits the lexicon — this is how a
  //  clarification is answered, and how a caller resolves an intent
  //  deterministically with no language involved at all.
  if (preferred) {
    const hit = SUPPORTED.find((s) => s.intent_slug === preferred);
    return hit
      ? { resolution: "resolved", intent_slug: hit.intent_slug, via: "explicit_choice" }
      : { resolution: "unsupported", topic: "unknown_intent",
          why: "that intent is not in the supported set" };
  }

  /*  AN EXPLICITLY UNSUPPORTED TOPIC WINS OVER A LEXICON MATCH.
   *
   *  This ordering is a correction, and the case that forced it matters:
   *  "Who is accountable for this?" matched the ownership cue `who is`
   *  and resolved to assignment/acceptance — answering a DIFFERENT
   *  question than the one asked, in the exact area where the difference
   *  is the whole point. Assignment is not accountability, so a question
   *  that names accountability must be refused even though it is shaped
   *  like one we can answer. Refusing the right question beats answering
   *  the wrong one confidently. */
  for (const t of UNSUPPORTED_TOPICS) {
    if (countMatches(q, t.cues) > 0) {
      return { resolution: "unsupported", topic: t.topic, why: t.why };
    }
  }

  const scored = SUPPORTED
    .map((s) => ({ s, n: countMatches(q, s.cues) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);

  //  AMBIGUITY FIRST. Two supported intents both matching is a question
  //  we must not answer by picking the bigger population.
  if (scored.length > 1 && scored[0].n === scored[1].n) {
    return { resolution: "clarification_required", reason: "ambiguous",
             candidates: scored.map((x) => publicShape(x.s)) };
  }
  if (scored.length >= 1) {
    return { resolution: "resolved", intent_slug: scored[0].s.intent_slug, via: "lexicon" };
  }

  //  A general survey with no subject. Ask rather than guess — and in
  //  particular do NOT fall through to `maintenance.attention`, which is
  //  deliberately unfrozen and is not part of this surface.
  if (countMatches(q, VAGUE) > 0) {
    return { resolution: "clarification_required", reason: "too_general",
             candidates: SUPPORTED.map(publicShape) };
  }

  return { resolution: "unsupported", topic: "not_recognised",
           why: "that question is outside the governed set this surface supports" };
}

const publicShape = (s) => ({ intent_slug: s.intent_slug, label: s.label, asks: s.asks });

module.exports = {
  resolve,
  SUPPORTED_INTENTS: SUPPORTED.map(publicShape),
  UNSUPPORTED_TOPICS: UNSUPPORTED_TOPICS.map((t) => ({ topic: t.topic, why: t.why })),
};
