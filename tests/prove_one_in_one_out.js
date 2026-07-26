// ════════════════════════════════════════════════════════════════════
//  SLICE 2 — ONE INBOUND → AT MOST ONE OUTBOUND  (prove_one_in_one_out.js)
//  Proof-only (no source change). Every block asserts BOTH the durable record
//  (outbound comm_events) AND the wire attempts (mocked sendPropertySms calls),
//  so a "DB shows one, transport fired twice" defect cannot hide.
//   A. Normal inbound → exactly one outbound row AND one wire call.
//   B. Tool-chain run → one final text, one outbound row, one wire call
//      (tool steps do not each emit a prospect message).
//   C. CONCURRENT duplicate sms_sid (Promise.all) → one inbound/run/draft,
//      one outbound row, one wire call; both HTTP calls 200 (loser replayed).
//   D. CONCURRENT double dispatch of the SAME ready draft → exactly one
//      succeeds, the other refused; one outbound row, one wire call.
//   E. STALE draft: build a ready draft with auto-dispatch OFF, bump thread
//      version with a newer inbound, then attempt to send the OLD draft →
//      refused, producing NEITHER a new outbound row NOR a wire call.
//
//  Run per-block from the Render Web Shell:
//    for B in A B C D E; do ONLY_BLOCK=$B node prove_one_in_one_out.js; done
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const express = require("express"); const http = require("http"); const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
let passed = 0, failed = 0;
const chk = (n, c, d = "") => { if (c) { passed++; console.log(`  \u2713 ${n}`); } else { failed++; console.log(`  \u2717 ${n} ${d}`); } };
const ONLY = (process.env.ONLY_BLOCK || "").split(",").filter(Boolean);
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
process.env.SMS_SEND_MODE = "internal_qa_autonomous";
process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = DEMO;

let TOOLMODE = false;
const fakeAnthropic = { messages: { async create(req) {
  const msgs = JSON.stringify(req.messages || []);
  if (msgs.includes("tool_result")) return { id: "r2", content: [{ type: "text", text: "Here are a couple of open studios — want details?" }] };
  if (TOOLMODE) return { id: "r1", content: [{ type: "tool_use", id: "tu_inv", name: "find_available_units", input: { max_rent: 1800 } }] };
  return { id: "r1", content: [{ type: "text", text: "A studio runs in the mid-1600s. Want a couple that are open?" }] };
} } };

// ── WIRE COUNTER ───────────────────────────────────────────────────────
// Wrap the REAL boundary so we count actual sendPropertySms invocations (the
// wire attempt), independent of what the DB shows. Reset per block.
const realBoundary = require("../src/comms/communications_boundary.js")({ pool, sms: { enabled: () => false, sendSms: async () => ({ sent: true, sid: "SMwire" }), validateWebhook: () => true } });
let WIRE_CALLS = 0;
const boundary = new Proxy(realBoundary, {
  get(target, prop) {
    if (prop === "sendPropertySms") return async (...args) => { WIRE_CALLS++; return target.sendPropertySms(...args); };
    return target[prop];
  },
});
const resetWire = () => { WIRE_CALLS = 0; };

const inventoryStub = { search: async () => ([{ unit_number: "214", rent: 1675, sqft: 410 }]), matchConfirmationToOffer: () => null, attachSelectedUnit: async () => ({ attached: false }) };
async function spawnOb(c, o) {
  const r = await c.query(
    `insert into obligations (id, property_id, person_id, module, type, label, owner_type, assigned_role, status, priority, severity)
     values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'open','normal','normal') returning *`,
    [o.property_id, o.person_id, o.module, o.type, o.label, o.owner_type, o.assigned_role || null]);
  return r.rows[0];
}
const agent = require("../src/agent/agent.js")({ pool, anthropic: fakeAnthropic, INGEST_MODEL: "fake", spawnObligationFromEvent: spawnOb, completeObligation: async () => ({}), leasingLifecycle: { maybeReopenOnQualifyingInbound: async () => ({}) }, commBoundary: boundary, inventory: inventoryStub, leasingBookingService: null });

let srv, base; const track = [];

// /agent/inbound is operator-gated (2026-07-26) — it used to let anyone write
// words into a real conversation as a real person. This harness starts its own
// server below, so it owns the key it sets here.
const OP_KEY = process.env.OPERATOR_KEY || (process.env.OPERATOR_KEY = "harness-op-key");
const AGENT_HEADERS = { "content-type": "application/json", "x-operator-key": OP_KEY };
async function newProspect(name) {
  const pid = uuid(); track.push(pid);
  await pool.query(`insert into persons (id,name,phone) values ($1,$2,$3)`, [pid, name, "+1555" + Math.floor(1e6 + Math.random() * 8e6)]);
  await pool.query(`insert into leasing_leads (id,person_id,property_id,status) values ($1,$2,$3,'new')`, [uuid(), pid, DEMO]);
  await pool.query(`insert into person_property_classifications (person_id,property_id,record_class,classification_source) values ($1,$2,'internal_qa','system')`, [pid, DEMO]).catch(() => {});
  await pool.query(`insert into contact_preferences (person_id,channel,consent_state,source,updated_at) values ($1,'text','opted_in','internal_qa_enrollment',now()) on conflict (person_id,channel) do update set consent_state='opted_in'`, [pid]).catch(() => {});
  return pid;
}
function fireInbound(pid, body, sms) {
  const ms = sms || ("SM" + crypto.randomBytes(10).toString("hex"));
  return fetch(`${base}/agent/inbound`, { method: "POST", headers: AGENT_HEADERS, body: JSON.stringify({ property_id: DEMO, person_id: pid, body, sms_sid: ms, idempotency_key: ms }) }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
}
async function inbound(pid, body, sms) { const r = await fireInbound(pid, body, sms); await new Promise(z => setTimeout(z, 400)); return r; }
async function convOf(pid) { return (await pool.query(`select id from conversations where person_id=$1 and property_id=$2`, [pid, DEMO])).rows[0]?.id; }
async function counts(pid) {
  const conv = await convOf(pid);
  const q = async (dir) => (await pool.query(`select count(*)::int n from comm_events where conversation_id=$1 and direction=$2`, [conv, dir])).rows[0].n;
  const runs = (await pool.query(`select count(*)::int n from agent_runs where conversation_id=$1`, [conv])).rows[0].n;
  const drafts = (await pool.query(`select count(*)::int n from agent_drafts d join agent_runs r on r.id=d.agent_run_id where r.conversation_id=$1`, [conv])).rows[0].n;
  return { inb: await q("inbound"), out: await q("outbound"), runs, drafts };
}
async function readyDraftId(pid) {
  const conv = await convOf(pid);
  return (await pool.query(`select d.id from agent_drafts d join agent_runs r on r.id=d.agent_run_id where r.conversation_id=$1 and d.status='ready' order by d.created_at desc limit 1`, [conv])).rows[0]?.id;
}
const sendDraft = (draftId) => fetch(`${base}/agent/drafts/${draftId}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }).then(r => r.status);

async function main() {
  const app = express(); app.use(express.json()); app.use("/", agent);
  srv = http.createServer(app); await new Promise(r => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`;
  await pool.query(`insert into properties (id,name,sms_number) values ($1,'Property Spine Demo Building','+12154452021') on conflict (id) do nothing`, [DEMO]);

  if (!ONLY.length || ONLY.includes("A")) {
    console.log("\n\u2500\u2500\u2500 A. Normal inbound → one outbound row + one wire call \u2500\u2500\u2500");
    TOOLMODE = false; resetWire();
    const pid = await newProspect("A OneOut");
    await inbound(pid, "what's a studio run?");
    const c = await counts(pid);
    chk("A. one inbound, one run, one draft", c.inb === 1 && c.runs === 1 && c.drafts === 1, `inb=${c.inb} runs=${c.runs} drafts=${c.drafts}`);
    chk("A. exactly one outbound comm_event", c.out === 1, `out=${c.out}`);
    chk("A. exactly one wire call (sendPropertySms)", WIRE_CALLS === 1, `wire=${WIRE_CALLS}`);
  }

  if (!ONLY.length || ONLY.includes("B")) {
    console.log("\n\u2500\u2500\u2500 B. Tool-chain → one final text, one outbound, one wire \u2500\u2500\u2500");
    TOOLMODE = true; resetWire();
    const pid = await newProspect("B ToolChain");
    await inbound(pid, "show me something under 1800");
    const c = await counts(pid);
    chk("B. one run, one draft (tool steps did not each message)", c.runs === 1 && c.drafts === 1, `runs=${c.runs} drafts=${c.drafts}`);
    chk("B. exactly one outbound comm_event", c.out === 1, `out=${c.out}`);
    chk("B. exactly one wire call after the tool chain", WIRE_CALLS === 1, `wire=${WIRE_CALLS}`);
    TOOLMODE = false;
  }

  if (!ONLY.length || ONLY.includes("C")) {
    console.log("\n\u2500\u2500\u2500 C. CONCURRENT duplicate sms_sid → one of everything \u2500\u2500\u2500");
    TOOLMODE = false; resetWire();
    const pid = await newProspect("C ConcurrentDup");
    const ms = "SM" + crypto.randomBytes(10).toString("hex");
    const [a, b] = await Promise.all([fireInbound(pid, "hi there", ms), fireInbound(pid, "hi there", ms)]);
    await new Promise(z => setTimeout(z, 700));
    const c = await counts(pid);
    chk("C. exactly one inbound recorded (concurrent same sms_sid)", c.inb === 1, `inb=${c.inb}`);
    chk("C. exactly one run, one draft", c.runs === 1 && c.drafts === 1, `runs=${c.runs} drafts=${c.drafts}`);
    chk("C. exactly one outbound comm_event", c.out === 1, `out=${c.out}`);
    chk("C. exactly one wire call", WIRE_CALLS === 1, `wire=${WIRE_CALLS}`);
    chk("C. both HTTP calls 200 (loser idempotent-replayed, not crashed)", a.status === 200 && b.status === 200, `a=${a.status} b=${b.status}`);
  }

  if (!ONLY.length || ONLY.includes("D")) {
    console.log("\n\u2500\u2500\u2500 D. CONCURRENT double dispatch of same draft → one send \u2500\u2500\u2500");
    process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = ""; TOOLMODE = false; resetWire();
    const pid = await newProspect("D ConcurrentSend");
    await inbound(pid, "quick question");
    const draftId = await readyDraftId(pid);
    chk("D. a ready draft exists to contend on", !!draftId, String(draftId));
    const [s1, s2] = await Promise.all([sendDraft(draftId), sendDraft(draftId)]);
    await new Promise(z => setTimeout(z, 500));
    const c = await counts(pid);
    const oneWon = (s1 === 200) !== (s2 === 200);
    chk("D. exactly one dispatch succeeded, the other refused", oneWon, `s1=${s1} s2=${s2}`);
    chk("D. exactly one outbound comm_event", c.out === 1, `out=${c.out}`);
    chk("D. exactly one wire call (transport not double-fired)", WIRE_CALLS === 1, `wire=${WIRE_CALLS}`);
    process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = DEMO;
  }

  if (!ONLY.length || ONLY.includes("E")) {
    console.log("\n\u2500\u2500\u2500 E. STALE draft → refused, no outbound row, no wire call \u2500\u2500\u2500");
    process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = ""; TOOLMODE = false; resetWire();
    const pid = await newProspect("E Stale");
    await inbound(pid, "first message");
    const staleDraftId = await readyDraftId(pid);
    chk("E. first inbound produced a ready (unsent) draft", !!staleDraftId, String(staleDraftId));
    await inbound(pid, "second message, newer"); // bumps thread_version → first draft stale
    resetWire(); // count only what the stale-send attempt does
    const outBefore = (await counts(pid)).out;
    const sendStatus = await sendDraft(staleDraftId);
    const c = await counts(pid);
    chk("E. stale draft dispatch refused (not 200)", sendStatus !== 200, `status=${sendStatus}`);
    chk("E. stale send produced NO new outbound comm_event", c.out === outBefore, `before=${outBefore} after=${c.out}`);
    chk("E. stale send produced NO wire call", WIRE_CALLS === 0, `wire=${WIRE_CALLS}`);
    process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = DEMO;
  }

  console.log(`\n${failed === 0 ? "\u2713 ALL PASS" : "\u2717 FAILURES"}  passed=${passed} failed=${failed}`);
  await srv.close(); await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
