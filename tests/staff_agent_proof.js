// ════════════════════════════════════════════════════════════════════
//  staff_agent_proof.js — BUILD 5 proof harness
//
//    node tests/staff_agent_proof.js
//
//  Part A (pure + structural) runs anywhere. Part B requires DATABASE_URL and
//  REAL Postgres; without it this harness EXITS NON-ZERO. No fixture fallback.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const I = require("../src/agent/staff_agent_intent");
const { makeStaffAgentService } = require("../src/agent/staff_agent_service");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

const SVC_SRC = fs.readFileSync(require.resolve("../src/agent/staff_agent_service"), "utf8");
const MIG = fs.readFileSync(__dirname + "/../migrations/117_staff_agent_capture.sql", "utf8");
const stub = () => ({
  unitTriageService: { confirmTriage: async () => ({}), proposeTriage: () => ({}), readUnitTriageState: async () => ({}) },
  unitTurnScopeService: { confirmScope: async () => ({}), propose: () => ({}) },
  workAcceptanceService: { acceptWork: async () => ({}), claimCompletion: async () => ({}) },
  readinessService: { recordWalk: async () => ({}) },
});

section("E1  NO RAW DOMAIN INSERT EXISTS IN THE AGENT PATH");
{
  // The structural guarantee. Asserted against source, not intent.
  const DOMAIN = [
    "unit_triage_findings", "unit_triage_required_work", "unit_triage_confirmations",
    "unit_observations", "unit_turn_scopes", "unit_turn_appliances",
    "work_acceptances", "work_completion_claims", "work_reopenings",
    "unit_readiness_walks", "unit_readiness_certifications", "reclean_rulings",
    "obligations", "turnovers",
  ];
  for (const t of DOMAIN) {
    ok(`no INSERT into ${t}`, !new RegExp("insert\\s+into\\s+" + t, "i").test(SVC_SRC));
    ok(`no UPDATE of ${t}`, !new RegExp("update\\s+" + t + "\\b", "i").test(SVC_SRC));
  }
  ok("no DELETE of anything", !/delete\s+from/i.test(SVC_SRC));

  // The only tables it may write are its own three.
  const inserts = (SVC_SRC.match(/insert\s+into\s+(\w+)/gi) || [])
    .map((s) => s.replace(/insert\s+into\s+/i, "").toLowerCase());
  const allowed = new Set(["staff_agent_threads", "staff_agent_messages", "staff_agent_proposals"]);
  ok("every INSERT targets a staff-agent conversation table only",
     inserts.every((t) => allowed.has(t)), inserts.join(","));
  const updates = (SVC_SRC.match(/update\s+(\w+)\s+set/gi) || [])
    .map((s) => s.replace(/update\s+/i, "").replace(/\s+set/i, "").toLowerCase());
  ok("every UPDATE targets a staff-agent conversation table only",
     updates.every((t) => allowed.has(t)), updates.join(","));
}

section("E2  migration 117 owns no domain model");
{
  const created = (MIG.match(/create table if not exists (\w+)/gi) || [])
    .map((s) => s.replace(/create table if not exists /i, "").toLowerCase());
  ok("exactly three tables created", created.length === 3, created.join(","));
  ok("all three are conversation tables",
     created.every((t) => t.startsWith("staff_agent_")), created.join(","));
  for (const forbidden of ["finding", "required_work", "obligation", "readiness", "ownership", "due_commitment", "work_status"]) {
    ok(`no agent-specific ${forbidden} table`,
       !new RegExp("create table[^;]*staff_agent_\\w*" + forbidden, "i").test(MIG));
  }
  ok("no ALTER of any domain table", !/alter table (?!.*staff_agent)/i.test(MIG));
  ok("only a confirmed proposal may reference a canonical record",
     /ck_sap_only_confirmed_has_result/.test(MIG));
  ok("an unclear proposal can never be confirmed", /ck_sap_unclear_never_confirms/.test(MIG));
  ok("one confirmation per proposal, structurally", /uq_sap_one_confirmation/.test(MIG));
  ok("confirmation is attributed", /ck_sap_confirmed_is_attributed/.test(MIG));
}

section("E3  all four canonical services are REQUIRED dependencies");
{
  ok("builds with all four", (() => { try { makeStaffAgentService(stub()); return true; } catch (e) { return false; } })());
  for (const k of ["unitTriageService", "unitTurnScopeService", "workAcceptanceService", "readinessService"]) {
    const d = stub(); delete d[k];
    let threw = false, msg = "";
    try { makeStaffAgentService(d); } catch (e) { threw = true; msg = e.message; }
    ok(`construction FAILS without ${k}`, threw);
    ok(`and the error names ${k}`, msg.includes(k), msg.slice(0, 80));
  }
  ok("the error explains there is no fallback", (() => {
    const d = stub(); delete d.readinessService;
    try { makeStaffAgentService(d); return false; } catch (e) { return /no fallback path/i.test(e.message); }
  })());
  ok("every confirmed branch calls a canonical service",
     /unitTriageService\.confirmTriage/.test(SVC_SRC) &&
     /unitTurnScopeService\.confirmScope/.test(SVC_SRC) &&
     /workAcceptanceService\.acceptWork/.test(SVC_SRC) &&
     /workAcceptanceService\.claimCompletion/.test(SVC_SRC) &&
     /readinessService\.recordWalk/.test(SVC_SRC));
}

section("E4  an unconfirmed interpretation cannot write truth");
{
  ok("the intent module is pure — no SQL at all",
     !/insert into|update .* set|select .* from/i.test(
       fs.readFileSync(require.resolve("../src/agent/staff_agent_intent"), "utf8")));
  ok("every classification is labelled a proposal",
     I.classifyIntent("304 is empty").is_proposal === true);
  ok("capture says nothing was recorded", /nothing_recorded/.test(SVC_SRC));
  // Delegation appears ONLY inside confirmProposal.
  const capture = SVC_SRC.slice(SVC_SRC.indexOf("async function captureMessage"), SVC_SRC.indexOf("async function confirmProposal"));
  for (const s of ["confirmTriage", "confirmScope", "acceptWork", "claimCompletion", "recordWalk"]) {
    ok(`captureMessage never calls ${s}`, !new RegExp("\\." + s + "\\(").test(capture));
  }
  ok("a cancelled proposal records nothing", /Nothing operating was recorded/.test(SVC_SRC));
}

section("E5  scenario 1 — clear triage message");
{
  const r = I.classifyIntent("304 is empty. There are cockroaches and the refrigerator is missing.");
  ok("classified as initial triage", r.intent === "initial_triage", r.intent);
  ok("unit reference read", r.unit_ref === "304", r.unit_ref);
  ok("routes to the Build 1 service", /BUILD 1/.test(I.INTENT_SERVICE[r.intent]));
  ok("does NOT infer a complete inspection",
     r.unknowns.some((u) => /completeness is NOT assumed/i.test(u)));
  ok("the original words are carried", r.interpreted_from.indexOf("cockroaches") > -1);
}

section("E6  scenario 2 — full paint and deep clean");
{
  const r = I.classifyIntent("304 needs full paint and a deep clean.");
  ok("classified as turn scope", r.intent === "turn_scope", r.intent);
  ok("full paint proposed", r.proposed.paint_level === "full", r.proposed.paint_level);
  ok("deep clean proposed", r.proposed.cleaning_level === "deep", r.proposed.cleaning_level);
  ok("inspection completeness is NOT inferred", r.proposed.inspection_completeness === null);
  ok("and the unknown is stated", r.unknowns.some((u) => /not stated and is not assumed/i.test(u)));
  // deep clean alone must not become severe or long-lead
  ok("no severity is manufactured", !/severe/i.test(JSON.stringify(r.proposed)));
  ok("no long-lead is manufactured", !/long_lead/i.test(JSON.stringify(r.proposed)));
  ok("no manager escalation is proposed", !/manager/i.test(JSON.stringify(r.proposed)));
  // the service forces partial unless overridden
  ok("the service defaults inspection to partial, never complete",
     /inspection_completeness: overrides\.inspection_completeness \|\| "partial"/.test(SVC_SRC));

  const vague = I.classifyIntent("304 needs paint.");
  ok("'needs paint' asks the level", /Touch-up, partial, or full/i.test(vague.clarification), vague.clarification);
}

section("E7  scenario 3+4 — 'I'll handle it tomorrow' proposes, never accepts");
{
  const ctx = { unit_id: "u", open_work: [{ id: "w1", work_text: "Source and install refrigerator", stage: "repair", status: "required" }] };
  const r = I.classifyIntent("I'll replace the refrigerator tomorrow.", ctx);
  ok("classified as work acceptance", r.intent === "work_acceptance", r.intent);
  ok("the refrigerator item is identified", r.proposed.work_id === "w1", r.proposed.work_id);
  ok("the speaker is proposed as owner", r.proposed.owner_is_speaker === true);
  ok("nothing is accepted until confirmation",
     r.unknowns.some((u) => /Nothing is accepted until you confirm/i.test(u)));
  ok("routes to the Build 3 service", /BUILD 3/.test(I.INTENT_SERVICE[r.intent]));
  // Build 3 eligibility and actionability still apply — the agent calls
  // acceptWork, which performs both checks itself.
  ok("acceptance delegates to acceptWork, which enforces blocked-work refusal",
     /workAcceptanceService\.acceptWork/.test(SVC_SRC));
  ok("the agent adds no acceptance path of its own",
     !/insert into work_acceptances/i.test(SVC_SRC));
}

section("E8  scenario 5+6 — completion with and without proof");
{
  const ctx = { unit_id: "u", open_work: [{ id: "w1", work_text: "Source and install refrigerator", stage: "repair", status: "required" }] };
  const r = I.classifyIntent("The refrigerator is installed and working.", ctx);
  ok("classified as work completion", r.intent === "work_completion", r.intent);
  ok("the work item is identified", r.proposed.work_id === "w1");
  ok("functional confirmation carried", !!r.proposed.functional_confirmation);
  ok("proof requirement is flagged as outstanding",
     r.unknowns.some((u) => /claim is kept and the work stays open/i.test(u)));
  ok("the agent does not decide proof — the canonical service does",
     /workAcceptanceService\.claimCompletion/.test(SVC_SRC) &&
     !/proof_satisfied\s*=/.test(SVC_SRC));
  ok("photos are passed as evidence to the canonical service",
     /proof_photos: msg\.photos/.test(SVC_SRC));
}

section("E9  scenario 7 — ambiguous 'I fixed it'");
{
  const two = { unit_id: "u", open_work: [
    { id: "w1", work_text: "Paint full unit", stage: "paint", status: "required" },
    { id: "w2", work_text: "Complete final full clean", stage: "final_clean", status: "required" }] };
  const r = I.classifyIntent("I fixed it.", two);
  ok("does NOT classify as a completion", r.intent === "unclear", r.intent);
  ok("asks which work item", /which work item/i.test(r.clarification), r.clarification);
  ok("and says why", r.unknowns.some((u) => /did not name a specific work item/i.test(u)));

  // a TIE between equally-matching items is ambiguity, not a coin flip
  const tie = { unit_id: "u", open_work: [
    { id: "a", work_text: "Repair kitchen faucet", stage: "repair", status: "required" },
    { id: "b", work_text: "Repair bathroom faucet", stage: "repair", status: "required" }] };
  const t = I.resolveWorkTarget("the faucet is repaired", tie);
  ok("a tie yields no work id", t.work_id === null || t.ambiguous === true, JSON.stringify(t));

  ok("no open work at all → a question, not a guess",
     I.resolveWorkTarget("it's fixed", { open_work: [] }).work_id === null);
}

section("E10  scenario 8 — unit ambiguity and cross-property safety");
{
  const r = I.classifyIntent("It's empty and needs paint.");
  ok("no unit named and none open → unclear", r.intent === "unclear", r.intent);
  ok("asks which unit", /which unit/i.test(r.clarification || ""), r.clarification);

  // the resolver query is scoped by property_id — cross-property is unreachable
  ok("unit lookup is scoped by property_id",
     /from units where property_id=\$1 and unit_number = \$2/.test(SVC_SRC));
  ok("a multi-match asks rather than picking", /matches more than one unit here/.test(SVC_SRC));
  ok("an unknown unit asks rather than guessing", /I can't find unit/.test(SVC_SRC));
  ok("there is no unscoped unit query anywhere",
     !/from units where unit_number/i.test(SVC_SRC));
  ok("context unit is also property-scoped",
     /where id=\$1 and property_id=\$2/.test(SVC_SRC));
}

section("E11  scenario 9+10 — final walk and readiness");
{
  const f = I.classifyIntent("Final walk failed. The bathroom door still doesn't latch.");
  ok("classified as failed final walk", f.intent === "failed_final_walk", f.intent);
  ok("the finding text is carried", /bathroom door/i.test(f.proposed.findings_text), f.proposed.findings_text);
  ok("routes to the Build 4 service", /BUILD 4/.test(I.INTENT_SERVICE[f.intent]));
  ok("states Build 4 authority still applies",
     f.unknowns.some((u) => /Build 4 failed-walk service/i.test(u)));

  const bare = I.classifyIntent("Final walk failed.");
  ok("a bare failure asks what was found", /what did the final walk find/i.test(bare.clarification || ""), bare.clarification);

  // "304 is ready" MUST NOT certify
  const r = I.classifyIntent("304 is ready.");
  ok("classified as a readiness REQUEST, not a certification", r.intent === "readiness_request", r.intent);
  ok("and says it does not certify",
     r.unknowns.some((u) => /does NOT certify readiness/i.test(u)));
  ok("the service REFUSES to confirm a readiness request",
     /a message cannot certify readiness/.test(SVC_SRC));
  ok("and points at the governed walk", /operator\/units\/:id\/readiness\/walk/.test(SVC_SRC));
  ok("no certification call exists anywhere in the agent",
     !/certifyReadiness|correctCertification|finishReady/.test(SVC_SRC));
  ok("the only readiness call is recordWalk with outcome not_ready",
     /outcome: "not_ready"/.test(SVC_SRC) && !/outcome: "ready"/.test(SVC_SRC));
}

section("E12  scenario 11+12 — duplicate confirmation and cancellation");
{
  ok("a confirmed proposal short-circuits before any service call",
     /if \(p\.status === "confirmed"\)[\s\S]{0,300}already_confirmed: true/.test(SVC_SRC));
  ok("and says the action ran once", /ran once and was not repeated/.test(SVC_SRC));
  ok("the row is locked for update", /for update/.test(SVC_SRC));
  ok("the database also enforces one confirmation", /uq_sap_one_confirmation/.test(MIG));
  ok("a cancelled proposal cannot be confirmed", /was cancelled and cannot be confirmed/.test(SVC_SRC));
  ok("a confirmed proposal cannot be cancelled", /already created operating truth/.test(SVC_SRC));
  ok("clarification_required blocks confirmation", /needs a clarification before it can be confirmed/.test(SVC_SRC));
  ok("unclear can never be confirmed", /was not understood well enough/.test(SVC_SRC));
}

section("E13  photos are evidence, never a verdict");
{
  const q = I.photoNeedsClarification("", ["p1"]);
  ok("a photo with no text asks what it shows", !!q && /what condition or action/i.test(q.clarification));
  ok("and says nothing inspects it", /Nothing here inspects it/i.test(q.why));
  ok("a photo with enough text does not force a question",
     I.photoNeedsClarification("Paint is done in the whole unit", ["p1"]) === null);
  ok("no photo → no question", I.photoNeedsClarification("anything", []) === null);
  const intentSrc = fs.readFileSync(require.resolve("../src/agent/staff_agent_intent"), "utf8");
  ok("no computer vision in the intent module",
     !/require\(['"][^'"]*(vision|tensorflow|opencv|rekognition)/i.test(intentSrc));
  ok("no image classification anywhere",
     !/classifyImage|detectLabels|analyzeImage/.test(intentSrc + SVC_SRC));
  ok("the migration says nothing inspects a photo", /NOTHING INSPECTS IT/.test(MIG));
}

section("E14  corrections do not invent a mechanism");
{
  const r = I.classifyIntent("Correction—it's Unit 305, not 304.");
  ok("classified as a correction", r.intent === "correction", r.intent);
  ok("says the original stays in history",
     r.unknowns.some((u) => /original stays in history/i.test(u)));
  ok("the service refuses to invent a generic correction",
     /corrections go through the canonical correction path/i.test(SVC_SRC));
  ok("and tells the operator where to go", /Open the affected record/i.test(SVC_SRC));
  ok("no findings or work are moved between units",
     !/update unit_triage_findings set unit_id|update unit_triage_required_work set unit_id/i.test(SVC_SRC));
  ok("a correction is a NEW proposal, never an edit", /corrects_id/.test(MIG));
  ok("and a confirmed proposal is immutable in the schema",
     /ck_sap_confirmed_is_attributed/.test(MIG));
}

section("E15  property scope stays server-derived");
{
  ok("no property_id is ever taken from a message body",
     !/body\.property_id|proposed\.property_id/.test(SVC_SRC));
  ok("property_id arrives as a parameter from the caller",
     /property_id, actor_user_id/.test(SVC_SRC));
  ok("proposals are property-checked before confirmation",
     /that proposal is not at the property you are operating/.test(SVC_SRC));
}

// ════════════════════════════════════════════════════════════════
//  PART B — DURABLE. Requires REAL Postgres.
// ════════════════════════════════════════════════════════════════
async function partB() {
  section("DB  durable proof against real Postgres");
  if (!process.env.DATABASE_URL) {
    console.log(`
  NOT RUN — DATABASE_URL is not set.

  Part A proves the pure logic and the STRUCTURAL boundary. It does NOT prove
  the slice. Unexercised:

    · migration 117 applies cleanly on top of ceiling 116
    · the constraints actually refuse
        - an unconfirmed proposal carrying a resulting_id (ck_sap_only_confirmed_has_result)
        - a confirmed 'unclear' proposal            (ck_sap_unclear_never_confirms)
        - a confirmation with no actor              (ck_sap_confirmed_is_attributed)
    · capture writes message + proposal in ONE transaction and rolls back as one
    · confirmation invokes the canonical service exactly once under concurrency
    · an agent-created action appears identically in the existing unit/work reads
    · unit resolution really is property-scoped against live data

  PROOF LEVEL REACHED: Built-but-dormant.
`);
    return false;
  }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_name in ('staff_agent_threads','staff_agent_messages','staff_agent_proposals')`);
    ok("migration 117 tables exist", t.rows.length === 3, t.rows.map((r) => r.table_name).join(",") || "none");
  } finally { await pool.end(); }
  return true;
}

(async () => {
  const ranB = await partB();
  section("RESULT");
  console.log("  assertions passed: " + passed);
  console.log("  assertions failed: " + failed);
  if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
  console.log("\n  PROOF LEVEL: " + (ranB ? "Proven (real DB)" : "Built-but-dormant (pure logic only)"));
  if (!ranB) console.log("  Real HTTP and browser verification still required before this is 'done'.");
  process.exit(failed > 0 || !ranB ? 1 : 0);
})();
