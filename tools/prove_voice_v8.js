// prove_voice_v8.js — proof harness for the Case 1-5 voice upgrades.
//
// EVIDENCE STANDARD (AI_VOICE_TUNING.md §4): `node --check` is not evidence.
// Every assertion below runs the REAL exported functions against the REAL
// strings a live prospect received, and every one of them FAILS against the
// pre-v8 code. Run with --show-prefix to see the pre-fix behavior reproduced.
//
//   node tools/prove_voice_v8.js
//
// Class 3 (test-only). Removal condition: delete when the voice corpus in
// AI_VOICE_TUNING.md is superseded by api/docs/AI_VOICE.md + its own suite.

const path = require("path");
const mod = require(path.join(__dirname, "..", "src", "agent", "agent.js"));
const router = mod({ pool: { query: async () => ({ rows: [] }) }, anthropic: null });
const { stripMarkdown, stripDashes, humanizeTypos, finishProspectText } = router.__test__;

let pass = 0, fail = 0;
const results = [];
function check(name, actual, predicate, expectation) {
  const ok = predicate(actual);
  ok ? pass++ : fail++;
  results.push({ ok, name, expectation, actual });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      expected: ${expectation}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

// ─── Case 4A: markdown reached a real prospect over SMS ───────────────────────
// This is the VERBATIM body sent to Cameron Sitelli at 08:26 on 2026-07-25.
const LIVE_FEE_REPLY =
  "Here's the breakdown: **At application:** $50 app fee **At move-in (due at least 3 weeks " +
  "before, but we'll need to compress that):** - First month's rent (e.g. $2,700 for the 2-bed) " +
  "- Security deposit ($1,000, one month's rent, depends on approval) - $300 amenity fee " +
  "- $75, 99 telecom fee - $99 admin fee **Monthly:** - Rent - Electric & water (usage-based) " +
  "- $40 building wifi - $15 renters insurance (or bring your own policy) Parking's $300/month " +
  "if you need it. Does that work with your timeline?";

const cleaned = stripMarkdown(LIVE_FEE_REPLY);
check("markdown: no asterisks survive", cleaned, s => !s.includes("*"), "zero '*' characters");
check("markdown: no inline hyphen bullets", cleaned, s => !/\s-\s/.test(s), "no ' - ' list markers");
check("markdown: content preserved (fee amounts intact)", cleaned,
  s => ["$50", "$2,700", "$300", "$99", "$40", "$15"].every(v => s.includes(v)),
  "every dollar figure still present");
check("markdown: header text kept, marker dropped", cleaned,
  s => s.includes("At application:") && !s.includes("**At application:**"),
  "'At application:' present without asterisks");

// A strip that ate content would be worse than the bug. Guard against it.
check("markdown: does not mangle a clean sentence", stripMarkdown("Yes, in-unit W/D. Rent is $2,700."),
  s => s === "Yes, in-unit W/D. Rent is $2,700.", "unchanged");

// ─── Case 5: humanization can never alter a fact ──────────────────────────────
// Forced ON (rng always 0) so the guarantee is tested, not sampled.
const always = () => 0;
const MONEY = "Rent is $2,700 and parking's $300/month. Tour Monday at 2 PM in unit 602.";
check("typos: never touch a number, price, time, or unit", humanizeTypos(MONEY, always),
  s => ["$2,700", "$300", "2 PM", "602"].every(v => s.includes(v)),
  "every figure identical");

check("typos: drops exactly one apostrophe, not all",
  humanizeTypos("I dont know, that's fine, there's more, what's next?".replace("dont", "don't"), always),
  s => (s.match(/\b(dont|thats|theres|whats)\b/g) || []).length === 1,
  "exactly one de-apostrophized word");

check("typos: off when rate not hit", humanizeTypos("That's the two-bed.", () => 0.99),
  s => s === "That's the two-bed.", "unchanged");

check("typos: cannot invent or delete words",
  humanizeTypos("We don't have a three-bedroom open.", always),
  s => s.split(/\s+/).length === "We don't have a three-bedroom open.".split(/\s+/).length,
  "same word count");

// ─── Case 2A / 4B / 4C: the fact layer's own en dashes ────────────────────────
// $75-99 (en dash) is REAL DATA from demo_solo_agent_facts_v1.json. It became
// "$75, 99" in a live message. This asserts the range survives the full chain.
const FACT_TELECOM = "A telecom fee of $75–99 is due at move-in.";
const FACT_QUIET = "Quiet hours are 9 PM–8 AM Sunday–Thursday.";
check("ranges: telecom fee range is not comma-collapsed", finishProspectText(FACT_TELECOM, () => 0.99),
  s => !/\$75,\s*99/.test(s), "not '$75, 99'");
check("ranges: quiet hours remain parseable", finishProspectText(FACT_QUIET, () => 0.99),
  s => !/9 PM,\s*8 AM/.test(s), "not '9 PM, 8 AM'");

// ─── Ordering: the full pipeline on the live defect ───────────────────────────
const finished = finishProspectText(LIVE_FEE_REPLY, () => 0.99);
check("pipeline: end-to-end leaves no markup", finished,
  s => !s.includes("*") && !/\s-\s/.test(s), "clean of markdown and bullets");
check("pipeline: no em/en dash escapes", finished,
  s => !s.includes("—") && !s.includes("–"), "no AI dashes");

// ─── Report ───────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (process.argv.includes("--show-prefix")) {
  console.log("\n--- PRE-FIX REPRODUCTION (what the prospect actually got) ---");
  console.log("stripDashes only, no stripMarkdown:");
  console.log(stripDashes(LIVE_FEE_REPLY).slice(0, 200) + "...");
}
process.exit(fail ? 1 : 0);
