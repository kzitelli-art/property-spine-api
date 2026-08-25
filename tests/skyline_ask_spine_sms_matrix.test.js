/* ════════════════════════════════════════════════════════════════════
   skyline_ask_spine_sms_matrix.test.js
   THE SAME GOVERNED READ, WHICHEVER SURFACE ASKS.   CLASS 3.

   Mike texts. An operator types the same sentence into the dashboard.
   §40 says both reach ONE composer over ONE canonical read, and that
   entitlement is checked BEFORE any governed reader runs — not after,
   and never by a sentence in a prompt.

   This proof exercises the REAL exported functions
   (ask_spine_answer.questionSubject / isPersonalAttentionQuestion /
   gatherFacts, and staff_sms_router.routeStaffSmsTurn). It copies no
   regex. A copied pattern would prove that the copy still matches, which
   is exactly the class of green this repository has been burned by.

   No database. The readers are injected counting stubs, because the claim
   under test is WHETHER A READER IS REACHED, and a stub is the only way
   to see a call that never happens.

   ── WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT CLAIM ──────────
   It pins TODAY'S routing contract so drift is caught. Four of the
   acceptance-rule questions do NOT currently route the way the product
   acceptance rule wants; those are reported below as DIVERGENCES against
   the current behaviour rather than asserted as if they already passed.
   Asserting the desired-but-absent behaviour would leave the branch red
   and would repair Codex-owned routing from a CAMP test, which is not
   this lane's to do.

   CLASS 3 — test infrastructure.
   Run:  node tests/skyline_ask_spine_sms_matrix.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const askSpineAnswer = require("../src/agent/ask_spine_answer.js");
const { routeStaffSmsTurn } = require("../src/conversation/staff_sms_router.js");

let pass = 0, fail = 0, ran = 0;
const failures = [];
const divergences = [];
function ok(label, condition, detail) {
  ran++;
  if (condition) { pass++; console.log("  ok    " + label); return; }
  fail++; failures.push(label);
  console.log("  FAIL  " + label + (detail ? "\n          " + detail : ""));
}
function note(text) { divergences.push(text); }

//  A database that fails loudly. Nothing in this proof may touch one; if
//  something does, the test must say so rather than quietly succeed.
const NO_DB = { query() { throw new Error("this proof must not touch a database"); } };

/*  ── PART A · SUBJECT ROUTING, MEASURED NOT ASSUMED ─────────────────
 *  Every expectation below was read off the real functions first and is
 *  pinned here. `acceptance` records what the product acceptance rule
 *  wants, so a divergence is visible instead of silently normalised.   */
const MATRIX = [
  { q: "What should I focus on?",                          subject: "work",                    dest: "ask_spine",  acceptance: "personal_attention" },
  { q: "Where does Jane's application stand?",             subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
  { q: "Did the resident sign?",                           subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
  { q: "Did the guarantor sign?",                          subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
  { q: "Has Skyline countersigned?",                       subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
  { q: "has Skyline signed Jane's lease",                  subject: "leasing_person",          dest: "technician", acceptance: "leasing_person", surfaceSplit: true },
  { q: "What is holding this lease up?",                   subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
  { q: "What does the applicant need to do next?",         subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
  { q: "Which unit or bed is this applicant pursuing?",    subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
  { q: "What happened after yesterday's tour?",            subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
  { q: "When is my next tour?",                            subject: "tour_schedule",           dest: "ask_spine",  acceptance: "tour_schedule" },
  { q: "What needs my attention?",                          subject: "work",                    dest: "ask_spine",  acceptance: "personal_attention" },
  { q: "upcoming tour availability",                       subject: "tour_schedule",           dest: "technician", acceptance: "tour_schedule", surfaceSplit: true },
  { q: "What is our debt service on this property?",       subject: "debt",                    dest: "ask_spine",  acceptance: "debt" },
  { q: "How many beds do we have, and what is the loan balance?",
                                                           subject: "composition_unavailable", dest: "ask_spine",  acceptance: "composition_unavailable" },
  //  Reported with its full reasoning further down, so this row opts out
  //  of the terse generic note rather than saying it twice.
  { q: "What is the weather tomorrow?",                    subject: "work",                    dest: "technician", acceptance: "out_of_scope", reportedSeparately: true },
  { q: "Where do Jane's and Marcus's applications stand?", subject: "leasing_person",          dest: "ask_spine",  acceptance: "leasing_person" },
];

console.log("\n  ── subject routing, real functions ──");
for (const row of MATRIX) {
  const subject = askSpineAnswer.questionSubject(row.q);
  ok(`subject "${row.q.slice(0, 44)}" → ${row.subject}`,
    subject === row.subject, `got ${subject}`);
  if (subject !== row.acceptance && row.acceptance !== "personal_attention"
      && !row.reportedSeparately) {
    note(`${JSON.stringify(row.q)} routes to "${subject}"; acceptance rule wants "${row.acceptance}"`);
  }
}

console.log("\n  ── SMS router agrees with the composer (no surface-specific logic) ──");
for (const row of MATRIX) {
  const route = routeStaffSmsTurn({ text: row.q, attachments: [] });
  ok(`route "${row.q.slice(0, 40)}" → ${row.dest}`,
    route.destination === row.dest, `got ${route.destination}`);
  const composerSubject = askSpineAnswer.questionSubject(row.q);
  if (route.destination === "ask_spine") {
    ok(`  and its subject equals the dashboard's for "${row.q.slice(0, 34)}"`,
      route.subject === composerSubject,
      `router=${route.subject} composer=${composerSubject}`);
  } else if (row.surfaceSplit) {
    /*  SURFACE DIVERGENCE, PINNED DELIBERATELY.
     *  The dashboard composer classifies this sentence as a governed
     *  domain; the SMS router sends it to the technician rail instead,
     *  because it is not phrased as a question. Same words, two answers,
     *  depending on which surface asked — which is precisely what
     *  "no surface-specific logic" forbids. Pinned as today's behaviour
     *  and reported; the router is Codex-owned and not repaired here.  */
    ok(`  SURFACE SPLIT pinned for "${row.q.slice(0, 34)}" (router≠composer)`,
      route.destination === "technician" && composerSubject === row.subject,
      `router=${route.destination} composer=${composerSubject}`);
    note(`SURFACE SPLIT — ${JSON.stringify(row.q)}: dashboard composer says "${composerSubject}", `
      + `SMS router sends it to "technician". The same wording does not reach the same read.`);
  }
}

console.log("\n  ── personal attention stays person-scoped ──");
ok("a personal-attention question routes to ask_spine with subject work",
  askSpineAnswer.isPersonalAttentionQuestion("what's on my plate")
    && routeStaffSmsTurn({ text: "what's on my plate", attachments: [] }).destination === "ask_spine"
    && routeStaffSmsTurn({ text: "what's on my plate", attachments: [] }).subject === "work");
/*  These two were REPORTED as unrecognised and are now ASSERTED. The
 *  earlier `note()` was the right call while the phrasings were Codex's
 *  to rule on; once the composer accepted them, a note would let them
 *  regress silently. PERSONAL_ATTENTION_TERMS is shared by the dashboard
 *  and the SMS router, so each phrasing is checked on BOTH surfaces —
 *  that sharing is the reason there is one list, and an assertion that
 *  only looked at the composer would not notice if it stopped being
 *  true.  */
for (const phrasing of ["What should I focus on?", "What needs my attention?",
                        "what should I do today", "what's on my plate"]) {
  const route = routeStaffSmsTurn({ text: phrasing, attachments: [] });
  ok(`"${phrasing}" is a personal-attention question on BOTH surfaces`,
    askSpineAnswer.isPersonalAttentionQuestion(phrasing)
      && route.destination === "ask_spine" && route.subject === "work",
    `personal=${askSpineAnswer.isPersonalAttentionQuestion(phrasing)} `
    + `dest=${route.destination} subject=${route.subject}`);
}

/*  ── THE TWO LATENT REGEX DEFECTS, PINNED AT THE TOKEN ──────────────
 *  Repairing the phrases above is not the same as proving WHY they were
 *  broken, and the acceptance phrase would keep passing if someone
 *  reintroduced the bug in a form that happened to miss it. These assert
 *  the bare word forms directly:
 *
 *    `toured?`     is `toure` + optional `d`; it never matched "tour".
 *    `countersign` had no suffix group, and "countersigned" has no word
 *                  boundary before "sign", so nothing rescued it.       */
for (const bare of ["a tour", "the tour", "she toured", "they are touring"]) {
  ok(`the bare noun form "${bare}" reaches leasing_person`,
    askSpineAnswer.questionSubject("what happened at " + bare) === "leasing_person",
    askSpineAnswer.questionSubject("what happened at " + bare));
}
for (const form of ["countersign", "countersigns", "countersigned", "countersigning"]) {
  ok(`"${form}" reaches leasing_person`,
    askSpineAnswer.questionSubject("has the company " + form + " it") === "leasing_person",
    askSpineAnswer.questionSubject("has the company " + form + " it"));
}

/*  ── THE WIDENING DID NOT SWALLOW ITS NEIGHBOURS ────────────────────
 *  `holding ... up` was widened by NAMING LEASING'S OWN NOUNS, not by
 *  loosening the object slot. A `holding .* up` wildcard would have
 *  taken Maintenance's sentence, so that is the assertion.
 *  And bare `tours?` is only safe because tour_schedule suppresses
 *  leasing_person — asserted here rather than trusted.                 */
/*  A PRE-EXISTING MIS-ROUTE, FOUND WHILE WIDENING AND NOT INTRODUCED BY
 *  IT. The original `holding (?:this|it|things) up` alternative claims a
 *  sentence that carries explicit MAINTENANCE vocabulary, because `work`
 *  yields to `leasing_person` by design. Widening did not cause it and
 *  narrowing the new noun-anchored alternative cannot cure it. Repairing
 *  it means deciding whether some leasing vocabulary is weak enough to
 *  yield to explicit work terms — a routing ruling, not a phrase fix, so
 *  it is REPORTED and pinned rather than taken here.                    */
ok("a work sentence with a generic leasing phrase still goes to leasing_person (PRE-EXISTING, pinned)",
  askSpineAnswer.questionSubject("the elevator repair is holding this up") === "leasing_person",
  askSpineAnswer.questionSubject("the elevator repair is holding this up"));
note("PRE-EXISTING (not introduced by this build) — \"the elevator repair is holding this "
   + "up\" routes to `leasing_person`. The generic `holding this up` alternative outranks "
   + "explicit maintenance vocabulary because `work` yields to every named domain. Curing "
   + "it needs a weak/strong distinction inside leasing vocabulary, which is a routing "
   + "ruling rather than a phrase repair.");

ok("\"what is holding the elevator up\" stays OUT of leasing_person",
  askSpineAnswer.questionSubject("what is holding the elevator up") !== "leasing_person",
  askSpineAnswer.questionSubject("what is holding the elevator up"));
for (const sched of ["when can we tour", "schedule a tour", "tour availability this week",
                     "who is hosting tours friday", "When is my next tour?"]) {
  ok(`scheduling sentence "${sched}" still wins over bare tour vocabulary`,
    askSpineAnswer.questionSubject(sched) === "tour_schedule",
    askSpineAnswer.questionSubject(sched));
}

/*  ── THE UNSUPPORTED-QUESTION BOUNDARY · ANSWERED, NOT BOLTED ON ────
 *  "What is the weather tomorrow?" was reported as routing to `work`
 *  rather than out_of_scope. It still does, DELIBERATELY.
 *
 *  questionSubject has no deterministic unsupported boundary: it ends at
 *  `return "work"`, so every unrecognised sentence becomes a work
 *  question. The only deterministic out_of_scope returns in answer() are
 *  for an EMPTY question and an OVERSIZED one — properties of the
 *  string, not of its subject. Off-subject detection is the MODEL's, by
 *  design, and the comment above that rule records why: an earlier
 *  version also refused when the facts were thin, which was dishonest
 *  ("I can only answer about open work" when the truth was there is
 *  none) and unstable (the same question landed differently run to run).
 *  It was narrowed to subject alone because subject has an edge and
 *  sufficiency does not.
 *
 *  A weather regex would be the first entry in exactly the blacklist
 *  that design rejected. So the boundary is asserted as it stands, and
 *  the finding stays REPORTED.                                          */
ok("an off-subject question routes to `work`; out_of_scope is the model's call, not a blacklist",
  askSpineAnswer.questionSubject("What is the weather tomorrow?") === "work"
    && askSpineAnswer.questionSubject("") === "work",
  askSpineAnswer.questionSubject("What is the weather tomorrow?"));
note("\"What is the weather tomorrow?\" routes to `work`. REPORTED, not repaired: "
   + "questionSubject has no deterministic unsupported boundary — it ends at "
   + "`return \"work\"`, and the only deterministic out_of_scope returns are for an "
   + "empty or oversized question. Off-subject is decided by the model against "
   + "DECISION_SCHEMA, and the server writes the sentence. Adding a weather pattern "
   + "would start the blacklist that design deliberately rejected.");

async function main() {
/*  ── PART B · ENTITLEMENT PRECEDES THE READER ───────────────────────
 *  §40.8. The claim is not "an unentitled answer looks refused" — it is
 *  that the governed reader IS NEVER CALLED and its facts never exist to
 *  be leaked. Only a call counter can say that.                        */
function countingLeasingReader() {
  const calls = { resolve: 0, standing: 0 };
  return {
    calls,
    async resolveLeasingSubject() {
      calls.resolve++;
      return { resolved: true, person: { id: "11111111-1111-4111-8111-111111111111", name: "Jane Doe" } };
    },
    async readLeasingStanding() {
      calls.standing++;
      return { application: { state: "submitted" }, secret_id: "22222222-2222-4222-8222-222222222222" };
    },
  };
}

console.log("\n  ── entitlement precedes intelligence (§40.8) ──");
{
  const reader = countingLeasingReader();
  const facts = await askSpineAnswer.gatherFacts(NO_DB, {
    property_id: "p-1", allowed_modules: [], subject: "leasing_person",
    question: "has Skyline signed Jane's lease", leasingReader: reader,
  });
  ok("an unentitled session NEVER reaches the leasing reader",
    reader.calls.resolve === 0 && reader.calls.standing === 0,
    `resolve=${reader.calls.resolve} standing=${reader.calls.standing}`);
  ok("and the fact envelope says NOT_AUTHORIZED",
    facts.leasing_person && facts.leasing_person.read_state === "NOT_AUTHORIZED",
    JSON.stringify(facts.leasing_person));
  ok("no leasing payload exists to leak into model context",
    facts.leasing_person && facts.leasing_person.application === undefined
      && !JSON.stringify(facts.leasing_person).includes("22222222"),
    JSON.stringify(facts.leasing_person));
}

console.log("\n  ── the entitled path DOES reach the reader, and strips ids ──");
{
  const reader = countingLeasingReader();
  const facts = await askSpineAnswer.gatherFacts(NO_DB, {
    property_id: "p-1", allowed_modules: ["leasing"], subject: "leasing_person",
    question: "has Skyline signed Jane's lease", leasingReader: reader,
  });
  ok("an entitled session reaches the canonical leasing reader exactly once",
    reader.calls.resolve === 1 && reader.calls.standing === 1,
    `resolve=${reader.calls.resolve} standing=${reader.calls.standing}`);
  ok("the fact envelope reads OK and carries the subject name",
    facts.leasing_person.read_state === "OK" && facts.leasing_person.subject_name === "Jane Doe");
  ok("database identifiers are stripped before the model can see them",
    !JSON.stringify(facts.leasing_person).includes("22222222")
      && !JSON.stringify(facts.leasing_person).includes("11111111"),
    JSON.stringify(facts.leasing_person).slice(0, 160));
}

console.log("\n  ── an unentitled Asset Management question yields no asset facts ──");
{
  const facts = await askSpineAnswer.gatherFacts(NO_DB, {
    property_id: "p-1", allowed_modules: ["leasing"], subject: "debt",
    question: "What is our debt service on this property?",
    debtService: { get instrumentsFor() { throw new Error("debt reader must not be reached"); } },
  });
  const blob = JSON.stringify(facts);
  ok("no debt facts entered the envelope without asset_management",
    !facts.debt || facts.debt.read_state === "NOT_AUTHORIZED",
    blob.slice(0, 200));
}

/*  ── PART C · THE FOUR SILENCES STAY APART (§40.7) ──────────────────
 *  READ_FAILED, READ_TIMED_OUT, NOT_ESTABLISHED and quiet are four
 *  different answers. A surface that collapses them answers confidently
 *  about the wrong human.                                              */
console.log("\n  ── four silences remain distinct (§40.7) ──");
{
  const failing = {
    async resolveLeasingSubject() { throw new Error("connection reset"); },
    async readLeasingStanding() { throw new Error("unused"); },
  };
  const timing = {
    async resolveLeasingSubject() { const e = new Error("slow"); e.code = "READ_TIMED_OUT"; throw e; },
    async readLeasingStanding() { throw new Error("unused"); },
  };
  const absent = {
    async resolveLeasingSubject() { return { resolved: false, reason: "none", candidates: [] }; },
    async readLeasingStanding() { throw new Error("must not be called when unresolved"); },
  };
  const ambiguous = {
    async resolveLeasingSubject() {
      return { resolved: false, reason: "ambiguous",
               candidates: [{ name: "Jane Doe" }, { name: "Jane Roe" }] };
    },
    async readLeasingStanding() { throw new Error("must not be called when ambiguous"); },
  };
  const call = (leasingReader) => askSpineAnswer.gatherFacts(NO_DB, {
    property_id: "p-1", allowed_modules: ["leasing"], subject: "leasing_person",
    question: "has Skyline signed Jane's lease", leasingReader,
  });
  const f = await call(failing); const t = await call(timing);
  const n = await call(absent);  const a = await call(ambiguous);
  const states = [f.leasing_person.read_state, t.leasing_person.read_state,
                  n.leasing_person.read_state, a.leasing_person.read_state];
  ok("a read failure is READ_FAILED, not silence",
    states[0] === "READ_FAILED", states[0]);
  ok("a timeout is READ_TIMED_OUT, distinct from a failure",
    states[1] === "READ_TIMED_OUT", states[1]);
  ok("no such person is NO_SUBJECT, not a failure and not 'nothing happening'",
    states[2] === "NO_SUBJECT", states[2]);
  ok("more than one match is AMBIGUOUS_SUBJECT and Spine refuses to guess",
    states[3] === "AMBIGUOUS_SUBJECT", states[3]);
  ok("all four silences are different values",
    new Set(states).size === 4, states.join(" / "));
  ok("an unavailable read never renders as 'nothing outstanding'",
    !/nothing (outstanding|happening)/i.test(JSON.stringify(f.leasing_person)));
  ok("ambiguity offers NAMES, never database identifiers",
    Array.isArray(a.leasing_person.candidates)
      && a.leasing_person.candidates.every((c) => typeof c === "string"),
    JSON.stringify(a.leasing_person.candidates));
}

/*  ── PART D · COMPOSITION IS A REFUSAL, NOT AN ANSWER (§40.8) ───────  */
console.log("\n  ── cross-domain composition remains refused ──");
ok("a two-domain question is composition_unavailable at the subject layer",
  askSpineAnswer.questionSubject("How many beds do we have, and what is the loan balance?")
    === "composition_unavailable");
ok("the SMS router carries that refusal rather than picking a domain",
  routeStaffSmsTurn({ text: "How many beds do we have, and what is the loan balance?", attachments: [] })
    .subject === "composition_unavailable");

/*  ── PART E · THE MODEL GETS NO IDS AND NO TOOLS ────────────────────  */
console.log("\n  ── the model never receives identifiers or an action tool ──");
{
  let captured = null;
  const anthropic = { messages: { create: async (payload) => {
    captured = payload;
    //  The composer enforces DECISION_SCHEMA and treats anything else as
    //  `unavailable`. A stub returning prose was testing my stub, not the
    //  contract — the composer was right to reject it.
    return { content: [{ type: "text",
      text: JSON.stringify({ outcome: "answered", answer: "Jane's lease is not yet countersigned." }) }] };
  } } };
  const reader = countingLeasingReader();
  const out = await askSpineAnswer.answer(NO_DB, anthropic, {
    property_id: "p-1", allowed_modules: ["leasing"],
    question: "has Skyline signed Jane's lease",
    leasingReader: reader, operator_user_id: "u-1", primary_for_modules: [],
  });
  ok("the model was called for an entitled question", !!captured);
  if (captured) {
    const wire = JSON.stringify(captured);
    ok("no database uuid crossed into model context",
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(wire),
      wire.slice(0, 200));
    ok("the model is given no tools — it cannot act",
      captured.tools === undefined || (Array.isArray(captured.tools) && captured.tools.length === 0));
  }
  ok("grounded_on is server-generated, not model-authored",
    out && out.grounded_on && typeof out.grounded_on === "object"
      && !String(out.answer || "").includes("grounded_on"),
    JSON.stringify(out && out.grounded_on).slice(0, 160));
}

console.log("");
if (divergences.length) {
  console.log("  ── DIVERGENCES from the product acceptance rule (REPORTED, not repaired) ──");
  for (const d of divergences) console.log("     • " + d);
  console.log("     These are Codex/leasing-routing findings. Repairing them from a CAMP");
  console.log("     test is out of this lane; they are pinned above as current behaviour.");
  console.log("");
}
console.log("════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${ran} run · ${pass} passed · ${fail} failed`);
console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — skyline_ask_spine_sms_matrix.test.js`);
console.log(`  EXIT      ${fail === 0 ? 0 : 1}`);
console.log("════════════════════════════════════════════════════════════════\n");
if (fail) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
