// ════════════════════════════════════════════════════════════════════
//  operator_language_proof.js — BUILD 6B proof harness
//
//    node tests/operator_language_proof.js
//
//  BUILD 6B is a LANGUAGE and SURFACE cleanup. It adds no migration, no
//  domain table, no screen and no capability. Two things did change in
//  substance, and both REMOVE something:
//
//      · a message can no longer accept work
//      · a message can no longer enter the readiness lifecycle at all
//
//  Everything else here asserts that a word changed and nothing underneath
//  did. The ten sections below are the ten proof obligations, in order.
//
//  Part A is pure + structural and runs anywhere. There is no Part B: this
//  build introduces no schema and no new durable behaviour to exercise, so
//  claiming a database section would overstate what exists.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const path = require("path");
const I = require("../src/agent/staff_agent_intent");
const { makeStaffAgentService } = require("../src/agent/staff_agent_service");
const { makeUnitTurnRead } = require("../src/surfaces/unit_turn_read");
const { computeTurnFlow, turnExceptions } = require("../src/maintenance/turn_sequence");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

const APP_DIR = "/workspace/property-spine-app";
const read = (p) => fs.readFileSync(p, "utf8");

//  "Operator-facing copy" means a STRING a surface can print — not a comment
//  explaining the rename, and not a property read. `w.stage_decision_required`
//  is how the column is read; the test is whether its name can ever reach a
//  person. So: strip comments, then keep only string and template literals.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
//  `${i.stage_decision_note}` prints the note's VALUE, not the field's name, so
//  interpolation expressions are dropped before the copy is examined.
const printable = (s) =>
  (stripComments(s).match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [])
    .join("\n").replace(/\$\{[^}]*\}/g, "");

const INTENT_SRC = read(require.resolve("../src/agent/staff_agent_intent"));
const SVC_SRC = read(require.resolve("../src/agent/staff_agent_service"));
const DOOR_SRC = read(require.resolve("../src/agent/staff_agent"));
const READ_SRC = read(require.resolve("../src/surfaces/unit_turn_read"));
const TURN_DOOR_SRC = read(require.resolve("../src/surfaces/unit_turn"));
const SEQ_SRC = read(require.resolve("../src/maintenance/turn_sequence"));
const ACCEPT_SVC_SRC = read(require.resolve("../src/maintenance/work_acceptance_service"));
const APP_PAGE = read(path.join(APP_DIR, "unit-turn-page.js"));
const APP_AGENT = read(path.join(APP_DIR, "staff-agent-door.js"));
const APP_INDEX = read(path.join(APP_DIR, "index.html"));

//  A capture harness that records the calls a canonical service would receive.
//  Nothing is mocked in the product — this is the test double, and if the
//  agent ever reached a canonical write it would be recorded here.
function spy() {
  const calls = [];
  const rec = (name) => async (...a) => { calls.push({ name, args: a }); return {}; };
  return {
    calls,
    deps: {
      unitTriageService: {
        confirmTriage: rec("confirmTriage"), proposeTriage: () => ({}),
        readUnitTriageState: async () => ({}),
      },
      unitTurnScopeService: { confirmScope: rec("confirmScope"), propose: () => ({}) },
      workAcceptanceService: { acceptWork: rec("acceptWork"), claimCompletion: rec("claimCompletion") },
      readinessService: {
        recordWalk: rec("recordWalk"),
        resolveWalkAuthority: async () => ({ authorized: false, reason: "not a manager at this property" }),
      },
    },
  };
}

//  A minimal in-memory client good enough for captureMessage: it resolves a
//  unit, returns no open work, and records inserts.
function fakeClient({ unit = { id: "u1", unit_number: "304" }, openWork = [] } = {}) {
  const inserts = [];
  return {
    inserts,
    query: async (sql, params) => {
      const s = String(sql);
      if (/from units where/i.test(s)) return { rows: unit ? [unit] : [] };
      if (/from unit_triage_required_work/i.test(s)) return { rows: openWork };
      if (/from staff_agent_threads/i.test(s)) return { rows: [{ id: "t1" }] };
      if (/insert into staff_agent_threads/i.test(s)) { inserts.push("thread"); return { rows: [{ id: "t1" }] }; }
      if (/insert into staff_agent_messages/i.test(s)) {
        inserts.push("message");
        return { rows: [{ id: "m1", body: params[3], photos: params[4] }] };
      }
      if (/insert into staff_agent_proposals/i.test(s)) {
        inserts.push("proposal");
        return { rows: [{ id: "p1", intent: params[4], status: params[8], clarification: params[7] }] };
      }
      return { rows: [] };
    },
  };
}

const CTX_WORK = [{ id: "w1", work_text: "Source and install refrigerator", stage: "repair", status: "required" }];

// ════════════════════════════════════════════════════════════════════
section("1  conversational acceptance cannot call acceptWork");
{
  const r = I.classifyIntent("I'll handle the refrigerator tomorrow.", { unit_id: "u1", open_work: CTX_WORK });
  ok("'I'll handle it tomorrow' is a redirect", r.intent === "redirect", r.intent);
  ok("work_acceptance is gone from the intent vocabulary",
     !I.INTENT_VALUES.includes("work_acceptance"), I.INTENT_VALUES.join(","));
  ok("and is recorded as RETIRED, not silently dropped",
     I.RETIRED_INTENTS.includes("work_acceptance"));
  ok("the redirect names the work item", r.redirect.to === "work_item" && r.redirect.work_id === "w1");
  ok("with the direct link, because the item is uniquely known",
     r.redirect.link === "#work-w1", r.redirect.link);
  ok("the copy points at the work item",
     /ready to accept/.test(r.redirect.message) && /ownership and due timing/.test(r.redirect.message),
     r.redirect.message);
  ok("no ownership is proposed", !r.proposed.owner_user_id && !r.proposed.owner_is_speaker);
  ok("no due commitment is proposed", !r.proposed.due_at);

  // STRUCTURAL: the call site is gone from the agent entirely.
  ok("the agent module contains no acceptWork call", !/acceptWork\(/.test(SVC_SRC));
  ok("nor any work_acceptance branch", !/INTENT\.ACCEPT\b/.test(SVC_SRC));
  ok("nor a raw acceptance insert", !/insert\s+into\s+work_acceptances/i.test(SVC_SRC));

  // BEHAVIOURAL: capture the message and watch what the services receive.
  const s = spy();
  const svc = makeStaffAgentService(s.deps);
  const c = fakeClient({ openWork: CTX_WORK });
  const p = svc.captureMessage(c, {
    property_id: "prop", actor_user_id: "user", text: "I'll handle the refrigerator tomorrow.",
    context_unit_id: "u1",
  }).then((out) => {
    ok("capture returns a redirect", !!out.redirect && out.redirect.to === "work_item");
    ok("and NO proposal row", out.proposal === null);
    ok("the message itself is still recorded verbatim", c.inserts.includes("message"));
    ok("no proposal was inserted", !c.inserts.includes("proposal"));
    ok("no canonical service was called", s.calls.length === 0, s.calls.map((x) => x.name).join(","));
    ok("and it says nothing is waiting on the operator",
       /nothing is waiting on you here/i.test(out.nothing_recorded), out.nothing_recorded);
  });
  module.exports.__p1 = p;
}

// ════════════════════════════════════════════════════════════════════
section("2  the Accept button still calls the Build 3 canonical service");
{
  ok("the Unit Turn page still advertises the Build 3 accept door",
     /\/operator\/turn-work\/:workId\/accept/.test(READ_SRC));
  ok("the app's Accept button calls the Build 3 service", /acceptWork\(/.test(APP_PAGE));
  ok("the app renders an Accept button", />Accept work</.test(APP_PAGE));
  ok("the app has no acceptance endpoint of its own",
     !/unit-turn\/(accept|complete|certify)/.test(APP_PAGE));

  // Build 3 itself is untouched by this build.
  ok("acceptance is still not completion", /ACCEPTANCE IS NOT COMPLETION/.test(ACCEPT_SVC_SRC));
  ok("acceptWork still exists as the canonical path", /async function acceptWork/.test(ACCEPT_SVC_SRC));
  ok("it still writes the canonical acceptance row",
     /insert into work_acceptances/i.test(ACCEPT_SVC_SRC));
  const { execSync } = require("child_process");
  const since6A = execSync("git diff --name-only 62b25e8 -- src/maintenance/work_acceptance_service.js src/maintenance/work_acceptance.js migrations/115_work_acceptance_and_proof.sql",
    { cwd: __dirname + "/.." }).toString().trim();
  ok("the Build 3 acceptance service and door are byte-unchanged by BUILD 6B",
     since6A === "", since6A);
}

// ════════════════════════════════════════════════════════════════════
section("3  readiness language cannot create a confirmable proposal");
{
  const r = I.classifyIntent("304 is ready.");
  ok("'304 is ready' is a redirect", r.intent === "redirect", r.intent);
  ok("readiness_request is gone from the intent vocabulary",
     !I.INTENT_VALUES.includes("readiness_request"));
  ok("and is recorded as RETIRED", I.RETIRED_INTENTS.includes("readiness_request"));
  ok("no readiness proposal shape exists", Object.keys(r.proposed).length === 0);

  const s = spy();
  const svc = makeStaffAgentService(s.deps);
  const c = fakeClient();
  const p = svc.captureMessage(c, {
    property_id: "prop", actor_user_id: "user", text: "304 is ready.",
  }).then(async (out) => {
    ok("capture creates NO proposal for readiness", out.proposal === null);
    ok("no proposal row was inserted", !c.inserts.includes("proposal"));
    ok("no canonical service was called", s.calls.length === 0, s.calls.map((x) => x.name).join(","));
    ok("the message is still recorded", c.inserts.includes("message"));

    // There is nothing to confirm — and the guard exists anyway.
    let threw = false, msg = "";
    try {
      await svc.confirmProposal({
        query: async () => ({ rows: [{ id: "p1", intent: "readiness_request", property_id: "prop", status: "proposed", unit_id: "u1" }] }),
      }, { proposal_id: "p1", property_id: "prop", actor_user_id: "user" });
    } catch (e) { threw = true; msg = e.message; }
    ok("a LEGACY readiness_request row still cannot be confirmed", threw);
    ok("and the refusal says a message cannot certify", /cannot certify readiness/i.test(msg), msg);

    let threw2 = false, msg2 = "";
    try {
      await svc.confirmProposal({
        query: async () => ({ rows: [{ id: "p2", intent: "work_acceptance", property_id: "prop", status: "proposed", unit_id: "u1" }] }),
      }, { proposal_id: "p2", property_id: "prop", actor_user_id: "user" });
    } catch (e) { threw2 = true; msg2 = e.message; }
    ok("a LEGACY work_acceptance row still cannot be confirmed", threw2);
    ok("and the refusal points at the work item", /work item/i.test(msg2), msg2);
    ok("no canonical service was called by either refusal", s.calls.length === 0);
  });
  module.exports.__p3 = p;

  ok("no certification call exists anywhere in the agent",
     !/certifyReadiness|correctCertification|finishReady/.test(SVC_SRC));
  ok("the only readiness call is recordWalk with outcome not_ready",
     /outcome: "not_ready"/.test(SVC_SRC) && !/outcome: "ready"/.test(SVC_SRC));
}

// ════════════════════════════════════════════════════════════════════
section("4  readiness language directs to the Build 4 governed action");
{
  const r = I.classifyIntent("304 is ready.");
  ok("the redirect target is the final readiness walk", r.redirect.to === "final_readiness");
  ok("the copy names the final readiness walk",
     /Readiness requires the final readiness walk/.test(r.redirect.message), r.redirect.message);
  ok("and tells the operator where to open it",
     /Open Final Readiness/.test(r.redirect.message), r.redirect.message);
  ok("it states that a message cannot certify",
     r.unknowns.some((u) => /message cannot certify readiness/i.test(u)));

  // WHERE THE OPERATOR LACKS AUTHORITY, SAY SO PLAINLY — read from Build 4.
  const s = spy();
  const svc = makeStaffAgentService(s.deps);
  const p = svc.captureMessage(fakeClient(), {
    property_id: "prop", actor_user_id: "user", text: "304 is ready.",
  }).then((out) => {
    ok("the redirect carries the Build 4 authority answer", out.redirect.authorized === false);
    ok("and says so plainly in the message",
       /You cannot certify this unit: not a manager at this property/.test(out.redirect.message),
       out.redirect.message);
    ok("the authority verdict came from the readiness service, not from here",
       /readinessService\.resolveWalkAuthority/.test(SVC_SRC));
  });
  module.exports.__p4 = p;

  ok("the page still offers the walk only when the SERVER says may_walk",
     /may_walk/.test(READ_SRC) && /may_walk/.test(APP_PAGE));
  ok("the page never decides authority itself", !/allowed_modules|role_title/.test(APP_PAGE));
}

// ════════════════════════════════════════════════════════════════════
section("5  both historical clarification statuses render identically");
{
  const A = { id: "a", intent: "initial_triage", status: "clarification_required", clarification: "Which unit?" };
  const B = { id: "b", intent: "unclear", status: "proposed", clarification: "Which unit?" };

  ok("a stored clarification_required needs clarification", I.needsClarification(A) === true);
  ok("a stored unclear intent needs clarification too", I.needsClarification(B) === true);
  ok("both produce the SAME operator label", I.statusLabel(A) === I.statusLabel(B), I.statusLabel(A));
  ok("and that label is plain language", I.statusLabel(A) === "Needs clarification");
  ok("a normal proposal is NOT collapsed into it",
     I.needsClarification({ intent: "initial_triage", status: "proposed" }) === false);
  ok("nothing else borrows the label",
     I.statusLabel({ intent: "initial_triage", status: "confirmed" }) === "Recorded");

  ok("the service decides it once and every surface reads that",
     /needs_clarification: needsClarification\(p\)/.test(SVC_SRC) &&
     /status_label: statusLabel\(p\)/.test(SVC_SRC));
  ok("the Unit Turn read forwards the same decision",
     /needs_clarification: needsClarification\(p\)/.test(READ_SRC));

  //  NO SURFACE MAY BRANCH ON THE RAW STATUS STRING — that is what let two
  //  identical meanings look different in the first place.
  ok("the app page never compares against the raw status",
     !/status === "clarification_required"/.test(APP_PAGE));
  ok("the diagnostic agent door never does either",
     !/status === "clarification_required"/.test(APP_AGENT));
  ok("the app page reads the collapsed flag", /needs_clarification/.test(APP_PAGE));
  ok("the diagnostic door reads it too", /p\.needs_clarification/.test(APP_AGENT));
  ok("the app prints one status label", /status_label/.test(APP_PAGE));
  ok("no surface can print the word 'unclear'",
     !/unclear/.test(printable(APP_PAGE)) && !/unclear/.test(printable(APP_AGENT)));
  ok("nor the raw status string",
     !/clarification_required/.test(printable(APP_PAGE)) &&
     !/clarification_required/.test(printable(APP_AGENT)));

  //  The operator sees: what Spine understood · the missing detail · one question.
  ok("what Spine understood is shown in plain language", /plain_label/.test(APP_PAGE));
  ok("the missing detail is shown", /p\.unknowns/.test(APP_PAGE));
  ok("and one concise question is shown", /p\.clarification/.test(APP_PAGE));
}

// ════════════════════════════════════════════════════════════════════
section("6  new ambiguous messages use the preferred clarification status");
{
  ok("there is exactly ONE preferred status constant",
     I.CLARIFICATION_STATUS === "clarification_required");
  ok("the service writes only that constant, never a literal",
     (SVC_SRC.match(/status = CLARIFICATION_STATUS/g) || []).length >= 3 &&
     !/status = "clarification_required"/.test(SVC_SRC));

  const s = spy();
  const svc = makeStaffAgentService(s.deps);

  // An unclear message.
  const c1 = fakeClient({ unit: null });
  const p6a = svc.captureMessage(c1, {
    property_id: "prop", actor_user_id: "user", text: "304 is bad.",
  }).then((out) => {
    ok("an unintelligible message yields the preferred status",
       out.proposal.status === "clarification_required", out.proposal.status);
    ok("it is flagged as needing clarification", out.needs_clarification === true);
    ok("and carries one concise question", !!out.proposal.clarification, out.proposal.clarification);
    ok("no canonical service was called", s.calls.length === 0);
  });

  // A photo with too little text.
  const c2 = fakeClient();
  const p6b = svc.captureMessage(c2, {
    property_id: "prop", actor_user_id: "user", text: "see", photos: ["p1"], context_unit_id: "u1",
  }).then((out) => {
    ok("a photo with too little text also uses the preferred status",
       out.proposal.status === "clarification_required", out.proposal.status);
    ok("and asks what the photo shows",
       /what condition or action/i.test(out.proposal.clarification || ""), out.proposal.clarification);
  });

  // A paint message missing its level.
  const c3 = fakeClient();
  const p6c = svc.captureMessage(c3, {
    property_id: "prop", actor_user_id: "user", text: "304 needs paint.",
  }).then((out) => {
    ok("a scope message missing a level uses the preferred status",
       out.proposal.status === "clarification_required", out.proposal.status);
    ok("and asks the one missing detail",
       /Touch-up, partial, or full/i.test(out.proposal.clarification || ""), out.proposal.clarification);
  });

  module.exports.__p6 = Promise.all([p6a, p6b, p6c]);

  ok("migration 117 still permits the stored value, so no migration is needed",
     /clarification_required/.test(read(__dirname + "/../migrations/117_staff_agent_capture.sql")));
}

// ════════════════════════════════════════════════════════════════════
section("7  stage_decision_required never appears in operator-facing copy");
{
  //  Owned, so the "assign an owner" action does not win the controlling slot
  //  ahead of the placement question this section is about.
  const inherited = {
    id: "w9", work_text: "Source and install refrigerator", status: "required",
    stage: null, stage_decision_required: true, owner_user_id: "user-1",
  };
  const flow = computeTurnFlow({
    scope: { inspection_completeness: "complete" }, work: [inherited],
  });
  const item = flow.items[0];

  ok("the underlying field is unchanged", item.requires_scope_decision === true);
  ok("the operator label is plain", item.placement_label === "Needs placement in the turn flow");
  ok("with the supporting explanation",
     item.placement_explanation === "Decide whether this work belongs before paint, before cleaning, or elsewhere.",
     item.placement_explanation);

  const ctl = flow.controlling_next_action;
  ok("the controlling action is the compact placement sentence",
     ctl.action === 'Place "Source and install refrigerator" in the turn sequence', ctl.action);
  ok("its explanation is plain too", /before paint, before cleaning, or elsewhere/.test(ctl.why), ctl.why);
  ok("no operator sentence contains the column name",
     !/stage_decision_required/.test(JSON.stringify(flow)));
  ok("nor the word 'staged' as an instruction", !/until it is staged/.test(JSON.stringify(flow)));

  const exc = turnExceptions({ scope: { inspection_completeness: "complete" }, work: [inherited], flow });
  const e = exc.find((x) => x.code === "inherited_work_not_placed");
  ok("the management exception label is plain",
     e.label === "Work from the initial walk needs placement in the turn flow", e.label);
  ok("and its detail names the turn flow, not a stage decision",
     /no place in the turn flow/.test(e.detail) && !/stage_decision/.test(e.detail));

  //  The Unit Turn page FORWARDS it — it does not re-derive placement.
  ok("the page forwards requires_scope_decision from the flow",
     /fi\.requires_scope_decision/.test(READ_SRC));
  ok("the page reads the flow's verdict, never the column",
     !/stage_decision_required/.test(READ_SRC.replace(/^\s*\/\/.*$/gm, "")));
  ok("and emits plain placement language",
     /placement_label/.test(READ_SRC) && /in the turn sequence/.test(READ_SRC));

  //  NOT ONE operator-facing file may be ABLE to print the column name — the
  //  test is over printable strings, so reading the field stays legal.
  for (const [name, src] of [
    ["the sequence engine", SEQ_SRC],
    ["the Unit Turn read", READ_SRC],
    ["the Unit Turn door", TURN_DOOR_SRC],
    ["the app page", APP_PAGE],
    ["the diagnostic agent door", APP_AGENT],
  ]) {
    ok(`${name} can print no stage_decision_required`, !/stage_decision_required/.test(printable(src)));
    ok(`${name} can print no stage_decision_note either`, !/stage_decision_note/.test(printable(src)));
  }
  ok("the app renders the plain placement label", /placement_label/.test(APP_PAGE));
  ok("and the compact placement action", /placement_action/.test(APP_PAGE));
}

// ════════════════════════════════════════════════════════════════════
section("8  no migration and no domain table change is introduced");
{
  const migs = fs.readdirSync(__dirname + "/../migrations").filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  ok("the migration ceiling is still 117", migs[migs.length - 1].startsWith("117"), migs[migs.length - 1]);
  ok("no 118 exists", !migs.some((f) => f.startsWith("118")));

  const { execSync } = require("child_process");
  const changed = execSync("git diff --name-only 62b25e8", { cwd: __dirname + "/.." })
    .toString().trim().split("\n").filter(Boolean);
  ok("no migration file was touched", !changed.some((f) => f.startsWith("migrations/")), changed.join(","));

  //  The canonical services that own domain truth: only the staff agent, the
  //  page read, and the sequence LANGUAGE may change in this build.
  const ALLOWED = [
    "src/agent/staff_agent_intent.js", "src/agent/staff_agent_service.js", "src/agent/staff_agent.js",
    "src/surfaces/unit_turn_read.js", "src/maintenance/turn_sequence.js",
    "tests/operator_language_proof.js", "tests/staff_agent_proof.js", "tests/unit_turn_page_proof.js",
  ];
  const unexpected = changed.filter((f) => !ALLOWED.includes(f));
  ok("only the language surfaces changed", unexpected.length === 0, unexpected.join(","));

  //  And the language surfaces write nothing.
  for (const [name, src] of [["the Unit Turn read", READ_SRC], ["the sequence engine", SEQ_SRC]]) {
    ok(`${name} performs no INSERT`, !/insert\s+into/i.test(src));
    ok(`${name} performs no UPDATE`, !/update\s+\w+\s+set/i.test(src));
    ok(`${name} performs no DELETE`, !/delete\s+from/i.test(src));
  }
  ok("the sequence engine is still pure — no database, no clock",
     !/\bpool\b|\bclient\.query\b|Date\.now\(/.test(SEQ_SRC));
  ok("the intent module is still pure",
     !/insert into|update .* set|select .* from/i.test(INTENT_SRC));
  ok("the agent still writes only its own three conversation tables",
     (SVC_SRC.match(/insert into (\w+)/gi) || [])
       .every((m) => /staff_agent_(threads|messages|proposals)/i.test(m)));
}

// ════════════════════════════════════════════════════════════════════
section("9  the primary navigation remains two screens");
{
  ok("the API exposes exactly two primary read routes",
     (TURN_DOOR_SRC.match(/router\.get\(/g) || []).length === 2);
  ok("one is the turn list", /router\.get\("\/operator\/turns"/.test(TURN_DOOR_SRC));
  ok("one is the Unit Turn page", /router\.get\("\/operator\/units\/:unitId\/turn"/.test(TURN_DOOR_SRC));
  ok("the door exposes no write route",
     (TURN_DOOR_SRC.match(/router\.(get|post|patch|put|delete)\(/g) || []).every((m) => /router\.get\(/.test(m)));
  ok("management is a filter over the same list, not a third screen",
     /management_is_a_filter/.test(TURN_DOOR_SRC) &&
     !/operator\/management|operator\/exceptions/.test(TURN_DOOR_SRC));
  ok("an attention row opens the SAME Unit Turn page",
     /opens: `\/operator\/units\/\$\{u\.id\}\/turn`/.test(TURN_DOOR_SRC));

  ok("the app has the two mount points", /psTurnList/.test(APP_INDEX) && /psUnitTurnPage/.test(APP_INDEX));
  ok("the app page renders exactly those two", /renderList\(\)/.test(APP_PAGE) && /renderTurn\(\)/.test(APP_PAGE));

  //  NO LINK BACK INTO THE OLD MULTI-SURFACE EXPERIENCE.
  const OLD_MOUNTS = [
    "psUnitTriageCapture", "psUnitTriageWalks", "psUnitTriageRisk",
    "psTurnScopeCapture", "psTurnFlow", "psTurnExceptions",
    "psWorkFlow", "psReadinessQueue", "psReadinessWalk", "psStaffAgent",
  ];
  for (const m of OLD_MOUNTS) {
    ok(`the Unit Turn page never targets ${m}`, !new RegExp(m).test(APP_PAGE));
  }
  const OLD_DOORS = ["unit-triage-door", "turn-scope-door", "work-acceptance-door", "readiness-door", "staff-agent-door"];
  for (const d of OLD_DOORS) {
    ok(`and never loads or links ${d}.js`, !new RegExp(d).test(APP_PAGE));
  }
  ok("nor calls another door's boot", !/__psUnitTriage|__psTurnScope|__psWorkFlow|__psReadiness|__psStaffAgent/.test(APP_PAGE));

  //  A redirect points at something ON the page, never at another surface.
  ok("a work redirect opens the item on this page", /rd-work/.test(APP_PAGE));
  ok("and it opens the panel rather than navigating", /S\.open\[i\] = true/.test(APP_PAGE));
  ok("the readiness redirect points at this page's own section",
     /Final readiness is on this page/.test(APP_PAGE));
  ok("no redirect emits an external href", !/href=/.test(APP_PAGE));
}

// ════════════════════════════════════════════════════════════════════
section("10  the staff agent supports exactly three purposes");
{
  const PURPOSES = ["Report a condition", "Add or correct turn scope", "Report completed work"];

  ok("the server states the three purposes",
     PURPOSES.every((p) => new RegExp('"' + p + '"').test(READ_SRC)), READ_SRC.includes("message_purposes"));
  ok("and states nothing else as a purpose",
     (READ_SRC.match(/message_purposes: \[([\s\S]*?)\]/) || [, ""])[1].split(",").filter((x) => x.trim()).length === 3);
  ok("the app declares the same three, in the same order",
     new RegExp(PURPOSES.map((p) => '"' + p + '"').join(", ")).test(APP_PAGE));
  ok("the app prints them above the box", /message_purposes/.test(APP_PAGE) && /A message does three things/.test(APP_PAGE));
  ok("and states what a message cannot do", /message_excludes/.test(APP_PAGE));
  ok("the exclusions name acceptance and readiness",
     /Taking on work is a tap on the work item/.test(READ_SRC) &&
     /Readiness comes from the final readiness walk/.test(READ_SRC));

  //  The three purposes are exactly the three confirmable intents that remain
  //  (plus correction, which is a path into an existing record, and unclear,
  //  which records nothing).
  const CONFIRMABLE = ["initial_triage", "turn_scope", "work_completion", "failed_final_walk"];
  for (const k of CONFIRMABLE) ok(`${k} is still a real intent`, I.INTENT_VALUES.includes(k));
  ok("and no intent exists outside the documented set",
     I.INTENT_VALUES.every((v) =>
       CONFIRMABLE.concat(["redirect", "correction", "unclear"]).includes(v)),
     I.INTENT_VALUES.join(","));
  ok("every remaining intent maps to a named service or to none",
     I.INTENT_VALUES.every((v) => typeof I.INTENT_SERVICE[v] === "string"));
  ok("redirect maps to NO service",
     /^none/i.test(I.INTENT_SERVICE.redirect) && /not a proposal/i.test(I.INTENT_SERVICE.redirect),
     I.INTENT_SERVICE.redirect);

  //  Completion by message stays, because a person really does say it — but
  //  the button remains the primary path.
  const r = I.classifyIntent("The refrigerator is installed and working.", { unit_id: "u1", open_work: CTX_WORK });
  ok("a completion message still classifies", r.intent === "work_completion", r.intent);
  ok("the primary completion action is still the button", /"Complete work"/.test(APP_PAGE));
  ok("with photo capture on the work item", /wk-photo/.test(APP_PAGE));

  //  NO INTERNAL NAME REACHES THE OPERATOR.
  ok("plain language for every intent lives in ONE place", /INTENT_PLAIN/.test(INTENT_SRC));
  ok("the page imports it rather than re-declaring it",
     /INTENT_PLAIN,[\s\S]{0,120}\} = require\("\.\.\/agent\/staff_agent_intent"\)/.test(READ_SRC));
  for (const v of I.INTENT_VALUES.concat(I.RETIRED_INTENTS)) {
    ok(`'${v}' has a plain label`, !!I.INTENT_PLAIN[v]);
    ok(`and it is not the raw name`, I.INTENT_PLAIN[v] !== v && !/_/.test(I.INTENT_PLAIN[v]));
  }
  ok("the API door replies in plain language, never a raw intent",
     /INTENT_PLAIN\[p\.intent\]/.test(DOOR_SRC) && !/p\.intent\.replace/.test(DOOR_SRC));
  ok("the app page prints plain_label", /plain_label/.test(APP_PAGE));
  ok("the diagnostic door prints plain_label too", /plain_label/.test(APP_AGENT));
  ok("neither prints a raw intent name",
     !/String\(p\.intent\)/.test(APP_AGENT) && !/\.intent\s*\)/.test(APP_PAGE.replace(/plain_label/g, "")));

  //  Nor a raw marketing-state enum. The availability read already computes
  //  the label; the page was printing the state name beside it.
  ok("the read emits a marketability LABEL", /marketability_label/.test(READ_SRC));
  ok("and reports a failed availability read as a failure, not a blank",
     /Availability could not be read/.test(READ_SRC));
  ok("the app prints the label, not the state", /t\.status\.marketability_label/.test(APP_PAGE));
  ok("the app never prints the raw marketing state",
     !/t\.status\.marketability\b/.test(APP_PAGE.replace(/marketability_label/g, "")));
}

// ════════════════════════════════════════════════════════════════════
//  Every async assertion must settle before RESULT prints, or a green line
//  would be printed before the work that could turn it red.
Promise.all([module.exports.__p1, module.exports.__p3, module.exports.__p4, module.exports.__p6])
  .then(() => {
    section("RESULT");
    console.log("  assertions passed: " + passed);
    console.log("  assertions failed: " + failed);
    if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
    console.log("\n  PROOF LEVEL: Built-but-dormant (pure + structural).");
    console.log("  BUILD 6B adds no migration and no durable behaviour, so there is no");
    console.log("  database section to run. What it REMOVED — conversational acceptance and");
    console.log("  the readiness proposal lifecycle — is proven by exercising captureMessage");
    console.log("  and confirmProposal against recording doubles and observing that no");
    console.log("  canonical service is reached and no proposal row is written.");
    console.log("  Browser verification remains blocked on the database baseline artifacts.");
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
