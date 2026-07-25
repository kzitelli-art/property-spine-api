// ════════════════════════════════════════════════════════════════════
//  PROOF HARNESS — inbound prospect SMS resolution (Option A), v2
//
//  Corrections in this version (per review):
//   #1 Cross-tier conflict: one resident + a DIFFERENT-person open lead →
//      needs_human (NOT silent resident win). Same durable person as both →
//      resident. Asserted directly.
//   #2 REAL webhook handoff: mounts the ACTUAL tenantlink /communications/
//      inbound-sms route AND the agent route on one app, wired with the real
//      getAgentService, and drives Twilio-shaped POSTs — proving
//      webhook→resolver→(resident→runInbound | lead→agent) end to end.
//   #3 CONCURRENCY race: two concurrent identical MessageSid deliveries →
//      one inbound comm_event, no 23505-driven 500, one agent run, ≤1 outbound.
//   #4 OUTBOUND-reply dedup: deterministic fake model returns a safe draft +
//      an SMS transport SPY counts sends → exactly one outbound across a
//      duplicate delivery (with auto-dispatch ON for the test property).
//   #5 SELF-CLEANING: every created UUID is tracked and deleted in dependency
//      order. No broad name-pattern deletes. Safe to run on Neon.
//
//  RUN:  DATABASE_URL="<db>" node inbound_prospect_resolution_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const express = require("express");
const crypto = require("crypto");
const http = require("http");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
const sid = () => "SM" + crypto.randomBytes(16).toString("hex");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${detail ? "  \u2014 " + detail : ""}`); }
}

const created = {
  properties: [], units: [], spaces: [], persons: [],
  leases: [], tenant_invites: [], leasing_leads: [], conversations: [],
};
function track(kind, id) { created[kind].push(id); return id; }

const smsSpy = {
  sends: [],
  enabled: () => true,
  validateWebhook: () => true,
  async sendSms({ to, from, body }) {
    this.sends.push({ to, from, body });
    return { sent: true, sid: "SMSPY_" + crypto.randomBytes(8).toString("hex") };
  },
};

const fakeAnthropic = {
  messages: {
    async create() {
      return {
        content: [{ type: "text", text: "Thanks for reaching out! We do have availability \u2014 would you like to book a tour?" }],
        _request_id: "req_fake",
      };
    },
  },
};

const boundary = require("../src/comms/communications_boundary.js")({ pool, sms: smsSpy });

async function spawnObligationFromEvent(client, o) {
  const r = await client.query(
    `insert into obligations (id, property_id, person_id, unit_id, module, type, label, owner_type, assigned_role, status)
     values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8::role_name,'open') returning id`,
    [o.property_id, o.person_id, o.unit_id || null, o.module, o.type, o.label, o.owner_type, o.assigned_role || null]
  ).catch(() => ({ rows: [{ id: null }] }));
  return r.rows[0];
}
async function completeObligation() { return {}; }
const leasingLifecycle = { maybeReopenOnQualifyingInbound: async () => ({}) };

let agentApp, app, srv, base, TEST_PROP, LINE, OTHER_LINE, spaceId, unitId;

async function makeProperty(smsNumber) {
  const id = track("properties", uuid());
  await pool.query(`insert into properties (id, name, sms_number) values ($1,'PROOF Prop',$2)`, [id, smsNumber]);
  const u = track("units", uuid());
  await pool.query(`insert into units (id, property_id, unit_number, bedrooms, bathrooms, market_rent, occupancy_status)
    values ($1,$2,'P-1',1,1,1500,'occupied')`, [u, id]);
  const s = track("spaces", uuid());
  await pool.query(`insert into spaces (id, unit_id, space_label) values ($1,$2,'(whole unit)')`, [s, u]);
  return { id, unitId: u, spaceId: s };
}
async function person(phone, name) {
  const id = track("persons", uuid());
  await pool.query(`insert into persons (id, name, phone) values ($1,$2,$3)`, [id, name, phone]);
  return id;
}
async function makeResident(propId, spId, phone, name, pid = null) {
  pid = pid || await person(phone, name);
  const lid = track("leases", uuid());
  await pool.query(`insert into leases (id, property_id, space_id, tenant_ids, lease_status)
    values ($1,$2,$3,ARRAY[$4]::uuid[],'active')`, [lid, propId, spId, pid]);
  const iid = track("tenant_invites", uuid());
  await pool.query(`insert into tenant_invites (id, person_id, property_id, token, status, expires_at)
    values ($1,$2,$3,$4,'used', now() + interval '30 days')`,
    [iid, pid, propId, "tok_" + crypto.randomBytes(6).toString("hex")]);
  return pid;
}
async function makeLead(propId, phone, name, status = "new", pid = null) {
  pid = pid || await person(phone, name);
  const lid = track("leasing_leads", uuid());
  await pool.query(`insert into leasing_leads (id, person_id, property_id, status) values ($1,$2,$3,$4)`,
    [lid, pid, propId, status]);
  return pid;
}
async function commCount(smsSid) {
  return Number((await pool.query(`select count(*)::int n from comm_events where sms_sid=$1`, [smsSid])).rows[0].n);
}
async function runCount(convPropId) {
  return Number((await pool.query(
    `select count(*)::int n from agent_runs r
       join conversations c on c.id = r.conversation_id
      where c.property_id = $1`, [convPropId])).rows[0].n);
}
async function postInbound({ To, From, Body, MessageSid }) {
  const res = await fetch(`${base}/communications/inbound-sms`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To, From, Body, MessageSid, AccountSid: "ACtest" }).toString(),
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  agentApp = require("../src/agent/agent.js")({
    pool, anthropic: fakeAnthropic, INGEST_MODEL: "fake-model",
    spawnObligationFromEvent, completeObligation, leasingLifecycle, commBoundary: boundary,
  });
  const tenantLink = require("../src/comms/tenantlink.js")({
    pool, anthropic: fakeAnthropic, INGEST_MODEL: "fake-model", sms: smsSpy,
    commBoundary: boundary,
    getAgentService: () => agentApp._service,
  });
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use("/", tenantLink);
  app.use("/", agentApp);
  srv = http.createServer(app);
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;

  const P = await makeProperty("+1555" + Math.floor(1e6 + Math.random() * 8e6));
  TEST_PROP = P.id; spaceId = P.spaceId; unitId = P.unitId;
  LINE = (await pool.query(`select sms_number from properties where id=$1`, [TEST_PROP])).rows[0].sms_number;
  OTHER_LINE = "+1555" + Math.floor(1e6 + Math.random() * 8e6);
  // auto-dispatch ON for this property (env perimeter)
  process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = TEST_PROP;

  console.log("\n\u2500\u2500\u2500 RESOLVER PROOFS (real Postgres) \u2500\u2500\u2500");
  {
    const phone = "+1607" + Math.floor(1e6 + Math.random() * 8e6);
    await makeResident(TEST_PROP, spaceId, phone, "Rhonda Resident");
    const ctx = await boundary.resolveInboundSmsContext({ To: LINE, From: phone, MessageSid: sid(), body: "hi" });
    check("1. resident-only -> relationship='resident'", ctx.relationship === "resident" && ctx.comm_event === null);
  }
  {
    const phone = "+1610" + Math.floor(1e6 + Math.random() * 8e6);
    const pid = await makeLead(TEST_PROP, phone, "Larry Lead", "new");
    const ctx = await boundary.resolveInboundSmsContext({ To: LINE, From: phone, MessageSid: sid(), body: "units?" });
    check("2. open-lead-only -> relationship='lead', writes nothing",
      ctx.relationship === "lead" && ctx.person.id === pid && ctx.comm_event === null);
  }
  {
    const phone = "+1215" + Math.floor(1e6 + Math.random() * 8e6);
    await makeResident(TEST_PROP, spaceId, phone, "Resident Person");
    await makeLead(TEST_PROP, phone, "Different Lead Person", "new");
    const ctx = await boundary.resolveInboundSmsContext({ To: LINE, From: phone, MessageSid: sid(), body: "hi" });
    check("1* resident + DIFFERENT-person lead (same phone) -> needs_human (no silent resident win)",
      ctx.ambiguous === true && ctx.relationship == null && ctx.person === null,
      JSON.stringify({ rel: ctx.relationship, amb: ctx.ambiguous }));
  }
  {
    const phone = "+1484" + Math.floor(1e6 + Math.random() * 8e6);
    const pid = await person(phone, "Same Person Both");
    await makeResident(TEST_PROP, spaceId, phone, "Same Person Both", pid);
    await makeLead(TEST_PROP, phone, "Same Person Both", "new", pid);
    const ctx = await boundary.resolveInboundSmsContext({ To: LINE, From: phone, MessageSid: sid(), body: "hi" });
    check("1* resident + lead = SAME durable person -> resolves as resident",
      ctx.relationship === "resident" && ctx.person && ctx.person.id === pid,
      JSON.stringify({ rel: ctx.relationship }));
  }
  {
    const phone = "+1612" + Math.floor(1e6 + Math.random() * 8e6);
    await makeLead(TEST_PROP, phone, "Lost Lead", "lost");
    const ctx = await boundary.resolveInboundSmsContext({ To: LINE, From: phone, MessageSid: sid(), body: "hi" });
    check("terminal lead (lost) is NOT open -> needs_human", ctx.ambiguous === true && ctx.relationship == null);
  }
  {
    const phone = "+1720" + Math.floor(1e6 + Math.random() * 8e6);
    await makeLead(TEST_PROP, phone, "Lead A", "new");
    await makeLead(TEST_PROP, phone, "Lead B", "tour_requested");
    const ctx = await boundary.resolveInboundSmsContext({ To: LINE, From: phone, MessageSid: sid(), body: "hi" });
    check(">1 open lead -> needs_human (no silent pick)", ctx.ambiguous === true && ctx.relationship == null);
  }
  {
    const phone = "+1856" + Math.floor(1e6 + Math.random() * 8e6);
    const pid = await person(phone, "Cold Convo");
    const cid = track("conversations", uuid());
    await pool.query(`insert into conversations (id, property_id, person_id) values ($1,$2,$3)`, [cid, TEST_PROP, pid]);
    const ctx = await boundary.resolveInboundSmsContext({ To: LINE, From: phone, MessageSid: sid(), body: "still there?" });
    check("conversation-only (no lease, no open lead) -> needs_human", ctx.ambiguous === true && ctx.relationship == null);
  }
  {
    const phone = "+1610" + Math.floor(1e6 + Math.random() * 8e6);
    await makeLead(TEST_PROP, phone, "Would-be", "new");
    const before = (await pool.query(`select count(*)::int n from comm_events`)).rows[0].n;
    const ctx = await boundary.resolveInboundSmsContext({ To: OTHER_LINE, From: phone, MessageSid: sid(), body: "hi" });
    const after = (await pool.query(`select count(*)::int n from comm_events`)).rows[0].n;
    check("unknown line -> unknownLine, zero rows, no sender resolution",
      ctx.unknownLine === true && ctx.relationship == null && after - before === 0);
  }

  console.log("\n\u2500\u2500\u2500 #2 REAL WEBHOOK ROUTE (webhook -> resolver -> brain) \u2500\u2500\u2500");
  {
    const phone = "+1908" + Math.floor(1e6 + Math.random() * 8e6);
    await makeResident(TEST_PROP, spaceId, phone, "Webhook Resident");
    const ms = sid();
    const before = await commCount(ms);
    const r = await postInbound({ To: LINE, From: phone, Body: "my sink is leaking", MessageSid: ms });
    const after = await commCount(ms);
    check("webhook->resident->runInbound: 200 + exactly one inbound comm_event written",
      r.status === 200 && after - before === 1, `status=${r.status}, delta=${after - before}`);
  }
  {
    const phone = "+1917" + Math.floor(1e6 + Math.random() * 8e6);
    await makeLead(TEST_PROP, phone, "Webhook Lead", "new");
    const ms = sid();
    const before = await commCount(ms);
    smsSpy.sends.length = 0;
    const r = await postInbound({ To: LINE, From: phone, Body: "do you have any 1 bedrooms?", MessageSid: ms });
    await new Promise(res => setTimeout(res, 400));
    const after = await commCount(ms);
    const inboundRow = (await pool.query(
      `select sender_role from comm_events where sms_sid=$1 and direction='inbound' limit 1`, [ms]
    )).rows[0];
    check("webhook->lead->agent: exactly one inbound comm_event, agent-stamped (sender_role='prospect')",
      r.status === 200 && after - before === 1 && inboundRow && inboundRow.sender_role === "prospect",
      JSON.stringify({ status: r.status, delta: after - before, row: inboundRow }));
  }

  console.log("\n\u2500\u2500\u2500 #3 CONCURRENCY RACE (same MessageSid, concurrent) \u2500\u2500\u2500");
  {
    process.env.SMS_SEND_MODE = "internal_qa_autonomous";
    const phone = "+1973" + Math.floor(1e6 + Math.random() * 8e6);
    const pid = await makeLead(TEST_PROP, phone, "Race Lead", "new");
    await boundary.enrollInternalQa({ person_id: pid, property_id: TEST_PROP, actor_user_id: null });
    const ms = sid();
    smsSpy.sends.length = 0;
    const runsBefore = await runCount(TEST_PROP);
    const [a, b] = await Promise.all([
      postInbound({ To: LINE, From: phone, Body: "hi from race", MessageSid: ms }),
      postInbound({ To: LINE, From: phone, Body: "hi from race", MessageSid: ms }),
    ]);
    await new Promise(res => setTimeout(res, 900));
    const inboundN = await commCount(ms);
    const runsAfter = await runCount(TEST_PROP);
    const outbound = smsSpy.sends.length;
    check("#3 concurrent dup: both webhook responses 200 (no 23505-driven 500)",
      a.status === 200 && b.status === 200, `a=${a.status} b=${b.status}`);
    check("#3 concurrent dup: exactly ONE inbound comm_event", inboundN === 1, `count=${inboundN}`);
    check("#3 concurrent dup: exactly ONE agent run", runsAfter - runsBefore === 1, `delta=${runsAfter - runsBefore}`);
    check("#3 concurrent dup: at most ONE outbound reply attempt", outbound <= 1, `sends=${outbound}`);
    process.env.SMS_SEND_MODE = "disabled";
  }

  console.log("\n\u2500\u2500\u2500 #4 OUTBOUND-REPLY DEDUP (deterministic model + SMS spy) \u2500\u2500\u2500");
  {
    // Replicate the LIVE aperture the real environment provides for an AI reply
    // to a prospect: send mode internal_qa_autonomous + the recipient enrolled
    // as internal_qa/opted_in. This proves the outbound goes through the REAL
    // gate (not bypassing it) exactly once, and the duplicate is suppressed.
    process.env.SMS_SEND_MODE = "internal_qa_autonomous";
    const phone = "+1215" + Math.floor(2e6 + Math.random() * 7e6);
    const pid = await makeLead(TEST_PROP, phone, "Reply Dedup Lead", "new");
    await boundary.enrollInternalQa({ person_id: pid, property_id: TEST_PROP, actor_user_id: null });
    const ms = sid();
    smsSpy.sends.length = 0;
    await postInbound({ To: LINE, From: phone, Body: "hello there", MessageSid: ms });
    await new Promise(res => setTimeout(res, 700));
    const afterFirst = smsSpy.sends.length;
    await postInbound({ To: LINE, From: phone, Body: "hello there", MessageSid: ms });
    await new Promise(res => setTimeout(res, 700));
    const afterSecond = smsSpy.sends.length;
    check("#4 first delivery produced exactly ONE outbound reply (auto-dispatched through the real gate)",
      afterFirst === 1, `sends=${afterFirst}`);
    check("#4 duplicate delivery produced NO additional outbound reply",
      afterSecond === afterFirst && afterSecond === 1, `first=${afterFirst} afterDup=${afterSecond}`);
    const inboundN = await commCount(ms);
    check("#4 duplicate delivery wrote no second inbound record", inboundN === 1, `count=${inboundN}`);
    process.env.SMS_SEND_MODE = "disabled";
  }

  srv.close();
  console.log("\n\u2500\u2500\u2500 cleanup (exact UUIDs, dependency order) \u2500\u2500\u2500");
  await cleanup();

  console.log(`\n\u2550\u2550\u2550 RESULT: ${passed} passed, ${failed} failed \u2550\u2550\u2550`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  const props = created.properties;
  if (props.length) {
    const ph = props.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`update agent_thread_state set latest_inbound_comm_event_id=null, current_review_obligation_id=null
      where conversation_id in (select id from conversations where property_id in (${ph}))`, props).catch(() => {});
    await pool.query(`delete from agent_drafts where agent_run_id in
      (select r.id from agent_runs r join conversations c on c.id=r.conversation_id where c.property_id in (${ph}))`, props).catch(() => {});
    await pool.query(`delete from agent_runs where conversation_id in
      (select id from conversations where property_id in (${ph}))`, props).catch(() => {});
    await pool.query(`delete from agent_thread_state where conversation_id in
      (select id from conversations where property_id in (${ph}))`, props).catch(() => {});
    await pool.query(`delete from comm_events where property_id in (${ph})`, props).catch(() => {});
    await pool.query(`delete from obligations where property_id in (${ph})`, props).catch(() => {});
    await pool.query(`delete from lead_source_touches where lead_id in
      (select id from leasing_leads where property_id in (${ph}))`, props).catch(() => {});
    // person_property_classifications written by enrollInternalQa in #3/#4
    await pool.query(`delete from person_property_classifications where property_id in (${ph})`, props).catch(() => {});
  }
  const delById = async (table, ids) => {
    if (!ids.length) return;
    const ph = ids.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`delete from ${table} where id in (${ph})`, ids).catch((e) => console.log(`  (cleanup ${table}: ${e.message.split("\n")[0]})`));
  };
  await delById("conversations", created.conversations);
  await delById("leasing_leads", created.leasing_leads);
  await delById("tenant_invites", created.tenant_invites);
  await delById("leases", created.leases);
  if (created.persons.length) {
    const ph = created.persons.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`delete from contact_preferences where person_id in (${ph})`, created.persons).catch(() => {});
  }
  await delById("spaces", created.spaces);
  await delById("units", created.units);
  await delById("persons", created.persons);
  await delById("properties", created.properties);
  console.log("  cleanup complete (only tracked UUIDs touched).");
}

main().catch(async (e) => {
  console.error("HARNESS ERROR:", e);
  try { if (srv) srv.close(); await cleanup(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
