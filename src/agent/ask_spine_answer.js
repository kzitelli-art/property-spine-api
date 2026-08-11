//  ════════════════════════════════════════════════════════════════════
//  ask_spine_answer.js — ASK SPINE, SLICE 2: ANSWER A TYPED QUESTION
//
//  Slice 1 was one button and one question. This is the operator typing
//  a sentence and getting an answer from THIS property's real data.
//
//  ── READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────
//
//  Every read below is a select. There is no write path in this file and
//  no service here that has one. The model is never given a tool, an
//  identifier to act on, or a route — it is given facts and asked to
//  speak about them. Making Ask Spine able to DO something is a separate
//  slice with its own authority rules; it is not one prompt away.
//
//  ── THE MODEL IS A NARRATOR, NOT A SOURCE ───────────────────────────
//
//  Everything the answer may contain is gathered first, by the same
//  canonical services every other surface reads. The model receives that
//  bundle and the question, and is instructed to answer ONLY from it.
//
//  That is a real constraint, not a hope, and it is why `grounded_on`
//  travels back with every answer: the caller can show what the answer
//  was built from. An answer nobody can trace is the confident-wrong this
//  codebase refuses, and a chat box is the easiest place in a product to
//  ship one.
//
//  ── WHAT HAPPENS WHEN IT CANNOT ANSWER ──────────────────────────────
//
//  It says so. Three failure shapes, all distinguishable by the caller:
//
//    unavailable   the model could not be reached, or no key is set.
//                  NOT an empty answer — the operator is told the
//                  assistant is down, not that nothing is happening.
//    out_of_scope  a real question this slice cannot answer from the
//                  facts it is allowed to read.
//    answered      grounded in the bundle.
//
//  A read failure NEVER arrives shaped like "nothing to report". That
//  distinction is the whole reason this file has three outcomes instead
//  of a string.
//  ════════════════════════════════════════════════════════════════════
"use strict";

const askSpineService = require("./ask_spine_service");
const workOrderRead = require("../surfaces/work_order_status_read");

const MODEL = process.env.ASK_SPINE_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 700;
const MAX_QUESTION = 500;

/*  The bundle. Bounded on purpose: every field here is something the
 *  operator could already see on a surface they are entitled to, read
 *  through the same services those surfaces use. Nothing is derived a
 *  second time, so Ask Spine cannot disagree with the board about a fact
 *  they both show.  */
async function gatherFacts(db, { property_id, allowed_modules }) {
  const facts = { property_id, gathered_at: new Date().toISOString() };
  const failures = [];

  try {
    const a = await askSpineService.attention(db, { property_id, allowed_modules });
    facts.attention = {
      total_open: a.total_open,
      scope_note: a.scope_note,
      items: (a.items || []).map((i) => ({
        label: i.label, module: i.module, type: i.type,
        due_at: i.due_at, is_overdue: i.is_overdue, is_unassigned: i.is_unassigned,
      })),
    };
  } catch (e) { failures.push("attention"); }

  try {
    const wo = await workOrderRead.readPropertyWorkOrderStatuses(db, { propertyId: property_id, limit: 50 });
    const list = (wo && wo.work_orders) || [];
    facts.work_orders = {
      count: list.length,
      items: list.map((w) => ({
        reference: w.work_order && w.work_order.reference,
        unit: (w.work_order && w.work_order.unit_number) || "common area",
        title: w.work_order && w.work_order.title,
        state: w.current && w.current.state,
        accountable: w.current && w.current.accountable === "UNASSIGNED"
          ? "UNASSIGNED"
          : (w.current && w.current.accountable && w.current.accountable.name) || null,
        assigned_to: w.current && w.current.assigned_to ? w.current.assigned_to.name : null,
        next_action: w.next_action || null,
        opened_at: w.work_order && w.work_order.opened_at,
      })),
    };
  } catch (e) { failures.push("work_orders"); }

  facts.reads_that_failed = failures;
  return facts;
}

/*  THE INSTRUCTION IS THE PRODUCT.
 *
 *  Everything that keeps this honest is written here, and each line was
 *  chosen against a specific way a chat box lies:
 *
 *    · inventing a number nobody read
 *    · answering a question about a property the operator cannot see
 *    · turning "I don't have that" into a plausible guess
 *    · describing what it would do, as though it had done it
 *    · reciting internal vocabulary at a person who wanted a sentence  */
function systemPrompt() {
  return [
    "You are Spine, the assistant inside a property-management system.",
    "You are answering a signed-in operator about ONE property.",
    "",
    "ABSOLUTE RULES:",
    "1. Answer ONLY from the FACTS JSON provided in the user message. It is the",
    "   complete set of things you know. If the answer is not derivable from it,",
    "   say plainly that you do not have that yet — never guess, never estimate,",
    "   and never present a plausible number as a real one.",
    "2. You cannot take actions. You cannot assign, message, schedule, close or",
    "   change anything. If asked to, say what you can see and that doing it is",
    "   not something you can do yet. Do not describe an action as though you",
    "   performed it.",
    "3. If `reads_that_failed` is non-empty, say that part of the picture could",
    "   not be read. Do not report a failed read as 'nothing to report' — those",
    "   are different facts and confusing them is the worst thing you can do.",
    "4. Nothing being open is a real, good answer. Say it plainly and stop.",
    "   Do not manufacture concerns to seem useful.",
    "",
    "HOW TO SOUND:",
    "· Talk like a competent colleague, not a database. Short sentences.",
    "· Lead with the answer. No preamble, no restating the question.",
    "· Refer to work by unit and issue ('Unit 631, broken toilet'), and include",
    "  the work-order number when you have it.",
    "· Never use internal vocabulary: obligation, proof evaluation, canonical",
    "  writer, lifecycle state, accountable rail, module entitlement. Say who",
    "  has it, what is happening, and what is next.",
    "· 'UNASSIGNED' means nobody has taken it. Say 'nobody has taken this yet'.",
    "· Assigned and accepted are different. Someone can be assigned and not have",
    "  accepted; say 'waiting for X to accept', not 'X is working on it'.",
    "· Under 120 words unless the operator asked for a list.",
  ].join("\n");
}

/**
 * Answer a typed question about one property.
 *
 * @param anthropic  the shared SDK client (injected — this module holds no key)
 * @returns { outcome, answer, grounded_on, model }
 */
async function answer(db, anthropic, { property_id, allowed_modules, question }) {
  if (!property_id) throw new Error("ask_spine.answer requires a server-derived property_id");

  const q = String(question || "").trim();
  if (!q) {
    return { outcome: "out_of_scope", answer: "Ask me something about this property's work.",
             grounded_on: null };
  }
  if (q.length > MAX_QUESTION) {
    return { outcome: "out_of_scope",
             answer: `That question is longer than I can take in (${MAX_QUESTION} characters). Try a shorter one.`,
             grounded_on: null };
  }

  //  NO KEY IS NOT AN EMPTY ANSWER. Without this the operator would ask a
  //  question and get silence, which reads as "nothing is happening here".
  if (!anthropic) {
    return { outcome: "unavailable",
             answer: "I can't answer right now — the assistant isn't reachable. " +
                     "The rest of the dashboard is unaffected.",
             grounded_on: null };
  }

  const facts = await gatherFacts(db, { property_id, allowed_modules });

  let text = "";
  try {
    const ai = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(),
      messages: [{
        role: "user",
        content: `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nOPERATOR ASKED: ${q}`,
      }],
    });
    text = (ai.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  } catch (e) {
    //  The model failed. Say that. An operator who is told "nothing needs
    //  attention" when the assistant actually fell over has been lied to.
    console.error("ask-spine/answer model error", e && e.message);
    return { outcome: "unavailable",
             answer: "I couldn't reach the assistant just then. Try again in a moment.",
             grounded_on: null };
  }

  if (!text) {
    return { outcome: "unavailable",
             answer: "I couldn't put an answer together just then. Try again in a moment.",
             grounded_on: null };
  }

  return {
    outcome: "answered",
    answer: text,
    model: MODEL,
    //  What the answer was built from. The caller shows this so a claim
    //  is checkable — the counts, not the rows, because the rows are
    //  already on the surfaces the operator can open.
    grounded_on: {
      open_items: facts.attention ? facts.attention.total_open : null,
      work_orders: facts.work_orders ? facts.work_orders.count : null,
      reads_that_failed: facts.reads_that_failed,
      gathered_at: facts.gathered_at,
    },
  };
}

module.exports = { answer, gatherFacts, systemPrompt, MODEL };
