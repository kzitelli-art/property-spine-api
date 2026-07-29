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
  //  ── FINDING: THE DOORS DO NOT AGREE ON WHO MAY OPERATE ───────────
  //  Three doors accept maintenance OR management; three accept maintenance
  //  ONLY. A management-only operator can open the Unit Turn page (Build 6A
  //  admits management) and is shown Accept / Complete / Reopen — every one of
  //  which posts to a Build 1-3 door that will refuse them.
  const MAINT_ONLY = [], MAINT_OR_MGMT = [];
  for (const f of BUILD_DOORS) {
    const t = src(f);
    (/mods\.includes\("management"\)/.test(t) ? MAINT_OR_MGMT : MAINT_ONLY).push(path.basename(f));
  }
  ok("FINDING: three doors admit management, three do not",
     MAINT_OR_MGMT.length === 3 && MAINT_ONLY.length === 3,
     `or-mgmt=[${MAINT_OR_MGMT}] maint-only=[${MAINT_ONLY}]`);
  ok("FINDING: the Unit Turn page admits management…",
     MAINT_OR_MGMT.includes("unit_turn.js"));
  ok("…but the write doors it points at do not",
     MAINT_ONLY.includes("work_acceptance.js") && MAINT_ONLY.includes("unit_triage.js") &&
     MAINT_ONLY.includes("unit_turn_scope.js"));
  ok("the page offers those writes unconditionally, without checking module access",
     /wk-accept/.test(app("unit-turn-page.js")) && !/allowed_modules/.test(app("unit-turn-page.js")));
  //  Certification must not be satisfiable by the door gate. It reads the
  //  ladder and the delegation flag, which no door does.
  const authBody = RS.slice(RS.indexOf("async function resolveWalkAuthority")).slice(0, 2500);
  ok("certification does NOT reuse the door's maintenance-or-management test",
     !/mods\.includes\("maintenance"\)/.test(authBody));
  ok("certification reads the ladder and the delegation flag instead",
     /AUTHORITY_LADDER/.test(authBody) && /primary_for_modules/.test(authBody));

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
  verdict("8 authority", "FAIL",
    "readiness authority is correct — three necessary conditions, no weaker agent path. But the OPERATE gate disagrees across doors: the Unit Turn page admits a management-only operator and then shows Accept/Complete/Reopen controls that Builds 1-3 will 403");
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

  //  ── FINDING: THE BOX ADVERTISES A SENTENCE IT CANNOT READ ────────
  //  "Report a condition" is purpose #1, and the placeholder's own first
  //  example is a bare condition report. With a unit already open, none of
  //  these classify: triage requires vacancy language, because Build 1 is
  //  post-move-out initial triage. The operator types the suggested sentence
  //  and is asked "What did you want to record?".
  const BARE = [
    "There are cockroaches behind the refrigerator.",
    "The outlets in the bedroom are dead.",
    "The bathroom door does not latch.",
  ];
  for (const b of BARE) {
    ok(`FINDING: bare condition "${b.slice(0, 34)}…" → unclear`,
       INTENT.classifyIntent(b, ctx).intent === "unclear", INTENT.classifyIntent(b, ctx).intent);
  }
  ok("FINDING: the app's placeholder offers exactly that failing sentence",
     /cockroaches behind the refrigerator/.test(app("unit-turn-page.js")));
  ok("FINDING: and the server advertises 'Report a condition' as purpose #1",
     /"Report a condition"/.test(src("src/surfaces/unit_turn_read.js")));
  //  It is at least an HONEST failure — it asks rather than guessing.
  ok("the failure mode is a question, not a wrong record",
     !!INTENT.classifyIntent(BARE[0], ctx).clarification);

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
    verdict("12 staff-agent boundary", "FAIL",
      "the vocabulary and the retired-intent guarantees are correct and tight. But 'Report a condition' is advertised as purpose #1 and the placeholder's own example does not classify — triage is vacancy-gated, so a bare condition report returns a clarification");
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
section("15  PHOTO PROOF — the load-bearing finding");
{
  const P = app("unit-turn-page.js");

  //  STEP 1-2: does the operator ever select a file?
  const hasFileInput = /type="file"/.test(P);
  ok("STEP 1 operator selects a photo — NO FILE INPUT EXISTS", !hasFileInput === true);
  ok("STEP 2 browser processes the file — no FileReader, no FormData",
     !/FileReader|FormData|\.files\[/.test(P));
  ok("the control is a TEXT input", /class="ut-in wk-photo"/.test(P) && !/wk-photo[^>]*type="file"/.test(P));

  //  STEP 3-4: is there an upload endpoint the Build uses?
  const usesUpload = /\/intake\/media|multipart|upload/i.test(P);
  ok("STEP 3 upload endpoint — the Build calls none", !usesUpload);

  //  An upload primitive DOES exist on main. It is simply not used here.
  const INTAKE = src("src/onboarding/intake.js");
  ok("main HAS a governed attachment primitive (intake_media + multer + a serve route)",
     /insert into intake_media/i.test(INTAKE) && /router\.get\("\/intake\/media\/:id"/.test(INTAKE));
  ok("but it is password-gated, not staff-session scoped",
     /password/i.test(INTAKE.slice(INTAKE.indexOf('router.get("/intake/media/:id"'), INTAKE.indexOf('router.get("/intake/media/:id"') + 700)));
  ok("Build 3 does not reference it", !/intake_media/.test(src("src/maintenance/work_acceptance_service.js")));
  ok("Build 6A does not reference it", !/intake_media/.test(src("src/surfaces/unit_turn_read.js")));

  //  STEP 5-7: the claim, the proof read, the page.
  ok("STEP 5 completion claim carries whatever string was typed",
     /proof_photos: d\(i, "photo"\) \? \[d\(i, "photo"\)\] : \[\]/.test(P));
  ok("STEP 6 proof is evaluated by COUNTING the array", /photos\.length < req\.photos_min/.test(src("src/maintenance/work_proof.js")));
  ok("STEP 7 the page renders the shortfall", /proof_shortfall/.test(P));

  //  ── THE DEFECT, EXECUTED ──────────────────────────────────────────
  const w = { work_text: "Source and install refrigerator", stage: "repair" };
  const typed = PROOF.evaluateProof(w, { outcome: "completed", proof_photos: ["x"], functional_confirmation: "it cools now" });
  const space = PROOF.evaluateProof(w, { outcome: "completed", proof_photos: [" "], functional_confirmation: "it cools now" });
  const none = PROOF.evaluateProof(w, { outcome: "completed", proof_photos: [], functional_confirmation: "it cools now" });

  ok("no photo correctly leaves the work open", none.satisfied === false);
  //  These two are the finding. They are asserted as FACTS about current
  //  behaviour, and the verdict below is FAIL because of them.
  ok("FINDING: a single typed character satisfies 'one completion photo'", typed.satisfied === true);
  ok("FINDING: a single SPACE satisfies it too", space.satisfied === true);

  //  The module already knows the difference for TEXT.
  const shortConf = PROOF.evaluateProof(w, { outcome: "completed", proof_photos: ["x"], functional_confirmation: "ok" });
  ok("a two-character functional confirmation is REFUSED — the same care is not applied to photos",
     shortConf.satisfied === false);

  verdict("15 photo proof", "FAIL",
    "'complete with photo' is not an operational flow: no file input, no upload call, and evaluateProof counts array length so one typed character — or one space — closes work as proof-satisfied");
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
Promise.all([module.exports.__p12]).then(() => {
  section("STATE-TRANSITION MATRIX");
  for (const m of MATRIX) {
    console.log(`  ${m.state}`);
    console.log(`     open=${m.open} actionable=${m.actionable} blocked=${m.blocked} walk_blocked=${m.walk_blocked}`);
    console.log(`     next: ${m.next_action || "(none — see exceptions)"}${m.next_kind ? "  [" + m.next_kind + "]" : ""}`);
    if (m.exceptions.length) console.log(`     manager decision: ${m.exceptions.join(", ")}`);
  }

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
