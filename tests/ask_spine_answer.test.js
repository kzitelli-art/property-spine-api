#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   ASK SPINE · SLICE 2 — THE HONESTY PROPERTIES

   A chat box is the easiest place in a product to ship a confident lie.
   It speaks in prose, so a fabricated number looks exactly like a read
   one, and the operator has no way to tell them apart.

   These are the properties that keep it honest, asserted rather than
   hoped for. DB-free and model-free: the database is a stub and the
   Anthropic client is a stub, because what is under test is the SEAM —
   what gets gathered, what the model is told, and what happens when it
   fails. Whether the model writes a good sentence is not something a
   unit test can decide.

       node tests/ask_spine_answer.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const answerModule = require(path.join(__dirname, "..", "src/agent/ask_spine_answer.js"));

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

//  A database that answers the two reads the bundle is built from.
const stubDb = (over) => ({
  query: async (sql) => {
    if (over && over.throwOn && sql.includes(over.throwOn)) throw new Error("read failed");
    if (/from obligations/.test(sql)) {
      return { rows: (over && over.obligations) || [] };
    }
    return { rows: (over && over.rows) || [] };
  },
});

/*  A model that records what it was asked and returns what we tell it to.
 *
 *  It returns a WHOLE object, because that is what a schema-constrained
 *  reply is. This stub used to return the remainder of one — `.slice(1)`,
 *  dropping a brace the service prepended — which was faithful to the
 *  prefill contract while that contract existed. It no longer does: every
 *  current model rejects an assistant prefill with a 400, and the shape is
 *  enforced by the response schema instead.
 *
 *  `raw` still bypasses the shape, because the service must keep refusing a
 *  reply it cannot parse. The schema makes that unreachable through the
 *  real API; it does not make the branch unnecessary, and a stub is the
 *  only way left to reach it.  */
const stubAI = (behaviour) => ({
  messages: {
    create: async (req) => {
      if (behaviour && behaviour.throws) throw new Error("model down");
      if (behaviour) behaviour.lastRequest = req;
      if (behaviour && behaviour.raw !== undefined) {
        return { content: [{ type: "text", text: behaviour.raw }] };
      }
      const outcome = (behaviour && behaviour.outcome) || "answered";
      const answer = behaviour && "text" in behaviour ? behaviour.text : "Nothing is open right now.";
      return { content: [{ type: "text", text: JSON.stringify({ outcome, answer }) }] };
    },
  },
});

const PROP = "11111111-1111-4111-8111-111111111111";
const base = { property_id: PROP, allowed_modules: ["maintenance"] };

(async function main() {
  console.log("\n" + "═".repeat(66));
  console.log("  ASK SPINE · SLICE 2 — honesty properties");
  console.log("═".repeat(66));
  console.log("  ASSERTIONS STARTED\n");

  // ── A · AUTHORITY ─────────────────────────────────────────────────
  let threw = null;
  try { await answerModule.answer(stubDb(), stubAI({}), { question: "hi" }); }
  catch (e) { threw = e; }
  ok("A1  no server-derived property_id → it THROWS rather than answering",
     !!threw && /server-derived property_id/.test(threw.message),
     "it answered without knowing which property it was talking about");

  // ── U · UNAVAILABLE IS NOT AN EMPTY ANSWER ────────────────────────
  //  The single most dangerous failure this surface has. An operator told
  //  "nothing needs attention" when the assistant fell over will act on
  //  it.
  const noKey = await answerModule.answer(stubDb(), null, { ...base, question: "what's open?" });
  ok("U1  with NO model client, the outcome is `unavailable`",
     noKey.outcome === "unavailable", JSON.stringify(noKey));
  ok("U2  …and it says the assistant is unreachable, not that nothing is happening",
     /can't answer|isn't reachable|unreachable/i.test(noKey.answer) &&
     !/nothing|no open|all clear/i.test(noKey.answer),
     "the outage message reads like an empty result: " + noKey.answer);
  ok("U3  …and it carries NO grounding, because it read nothing",
     noKey.grounded_on === null);

  const modelDown = await answerModule.answer(stubDb(), stubAI({ throws: true }),
    { ...base, question: "what's open?" });
  ok("U4  when the model THROWS, the outcome is `unavailable` — not a guess",
     modelDown.outcome === "unavailable" && modelDown.grounded_on === null,
     JSON.stringify(modelDown));

  const empty = await answerModule.answer(stubDb(), stubAI({ text: "   " }),
    { ...base, question: "what's open?" });
  ok("U5  an EMPTY model response is `unavailable`, not a blank answer",
     empty.outcome === "unavailable",
     "a blank string was passed through to the operator as an answer");

  // ── Q · THE QUESTION ──────────────────────────────────────────────
  const blank = await answerModule.answer(stubDb(), stubAI({}), { ...base, question: "   " });
  ok("Q1  an empty question is out_of_scope and never reaches the model",
     blank.outcome === "out_of_scope");
  const huge = await answerModule.answer(stubDb(), stubAI({}),
    { ...base, question: "x".repeat(5000) });
  ok("Q2  an oversized question is refused with a sayable reason",
     huge.outcome === "out_of_scope" && /longer than I can take in/.test(huge.answer));

  // ── G · THE MODEL IS A NARRATOR, NOT A SOURCE ─────────────────────
  const spy = {};
  const answered = await answerModule.answer(
    stubDb({ obligations: [{ id: "o1", label: "Fix leak", module: "maintenance", type: "repair",
                             due_at: null, is_overdue: false, is_unassigned: true, total_open: 1 }] }),
    stubAI(spy), { ...base, question: "what needs attention?" });

  ok("G1  a normal question is `answered`", answered.outcome === "answered", JSON.stringify(answered));
  ok("G2  …and the answer carries what it was grounded on",
     !!answered.grounded_on && "open_items" in answered.grounded_on &&
     "work_orders" in answered.grounded_on,
     JSON.stringify(answered.grounded_on));
  ok("G3  the model was given the FACTS bundle and the question, in one message",
     !!spy.lastRequest && /FACTS:/.test(spy.lastRequest.messages[0].content) &&
     /OPERATOR ASKED: what needs attention\?/.test(spy.lastRequest.messages[0].content));
  /*  ── REFERENCES ARE RESOLVED, NEVER PARSED ──────────────────────────
   *  The answer carries openable records so the operator can go to the
   *  thing that was described. They come from the attention service's own
   *  `navigationFor`, not from matching names in the prose — two residents
   *  sharing a first name is all it takes for a parsed link to open the
   *  wrong person's card, and the most clickable thing on the surface
   *  would be the least trustworthy.
   *
   *  The model is therefore never given an id. It cannot put one in a
   *  sentence it did not get.  */
  ok("R1  the answer carries a references array",
     Array.isArray(answered.references), JSON.stringify(answered.references));
  ok("R2  …and the FACTS given to the model contain NO record ids",
     !/__refs/.test(spy.lastRequest.messages[0].content) &&
     !/"open"\s*:/.test(spy.lastRequest.messages[0].content),
     "the model was handed navigation targets; it can now compose a link " +
     "Spine never resolved");
  ok("G4  …and the facts it was given name the server-derived property",
     spy.lastRequest.messages[0].content.includes(PROP),
     "the model was not told which property it is talking about");

  //  THE INSTRUCTION IS THE PRODUCT. If these sentences go missing, the
  //  surface can fabricate and nothing else here would notice.
  const sys = spy.lastRequest.system;
  ok("S1  the system prompt forbids answering from anything but the facts",
     /ONLY from the FACTS/.test(sys) && /never guess/.test(sys),
     "the anti-fabrication instruction is gone");
  ok("S2  …forbids claiming actions it cannot take",
     /cannot take actions/i.test(sys) && /as though you/i.test(sys));
  ok("S3  …requires a failed read to be named, not reported as nothing",
     /reads_that_failed/.test(sys) && /nothing to report/.test(sys));
  ok("S4  …allows 'nothing is open' as a real answer without manufacturing concern",
     /real, good answer/.test(sys) && /Do not manufacture/.test(sys));
  ok("S5  …bans the internal vocabulary from reaching a human",
     /obligation/.test(sys) && /proof evaluation/.test(sys) && /canonical/.test(sys),
     "the jargon ban is gone — answers will start saying 'obligation' to an operator");
  ok("S6  …keeps assignment and acceptance distinct",
     /Assigned and accepted are different/.test(sys) &&
     /waiting for X to accept/.test(sys),
     "the distinction the whole work-order rail is built on is missing from the voice");

  // ── B · THE BOUNDARY · scope is enforced, not hoped for ───────────
  //  The defect this section exists for: the first version of this slice
  //  had a text box and NO scope. Every sentence went to the model, and
  //  `out_of_scope` fired only on an empty or oversized string — never on
  //  a topic. "Should I raise rents?" got a confident answer built from
  //  nothing. A text box had quietly made a governed read into a chatbot.
  const scoped = await answerModule.answer(stubDb(), stubAI({ outcome: "out_of_scope", text: "" }),
    { ...base, question: "should I raise rents?" });
  ok("B1  a model verdict of out_of_scope is returned AS out_of_scope",
     scoped.outcome === "out_of_scope", JSON.stringify(scoped));
  ok("B2  …and the refusal is the SERVER's words, not the model's",
     scoped.answer === answerModule.OUT_OF_SCOPE_ANSWER,
     "the model wrote its own decline. A model that composes a refusal can talk " +
     "itself into being helpful — 'I can't really answer that, but generally…'");
  ok("B3  …and the refusal names what CAN be asked",
     /what needs attention|what is open|who has a job/i.test(scoped.answer));
  ok("B4  …and it carries no grounding, having answered from nothing",
     scoped.grounded_on === null);

  //  A model that ignored the contract and wrote prose must NOT be read
  //  as an answer. This is the exact failure the structured decision
  //  exists to close: a decline in sentence form used to be
  //  indistinguishable from a grounded answer.
  const prose = await answerModule.answer(stubDb(), stubAI({ raw: "I can't really answer that, but generally rents rise 3%." }),
    { ...base, question: "should I raise rents?" });
  ok("B5  a PROSE reply is `unavailable`, never `answered`",
     prose.outcome === "unavailable",
     "free text was accepted as an answer — a model that starts talking has " +
     "already escaped the contract: " + JSON.stringify(prose));

  const badOutcome = await answerModule.answer(stubDb(), stubAI({ outcome: "maybe", text: "x" }),
    { ...base, question: "what's open?" });
  ok("B6  an outcome the contract does not define is `unavailable`",
     badOutcome.outcome === "unavailable", JSON.stringify(badOutcome));

  const emptyAnswered = await answerModule.answer(stubDb(), stubAI({ outcome: "answered", text: "" }),
    { ...base, question: "what's open?" });
  ok("B7  `answered` with an empty body is `unavailable`, not a blank answer",
     emptyAnswered.outcome === "unavailable");

  //  The scope must be ONE definition. If the prompt and the refusal ever
  //  describe different things, the operator is told they can ask about
  //  something the model has been told to decline.
  ok("B8  the system prompt and the refusal quote the SAME scope constant",
     sys.includes(answerModule.SUPPORTED_SCOPE) &&
     answerModule.OUT_OF_SCOPE_ANSWER.includes(answerModule.SUPPORTED_SCOPE),
     "scope has two definitions — they will drift");
  ok("B9  …and the prompt names the off-limits topics explicitly",
     /rent strategy|pricing/.test(sys) && /meetings/.test(sys) &&
     /general knowledge/.test(sys) && /NOT a reason to answer/.test(sys),
     "the model is left to infer what is off-subject");
  /*  B10 USED TO ASSERT THE OPPOSITE TOO.
   *
   *  It required the prompt to tell the model to decline ON-SUBJECT
   *  questions whose facts came up empty. That produced a refusal which
   *  misnamed its own reason — "I can only answer about the open work at
   *  this property", said in reply to a question about exactly that — and
   *  it made scope turn on a judgement with no edge, so the browser gate
   *  passed check 3 on one run and failed it on the next with nothing
   *  changed. Scope is decided on SUBJECT; emptiness is answered honestly.  */
  ok("B10 …and out_of_scope is reserved for OFF-SUBJECT questions only",
     /out_of_scope ONLY when the question is off-subject/.test(sys),
     "the prompt lets thin facts become out_of_scope again — that refusal " +
     "misnames its reason, and makes the scope decision unstable");
  ok("B10b …and an on-subject question with nothing to report is still answered",
     /ALWAYS `answered`/.test(sys) && /Nothing is overdue right now/.test(sys),
     "the prompt no longer tells the model that an empty result is an answer");
  ok("B10c …and it is still forbidden from inventing one to fill the gap",
     /[Nn]ever stretch the facts/.test(sys) && /never invent one/.test(sys),
     "removing the decline rule must not remove the no-stretching rule");
  /*  B11 USED TO ASSERT THE OPPOSITE OF THIS.
   *
   *  It required an assistant turn containing "{" — a prefill, so the reply
   *  could not open with a sentence. The reasoning was sound and the
   *  mechanism was not: every current model refuses a prefill outright with
   *  `400 invalid_request_error — "This model does not support assistant
   *  message prefill. The conversation must end with a user message."` The
   *  service caught that 400 and returned `unavailable`, so the surface
   *  reported an outage on every question ever asked.
   *
   *  This test passed throughout, because a stub cannot 400. That is the
   *  whole lesson: it pinned the MECHANISM rather than the GUARANTEE, and a
   *  mechanism the real API rejects is not a guarantee at all.
   *
   *  So these assert the guarantee — the reply's shape is constrained by
   *  the API — and name the fields, because an unnamed contract is the one
   *  the next sweep breaks silently.  */
  ok("B11 the conversation ENDS on the user turn — a prefill is a 400",
     spy.lastRequest.messages.length === 1 &&
     spy.lastRequest.messages[0].role === "user" &&
     !spy.lastRequest.messages.some((m) => m.role === "assistant"),
     "an assistant turn is back; the real API refuses this and the failure " +
     "renders as an outage, which is indistinguishable from a real one");
  const fmt = spy.lastRequest.output_config && spy.lastRequest.output_config.format;
  ok("B11b …and the shape is enforced by a json_schema, not coaxed by prose",
     !!fmt && fmt.type === "json_schema" && !!fmt.schema,
     "no output_config.format — the two-outcome contract is back to being hoped for");
  ok("B11c …and the schema pins BOTH outcomes by name, and admits no others",
     fmt.schema.additionalProperties === false &&
     Array.isArray(fmt.schema.properties.outcome.enum) &&
     fmt.schema.properties.outcome.enum.slice().sort().join(",") === "answered,out_of_scope",
     JSON.stringify(fmt.schema.properties.outcome));
  ok("B11d …and `grounded_on` is NOT the model's to supply",
     !("grounded_on" in fmt.schema.properties),
     "grounding must stay a thing the server measured, never a thing the model claimed");

  // ── F · A FAILED READ IS CARRIED, NOT SWALLOWED ───────────────────
  const spy2 = {};
  await answerModule.answer(stubDb({ throwOn: "from obligations" }), stubAI(spy2),
    { ...base, question: "what's open?" });
  const facts2 = JSON.parse(spy2.lastRequest.messages[0].content
    .replace(/^FACTS:\n/, "").replace(/\n\nOPERATOR ASKED:[\s\S]*$/, ""));
  ok("F1  a read that failed is NAMED in the facts given to the model",
     Array.isArray(facts2.reads_that_failed) && facts2.reads_that_failed.includes("attention"),
     JSON.stringify(facts2.reads_that_failed));
  ok("F2  …and the failed read does NOT appear as an empty result",
     !("attention" in facts2) || facts2.attention === undefined,
     "a failed read was handed to the model as `attention: { total_open: 0 }` — " +
     "the model would truthfully report nothing is open, and be wrong");

  // ── W · NO WRITE PATH ─────────────────────────────────────────────
  const src = require("fs").readFileSync(
    path.join(__dirname, "..", "src/agent/ask_spine_answer.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  ok("W1  the answer service contains no insert, update or delete",
     !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(src),
     "a write appeared in a read-only service");
  ok("W2  …and it hands the model no tools",
     !/tools\s*:/.test(src),
     "the model was given tools — that is the ACT slice, and it has its own authority rules");

  console.log("\n" + "═".repeat(66));
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("  It answers from reads, names what it read, and says plainly when");
    console.log("  it cannot answer. An outage never arrives shaped like good news.");
  }
  console.log("═".repeat(66) + "\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
