/* ════════════════════════════════════════════════════════════════════
   conversation/intent.js — TRANSPORT-INDEPENDENT INTENT INTERPRETATION.

   The first of the shared conversational seams, extracted from
   src/comms/tenantlink.js where it lived as a private closure reachable
   only through the SMS route.

   WHY IT MOVED. AGENT_CAPABILITY_SEAMS.md records the extraction trigger:
   before a SECOND conversational caller needs intent recognition,
   clarification or confirmation, those functions must become
   transport-independent services used by both paths. The dashboard bar is
   that second caller, so the trigger has fired. Extract once; do not copy
   processInboundClaim.

   THIS IS A MOVE, NOT A REDESIGN. Both functions below are the tenantlink
   originals, character-identical apart from de-indentation and taking
   `anthropic` / `model` as explicit dependencies rather than closing over
   the module factory's. SMS behaviour must be unchanged, and any behaviour
   change is a separate, argued slice.

   WHAT IT MAY AND MAY NOT DO. It interprets a message and returns a
   structured reading. It does NOT write work orders, assign priority,
   authorize actors, order work, or mark completion — those belong to
   canonical Property Spine services and projections. This module proposes
   an understanding; it decides nothing durable.

   TRANSPORT CONCERNS STAY OUT. No Twilio, no provider receipts, no SMS
   length or segmentation, no browser session, no UI rendering, no
   transport authentication. It takes text and returns a reading.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  Factory. `anthropic` and `model` are the only dependencies, and both are
 *  injected — the module reaches for nothing global and opens no socket of
 *  its own. A caller with no model still gets honest, fail-soft answers. */
module.exports = function makeIntentReader({ anthropic = null, model = null } = {}) {
  const INGEST_MODEL = model;

  const FIELD_CATEGORIES = ["plumbing","electric","heat_ac","appliance","lock_key",
                            "pest","paint_walls","internet","noise","cleaning","other"];
  const EMERGENCY_RX = /\b(fire|smoke|gas leak|smell gas|smells? like gas|carbon monoxide|water (pouring|gushing)|flood(ing)?|sewage|sewer back|sparking|burst pipe|broke(n)? in|break.?in|no heat)\b/i;
  const SENSITIVE_RX = /\b(evict|lawyer|attorney|legal action|sue|suing|court|harass|discriminat|unsafe|uninhabitable|habitab|mold|lead paint|withhold(ing)? rent|dispute)\b/i;

  const CLASSIFY_PROMPT =
  `You classify ONE tenant message for a property operating system. Respond with ONLY a JSON object, no markdown, no preamble:
  {"classification":"maintenance|balance|document|lease_question|emergency|general|unknown",
  "field_category":"plumbing|electric|heat_ac|appliance|lock_key|pest|paint_walls|internet|noise|cleaning|other",
  "urgency":"normal|high|emergency",
  "confidence":0.0,
  "needs_human":false,
  "summary":"one short line describing the issue",
  "suggested_title":"3-6 word work order title"}
  Rules: classification "emergency" only for active danger or major damage in progress (fire, gas, flooding, sewage, electrical hazard, security breach, no heat in cold weather). Legal threats, payment disputes, anger, harassment, habitability claims => needs_human true. If you are not sure what the tenant wants => classification "unknown", needs_human true. confidence is YOUR honest certainty 0-1.`;

  async function classifyMessage(body) {
    const hardEmergency = EMERGENCY_RX.test(body);
    const hardSensitive = SENSITIVE_RX.test(body);
    let ai = null;
    if (anthropic) {
      try {
        const resp = await anthropic.messages.create({
          model: INGEST_MODEL || "claude-sonnet-4-6",
          max_tokens: 300,
          messages: [{ role: "user", content: CLASSIFY_PROMPT + "\n\nTenant message:\n" + String(body).slice(0, 2000) }],
        });
        const text = (resp.content || []).filter(c => c.type === "text").map(c => c.text).join("");
        ai = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch (e) {
        console.error("classify AI failed (degrading to human queue):", e.message);
        ai = null; // fail-soft: the message is already saved; it goes to a human
      }
    }
    // Merge: hard overrides beat the model, both directions.
    const out = {
      classification: ai ? ai.classification : "unknown",
      field_category: ai && FIELD_CATEGORIES.includes(ai.field_category) ? ai.field_category : "other",
      urgency: ai ? ai.urgency : "normal",
      confidence: ai && typeof ai.confidence === "number" ? ai.confidence : 0,
      needs_human: ai ? !!ai.needs_human : true,
      summary: ai && ai.summary ? String(ai.summary).slice(0, 200) : null,
      suggested_title: ai && ai.suggested_title ? String(ai.suggested_title).slice(0, 80) : null,
    };
    if (hardEmergency) {
      out.classification = "emergency"; out.urgency = "emergency"; out.needs_human = true;
      // AI down or vague? Infer the trade from the words — honest, keyword-derived.
      if (out.field_category === "other") {
        if (/water|flood|pipe|sewage|sewer|leak|toilet/i.test(body)) out.field_category = "plumbing";
        else if (/spark|electrical|outlet|wires?\b/i.test(body)) out.field_category = "electric";
        else if (/no heat|heat\b|furnace|boiler/i.test(body)) out.field_category = "heat_ac";
        else if (/break.?in|broke(n)? in|door|lock/i.test(body)) out.field_category = "lock_key";
      }
    }
    if (hardSensitive) { out.needs_human = true; }
    if (out.classification === "emergency") out.needs_human = true; // AI-called emergencies too
    return out;
  }

  const ANSWER_VERDICTS = ["answers_question", "separate_problem", "both", "unclear"];
  async function recognizeAnswer({ question, reply }) {
    if (!anthropic) return "unclear";
    try {
      const r = await anthropic.messages.create({
        model: INGEST_MODEL || "claude-sonnet-4-6",
        max_tokens: 60,
        messages: [{ role: "user", content:
          `A property manager asked a resident this question about an open maintenance request:\n"${String(question).slice(0, 500)}"\n\n` +
          `The resident replied:\n"${String(reply).slice(0, 1000)}"\n\n` +
          `Reply with ONE word, no punctuation:\n` +
          `answers_question — the reply answers the question asked\n` +
          `separate_problem — the reply reports a DIFFERENT maintenance issue and does not answer\n` +
          `both — it answers AND raises a separate issue\n` +
          `unclear — you cannot tell` }],
      });
      const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim().toLowerCase();
      const hit = ANSWER_VERDICTS.find((v) => text.includes(v));
      return hit || "unclear";
    } catch (e) {
      console.error("recognizeAnswer failed (preserving and flagging):", e.message);
      return "unclear";
    }
  }

  return {
    classifyMessage,
    recognizeAnswer,
    //  Exposed so a harness can assert the vocabularies did not drift in the
    //  move, rather than trusting that they didn't.
    FIELD_CATEGORIES,
    ANSWER_VERDICTS,
    EMERGENCY_RX,
    SENSITIVE_RX,
  };
};
