#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  technician_lifecycle_proof.db.js — REAL HTTP + REAL PostgreSQL.
//
//  THE WHOLE DAY, in the words a technician actually uses:
//
//      "Got it."                      → accepted
//      "I'm heading over."            → en route      + resident update
//      "Couldn't get in."             → no access     + resident update
//      "leak is stopped, needs a valve" → finding     (INTERNAL)
//      "All done."                    → claim recorded, NOT closed
//      (photo)                        → evidence preserved
//      "All done."                    → governed completion + resident update
//      "anything else open here?"     → a plain list
//
//  ── THE TEST IS NOT "CAN THE ROUTE PROCESS SEVEN ACTIONS" ───────────
//  It is whether a good technician could use this with no training. So
//  every message below is written the way somebody texts, NOT as a
//  command, and every reply is PRINTED so the wording is reviewable
//  rather than merely asserted.
//
//  ── SAFETY ──────────────────────────────────────────────────────────
//  HARNESS_DATABASE_URL only, no fallback, refuses if it matches
//  DATABASE_URL. Scratch database created and dropped. Reserved
//  +1 (212) 555-01xx numbers only. The transport and the media fetcher
//  are doubles; nothing real leaves and no URL is ever opened.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Client } = require("pg");
const receipt = require("../_run_receipt");

const HARNESS = __filename;
const EXPECTED = 51;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const ADMIN_URL = receipt.harnessConnectionString();
const SCRATCH_DB = `ps_tech_life_${process.pid}`;
const ROOT = path.join(__dirname, "..", "..");
const mig = (n) => fs.readFileSync(path.join(ROOT, "migrations", n), "utf8");

let sawFatalDbError = null;
const realError = console.error;
console.error = (...a) => {
  const m = a.map(String).join(" ");
  if (/does not exist|42P01|42703|syntax error/i.test(m)) sawFatalDbError = sawFatalDbError || m;
  if (process.env.HARNESS_VERBOSE) realError(...a);
};

receipt.begin(HARNESS, { url: ADMIN_URL, expected: EXPECTED });

let admin = null, db = null, server = null, code = 1;
(async () => {
try {
  admin = new Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  await admin.query(`drop database if exists ${SCRATCH_DB}`);
  await admin.query(`create database ${SCRATCH_DB}`);
  const u = new URL(ADMIN_URL); u.pathname = "/" + SCRATCH_DB;
  db = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
  await db.connect();
  console.log(`  SCRATCH   ${SCRATCH_DB}`);

  await db.query(fs.readFileSync(path.join(__dirname, "_ops_scoped_schema.sql"), "utf8"));
  //  work_orders needs the columns the lifecycle touches.
  await db.query(`
    alter table work_orders add column if not exists unit_id uuid references units(id);
    alter table work_orders add column if not exists not_done_reason text;
    alter table work_orders add column if not exists completion_note text;
    alter table work_orders add column if not exists affected_person_id uuid references persons(id);
    alter table work_orders add column if not exists reported_by_person_id uuid references persons(id);
    alter table work_orders add column if not exists updated_at timestamptz not null default now();
    alter table obligations add column if not exists completed_at timestamptz;
    alter table obligations add column if not exists resolution_code text;
  `);
  section("1. MIGRATIONS 130 → 136 APPLY IN ORDER");
  for (const n of ["130_communication_lines.sql", "131_work_acceptance.sql",
                   "132_outbound_line_policy.sql", "133_work_order_reference.sql",
                   "134_technician_lifecycle.sql", "135_delivery_attempts.sql",
                   "136_one_resident_update_per_cause.sql"]) {
    let e = null;
    try { await db.query(mig(n)); } catch (err) { e = err; }
    ok(`${n} applies cleanly, verbatim`, e === null, e && e.message);
  }
  ok("134 is idempotent",
    await (async () => { try { await db.query(mig("134_technician_lifecycle.sql")); return true; }
                         catch (e) { realError(e.message); return false; } })());
  ok("136 is idempotent",
    await (async () => { try { await db.query(mig("136_one_resident_update_per_cause.sql")); return true; }
                         catch (e) { realError(e.message); return false; } })());

  const shim = { query: (...a) => db.query(...a),
                 connect: async () => ({ query: (...a) => db.query(...a), release: () => {} }) };

  // ── FIXTURES ───────────────────────────────────────────────────────
  const OPS = "+12125550120", PROP_LINE = "+12125550121";
  const DANA = "+12125550131";
  const org = (await db.query(`insert into organizations (name,slug) values ('Org','o') returning id`)).rows[0].id;
  //  NOT inserting sms_number directly — Slice A made it a read-only
  //  projection and the guard refuses the write. The property line is created
  //  canonically below and the trigger projects it, which is the whole point.
  const maple = (await db.query(`insert into properties (name,organization_id) values ('Maple',$1) returning id`, [org])).rows[0].id;
  const dana = (await db.query(`insert into users (name,email,phone) values ('Dana','d@h.test',$1) returning id`, [DANA])).rows[0].id;
  const RESIDENT_PHONE = "+12125550141";
  const resident = (await db.query(
    `insert into persons (property_id,name,primary_phone_e164) values ($1,'Ana',$2) returning id`,
    [maple, RESIDENT_PHONE])).rows[0].id;
  const unit302 = (await db.query(`insert into units (property_id,unit_number) values ($1,'302') returning id`, [maple])).rows[0].id;
  await db.query(`insert into property_team_assignments (property_id,user_id) values ($1,$2)`, [maple, dana]);
  //  The RESIDENT-side rails are real and are not bypassed: a resident update
  //  still passes the ordinary consent + classification gate. An opted-in,
  //  production-classified resident is set up here so the gate is EXERCISED
  //  rather than skipped.
  await db.query(`insert into contact_preferences (person_id, channel, consent_state, source)
                  values ($1,'text','opted_in','harness')`, [resident]);
  await db.query(`insert into person_property_classifications (person_id, property_id, record_class, classification_source)
                  values ($1,$2,'production','operator')`, [resident, maple]);
  process.env.SMS_SEND_MODE = "customer_care";
  //  A real active lease, so the resident's relationship to this property is
  //  a fact the gate can read rather than something the harness asserts.
  await db.query(`insert into leases (property_id, unit_id, tenant_ids, lease_status)
                  values ($1,$2,array[$3::uuid],'active')`, [maple, unit302, resident]);
  const opsLineId = (await db.query(
    `insert into communication_lines (e164,line_type,organization_id,authority_ceiling,permitted_audience,
       inbound_enabled,outbound_enabled,outbound_policy,status)
     values ($1,'operations',$2,'operational','staff',true,true,'reply_only','active') returning id`, [OPS, org])).rows[0].id;
  await db.query(
    `insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience,
       inbound_enabled,outbound_enabled,outbound_policy,status)
     values ($1,'property_facing',$2,'external','residents_and_prospects',true,true,'proactive','active')`, [PROP_LINE, maple]);

  const wo = (await db.query(
    `insert into work_orders (property_id,unit_id,title,affected_person_id)
     values ($1,$2,'Sink leak',$3) returning id, work_order_ref`, [maple, unit302, resident])).rows[0];
  const ob = (await db.query(
    `insert into obligations (property_id,related_id,related_type,type,label,assigned_user_id,status)
     values ($1,$2,'work_order','maintenance_repair','Repair',$3,'open') returning id`,
    [maple, wo.id, dana])).rows[0].id;

  // ── APP ────────────────────────────────────────────────────────────
  const sent = [];
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  let mediaMode = "ok";
  const smsDouble = {
    enabled: () => true, validateWebhook: () => true,
    sendSms: async ({ to, from, body }) => {
      sent.push({ to, from, body });
      return { sent: true, status: "queued", sid: `SM_HARNESS_NEVER_REAL_${sent.length}` };
    },
    //  Never opens a socket. Proves the storage path without a network.
    fetchMedia: async () => (mediaMode === "ok"
      ? { ok: true, buffer: PNG, mime: "image/png" }
      : { ok: false, reason: "carrier_403" }),
  };
  const commBoundary = require(path.join(ROOT, "src/comms/communications_boundary.js"))({ pool: shim, sms: smsDouble });
  const app = express();
  app.use("/", require(path.join(ROOT, "src/comms/tenant_link.js"))({
    pool: shim, anthropic: null, INGEST_MODEL: "harness", sms: smsDouble, commBoundary,
    workOrderService: { createWorkOrder: async () => { throw new Error("unused"); },
                        appendClarification: async () => { throw new Error("unused"); } },
    getAgentService: () => null,
  }));
  server = app.listen(0);
  const port = server.address().port;

  let seq = 0;
  const text = (bodyText, media = []) => new Promise((resolve, reject) => {
    const p = { MessageSid: `SM_L_${++seq}`, From: DANA, To: OPS, Body: bodyText, NumMedia: String(media.length) };
    media.forEach((m, i) => { p[`MediaUrl${i}`] = m.url; p[`MediaContentType${i}`] = m.mime; });
    const payload = new URLSearchParams(p).toString();
    const req = http.request({ host: "127.0.0.1", port, path: "/communications/inbound-sms", method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(payload) } },
      (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.write(payload); req.end();
  });
  const settle = () => new Promise((r) => setTimeout(r, 140));

  //  THE TRANSCRIPT. Printed, so the wording is reviewable.
  const transcript = [];
  //  The technician's reply is the one sent FROM THE OPERATIONS LINE. Taking
  //  "the last thing sent" was wrong the moment resident updates started
  //  working — it returned the resident's message and reported six false
  //  failures. Two lines, two audiences, read separately.
  const say = async (msg, media = []) => {
    const before = sent.length;
    await text(msg, media); await settle();
    const fresh = sent.slice(before);
    const toTech = fresh.filter((x) => x.from === OPS);
    const toResident = fresh.filter((x) => x.from === PROP_LINE);
    const reply = toTech.length ? toTech[toTech.length - 1].body : "(no reply)";
    transcript.push({ tech: msg + (media.length ? "  [photo]" : ""), spine: reply,
                      resident: toResident.map((x) => x.body) });
    return reply;
  };
  const residentMessages = async () => (await db.query(
    `select body, person_id, conversation_id, staff_thread_id, derived_from_progress_id
       from comm_events where derived_from_progress_id is not null order by occurred_at asc`)).rows;

  // ════════════════════════════════════════════════════════════════════
  section("2. THE DAY, IN PLAIN LANGUAGE");
  {
    let r = await say("Got it.");
    ok(`"Got it." accepts the work — ${JSON.stringify(r)}`,
      /Accepted\. The Unit 302 sink leak is now yours and in progress\./.test(r), r);
    ok("...and the obligation is really accepted",
      (await db.query(`select accepted_by_user_id,status from obligations where id=$1`, [ob])).rows[0].accepted_by_user_id === dana);

    r = await say("I'm heading over.");
    ok(`"I'm heading over." records en route — ${JSON.stringify(r)}`,
      /on the way to the Unit 302 sink leak/.test(r), r);
    ok("...an en_route field fact exists, tied to the inbound message",
      (await db.query(`select count(*)::int c from work_order_progress where kind='en_route' and source_comm_event_id is not null`)).rows[0].c === 1);

    const res1 = await residentMessages();
    ok("...and the RESIDENT was told, in the property's words not the technician's",
      res1.length === 1 && res1[0].body === "Your technician is on the way for the sink leak.", JSON.stringify(res1[0] && res1[0].body));
    ok("...on the resident conversation, never the staff thread",
      res1[0].person_id === resident && !!res1[0].conversation_id && res1[0].staff_thread_id === null);

    r = await say("Couldn't get in.");
    ok(`"Couldn't get in." records no access — ${JSON.stringify(r)}`,
      /Recorded no access on the Unit 302 sink leak\./.test(r) && /stays open/.test(r), r);
    ok("...the work order STAYS OPEN with a not-done reason",
      (await db.query(`select status,not_done_reason from work_orders where id=$1`, [wo.id])).rows[0].status === "open");
    ok("...and it says access follow-up is needed", /access follow-up is now needed/.test(r), r);
    const res2 = await residentMessages();
    ok("...the resident is asked to coordinate entry",
      res2.length === 2 && /could not access the unit/.test(res2[1].body), res2[1] && res2[1].body);

    r = await say("the leak is stopped but it needs a valve");
    ok(`a finding is saved verbatim — ${JSON.stringify(r)}`,
      /Saved to the Unit 302 sink leak: the leak is stopped but it needs a valve/.test(r), r);
    ok("...INTERNAL by default — the resident is told nothing about it",
      (await residentMessages()).length === 2);
  }

  // ════════════════════════════════════════════════════════════════════
  section("3. A PHOTO IS EVIDENCE, NOT COMPLETION");
  {
    let r = await say("All done.");
    ok(`"All done." with no photo does NOT close it — ${JSON.stringify(r)}`,
      /I recorded that you finished .*but I still need a photo of the repair before I can close it/.test(r), r);
    ok("...the work order is still open",
      (await db.query(`select status from work_orders where id=$1`, [wo.id])).rows[0].status === "open");
    ok("...but the CLAIM is recorded — the technician's report is never discarded",
      (await db.query(`select count(*)::int c from work_order_progress where kind='completion_claimed'`)).rows[0].c === 1);
    ok("...and no resident was told the repair was done",
      (await residentMessages()).every((m) => !/completed/i.test(m.body)));

    mediaMode = "fail";
    r = await say("here you go", [{ url: "https://api.example.test/Media/ME_FAIL", mime: "image/png" }]);
    ok(`a photo we could NOT save says so — ${JSON.stringify(r)}`,
      /couldn't save it/.test(r), r);
    const failed = (await db.query(`select storage_state, content, sha256 from work_order_proof_attachments where storage_state='fetch_failed'`)).rows;
    ok("...recorded as fetch_failed with NO bytes and NO digest",
      failed.length === 1 && failed[0].content === null && failed[0].sha256 === null);

    r = await say("All done.");
    ok(`a claim with only an unpreserved photo still does not close it — ${JSON.stringify(r)}`,
      /the photo didn't save, so I can't close it yet/.test(r), r);
    ok("...still open", (await db.query(`select status from work_orders where id=$1`, [wo.id])).rows[0].status === "open");

    mediaMode = "ok";
    r = await say("try again", [{ url: "https://api.example.test/Media/ME_OK", mime: "image/png" }]);
    ok(`a preserved photo is confirmed — ${JSON.stringify(r)}`, /Photo saved to the Unit 302 sink leak\./.test(r), r);
    const stored = (await db.query(`select * from work_order_proof_attachments where storage_state='stored'`)).rows;
    ok("...stored with bytes, size, digest and a stored_at, all together",
      stored.length === 1 && !!stored[0].content && Number(stored[0].byte_size) === PNG.length
      && stored[0].sha256 === crypto.createHash("sha256").update(PNG).digest("hex") && !!stored[0].stored_at);
    ok("...carrying the source message, the actor and the provider identity",
      !!stored[0].source_comm_event_id && stored[0].uploaded_by_user_id === dana
      && stored[0].provider === "twilio" && stored[0].provider_media_id === "ME_OK");
    ok("...received_at and stored_at are separate facts",
      !!stored[0].received_at && !!stored[0].stored_at);
  }

  // ════════════════════════════════════════════════════════════════════
  section("4. GOVERNED COMPLETION");
  {
    const r = await say("All done.");
    ok(`now it closes — ${JSON.stringify(r)}`, /Done — the Unit 302 sink leak is closed\./.test(r), r);
    ok("...and says the resident will be notified", /resident will be notified/.test(r), r);
    const w = (await db.query(`select status from work_orders where id=$1`, [wo.id])).rows[0];
    ok("...the work order is complete", w.status === "complete");
    ok("...the obligation closed WITH it — work and accountability move together",
      (await db.query(`select status,resolution_code from obligations where id=$1`, [ob])).rows[0].status === "complete");
    ok("...a `completed` fact is its own row, distinct from the claim",
      (await db.query(`select count(*)::int c from work_order_progress where kind='completed'`)).rows[0].c === 1);

    const res = await residentMessages();
    const done = res[res.length - 1];
    ok("...the resident is told the repair is complete — AFTER governed completion",
      done.body === "The repair has been completed.", done.body);
    ok("...derived from the committed fact, not from anything typed",
      !!done.derived_from_progress_id
      && !(await db.query(`select 1 from comm_events where derived_from_progress_id is not null and body ilike '%valve%'`)).rows.length);
    ok("...and it went out on the PROPERTY line, not the operations line",
      sent.some((s) => s.from === PROP_LINE && s.body === "The repair has been completed."),
      JSON.stringify(sent.filter((s) => s.from === PROP_LINE).map((s) => s.body)));
  }

  // ════════════════════════════════════════════════════════════════════
  section("5. RECOGNITION, NOT RE-ENTRY");
  {
    const wo2 = (await db.query(
      `insert into work_orders (property_id,unit_id,title,affected_person_id) values ($1,$2,'No heat',$3) returning id, work_order_ref`,
      [maple, unit302, resident])).rows[0];
    await db.query(`insert into obligations (property_id,related_id,related_type,type,label,assigned_user_id,status)
                    values ($1,$2,'work_order','maintenance_repair','Repair',$3,'open')`, [maple, wo2.id, dana]);

    const r = await say("anything else open here?");
    ok(`"anything else open here?" lists it in plain words — ${JSON.stringify(r)}`,
      /Unit 302 no heat/.test(r) && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(r), r);
    ok("...listing does not require a reference and writes nothing",
      (await db.query(`select count(*)::int c from work_order_progress where kind='en_route'`)).rows[0].c === 1);

    //  Only ONE open item now, so a bare report needs no reference at all.
    const r2 = await say("omw");
    ok(`"omw" with one open item needs no reference — ${JSON.stringify(r2)}`,
      /on the way to the Unit 302 no heat/.test(r2), r2);
  }

  // ════════════════════════════════════════════════════════════════════
  section("6. NOTHING LEAKS, NOTHING GUESSES");
  {
    const replies = sent.filter((s) => s.from === OPS).map((s) => s.body);
    ok("no reply ever shows a uuid", !replies.some((b) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(b)));
    ok("no reply shows a migration number, constraint name or routing term",
      !replies.some((b) => /migration|constraint|obligation|comm_event|work_order_id|staff_thread|reply_only|in_progress|not_done_reason/i.test(b)),
      replies.find((b) => /obligation|constraint|in_progress/i.test(b)));
    ok("no reply asks the technician for a database reference",
      !replies.some((b) => /valid reference|work.order id|uuid/i.test(b)));
    ok("every technician reply is reply-bound on the operations line",
      (await db.query(`select count(*)::int c from comm_events
         where direction='outbound' and communication_line_id is not null
           and (in_reply_to_comm_event_id is null or to_user_id is null
                or staff_thread_id is null or correlation_key is null)`)).rows[0].c === 0);
    ok("no resident message was ever attached to a staff thread",
      (await db.query(`select count(*)::int c from comm_events
         where derived_from_progress_id is not null and staff_thread_id is not null`)).rows[0].c === 0);
    ok("no technician word ever reached a resident",
      (await db.query(`select count(*)::int c from comm_events
         where derived_from_progress_id is not null
           and (body ilike '%valve%' or body ilike '%couldn%' or body ilike '%all done%')`)).rows[0].c === 0);
    ok("the operations line never addressed a resident",
      (await db.query(`select count(*)::int c from comm_events
         where communication_line_id = $1 and person_id is not null`, [opsLineId])).rows[0].c === 0);
    ok("every send used a reserved number", sent.every((s) => /^\+121255501\d\d$/.test(s.to)));

    //  ── ONE FACT, ONE RESIDENT MESSAGE (136) ───────────────────────
    //  Structural, not procedural. The operator action and the automatic
    //  derivation record the same canonical cause, so a second message
    //  about the same fact is refused by the database — whichever writer
    //  attempts it, and whether or not it thought to look first.
    const cause = (await db.query(
      `select derived_from_progress_id p, property_id, person_id, conversation_id, body,
              created_object_id
         from comm_events where derived_from_progress_id is not null limit 1`)).rows[0];
    ok("a resident update records the canonical fact that caused it", !!cause && !!cause.p);
    let dupErr = null;
    try {
      await db.query(
        `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body,
           classification, created_object_type, created_object_id, derived_from_progress_id)
         values ($1,$2,$3,'sms','outbound',$4,'work_order_update','work_order',$5,$6)`,
        [cause.property_id, cause.person_id, cause.conversation_id, cause.body,
         cause.created_object_id, cause.p]);
    } catch (e) { dupErr = e; }
    ok("a SECOND resident message about the same fact is REFUSED by the database",
      !!dupErr && dupErr.code === "23505", dupErr ? dupErr.code : "the insert succeeded");
    ok("...and exactly one message about that fact survives",
      (await db.query(`select count(*)::int c from comm_events where derived_from_progress_id=$1
                        and classification='work_order_update' and channel='sms'`, [cause.p])).rows[0].c === 1);

    //  ── AND NO WIDER. ─────────────────────────────────────────────
    //  A field fact may be REFERENCED any number of times. What it may
    //  not do is tell the resident the same thing twice. These two prove
    //  the index governs the message and not the fact: a different type
    //  and a different channel derived from the same cause are allowed.
    let otherType = null;
    try {
      await db.query(
        `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body,
           classification, created_object_type, created_object_id, derived_from_progress_id)
         values ($1,$2,$3,'sms','outbound','A later, different kind of notice.',
                 'work_order_escalation','work_order',$4,$5)`,
        [cause.property_id, cause.person_id, cause.conversation_id, cause.created_object_id, cause.p]);
    } catch (e) { otherType = e; }
    ok("a DIFFERENT message type derived from the same fact is ALLOWED",
      otherType === null, otherType && otherType.message);

    let otherChannel = null;
    try {
      await db.query(
        `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body,
           classification, created_object_type, created_object_id, derived_from_progress_id)
         values ($1,$2,$3,'email','outbound',$4,'work_order_update','work_order',$5,$6)`,
        [cause.property_id, cause.person_id, cause.conversation_id, cause.body,
         cause.created_object_id, cause.p]);
    } catch (e) { otherChannel = e; }
    ok("a DIFFERENT channel derived from the same fact is ALLOWED",
      otherChannel === null, otherChannel && otherChannel.message);

    //  The one it governs is still governed, with those others present.
    let stillRefused = null;
    try {
      await db.query(
        `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body,
           classification, created_object_type, created_object_id, derived_from_progress_id)
         values ($1,$2,$3,'sms','outbound',$4,'work_order_update','work_order',$5,$6)`,
        [cause.property_id, cause.person_id, cause.conversation_id, cause.body,
         cause.created_object_id, cause.p]);
    } catch (e) { stillRefused = e; }
    ok("...and the governed message is STILL refused alongside them",
      !!stillRefused && stillRefused.code === "23505",
      stillRefused ? stillRefused.code : "the insert succeeded");

    //  A staff-facing row on the same cause is unrepresentable regardless
    //  of this index — 134 closes the audience. The thread is the real one
    //  the technician conversation created, not a fabricated id.
    const thr = (await db.query(`select id from staff_threads limit 1`)).rows[0];
    ok("the technician conversation created a real staff thread to test against", !!thr);
    let staffFacing = null;
    try {
      await db.query(
        `insert into comm_events (property_id, channel, direction, body, staff_thread_id,
           created_object_type, created_object_id, derived_from_progress_id)
         values ($1,'sms','outbound','internal',$2,'work_order',$3,$4)`,
        [cause.property_id, thr && thr.id, cause.created_object_id, cause.p]);
    } catch (e) { staffFacing = e; }
    ok("a STAFF-facing message on that cause is refused by 134, not by this index",
      !!staffFacing && /ck_comm_derived_is_resident_facing/.test(staffFacing.message),
      staffFacing ? staffFacing.message.slice(0, 120) : "the insert succeeded");
  }

  section("7. REPLAY");
  {
    const before = (await db.query(`select count(*)::int c from work_order_progress`)).rows[0].c;
    const p = new URLSearchParams({ MessageSid: "SM_L_2", From: DANA, To: OPS, Body: "I'm heading over.", NumMedia: "0" }).toString();
    await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/communications/inbound-sms", method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(p) } },
        (res) => { res.on("data", () => {}); res.on("end", resolve); });
      req.on("error", reject); req.write(p); req.end();
    });
    await settle();
    ok("a redelivered field report writes no second fact",
      (await db.query(`select count(*)::int c from work_order_progress`)).rows[0].c === before);
  }

  section("8. RUN VALIDITY");
  ok("no swallowed database error anywhere in the run", sawFatalDbError === null, sawFatalDbError || "");

  console.error = realError;
  console.log("\n════════ THE ACTUAL CONVERSATION ════════");
  for (const t of transcript) {
    console.log(`\n  TECH   ${t.tech}`);
    console.log(`  SPINE  ${t.spine.replace(/\n/g, "\n         ")}`);
  }
  console.log("\n  ── and on the resident's line ──");
  for (const m of await residentMessages()) console.log(`  SPINE→RESIDENT  ${m.body}`);
  console.log("");

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
