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
//  It says so. Failure and refusal shapes remain distinguishable by the caller:
//
//    unavailable   the model could not be reached, or no key is set.
//                  NOT an empty answer — the operator is told the
//                  assistant is down, not that nothing is happening.
//    out_of_scope  a real question this slice cannot answer from the
//                  facts it is allowed to read.
//    not_authorized the session lacks the governed domain entitlement.
//    composition_unavailable the requested cross-domain disclosure has
//                  no established composition authority.
//    answered      grounded in the bundle.
//
//  A read failure NEVER arrives shaped like "nothing to report". That
//  distinction is the whole reason this file has three outcomes instead
//  of a string.
//  ════════════════════════════════════════════════════════════════════
"use strict";

const askSpineService = require("./ask_spine_service");
const workOrderRead = require("../surfaces/work_order_status_read");
const complianceRead = require("../asset/compliance_read");

const MODEL = process.env.ASK_SPINE_MODEL || "claude-opus-5";
/*  THINKING AND THE ANSWER SHARE THIS CEILING. On this model family
 *  thinking is on by default and `max_tokens` caps reasoning PLUS reply,
 *  not the reply alone. The old value here was 700 — sized for a two-line
 *  answer on a model that did not think — and it truncates mid-reasoning
 *  before a word is written. The reply itself is still short; the room is
 *  for the thinking in front of it.  */
const MAX_TOKENS = 4000;
/*  A bounded read-and-narrate task over facts that are already gathered:
 *  decide in-scope or not, then say one honest paragraph. That is not deep
 *  reasoning, and this is a dashboard where latency is felt. Tune by
 *  sweeping against the browser gate rather than by argument.  */
const EFFORT = process.env.ASK_SPINE_EFFORT || "medium";
const MAX_QUESTION = 500;

/*  ══ THE DECISION SHAPE, ENFORCED BY THE API ═══════════════════════
 *
 *  This replaces an assistant-turn prefill of `{`. That trick existed for
 *  a good reason — "a model that starts talking has already escaped the
 *  contract, and salvaging JSON out of prose is how a decline gets parsed
 *  as an answer" — but it was an approximation of a guarantee, and every
 *  current model REFUSES it outright:
 *
 *      400 invalid_request_error — "This model does not support assistant
 *      message prefill. The conversation must end with a user message."
 *
 *  The catch below turned that 400 into `unavailable`, so the surface said
 *  "I couldn't reach the assistant just then" forever. Honest, and
 *  indistinguishable from a real outage — which is exactly why it survived.
 *
 *  Structured outputs are the real mechanism the prefill was imitating: the
 *  API constrains the reply to this schema, so a reply that parses is not
 *  luck. `additionalProperties:false` and the `outcome` enum mean the
 *  two-outcome contract is refused at the wire rather than downstream.
 *
 *  ONLY WHAT THE MODEL DECIDES LIVES HERE. `grounded_on` is absent on
 *  purpose: the server builds it from the facts it gathered, so grounding
 *  is a thing Spine measured, never a thing the model claimed.  */
const DECISION_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["answered", "out_of_scope"] },
    answer: { type: "string" },
  },
  required: ["outcome", "answer"],
  additionalProperties: false,
};

/*  ══ THE SCOPE, DECLARED ONCE ══════════════════════════════════════
 *
 *  The first version of this slice had no scope at all. A text box was
 *  added and every sentence went to the model with a bundle of facts and
 *  an instruction to answer from them. That instruction bounds the DATA
 *  the model may cite. It does not bound the QUESTION. "Should I raise
 *  rents?" gets a confident, reasonable-sounding answer built from
 *  nothing, and `out_of_scope` only ever fired on an empty or oversized
 *  string — never on a topic.
 *
 *  A text box had quietly turned a governed read into a property chatbot.
 *
 *  So the scope is a CONSTANT, used in three places that must not drift:
 *  the model's instruction, the refusal the operator reads, and the test
 *  that pins both. One definition, no second opinion.
 *
 *  Widening it is a product decision with its own facts to gather. It is
 *  not something a prompt edit should be able to do quietly.  */
const SUPPORTED_SCOPE =
  "the current open work and governed Compliance records at this property — " +
  "what work is open and who has it, or whether a recorded Compliance item is " +
  "current, why, its evidence, expiration, unresolved facts, and next established action";

//  The refusal is OWNED BY THE SERVER, not written by the model. A model
//  that composes its own decline can talk itself into being helpful, and
//  "I can't really answer that, but generally…" is the failure this
//  outcome exists to prevent.
const OUT_OF_SCOPE_ANSWER =
  "I can only answer about " + SUPPORTED_SCOPE + ". " +
  "Ask me what needs attention, what is open, or about a recorded license or Compliance item.";

const COMPLIANCE_TERMS =
  /\b(compliance|licen[cs]e|registration|inspection|certificate|violation|cure|renewal|expire[sd]?|expiration)\b/i;
const EXPLICIT_WORK_TERMS =
  /\b(work[ -]?order|repair|maintenance|technician|task|job|assigned|assignment)\b/i;

function questionSubject(question) {
  const text = String(question || "");
  const compliance = COMPLIANCE_TERMS.test(text);
  const work = EXPLICIT_WORK_TERMS.test(text);
  if (compliance && work) return "composition_unavailable";
  return compliance ? "compliance" : "work";
}

/*  The bundle. Bounded on purpose: every field here is something the
 *  operator could already see on a surface they are entitled to, read
 *  through the same services those surfaces use. Nothing is derived a
 *  second time, so Ask Spine cannot disagree with the board about a fact
 *  they both show.  */
async function gatherFacts(db, {
  property_id, allowed_modules, subject = "work", mintComplianceReference,
  complianceReader = complianceRead,
}) {
  const facts = {
    property_id,
    gathered_at: new Date().toISOString(),
    question_subject: subject,
    __refs: [],
  };
  const failures = [];

  if (subject === "work") {
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
    /*  ── WHAT THE ANSWER REFERS TO, AS RECORDS ──────────────────────
     *  The prose above is the model's. These are not: each is an item
     *  the attention service already resolved to a durable target
     *  (`navigationFor`), carried through untouched so the caller can
     *  open the actual thing.
     *
     *  ON `__refs`, AND WHY IT IS NOT IN `items`: the model is never
     *  given a record id. It has no use for one, and a model holding
     *  ids is a model that can put an id in a sentence — at which point
     *  a link is a thing it composed rather than a thing Spine
     *  resolved. The two are different epistemic classes (§38) and only
     *  one of them is safe to click. The key is stripped explicitly
     *  when the facts are serialised for the model; see `answer`.  */
      facts.__refs = (a.items || [])
        .filter((i) => i.open && i.open.kind && i.open.id)
        .map((i) => ({
          label: i.label,
          module: i.module,
          due_at: i.due_at,
          is_overdue: !!i.is_overdue,
          is_unassigned: !!i.is_unassigned,
          open: { kind: i.open.kind, id: i.open.id },
        }));
    } catch (e) { failures.push("attention"); }

    try {
      const wo = await workOrderRead.readPropertyWorkOrderStatuses(db,
        { propertyId: property_id, limit: 50 });
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
  }

  if (subject === "compliance") {
    try {
      const standing = await complianceReader.readComplianceStanding(db, {
        property_id,
        as_of: new Date().toISOString().slice(0, 10),
        mintReference: mintComplianceReference,
      });
      facts.compliance = {
        contract_version: standing.contract_version,
        capability_classes: standing.capability_classes,
        composition_authorization: standing.composition_authorization,
        as_of: standing.as_of,
        coverage: standing.coverage,
        items: standing.items.map((item) => ({
          entity: {
            type: item.entity.type,
            compliance_type: item.entity.compliance_type,
            label: item.entity.label,
          },
          standing: item.standing,
          why: item.why,
          evidence: item.evidence.map((entry) => ({ role: entry.role, label: entry.label })),
          unresolved: item.unresolved,
          next: item.next,
          attention: item.attention,
        })),
      };
      facts.__refs = standing.references.map((reference) => ({
        label: reference.label,
        module: "compliance",
        open: {
          kind: reference.role === "canonical_record"
            ? "compliance_record" : "compliance_source",
          token: reference.opener.token,
        },
      }));
    } catch (e) { failures.push("compliance"); }
  }

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
function systemPrompt(subject = "work") {
  return [
    "You are Spine, the assistant inside a property-management system.",
    "You are answering a signed-in operator about ONE property.",
    "The server selected exactly one authorized question subject: " + subject + ".",
    "",
    "YOU ANSWER ABOUT EXACTLY ONE SUBJECT:",
    "  " + SUPPORTED_SCOPE + ".",
    "",
    "Anything else is out of scope — rent strategy, pricing, legal or tax advice",
    "questions, meetings and what was said in them, market conditions, vendors",
    "you were not given, people you were not given, other properties, anything",
    "historical you cannot see, and any general knowledge question. Being able",
    "to answer well is NOT a reason to answer. If it is not the subject above,",
    "it is out of scope even when you know the answer.",
    "",
    //  The SHAPE is enforced by the response schema, so this says which
    //  outcome to choose rather than how to format one. Instructing a
    //  format the API already guarantees only invites the model to spend
    //  attention on syntax it cannot get wrong.
    "YOUR REPLY CARRIES ONE OF TWO OUTCOMES:",
    '  "answered"       the question is in scope and the facts support an',
    "                   answer. Put it in `answer`.",
    '  "out_of_scope"   anything else. Leave `answer` empty — the system',
    "                   writes the refusal, not you.",
    "",
    //  ── OUT OF SCOPE IS ABOUT THE SUBJECT, NEVER ABOUT THE FACTS ────
    //  This rule used to read: out_of_scope when off-subject, AND when
    //  on-subject but the facts do not contain what is needed. That second
    //  clause was wrong twice over.
    //
    //  It was DISHONEST. Asked "who owns the overdue work?" with nothing
    //  overdue, it produced "I can only answer about the current open work
    //  at this property" — which tells the operator the subject is off
    //  limits when the truth is simply that there is none. The refusal
    //  misnames its own reason, and §5 is about showing what is missing as
    //  missing, not about declining to look.
    //
    //  It was also UNSTABLE. "Do the facts contain what is needed" is a
    //  judgement call with no edge, so the same question landed `answered`
    //  on one run and `out_of_scope` on the next — the browser gate caught
    //  exactly that, passing check 3 and then failing it with no change in
    //  between. A contract a model has to guess at is not a contract.
    //
    //  Subject is a question with an edge. Sufficiency is not. So scope is
    //  decided on subject alone, and thin facts are answered honestly.
    "Choose out_of_scope ONLY when the question is off-subject.",
    "",
    "An on-subject question is ALWAYS `answered`, including when the facts",
    "turn out to hold nothing. \"Nothing is overdue right now\" is an answer,",
    "and a true one. Refusing it as out of scope would tell the operator you",
    "cannot discuss the subject, which is a different claim and a false one.",
    "Say what is there and what is not. Never stretch the facts to fill an",
    "answer, and never invent one to avoid an empty-sounding reply.",
    "",
    "ABSOLUTE RULES FOR AN `answered` REPLY:",
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
    "5. The FACTS contain only one authorized subject. Never combine Compliance",
    "   with work, residents, finances or any absent domain. Composition authority",
    "   is not established merely because each domain could be read separately.",
    "6. For Compliance, item standing is not a property-wide legal conclusion.",
    "   An expiration date is not a renewal obligation, and a date-only next event",
    "   is not work that needs action. Preserve those distinctions exactly.",
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
async function answer(db, anthropic, {
  property_id, allowed_modules, question, mintComplianceReference, complianceReader,
}) {
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

  const subject = questionSubject(q);
  if (subject === "composition_unavailable") {
    return {
      outcome: "composition_unavailable",
      answer: "I can answer about Compliance or open work separately, but I can't combine them in one answer yet.",
      grounded_on: null,
      references: [],
    };
  }
  const modules = Array.isArray(allowed_modules) ? allowed_modules.map(String) : [];
  if (subject === "compliance" && !modules.includes("asset_management")) {
    return {
      outcome: "not_authorized",
      answer: "Compliance is not available in your current access for this property.",
      grounded_on: null,
      references: [],
    };
  }

  //  NO KEY IS NOT AN EMPTY ANSWER. Without this the operator would ask a
  //  question and get silence, which reads as "nothing is happening here".
  if (!anthropic) {
    return { outcome: "unavailable",
             answer: "I can't answer right now — the assistant isn't reachable. " +
                     "The rest of the dashboard is unaffected.",
             grounded_on: null };
  }

  const facts = await gatherFacts(db, {
    property_id, allowed_modules: modules, subject,
    mintComplianceReference, complianceReader,
  });

  let text = "";
  try {
    const ai = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(subject),
      //  The shape is enforced here, not coaxed. See DECISION_SCHEMA.
      output_config: { format: { type: "json_schema", schema: DECISION_SCHEMA }, effort: EFFORT },
      //  ENDS ON THE USER TURN. Nothing may follow it — see DECISION_SCHEMA
      //  for what the assistant prefill that used to sit here cost.
      messages: [
        //  `__refs` is STRIPPED HERE. The model gets labels and dates and
        //  never a record id — see gatherFacts for why a model holding ids
        //  is a model that can compose a link Spine did not resolve.
        { role: "user",
          content: `QUESTION SUBJECT: ${subject}\nFACTS:\n`
                   + `${JSON.stringify(facts, (k, v) => (k === "__refs" ? undefined : v), 2)}`
                   + `\n\nOPERATOR ASKED: ${q}` },
      ],
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

  /*  THE SERVER DECIDES THE OUTCOME, NOT THE PROSE.
   *
   *  Before this, the model returned free text and every non-empty reply
   *  was treated as `answered`. A decline written as a sentence — "I can't
   *  really answer that, but generally…" — was indistinguishable from a
   *  grounded answer, to this code and therefore to the operator.
   *
   *  Now the reply must PARSE and must carry one of exactly two outcomes.
   *  Anything else is `unavailable`: a model that did not follow the
   *  contract is a model whose answer cannot be trusted, and guessing what
   *  it meant is the whole failure mode.  */
  let decision = null;
  try { decision = JSON.parse(text); } catch (_) { decision = null; }

  if (!decision || (decision.outcome !== "answered" && decision.outcome !== "out_of_scope")) {
    console.error("ask-spine/answer: model did not return a valid decision");
    return { outcome: "unavailable",
             answer: "I couldn't put an answer together just then. Try again in a moment.",
             grounded_on: null };
  }

  if (decision.outcome === "out_of_scope") {
    //  The server's words, every time. See OUT_OF_SCOPE_ANSWER.
    return { outcome: "out_of_scope", answer: OUT_OF_SCOPE_ANSWER, grounded_on: null };
  }

  const body = String(decision.answer || "").trim();
  if (!body) {
    return { outcome: "unavailable",
             answer: "I couldn't put an answer together just then. Try again in a moment.",
             grounded_on: null };
  }

  return {
    outcome: "answered",
    answer: body,
    model: MODEL,
    //  THE RECORDS THE ANSWER IS ABOUT. Server-resolved, never parsed out
    //  of the prose: matching names in model output back to rows would
    //  invent a link every time two people share a first name, and would
    //  make the surface's most clickable element its least trustworthy.
    //  Empty is a legitimate answer — an operator can read the prose and
    //  simply have nothing to open.
    references: facts.__refs || [],
    //  What the answer was built from. The caller shows this so a claim
    //  is checkable — the counts, not the rows, because the rows are
    //  already on the surfaces the operator can open.
    grounded_on: {
      open_items: facts.attention ? facts.attention.total_open : null,
      work_orders: facts.work_orders ? facts.work_orders.count : null,
      compliance_items: facts.compliance ? facts.compliance.items.length : null,
      compliance_as_of: facts.compliance ? facts.compliance.as_of : null,
      composition_authorization: facts.compliance
        ? facts.compliance.composition_authorization : null,
      reads_that_failed: facts.reads_that_failed,
      gathered_at: facts.gathered_at,
    },
  };
}

module.exports = {
  answer, gatherFacts, questionSubject, systemPrompt, MODEL, SUPPORTED_SCOPE, OUT_OF_SCOPE_ANSWER,
};
