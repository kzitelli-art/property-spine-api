#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  technician_route_proof.db.js — REAL HTTP + REAL PostgreSQL.
//
//  The whole Phase 2 turn, end to end, through the actual Express route:
//
//      POST /communications/inbound-sms   (Twilio form encoding)
//        → line resolved            (real communication_lines)
//        → staff sender resolved    (real users + assignments)
//        → work reference resolved  (real obligations + work_orders)
//        → canonical acceptance     (real transaction, real constraints)
//        → operating receipt        (composed from the committed row)
//        → reply-only outbound      (real trigger, real correlation key)
//        → transport attempted      (a double — nothing real leaves)
//        → delivery recorded separately
//
//  ── WHAT IS DOUBLED, AND WHAT IS NOT ────────────────────────────────
//  ONLY the outside world: the Twilio client and the signature check.
//  Every decision, every row and every constraint is real. The transport
//  double never imports the Twilio client and every sid it mints carries
//  an unmistakable harness prefix, asserted at the end.
//
//  ── SAFETY ──────────────────────────────────────────────────────────
//  HARNESS_DATABASE_URL only, no fallback, refuses if it matches
//  DATABASE_URL. Scratch database created and dropped. Every phone number
//  is in the reserved +1 (212) 555-01xx range, asserted over every row.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Client } = require("pg");
const receipt = require("../_run_receipt");

const HARNESS = __filename;
const EXPECTED = 77;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const ADMIN_URL = receipt.harnessConnectionString();
const SCRATCH_DB = `ps_tech_route_${process.pid}`;
const ROOT = path.join(__dirname, "..", "..");
const mig = (n) => fs.readFileSync(path.join(ROOT, "migrations", n), "utf8");
const { databaseSsl } = require(path.join(ROOT, "src/shared/database_ssl"));
const clientConfig = (connectionString) => ({
  connectionString,
  ssl: databaseSsl(connectionString),
});

//  THE SENTINEL. The inbound route acks the provider and swallows failures
//  by design, so a query that THROWS looks identical to a clean refusal
//  from outside. Slice A passed 57/57 with its most important assertion
//  green BECAUSE the query died. Everything the boundary logs is captured
//  and any schema error anywhere invalidates the entire run.
let sawFatalDbError = null;
const realError = console.error;
console.error = (...a) => {
  const m = a.map(String).join(" ");
  if (/does not exist|42P01|42703|syntax error|relation .* does not/i.test(m)) {
    sawFatalDbError = sawFatalDbError || m;
  }
  if (process.env.HARNESS_VERBOSE) realError(...a);
};

const SCOPED_SCHEMA = fs.readFileSync(path.join(__dirname, "_ops_scoped_schema.sql"), "utf8");

receipt.begin(HARNESS, { url: ADMIN_URL, expected: EXPECTED });

let admin = null, db = null, server = null, code = 1;
(async () => {
try {
  admin = new Client(clientConfig(ADMIN_URL));
  await admin.connect();
  await admin.query(`drop database if exists ${SCRATCH_DB}`);
  await admin.query(`create database ${SCRATCH_DB}`);
  const u = new URL(ADMIN_URL); u.pathname = "/" + SCRATCH_DB;
  db = new Client(clientConfig(u.toString()));
  await db.connect();
  console.log(`  SCRATCH   ${SCRATCH_DB}`);

  await db.query(SCOPED_SCHEMA);
  for (const n of ["130_communication_lines.sql", "131_work_acceptance.sql",
                   "132_outbound_line_policy.sql", "133_work_order_reference.sql"]) {
    await db.query(mig(n));
  }

  //  A single-connection pool shim. The route calls pool.connect() and
  //  pool.query(); both land on this one real client, so every write is a
  //  real write against a real schema.
  const shim = {
    query: (...a) => db.query(...a),
    connect: async () => ({ query: (...a) => db.query(...a), release: () => {} }),
  };

  // ── FIXTURES ───────────────────────────────────────────────────────
  const OPS_LINE = "+12125550120";
  const DANA_PHONE = "+12125550131";
  const SAM_PHONE = "+12125550132";
  const STRANGER = "+12125550199";

  const org = (await db.query(`insert into organizations (name,slug) values ('Harness Org','h') returning id`)).rows[0].id;
  const otherOrg = (await db.query(`insert into organizations (name,slug) values ('Other','o') returning id`)).rows[0].id;
  const maple = (await db.query(`insert into properties (name, organization_id) values ('Maple',$1) returning id`, [org])).rows[0].id;
  const oak = (await db.query(`insert into properties (name, organization_id) values ('Oak',$1) returning id`, [org])).rows[0].id;
  const dana = (await db.query(`insert into users (name,email,phone) values ('Dana','d@h.test',$1) returning id`, [DANA_PHONE])).rows[0].id;
  const sam = (await db.query(`insert into users (name,email,phone) values ('Sam','s@h.test',$1) returning id`, [SAM_PHONE])).rows[0].id;
  await db.query(
    `insert into property_team_assignments (property_id,user_id,allowed_modules)
     values ($1,$2,$3)`, [maple, dana, ["maintenance", "leasing"]]);
  await db.query(`insert into property_team_assignments (property_id,user_id) values ($1,$2)`, [oak, sam]);

  const opsLineId = (await db.query(
    `insert into communication_lines (e164, line_type, organization_id, authority_ceiling,
       permitted_audience, inbound_enabled, outbound_enabled, outbound_policy, status)
     values ($1,'operations',$2,'operational','staff',true,true,'reply_only','active') returning id`,
    [OPS_LINE, org])).rows[0].id;

  const mkWork = async (propertyId, userId, status = "open") => {
    const w = (await db.query(
      `insert into work_orders (property_id,title) values ($1,'Leak under sink') returning id, work_order_ref`,
      [propertyId])).rows[0];
    const ob = (await db.query(
      `insert into obligations (property_id, related_id, related_type, type, label, assigned_user_id, status)
       values ($1,$2,'work_order','maintenance_repair','Repair',$3,$4) returning id`,
      [propertyId, w.id, userId, status])).rows[0].id;
    return { wo: w.id, ref: Number(w.work_order_ref), ob };
  };

  // ── THE APP ────────────────────────────────────────────────────────
  const sent = [];
  const HARNESS_SID = "SM_HARNESS_NEVER_REAL_";
  let transportMode = "ok";           // ok | fail | throw
  const smsDouble = {
    enabled: () => true,
    validateWebhook: () => true,      // transport auth stubbed; domain logic real
    sendSms: async ({ to, from, body }) => {
      sent.push({ to, from, body });
      if (transportMode === "throw") throw new Error("carrier unreachable (deliberate)");
      if (transportMode === "fail") return { sent: false, reason: "undelivered" };
      return { sent: true, status: "queued", sid: `${HARNESS_SID}${sent.length}` };
    },
  };
  const commBoundary = require(path.join(ROOT, "src/comms/communications_boundary.js"))({ pool: shim, sms: smsDouble });
  const tenantLinkModule = require(path.join(ROOT, "src/comms/tenant_link.js"));
  const askCalls = [];
  const askSpineAnswer = {
    answer: async (readDb, model, options) => {
      const transaction = (await readDb.query(
        `select txid_current_if_assigned() as transaction_id`)).rows[0].transaction_id;
      askCalls.push({ readDb, model, options, transaction });
      if (/unavailable/i.test(options.question)) {
        throw new Error("governed reader unavailable (deliberate harness failure)");
      }
      return { outcome: "answered", answer: "The published rent is $850.", grounded_on: {} };
    },
  };
  const app = express();
  app.use("/", tenantLinkModule({
    pool: shim, anthropic: null, INGEST_MODEL: "harness",
    sms: smsDouble, commBoundary,
    workOrderService: { createWorkOrder: async () => { throw new Error("not used"); },
                        appendClarification: async () => { throw new Error("not used"); } },
    getAgentService: () => null,
    askSpineAnswer,
  }));
  server = app.listen(0);
  const port = server.address().port;

  let sidSeq = 0;
  const inboundSms = (from, body, sid = null) => new Promise((resolve, reject) => {
    const payload = new URLSearchParams({
      MessageSid: sid || `SM_IN_${++sidSeq}`, From: from, To: OPS_LINE, Body: body,
    }).toString();
    const req = http.request({ host: "127.0.0.1", port, path: "/communications/inbound-sms",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded",
                 "content-length": Buffer.byteLength(payload) } }, (res) => {
      let d = ""; res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject); req.write(payload); req.end();
  });
  //  The route acks the provider before finishing its work. Give the
  //  post-ack path a moment to complete, then assert against the database.
  const settle = () => new Promise((r) => setTimeout(r, 120));
  const counts = async () => {
    const t = (await db.query(`select table_name from information_schema.tables
                                where table_schema='public' order by table_name`)).rows.map((r) => r.table_name);
    const o = {};
    for (const x of t) o[x] = Number((await db.query(`select count(*)::int c from "${x}"`)).rows[0].c);
    return o;
  };

  // ════════════════════════════════════════════════════════════════════
  section("1. AUTHORIZED TECHNICIAN ACCEPTS ASSIGNED WORK");
  const a = await mkWork(maple, dana);
  const decoy = await mkWork(maple, dana);   // a SECOND open item, so a lucky
  {                                          // one-item fallback cannot pass for
                                             // an explicit reference. The first
                                             // cut of this section had only one
                                             // item and went green while
                                             // extractReference matched nothing.
    const r = await inboundSms(DANA_PHONE, `accept ${a.ref}`, "SM_ACCEPT_1");
    await settle();
    ok("the route acks the provider with empty TwiML", r.status === 200 && /<Response><\/Response>/.test(r.body), r.body);

    const ob = (await db.query(`select * from obligations where id=$1`, [a.ob])).rows[0];
    ok("the obligation is in_progress and owned by the technician",
      ob.status === "in_progress" && ob.accepted_by_user_id === dana && ob.assigned_user_id === dana);
    ok("...with a durable acceptance time", !!ob.accepted_at);
    ok("...keyed on the provider's own message id", ob.acceptance_key === "SM_ACCEPT_1");
    ok("...and the DECOY item beside it was not touched — the number they typed is what selected",
      (await db.query(`select accepted_at, status from obligations where id=$1`, [decoy.ob])).rows[0].accepted_at === null);

    const ev = (await db.query(`select note from events where type='work_accepted'`)).rows;
    ok("one immutable acceptance event", ev.length === 1 && JSON.parse(ev[0].note).work_order_id === a.wo);

    const out = (await db.query(
      `select * from comm_events where direction='outbound' and reply_reason='execution_receipt'`)).rows;
    ok("exactly one outbound reply intent", out.length === 1);
    //  RULING 2026-08-04 — the work is named the way the technician names it,
    //  not by its number. The number stays available as a fallback when there
    //  is no descriptive label, and as something they may type.
    ok("...naming the work descriptively, with no number and no uuid",
      /^Accepted\. The leak under sink is now yours and in progress\.$/.test(out[0].body)
      && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(out[0].body), out[0].body);
    ok("...bound to the inbound message it answers", !!out[0].in_reply_to_comm_event_id);
    ok("...bound to the staff thread, the recipient, and a correlation key",
      !!out[0].staff_thread_id && out[0].to_user_id === dana && !!out[0].correlation_key);
    ok("...and NOT to any resident", out[0].person_id === null && out[0].conversation_id === null);
    ok("...sent from the operations line", sent.length === 1 && sent[0].from === OPS_LINE && sent[0].to === DANA_PHONE);
    ok("...and delivery is recorded on the intent",
      out[0].sms_status === "queued" && String(out[0].sms_sid).startsWith(HARNESS_SID));

    const inb = (await db.query(`select * from comm_events where direction='inbound' and sms_sid='SM_ACCEPT_1'`)).rows[0];
    ok("the inbound is recorded on the staff thread and cleared of the human flag",
      !!inb && inb.staff_thread_id === out[0].staff_thread_id && inb.needs_human === false);
    ok("the staff thread belongs to this technician in this organization",
      (await db.query(`select * from staff_threads where id=$1`, [inb.staff_thread_id])).rows[0].user_id === dana);
  }

  // ════════════════════════════════════════════════════════════════════
  section("2. REPLAY DOES NOT DUPLICATE ACCEPTANCE OR THE REPLY");
  {
    const before = await counts();
    await inboundSms(DANA_PHONE, `accept ${a.ref}`, "SM_ACCEPT_1");
    await settle();
    const after = await counts();
    ok("a redelivered message writes NOTHING — not a row anywhere",
      JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    ok("...and puts nothing further on the wire", sent.length === 1);
  }

  // ════════════════════════════════════════════════════════════════════
  section("3. UNAUTHORIZED TECHNICIAN CHANGES NOTHING");
  {
    const before = await counts();
    const r = await inboundSms(STRANGER, `accept ${a.ref}`, "SM_STRANGER");
    await settle();
    ok("an unresolvable sender is acked", r.status === 200);
    ok("...and ZERO rows are written anywhere",
      JSON.stringify(before) === JSON.stringify(await counts()));
    ok("...and the operations number replies to nobody", sent.length === 1);
  }

  // ==================================================================
  section("3B. A CLEAR READ QUESTION USES ASK SPINE");
  {
    const workBefore = (await db.query(`select count(*)::int c from work_orders`)).rows[0].c;
    const r = await inboundSms(DANA_PHONE, "What pricing is published?", "SM_GOVERNED_READ");
    await settle();
    ok("the read question is acknowledged through the real webhook", r.status === 200);
    ok("the Ask Spine answer service is called exactly once", askCalls.length === 1);
    ok("the receiving line does not choose the property - Dana's assignment does",
      askCalls[0] && askCalls[0].options.property_id === maple);
    ok("module entitlement comes from that same active assignment",
      askCalls[0] && askCalls[0].options.allowed_modules.join(",") === "maintenance,leasing",
      askCalls[0] && askCalls[0].options.allowed_modules.join(","));
    ok("the exact staff question reaches the governed reader",
      askCalls[0] && askCalls[0].options.question === "What pricing is published?");
    ok("the governed read and model run with no database transaction held open",
      askCalls[0] && askCalls[0].transaction === null,
      askCalls[0] && askCalls[0].transaction);

    const inbound = (await db.query(
      `select * from comm_events where direction='inbound' and sms_sid='SM_GOVERNED_READ'`)).rows[0];
    const outbound = (await db.query(
      `select * from comm_events where in_reply_to_comm_event_id=$1`, [inbound.id])).rows[0];
    ok("the inbound is durable and cleared only after the answer is durable",
      inbound.needs_human === false && inbound.classification === "governed_read_answered");
    ok("the answer is reply-bound on the existing staff thread",
      outbound && outbound.staff_thread_id === inbound.staff_thread_id
      && outbound.reply_reason === "governed_read");
    ok("the governed answer is the text sent back to the staff member",
      outbound && outbound.body === "The published rent is $850."
      && sent[sent.length - 1].body === outbound.body);
    console.log(`\n  STAFF  What pricing is published?`);
    console.log(`  SPINE  ${outbound && outbound.body}`);
    ok("a read question creates no work order",
      (await db.query(`select count(*)::int c from work_orders`)).rows[0].c === workBefore);

    const beforeReplay = await counts();
    const sendsBeforeReplay = sent.length;
    await inboundSms(DANA_PHONE, "What pricing is published?", "SM_GOVERNED_READ");
    await settle();
    ok("a provider replay does not call Ask Spine twice", askCalls.length === 1);
    ok("a provider replay writes no second row", JSON.stringify(await counts()) === JSON.stringify(beforeReplay));
    ok("a provider replay sends no second answer", sent.length === sendsBeforeReplay);
  }

  // ==================================================================
  section("3C. MULTI-PROPERTY READS ASK, NEVER GUESS");
  {
    await db.query(
      `insert into property_team_assignments (property_id,user_id,allowed_modules)
       values ($1,$2,$3)`, [maple, sam, ["leasing"]]);
    const r = await inboundSms(SAM_PHONE, "What pricing is published?", "SM_READ_MANY");
    await settle();
    ok("the ambiguous read is acknowledged", r.status === 200);
    ok("property ambiguity reaches no governed reader", askCalls.length === 1);
    const inbound = (await db.query(
      `select * from comm_events where direction='inbound' and sms_sid='SM_READ_MANY'`)).rows[0];
    const outbound = (await db.query(
      `select * from comm_events where in_reply_to_comm_event_id=$1`, [inbound.id])).rows[0];
    ok("the reply is a clarification, not a governed answer",
      outbound && outbound.reply_reason === "clarification");
    ok("the clarification names only Sam's two assigned properties",
      outbound && /Which property is this about/.test(outbound.body)
      && /Maple/.test(outbound.body) && /Oak/.test(outbound.body),
      outbound && outbound.body);
    ok("the ambiguity is recorded as its own outcome",
      inbound.classification === "governed_read_property_context_ambiguous");
    console.log(`\n  STAFF  What pricing is published?`);
    console.log(`  SPINE  ${outbound && outbound.body}`);

    const named = await inboundSms(
      SAM_PHONE, "What pricing is published at Maple?", "SM_READ_NAMED_PROPERTY");
    await settle();
    ok("resending the question with an assigned property is acknowledged", named.status === 200);
    ok("the named-property question reaches Ask Spine once", askCalls.length === 2);
    ok("the property name resolves Maple from Sam's assignments",
      askCalls[1] && askCalls[1].options.property_id === maple);
    ok("the named assignment supplies its own module entitlement",
      askCalls[1] && askCalls[1].options.allowed_modules.join(",") === "leasing");
    const namedInbound = (await db.query(
      `select * from comm_events where direction='inbound' and sms_sid='SM_READ_NAMED_PROPERTY'`)).rows[0];
    const namedOutbound = (await db.query(
      `select * from comm_events where in_reply_to_comm_event_id=$1`, [namedInbound.id])).rows[0];
    ok("the resolved question receives a governed answer",
      namedOutbound && namedOutbound.reply_reason === "governed_read");
    console.log(`  STAFF  What pricing is published at Maple?`);
    console.log(`  SPINE  ${namedOutbound && namedOutbound.body}`);
  }

  // ==================================================================
  section("3D. A FAILED READ PRESERVES THE INBOUND");
  {
    const sendsBefore = sent.length;
    const r = await inboundSms(
      DANA_PHONE, "What pricing is unavailable?", "SM_READ_FAILURE");
    await settle();
    ok("the provider is still acknowledged when the governed reader fails", r.status === 200);
    ok("the failing reader was called outside a transaction",
      askCalls.length === 3 && askCalls[2].transaction === null);
    const inbound = (await db.query(
      `select * from comm_events where direction='inbound' and sms_sid='SM_READ_FAILURE'`)).rows[0];
    ok("the inbound remains durable and visibly needs a human",
      inbound && inbound.needs_human === true && inbound.classification === null);
    ok("no answer intent is fabricated for a failed read",
      (await db.query(`select count(*)::int c from comm_events
                        where in_reply_to_comm_event_id=$1`, [inbound.id])).rows[0].c === 0);
    ok("nothing is sent after the read failure", sent.length === sendsBefore);
    await inboundSms(DANA_PHONE, "What pricing is unavailable?", "SM_READ_FAILURE");
    await settle();
    ok("a provider replay neither duplicates nor hides the preserved failure",
      askCalls.length === 3
      && (await db.query(`select count(*)::int c from comm_events
                           where sms_sid='SM_READ_FAILURE'`)).rows[0].c === 1);
  }

  // ════════════════════════════════════════════════════════════════════
  section("4. CROSS-PROPERTY: WORK AT A BUILDING THEY DO NOT WORK AT");
  const cross = await mkWork(oak, dana);        // assigned to Dana on paper; Dana is not on Oak
  {
    await inboundSms(DANA_PHONE, `accept ${cross.ref}`, "SM_CROSS");
    await settle();
    const ob = (await db.query(`select * from obligations where id=$1`, [cross.ob])).rows[0];
    ok("the obligation is untouched — assignment on the row is not scope",
      ob.status === "open" && ob.accepted_by_user_id === null);
    const out = (await db.query(
      `select * from comm_events where direction='outbound' and correlation_key like 'SM_CROSS%'`)).rows;
    ok("the technician is answered, honestly", out.length === 1);
    ok("...and the answer names no work order they cannot see",
      !out[0].body.includes(String(cross.ref)), out[0].body);
  }

  // ════════════════════════════════════════════════════════════════════
  section("5. THE THREE GOVERNED REFERENCE SOURCES");
  const b1 = await mkWork(maple, dana);
  const b2 = await mkWork(maple, dana);
  {
    //  THREAD. Exactly one work order is active in this thread (a, accepted
    //  in section 1), so a bare "accept" resolves to it — the second source
    //  the ruling names. It is already hers, so the honest answer is that
    //  she already has it, and NOTHING is written.
    const acceptedBefore = (await db.query(`select count(*)::int c from obligations where accepted_at is not null`)).rows[0].c;
    await inboundSms(DANA_PHONE, "accept", "SM_THREAD");
    await settle();
    const out = (await db.query(`select * from comm_events where correlation_key like 'SM_THREAD%'`)).rows;
    ok("a bare request resolves through the THREAD when exactly one work is active there",
      out.length === 1 && out[0].reply_reason === "execution_receipt", out.length && out[0].reply_reason);
    ok("...and says she already has it rather than accepting it twice",
      out.length === 1 && /already have the /.test(out[0].body), out.length && out[0].body);
    ok("...writing no second acceptance",
      (await db.query(`select count(*)::int c from obligations where accepted_at is not null`)).rows[0].c === acceptedBefore);

    //  EXPLICIT beats the thread: naming b1 selects b1, not the thread item.
    await inboundSms(DANA_PHONE, `accept ${b1.ref}`, "SM_EXPLICIT_B1");
    await settle();
    ok("an explicit reference outranks the thread",
      (await db.query(`select accepted_by_user_id from obligations where id=$1`, [b1.ob])).rows[0].accepted_by_user_id === dana);

    //  AMBIGUOUS: now TWO work orders are active in the thread and several
    //  are assigned. A bare request has no correct answer, so it asks.
    await inboundSms(DANA_PHONE, "accept", "SM_AMBIG");
    await settle();
    const amb = (await db.query(`select * from comm_events where correlation_key like 'SM_AMBIG%'`)).rows;
    ok("two active items in the thread → a clarification, never a pick",
      amb.length === 1 && amb[0].reply_reason === "clarification", amb.length && amb[0].reply_reason);
    ok("...and b2 was not quietly accepted",
      (await db.query(`select accepted_at from obligations where id=$1`, [b2.ob])).rows[0].accepted_at === null);

    //  UNRESOLVED CLAIM: a number that matches nothing they are authorized for.
    await inboundSms(DANA_PHONE, "accept 999999", "SM_NOTMINE");
    await settle();
    const nm = (await db.query(`select * from comm_events where correlation_key like 'SM_NOTMINE%'`)).rows;
    ok("naming work that is not theirs asks rather than acting",
      nm.length === 1 && nm[0].reply_reason === "clarification", nm.length && nm[0].reply_reason);
    ok("...and never falls back to the thread or the assignment source",
      (await db.query(`select accepted_at from obligations where id=$1`, [b2.ob])).rows[0].accepted_at === null);
  }

  // ════════════════════════════════════════════════════════════════════
  section("6. A MESSAGE THAT ASKS FOR NOTHING GETS NO ACTION");
  {
    const acceptedBefore = (await db.query(`select count(*)::int c from obligations where accepted_at is not null`)).rows[0].c;
    await inboundSms(DANA_PHONE, `what is happening with ${b1.ref}`, "SM_NOVERB");
    await settle();
    ok("a message with a reference but no verb accepts nothing",
      (await db.query(`select count(*)::int c from obligations where accepted_at is not null`)).rows[0].c === acceptedBefore);
    const out = (await db.query(`select * from comm_events where correlation_key like 'SM_NOVERB%'`)).rows;
    ok("...and is answered with a clarification", out.length === 1 && out[0].reply_reason === "clarification");
  }

  // ════════════════════════════════════════════════════════════════════
  section("7. STALE WORK STATE IS REFUSED");
  {
    const taken = await mkWork(maple, dana);
    await db.query(`update obligations set status='complete' where id=$1`, [taken.ob]);
    await inboundSms(DANA_PHONE, `accept ${taken.ref}`, "SM_STALE");
    await settle();
    const ob = (await db.query(`select * from obligations where id=$1`, [taken.ob])).rows[0];
    ok("completed work cannot be accepted", ob.accepted_at === null && ob.status === "complete");

    //  Someone else's, at her own property.
    const theirs = await mkWork(maple, sam);
    await inboundSms(DANA_PHONE, `accept ${theirs.ref}`, "SM_THEIRS");
    await settle();
    ok("work assigned to another technician is untouched",
      (await db.query(`select accepted_at from obligations where id=$1`, [theirs.ob])).rows[0].accepted_at === null);
  }

  // ════════════════════════════════════════════════════════════════════
  section("8. ACCEPTANCE COMMITS EVEN WHEN THE REPLY NEVER ARRIVES");
  {
    const c1 = await mkWork(maple, dana);
    transportMode = "fail";
    await inboundSms(DANA_PHONE, `accept ${c1.ref}`, "SM_FAILSEND");
    await settle();
    const ob = (await db.query(`select * from obligations where id=$1`, [c1.ob])).rows[0];
    ok("THE ACCEPTANCE STANDS — a failed send does not roll back committed work",
      ob.status === "in_progress" && ob.accepted_by_user_id === dana);
    const out = (await db.query(`select * from comm_events where correlation_key like 'SM_FAILSEND%'`)).rows[0];
    ok("...the reply intent is persisted and marked failed",
      out.sms_status === "failed" && out.sms_sid === null);
    const inb = (await db.query(`select needs_human from comm_events where sms_sid='SM_FAILSEND'`)).rows[0];
    ok("...and the undelivered reply is flagged for a human on the INBOUND row",
      inb.needs_human === true);

    const c2 = await mkWork(maple, dana);
    transportMode = "throw";
    await inboundSms(DANA_PHONE, `accept ${c2.ref}`, "SM_THROWSEND");
    await settle();
    ok("a THROWING transport is a failed delivery like any other — acceptance still stands",
      (await db.query(`select status from obligations where id=$1`, [c2.ob])).rows[0].status === "in_progress");
    ok("...and is flagged, not silently swallowed",
      (await db.query(`select needs_human from comm_events where sms_sid='SM_THROWSEND'`)).rows[0].needs_human === true);
    transportMode = "ok";
  }

  // ════════════════════════════════════════════════════════════════════
  section("9. THE OPERATIONS LINE CANNOT BECOME A BROADCAST CHANNEL");
  {
    const m = await (async () => {
      try {
        await db.query(
          `insert into comm_events (channel, direction, body, communication_line_id, to_user_id, reply_reason, correlation_key)
           values ('sms','outbound','New work assigned to you',$1,$2,'execution_receipt','PROACTIVE_1')`,
          [opsLineId, dana]);
        return null;
      } catch (e) { return String(e.message); }
    })();
    ok("a PROACTIVE push from the operations number is refused at the database",
      !!m && m.includes("answers nothing"), m);
    ok("...and the line cannot be reconfigured to allow one", await (async () => {
      try { await db.query(`update communication_lines set outbound_policy='proactive' where id=$1`, [opsLineId]); return false; }
      catch (e) { return String(e.message).includes("ck_cl_outbound_policy_by_type"); }
    })());
  }

  // ════════════════════════════════════════════════════════════════════
  section("10. SAFETY");
  {
    ok("every send used the reserved +1 (212) 555-01xx range",
      sent.every((s) => /^\+121255501\d\d$/.test(s.to) && /^\+121255501\d\d$/.test(s.from)),
      JSON.stringify(sent.map((s) => s.to)));
    ok("every provider id is harness-minted",
      (await db.query(`select sms_sid from comm_events where sms_sid is not null`)).rows
        .every((r) => r.sms_sid.startsWith(HARNESS_SID) || r.sms_sid.startsWith("SM_")));
    ok("no resident was written to at all",
      (await db.query(`select count(*)::int c from comm_events where person_id is not null`)).rows[0].c === 0);
    ok("no conversation row was created", (await db.query(`select count(*)::int c from conversations`)).rows[0].c === 0);
    ok("every outbound on the operations line is reply-bound",
      (await db.query(`select count(*)::int c from comm_events
                        where direction='outbound' and communication_line_id is not null
                          and (in_reply_to_comm_event_id is null or correlation_key is null
                               or to_user_id is null or staff_thread_id is null)`)).rows[0].c === 0);
  }

  section("11. RUN VALIDITY");
  ok("no swallowed database error anywhere in the run — absence of red is not green",
    sawFatalDbError === null, sawFatalDbError || "");

  console.error = realError;
  code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
} catch (e) {
  console.error = realError;
  code = receipt.died(HARNESS, e, passed + failed);
} finally {
  try { if (server) server.close(); } catch { /* closing is not a proof step */ }
  try { if (db) await db.end(); } catch { /* ditto */ }
  try { if (admin) { await admin.query(`drop database if exists ${SCRATCH_DB}`); await admin.end(); } }
  catch (e) { realError("  scratch cleanup failed:", e.message); }
}
process.exit(code);
})();
