// ════════════════════════════════════════════════════════════════════
//  unit_turn_page_proof.js — BUILD 6A proof harness
//
//  Consolidation build. The claim under test is NOT that new behaviour works —
//  it is that NO new behaviour was created. Every assertion here is structural:
//  the page composes, forwards, and delegates, and owns nothing.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const { makeUnitTurnRead } = require("../../src/surfaces/unit_turn_read");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

const READ = fs.readFileSync(require.resolve("../src/surfaces/unit_turn_read"), "utf8");
const DOOR = fs.readFileSync(require.resolve("../src/surfaces/unit_turn"), "utf8");
const APP = fs.readFileSync("/workspace/property-spine-app/unit-turn-page.js", "utf8");
const BOTH = READ + DOOR;

section("F1  the page creates NO state and NO second model");
{
  const DOMAIN = [
    "unit_triage_findings", "unit_triage_required_work", "unit_triage_confirmations",
    "unit_observations", "unit_turn_scopes", "unit_turn_appliances",
    "work_acceptances", "work_completion_claims", "work_reopenings",
    "unit_readiness_walks", "unit_readiness_certifications", "reclean_rulings",
    "obligations", "staff_agent_proposals", "staff_agent_messages",
  ];
  for (const t of DOMAIN) {
    ok(`no INSERT into ${t}`, !new RegExp("insert\\s+into\\s+" + t, "i").test(BOTH));
    ok(`no UPDATE of ${t}`, !new RegExp("update\\s+" + t + "\\b", "i").test(BOTH));
  }
  ok("no INSERT of any kind", !/insert\s+into/i.test(BOTH));
  ok("no UPDATE of any kind", !/update\s+\w+\s+set/i.test(BOTH));
  ok("no DELETE of any kind", !/delete\s+from/i.test(BOTH));
  //  BUILD 6A added no migration, and that claim is pinned to Build 6A rather
  //  than to the working tree: the closure slice adds 118 deliberately.
  ok("BUILD 6A added no migration of its own",
     !fs.existsSync(__dirname + "/../migrations/118_unit_turn.sql"));
  const { execSync: _ex } = require("child_process");
  const addedBy6A = _ex("git diff --name-only 8fc4982 62b25e8 -- migrations/", { cwd: __dirname + "/.." })
    .toString().trim();
  ok("BUILD 6A changed no migration file", addedBy6A === "", addedBy6A);
}

section("F2  every canonical read is REQUIRED, so nothing can be derived locally");
{
  const stub = () => ({
    unitTriageService: { readUnitTriageState: async () => ({}), nextCommittedMoveIn: async () => null },
    unitTurnScopeService: { readTurnFlow: async () => ({}) },
    workAcceptanceService: { readUnitFlow: async () => ({ work: [] }), readWorkState: async () => ({}) },
    readinessService: { readGateState: async () => ({ gate: {} }), resolveWalkAuthority: async () => ({}) },
  });
  ok("builds with all four", (() => { try { makeUnitTurnRead(stub()); return true; } catch (e) { return false; } })());
  for (const k of Object.keys(stub())) {
    const d = stub(); delete d[k];
    let threw = false, msg = "";
    try { makeUnitTurnRead(d); } catch (e) { threw = true; msg = e.message; }
    ok(`construction FAILS without ${k}`, threw);
    ok(`and the error names ${k}`, msg.includes(k));
  }
  ok("the error states it composes and cannot derive",
     (() => { const d = stub(); delete d.readinessService;
       try { makeUnitTurnRead(d); return false; } catch (e) { return /COMPOSES canonical reads/.test(e.message); } })());
}

section("F3  each layer's answer is FORWARDED, not recomputed");
{
  ok("triage state comes from the triage service", /unitTriageService\.readUnitTriageState/.test(READ));
  ok("scope comes from the scope service", /unitTurnScopeService\.readTurnFlow/.test(READ));
  ok("work + flow come from the acceptance service", /workAcceptanceService\.readUnitFlow/.test(READ));
  ok("per-item proof state comes from the acceptance service", /workAcceptanceService\.readWorkState/.test(READ));
  ok("the readiness gate comes from the readiness service", /readinessService\.readGateState/.test(READ));
  ok("readiness authority comes from the readiness service", /readinessService\.resolveWalkAuthority/.test(READ));
  ok("availability comes from the canonical availability read", /availabilityRead\(/.test(READ));
  ok("the thread comes from the staff-agent service", /staffAgentService\.readThread/.test(READ));

  // NO second engine of any kind
  ok("does not require the sequence engine", !/require\(.*turn_sequence/.test(BOTH));
  ok("does not require the readiness gate module", !/require\(.*readiness_gate/.test(BOTH));
  ok("does not require any interpreter", !/require\(.*interpreter/.test(BOTH));
  ok("does not compute proof", !/evaluateProof|proofRequirementFor\(/.test(BOTH));
  ok("does not compute a marketing state", !/marketingState\(/.test(BOTH));
  ok("the controlling action is forwarded from the work flow",
     /workFlow\.flow \? workFlow\.flow\.controlling_next_action/.test(READ));
  ok("it documents that deriving here would create a sixth source of truth",
     /sixth source of truth/i.test(READ));
}

section("F4  writes still delegate to the Build 1-5 canonical doors");
{
  ok("accept points at the Build 3 door", /\/operator\/turn-work\/:workId\/accept/.test(READ));
  ok("complete points at the Build 3 door", /\/operator\/turn-work\/:workId\/claim/.test(READ));
  ok("reopen points at the Build 3 door", /\/operator\/turn-work\/:workId\/reopen/.test(READ));
  ok("the final walk points at the Build 4 door", /\/operator\/units\/:id\/readiness\/walk/.test(READ));
  ok("messages point at the Build 5 door", /\/operator\/staff-agent\/message/.test(READ));
  ok("the door itself exposes only GET routes",
     (DOOR.match(/router\.(get|post|patch|put|delete)\(/g) || []).every((m) => /router\.get\(/.test(m)));

  // the app posts to the canonical doors, never to a 6A endpoint
  ok("the app accepts via the Build 3 service", /acceptWork\(/.test(APP));
  ok("the app completes via the Build 3 service", /claimWorkCompletion\(/.test(APP));
  ok("the app walks via the Build 4 service", /readinessWalk\(/.test(APP));
  ok("the app messages via the Build 5 service", /staffAgentMessage\(/.test(APP));
  ok("the app has no write endpoint of its own", !/unit-turn\/(accept|complete|certify)/.test(APP));
}

section("F5  acceptance is a BUTTON; readiness is never conversational");
{
  ok("the app renders an Accept button", /Accept work|>Accept</.test(APP));
  ok("the app renders a Complete action", /Complete work|>Complete</.test(APP));
  ok("the app renders the final walk as a governed action", /Perform final readiness walk/i.test(APP));
  ok("the message box does not advertise acceptance",
     !/placeholder="[^"]*I'?ll (handle|take|do)/i.test(APP));
  ok("the message box does not advertise readiness",
     !/placeholder="[^"]*is ready/i.test(APP));
  ok("the message box advertises observation and completion instead",
     /cockroaches|needs full paint|installed and working/i.test(APP));
  ok("readiness is offered only when the SERVER says the operator may walk",
     /may_walk/.test(APP));
  ok("the page never decides authority itself", !/allowed_modules|role_title/.test(APP));
}

section("F6  no internal intent names reach the operator");
{
  const r = makeUnitTurnRead({
    unitTriageService: { readUnitTriageState: async () => ({}), nextCommittedMoveIn: async () => null },
    unitTurnScopeService: { readTurnFlow: async () => ({}) },
    workAcceptanceService: { readUnitFlow: async () => ({ work: [] }), readWorkState: async () => ({}) },
    readinessService: { readGateState: async () => ({ gate: {} }), resolveWalkAuthority: async () => ({}) },
  });
  for (const k of ["initial_triage", "turn_scope", "work_acceptance", "work_completion", "readiness_request"]) {
    ok(`'${k}' has a plain-language label`, !!r.INTENT_PLAIN[k]);
    ok(`and the label is not the raw name`, r.INTENT_PLAIN[k] !== k && !/_/.test(r.INTENT_PLAIN[k]));
  }
  ok("the app renders plain_label, never the raw intent", /plain_label/.test(APP));
  ok("the app never prints a raw intent name",
     !/\bintent\b\s*\)|\.intent\s*\)/.test(APP.replace(/plain_label/g, "")));
}

section("F7  management is a FILTER over the same truth, not a workflow");
{
  ok("one list endpoint, filtered by query", /req\.query\.attention/.test(DOOR));
  ok("there is no separate management endpoint", !/operator\/management|operator\/exceptions/.test(DOOR));
  ok("each row opens the SAME Unit Turn page", /opens: `\/operator\/units\/\$\{u\.id\}\/turn`/.test(DOOR));
  ok("and says so explicitly", /management_is_a_filter/.test(DOOR));
  ok("attention reasons are read from layer state, not recomputed",
     /t\.work\.some|t\.status\.next_move_in|t\.scope\.inspection_completeness/.test(DOOR));
  ok("an empty attention list says routine work is deliberately absent",
     /deliberately not listed/.test(DOOR));
}

section("F8  the truth model is unchanged underneath");
{
  // The six distinctions, still enforced by the layers that own them.
  const svc = fs.readFileSync(require.resolve("../src/maintenance/work_acceptance_service"), "utf8");
  const rdy = fs.readFileSync(require.resolve("../src/maintenance/readiness_service"), "utf8");
  ok("acceptance is still not completion", /ACCEPTANCE IS NOT COMPLETION/.test(svc));
  ok("a proof-short claim still does not close", /A COMPLETION CLAIM WITHOUT PROOF DOES NOT CLOSE/.test(svc));
  ok("closed work still is not readiness", /ABSENCE OF OPEN WORK IS NOT READINESS/.test(rdy));
  ok("the page repeats that readiness is not inferred",
     /not from closed work/i.test(READ));
  ok("the page distinguishes physically ready from marketable",
     /Physically ready but not currently marketable/.test(READ));
  ok("and reports a failed availability read as a failure, not an absence",
     /availability read failed/.test(READ));

  // Builds 1-5 sources untouched by BUILD 6A.
  //
  //  The range is pinned to Build 5 → Build 6A rather than → HEAD. The claim
  //  this asserts is about what BUILD 6A changed, and it stays true forever.
  //  Measuring to HEAD would silently turn it into "no later build may ever
  //  touch a service", which is a different claim and a false one: BUILD 6B
  //  changes the staff-agent service on purpose.
  const { execSync } = require("child_process");
  const changed = execSync("git diff --name-only 8fc4982 62b25e8", { cwd: __dirname + "/.." }).toString().trim().split("\n").filter(Boolean);
  const touchedCore = changed.filter((f) =>
    /^src\/maintenance\/|^src\/agent\/|^migrations\//.test(f));
  ok("no Build 1-5 service or migration was modified", touchedCore.length === 0, touchedCore.join(","));
}

section("RESULT");
console.log("  assertions passed: " + passed);
console.log("  assertions failed: " + failed);
if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
console.log("\n  PROOF LEVEL: Built-but-dormant (structural only).");
console.log("  This is a CONSOLIDATION build: the claim is that no new behaviour exists.");
console.log("  Browser proof remains blocked on the database baseline artifacts.");
process.exit(failed > 0 ? 1 : 0);
