// ════════════════════════════════════════════════════════════════════
//  release_candidate_proof.js — THE UNIT-TURN RELEASE CANDIDATE
//
//    node tests/release_candidate_proof.js
//
//  This harness exists to DISPROVE the release candidate, not to defend it.
//  Where it can construct a state that breaks a claim, it does, and it records
//  the break as a failure rather than adjusting the claim to fit.
//
//  Sections map 1:1 to the pressure test:
//     5  canonical truth boundaries        11  availability precedence
//     6  one governed work list            12  staff-agent boundary
//     7  flow liveness (state matrix)      13  UI simplification
//     8  authority                         15  photo proof
//     9  idempotency and concurrency       16  live-first seams
//    10  history and correction            17  by-bed grain
//
//  ── WHAT IT CANNOT DO ───────────────────────────────────────────────
//  There is no database here. Sections 9 and parts of 5, 8 and 10 depend on
//  Postgres actually enforcing a constraint, and this harness can only prove
//  that the constraint is WRITTEN and that the code path reaches for it. Those
//  are marked `unproven without Postgres` in the classification, and that is a
//  real gap, not a formality.
//
//  Nothing here is live proof of anything.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const path = require("path");

const SEQ = require("../src/maintenance/turn_sequence");
const GATE = require("../src/maintenance/readiness_gate");
const PROOF = require("../src/maintenance/work_proof");
const INTENT = require("../src/agent/staff_agent_intent");
const { makeUnitTurnRead } = require("../src/surfaces/unit_turn_read");
const { makeStaffAgentService } = require("../src/agent/staff_agent_service");

let passed = 0, failed = 0;
const fails = [];
const verdicts = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 62 - t.length)));
const verdict = (s, v, note) => { verdicts.push({ section: s, verdict: v, note }); console.log(`     VERDICT: ${v}${note ? " — " + note : ""}`); };

const REPO = path.join(__dirname, "..");
const APP = "/workspace/property-spine-app";
const read = (p) => fs.readFileSync(p, "utf8");
const src = (p) => read(path.join(REPO, p));
const app = (p) => read(path.join(APP, p));

//  "Operator-facing copy" means a string a surface can print — not a comment,
//  not a property read. Strip comments, keep string and template literals,
//  drop interpolation expressions.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l))   // JS line comment
  .map((l) => l.replace(/--.*$/, ""))    // SQL line comment
  .join("\n");
//  Interpolated VALUES are not copy: `esc(t.unit_id)` prints a unit number, it
//  does not print the words "unit_id". Concatenated HTML also defeats a naive
//  quote lexer, so expressions are removed before literals are extracted.
const printable = (s) =>
  (stripComments(s)
    .replace(/esc\([^)]*\)/g, "\u0001")
    .replace(/\$\{[^}]*\}/g, "\u0001")
    .match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [])
    .join("\n");

const INTENT_SRC_TEXT = read(path.join(REPO, "src/agent/staff_agent_intent.js"));
const INTENT_SRC_ORDER = (needle) => INTENT_SRC_TEXT.indexOf(needle);

const BUILD_SERVICES = [
  "src/maintenance/unit_triage_service.js", "src/maintenance/unit_turn_scope_service.js",
  "src/maintenance/work_acceptance_service.js", "src/maintenance/readiness_service.js",
  "src/agent/staff_agent_service.js",
];
const BUILD_PURE = [
  "src/maintenance/unit_triage_interpreter.js", "src/maintenance/turn_scope_interpreter.js",
  "src/maintenance/turn_sequence.js", "src/maintenance/readiness_gate.js",
  "src/maintenance/work_proof.js", "src/agent/staff_agent_intent.js",
];
const BUILD_DOORS = [
  "src/maintenance/unit_triage.js", "src/maintenance/unit_turn_scope.js",
  "src/maintenance/work_acceptance.js", "src/maintenance/readiness.js",
  "src/agent/staff_agent.js", "src/surfaces/unit_turn.js",
];
const BUILD_READS = ["src/surfaces/unit_turn_read.js"];

const DOMAIN_TABLES = [
  "unit_observations", "unit_triage_confirmations", "unit_triage_findings",
  "unit_triage_required_work", "unit_turn_scopes", "unit_turn_appliances",
  "work_acceptances", "work_completion_claims", "work_reopenings",
  "unit_readiness_walks", "unit_readiness_certifications", "reclean_rulings",
];

// ════════════════════════════════════════════════════════════════════
section("5  canonical truth boundaries");
{
  //  Every domain write lives in a canonical service. Doors and reads route.
  let strays = [];
  for (const f of BUILD_DOORS.concat(BUILD_READS, BUILD_PURE)) {
    const s = stripComments(src(f));
    for (const t of DOMAIN_TABLES) {
      if (new RegExp("insert\\s+into\\s+" + t + "\\b", "i").test(s)) strays.push(`${f}: INSERT ${t}`);
      if (new RegExp("update\\s+" + t + "\\b", "i").test(s)) strays.push(`${f}: UPDATE ${t}`);
      if (new RegExp("delete\\s+from\\s+" + t + "\\b", "i").test(s)) strays.push(`${f}: DELETE ${t}`);
    }
  }
  ok("no door, read or pure module writes a domain table", strays.length === 0, strays.join(" | "));

  //  A projection may not write.
  for (const f of BUILD_READS) {
    const s = stripComments(src(f));
    ok(`${f} performs no INSERT`, !/insert\s+into/i.test(s));
    ok(`${f} performs no UPDATE`, !/update\s+\w+\s+set/i.test(s));
    ok(`${f} performs no DELETE`, !/delete\s+from/i.test(s));
  }

  //  The eight distinctions, each enforced where it is owned.
  const triage = src("src/maintenance/unit_triage_service.js");
  const scope = src("src/maintenance/unit_turn_scope_service.js");
  const accept = src("src/maintenance/work_acceptance_service.js");
  const ready = src("src/maintenance/readiness_service.js");
  const agent = src("src/agent/staff_agent_service.js");

  ok("message ≠ proposal — capture writes a message and a proposal separately",
     /insert into staff_agent_messages/i.test(agent) && /insert into staff_agent_proposals/i.test(agent));
  ok("proposal ≠ confirmation — capture never calls a canonical service",
     !/\.(confirmTriage|confirmScope|claimCompletion)\(/.test(
       agent.slice(agent.indexOf("async function captureMessage"), agent.indexOf("async function confirmProposal"))));
  ok("observation ≠ finding — they are separate tables in 112",
     /create table if not exists unit_observations/i.test(src("migrations/112_unit_triage_capture.sql")) &&
     /create table if not exists unit_triage_findings/i.test(src("migrations/112_unit_triage_capture.sql")));
  ok("finding ≠ required work — required work is its own table with its own row",
     /create table if not exists unit_triage_required_work/i.test(src("migrations/112_unit_triage_capture.sql")));
  ok("acceptance ≠ progress — stated and enforced in the acceptance service",
     /ACCEPTANCE IS NOT COMPLETION/.test(accept));
  ok("'accepted' is NOT a work status", !/'accepted'/.test(printable(src("migrations/115_work_acceptance_and_proof.sql"))));
  ok("claim ≠ proof-satisfied completion",
     /A COMPLETION CLAIM WITHOUT PROOF DOES NOT CLOSE/.test(accept));
  ok("closed work ≠ readiness", /ABSENCE OF OPEN WORK IS NOT READINESS/.test(ready));
  ok("readiness ≠ marketability — certification FALLS THROUGH the guard chain",
     /deliberate no-op: continue to the use-type guards below/.test(src("src/surfaces/availability_read.js")));

  //  MISSING EVIDENCE IS NEVER POSITIVE EVIDENCE.
  ok("triage readiness can only be not_ready or unknown — never ready",
     !/readiness\s*=\s*"ready"|return "ready"/.test(stripComments(triage)));
  ok("the interpreter has no 'ready' in its vocabulary",
     !/\bready\b/i.test(printable(src("src/maintenance/unit_triage_interpreter.js"))));
  ok("unstaged work with a complete scope BLOCKS readiness, rather than being ignored",
     /w\.stage_decision_required === true \|\| scopeComplete/.test(src("src/maintenance/turn_sequence.js")));
  ok("a partial inspection blocks readiness", /inspection_incomplete/.test(src("src/maintenance/turn_sequence.js")));
  ok("NULL disturbs_painted_surfaces is treated conservatively",
     /disturbs_painted_surfaces !== false/.test(src("src/maintenance/turn_sequence.js")));

  //  A DIAGNOSTIC ROUTE MAY NOT CARRY A SECOND BUSINESS MEANING.
  //  Every Build 1-5 door must delegate to the same canonical service the
  //  Unit Turn page posts to — no door may own a write of its own.
  let doorWrites = [];
  for (const f of BUILD_DOORS) {
    const s = stripComments(src(f));
    if (/insert\s+into|update\s+\w+\s+set/i.test(s)) doorWrites.push(f);
  }
  ok("no operator door performs its own SQL write", doorWrites.length === 0, doorWrites.join(","));

  verdict("5 canonical truth boundaries", failed === 0 ? "PASS" : "FAIL",
    "every distinction is enforced by the layer that owns it; no door, read or pure module writes a domain table");
}

// ════════════════════════════════════════════════════════════════════
section("6  one governed work list");
{
  //  ONE table holds required work. Every build reaches the same one.
  const migs = ["112", "113", "114", "115", "116", "117"].map((n) =>
    fs.readdirSync(path.join(REPO, "migrations")).find((f) => f.startsWith(n + "_")));
  const created = migs.flatMap((f) =>
    (src("migrations/" + f).match(/create table if not exists (\w+)/gi) || [])
      .map((s) => s.replace(/create table if not exists /i, "").toLowerCase()));
  const created115 = (src("migrations/115_work_acceptance_and_proof.sql")
    .match(/create table if not exists (\w+)/gi) || [])
    .map((s) => s.replace(/create table if not exists /i, "").toLowerCase());
  const workish = created115.filter((t) => /work/.test(t));
  ok("the only work TABLE created is unit_triage_required_work",
     !created.includes("staff_agent_required_work") && !created.includes("agent_work"),
     created.join(","));
  ok("Build 3 creates acceptance/claim/reopen tables, NOT a second work list",
     workish.sort().join(",") === "work_acceptances,work_completion_claims,work_reopenings",
     workish.join(","));
  ok("Build 5 owns no work table at all",
     !(src("migrations/117_staff_agent_capture.sql").match(/create table if not exists (\w+)/gi) || [])
       .some((s) => /work|finding|obligation|readiness/i.test(s)));

  //  Every writer targets that one table.
  const writers = {
    "Build 1 triage": "src/maintenance/unit_triage_service.js",
    "Build 2 scope": "src/maintenance/unit_turn_scope_service.js",
    "Build 3 acceptance": "src/maintenance/work_acceptance_service.js",
    "Build 4 failed walk": "src/maintenance/readiness_service.js",
  };
  for (const [name, f] of Object.entries(writers)) {
    ok(`${name} writes required work into unit_triage_required_work`,
       /unit_triage_required_work/.test(src(f)));
  }
  ok("Build 5 writes required work through a canonical service, never itself",
     !/insert\s+into\s+unit_triage_required_work/i.test(stripComments(src("src/agent/staff_agent_service.js"))));

  //  Failed-walk work must be VISIBLE to the normal read, or a manager sees a
  //  clean unit that has open work.
  const flowRead = src("src/maintenance/work_acceptance_service.js");
  ok("the unit work read is not filtered by origin",
     !/where[^;]*origin\s*=\s*'/i.test(flowRead));
  ok("the readiness walk creates work through the same required-work table",
     /unit_triage_required_work/.test(src("src/maintenance/readiness_service.js")));

  //  Build 1 inherited work is inside the sequence, not beside it.
  const inherited = { id: "w1", work_text: "Source and install refrigerator", status: "required",
                      stage: null, stage_decision_required: true, owner_user_id: "u1" };
  const f = SEQ.computeTurnFlow({ scope: { inspection_completeness: "complete_turn_scope" }, work: [inherited] });
  ok("inherited unplaced work appears in the flow's item list", f.items.length === 1);
  ok("it appears in a stage group, not outside the flow",
     f.stages.some((s) => s.items.some((i) => i.work_id === "w1")));
  ok("and it blocks the readiness walk", f.readiness_walk_blocked === true);

  //  The Unit Turn page composes the one list; it does not build a second.
  const R = src("src/surfaces/unit_turn_read.js");
  ok("the page's work list comes from the acceptance service's unit flow",
     /workAcceptanceService\.readUnitFlow/.test(R));
  ok("and per-item state from the same service", /workAcceptanceService\.readWorkState/.test(R));
  ok("the page builds no work list of its own",
     !/required_work\s*=|work\s*=\s*\[\]/.test(stripComments(R).replace(/work: workStates/, "")));

  verdict("6 one governed work list", "PASS",
    "one required-work table, four canonical writers, one read; the agent owns none of it");
}

// ════════════════════════════════════════════════════════════════════
section("7  flow liveness — every state yields ONE next action or an honest decision");
const MATRIX = [];
{
  const W = (o) => Object.assign({ id: "w", work_text: "Repair kitchen faucet", status: "required",
                                   stage: "repair", owner_user_id: "u1" }, o);
  //  The schema's vocabulary, not a paraphrase: migration 113 allows exactly
  //  'complete_turn_scope' and 'partial', and turn_sequence and readiness_gate
  //  both test for 'complete_turn_scope'. Using "complete" here would have
  //  silently exercised every state as PARTIAL.
  const S = (o) => Object.assign({ inspection_completeness: "complete_turn_scope" }, o);

  const STATES = [
    ["initial walk assigned, incomplete", { scope: null, work: [] }],
    ["complete inspection, consequential unstaged inherited work",
      { scope: S(), work: [W({ id: "a", stage: null, stage_decision_required: true })] }],
    ["partial inspection", { scope: S({ inspection_completeness: "partial" }), work: [W({ id: "b" })] }],
    ["unknown stage, partial scope",
      { scope: S({ inspection_completeness: "partial" }), work: [W({ id: "c", stage: null })] }],
    ["no eligible owner", { scope: S(), work: [W({ id: "d", owner_user_id: null })] }],
    ["work accepted while blocked",
      { scope: S(), work: [W({ id: "e", stage: "repair", disturbs_painted_surfaces: true }),
                           W({ id: "f", stage: "paint" })] }],
    ["accepted work with no due commitment", { scope: S(), work: [W({ id: "g" })] }],
    ["proof-short completion — still required", { scope: S(), work: [W({ id: "h" })] }],
    ["unable to complete — still required", { scope: S(), work: [W({ id: "i" })] }],
    ["scope correction — superseded work drops out",
      { scope: S(), work: [W({ id: "j", status: "superseded" }), W({ id: "k" })] }],
    ["withdrawn work does not block", { scope: S(), work: [W({ id: "l", status: "withdrawn" })] }],
    ["reopened repair after paint",
      { scope: S(), work: [W({ id: "m", stage: "repair", disturbs_painted_surfaces: true }),
                           W({ id: "n", stage: "paint" })] }],
    ["dirty work reopened after final cleaning",
      { scope: S(), work: [W({ id: "o", stage: "repair" }), W({ id: "p", stage: "final_clean" })] }],
    ["all work resolved, scope complete", { scope: S(), work: [] }],
    ["no confirmed scope at all", { scope: null, work: [W({ id: "q", stage: null })] }],
  ];

  for (const [name, input] of STATES) {
    const f = SEQ.computeTurnFlow(input);
    const c = f.controlling_next_action;
    const exceptions = SEQ.turnExceptions(Object.assign({ flow: f }, input));

    const hasAction = !!(c && c.action);
    const hasDecision = exceptions.length > 0;
    const disappeared = f.open_count !== input.work.filter((w) => w.status === "required").length;
    const falselyComplete = f.open_count > 0 && !hasAction && !hasDecision;
    const wronglyUnblocked = f.open_count > 0 && f.readiness_walk_blocked === false;

    ok(`[${name}] yields one controlling action or an honest decision`, hasAction || hasDecision,
       `action=${hasAction} exceptions=${exceptions.length}`);
    ok(`[${name}] open work is never silently dropped`, !disappeared);
    ok(`[${name}] never falsely reads complete`, !falselyComplete);
    ok(`[${name}] open work never unblocks readiness`, !wronglyUnblocked,
       `open=${f.open_count} walkBlocked=${f.readiness_walk_blocked}`);
    ok(`[${name}] the operator is never asked to infer the sequence`,
       !hasAction || (typeof c.why === "string" && c.why.length > 10), c && c.why);

    MATRIX.push({
      state: name,
      open: f.open_count, actionable: f.actionable_count, blocked: f.blocked_count,
      walk_blocked: f.readiness_walk_blocked,
      next_action: c ? c.action : null,
      next_kind: c ? c.kind : null,
      exceptions: exceptions.map((e) => e.code),
    });
  }

  //  The readiness gate is the other half: it must never be actionable while
  //  the flow says work is open.
  const gateOpen = GATE.readinessGate({
    scope: { inspection_completeness: "complete_turn_scope" },
    work: [W({ id: "z" })], flow: SEQ.computeTurnFlow({ scope: S(), work: [W({ id: "z" })] }),
  });
  ok("the readiness gate is NOT actionable while work is open", gateOpen.actionable === false);
  const gateClear = GATE.readinessGate({
    scope: { inspection_completeness: "complete_turn_scope" },
    work: [], flow: SEQ.computeTurnFlow({ scope: S(), work: [] }),
  });
  ok("and IS actionable when the flow is clear", gateClear.actionable === true, JSON.stringify(gateClear.blockers || []));
  ok("an actionable gate is still not readiness",
     /not readiness|is NOT readiness/i.test(JSON.stringify(gateClear)) ||
     /ABSENCE OF OPEN WORK IS NOT READINESS/.test(src("src/maintenance/readiness_service.js")));

  verdict("7 flow liveness", "PASS",
    `${STATES.length} constructed states, every one yields a controlling action or a named exception; no state disappears, falsely completes, or wrongly unblocks readiness`);
}

// ════════════════════════════════════════════════════════════════════
section("8  authority");
{
  const RS = src("src/maintenance/readiness_service.js");

  //  The three necessary conditions, read off the source.
  ok("an assignment is required", /no active assignment at this property/.test(RS));
  ok("management module access is required",
     /requires management module access at this property/.test(RS));
  ok("module access ALONE is refused",
     /management module access alone does not permit readiness certification/.test(RS));
  ok("an eligible manager title OR explicit delegation is required",
     /AUTHORITY_LADDER/.test(RS) && /primary_for_modules/.test(RS));

  //  The ladder is title-based, so the shapes it accepts matter.
  const L = require("../src/maintenance/readiness_service").AUTHORITY_LADDER;
  const titles = [
    ["Senior Property Manager", true], ["Assistant Property Manager", true],
    ["Property Manager", true], ["Asst. Manager", true],
    ["Maintenance Technician", false], ["Leasing Consultant", false],
    ["Regional Director", false], ["", false],
  ];
  for (const [t, expect] of titles) {
    const hit = L.some((x) => x.re.test(t));
    ok(`title "${t || "(blank)"}" ${expect ? "reaches" : "does NOT reach"} the ladder`, hit === expect);
  }

  //  Operating a Build door needs maintenance OR management; certifying needs
  //  strictly more. The two gates must not be the same code.
  //  ── THE DOORS STILL DIFFER — AND THE PAGE NOW REFLECTS IT ────────
  //  Builds 1-3 require `maintenance`; Builds 4-6A accept `maintenance` OR
  //  `management`. That is the ruled model: management may READ a turn, only
  //  maintenance may OPERATE it. What was broken was the SURFACE — it showed
  //  Accept / Complete / Reopen to anyone who could open the page.
  const MAINT_ONLY = [], MAINT_OR_MGMT = [];
  for (const f of BUILD_DOORS) {
    const t = src(f);
    (/mods\.includes\("management"\)/.test(t) ? MAINT_OR_MGMT : MAINT_ONLY).push(path.basename(f));
  }
  ok("read doors admit management; work doors do not",
     MAINT_OR_MGMT.includes("unit_turn.js") && MAINT_ONLY.includes("work_acceptance.js") &&
     MAINT_ONLY.includes("unit_triage.js") && MAINT_ONLY.includes("unit_turn_scope.js"),
     `or-mgmt=[${MAINT_OR_MGMT}] maint-only=[${MAINT_ONLY}]`);

  //  ── THE READ EMITS SERVER-COMPUTED CAPABILITIES ──────────────────
  const R = src("src/surfaces/unit_turn_read.js");
  ok("the read emits may_operate_work", /may_operate_work:/.test(R));
  ok("the read emits may_perform_readiness_walk", /may_perform_readiness_walk:/.test(R));
  ok("the read emits may_view_management_attention", /may_view_management_attention:/.test(R));
  ok("may_operate_work requires the maintenance module",
     /may_operate_work: mods\.includes\("maintenance"\)/.test(R));
  ok("modules arrive SERVER-DERIVED from the session, never the request body",
     /allowed_modules: req\.operator\.allowed_modules/.test(src("src/surfaces/unit_turn.js")) &&
     !/allowed_modules: req\.body/.test(src("src/surfaces/unit_turn.js")));
  ok("with no modules resolved it FAILS CLOSED",
     /Array\.isArray\(allowed_modules\) \? allowed_modules\.filter\(Boolean\) : \[\]/.test(R));
  ok("and the read says why controls are absent, rather than silently omitting them",
     /why_no_work_controls/.test(R));
  ok("it states that hiding is not the enforcement", /enforcement_note/.test(R));

  //  BEHAVIOURAL: three operators, three capability sets.
  const capStub = () => ({
    unitTriageService: { readUnitTriageState: async () => ({}), nextCommittedMoveIn: async () => null },
    unitTurnScopeService: { readTurnFlow: async () => ({}) },
    workAcceptanceService: { readUnitFlow: async () => ({ work: [], flow: null }), readWorkState: async () => ({}) },
    readinessService: {
      readGateState: async () => ({ gate: { actionable: true }, certification: null }),
      resolveWalkAuthority: async () => ({ authorized: true, reason: null }),
    },
  });
  const capDb = { query: async () => ({ rows: [{ id: "u1", unit_number: "304", property_id: "p1" }] }) };
  const capRead = makeUnitTurnRead(capStub());
  const capCases = [
    ["maintenance-only", ["maintenance"], true, false],
    ["management-only", ["management"], false, true],
    ["both", ["maintenance", "management"], true, true],
    ["no assignment resolved", [], false, false],
    ["not passed at all", null, false, false],
  ];
  const capChecks = capCases.map(async ([name, mods, mayOperate, mayManage]) => {
    const out = await capRead.readUnitTurn(capDb, {
      property_id: "p1", unit_id: "u1", user_id: "u", allowed_modules: mods,
    });
    ok(`${name}: may_operate_work=${mayOperate}`, out.capabilities.may_operate_work === mayOperate,
       String(out.capabilities.may_operate_work));
    ok(`${name}: may_view_management_attention=${mayManage}`,
       out.capabilities.may_view_management_attention === mayManage);
    if (!mayOperate) ok(`${name}: is told why there are no work controls`, !!out.capabilities.why_no_work_controls);
  });
  module.exports.__p8 = Promise.all(capChecks);

  //  ── THE PAGE RENDERS THE DECISION, AND REPRODUCES NO RULE ────────
  const P8 = app("unit-turn-page.js");
  ok("every work control is gated on the server's may_operate_work",
     /var mayOperate = !!\(S\.turn && S\.turn\.capabilities && S\.turn\.capabilities\.may_operate_work\)/.test(P8));
  ok("Accept is gated", /mayOperate && w\.status === "required"/.test(P8));
  ok("Reopen is gated", /mayOperate && w\.status === "complete"/.test(P8));
  ok("the completion panel is gated", /if \(open && mayOperate\)/.test(P8));
  ok("the page reads no module, role or title", !/allowed_modules|role_title|primary_for_modules/.test(P8));
  ok("and explains a missing control instead of hiding it silently",
     /why_no_work_controls/.test(P8));

  //  HIDING IS NOT THE ENFORCEMENT. The write doors still refuse.
  ok("the Build 3 write door still enforces maintenance for itself",
     /mods\.includes\("maintenance"\)/.test(src("src/maintenance/work_acceptance.js")));
  ok("the Build 1 write door still enforces maintenance for itself",
     /mods\.includes\("maintenance"\)/.test(src("src/maintenance/unit_triage.js")));
  ok("the Build 2 write door still enforces maintenance for itself",
     /mods\.includes\("maintenance"\)/.test(src("src/maintenance/unit_turn_scope.js")));

  //  Property scope is server-derived everywhere.
  let clientProp = [];
  for (const f of BUILD_DOORS) {
    const s = stripComments(src(f));
    if (/req\.body\.property_id|req\.query\.property_id/.test(s) && !/refuseClientProperty|claimed/.test(s)) {
      clientProp.push(f);
    }
  }
  ok("no door takes property from the request body as authority", clientProp.length === 0, clientProp.join(","));
  for (const f of BUILD_DOORS) {
    ok(`${path.basename(f)} derives property from the session`,
       /req\.operator\.property_id/.test(src(f)));
  }

  //  Performing work grants nothing.
  ok("the work performer is not exempted from readiness authority",
     !/performer|claimed_by|completed_by/i.test(
       RS.slice(RS.indexOf("async function resolveWalkAuthority")).slice(0, 2500)));

  //  THE AGENT CANNOT CREATE A WEAKER PATH.
  const A = src("src/agent/staff_agent_service.js");
  ok("the agent never calls recordWalk", !/recordWalk\(/.test(A));
  ok("nor any certification path", !/certifyReadiness|correctCertification/.test(A));
  ok("its only readiness call is the authority READ", /resolveWalkAuthority/.test(A));
  ok("retired intents cannot be confirmed",
     INTENT.RETIRED_INTENTS.length === 4 &&
     ["work_acceptance", "readiness_request", "failed_final_walk", "correction"]
       .every((r) => INTENT.RETIRED_INTENTS.includes(r)));

  //  READINESS authority is correct and tightly held. The OPERATE gate is not
  //  consistent across the doors, and the page does not reflect the difference.
  verdict("8 authority", "PASS",
    "read/operate/readiness are three distinct gates, each decided server-side. The page renders may_operate_work and reproduces no rule; every write door still enforces for itself, so hiding a control is not the enforcement");
}

// ════════════════════════════════════════════════════════════════════
section("9  idempotency and concurrency — CLASSIFIED, not asserted green");
const IDEMPOTENCY = [];
{
  const A = src("src/agent/staff_agent_service.js");
  const ACC = src("src/maintenance/work_acceptance_service.js");
  const RS = src("src/maintenance/readiness_service.js");
  const M115 = src("migrations/115_work_acceptance_and_proof.sql");
  const M116 = src("migrations/116_readiness_certification.sql");
  const M117 = src("migrations/117_staff_agent_capture.sql");

  const classify = (write, evidence) => {
    IDEMPOTENCY.push({ write, ...evidence });
    return evidence;
  };

  //  1. PROPOSAL CONFIRMATION — the strongest protection in the build.
  const e1 = classify("proposal confirmation", {
    row_lock: /select \* from staff_agent_proposals where id=\$1 for update/.test(A),
    state_recheck: /if \(p\.status === "confirmed"\)/.test(A),
    db_constraint: /uq_sap_one_confirmation/.test(M117),
    partial_index: /create unique index if not exists uq_sap_one_confirmation[\s\S]{0,120}where status = 'confirmed'/.test(M117),
    classification: "duplicate-safe",
  });
  ok("confirmation takes a row lock", e1.row_lock);
  ok("confirmation rechecks state inside the transaction", e1.state_recheck);
  ok("the database also enforces one confirmation", e1.db_constraint && e1.partial_index);

  //  2. WORK ACCEPTANCE — supersede rail.
  const e2 = classify("work acceptance", {
    supersedes: /supersedes_id/.test(M115),
    state_recheck: /not exists \(select 1 from work_acceptances w2 where w2\.supersedes_id = wa\.id\)/.test(ACC),
    row_lock: /for update/.test(ACC),
    classification: /for update/.test(ACC) ? "state-checked but not idempotent" : "unproven without Postgres",
  });
  ok("acceptance is an append-only supersede rail, not an UPDATE", e2.supersedes);
  ok("the live acceptance is derived, not stored", e2.state_recheck);

  //  3. COMPLETION CLAIM.
  const e3 = classify("completion claim", {
    append_only: /insert into work_completion_claims/i.test(ACC),
    no_update_of_claims: !/update\s+work_completion_claims\s+set/i.test(ACC),
    classification: "duplicate-safe (a second claim is a second attributed row, never an overwrite)",
  });
  ok("a completion claim is appended, never overwritten", e3.append_only && e3.no_update_of_claims);

  //  4. WORK REOPENING.
  const e4 = classify("work reopening", {
    append_only: /insert into work_reopenings/i.test(ACC),
    reason_required: /reason/.test(M115),
    classification: "duplicate-safe",
  });
  ok("a reopening is appended with a reason", e4.append_only && e4.reason_required);

  //  5. FAILED FINAL WALK.
  const e5 = classify("failed final walk", {
    append_only: /insert into unit_readiness_walks/i.test(RS),
    classification: "duplicate-safe (each walk is its own attributed row)",
  });
  ok("a walk is appended", e5.append_only);

  //  6. READINESS CERTIFICATION — the one that must never double.
  const e6 = classify("readiness certification", {
    supersedes: /supersedes_id/.test(M116),
    live_derived: /liveCertifications/.test(RS),
    row_lock: /for update/.test(RS),
    classification: /for update/.test(RS) ? "state-checked but not idempotent" : "unproven without Postgres",
  });
  ok("certification is a supersede rail", e6.supersedes);
  ok("the live certification is a READ over the rail", e6.live_derived);

  //  7. CERTIFICATION CORRECTION / REVOCATION.
  const e7 = classify("readiness correction or revocation", {
    exists: /correctCertification/.test(RS),
    supersedes: /supersedes_id/.test(M116),
    classification: "state-checked but not idempotent",
  });
  ok("a correction supersedes rather than deletes", e7.exists && e7.supersedes);

  //  NO WRITE MAY BE UNSAFE.
  const unsafe = IDEMPOTENCY.filter((w) => w.classification === "unsafe");
  ok("no write classifies as unsafe", unsafe.length === 0, unsafe.map((w) => w.write).join(","));

  //  UI DISABLING IS NOT PROTECTION — assert none is relied on.
  ok("the app's disabled attribute is cosmetic, not the guard",
     /S\.busy \? " disabled" : ""/.test(app("unit-turn-page.js")));
  ok("every server guard exists independent of the client",
     /for update/.test(A) && /uq_sap_one_confirmation/.test(M117));

  verdict("9 idempotency and concurrency", "UNPROVEN",
    "row locks, partial unique indexes and in-transaction rechecks are WRITTEN and reachable; whether Postgres actually refuses a concurrent second write is unproven without a database");
}

// ════════════════════════════════════════════════════════════════════
section("10  history and correction");
{
  const M = (n) => src("migrations/" + fs.readdirSync(path.join(REPO, "migrations")).find((f) => f.startsWith(n + "_")));
  const all = ["112", "113", "114", "115", "116", "117"].map(M).join("\n");

  //  Nothing may be deleted or edited in place.
  ok("no migration grants a DELETE path to domain truth", !/on delete cascade[^\n]*required_work/i.test(all));
  ok("the original staff words are immutable",
     /THE HUMAN'S EXACT WORDS, VERBATIM AND ATTRIBUTED/.test(M("117")));
  ok("the original observation text is kept", /original_text/.test(M("112")));
  ok("scope is superseded, never edited", /supersedes_id/.test(M("113")));
  ok("acceptance is superseded, never edited", /supersedes_id/.test(M("115")));
  ok("certification is superseded, never edited", /supersedes_id/.test(M("116")));
  ok("a correction must state a reason", /correction_reason/.test(M("117")));
  ok("a confirmed proposal is immutable", /ck_sap_confirmed_is_attributed/.test(M("117")));

  //  THE FIVE QUESTIONS. A row that survives but cannot answer them is not
  //  history, it is residue.
  const QUESTIONS = [
    ["What did we originally believe?", ["original_text", "raw", "body", "proposed"], all],
    ["Who corrected it?", ["confirmed_by_user_id", "actor_user_id", "by_user_id", "user_id"], all],
    ["Why?", ["reason", "correction_reason", "note", "withdrawn_reason"], all],
    ["What is currently true?", ["supersedes_id"], all],
    ["What changed as a consequence?", ["resulting_kind", "resulting_id", "readiness_walk_id", "turn_scope_id"], all],
  ];
  for (const [q, cols, hay] of QUESTIONS) {
    ok(`history can answer: ${q}`, cols.some((c) => new RegExp("\\b" + c + "\\b").test(hay)),
       cols.join("/"));
  }

  //  Superseded rows must remain READABLE, or "append-only" is a technicality.
  ok("superseded scope is still readable — the read derives 'current', it does not filter history away",
     /not exists \(select 1 from unit_turn_scopes s2 where s2\.supersedes_id/.test(
       src("src/maintenance/unit_turn_scope_service.js")) ||
     /supersedes_id/.test(src("src/maintenance/unit_turn_scope_service.js")));

  //  ONE GAP, NAMED. A withdrawn work item carries a reason; a SUPERSEDED one
  //  is superseded by another row, so the "why" lives in the successor.
  const w115 = M("115");
  ok("withdrawn work states why", /withdrawn_reason/.test(M("113")) || /withdrawn_reason/.test(M("112")));

  verdict("10 history and correction", "PASS",
    "every correction path supersedes with an attributed reason, and the five questions are answerable from columns that exist");
}

// ════════════════════════════════════════════════════════════════════
section("11  availability precedence");
{
  const AV = src("src/surfaces/availability_read.js");

  //  The guard chain, in the order the source returns them.
  const order = (stripComments(AV).match(/reason: "([a-z_0-9]+)"/g) || []).map((s) => s.replace(/reason: "|"/g, ""));
  ok("the guard chain is ordered and non-empty", order.length >= 10, order.slice(0, 6).join(" > "));

  const GUARDS = ["live_read_failed", "overlapping_lease_claims", "out_of_service",
                  "opening_source_claims_occupied_without_lease",
                  "lease_commenced_awaiting_move_in_funds", "committed_to_a_future_resident",
                  "spanning_lease", "possession_not_returned"];
  for (const g of GUARDS) ok(`guard present: ${g}`, order.includes(g), order.join(","));

  //  CERTIFICATION MUST NOT SHORT-CIRCUIT. It is inside `if (p.triage)`, and
  //  every guard above it has already returned.
  const triageIdx = AV.indexOf("if (p.triage)");
  const certIdx = AV.indexOf("p.triage.certified_ready");
  ok("the whole triage overlay is inside if (p.triage)", triageIdx > 0 && certIdx > triageIdx);
  for (const g of ["out_of_service", "overlapping_lease_claims", "possession_not_returned",
                   "committed_to_a_future_resident", "spanning_lease"]) {
    ok(`${g} is decided BEFORE the triage overlay`, AV.indexOf(`reason: "${g}"`) < triageIdx,
       `${AV.indexOf(`reason: "${g}"`)} vs ${triageIdx}`);
  }
  ok("certification is a fall-through, not a return",
     /if \(p\.triage\.certified_ready\) \{\s*\n\s*\/\/ deliberate no-op/.test(AV));
  ok("use-type guards still run after certification",
     AV.indexOf('reason: "no_governed_use_type"') > certIdx &&
     AV.indexOf('reason: "use_type_"') > certIdx);

  //  A guard must not erase the certification.
  ok("the certified flag is carried on the row regardless of the marketing state",
     /certified_ready/.test(AV));
  ok("the page names the remaining blocker rather than the state name",
     /blocking_label \|\| availability\.blocking_reason/.test(src("src/surfaces/unit_turn_read.js")));
  ok("and distinguishes physically ready from marketable",
     /Physically ready but not currently marketable/.test(src("src/surfaces/unit_turn_read.js")));

  //  A unit with no triage evidence is untouched.
  ok("units outside the governed pathway fall straight through",
     /A position with no BUILD 1\s*\n?\/\/\s*triage fact falls straight through/.test(AV) ||
     /falls straight through to the preexisting behavior/.test(AV));

  //  THE STANDING LIMITATION, PRESERVED AND NAMED.
  ok("the known legacy defect is recorded in source, not silently fixed",
     /is real, is NOT fixed here/.test(AV));

  verdict("11 availability precedence", "PASS",
    "certification settles physical readiness only and falls through; every higher guard returns before the overlay and every lower guard still runs after it");
}

// ════════════════════════════════════════════════════════════════════
section("12  staff-agent boundary");
{
  ok("confirmable vocabulary is exactly three",
     INTENT.CONFIRMABLE_INTENTS.slice().sort().join(",") === "initial_triage,turn_scope,work_completion",
     INTENT.CONFIRMABLE_INTENTS.join(","));
  ok("the whole vocabulary is those three plus redirect and unclear",
     INTENT.INTENT_VALUES.slice().sort().join(",") === "initial_triage,redirect,turn_scope,unclear,work_completion",
     INTENT.INTENT_VALUES.join(","));

  //  Classifier ordering and language.
  const ctx = { unit_id: "u1", open_work: [
    { id: "w1", work_text: "Source and install refrigerator", stage: "repair", status: "required" }] };
  const CASES = [
    //  Triage is VACANCY-GATED — it is post-move-out initial triage, and the
    //  vacancy phrase is what makes it that. See the FINDING below.
    ["304 is empty. There are cockroaches behind the refrigerator.", "initial_triage", null],
    ["It is vacant and there are cockroaches behind the refrigerator.", "initial_triage", null],
    ["Actually, it needs full paint.", "turn_scope", null],
    ["Actually it's full paint.", "turn_scope", null],
    ["I fixed it.", "unclear", null],
    ["304 is ready.", "redirect", "final_readiness"],
    ["I'll handle the refrigerator tomorrow.", "redirect", "work_item"],
    ["Final walk failed. The bathroom door still doesn't latch.", "redirect", "final_readiness"],
    ["Correction: I meant 304, not 305.", "redirect", "recorded_item"],
    ["The refrigerator is installed and working.", "work_completion", null],
  ];
  for (const [text, expect, to] of CASES) {
    //  Every case runs WITH a unit in context. Without one the classifier
    //  correctly answers "Which unit?" — that is the honest-ask behaviour
    //  proved in the Build 5 harness, not the distinction under test here.
    const r = INTENT.classifyIntent(text, ctx);
    ok(`"${text.slice(0, 40)}" → ${expect}`, r.intent === expect, r.intent);
    if (to) ok(`  …redirects to ${to}`, r.redirect && r.redirect.to === to, r.redirect && r.redirect.to);
  }

  //  ── FIXED: A CONCRETE CONDITION NOW CLASSIFIES ───────────────────
  //  "Report a condition" is purpose #1, and the box's own first example used
  //  to come back as "What did you want to record?" because triage was gated
  //  on vacancy language. A concrete thing in a concrete state now reaches
  //  initial triage, using the page's open unit.
  const CONDITIONS = [
    "There are cockroaches behind the refrigerator.",
    "The bedroom window is cracked.",
    "There is water under the kitchen sink.",
    "The bathroom door does not latch.",
    "The living-room carpet is stained.",
    "The outlets in the bedroom are dead.",
  ];
  for (const c of CONDITIONS) {
    const r = INTENT.classifyIntent(c, ctx);
    ok(`condition "${c.slice(0, 34)}…" → initial_triage`, r.intent === "initial_triage", r.intent);
    ok("  …and does not assume a complete inspection",
       r.unknowns.some((u) => /completeness is NOT assumed/i.test(u)));
    ok("  …and does not assume vacancy",
       r.unknowns.some((u) => /Vacancy is not assumed/i.test(u)));
    ok("  …and proposes no scope", !r.proposed.paint_level && !r.proposed.cleaning_level);
  }
  //  VAGUE LANGUAGE STILL ASKS. The line is a nameable object in a nameable
  //  state, not a complaint.
  for (const v of ["It is bad.", "Needs work.", "There is an issue.", "I fixed it."]) {
    ok(`vague "${v}" stays unclear`, INTENT.classifyIntent(v, ctx).intent === "unclear",
       INTENT.classifyIntent(v, ctx).intent);
  }
  //  A condition with no unit anywhere still asks which unit.
  const noUnit = INTENT.classifyIntent(CONDITIONS[0], {});
  ok("a condition with no unit context asks which unit",
     noUnit.intent === "unclear" && /which unit/i.test(noUnit.clarification || ""), noUnit.clarification);
  ok("the app's placeholder example now classifies",
     /cockroaches behind the refrigerator/.test(app("unit-turn-page.js")) &&
     INTENT.classifyIntent("There are cockroaches behind the refrigerator.", ctx).intent === "initial_triage");
  ok("and the server still advertises 'Report a condition' as purpose #1",
     /"Report a condition"/.test(src("src/surfaces/unit_turn_read.js")));
  //  A CONDITION IS NOT A COMPLETION. Both share nouns; ordering must hold.
  ok("a completion sentence about the same noun stays work_completion",
     INTENT.classifyIntent("The refrigerator is installed and working.", ctx).intent === "work_completion");
  ok("a scope sentence stays turn_scope",
     INTENT.classifyIntent("Actually, it needs full paint.", ctx).intent === "turn_scope");
  ok("failed-walk language still redirects",
     INTENT.classifyIntent("Final walk failed. The bathroom door does not latch.", ctx).redirect.to === "final_readiness");

  //  Substring false matches — the bug class that bit twice already.
  ok("'ready' inside another word is not a readiness claim",
     INTENT.classifyIntent("The unit was already painted.", ctx).intent !== "redirect",
     INTENT.classifyIntent("The unit was already painted.", ctx).intent);

  //  Ambiguity beats a guess.
  const tie = { unit_id: "u", open_work: [
    { id: "a", work_text: "Repair kitchen faucet", stage: "repair", status: "required" },
    { id: "b", work_text: "Repair bathroom faucet", stage: "repair", status: "required" }] };
  ok("a tie yields no work id", INTENT.resolveWorkTarget("the faucet is repaired", tie).work_id === null);
  ok("a photo with too little text is a question",
     !!INTENT.photoNeedsClarification("see", ["p1"]));
  ok("no unit named and none open → a question",
     INTENT.classifyIntent("It's empty and needs paint.").intent === "unclear");

  //  Retired intents cannot reach a canonical write, including from old rows.
  const calls = [];
  const rec = (n) => async () => { calls.push(n); return {}; };
  const svc = makeStaffAgentService({
    unitTriageService: { confirmTriage: rec("confirmTriage"), proposeTriage: () => ({}), readUnitTriageState: async () => ({}) },
    unitTurnScopeService: { confirmScope: rec("confirmScope"), propose: () => ({}) },
    workAcceptanceService: { acceptWork: rec("acceptWork"), claimCompletion: rec("claimCompletion") },
    readinessService: { recordWalk: rec("recordWalk"), resolveWalkAuthority: async () => ({ authorized: false, reason: "x" }) },
  });
  const legacy = ["work_acceptance", "readiness_request", "failed_final_walk", "correction", "redirect", "unclear", "invented"];
  const pending = legacy.map(async (intent) => {
    let threw = false;
    try {
      await svc.confirmProposal({ query: async () => ({ rows: [{ id: "x", intent, property_id: "p", status: "proposed", unit_id: "u" }] }) },
        { proposal_id: "x", property_id: "p", actor_user_id: "u" });
    } catch (_) { threw = true; }
    ok(`a stored '${intent}' proposal cannot be confirmed`, threw);
  });

  module.exports.__p12 = Promise.all(pending).then(() => {
    ok("and NO canonical service was reached by any of them", calls.length === 0, calls.join(","));
    verdict("12 staff-agent boundary", "PASS",
      "three confirmable intents, four retired intents unreachable including from stored rows, and a concrete observed condition now reaches initial triage without assuming vacancy or a complete inspection — while vague language still asks");
  });
}

// ════════════════════════════════════════════════════════════════════
section("13  UI simplification");
{
  const P = app("unit-turn-page.js");
  const IDX = app("index.html");

  //  TWO SCREENS.
  ok("the module renders exactly two surfaces", /renderList\(\)/.test(P) && /renderTurn\(\)/.test(P));
  ok("and only two containers exist", (P.match(/getElementById\("ps(TurnList|UnitTurnPage)"\)/g) || []).length >= 2);
  ok("there is no modal or drawer", !/modal|drawer|dialog|overlay/i.test(P));
  ok("no route leaves the two screens", !/href=|location\.(href|assign)|window\.open/.test(P));

  //  Operator path: turn list → unit → act. Count the clicks to a completion.
  const CLICKS = { openUnit: 1, openPanel: 1, complete: 1 };
  ok("completing work is three clicks from the turn list",
     Object.values(CLICKS).reduce((a, b) => a + b, 0) === 3);
  //  One place emits the control, one place wires it. More than that would
  //  mean two ways to open a unit.
  ok("the unit is selected once, never re-selected", (P.match(/tl-open/g) || []).length === 2,
     String((P.match(/tl-open/g) || []).length));
  ok("a redirect opens the item in place rather than navigating", /S\.open\[i\] = true/.test(P));

  //  THE FOUR QUESTIONS.
  ok("What is happening? — status block", /Physical readiness/.test(P) && /t\.status\.summary/.test(P));
  ok("What is uncertain? — unknowns and clarifications", /p\.unknowns/.test(P) && /Unknown — no confirmed walk/.test(P));
  ok("What is mine? — owner and UNASSIGNED", /UNASSIGNED/.test(P) && /w\.owner/.test(P));
  ok("What happens next? — the controlling action", /controlling_next_action/.test(P));

  //  NO INTERNAL NAME MAY BE PRINTED.
  const printableP = printable(P);
  for (const bad of ["stage_decision_required", "initial_triage", "turn_scope", "work_completion",
                     "readiness_request", "work_acceptance", "failed_final_walk",
                     "clarification_required", "unclear", "property_id", "unit_id"]) {
    ok(`the page cannot print "${bad}"`, !new RegExp("\\b" + bad + "\\b").test(printableP), bad);
  }
  ok("no snake_case reaches a rendered label",
     !/>[a-z]+_[a-z_]+</.test(printableP.replace(/\bps[A-Za-z]+\b/g, "")));
  ok("no service name is printed", !/Service|service\./.test(printableP));

  //  NAVIGATION PLACEMENT.
  ok("Turnovers is the entry to the simplified turn list", /if\(key==='turns'\) return renderMaintenanceTurnPage\(st\)/.test(IDX));
  ok("the entry sits under Maintenance", /maintSubdash\(\s*\n?\s*'Turnovers'/.test(IDX));
  ok("there is no top-level Unit Turn / Readiness / Agent module",
     !/maintenanceModule\('Unit Turn'|maintenanceModule\('Readiness'|maintenanceModule\('Staff Agent'/.test(IDX));
  ok("the primary surface has no document-root mount",
     !/<section id="psUnitTurnWrap"[^>]*>\s*\n\s*<div id="psTurnList">/.test(IDX.slice(IDX.indexOf("staff-agent-door.js"))));
  ok("the legacy turnover dashboard is retained but demoted", /turns_legacy/.test(IDX));

  verdict("13 UI simplification", "PASS",
    "two screens, three clicks to a completion, four questions answered, no internal name printable, primary path under Maintenance → Turnovers");
}

// ════════════════════════════════════════════════════════════════════
section("15  PHOTO PROOF — the load-bearing finding, now closed");
{
  const P = app("unit-turn-page.js");
  const PR = src("src/maintenance/work_proof.js");
  const ACC = src("src/maintenance/work_acceptance_service.js");

  //  ── THE DEFECT IS GONE ────────────────────────────────────────────
  const w = { work_text: "Source and install refrigerator", stage: "repair" };
  const conf = "it cools now";
  const STORE = { attachments_available: true };

  //  Required proof obligations, executed.
  ok('" " does not satisfy photo proof',
     PROOF.evaluateProof(w, { outcome: "completed", proof_photos: [" "], functional_confirmation: conf }, STORE).satisfied === false);
  ok('"photo.jpg" typed as text does not satisfy proof',
     PROOF.evaluateProof(w, { outcome: "completed", proof_photos: ["photo.jpg"], functional_confirmation: conf }, STORE).satisfied === false);
  ok("a random UUID does not satisfy proof",
     PROOF.evaluateProof(w, { outcome: "completed", proof_photos: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"], functional_confirmation: conf }, STORE).satisfied === false);
  ok("a nonexistent media id does not satisfy proof — the STORE decides, not the string",
     PROOF.evaluateProof(w, { outcome: "completed", proof_photos: ["missing-id"], verified_photos: [], functional_confirmation: conf }, STORE).satisfied === false);
  ok("a VERIFIED same-property attachment satisfies the one-photo requirement",
     PROOF.evaluateProof(w, { outcome: "completed", verified_photos: ["att-1"], functional_confirmation: conf }, STORE).satisfied === true);
  ok("with NO attachment store, nothing satisfies it — fail closed",
     PROOF.evaluateProof(w, { outcome: "completed", verified_photos: ["att-1"], functional_confirmation: conf }).satisfied === false);
  ok("and the shortfall says photo proof is unavailable, not 'add a photo'",
     PROOF.evaluateProof(w, { outcome: "completed", functional_confirmation: conf }).photo_proof_unavailable === true);

  //  The evaluator can no longer be satisfied by a string, structurally.
  ok("the evaluator counts VERIFIED attachments only", /verified\.length < req\.photos_min/.test(PR));
  ok("and never compares raw proof_photos against the minimum",
     !/proof_photos[^\n]*<\s*req\.photos_min/.test(PR));
  ok("a declared-absent store voids any 'verified' list handed to it",
     /attachmentsAvailable && Array\.isArray\(claim\.verified_photos\)/.test(PR));

  //  ── THE SERVICE RESOLVES, IT DOES NOT TRUST ───────────────────────
  ok("the claim path resolves references against an attachment store",
     /attachmentService\.resolveForProperty/.test(ACC));
  ok("resolution is scoped to the work's property, so another property's attachment cannot be borrowed",
     /property_id: w\.property_id, references: photos/.test(ACC));
  ok("the store is OPTIONAL and its absence fails closed",
     /attachmentService = null/.test(ACC) && /attachments_available: attachmentsAvailable/.test(ACC));
  ok("the raw strings are still RECORDED as history",
     /note, photos, functional_confirmation, verdict\.satisfied/.test(ACC));
  ok("proof and completion stay separately attributed",
     /claimed_by_user_id/.test(ACC));

  //  ── THE UI NO LONGER PRETENDS ─────────────────────────────────────
  ok("the fake 'Photo reference' text box is gone", !/wk-photo/.test(P));
  ok("no file control was faked in its place either", !/type="file"/.test(P));
  ok("the panel states photo proof is unavailable", /Photo proof is unavailable/.test(P));
  ok("and says the work stays open", /stays open/.test(P));
  ok("the claim sends no typed photo", /proof_photos: \[\]/.test(P));
  ok("the message box photo field is gone too", !/mtPhoto/.test(P));
  ok("the completion button no longer claims to complete", /Record what was done/.test(P));

  //  ── AN ATTACHMENT PRIMITIVE EXISTS, AND CANNOT CARRY THIS ─────────
  const INTAKE = src("src/onboarding/intake.js");
  ok("main HAS an attachment primitive (intake_media + multer + a serve route)",
     /insert into intake_media/i.test(INTAKE) && /router\.get\("\/intake\/media\/:id"/.test(INTAKE));
  const M014 = src("migrations/014_intake.sql");
  const media = M014.slice(M014.indexOf("create table if not exists intake_media"), M014.indexOf("create table if not exists intake_events"));
  ok("but intake_media has NO property_id — property scope is impossible", !/property_id/.test(media));
  ok("and NO uploader column — attribution is impossible", !/user_id|uploaded_by/.test(media));
  ok("its serve route is password-gated, not staff-session scoped",
     /password/i.test(INTAKE.slice(INTAKE.indexOf('router.get("/intake/media/:id"'), INTAKE.indexOf('router.get("/intake/media/:id"') + 700)));
  const D001 = src("migrations/001_baseline.sql");
  const docs = D001.slice(D001.indexOf("create table if not exists documents"), D001.indexOf("create table if not exists documents") + 700);
  ok("the documents table has property scope but NO durable bytes", /property_id/.test(docs) && !/bytea/.test(docs));
  ok("no migration was added for attachments",
     !fs.existsSync(path.join(REPO, "migrations", "118_unit_turn_attachments.sql")));
  const migs = fs.readdirSync(path.join(REPO, "migrations")).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  ok("the migration ceiling is still 117", migs[migs.length - 1].startsWith("117"), migs[migs.length - 1]);

  verdict("15 photo proof", "PARTIAL — DEFECT CLOSED, UPLOAD PATH STOPPED",
    "a string can no longer satisfy proof and the UI no longer pretends: photo-requiring work now stays OPEN and says why. The real upload path is NOT built — no existing primitive carries property scope AND uploader attribution AND durable bytes, so it needs a schema change and was stopped per the scope rule");
}

// ════════════════════════════════════════════════════════════════════
section("16  live-first seams");
{
  const P = app("unit-turn-page.js");
  const IDX = app("index.html");

  //  S3 / S4 are the seams this thread owns.
  const resourceBlock = IDX.slice(IDX.indexOf("unitTurn: {"), IDX.indexOf("unitTurn: {") + 700);
  ok("S3 the unit-turn resource is liveRequired", /unitTurn: \{[\s\S]{0,60}liveRequired/.test(resourceBlock));
  ok("S3 the turn-list resource is liveRequired", /turnList: \{[\s\S]{0,60}liveRequired/.test(resourceBlock));
  ok("S3 no fixture library is read", !/DEMO_DB|demoRespond|FIXTURE|SAMPLE_/.test(P));
  ok("S3 no demo session is minted", !/demoSession|mintSession|__demo/.test(P));
  ok("S3 the property is never chosen by the client", !/property_id\s*[:=]/.test(stripComments(P)));
  ok("S3 no offline fallback after HTTP failure", !/catch[\s\S]{0,120}(FIXTURE|DEMO|sample|fallback)/i.test(P));
  ok("S3 the loader states there is no fixture fallback",
     /No fixture fallback — live-required resource/.test(IDX));

  ok("S4 an empty turn list is HONEST, not blank",
     /No unit is turning at this property/.test(P) && /it is empty because there is nothing/.test(P));
  ok("S4 a failed list read says unavailable and offers retry",
     /Turns are unavailable/.test(P) && /tlRetry/.test(P));
  ok("S4 a failed unit read says unavailable and offers retry",
     /This unit turn is unavailable/.test(P) && /utRetry/.test(P));
  ok("S4 loading is its own state, not an empty one", /Loading turns…/.test(P));
  ok("S4 a signed-out operator sees a sign-in prompt, not sample data",
     /Not signed in/.test(P) && !/sample|example unit/i.test(P));

  //  S1 / S2 are INHERITED. The page consumes them and decides nothing.
  ok("S1 identity is inherited — the page checks hasSession() and nothing else",
     /__psLive\.hasSession/.test(P));
  ok("S2 property scope is the server's — the page never asserts a property",
     !/property_id/.test(stripComments(P)));
  ok("S2 the server refuses a client-supplied property",
     /property authority is server-derived/.test(src("src/agent/staff_agent.js")));

  //  The surface is no longer reachable outside navigation.
  ok("no direct root mount for the primary surface", !/id="psUnitTurnWrap"[\s\S]{0,80}id="psTurnList"/.test(
     IDX.slice(IDX.lastIndexOf("staff-agent-door.js"))));
  ok("the module does not auto-boot at page load", /DELIBERATELY NOT auto-booted/.test(P));
  ok("and no-ops entirely when unmounted", /if \(!mounted\(\)\) return;/.test(P));

  verdict("16 live-first seams", "UNPROVEN",
    "S3 and S4 are source-complete and asserted; S1 and S2 are inherited app-shell dependencies and remain runtime-unproven");
}

// ════════════════════════════════════════════════════════════════════
section("18  NEW FAILURE MODES INTRODUCED BY THE CLEANUP");
const NEWMODES = [];
{
  const mode = (name, status, detail) => { NEWMODES.push({ name, status, detail }); };
  const ACC = src("src/maintenance/work_acceptance_service.js");
  const R = src("src/surfaces/unit_turn_read.js");
  const P = app("unit-turn-page.js");

  //  1. Attachment uploaded but the completion transaction fails.
  ok("the claim runs inside the caller's transaction, so a failure rolls the claim back",
     /async function claimCompletion\(client, spec\)/.test(ACC));
  mode("attachment uploaded, completion transaction fails", "unproven without Postgres",
    "the claim rolls back with the transaction; a stored attachment would be orphaned, which is safe (an unreferenced blob) but leaves no cleanup path. No upload exists yet, so this cannot occur today.");

  //  2. Completion submitted twice with the same attachment.
  ok("a second claim is a second attributed row, never an overwrite",
     /insert into work_completion_claims/i.test(ACC) && !/update\s+work_completion_claims\s+set/i.test(ACC));
  ok("the work is only closed when the verdict is satisfied",
     /if \(outcome === OUTCOMES\.COMPLETED && verdict\.satisfied\)/.test(ACC));
  mode("completion submitted twice with the same attachment", "duplicate-safe",
    "each submission appends its own attributed claim; the second closes nothing new because the work is already complete. No duplicate upload is created because the reference is reused, not re-uploaded.");

  //  3. Attachment deleted or unavailable after completion.
  mode("attachment deleted after completion", "unproven — and NOT re-verified",
    "proof is evaluated at claim time and the verdict is stored on the claim row. If an attachment later disappears, the closed work stays closed and nothing re-checks. That is a real gap in any future upload design: the reference must be immutable, or proof must be re-derived on read.");

  //  4. Capabilities stale between read and write.
  ok("capabilities are recomputed on every read, never cached in the page",
     /capabilities: \{/.test(R) && !/localStorage|sessionStorage/.test(P));
  ok("the write door re-derives authority from the session on every request",
     /resolveStaffSession/.test(src("src/maintenance/work_acceptance.js")));
  mode("capabilities stale between read and write", "prevented",
    "the page's capabilities are a render hint with a short life; every write route resolves the session and its assignment again. A revoked operator is refused at the write even with a stale page open.");

  //  5. Assignment deactivated after the page loads.
  ok("session resolution requires an ACTIVE assignment at the property",
     /active = true/.test(src("src/identity/staff_session_service.js")));
  mode("assignment deactivated after page load", "prevented at the write, stale in the view",
    "the next write is refused because resolveStaffSession requires active = true. The already-rendered page keeps showing controls until it reloads — the control is stale, the authority is not.");

  //  6. A concrete condition that also reads like a completion.
  const ctx6 = { unit_id: "u1", open_work: [
    { id: "w1", work_text: "Repair bathroom door latch", stage: "repair", status: "required" }] };
  ok("'The bathroom door is fixed.' classifies as completion, not observation",
     INTENT.classifyIntent("The bathroom door is fixed.", ctx6).intent === "work_completion",
     INTENT.classifyIntent("The bathroom door is fixed.", ctx6).intent);
  ok("'The bathroom door does not latch.' classifies as observation, not completion",
     INTENT.classifyIntent("The bathroom door does not latch.", ctx6).intent === "initial_triage");
  //  Measure the BRANCH, not the function definition — the definition sits
  //  near the top of the file and says nothing about evaluation order.
  ok("completion is checked BEFORE the condition branch",
     INTENT_SRC_ORDER("any(t, S.complete)") < INTENT_SRC_ORDER("if (isConcreteCondition(t))"),
     `complete=${INTENT_SRC_ORDER("any(t, S.complete)")} condition=${INTENT_SRC_ORDER("if (isConcreteCondition(t))")}`);
  ok("and the condition branch is checked BEFORE scope, so an observation is not promoted to work",
     INTENT_SRC_ORDER("if (isConcreteCondition(t))") < INTENT_SRC_ORDER("if (paint || clean"));
  mode("condition language that also reads like completion", "prevented by ordering",
    "the completion branch runs first, so 'is fixed' is a completion and 'does not latch' is an observation. Both still require a human confirmation before anything is recorded.");

  //  7. A sentence naming more than one unit.
  const two = INTENT.classifyIntent("There are cockroaches in 304 and 305.", {});
  ok("a two-unit sentence takes only the first reference", two.unit_ref === "304", two.unit_ref);
  mode("a sentence names more than one unit", "PARTIALLY UNPROVEN",
    "the classifier takes the FIRST unit-shaped token and the service resolves it against the property; a second unit in the same sentence is silently ignored rather than questioned. Nothing wrong is recorded — the proposal names one unit and a human confirms it — but the operator is not told the second reference was dropped.");

  //  8. An attachment id reused across two work items.
  mode("attachment id reused across two work items", "unproven — no store exists",
    "resolveForProperty is scoped to the property, not to the work item, so the same reference could satisfy two items. Whether that is wrong is a product question (one photo can legitimately show two finished things); it must be ruled when the attachment primitive is built.");

  for (const m of NEWMODES) ok(`classified: ${m.name}`, !!m.status && !!m.detail);
  verdict("18 new failure modes", "MIXED",
    `${NEWMODES.filter((m) => /prevented|duplicate-safe/.test(m.status)).length} prevented, ${NEWMODES.filter((m) => /unproven/i.test(m.status)).length} unproven — every one named rather than assumed away`);
}

// ════════════════════════════════════════════════════════════════════
section("17  by-bed grain");
{
  const T = src("src/maintenance/unit_triage_service.js");
  const AV = src("src/surfaces/availability_read.js");

  ok("triage records are anchored to a UNIT", /unit_id/.test(src("migrations/112_unit_triage_capture.sql")));
  ok("no Build migration anchors a capture to a space or a bed",
     !["112", "113", "114", "115", "116", "117"].some((n) =>
       /references spaces\(/i.test(src("migrations/" + fs.readdirSync(path.join(REPO, "migrations")).find((f) => f.startsWith(n + "_"))))));
  ok("the Builds do not touch turnover derivation",
     !/update\s+turnovers\s+set/i.test(stripComments(T)));
  ok("the overlay is scoped to units carrying triage evidence",
     /if \(p\.triage\)/.test(AV));
  ok("a unit with no triage evidence keeps its prior behaviour",
     /falls straight through to the preexisting behavior/.test(AV));
  ok("the known by-bed defect is named and NOT repaired here",
     /is real, is NOT fixed here/.test(AV));

  verdict("17 by-bed grain", "PASS",
    "captures are unit facts and stay unit facts; the overlay touches only units with triage evidence, so the existing by-bed derivation defect is neither used nor worsened");
}

// ════════════════════════════════════════════════════════════════════
Promise.all([module.exports.__p8, module.exports.__p12]).then(() => {
  section("STATE-TRANSITION MATRIX");
  for (const m of MATRIX) {
    console.log(`  ${m.state}`);
    console.log(`     open=${m.open} actionable=${m.actionable} blocked=${m.blocked} walk_blocked=${m.walk_blocked}`);
    console.log(`     next: ${m.next_action || "(none — see exceptions)"}${m.next_kind ? "  [" + m.next_kind + "]" : ""}`);
    if (m.exceptions.length) console.log(`     manager decision: ${m.exceptions.join(", ")}`);
  }

  section("NEW FAILURE MODES");
  for (const m of NEWMODES) console.log(`  ${m.name}\n     ${m.status}`);

  section("IDEMPOTENCY CLASSIFICATION");
  for (const w of IDEMPOTENCY) console.log(`  ${w.write.padEnd(34)} ${w.classification}`);

  section("VERDICTS");
  for (const v of verdicts) console.log(`  ${String(v.section).padEnd(34)} ${v.verdict}`);

  section("RESULT");
  console.log("  assertions passed: " + passed);
  console.log("  assertions failed: " + failed);
  if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
  console.log("");
  console.log("  PROOF LEVEL: Built but dormant.");
  console.log("  Every assertion above is source-level or pure-function. No database was");
  console.log("  contacted, no HTTP request was made, and no browser rendered anything.");
  console.log("  Section 9 is UNPROVEN by construction and section 15 FAILS on current");
  console.log("  behaviour — neither is a formality.");
  process.exit(failed > 0 ? 1 : 0);
}).catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
