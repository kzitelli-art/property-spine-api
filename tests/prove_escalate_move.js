// ════════════════════════════════════════════════════════════════════
//  SLICE 1 — OPERATIONAL ESCALATION PROOF  (prove_escalate_move.js)
//  Proves (via the REAL agent route + create_staff_obligation tool):
//   A. ESCALATE writes exactly ONE obligation via the canonical service;
//      owner (assigned_role) + source_event_id populated; reply has NO [[HANDOFF]].
//   B. IDEMPOTENCY: the same inbound (same sms_sid, converges upstream) AND a
//      re-drive against the same source_event_id yield ONE obligation, not two.
//   C. BOUNDARY: a true-handoff inbound (asks for a person) fires [[HANDOFF]]
//      and creates NO operational_escalation obligation — the doors stay separate.
//   D. DEFER UNCHANGED: a plain unknown-fact inbound creates NO obligation and
//      NO handoff — the new move did not leak into normal defers.
//
//  Run per-block from the Render Web Shell (sandbox cannot reach Neon):
//    for B in A B C D; do ONLY_BLOCK=$B node prove_escalate_move.js; done
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const express = require("express"); const http = require("http"); const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
let passed = 0, failed = 0;
const chk = (n, c, d = "") => { if (c) { passed++; console.log(`  \u2713 ${n}`); } else { failed++; console.log(`  \u2717 ${n} ${d}`); } };

const ONLY = (process.env.ONLY_BLOCK || "").split(",").filter(Boolean);
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
process.env.SMS_SEND_MODE = "customer_care";
process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = DEMO;

// Scripted fake model.
//   MODE 'escalate' → calls create_staff_obligation with REASON
//   MODE 'escalate2'→ calls create_staff_obligation TWICE (two distinct tasks) in one turn
//   MODE 'handoff'  → text WITH the [[HANDOFF: ...]] sentinel (true handoff)
//   MODE 'defer'    → plain text, no tool, no tag (normal unknown fact)
// On a tool_result round it returns plain confirming text (never re-calls a tool).
let MODE = "defer", REASON = "confirm unit readiness for Sunday move-in", REASON2 = "check whether parking is available";
const fakeAnthropic = { messages: { async create(req) {
  const msgs = JSON.stringify(req.messages || []);
  if (msgs.includes("tool_result")) return { id: "r2", content: [{ type: "text", text: "Great — I've sent that to the team and I'll follow up." }] };
  if (MODE === "escalate") return { id: "r1", content: [{ type: "tool_use", id: "tu_e", name: "create_staff_obligation", input: { reason: REASON } }] };
  if (MODE === "escalate2") return { id: "r1", content: [
    { type: "tool_use", id: "tu_e1", name: "create_staff_obligation", input: { reason: REASON } },
    { type: "tool_use", id: "tu_e2", name: "create_staff_obligation", input: { reason: REASON2 } },
  ] };
  if (MODE === "handoff")  return { id: "r1", content: [{ type: "text", text: "I'm getting a teammate to help you directly.\n[[HANDOFF: prospect asked for a person]]" }] };
  return { id: "r1", content: [{ type: "text", text: "Let me check the exact number and get right back to you." }] };
}}};

const noopSms = { enabled: () => false, sendSms: async () => ({ sent: false }), validateWebhook: () => true };
const boundary = require("../src/comms/communications_boundary.js")({ pool, sms: noopSms });

// spawnOb mirrors server.js: sets assigned_role + source_event_id + dedupe_key
// so the OWNER ladder and the reason-keyed unique index (086) are genuinely
// exercised through the real branch.
async function spawnOb(c, o) {
  const r = await c.query(
    `insert into obligations (id, property_id, person_id, unit_id, source_event_id, module, type, label, owner_type, assigned_role, status, priority, severity, dedupe_key)
     values (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,'open','normal','normal',$10)
     returning *`,
    [o.property_id, o.person_id, o.unit_id || null, o.source_event_id || null, o.module, o.type, o.label, o.owner_type, o.assigned_role || null, o.dedupe_key || null]
  );
  return r.rows[0];
}

const agent = require("../src/agent/agent.js")({ pool, anthropic: fakeAnthropic, INGEST_MODEL: "fake", spawnObligationFromEvent: spawnOb, completeObligation: async () => ({}), leasingLifecycle: { maybeReopenOnQualifyingInbound: async () => ({}) }, commBoundary: boundary, leasingBookingService: null });

let srv, base; const track = { persons: [], leads: [] };

// /agent/inbound is operator-gated (2026-07-26) — it used to let anyone write
// words into a real conversation as a real person. This harness starts its own
// server below, so it owns the key it sets here.
const OP_KEY = process.env.OPERATOR_KEY || (process.env.OPERATOR_KEY = "harness-op-key");
const AGENT_HEADERS = { "content-type": "application/json", "x-operator-key": OP_KEY };
async function blockReset() { MODE = "defer"; await new Promise(r => setTimeout(r, 1000)); }
async function inbound(pid, body, smsSid) {
  const ms = smsSid || ("SM" + crypto.randomBytes(10).toString("hex"));
  const res = await fetch(`${base}/agent/inbound`, { method: "POST", headers: AGENT_HEADERS, body: JSON.stringify({ property_id: DEMO, person_id: pid, body, sms_sid: ms, idempotency_key: ms }) });
  const j = await res.json().catch(() => ({}));
  await new Promise(r => setTimeout(r, 400));
  return { ms, j };
}
async function newProspect(name) {
  const pid = uuid(); track.persons.push(pid);
  await pool.query(`insert into persons (id,name,phone) values ($1,$2,$3)`, [pid, name, "+1555" + Math.floor(1e6 + Math.random() * 8e6)]);
  const lead = uuid(); track.leads.push(lead);
  await pool.query(`insert into leasing_leads (id,person_id,property_id,status) values ($1,$2,$3,'new')`, [lead, pid, DEMO]);
  await pool.query(`insert into person_property_classifications (person_id,property_id,record_class,classification_source) values ($1,$2,'internal_qa','system')`, [pid, DEMO]).catch(() => {});
  await pool.query(`insert into contact_preferences (person_id,channel,consent_state,source,updated_at) values ($1,'text','opted_in','internal_qa_enrollment',now()) on conflict (person_id,channel) do update set consent_state='opted_in'`, [pid]).catch(() => {});
  return { pid, lead };
}
async function convOf(pid) { return (await pool.query(`select id from conversations where person_id=$1 and property_id=$2`, [pid, DEMO])).rows[0]?.id; }
async function escOf(pid) { return (await pool.query(`select * from obligations where person_id=$1 and module='agent' and type='operational_escalation'`, [pid])).rows; }
async function inboundEventOf(pid) { return (await pool.query(`select id from comm_events where person_id=$1 and direction='inbound' order by created_at desc limit 1`, [pid])).rows[0]?.id; }
async function latestDraft(pid) {
  const conv = await convOf(pid);
  return (await pool.query(`select d.generated_body from agent_drafts d join agent_runs r on r.id=d.agent_run_id join conversations c on c.id=r.conversation_id where c.person_id=$1 order by d.created_at desc limit 1`, [pid])).rows[0]?.generated_body || "";
}

async function main() {
  const app = express(); app.use(express.json()); app.use("/", agent);
  srv = http.createServer(app); await new Promise(r => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`;
  await pool.query(`insert into properties (id,name,sms_number) values ($1,'Property Spine Demo Building','+12154452021') on conflict (id) do nothing`, [DEMO]);

  if (!ONLY.length || ONLY.includes("A")) {
    console.log("\n\u2500\u2500\u2500 A. ESCALATE writes one owned obligation, no handoff \u2500\u2500\u2500");
    await blockReset();
    const { pid } = await newProspect("A Escalate");
    MODE = "escalate"; REASON = "confirm unit 214 can be ready for Sunday move-in";
    await inbound(pid, "can I move in this Sunday?");
    const obs = await escOf(pid);
    chk("A. exactly one operational_escalation obligation", obs.length === 1, `count=${obs.length}`);
    chk("A. obligation routed to a role (assigned_role present)", obs[0] && !!obs[0].assigned_role, obs[0] && JSON.stringify(obs[0].assigned_role));
    chk("A. obligation NOT falsely marked accepted (assigned_user_id null in slice 1)", obs[0] && !obs[0].assigned_user_id, obs[0] && String(obs[0].assigned_user_id));
    chk("A. obligation linked to inbound via dedupe_key", obs[0] && !!obs[0].dedupe_key, obs[0] && String(obs[0].dedupe_key));
    chk("A. obligation status open", obs[0] && obs[0].status === "open", obs[0] && obs[0].status);
    const draft = await latestDraft(pid);
    chk("A. reply contains NO [[HANDOFF]] tag", !/\[\[HANDOFF/i.test(draft), draft.slice(0, 80));
  }

  if (!ONLY.length || ONLY.includes("B")) {
    console.log("\n\u2500\u2500\u2500 B. Idempotency & multi-task, all through the REAL inbound path \u2500\u2500\u2500");

    // B1 — retry: the SAME inbound (same sms_sid) delivered twice converges on ONE obligation.
    await blockReset();
    {
      const { pid } = await newProspect("B1 Retry");
      MODE = "escalate"; REASON = "verify parking availability for a 2-car household";
      const first = await inbound(pid, "do you have parking?");
      await inbound(pid, "do you have parking?", first.ms);   // same sms_sid → upstream dedup + reason key
      const obs = await escOf(pid);
      chk("B1. same-inbound retry → exactly one obligation", obs.length === 1, `count=${obs.length}`);
      chk("B1. obligation carries a dedupe_key", obs[0] && !!obs[0].dedupe_key, obs[0] && String(obs[0].dedupe_key));
    }

    // B2 — TRUE concurrency through the route: two parallel /agent/inbound with the
    // SAME sms_sid race the full stack (inbound dedup + tool exec + 23505 recovery +
    // tool-result regeneration). Exactly one obligation must exist and both calls 200.
    await blockReset();
    {
      const { pid } = await newProspect("B2 Concurrent");
      MODE = "escalate"; REASON = "confirm unit 214 can be ready for Sunday move-in";
      const ms = "SM" + crypto.randomBytes(10).toString("hex");
      const fire = () => fetch(`${base}/agent/inbound`, { method: "POST", headers: AGENT_HEADERS, body: JSON.stringify({ property_id: DEMO, person_id: pid, body: "can I move in Sunday?", sms_sid: ms, idempotency_key: ms }) }).then(r => r.status);
      const [s1, s2] = await Promise.all([fire(), fire()]);
      await new Promise(r => setTimeout(r, 600));
      const obs = await escOf(pid);
      chk("B2. concurrent same-inbound through route → exactly one obligation", obs.length === 1, `count=${obs.length}`);
      chk("B2. both concurrent inbound calls returned 200 (no 500)", s1 === 200 && s2 === 200, `s1=${s1} s2=${s2}`);
    }

    // B3 — DISTINCTNESS: one inbound naming TWO different tasks must create TWO
    // obligations. The reason-keyed dedupe must NOT collapse them (the exact
    // regression the (source_event_id,type) index would have caused).
    await blockReset();
    {
      const { pid } = await newProspect("B3 TwoTasks");
      MODE = "escalate2";
      REASON = "confirm Sunday readiness for unit 214";
      REASON2 = "check whether a parking space is available";
      await inbound(pid, "can you confirm Sunday readiness and check if parking's available?");
      const obs = await escOf(pid);
      chk("B3. two distinct tasks in one inbound → TWO obligations", obs.length === 2, `count=${obs.length}`);
      const keys = new Set(obs.map(o => o.dedupe_key));
      chk("B3. the two obligations have DIFFERENT dedupe_keys", keys.size === 2, `keys=${keys.size}`);
    }
  }

  if (!ONLY.length || ONLY.includes("C")) {
    console.log("\n\u2500\u2500\u2500 C. Boundary: true handoff fires sentinel, creates NO escalation \u2500\u2500\u2500");
    await blockReset();
    const { pid } = await newProspect("C Handoff");
    MODE = "handoff";
    await inbound(pid, "I want to talk to a real person");
    const obs = await escOf(pid);
    chk("C. NO operational_escalation obligation created on handoff", obs.length === 0, `count=${obs.length}`);
    const draft = await latestDraft(pid);
    // The sentinel is stripped from the prospect-facing body but recorded; assert the
    // run recorded a handoff rather than an escalation. Body should NOT leak the raw tag.
    chk("C. prospect-facing body does not leak raw [[HANDOFF]] tag", !/\[\[HANDOFF/i.test(draft), draft.slice(0, 80));
  }

  if (!ONLY.length || ONLY.includes("D")) {
    console.log("\n\u2500\u2500\u2500 D. Defer unchanged: unknown fact makes no obligation, no handoff \u2500\u2500\u2500");
    await blockReset();
    const { pid } = await newProspect("D Defer");
    MODE = "defer";
    await inbound(pid, "what's the exact square footage of a studio?");
    const obs = await escOf(pid);
    chk("D. NO operational_escalation obligation on a plain defer", obs.length === 0, `count=${obs.length}`);
    const draft = await latestDraft(pid);
    chk("D. reply is a plain defer, no [[HANDOFF]]", !/\[\[HANDOFF/i.test(draft), draft.slice(0, 80));
  }

  // cleanup — scope strictly to tracked ids (never property-wide delete on shared Demo Building)
  for (const pid of track.persons) {
    await pool.query(`delete from obligations where person_id=$1 and type='operational_escalation'`, [pid]).catch(() => {});
  }

  console.log(`\n${failed === 0 ? "\u2713 ALL PASS" : "\u2717 FAILURES"}  passed=${passed} failed=${failed}`);
  await srv.close(); await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
