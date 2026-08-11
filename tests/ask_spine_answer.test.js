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

//  A model that records what it was asked and returns what we tell it to.
const stubAI = (behaviour) => ({
  messages: {
    create: async (req) => {
      if (behaviour && behaviour.throws) throw new Error("model down");
      if (behaviour) behaviour.lastRequest = req;
      return { content: [{ type: "text", text: (behaviour && behaviour.text) || "Nothing is open right now." }] };
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
