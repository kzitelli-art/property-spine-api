// ════════════════════════════════════════════════════════════════════
//  technician_language.test.js — DB-FREE.
//
//  THE PRODUCT BAR, as an executable assertion:
//
//    Could a good maintenance technician use this immediately, with no
//    training, by texting exactly as they already text today?
//
//  So this harness is a corpus of real phrasings, not a test of a syntax.
//  Every consequential reading must be right, and — more important —
//  nothing ambiguous may be guessed into an action. The fail-soft
//  direction is always toward asking.
// ════════════════════════════════════════════════════════════════════
"use strict";
const receipt = require("../_run_receipt");
const t = require("../../src/conversation/technician_intent");
const r = require("../../src/conversation/receipt");

const HARNESS = __filename;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const section = (x) => console.log(`\n── ${x} ${"─".repeat(Math.max(0, 56 - x.length))}`);

//  How technicians actually text. Every line here is a plain phrase, and
//  not one of them is a command.
const CORPUS = [
  ["accept",   ["Got it.", "got it", "on it", "I'll take it", "ill take that one", "taking it",
                "will do", "yep", "mine", "accept 1042"]],
  ["en_route", ["I'm heading over.", "omw", "on my way", "heading there now", "en route",
                "leaving now", "be there in 20", "headed over", "next stop"]],
  ["no_access", ["Couldn't get in.", "no access", "nobody's home", "no one is answering",
                 "cant get in", "locked out", "door was locked", "no answer at the door"]],
  ["blocked",  ["need a part", "waiting on the plumber", "have to come back",
                "can't finish it today", "stuck", "needs approval"]],
  ["complete", ["All done.", "all done", "finished", "it's complete", "wrapped it up",
                "all set", "good to go", "finished up"]],
  ["list_work", ["anything else open here?", "what's open for me", "my jobs",
                 "what do i have", "anything else",
                 //  Natural phrasings with the object "work"/"jobs" in the
                 //  middle — a technician texted "What work do I have" and the
                 //  line asked "which work order?" instead of listing. 2026-08-06.
                 "what work do i have", "What work do I have",
                 "what jobs am i working", "what work is assigned to me",
                 "what work do i need to do"]],
  ["finding",  ["the leak is stopped but it needs a valve",
                "shutoff valve is corroded and needs replacing",
                "the breaker keeps tripping on that outlet",
                "water damage on the ceiling below"]],
];

//  Things that must NEVER become an action. Every one of these is a real
//  message a technician might send, and acting on any of them would be
//  the software guessing.
const MUST_NOT_ACT = [
  "hi", "ok", "?", "thanks", "call me", "sorry",
  "should I replace the valve?", "who is the resident here",
  "3 units affected", "running late",
];

receipt.begin(HARNESS, { expected: 77 });

let code = 1;
try {
  section("1. PLAIN PHRASES READ CORRECTLY");
  for (const [expected, phrases] of CORPUS) {
    for (const p of phrases) {
      const got = t.readTurn({ text: p }).intent;
      ok(`${JSON.stringify(p)} → ${expected}`, got === expected, `got ${got}`);
    }
  }

  section("2. NOTHING AMBIGUOUS BECOMES AN ACTION");
  for (const p of MUST_NOT_ACT) {
    const got = t.readTurn({ text: p }).intent;
    ok(`${JSON.stringify(p)} is not read as a consequential verb`,
      got === "unclear" || got === "list_work", `got ${got}`);
  }

  section("3. CONSEQUENCE ORDER");
  {
    ok("a no-access report is not overwritten by a trailing travel clause",
      t.readTurn({ text: "couldn't get in, heading to the next one" }).intent === "no_access");
    ok("a blocked report outranks a bare completion word in the same message",
      t.readTurn({ text: "fixed what I could but need a part" }).intent === "blocked");
    ok("photos alone are a report, not an unreadable message",
      t.readTurn({ text: "", attachments: [{ url: "x" }] }).intent === "finding");
    ok("...and are flagged as evidence-only so the reply is about the photo",
      t.readTurn({ text: "here you go", attachments: [{ url: "x" }] }).evidenceOnly === true);
  }

  section("4. CONTEXT-DEPENDENT REPLIES ARE SEPARATE");
  {
    ok("'ok' is an affirmative, and is NOT a verb on its own",
      t.readAnswerToQuestion("ok") === "affirmative" && t.readTurn({ text: "ok" }).intent === "unclear");
    ok("'no' is a negative", t.readAnswerToQuestion("no") === "negative");
    ok("a real sentence is neither", t.readAnswerToQuestion("the valve is corroded") === null);
  }

  section("5. NO REPLY EVER EXPOSES THE SCHEMA");
  {
    const work = { id: "w", title: "Sink leak", unit_number: "302", work_order_ref: 1042 };
    const progress = { id: "p", note: "valve replaced" };
    const outcomes = [
      ["work_accepted", { work }],
      ["en_route_recorded", { work, progress }],
      ["no_access_recorded", { work, progress, residentUpdateQueued: true }],
      ["blocked_recorded", { work, progress }],
      ["finding_recorded", { work, progress }],
      ["completion_blocked", { work, progress, evidenceAttempted: false }],
      ["work_completed", { work, progress, residentUpdateQueued: true }],
      ["evidence_recorded", { work, storageState: "stored" }],
      ["work_list", { items: [work] }],
      ["authorization_refused", { verdict: "not_assigned_to_actor" }],
    ];
    const BANNED = /obligation|comm_event|work_order_id|uuid|constraint|migration|staff_thread|reply_only|in_progress|not_done_reason|null|undefined|storage_state|[0-9a-f]{8}-[0-9a-f]{4}/i;
    for (const [o, res] of outcomes) {
      const text = r.operatingReceipt({ outcome: o, result: res }).text;
      ok(`${o} says nothing about the schema`, !!text && !BANNED.test(text), text);
    }
  }

  code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: 77 });
} catch (e) {
  code = receipt.died(HARNESS, e, passed + failed);
}
process.exit(code);
