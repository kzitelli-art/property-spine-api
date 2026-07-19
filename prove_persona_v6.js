// ════════════════════════════════════════════════════════════════════
//  SLICE 3 — PERSONA BEHAVIOR TRANSCRIPTS  (prove_persona_v6.js)
//  Unlike the architectural harnesses, this drives the REAL model through the
//  REAL prompt and asserts on the TEXT the agent produces. It needs a live
//  Anthropic key (INGEST_MODEL / ANTHROPIC_API_KEY in the Render env) — run it
//  from the Render Web Shell. Assertions are deliberately structural (presence/
//  absence of a tour ask, local specificity, whole-building framing) rather than
//  exact-wording, because model text varies. Each scenario prints the reply so a
//  human can eyeball tone too.
//
//   T1. Neighborhood question → concrete local value, NO tour pitch.
//   T2. Work-from-home question → sells whole-building experience (names a
//       shared space), not a bare amenity list.
//   T3. Ignored tour invitation → the NEXT reply does not immediately re-ask.
//   T4. Serious availability question → can still move naturally toward a tour.
//   T5. ESCALATE and HANDOFF still fire correctly (regression guard).
//
//  Run:  node prove_persona_v6.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const express = require("express"); const http = require("http"); const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
let passed = 0, failed = 0;
const chk = (n, c, d = "") => { if (c) { passed++; console.log(`  \u2713 ${n}`); } else { failed++; console.log(`  \u2717 ${n} ${d}`); } };
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
process.env.SMS_SEND_MODE = "internal_qa_autonomous";
process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = DEMO;

// REAL Anthropic client — this harness proves prompt BEHAVIOR, so no fake model.
const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.INGEST_MODEL || "claude-sonnet-4-6";

const noopSms = { enabled: () => false, sendSms: async () => ({ sent: true, sid: "SMx" }), validateWebhook: () => true };
const boundary = require("./communications_boundary")({ pool, sms: noopSms });
async function spawnOb(c, o) {
  const r = await c.query(
    `insert into obligations (id, property_id, person_id, module, type, label, owner_type, assigned_role, status, priority, severity)
     values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'open','normal','normal') returning *`,
    [o.property_id, o.person_id, o.module, o.type, o.label, o.owner_type, o.assigned_role || null]);
  return r.rows[0];
}
const agent = require("./agent")({ pool, anthropic, INGEST_MODEL: MODEL, spawnObligationFromEvent: spawnOb, completeObligation: async () => ({}), leasingLifecycle: { maybeReopenOnQualifyingInbound: async () => ({}) }, commBoundary: boundary, leasingBookingService: null });

let srv, base; const track = [];
async function newProspect(name) {
  const pid = uuid(); track.push(pid);
  await pool.query(`insert into persons (id,name,phone) values ($1,$2,$3)`, [pid, name, "+1555" + Math.floor(1e6 + Math.random() * 8e6)]);
  await pool.query(`insert into leasing_leads (id,person_id,property_id,status) values ($1,$2,$3,'new')`, [uuid(), pid, DEMO]);
  await pool.query(`insert into person_property_classifications (person_id,property_id,record_class,classification_source) values ($1,$2,'internal_qa','system')`, [pid, DEMO]).catch(() => {});
  await pool.query(`insert into contact_preferences (person_id,channel,consent_state,source,updated_at) values ($1,'text','opted_in','internal_qa_enrollment',now()) on conflict (person_id,channel) do update set consent_state='opted_in'`, [pid]).catch(() => {});
  return pid;
}
async function convOf(pid) { return (await pool.query(`select id from conversations where person_id=$1 and property_id=$2`, [pid, DEMO])).rows[0]?.id; }
async function say(pid, body) {
  await fetch(`${base}/agent/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ property_id: DEMO, person_id: pid, body, sms_sid: "SM" + crypto.randomBytes(10).toString("hex") }) });
  await new Promise(z => setTimeout(z, 1200));
  const conv = await convOf(pid);
  const d = (await pool.query(`select d.generated_body from agent_drafts d join agent_runs r on r.id=d.agent_run_id where r.conversation_id=$1 order by d.created_at desc limit 1`, [conv])).rows[0];
  return (d && d.generated_body) || "";
}
const asksTour = (t) => /\btour\b|come (take a look|by|in|check)|see (the|a) (place|unit|building|apartment)|stop by|come see/i.test(t);
const mentionsSharedSpace = (t) => /coworking|study room|lounge|roof( ?deck| ?top)|recreation|rec room|common (area|space)|shared space|work(space| from home)|golf sim/i.test(t);

async function main() {
  const app = express(); app.use(express.json()); app.use("/", agent);
  srv = http.createServer(app); await new Promise(r => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`;
  await pool.query(`insert into properties (id,name,sms_number) values ($1,'Property Spine Demo Building','+12154452021') on conflict (id) do nothing`, [DEMO]);

  console.log("\n\u2500\u2500\u2500 T1. Neighborhood question → local value, no tour pitch \u2500\u2500\u2500");
  {
    const pid = await newProspect("T1 Local");
    const r = await say(pid, "what's the food like around there?");
    console.log(`     reply: ${r}`);
    chk("T1. does NOT pitch a tour on a pure neighborhood question", !asksTour(r), r.slice(0, 60));
    chk("T1. gives some substantive answer (not a deflection)", r.length > 25, `len=${r.length}`);
  }

  console.log("\n\u2500\u2500\u2500 T2. Work-from-home → sells whole-building experience \u2500\u2500\u2500");
  {
    const pid = await newProspect("T2 WFH");
    const r = await say(pid, "I work from home full time, is this a good place for that?");
    console.log(`     reply: ${r}`);
    chk("T2. connects to a shared/building space, not just the unit", mentionsSharedSpace(r), r.slice(0, 80));
  }

  console.log("\n\u2500\u2500\u2500 T3. Ignored tour invite → next reply does not immediately re-ask \u2500\u2500\u2500");
  {
    const pid = await newProspect("T3 NoRepeat");
    // Turn 1: a serious question likely to draw a tour invite.
    const r1 = await say(pid, "do you have any 1-bedrooms available soon?");
    console.log(`     reply 1: ${r1}`);
    // Turn 2: prospect ignores any tour ask, asks something else.
    const r2 = await say(pid, "what's the pet policy?");
    console.log(`     reply 2: ${r2}`);
    // The rule: don't ask for a tour in consecutive messages. If r1 asked, r2 must not.
    const ok = !(asksTour(r1) && asksTour(r2));
    chk("T3. not a tour ask in two consecutive replies", ok, `r1_tour=${asksTour(r1)} r2_tour=${asksTour(r2)}`);
  }

  console.log("\n\u2500\u2500\u2500 T4. Serious availability → can still progress toward a tour \u2500\u2500\u2500");
  {
    const pid = await newProspect("T4 Serious");
    await say(pid, "I'm looking to move in the next couple weeks, what's open?");
    const r = await say(pid, "the studio sounds good, what's next?");
    console.log(`     reply: ${r}`);
    // Not a hard requirement that it asks, but it SHOULD be allowed to; assert it
    // moves the process forward (tour OR a concrete next step like applying/seeing it).
    const progresses = asksTour(r) || /appl(y|ication)|next step|get you (in|started)|hold|reserve|see it|come/i.test(r);
    chk("T4. offers a real next step (tour or application/viewing)", progresses, r.slice(0, 80));
  }

  console.log("\n\u2500\u2500\u2500 T5. ESCALATE / HANDOFF regression guard \u2500\u2500\u2500");
  {
    const pidE = await newProspect("T5 Escalate");
    // Give the specific up front so escalation is deterministic — a vague "can I
    // move in Sunday?" legitimately makes the model ask "which unit?" first
    // (gathering the specific before creating meaningful staff work), which is
    // correct behavior, not a miss. A real prospect naming a unit is the trigger.
    await say(pidE, "I'm interested in unit 214, the studio.");
    const re = await say(pidE, "can that unit actually be ready for me to move in this Sunday?");
    console.log(`     escalate reply: ${re}`);
    const escRows = (await pool.query(`select 1 from obligations where person_id=$1 and type='operational_escalation'`, [pidE])).rows.length;
    chk("T5. readiness question (unit known) created an operational_escalation obligation", escRows >= 1, `rows=${escRows}`);
    chk("T5. escalate reply did NOT emit a raw [[HANDOFF]] tag", !/\[\[HANDOFF/i.test(re), re.slice(0, 60));

    const pidH = await newProspect("T5 Handoff");
    const rh = await say(pidH, "I need to talk to a real human being right now, this is urgent");
    console.log(`     handoff reply: ${rh}`);
    const hRows = (await pool.query(`select 1 from obligations where person_id=$1 and type='operational_escalation'`, [pidH])).rows.length;
    chk("T5. explicit person-request did NOT create an operational_escalation", hRows === 0, `rows=${hRows}`);
  }

  console.log(`\n${failed === 0 ? "\u2713 ALL PASS" : "\u2717 FAILURES"}  passed=${passed} failed=${failed}`);
  await srv.close(); await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
