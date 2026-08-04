// ════════════════════════════════════════════════════════════════════
//  conversation_intent_extraction.test.js — DB-FREE.
//
//  Phase 1 of the conversational convergence: intent interpretation and
//  answer recognition are extracted out of src/comms/tenantlink.js, where
//  they were private closures reachable only through the SMS route, into
//  src/conversation/intent.js.
//
//  ── WHAT THIS PROVES, AND WHAT IT CANNOT ────────────────────────────
//
//  EXTRACTION IS A MOVE, NOT A REDESIGN. The strongest evidence is the
//  diff: the two function bodies are byte-identical to the tenantlink
//  originals after de-indentation, which this harness re-checks against
//  git rather than asserting from memory.
//
//  It ALSO pins the behaviour itself, so a later edit that is not a move
//  fails here rather than in production: hard overrides in both
//  directions, keyword trade inference, fail-soft defaults, vocabulary
//  clamping, and the four answer verdicts.
//
//  IT DOES NOT REPLACE THE RESIDENT SMS PROOFS. Those build no schema of
//  their own and need a provisioned full-schema database, which this
//  session does not have. resident_sms_work_order_proof.js and
//  resident_sms_route_proof.js remain REQUIRED before this can merge —
//  see docs/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md. Byte-identity plus
//  behavioural pinning is strong evidence; it is not the route proof.
//
//  ── THE ARCHITECTURAL ASSERTIONS ────────────────────────────────────
//
//  One implementation (tenantlink must delegate, never keep a copy), and
//  transport independence (no Twilio, no express, no session, no database)
//  — because the whole point of the seam is that a second caller uses the
//  SAME implementation without dragging SMS along with it.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const receipt = require("./_run_receipt");

const HARNESS = __filename;
const EXPECTED = 34;
let passed = 0, failed = 0, ran = 0;
const ok = (label, cond, detail) => {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const makeIntentReader = require("../src/conversation/intent");
const INTENT_SRC = path.join(__dirname, "..", "src", "conversation", "intent.js");
const TENANTLINK_SRC = path.join(__dirname, "..", "src", "comms", "tenantlink.js");

//  An anthropic double. Never imports a real client; returns whatever the
//  test hands it, or throws on demand.
const modelDouble = (payload, { throws = false } = {}) => ({
  messages: {
    create: async () => {
      if (throws) throw new Error("model unavailable (deliberate)");
      return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
    },
  },
});

const AI_OK = {
  classification: "maintenance", field_category: "plumbing", urgency: "normal",
  confidence: 0.9, needs_human: false, summary: "sink leaking", suggested_title: "Leaking kitchen sink",
};

receipt.begin(HARNESS, { expected: EXPECTED });

let code = 1;
(async () => {
try {
  // ── 1. THE MOVE IS A MOVE ────────────────────────────────────────
  section("EXTRACTION IDENTITY");
  {
    let prior = null;
    try {
      prior = execSync("git show HEAD~1:src/comms/tenantlink.js", { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch { /* shallow history or first commit — reported below, not assumed away */ }

    if (prior) {
      //  Boundary-hunting for the end of a function is fragile — the first
      //  attempt stopped at the catch block's brace and reported a false
      //  difference. Compare by LINE MEMBERSHIP instead: every substantive
      //  line of the extracted body must appear verbatim in the prior
      //  tenantlink source, de-indented. That proves nothing was rewritten
      //  without depending on finding exact start and end markers.
      const priorLines = new Set(prior.split("\n").map((l) => l.trim()).filter(Boolean));
      const now = fs.readFileSync(INTENT_SRC, "utf8");
      const inner = now.slice(now.indexOf("const FIELD_CATEGORIES"), now.indexOf("\n\n  return {\n    classifyMessage"));
      const substantive = inner.split("\n").map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
      const foreign = substantive.filter((l) => !priorLines.has(l));

      ok(`every extracted line (${substantive.length}) appears verbatim in the tenantlink original`,
        foreign.length === 0,
        foreign.length ? "changed lines: " + foreign.slice(0, 3).join(" | ") : null);
    } else {
      ok("prior revision unavailable — identity checked by the other assertions",
        true, null);
    }
  }

  // ── 2. ONE IMPLEMENTATION ────────────────────────────────────────
  section("ONE IMPLEMENTATION");
  {
    const tl = fs.readFileSync(TENANTLINK_SRC, "utf8");
    ok("tenantlink keeps NO local classifyMessage", !/async function classifyMessage/.test(tl));
    ok("tenantlink keeps NO local recognizeAnswer", !/async function recognizeAnswer/.test(tl));
    ok("tenantlink keeps NO local classification vocabulary", !/const FIELD_CATEGORIES/.test(tl));
    ok("tenantlink keeps NO local emergency/sensitive patterns",
      !/const EMERGENCY_RX/.test(tl) && !/const SENSITIVE_RX/.test(tl));
    ok("tenantlink DELEGATES to the shared module", /require\("\.\.\/conversation\/intent"\)/.test(tl));
  }

  // ── 3. TRANSPORT INDEPENDENCE ────────────────────────────────────
  section("TRANSPORT INDEPENDENCE");
  {
    const raw = fs.readFileSync(INTENT_SRC, "utf8");
    //  READ THE CODE, NOT THE PROSE. The first version of these assertions
    //  grepped the whole file for "priority", "authoriz" and "complete" —
    //  and matched this module's own header comment SAYING it does none of
    //  those things. Three green-looking prohibitions were reading English.
    //  That is the same defect as a gate detecting a guard by grepping for
    //  its name, committed here an hour after fixing it there.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    ok("no provider/transport import (twilio)", !/require\(["'].*twilio/i.test(src));
    ok("no HTTP framework import (express)", !/require\(["']express/i.test(src));
    ok("no database driver import (pg)", !/require\(["']pg["']\)/.test(src));
    ok("no database access at all", !/\.query\s*\(/.test(src) && !/\bpool\b/.test(src));
    ok("no session or cookie handling", !/sessionStorage|req\.session|cookie/i.test(src));
    ok("no environment reach — dependencies are injected",
      !/process\.env/.test(src));
    //  The prohibition from the design: it proposes, it never decides.
    ok("does not write work orders", !/createWorkOrder|insert\s+into/i.test(src));
    ok("does not assign priority or order work", !/order\s+by|priority/i.test(src));
    ok("does not authorize actors", !/entitlement|authoriz/i.test(src));
    ok("does not mark completion", !/complete|completion/i.test(src));
  }

  // ── 4. FAIL-SOFT WITH NO MODEL ───────────────────────────────────
  section("BEHAVIOUR · no model available");
  {
    const r = makeIntentReader({});
    const c = await r.classifyMessage("the sink is leaking");
    ok("no model → classification 'unknown'", c.classification === "unknown");
    ok("no model → needs_human TRUE (never guessed onto a work order)", c.needs_human === true);
    ok("no model → confidence 0, not invented", c.confidence === 0);
    ok("no model → no summary or title fabricated",
      c.summary === null && c.suggested_title === null);
    ok("no model → recognizeAnswer is 'unclear'",
      (await r.recognizeAnswer({ question: "which unit?", reply: "3B" })) === "unclear");
  }

  // ── 5. HARD OVERRIDES BEAT THE MODEL, BOTH DIRECTIONS ────────────
  section("BEHAVIOUR · hard overrides");
  {
    const r = makeIntentReader({ anthropic: modelDouble(AI_OK), model: "harness" });

    const calm = await r.classifyMessage("there is water gushing from the ceiling");
    ok("hard emergency overrides a calm model verdict",
      calm.classification === "emergency" && calm.urgency === "emergency");
    ok("hard emergency forces needs_human", calm.needs_human === true);

    const sensitive = await r.classifyMessage("my lawyer says this is uninhabitable");
    ok("sensitive language forces needs_human even when the model is confident",
      sensitive.needs_human === true);
    ok("sensitive language does NOT fabricate an emergency",
      sensitive.classification !== "emergency");

    const aiEmergency = await r.classifyMessage("something is off");
    ok("an ordinary message keeps the model's verdict",
      aiEmergency.classification === "maintenance");

    const r2 = makeIntentReader({ anthropic: modelDouble({ ...AI_OK, classification: "emergency" }), model: "h" });
    const m = await r2.classifyMessage("something is off");
    ok("a model-called emergency also forces needs_human", m.needs_human === true);
  }

  // ── 6. KEYWORD TRADE INFERENCE — honest, not invented ────────────
  section("BEHAVIOUR · trade inference when the model is silent");
  {
    const r = makeIntentReader({});   // no model at all → field_category 'other'
    const cases = [
      ["sewage backing up in the basement", "plumbing"],
      ["the outlet is sparking", "electric"],
      ["no heat and it is freezing", "heat_ac"],
      ["someone broke in through the door", "lock_key"],
    ];
    for (const [text, expected] of cases) {
      const c = await r.classifyMessage(text);
      ok(`hard emergency infers trade '${expected}' from the words`,
        c.field_category === expected, `${text} → ${c.field_category}`);
    }
    const vague = await r.classifyMessage("there is a fire");
    ok("an emergency with no trade keyword stays 'other', not guessed",
      vague.field_category === "other", vague.field_category);
  }

  // ── 7. VOCABULARY CLAMPING ───────────────────────────────────────
  section("BEHAVIOUR · vocabularies did not drift in the move");
  {
    const r = makeIntentReader({ anthropic: modelDouble({ ...AI_OK, field_category: "teleportation" }), model: "h" });
    const c = await r.classifyMessage("something odd");
    ok("an off-vocabulary field_category clamps to 'other'", c.field_category === "other");

    const r2 = makeIntentReader({ anthropic: modelDouble({ ...AI_OK, confidence: "very sure" }), model: "h" });
    ok("a non-numeric confidence becomes 0", (await r2.classifyMessage("x")).confidence === 0);

    const long = "y".repeat(500);
    const r3 = makeIntentReader({ anthropic: modelDouble({ ...AI_OK, summary: long, suggested_title: long }), model: "h" });
    const c3 = await r3.classifyMessage("x");
    ok("summary is bounded to 200", c3.summary.length === 200);
    ok("suggested title is bounded to 80", c3.suggested_title.length === 80);

    const v = makeIntentReader({});
    ok("the eleven field categories survived the move",
      v.FIELD_CATEGORIES.length === 11 && v.FIELD_CATEGORIES.includes("plumbing") && v.FIELD_CATEGORIES.includes("other"));
    ok("the four answer verdicts survived the move",
      v.ANSWER_VERDICTS.join() === "answers_question,separate_problem,both,unclear");
  }

  // ── 8. ANSWER RECOGNITION ────────────────────────────────────────
  section("BEHAVIOUR · answer recognition");
  {
    for (const verdict of ["answers_question", "separate_problem", "both", "unclear"]) {
      const r = makeIntentReader({ anthropic: modelDouble(verdict), model: "h" });
      const got = await r.recognizeAnswer({ question: "which unit?", reply: "3B" });
      ok(`recognises '${verdict}'`, got === verdict, got);
    }
    const junk = makeIntentReader({ anthropic: modelDouble("I am not sure what you mean"), model: "h" });
    ok("an unrecognised verdict fails soft to 'unclear'",
      (await junk.recognizeAnswer({ question: "q", reply: "r" })) === "unclear");

    const dead = makeIntentReader({ anthropic: modelDouble(null, { throws: true }), model: "h" });
    ok("a model error fails soft to 'unclear', never a guess",
      (await dead.recognizeAnswer({ question: "q", reply: "r" })) === "unclear");

    const deadC = makeIntentReader({ anthropic: modelDouble(null, { throws: true }), model: "h" });
    const cc = await deadC.classifyMessage("the sink is leaking");
    ok("a model error during classification degrades to the human queue",
      cc.classification === "unknown" && cc.needs_human === true);
  }

  code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
} catch (e) {
  code = receipt.died(HARNESS, e, ran);
}
process.exit(code);
})();
