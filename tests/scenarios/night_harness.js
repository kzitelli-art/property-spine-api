#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  night_harness.js — FUNNEL-FLOW OVERNIGHT PROOF (Builds 1–3)
//  Real local Postgres. Fake Anthropic (scripted tool_use). Fake SMS
//  transport (records wire attempts). Proves the ruling's receipt list:
//  offered≠selected, property wall, prepared≠dispatched, auto perimeter,
//  honest provenance, gate enforcement, hallucination guard.
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://claude:claude@localhost/spinenight" });

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? " — " + d : ""}`)); };
const count = async (sql, p) => Number((await pool.query(sql, p)).rows[0].count);

// fake transport
const wireLog = [];
const fakeSms = {
  enabled: () => true,
  async sendSms({ to, from, body }) { wireLog.push({ to, from, body }); return { sent: true, sid: "SM_NIGHT_" + wireLog.length, status: "queued" }; },
  validateWebhook: () => true,
};
// fake Anthropic — scripted per call
let scriptQueue = [];
const fakeAnthropic = {
  messages: {
    async create(req) {
      const isAgentCall = Array.isArray(req.tools) && req.tools.some(t => t.name === "find_available_units")
        || (Array.isArray(req.messages) && req.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === "tool_result")));
      if (!isAgentCall) return { id: "req_side", content: [{ type: "text", text: "{}" }] }; // prospect_capture etc: benign
      const step = scriptQueue.shift();
      if (!step) return { id: "req_none", content: [{ type: "text", text: "Thanks! A teammate will follow up." }] };
      return step(req);
    },
  },
};
// fake obligations plumbing
async function fakeSpawn(client, { module: m, type }) {
  const r = await client.query(`insert into obligations (label, module, type, status) values ($1,$2,$3,'open') returning id`, [type, m, type]);
  return { obligation: { id: r.rows[0].id } };
}
async function fakeComplete(client, { obligation_id }) {
  await client.query(`update obligations set status='complete' where id=$1`, [obligation_id]);
}

(async () => {
  console.log("═══ FUNNEL-FLOW NIGHT HARNESS ═══\n");
  const commBoundary = require("../../src/comms/communications_boundary.js")({ pool, sms: fakeSms });
  const inventory = require("../../src/leasing/leasing_inventory.js")({ pool });
  const agent = require("../../src/agent/agent.js")({
    pool, anthropic: fakeAnthropic, INGEST_MODEL: "claude-sonnet-4-6",
    spawnObligationFromEvent: fakeSpawn, completeObligation: fakeComplete,
    leasingLifecycle: null, commBoundary,
  });
  const appSub = require("../../src/applications/application_submission.js")({
    pool, spawnObligationFromEvent: fakeSpawn, completeObligation: fakeComplete,
    conversionService: null, commBoundary,
  });
  const dispatchSvc = appSub._service.createAndDispatchApplicationInvitation;

  // express-less invocation of the agent route
  const express = require("express");
  const app = express(); app.use(express.json()); app.use("/", agent); app.use("/", appSub);
  process.env.OPERATOR_KEY = "night-op-key";
  const http = require("http"); const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  async function agentInbound(body) {
    const res = await fetch(`http://127.0.0.1:${port}/agent/inbound`, {
      // /agent/inbound is operator-gated (2026-07-26). This harness sets
      // OPERATOR_KEY above for the server it just started.
      method: "POST", headers: { "content-type": "application/json", "x-operator-key": "night-op-key" }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  // ── seed world ──
  const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
  const SOLO = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";
  await pool.query(`insert into properties (id, name, display_name, sms_number) values ($1,'Demo','Solo on Chestnut','+15550000010') on conflict (id) do nothing`, [DEMO]);
  await pool.query(`insert into properties (id, name, sms_number) values ($1,'Solo Real','+15550000011') on conflict (id) do nothing`, [SOLO]);
  const soloUnit = (await pool.query(`insert into units (property_id, unit_number, bedrooms, bathrooms, market_rent, occupancy_status) values ($1,'S-101',1,1,1500,'vacant') returning id`, [SOLO])).rows[0];

  // ═══ BUILD 1: seed ═══
  console.log("── Build 1: deterministic demo inventory ──");
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://claude:claude@localhost/spinenight";
  const { execSync } = require("child_process");
  const soloBefore = await count(`select count(*) as count from units where property_id=$1`, [SOLO]);
  const out1 = execSync(`node seed_demo_inventory.js --confirm`, { cwd: __dirname, env: process.env }).toString();
  const demoUnits = await count(`select count(*) as count from units where property_id=$1`, [DEMO]);
  const soloAfter = await count(`select count(*) as count from units where property_id=$1`, [SOLO]);
  check("seed loads the deterministic set (48 units)", demoUnits === 48, `got ${demoUnits}`);
  check("Solo untouched by seed", soloAfter === soloBefore);
  check("every seeded row carries demo_qa_inventory provenance",
    await count(`select count(*) as count from units where property_id=$1 and source_type='demo_qa_inventory'`, [DEMO]) === 48);
  const out1b = execSync(`node seed_demo_inventory.js --confirm`, { cwd: __dirname, env: process.env }).toString();
  check("seed is idempotent (second run creates 0)", /created 0/.test(out1b) && (await count(`select count(*) as count from units where property_id=$1`, [DEMO])) === 48);
  const vacants = await count(`select count(*) as count from units where property_id=$1 and occupancy_status='vacant'`, [DEMO]);
  check("plenty vacant (36/48)", vacants === 36, `got ${vacants}`);

  // ═══ BUILD 2: availableUnits + tool loop + offered≠selected ═══
  console.log("── Build 2: grounded discovery + attach-on-confirmation ──");
  const av = await inventory.availableUnits({ property_id: DEMO, bedrooms: 2 });
  check("availableUnits returns real 2-bed vacants (default limit 5) with honest qualification",
    av.units.length === 5 && av.units.every(u => u.bedrooms === 2) && av.qualification === "vacant_not_down", `${av.units.length}`);
  const avNone = await inventory.availableUnits({ property_id: DEMO, bedrooms: 4 });
  check("zero-match returns empty honestly", avNone.units.length === 0);
  const avBudget = await inventory.availableUnits({ property_id: DEMO, max_rent: 1500 });
  check("budget filter works (only studios ≤ $1500)", avBudget.units.every(u => u.market_rent <= 1500) && avBudget.units.length > 0);

  // person + lead in DEMO
  const p1 = (await pool.query(`insert into persons (name, phone) values ('__NIGHT__Prospect','+15551234001') returning id`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [p1.id, DEMO]);

  // property wall on attach
  const wall = await inventory.attachSelectedUnit({ property_id: DEMO, person_id: p1.id, unit_id: soloUnit.id });
  check("PROPERTY WALL: attaching a Solo unit to a Demo lead is refused", wall.attached === false && wall.reason === "unit_outside_property");

  // Turn 1: prospect asks "what do you have" → model calls the tool → offers
  delete process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS; // review mode first
  scriptQueue = [
    (req) => {
      const hasTool = Array.isArray(req.tools) && req.tools.some(t => t.name === "find_available_units");
      if (!hasTool) throw new Error("tool not offered to model");
      return { id: "req_t1", content: [{ type: "tool_use", id: "tu_1", name: "find_available_units", input: { bedrooms: 2, max_rent: 2000 } }] };
    },
    (req) => {
      const tr = JSON.parse(req.messages[req.messages.length - 1].content[0].content);
      const first = tr.units[0];
      return { id: "req_t2", content: [{ type: "text", text: `We have Unit ${first.unit_number} — ${first.bedrooms}bd/${first.bathrooms}ba at $${first.market_rent}/mo. Want to take a look?` }] };
    },
  ];
  const t1 = await agentInbound({ property_id: DEMO, person_id: p1.id, body: "Hi! What 2 bedrooms do you have under $2000?" });
  check("turn 1 creates a draft (review mode: NOT auto-dispatched)", t1.json.ok && t1.json.draft_id && !t1.json.auto_dispatched, JSON.stringify(t1.json));
  const run1 = (await pool.query(`select offered_units_json, selected_unit_id from agent_runs order by created_at desc limit 1`)).rows[0];
  check("offered units recorded durably on the run", Array.isArray(run1.offered_units_json) && run1.offered_units_json.length === 5);
  check("offering did NOT attach a unit (offered ≠ selected)",
    (await pool.query(`select unit_id from leasing_leads where person_id=$1`, [p1.id])).rows[0].unit_id === null);
  check("offering did NOT select on the run", run1.selected_unit_id === null);

  // dispatch turn-1 draft by a human
  const mgr = (await pool.query(`insert into users (name) values ('__NIGHT__Mgr') returning id`)).rows[0];
  const d1 = (await pool.query(`select id from agent_drafts order by created_at desc limit 1`)).rows[0];
  const send1 = await agent._service.sendDraftService({ draftId: d1.id, actorUserId: mgr.id });
  check("human dispatch works; dispatch_mode='human'", send1.ok && send1.dispatch_mode === "human");
  check("dispatched reply goes to the WIRE through the gate (refused in disabled mode, honestly)",
    send1.sms && send1.sms.sent === false && send1.sms.reason === "send_mode_disabled", JSON.stringify(send1.sms));
  const evStamp = (await pool.query(`select sms_status, sms_error from comm_events where id=$1`, [send1.outbound_comm_event_id])).rows[0];
  check("gate refusal stamped on the outbound comm_event", evStamp.sms_status === "refused" && /send_mode_disabled/.test(evStamp.sms_error));

  // Turn 2: prospect confirms the offered unit by number → ATTACH fires
  const offeredFirst = run1.offered_units_json[0];
  scriptQueue = [ () => ({ id: "req_t3", content: [{ type: "text", text: `Wonderful — Unit ${offeredFirst.unit_number} it is. I'll get your tour set up.` }] }) ];
  const t2 = await agentInbound({ property_id: DEMO, person_id: p1.id, body: `I'm interested in unit ${offeredFirst.unit_number}!` });
  const leadNow = (await pool.query(`select unit_id from leasing_leads where person_id=$1`, [p1.id])).rows[0];
  check("prospect's OWN words attach the unit (selected)", leadNow.unit_id === offeredFirst.id, JSON.stringify(leadNow));
  const run2 = (await pool.query(`select selected_unit_id from agent_runs order by created_at desc limit 1`)).rows[0];
  check("selection recorded on the run (selected_unit_id)", run2.selected_unit_id === offeredFirst.id);

  // hallucination guard: model cites a unit NOT in the tool result → blocked
  const p2 = (await pool.query(`insert into persons (name, phone) values ('__NIGHT__P2','+15551234002') returning id`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [p2.id, DEMO]);
  scriptQueue = [
    () => ({ id: "h1", content: [{ type: "tool_use", id: "tu_h", name: "find_available_units", input: { bedrooms: 3 } }] }),
    () => ({ id: "h2", content: [{ type: "text", text: "We have Unit 9999 — a stunning penthouse!" }] }),
  ];
  const th = await agentInbound({ property_id: DEMO, person_id: p2.id, body: "Any 3 bedrooms?" });
  check("hallucinated unit is BLOCKED by the grounding guard", th.json.blocked === true && /hallucinated_unit/.test(th.json.code || ""), JSON.stringify(th.json));

  // non-returned unit cannot be attached (confirmation only matches offered set)
  scriptQueue = [ () => ({ id: "x", content: [{ type: "text", text: "Noted!" }] }) ];
  await agentInbound({ property_id: DEMO, person_id: p2.id, body: "I'll take unit 9999" });
  check("citing a never-offered unit attaches nothing",
    (await pool.query(`select unit_id from leasing_leads where person_id=$1`, [p2.id])).rows[0].unit_id === null);

  // ═══ BUILD 3c: auto-dispatch perimeter ═══
  console.log("── Build 3c: auto-dispatch perimeter + honest provenance ──");
  process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = DEMO;
  const p3 = (await pool.query(`insert into persons (name, phone) values ('__NIGHT__Auto','+15551234003') returning id`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [p3.id, DEMO]);
  scriptQueue = [ () => ({ id: "a1", content: [{ type: "text", text: "Welcome! Happy to help — what are you looking for?" }] }) ];
  const ta = await agentInbound({ property_id: DEMO, person_id: p3.id, body: "hi there" });
  check("in-perimeter safe draft AUTO-dispatches", ta.json.auto_dispatched === true, JSON.stringify(ta.json));
  const autoDraft = (await pool.query(`select dispatch_mode, dispatched_by_user_id, status from agent_drafts order by created_at desc limit 1`)).rows[0];
  check("auto provenance honest: dispatch_mode='auto', NO human id", autoDraft.dispatch_mode === "auto" && autoDraft.dispatched_by_user_id === null && autoDraft.status === "dispatched");
  const autoEv = (await pool.query(`select human_approved_by_user_id, sent_by_user_id, sms_status from comm_events where id=$1`, [ta.json.outbound_comm_event_id])).rows[0];
  check("auto outbound event carries NO borrowed human approval", autoEv.human_approved_by_user_id === null && autoEv.sent_by_user_id === null);
  check("auto SMS still refused by the gate in disabled mode (the net)", ta.json.sms && ta.json.sms.sent === false && autoEv.sms_status === "refused");

  // out-of-perimeter property: unchanged review behavior
  process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = "00000000-0000-0000-0000-000000000001";
  const p4 = (await pool.query(`insert into persons (name, phone) values ('__NIGHT__Rev','+15551234004') returning id`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [p4.id, DEMO]);
  scriptQueue = [ () => ({ id: "r1", content: [{ type: "text", text: "Hello!" }] }) ];
  const tr2 = await agentInbound({ property_id: DEMO, person_id: p4.id, body: "hello" });
  check("out-of-perimeter: draft stays for human review (no auto)", tr2.json.ok && !tr2.json.auto_dispatched);
  // blocked policy never auto-dispatches
  process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = DEMO;
  scriptQueue = [ () => ({ id: "b1", content: [{ type: "text", text: "This is a bad neighborhood for you." }] }) ];
  const tb = await agentInbound({ property_id: DEMO, person_id: p4.id, body: "how's the area?" });
  check("blocked policy NEVER auto-dispatches", tb.json.blocked === true && !tb.json.auto_dispatched);
  // auto with a human actor is rejected structurally
  let dualErr = null;
  try { await agent._service.sendDraftService({ draftId: d1.id, actorUserId: mgr.id, auto: true }); } catch (e) { dualErr = e.message; }
  check("auto dispatch refuses to borrow a human identity", /must not carry a human actor/.test(dualErr || ""));

  // ═══ BUILD 3a: application-link dispatch ═══
  console.log("── Build 3a: create + dispatch through the gate ──");
  delete process.env.PUBLIC_APPLY_BASE_URL;
  const noBase = await dispatchSvc({ property_id: DEMO, person_id: p1.id, unit_id: leadNow.unit_id });
  check("missing PUBLIC_APPLY_BASE_URL fails closed (named)", noBase.dispatched === false && noBase.reason === "public_apply_base_url_not_configured");
  process.env.PUBLIC_APPLY_BASE_URL = "https://propertyspine.com";
  delete process.env.SMS_SEND_MODE; // disabled
  const disp1 = await dispatchSvc({ property_id: DEMO, person_id: p1.id, unit_id: leadNow.unit_id, created_by_user_id: mgr.id });
  check("gate refusal (disabled) REVOKES with honest reason + retry flag (no stranded prepared)",
    disp1.dispatched === false && disp1.reason === "send_mode_disabled" && disp1.status === "revoked" && disp1.retry_requires_new_invitation === true, JSON.stringify(disp1));
  const invRow1 = (await pool.query(`select status, sent_at, revoked_reason from application_invitations where id=$1`, [disp1.invitation_id])).rows[0];
  check("refused invitation: revoked, NO sent state, reason recorded",
    invRow1.status === "revoked" && invRow1.sent_at === null && /send_mode_disabled/.test(invRow1.revoked_reason));
  check("no raw token stored anywhere",
    await count(`select count(*) as count from application_invitations where token_digest is null or length(token_digest) < 20`) === 0);

  // proof_only must refuse application_link (buddy boundary condition)
  process.env.SMS_SEND_MODE = "proof_only"; process.env.SMS_PROOF_CELL = "+17243098434";
  const disp2 = await dispatchSvc({ property_id: DEMO, person_id: p1.id, unit_id: leadNow.unit_id, created_by_user_id: mgr.id });
  check("proof_only REFUSES application_link (and revokes honestly)", disp2.dispatched === false && disp2.status === "revoked", disp2.reason);

  // customer_care + a consented person at this property → dispatch succeeds.
  // (Was internal_qa_autonomous + an enrolled QA person until 2026-07-26; that
  // mode is retired and the enrollment no longer affects sending.)
  process.env.SMS_SEND_MODE = "customer_care"; process.env.SMS_QA_PROPERTY_ID = DEMO;
  await commBoundary.enrollInternalQa({ person_id: p1.id, property_id: DEMO, reason: "night harness" });
  const wiresBefore = wireLog.length;
  const disp3 = await dispatchSvc({ property_id: DEMO, person_id: p1.id, unit_id: leadNow.unit_id, created_by_user_id: mgr.id });
  check("QA-enrolled dispatch SENDS through the gate", disp3.dispatched === true && wireLog.length === wiresBefore + 1, disp3.reason);
  check("the link left on the PROPERTY line with the public URL",
    wireLog[wireLog.length - 1].from === "+15550000010" && /propertyspine\.com\/apply\//.test(wireLog[wireLog.length - 1].body));
  const invRow3 = (await pool.query(`select status, dispatch_source, provider_message_id from application_invitations where id=$1`, [disp3.invitation_id])).rows[0];
  check("accepted transport → provider_dispatched attestation with sid",
    invRow3.status === "provider_dispatched" && invRow3.dispatch_source === "provider" && /^SM_NIGHT_/.test(invRow3.provider_message_id));
  check("application_link_sent event written (attested, not delivery)",
    await count(`select count(*) as count from events where type='application_link_sent'`) >= 1);
  // property wall at invitation
  const wall2 = await (async () => { try { return await dispatchSvc({ property_id: DEMO, person_id: p1.id, unit_id: soloUnit.id, created_by_user_id: mgr.id }); } catch (e) { return { httpErr: e.httpStatus, msg: e.publicMessage || e.message }; } })();
  check("PROPERTY WALL at invitation: Solo unit on Demo dispatch refused", wall2.httpErr === 403, JSON.stringify(wall2));

  // ═══ RULING CORRECTIONS: strand / retry / staleness proofs ═══
  console.log("── corrections: refused≠recoverable · retry-safe · offered-earlier≠available-now ──");
  // C1: refused dispatch REVOKES (no stranded 'prepared' that can never send)
  process.env.SMS_SEND_MODE = "disabled";
  const c1 = await dispatchSvc({ property_id: DEMO, person_id: p1.id, unit_id: leadNow.unit_id, created_by_user_id: mgr.id });
  const c1row = (await pool.query(`select status, revoked_reason, dispatch_comm_event_id from application_invitations where id=$1`, [c1.invitation_id])).rows[0];
  check("refused dispatch REVOKES the invitation (not stranded 'prepared')",
    c1.dispatched === false && c1.status === "revoked" && c1.retry_requires_new_invitation === true && c1row.status === "revoked" && /dispatch refused/.test(c1row.revoked_reason));
  const plainRes = await fetch(`http://127.0.0.1:${port}/leasing/application-invitations`, {
    method: "POST", headers: { "content-type": "application/json", "x-operator-key": "night-op-key" },
    body: JSON.stringify({ property_id: DEMO, person_id: p1.id }),
  });
  const plain = await plainRes.json();
  const plainRow = (await pool.query(`select status, dispatch_comm_event_id from application_invitations where id=$1`, [plain.invitation_id])).rows[0];
  check("plain create route still means genuinely-prepared (manual workflow intact: raw token to operator, no dispatch identity)",
    plainRes.status === 200 && plain.token && plainRow.status === "prepared" && plainRow.dispatch_comm_event_id === null, JSON.stringify(plain));

  // C2: crash between accepted transport and attestation → resume reconciles, NO second text
  process.env.SMS_SEND_MODE = "customer_care"; process.env.SMS_QA_PROPERTY_ID = DEMO;
  // simulate: phase 1+2 succeed (sid stamped on the event), phase 3 "crashes" —
  // we reproduce by dispatching normally, then FORCING the invitation back to
  // pre-attestation state while the event keeps its sid (exactly the crash residue).
  const c2 = await dispatchSvc({ property_id: DEMO, person_id: p1.id, unit_id: leadNow.unit_id, created_by_user_id: mgr.id });
  check("setup: a full dispatch succeeded", c2.dispatched === true, c2.reason);
  await pool.query(`update application_invitations set status='prepared', provider_message_id=null, sent_at=null where id=$1`, [c2.invitation_id]);
  const wiresBeforeResume = wireLog.length;
  const c2r = await dispatchSvc({ resume_invitation_id: c2.invitation_id, created_by_user_id: mgr.id });
  check("resume reconciles the accepted send with NO second wire attempt",
    c2r.dispatched === true && c2r.resumed === true && wireLog.length === wiresBeforeResume, JSON.stringify({ r: c2r.reason, wires: wireLog.length - wiresBeforeResume }));
  const c2row = (await pool.query(`select status, provider_message_id from application_invitations where id=$1`, [c2.invitation_id])).rows[0];
  check("reconciled invitation carries the ORIGINAL provider sid", c2row.status === "provider_dispatched" && c2row.provider_message_id === c2.provider_message_id);
  const c2i = await dispatchSvc({ resume_invitation_id: c2.invitation_id, created_by_user_id: mgr.id });
  check("resuming an attested invitation is an idempotent success (no send)", c2i.idempotent === true && wireLog.length === wiresBeforeResume);

  delete process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS; // review mode for C3/C4
  // C3: offered earlier ≠ still available now — the chosen unit went occupied
  const p5 = (await pool.query(`insert into persons (name, phone) values ('__NIGHT__Stale','+15551234005') returning id`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [p5.id, DEMO]);
  scriptQueue = [
    () => ({ id: "s1", content: [{ type: "tool_use", id: "tu_s", name: "find_available_units", input: { bedrooms: 3 } }] }),
    (req) => { const tr = JSON.parse(req.messages[req.messages.length-1].content[0].content); return { id: "s2", content: [{ type: "text", text: `Unit ${tr.units[0].unit_number} is a lovely 3-bed at $${tr.units[0].market_rent}.` }] }; },
  ];
  await agentInbound({ property_id: DEMO, person_id: p5.id, body: "any 3 beds?" });
  const d5 = (await pool.query(`select id from agent_drafts order by created_at desc limit 1`)).rows[0];
  await agent._service.sendDraftService({ draftId: d5.id, actorUserId: mgr.id });
  const offer5 = (await pool.query(`select offered_units_json from agent_runs where offered_units_json is not null order by created_at desc limit 1`)).rows[0].offered_units_json;
  const chosen = offer5[0];
  await pool.query(`update units set occupancy_status='occupied' where id=$1`, [chosen.id]); // it got taken
  let sysNoteSeen = false;
  scriptQueue = [ (req) => { sysNoteSeen = /NO LONGER AVAILABLE/.test(req.system); return { id: "s3", content: [{ type: "text", text: `So sorry — Unit ${chosen.unit_number} was just taken. Want me to check what else is open?` }] }; } ];
  await agentInbound({ property_id: DEMO, person_id: p5.id, body: `I want unit ${chosen.unit_number}` });
  const lead5 = (await pool.query(`select unit_id from leasing_leads where person_id=$1`, [p5.id])).rows[0];
  check("stale selection attaches NOTHING (offered earlier ≠ available now)", lead5.unit_id === null);
  check("the agent is TOLD honestly (system note: no longer available)", sysNoteSeen === true);
  await pool.query(`update units set occupancy_status='vacant' where id=$1`, [chosen.id]);

  // C4: bare "yes" after a NEWER outbound does not select from the older offer
  const p6 = (await pool.query(`insert into persons (name, phone) values ('__NIGHT__Fresh','+15551234006') returning id`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [p6.id, DEMO]);
  scriptQueue = [
    () => ({ id: "f1", content: [{ type: "tool_use", id: "tu_f", name: "find_available_units", input: { bedrooms: 1, max_rent: 1750 } }] }),
    (req) => { const tr = JSON.parse(req.messages[req.messages.length-1].content[0].content); return { id: "f2", content: [{ type: "text", text: `Unit ${tr.units[0].unit_number} could be great for you.` }] }; },
  ];
  await agentInbound({ property_id: DEMO, person_id: p6.id, body: "got a cheap 1 bed?" });
  const d6 = (await pool.query(`select id from agent_drafts order by created_at desc limit 1`)).rows[0];
  await agent._service.sendDraftService({ draftId: d6.id, actorUserId: mgr.id });
  // a NEWER outbound intervenes (human note in the thread)
  const conv6 = (await pool.query(`select conversation_id from agent_runs order by created_at desc limit 1`)).rows[0];
  await pool.query(`insert into comm_events (property_id, person_id, conversation_id, channel, direction, body) values ($1,$2,$3,'text','outbound','Quick note: our office closes at 5 today.')`, [DEMO, p6.id, conv6.conversation_id]);
  scriptQueue = [ () => ({ id: "f3", content: [{ type: "text", text: "Great — which unit did you mean?" }] }) ];
  await agentInbound({ property_id: DEMO, person_id: p6.id, body: "yes" });
  check("bare 'yes' after a newer outbound selects NOTHING (freshness)",
    (await pool.query(`select unit_id from leasing_leads where person_id=$1`, [p6.id])).rows[0].unit_id === null);

  // C5: the gate's already-sent guard stands alone too
  const evG = (await pool.query(`insert into comm_events (property_id, person_id, channel, direction, body, sms_sid) values ($1,$2,'text','outbound','sent already','SM_PRIOR_1') returning id`, [DEMO, p1.id])).rows[0];
  const wiresG = wireLog.length;
  const g = await commBoundary.sendPropertySms({ property_id: DEMO, recipient: "+15551234001", body: "sent already", purpose: "application_link", person_id: p1.id, eventId: evG.id });
  check("gate refuses to re-wire an event that already carries a sid (already_sent)", g.sent === true && g.reason === "already_sent" && wireLog.length === wiresG);

  // ═══ boundary harness still green (application_link addition didn't break it) ═══
  console.log("── comms boundary regression: quick invariants ──");
  process.env.SMS_SEND_MODE = "disabled";
  const reg = await commBoundary.sendPropertySms({ property_id: DEMO, recipient: "+15551234001", body: "x", purpose: "application_link", person_id: p1.id });
  check("application_link honors send-mode like every purpose", reg.sent === false && reg.reason === "send_mode_disabled");

  console.log(`\n═══ RESULT: ${pass} passed · ${fail} failed ═══`);
  console.log(`wire attempts: ${wireLog.length} · without from: ${wireLog.filter(w => !w.from).length}`);
  srv.close(); await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error("HARNESS CRASH:", e); process.exit(2); });
