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
//  ── AND IT CAN NEVER CERTIFY READINESS ──────────────────────────────
//  "304 is ready" resolves to `readiness_request`, which at most proposes
//  OPENING the governed Build 4 action. There is no intent in this file that
//  can make a unit ready.
// ════════════════════════════════════════════════════════════════════

"use strict";

const INTENT = Object.freeze({
  TRIAGE: "initial_triage",
  SCOPE: "turn_scope",
  ACCEPT: "work_acceptance",
  COMPLETE: "work_completion",
  FAILED_WALK: "failed_final_walk",
  READINESS: "readiness_request",
  CORRECTION: "correction",
  UNCLEAR: "unclear",
});
const INTENT_VALUES = Object.freeze(Object.values(INTENT));

const INTENT_SERVICE = Object.freeze({
  initial_triage: "unitTriageService.confirmTriage (BUILD 1)",
  turn_scope: "unitTurnScopeService.confirmScope (BUILD 2)",
  work_acceptance: "workAcceptanceService.acceptWork (BUILD 3)",
  work_completion: "workAcceptanceService.claimCompletion (BUILD 3)",
  failed_final_walk: "readinessService.recordWalk outcome=not_ready (BUILD 4)",
  readiness_request: "readinessService.recordWalk (BUILD 4) — authority and confirmations still required",
  correction: "the canonical correction path for the affected action type",
  unclear: "none — no service may be called",
});

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

  const m = t.match(UNIT_REF);
  out.unit_ref = m ? m[1] : null;

  // ── CORRECTION ── highest precedence: it is about a prior action.
  if (any(t, S.correction)) {
    out.intent = INTENT.CORRECTION;
    out.proposed = { corrected_unit_ref: out.unit_ref };
    out.unknowns.push("A correction applies to the immediately preceding confirmed action. The original stays in history.");
    return out;
  }

  // ── FAILED FINAL WALK ── before generic completion, since it contains
  //    "failed" alongside condition words.
  if (any(t, S.failedWalk)) {
    out.intent = INTENT.FAILED_WALK;
    // Everything after the failure statement is the finding text.
    const after = t.replace(/^.*?(final walk (failed|didn'?t pass)|walk failed|failed the (final )?walk)\.?\s*/i, "");
    out.proposed = { findings_text: after.trim() || null };
    if (!after.trim()) {
      out.clarification = "What did the final walk find?";
      out.unknowns.push("No specific condition was named, so no work can be created.");
    }
    out.unknowns.push("This goes through the Build 4 failed-walk service. Its authority and entry conditions still apply.");
    return out;
  }

  // ── READINESS REQUEST ── never a certification.
  if (any(t, S.readiness)) {
    out.intent = INTENT.READINESS;
    out.proposed = { opens_governed_final_walk: true };
    out.unknowns.push(
      "This does NOT certify readiness. It can at most open the governed final readiness walk, which requires its own authority and every confirmation area affirmed.");
    return out;
  }

  // ── ACCEPTANCE ── "I'll handle it tomorrow"
  if (any(t, S.accept)) {
    out.intent = INTENT.ACCEPT;
    const target = resolveWorkTarget(t, context);
    out.proposed = { work_id: target.work_id, work_text: target.work_text, owner_is_speaker: true };
    if (!target.work_id) {
      out.intent = target.ambiguous ? INTENT.UNCLEAR : INTENT.UNCLEAR;
      out.clarification = target.question;
      out.unknowns.push(target.why);
      return out;
    }
    out.unknowns.push("Nothing is accepted until you confirm. Ownership and any due date are recorded only on confirmation.");
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
  classifyIntent, resolveWorkTarget, photoNeedsClarification,
  INTENT, INTENT_VALUES, INTENT_SERVICE, UNIT_REF,
};
