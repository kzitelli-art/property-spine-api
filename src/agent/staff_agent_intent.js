// ════════════════════════════════════════════════════════════════════
//  staff_agent_intent.js — WHICH GOVERNED ACTION IS THIS MESSAGE?
//
//  Class 1, permanent product primitive. PURE: no database, no I/O, no clock,
//  no network, no model call. Sibling of the Build 1/2 interpreters and bound
//  by the same rule: it PROPOSES, a human CONFIRMS, nothing here is truth.
//
//  ── IT CLASSIFIES INTO EXISTING ACTIONS ONLY ────────────────────────
//  Every intent maps to a Build 1-4 canonical service. There is no
//  agent-only action, and `unclear` is a first-class answer rather than a
//  failure — most of the value here is refusing to guess.
//
//  ── THE BIAS IS TOWARD ASKING ───────────────────────────────────────
//  "304 is bad" and "I fixed it" are not interpretable. Proposing something
//  confident from either would put a wrong durable fact under a human's name.
//  One concise question costs a tap; a wrong confirmed action costs a
//  correction with history.
//
//  ── BUILD 6B: WHAT A MESSAGE MAY DO SHRANK ──────────────────────────
//  A staff message serves exactly three purposes, and each maps to exactly
//  one canonical service:
//
//      report a condition · add or correct turn scope · report completed work
//
//  FOUR things were removed from that list, and each removal is the same
//  argument: a governed action already has a structured door that carries its
//  authority, its entry conditions and its history, and a second door reached
//  by typing a sentence is a weaker copy of it.
//
//      accepting work        → a tap on the work item (BUILD 3)
//      certifying readiness  → the final readiness walk (BUILD 4)
//      a FAILED final walk   → the same walk (BUILD 4)
//      a generic correction  → the affected record's own correction path
//
//  None of them produce a proposal. They produce a REDIRECT, which never
//  enters the proposal lifecycle, so there is no row anybody could confirm.
//  The guarantee is that the state does not exist, not that a confirmation is
//  refused later.
//
//  A failed final walk is the sharpest case. It reopens work, records findings
//  and moves a unit's readiness — Build 4 does all three in one governed act
//  with authority attached. A message that did the same thing would be a
//  second final-walk door, and the two would drift.
// ════════════════════════════════════════════════════════════════════

"use strict";

const INTENT = Object.freeze({
  TRIAGE: "initial_triage",
  SCOPE: "turn_scope",
  COMPLETE: "work_completion",
  REDIRECT: "redirect",
  UNCLEAR: "unclear",
});
const INTENT_VALUES = Object.freeze(Object.values(INTENT));

//  THREE confirmable actions, three canonical services. `redirect` and
//  `unclear` are response types and may call nothing.
const INTENT_SERVICE = Object.freeze({
  initial_triage: "unitTriageService.confirmTriage (BUILD 1)",
  turn_scope: "unitTurnScopeService.confirmScope (BUILD 2)",
  work_completion: "workAcceptanceService.claimCompletion (BUILD 3)",
  redirect: "none — this is a redirect to a structured action, not a proposal",
  unclear: "none — no service may be called",
});
const CONFIRMABLE_INTENTS = Object.freeze(["initial_triage", "turn_scope", "work_completion"]);

//  RETIRED (BUILD 6B). No message produces these any more. Rows written before
//  this build may still carry them, and those rows stay readable history — but
//  they can never be confirmed, because the action they name is no longer
//  something a message may do. Kept as data, not as a code path.
const RETIRED_INTENTS = Object.freeze([
  "work_acceptance", "readiness_request", "failed_final_walk", "correction",
]);

//  ── ONE OPERATOR CONCEPT FOR "I NEED ONE MORE DETAIL" ───────────────
//  Internally there were two: the intent `unclear` (the message did not map to
//  a governed action) and the status `clarification_required` (it mapped, but
//  something is missing). To an operator that is one situation with one
//  response — answer the question — so it is presented as one thing.
//
//  New proposals emit ONE status. Old rows may carry either, so the reader
//  below accepts both. No migration: rewriting history to tidy a label would
//  edit what was recorded.
const CLARIFICATION_STATUS = "clarification_required";
const CLARIFICATION_LABEL = "Needs clarification";

function needsClarification(p) {
  if (!p) return false;
  return p.status === CLARIFICATION_STATUS || p.intent === INTENT.UNCLEAR;
}

//  ── PLAIN OPERATING LANGUAGE FOR EVERY INTENT ───────────────────────
//  Defined beside the intents themselves so there is exactly one place that
//  decides what an operator is shown, and no surface can drift from it. The
//  operator never sees `initial_triage` or `failed_final_walk` — those are our
//  vocabulary, not theirs.
//
//  The two RETIRED intents keep labels because rows written before BUILD 6B
//  still exist and must still read as sentences. A blank label on old history
//  would be a surface hiding what it holds.
const INTENT_PLAIN = Object.freeze({
  initial_triage: "You reported a unit condition",
  turn_scope: "You added work to the turn",
  work_completion: "You reported work complete",
  redirect: "You were pointed at the right place to do that",
  unclear: "Spine needs one more detail",
  // retired — history only
  work_acceptance: "You offered to take on work",
  readiness_request: "You asked about readiness",
  failed_final_walk: "You reported a failed final walk",
  correction: "You corrected something",
});

//  Plain operating language for a proposal's state. `clarification_required`
//  and `unclear` collapse into ONE label here, so no surface has to know there
//  were ever two internal names for it.
const STATUS_PLAIN = Object.freeze({
  proposed: "Waiting for you to confirm",
  confirmed: "Recorded",
  corrected: "Corrected",
  cancelled: "Cancelled",
  clarification_required: CLARIFICATION_LABEL,
});

function statusLabel(p) {
  if (!p) return null;
  if (needsClarification(p)) return CLARIFICATION_LABEL;
  return STATUS_PLAIN[p.status] || "Sent";
}

// A unit reference like "304" or "1417-02". Deliberately narrow: a bare
// number that is not unit-shaped should not become a unit.
const UNIT_REF = /\b(\d{1,4}(?:-\d{1,3})?)\b/;

// ── SIGNALS ─────────────────────────────────────────────────────────
const S = {
  correction: [/\bcorrection\b/i, /\bactually\s+it'?s\b/i, /\bi meant\b/i, /\bnot\s+\d{3,4}\b.*\bit'?s\b/i],
  failedWalk: [/\bfinal walk (failed|didn'?t pass)\b/i, /\bwalk failed\b/i, /\bfailed the (final )?walk\b/i],
  readiness: [/\b(is|it'?s)\s+ready\b/i, /\bready to (go|rent|lease|move.?in)\b/i, /\bcertify\b/i, /\bpass(ed)? the walk\b/i],
  accept: [/\bi'?ll\b/i, /\bi will\b/i, /\bi can (do|get|handle|take)\b/i, /\bi'?m on it\b/i, /\blet me\b/i, /\bi'?ve got (it|this)\b/i],
  complete: [/\b(is|are)\s+(installed|fixed|done|finished|complete[d]?|repaired|replaced)\b/i,
             /\b(i )?(fixed|finished|completed|installed|replaced|painted|cleaned)\b/i,
             /\bpaint(ing)? is done\b/i, /\ball set\b/i],
  scope: [/\bneeds?\b/i, /\brequires?\b/i, /\bpaint\b/i, /\bclean\b/i],
  vacancy: [/\b(is |it'?s )?(empty|vacant)\b/i, /\bmoved out\b/i, /\bnobody(?:'s| is)? (there|inside)\b/i],
};

// ── A CONCRETE OBSERVED CONDITION ───────────────────────────────────
//
//  "Report a condition" was purpose #1 of the message box, and until now a
//  bare condition report did not classify: triage was gated on vacancy
//  language, because BUILD 1 is post-move-out initial triage. So the box's own
//  first example — "There are cockroaches behind the refrigerator." — came
//  back as "What did you want to record?". The surface advertised a sentence
//  it could not read.
//
//  This does NOT make the classifier guess. It requires BOTH halves of an
//  observation a person could point at:
//
//      a CONCRETE THING          cockroaches · window · sink · carpet · outlet
//      and either a STATE        cracked · leaking · stained · does not latch
//      or a PRESENCE claim       "there is …" / "there are …"
//
//  "It is bad", "Needs work" and "There is an issue" have no concrete thing,
//  so they stay `unclear` and still ask. That is the line: a nameable object in
//  a nameable state, not a vague complaint.
//
//  What it produces is an OBSERVATION, and nothing more. Vacancy stays
//  whatever the BUILD 1 interpreter reads from the words — `uncertain` when
//  the message does not say — and inspection completeness is never upgraded.
//  An observed condition is not a complete inspection and not a turn scope.
const CONDITION_NOUN = new RegExp(
  "\\b(" + [
    "cockroach(es)?", "roach(es)?", "rodent(s)?", "mice", "mouse", "rat(s)?", "ant(s)?",
    "pest(s)?", "bed ?bug(s)?", "insect(s)?",
    "refrigerator", "fridge", "stove", "range", "oven", "dishwasher", "microwave",
    "washer", "dryer", "disposal", "water ?heater", "hvac", "furnace", "thermostat",
    "window(s)?", "door(s)?", "latch(es)?", "lock(s)?", "screen(s)?", "blind(s)?",
    "carpet(s|ing)?", "floor(s|ing)?", "tile(s)?", "baseboard(s)?", "wall(s)?",
    "ceiling(s)?", "cabinet(s)?", "counter(top)?(s)?", "closet(s)?",
    "sink(s)?", "faucet(s)?", "toilet(s)?", "tub(s)?", "shower(s)?", "drain(s)?", "pipe(s)?",
    "outlet(s)?", "switch(es)?", "breaker(s)?", "light(s)?", "fixture(s)?", "smoke ?detector(s)?",
    "water", "leak(s)?", "mold", "mildew", "odor(s)?", "hole(s)?", "crack(s)?", "stain(s)?",
  ].join("|") + ")\\b", "i");

const CONDITION_STATE = new RegExp(
  "\\b(" + [
    "cracked", "broken", "damaged", "missing", "leaking", "leak(s|ed)?", "dripping",
    "stained", "torn", "ripped", "dead", "clogged", "blocked", "loose", "dirty", "filthy",
    "mold(y|ed)?", "smell(s|y|ing)?", "stuck", "burnt", "burned", "chipped", "peeling",
    "not working", "not draining", "not closing",
  ].join("|") + ")\\b", "i");

//  "does not latch", "doesn't drain", "won't close" — a negated verb attached
//  to a concrete thing. The noun gate is what keeps this from matching
//  "it doesn't work".
const CONDITION_NEGATED = /\b(does\s+not|does\s?n'?t|will\s+not|wo\s?n'?t|can\s?n?o?'?t)\s+\w+/i;
const CONDITION_PRESENCE = /\bthere\s+(is|are|was|were)\b/i;

function isConcreteCondition(t) {
  if (!CONDITION_NOUN.test(t)) return false;
  return CONDITION_STATE.test(t) || CONDITION_NEGATED.test(t) || CONDITION_PRESENCE.test(t);
}
const any = (t, list) => list.some((re) => re.test(t));

// Paint and cleaning levels, only where the words carry them.
const PAINT_LEVEL = [
  { re: /\bfull(?:\s+unit)?\s+paint|paint(?:\s+the)?\s+(?:whole|full|entire)\s+unit|needs?\s+full\s+paint\b/i, v: "full" },
  { re: /\btouch[- ]?up\s+paint|paint\s+touch[- ]?up\b/i, v: "touch_up" },
  { re: /\bpartial\s+paint\b/i, v: "partial" },
];
const CLEAN_LEVEL = [
  { re: /\bdeep\s+clean\b/i, v: "deep" },
  { re: /\bfull\s+clean\b/i, v: "full" },
  { re: /\btouch[- ]?up\s+clean\b/i, v: "touch_up" },
];

/**
 * classifyIntent — PURE. One message → one candidate governed action.
 *
 * `context` carries what the app already knows so the operator is never asked
 * to repeat it: { unit_id, unit_number, open_work: [{id, work_text, stage, status}] }
 */
function classifyIntent(text, context = {}) {
  const t = String(text || "").trim();
  const out = {
    intent: INTENT.UNCLEAR,
    unit_ref: null,
    unknowns: [],
    clarification: null,
    proposed: {},
    interpreted_from: t,
    // Stated on every result. Nothing this function returns is truth.
    is_proposal: true,
  };

  if (!t) {
    out.clarification = "What did you want to record?";
    return out;
  }

  // ── ONE UNIT, OR A QUESTION ───────────────────────────────────────
  //
  //  Taking the FIRST unit-shaped token out of "there are cockroaches in 304
  //  and 305" silently drops the second and records the finding against one
  //  unit the operator never chose. Nothing wrong is written — a human still
  //  confirms — but they confirm against a unit the sentence did not settle.
  //
  //  So: more than one DISTINCT reference is a question, not a coin flip. The
  //  same number repeated is not two units.
  const allRefs = [...new Set((t.match(new RegExp(UNIT_REF.source, "g")) || []).map((x) => x.trim()))];
  out.unit_ref = allRefs.length === 1 ? allRefs[0] : null;
  if (allRefs.length > 1) {
    out.intent = INTENT.UNCLEAR;
    out.unit_refs = allRefs;
    out.clarification = `Which unit — ${allRefs.slice(0, 3).join(" or ")}?`;
    out.unknowns.push(
      `This message names ${allRefs.length} units (${allRefs.join(", ")}). One record belongs to one unit, ` +
      `so nothing is proposed until you say which.`);
    return out;
  }

  // ── A FAILED FINAL WALK IS THE WALK, NOT A MESSAGE (BUILD 6B) ──────
  //  "Final walk failed. The bathroom door still doesn't latch." used to
  //  propose a Build 4 failed walk. It no longer does anything of the kind.
  //
  //  A failed walk is not a report — it is a governed act that records the
  //  failed inspection, creates findings, reopens work and moves the unit's
  //  readiness, all under an authorised person's name. Reproducing that from a
  //  sentence makes the agent a second final-walk door, and two doors onto one
  //  act drift. The manager types the same finding INSIDE the structured
  //  action, where it stays attached to the walk that produced it.
  //
  //  Checked before completion, since the sentence contains condition words.
  if (any(t, S.failedWalk)) {
    out.intent = INTENT.REDIRECT;
    out.redirect = {
      to: "final_readiness",
      reason_code: "failed_walk",
      message: "Record this through the final readiness walk so the failed inspection, " +
               "findings, and reopened work remain governed.",
      link: "#final-readiness",
    };
    out.unknowns.push("Nothing has been recorded. The findings belong inside the walk, not in a message.");
    return out;
  }

  // ── READINESS IS A GOVERNED ACTION, NOT AN INTENT (BUILD 6B) ───────
  //  "304 is ready" is a SAFETY REDIRECT. It never enters the proposal
  //  lifecycle at all, so there is no row anybody could confirm — the
  //  structural guarantee is now that the state does not exist, rather than
  //  that a confirmation is refused later.
  if (any(t, S.readiness)) {
    out.intent = INTENT.REDIRECT;
    out.redirect = {
      to: "final_readiness",
      reason_code: "readiness_claim",
      message: "Readiness requires the final readiness walk. Open Final Readiness.",
      link: "#final-readiness",
    };
    out.unknowns.push("A message cannot certify readiness. The walk affirms every required area and is performed by an authorized manager.");
    return out;
  }

  // ── ACCEPTANCE IS A BUTTON, NOT A CONVERSATION (BUILD 6B) ──────────
  //  "I'll handle the refrigerator tomorrow" no longer produces a proposal.
  //  Ownership and a due commitment are consequential enough that they belong
  //  behind a deliberate tap on the work item, where the operator can see the
  //  proof requirement and what the commitment blocks. A sentence in a thread
  //  is too easy to send by accident and too easy to mean loosely.
  //
  //  This returns a REDIRECT. It is not confirmable, and nothing downstream
  //  can turn it into an acceptance.
  if (any(t, S.accept)) {
    out.intent = INTENT.REDIRECT;
    const target = resolveWorkTarget(t, context);
    out.redirect = {
      to: "work_item",
      work_id: target.work_id || null,
      message: target.work_id
        ? `${target.work_text} is ready to accept. Open the work item to confirm ownership and due timing.`
        : "Open the work item on this unit to accept it and set the due timing.",
      link: target.work_id ? `#work-${target.work_id}` : null,
    };
    out.unknowns.push("Nothing has been accepted. Ownership and due timing are set on the work item, not in a message.");
    return out;
  }

  // ── COMPLETION ── "the refrigerator is installed and working"
  if (any(t, S.complete)) {
    out.intent = INTENT.COMPLETE;
    const target = resolveWorkTarget(t, context);
    if (!target.work_id) {
      out.intent = INTENT.UNCLEAR;
      out.clarification = target.question;
      out.unknowns.push(target.why);
      return out;
    }
    const works = /\bworking\b|\bworks\b|\bcool(ing|s)\b|\blatch(es|ing)\b|\bheats?\b|\bno leak\b/i.test(t);
    out.proposed = {
      work_id: target.work_id, work_text: target.work_text,
      outcome: "completed",
      functional_confirmation: works ? t : null,
    };
    out.unknowns.push("Required proof is decided by the work item. Without it the claim is kept and the work stays open.");
    return out;
  }

  // ── TRIAGE vs SCOPE ── vacancy language points at the first walk.
  const paint = PAINT_LEVEL.find((x) => x.re.test(t));
  const clean = CLEAN_LEVEL.find((x) => x.re.test(t));

  if (any(t, S.vacancy)) {
    out.intent = INTENT.TRIAGE;
    out.proposed = { observation_text: t };
    out.unknowns.push("Inspection completeness is NOT assumed. This is initial triage unless you say otherwise.");
    if (!out.unit_ref && !context.unit_id) {
      out.intent = INTENT.UNCLEAR;
      out.clarification = "Which unit?";
      out.unknowns.push("No unit was named and none is open.");
    }
    return out;
  }

  // ── A CONCRETE OBSERVED CONDITION (release candidate) ─────────────
  //  Checked AFTER vacancy, so "304 is empty. There are cockroaches…" still
  //  takes the richer vacancy path, and BEFORE scope, so an observed defect is
  //  recorded as something SEEN rather than promoted to work somebody has
  //  decided to do. Turning an observation into scope would skip the human.
  if (isConcreteCondition(t)) {
    out.intent = INTENT.TRIAGE;
    out.proposed = { observation_text: t };
    out.unknowns.push("This is an observed condition. Vacancy is not assumed — the initial walk records what the words actually say.");
    out.unknowns.push("Inspection completeness is NOT assumed. One condition is not a complete inspection, and it is not a turn scope.");
    if (!out.unit_ref && !context.unit_id) {
      out.intent = INTENT.UNCLEAR;
      out.clarification = "Which unit?";
      out.unknowns.push("A condition has to be attached to a unit. None was named and none is open.");
    }
    return out;
  }

  if (paint || clean || (any(t, S.scope) && (/\bpaint\b/i.test(t) || /\bclean\b/i.test(t)))) {
    out.intent = INTENT.SCOPE;
    out.proposed = {
      paint_level: paint ? paint.v : null,
      cleaning_level: clean ? clean.v : null,
      // NEVER inferred. A scope message says nothing about whether the whole
      // unit was inspected.
      inspection_completeness: null,
    };
    if (/\bpaint\b/i.test(t) && !paint) {
      out.clarification = "Touch-up, partial, or full unit?";
      out.unknowns.push("Paint was mentioned but the level was not stated.");
    }
    out.unknowns.push("Inspection completeness was not stated and is not assumed.");
    if (!out.unit_ref && !context.unit_id) {
      out.intent = INTENT.UNCLEAR;
      out.clarification = "Which unit?";
    }
    return out;
  }

  // ── A GENERIC CORRECTION IS NOT AN AGENT ACTION (BUILD 6B) ─────────
  //
  //  Deliberately checked LAST, and that ordering is the whole design.
  //
  //  "Actually, it needs full paint" is not a correction mechanism — it is a
  //  new scope statement, and the scope branch above already classified it as
  //  `turn_scope`, which is the canonical path for changing scope. Build 2
  //  handles that correctly and keeps the superseded scope in history.
  //
  //  What is left here is a message trying to generically alter some earlier
  //  confirmed action — "I meant 304, not 305." Building a generic correction
  //  framework for that would mean one mechanism editing records owned by four
  //  different services, each with its own supersede rule and its own history.
  //  So it redirects to the record itself, where correction already works.
  if (any(t, S.correction)) {
    out.intent = INTENT.REDIRECT;
    const target = resolveWorkTarget(t, context);
    out.redirect = {
      to: "recorded_item",
      work_id: target.work_id || null,
      unit_id: context.unit_id || null,
      message: "Open the recorded item to correct it without erasing its history.",
      link: target.work_id ? `#work-${target.work_id}` : null,
    };
    out.unknowns.push("Nothing has been changed. A correction is made on the record it affects, and the original stays in history.");
    return out;
  }

  // ── UNCLEAR ── the honest default.
  out.clarification = out.unit_ref
    ? `What did you find in ${out.unit_ref}?`
    : "What did you want to record?";
  out.unknowns.push("This message does not map to a governed action, so nothing has been proposed.");
  return out;
}

// ── RESOLVING WHICH WORK ITEM ───────────────────────────────────────
//
//  Conversation proximity alone is NOT enough. If two work items remain
//  plausible, the answer is a question — an accepted commitment or a closed
//  item attached to the wrong work is a wrong durable fact with somebody's
//  name on it.
function resolveWorkTarget(text, context) {
  const open = (context.open_work || []).filter((w) => w.status === "required");
  if (!open.length) {
    return { work_id: null, question: "Which work item did you mean?", why: "No open work item is in context." };
  }

  // A noun in the message that names a specific item wins outright.
  const scored = open.map((w) => {
    const words = String(w.work_text || "").toLowerCase().match(/[a-z]{4,}/g) || [];
    const hits = words.filter((x) => new RegExp("\\b" + x + "\\b", "i").test(text)).length;
    return { w, hits };
  }).sort((a, b) => b.hits - a.hits);

  if (scored[0].hits === 0) {
    return {
      work_id: null,
      question: open.length === 1
        ? `Did you mean "${open[0].work_text}"?`
        : "Which work item did you complete?",
      why: "The message did not name a specific work item.",
      ambiguous: open.length > 1,
    };
  }
  // A TIE is ambiguity, not a coin flip.
  if (scored.length > 1 && scored[1].hits === scored[0].hits) {
    return {
      work_id: null,
      question: `Which one — ${scored.slice(0, 2).map((s) => `"${s.w.work_text}"`).join(" or ")}?`,
      why: "More than one open work item matches this message equally well.",
      ambiguous: true,
    };
  }
  return { work_id: scored[0].w.id, work_text: scored[0].w.work_text };
}

//  A photo with insufficient text is a CLARIFICATION, never a finding.
//  Nothing inspects the image.
function photoNeedsClarification(text, photos) {
  const t = String(text || "").trim();
  const hasPhoto = Array.isArray(photos) && photos.filter(Boolean).length > 0;
  if (!hasPhoto) return null;
  if (t.length >= 12) return null;
  return {
    clarification: "What condition or action are you reporting in this photo?",
    why: "A photo is evidence a person can look at. Nothing here inspects it, so the text has to say what it shows.",
  };
}

module.exports = {
  classifyIntent, resolveWorkTarget, photoNeedsClarification, isConcreteCondition,
  needsClarification, statusLabel,
  INTENT, INTENT_VALUES, INTENT_SERVICE, INTENT_PLAIN,
  CONFIRMABLE_INTENTS, RETIRED_INTENTS,
  CLARIFICATION_STATUS, CLARIFICATION_LABEL, STATUS_PLAIN, UNIT_REF,
};
