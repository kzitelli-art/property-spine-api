// ════════════════════════════════════════════════════════════════════
//  resident_sms_route_proof.js — THE ROUTE-LEVEL PROOF
//  Contract: docs/RESIDENT_SMS_WORK_ORDER_CONTRACT.md (v3)
//
//  Proves contract cases 5, 9, 10, 11 and 14 — the ones the service-level
//  harness (resident_sms_work_order_proof.js) explicitly could NOT cover,
//  because they are properties of the RUNTIME PATH, not of a service call:
//
//      POST /communications/inbound-sms
//        → sms.validateWebhook (transport auth)
//        → commBoundary.resolveInboundSmsContext (domain resolution)
//        → resident routing
//        → runInbound (T1/T2)
//        → canonical work-order behaviour
//
//  ── WHY NOT JUST EXPORT runInbound ──────────────────────────────────
//  Because the thing under test is the seam, not the function. A test that
//  called runInbound directly would prove nothing about signature refusal,
//  unknown-line handling, sender ambiguity, or the browser door — and it
//  would have required widening the module's public surface for the
//  convenience of a test. Owner ruling, and the right one. The real router
//  is mounted here exactly as server.js mounts it.
//
//  ── ZERO PRODUCT-SOURCE CHANGES ─────────────────────────────────────
//  Everything the route touches is already injected: pool, anthropic,
//  INGEST_MODEL, sms, commBoundary, workOrderService, getAgentService.
//  This file supplies test doubles for the two OUTSIDE-WORLD dependencies
//  (the model and the SMS wire) and the REAL implementation of everything
//  that is under test — the boundary, the work-order service, the router.
//
//  ── ISOLATION: THE SAVEPOINT POOL ───────────────────────────────────
//  runInbound COMMITS T1 by design — that is the behaviour being proven, so
//  it cannot be wrapped in a plain transaction and rolled back. Instead one
//  client is held open in a transaction for the whole run and handed to the
//  module through a shim that rewrites its transaction verbs:
//      begin    → savepoint sp_N
//      commit   → release savepoint sp_N
//      rollback → rollback to savepoint sp_N
//  T1/T2 semantics stay fully observable (a "committed" T1 really is durable
//  from the module's point of view, and a failed T2 really does unwind), while
//  the outer ROLLBACK at the end removes every trace. Nothing is deleted to
//  clean up, so no durable history can be harmed by a cleanup bug.
//
//  ── SAFETY ──────────────────────────────────────────────────────────
//   · No pre-existing row is read, updated or deleted. Fixtures are created
//     fresh, uniquely named per run, and rolled back.
//   · Demo Building and every real property are untouched.
//   · The SMS transport double RECORDS every attempted send and reports a
//     successful queue WITHOUT importing the Twilio client at all, so a real
//     wire is unreachable by construction. It must report success: a refused
//     or failed send stamps sms_status refused/failed, which §7.1 correctly
//     treats as "never asked" and excludes from the gate — cases 10 and 11
//     would then silently exercise the wrong branch. The guarantee is
//     therefore not "zero sends" but "zero REAL sends", and it is asserted
//     twice: every send used this run's own fixture line, and every provider
//     SID in the run carries an unmistakable harness prefix.
//   · Zero DELETE / DROP / TRUNCATE statements.
// ════════════════════════════════════════════════════════════════════
"use strict";

const http = require("http");
const path = require("path");
const crypto = require("crypto");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; failures.push(name); console.error(`  FAIL  ${name}`); }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`); }

if (!process.env.HARNESS_DATABASE_URL) {
  console.error(`
════════════════════════════════════════════════════════════════════
  NOT RUN — HARNESS_DATABASE_URL is not set.

  This harness asserts against EXECUTED route behaviour and persisted
  database state. It refuses to report green without a real database:
  a suite that passes because it skipped its own subject is the exact
  failure mode run_harnesses.sh exists to prevent.
════════════════════════════════════════════════════════════════════`);
  process.exit(1);
}

(async function main() {
  const { Pool } = require("pg");
  const realPool = new Pool({
    connectionString: require("../_run_receipt").harnessConnectionString(),
    ssl: { rejectUnauthorized: false },
  });
  const c = await realPool.connect();
  let server;

  // ── the savepoint-translating pool shim (see header) ──────────────
  let spCounter = 0;
  const norm = (sql) => String(sql).trim().toLowerCase().replace(/;$/, "");
  function makeShim(client) {
    const stack = [];
    const translate = async (sql, params) => {
      const s = norm(sql);
      if (s === "begin") { const n = `sp_${++spCounter}`; stack.push(n); return client.query(`savepoint ${n}`); }
      if (s === "commit") { const n = stack.pop(); return n ? client.query(`release savepoint ${n}`) : { rows: [] }; }
      if (s === "rollback") { const n = stack.pop(); return n ? client.query(`rollback to savepoint ${n}`) : { rows: [] }; }
      return client.query(sql, params);
    };
    return {
      query: translate,
      connect: async () => ({ query: translate, release: () => {} }),
    };
  }
  const shim = makeShim(c);

  // ── test doubles for the OUTSIDE WORLD only ───────────────────────
  const sent = [];                    // every attempted send, recorded
  let nextSendFails = false;          // armed by case 12, consumed by one send
  const HARNESS_SID = "SM_HARNESS_NEVER_REAL_";
  const smsDouble = {
    enabled: () => true,
    validateWebhook: () => true,      // transport auth is stubbed; domain logic is real
    // Returns a SUCCESSFUL-looking send. That matters: a refused or failed
    // send stamps sms_status refused/failed, which §7.1 correctly treats as
    // "this question was never asked" and excludes from the gate. Cases 10
    // and 11 are about answering a question that WAS asked, so the transport
    // has to succeed for them to exercise the branch they name.
    // Nothing real can leave: this object never imports the Twilio client,
    // and every sid it mints carries an unmistakable harness prefix that is
    // asserted below.
    sendSms: async ({ to, from, body }) => {
      sent.push({ to, from, body });
      //  ONE forced failure, consumed on use. Case 12 needs a clarification
      //  question that genuinely could not be delivered — stamped `failed` by
      //  the real gate, through the real transport seam — rather than a
      //  status written directly onto the row, which would prove the harness.
      if (nextSendFails) {
        nextSendFails = false;
        return { sent: false, reason: "harness_forced_delivery_failure",
                 error: "the carrier rejected this message (harness)", sid: null };
      }
      return { sent: true, status: "queued", sid: `${HARNESS_SID}${sent.length}` };
    },
  };

  // The model double. classifyMessage and recognizeAnswer both call
  // anthropic.messages.create; they are told apart by their prompt shape, so
  // one double serves both and each test sets the verdict it wants.
  let nextClassification = { classification: "maintenance", field_category: "plumbing", urgency: "normal", confidence: 0.95, needs_human: false, summary: "s", suggested_title: "t" };
  let nextVerdict = "unclear";
  const anthropicDouble = { messages: { create: async ({ messages }) => {
    const prompt = messages[0].content;
    if (/Reply with ONE word/.test(prompt)) return { content: [{ type: "text", text: nextVerdict }] };
    return { content: [{ type: "text", text: JSON.stringify(nextClassification) }] };
  } } };

  try {
    await c.query("begin");
    const RUN = crypto.randomUUID().slice(0, 8);
    console.log(`\n════ ROUTE-LEVEL PROOF — real Postgres + real HTTP · run ${RUN} ════`);
    console.log("  fixtures created fresh and rolled back; no pre-existing row is read, updated or deleted.\n");

    // ── fixtures ────────────────────────────────────────────────────
    const LINE = `+1999${RUN.replace(/\D/g, "0").slice(0, 7).padEnd(7, "0")}`;
    const RESIDENT_PHONE = `+1888${RUN.replace(/\D/g, "0").slice(0, 7).padEnd(7, "0")}`;
    const STRANGER_PHONE = `+1777${RUN.replace(/\D/g, "0").slice(0, 7).padEnd(7, "0")}`;
    const RESIDENT2_PHONE = `+1866${RUN.replace(/\D/g, "0").slice(0, 7).padEnd(7, "0")}`;

    //  THE CANONICAL LINE MODEL (migration 130). `properties.sms_number` is a
    //  READ-ONLY PROJECTION of `communication_lines`, and writing it directly
    //  is refused by trg_properties_guard_legacy_line — correctly, because it
    //  would create a second truth about which number serves this property.
    //
    //  This fixture used to insert the number straight onto the property. That
    //  predates 130 and was never re-run against the canonical model, so the
    //  first full-schema run of this proof failed here. The guard was right;
    //  the fixture was wrong. The line is now configured where line
    //  configuration belongs, and trg_cl_project_property_line fills the
    //  column — so the `where sms_number = $1` reads below are unchanged.
    const prop = (await c.query(
      `insert into properties (name) values ($1) returning id`,
      [`TEST SMS-ROUTE ${RUN}`])).rows[0];
    await c.query(
      `insert into communication_lines
         (e164, line_type, property_id, authority_ceiling, permitted_audience,
          inbound_enabled, outbound_enabled, outbound_policy, status)
       values ($1,'property_facing',$2,'external','residents_and_prospects',
               true, true, 'proactive', 'active')`,
      [LINE, prop.id]);
    const unit = (await c.query(
      `insert into units (property_id, unit_number) values ($1,$2) returning id`,
      [prop.id, `R-${RUN}`])).rows[0];
    const space = (await c.query(
      `insert into spaces (unit_id) values ($1) returning id`, [unit.id])).rows[0];
    const person = (await c.query(
      `insert into persons (name, phone, primary_phone_e164, lifecycle_status)
       values ($1,$2,$2,'tenant') returning id`,
      [`TEST Route Resident ${RUN}`, RESIDENT_PHONE])).rows[0];
    await c.query(
      `insert into leases (property_id, space_id, tenant_ids, lease_status, rent)
       values ($1,$2,array[$3::uuid],'active',1500)`, [prop.id, space.id, person.id]);
    await c.query(
      `insert into tenant_invites (person_id, property_id, token, status, expires_at)
       values ($1,$2,$3,'used', now() + interval '30 days')`,
      [person.id, prop.id, `tok-invite-${RUN}`]);

    // SMS CONSENT — discovered by the first real run, not by reading source.
    //
    // Without an opted_in contact_preferences row, canSendSmsForRecord refuses
    // every outbound with customer_care_requires_opted_in_consent, and
    // sendPropertySms stamps the outbound sms_status='refused'. That is
    // CORRECT product behaviour — but it means the clarification question is
    // marked as never-delivered, and §7.1 then (correctly) excludes it from
    // the gate. Cases 10 and 11 assume a question that WAS delivered, so
    // without consent they were silently exercising the never-asked branch
    // instead of the branch they name. The fixture, not the product, was wrong.
    await c.query(
      `insert into contact_preferences (person_id, channel, consent_state, source, updated_at)
       values ($1,'text','opted_in','harness fixture', now())
       on conflict (person_id, channel) do update set consent_state='opted_in'`,
      [person.id]);

    //  ── A SECOND RESIDENT, for case 12 only ──────────────────────────
    //  `pendingClarifications` is scoped BY PERSON. Cases 9-11 deliberately
    //  leave delivered questions open for the first resident, so running the
    //  undelivered-question case on her would hold for a human through the
    //  `ambiguous_open_set` branch and pass for entirely the wrong reason.
    //  A resident with no clarification history isolates the branch under
    //  test to the one fact case 12 is about.
    const unit2 = (await c.query(
      `insert into units (property_id, unit_number) values ($1,$2) returning id`,
      [prop.id, `R2-${RUN}`])).rows[0];
    const space2 = (await c.query(
      `insert into spaces (unit_id) values ($1) returning id`, [unit2.id])).rows[0];
    const person2 = (await c.query(
      `insert into persons (name, phone, primary_phone_e164, lifecycle_status)
       values ($1,$2,$2,'tenant') returning id`,
      [`TEST Route Resident TWO ${RUN}`, RESIDENT2_PHONE])).rows[0];
    await c.query(
      `insert into leases (property_id, space_id, tenant_ids, lease_status, rent)
       values ($1,$2,array[$3::uuid],'active',1500)`, [prop.id, space2.id, person2.id]);
    await c.query(
      `insert into tenant_invites (person_id, property_id, token, status, expires_at)
       values ($1,$2,$3,'used', now() + interval '30 days')`,
      [person2.id, prop.id, `tok-invite2-${RUN}`]);
    await c.query(
      `insert into contact_preferences (person_id, channel, consent_state, source, updated_at)
       values ($1,'text','opted_in','harness fixture', now())
       on conflict (person_id, channel) do update set consent_state='opted_in'`,
      [person2.id]);

    // The receiving line must resolve to OUR fixture property and nothing
    // else. resolveInboundSmsContext does `where sms_number=$1 limit 1`, so a
    // collision with a real property's number would silently route this
    // harness's traffic at a real building. Proven, not assumed.
    const lineOwners = (await c.query(
      `select id from properties where sms_number = $1`, [LINE])).rows;
    ok(lineOwners.length === 1 && lineOwners[0].id === prop.id,
       "the fixture receiving line resolves to exactly ONE property — this run's own");

    // ── mount the REAL router, exactly as server.js does ────────────
    const express = require("express");
    const commBoundary = require(path.join(__dirname, "../../src/comms/communications_boundary.js"))({
      pool: shim, sms: smsDouble,
    });

    // ── THE SEND GATE IS SATISFIED, NEVER BYPASSED ──────────────────
    //  The OUTER suite still requires SMS_SEND_MODE=disabled and no carrier
    //  credentials in the environment, and nothing here changes that
    //  precondition. What this does is establish a controlled mode IN THIS
    //  PROCESS — and only after proving that nothing real is reachable from
    //  it and that the transport the boundary holds is this file's double.
    //
    //  Why it is needed: with the mode disabled, every send is refused
    //  UPSTREAM of the double, so the clarification question is stamped
    //  `refused` and cases 10 and 11 never reach the branch they name.
    //  sendPropertySms is untouched and its eligibility ladder runs in
    //  full — this satisfies the gate rather than stepping around it.
    const carrierEnv = Object.keys(process.env)
      .filter((k) => /^TWILIO_|^SMS_ACCOUNT|^MESSAGING_SERVICE/i.test(k));
    ok(carrierEnv.length === 0,
       `no carrier credential exists in this process (${carrierEnv.join(", ") || "none present"})`);
    //  Checks the SOURCE of the injected function, not a value it returns —
    //  calling it here would push a phantom row into `sent` and break the
    //  safety assertions that every recorded send used the fixture's own
    //  line. That every minted sid IS harness-prefixed is proven at the end
    //  of the run, against the sids actually minted.
    ok(/sent\.push/.test(String(smsDouble.sendSms))
       && /HARNESS_SID/.test(String(smsDouble.sendSms)),
       "the transport handed to the boundary is THIS FILE'S double — it records every send here and can mint only harness-prefixed sids");
    process.env.SMS_SEND_MODE = "customer_care";
    ok(process.env.SMS_SEND_MODE === "customer_care",
       "the send mode is satisfied in-process, AFTER the double is proven and with no carrier reachable");
    const { makeWorkOrderService } = require(path.join(__dirname, "../../src/maintenance/work_order_service.js"));
    const { spawnObligationFromEvent, satisfyObligation } = require(path.join(__dirname, "..", "_engine.js"));
    const { transitionObligation } = require(path.join(__dirname, "../../src/shared/obligation_transitions.js"));
    const workOrderService = makeWorkOrderService({ spawnObligationFromEvent, satisfyObligation, transitionObligation });
    const tenantLinkModule = require(path.join(__dirname, "../../src/comms/tenant_link.js"));

    const app = express();
    app.use(express.json());
    app.use("/", tenantLinkModule({
      pool: shim, anthropic: anthropicDouble, INGEST_MODEL: "harness",
      sms: smsDouble, commBoundary, workOrderService,
      getAgentService: () => null,
    }));
    server = app.listen(0);
    const port = server.address().port;

    const post = (urlPath, body, headers = {}) => new Promise((resolve, reject) => {
      const isForm = typeof body === "string";
      const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "POST",
        headers: Object.assign({
          "content-type": isForm ? "application/x-www-form-urlencoded" : "application/json",
          "content-length": Buffer.byteLength(isForm ? body : JSON.stringify(body)),
        }, headers) }, (res) => {
        let data = ""; res.on("data", (d) => { data += d; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.write(isForm ? body : JSON.stringify(body));
      req.end();
    });
    const inboundSms = (from, body, sid) => post("/communications/inbound-sms",
      `MessageSid=${encodeURIComponent(sid)}&From=${encodeURIComponent(from)}&To=${encodeURIComponent(LINE)}&Body=${encodeURIComponent(body)}`);

    const countWO = async () => Number((await c.query(
      `select count(*)::int n from work_orders where property_id=$1`, [prop.id])).rows[0].n);
    const countOutbound = async (pid) => Number((await c.query(
      `select count(*)::int n from comm_events where property_id=$1 and direction='outbound'
        ${pid ? "and person_id=$2" : ""}`, pid ? [prop.id, pid] : [prop.id])).rows[0].n);
    const openConfirm = async () => (await c.query(
      `select o.* from obligations o where o.property_id=$1 and o.type='confirm_urgency' and o.status='open'`,
      [prop.id])).rows;

    // ══ CASE 5 ══ unknown / ambiguous sender writes NOTHING on the resident path
    section("5 · an unknown sender never reaches the resident path");
    const woBefore5 = await countWO();
    const r5 = await inboundSms(STRANGER_PHONE, "my sink is leaking badly", `SM_STRANGER_${RUN}`);
    ok(r5.status === 200, "the webhook is acked (200) — Twilio must not be made to retry");
    ok(await countWO() === woBefore5, "PERSISTED: no work order was created for an unresolved sender");
    const strangerOutbound = Number((await c.query(
      `select count(*)::int n from comm_events
        where property_id=$1 and direction='outbound' and person_id is null`, [prop.id])).rows[0].n);
    ok(strangerOutbound === 0, "and ZERO outbound was dispatched to an unidentified sender");
    ok(sent.length === 0, "no send was even attempted at the transport");

    // ══ CASE 14 ══ the browser door still behaves canonically
    section("14 · the browser door shares the spine and its response shape");
    const tokenB = `tok-session-${RUN}`;
    await c.query(
      `insert into tenant_sessions (person_id, property_id, token, expires_at)
       values ($1,$2,$3, now() + interval '1 day')`, [person.id, prop.id, tokenB]);
    nextClassification = { classification: "maintenance", field_category: "plumbing", urgency: "normal", confidence: 0.95, needs_human: false, summary: "s", suggested_title: "cabinet hinge" };
    const woBefore14 = await countWO();
    const r14 = await post("/tenant/messages", { body: "the kitchen cabinet door hinge is loose" },
      { "x-tenant-session": tokenB });
    const j14 = JSON.parse(r14.body || "{}");
    ok(r14.status === 200, "browser door returns 200");
    ok(typeof j14.receipt === "string" && j14.message_id && j14.reply_id && j14.conversation_id,
       "response shape preserved: receipt + message_id + reply_id + conversation_id");
    ok(j14.created_object_type === "work_order" && !!j14.created_object_id,
       "and it reports the canonical object it created");
    ok(await countWO() === woBefore14 + 1, "PERSISTED: exactly one work order created via the browser door");
    const oblB = (await c.query(
      `select * from obligations where related_type='work_order' and related_id=$1`,
      [j14.created_object_id])).rows;
    ok(oblB.length === 1,
       "AND it produced a routing obligation — the raw insert this replaced produced none");
    ok(oblB[0].type === "maintenance_repair",
       "a routine report yields maintenance_repair, leaving NO clarification question outstanding");
    ok(sent.length === 0, "the browser door dispatched no SMS");

    // ══ CASE 9 ══ a clearly separate problem opens a NEW work order
    section("9 · a separate problem opens a new work order, original untouched");
    // First, an ambiguous SMS report that asks a clarifying question.
    nextClassification = { classification: "maintenance", field_category: "plumbing", urgency: "normal", confidence: 0.95, needs_human: false, summary: "s", suggested_title: "leak" };
    await inboundSms(RESIDENT_PHONE, "there's a leak somewhere", `SM_Q_${RUN}`);
    const pend9 = await openConfirm();
    ok(pend9.length === 1,
       `exactly one open confirm_urgency question exists (${pend9.length}) — the gate's single-question path`);
    // Keyed by IDENTITY, never by time. See the OCCURRED_AT HAZARD note below:
    // every row in this run shares one occurred_at, so an ORDER BY here would
    // pick an arbitrary row. This was previously safe only because exactly one
    // clarification_question existed at this point — an accident, not a design.
    const question9 = (await c.query(
      `select * from comm_events where property_id=$1 and direction='outbound'
        and classification='clarification_question' and created_object_id=$2`,
      [prop.id, pend9[0].related_id])).rows[0];
    ok(!!question9 && question9.created_object_id === pend9[0].related_id,
       "the outbound question is durably linked to its work order — the linkage the gate needs");

    const woBefore9 = await countWO();
    nextVerdict = "separate_problem";
    nextClassification = { classification: "maintenance", field_category: "electric", urgency: "normal", confidence: 0.95, needs_human: false, summary: "s", suggested_title: "outlet" };
    await inboundSms(RESIDENT_PHONE, "different thing - the bedroom outlet stopped working", `SM_SEP_${RUN}`);
    ok(await countWO() === woBefore9 + 1, "PERSISTED: a NEW work order was created for the separate problem");
    const stillOpen9 = await openConfirm();
    ok(stillOpen9.some((o) => o.id === pend9[0].id),
       "and the ORIGINAL clarification question is still open — untouched, not silently answered");

    // ══ CASE 10 ══ 'both' / 'unclear' preserves and flags, changing nothing
    section("10 · an ambiguous reply is preserved and flagged, never guessed");
    const woBefore10 = await countWO();
    const oblSnapshot = JSON.stringify((await openConfirm()).map((o) => [o.id, o.type, o.required_inputs]).sort());
    nextVerdict = "both";
    const r10 = await inboundSms(RESIDENT_PHONE, "yes it's dripping and also my heat is out", `SM_BOTH_${RUN}`);
    ok(r10.status === 200, "acked");
    ok(await countWO() === woBefore10, "PERSISTED: no work order created or modified");
    ok(JSON.stringify((await openConfirm()).map((o) => [o.id, o.type, o.required_inputs]).sort()) === oblSnapshot,
       "and no obligation changed type or required inputs");
    const flagged10 = (await c.query(
      `select needs_human from comm_events where property_id=$1 and direction='inbound'
        and sms_sid=$2`, [prop.id, `SM_BOTH_${RUN}`])).rows[0];
    ok(flagged10 && flagged10.needs_human === true,
       "PERSISTED: the inbound claim is flagged needs_human=true for a human");

    // ══ CASE 11 ══ more than one pending question → preserve, never choose
    section("11 · two pending questions — preserved, flagged, no choice offered");
    // create a SECOND open clarification for the same resident
    nextVerdict = "separate_problem";
    nextClassification = { classification: "maintenance", field_category: "heat_ac", urgency: "normal", confidence: 0.95, needs_human: false, summary: "s", suggested_title: "smell" };
    await inboundSms(RESIDENT_PHONE, "also there is a strange smell", `SM_Q2_${RUN}`);
    const pending11 = await openConfirm();
    ok(pending11.length >= 2, `two or more clarification questions are now open (${pending11.length})`);

    const woBefore11 = await countWO();
    // Identity snapshot: the outbound row is written INSIDE T2, which commits
    // before the HTTP response returns, so diffing ids is race-free.
    const outBefore11 = new Set((await c.query(
      `select id from comm_events where property_id=$1 and direction='outbound'`,
      [prop.id])).rows.map((r) => r.id));
    const r11 = await inboundSms(RESIDENT_PHONE, "yes that one", `SM_AMBIG_${RUN}`);
    ok(r11.status === 200, "acked");
    ok(await countWO() === woBefore11, "PERSISTED: no work order created or modified");
    const after11 = await openConfirm();
    ok(after11.length === pending11.length, "every pending question is still open — none was guessed at");
    const flagged11 = (await c.query(
      `select needs_human, body from comm_events where property_id=$1 and direction='inbound'
        and sms_sid=$2`, [prop.id, `SM_AMBIG_${RUN}`])).rows[0];
    ok(flagged11 && flagged11.needs_human === true, "PERSISTED: the claim is preserved and flagged");
    // ── OCCURRED_AT HAZARD (found by adversarial review, confirmed on PG16) ──
    //  comm_events.occurred_at defaults to now(), and Postgres now() is the
    //  TRANSACTION start time. This harness runs entirely inside ONE
    //  transaction — the savepoint shim means no real COMMIT ever happens — so
    //  EVERY row written by this run carries an IDENTICAL occurred_at.
    //  `order by occurred_at desc limit 1` therefore selects an arbitrary row.
    //
    //  The previous version of this assertion did exactly that, and read case
    //  14's browser-door reply instead of case 11's. It would have passed even
    //  if the code regressed to "Reply 1 for the leak or 2 for the smell" —
    //  a total false green on the ONE guard for §7.1.4's "do not ask the
    //  resident to choose". Never order by occurred_at in this file.
    //
    //  SECOND CORRECTION, from the rerun: the transport double's `sent` array
    //  is correctly ORDERED but arrives too LATE to read here. The route acks
    //  Twilio with emptyTwiml(res) BEFORE it awaits sendPropertySms — by
    //  design, so a slow carrier never makes Twilio retry — so the HTTP
    //  response returning does NOT mean the send has been recorded. Reading
    //  sent[sent.length-1] therefore saw the PREVIOUS message's reply, and the
    //  run reported `recorded (4)` where five sends were expected.
    //
    //  The outbound ROW, by contrast, is written inside T2 and committed
    //  before the response returns. So diff the outbound ids around the call
    //  and assert on the row that appeared: identity-keyed, race-free, and
    //  immune to the degenerate occurred_at above.
    const newOutbound = (await c.query(
      `select id, body from comm_events where property_id=$1 and direction='outbound'`,
      [prop.id])).rows.filter((r) => !outBefore11.has(r.id));
    ok(newOutbound.length === 1, `exactly one reply was written for this message (${newOutbound.length})`);
    const reply11 = newOutbound[0];
    ok(!!reply11 && /more than one open request/i.test(reply11.body),
       "the resident is told the TRUTH — that more than one request is open and the team will review");
    ok(!!reply11 && !/\b1\b|\b2\b|reply with|choose|which one/i.test(reply11.body),
       "and is NOT asked to pick between options the system cannot durably hold");

    // ══ transport safety, asserted rather than assumed ══
    // ══ CASE 12 ══ AN UNDELIVERED CLARIFICATION IS NOT PERMISSION TO OPEN WORK
    //
    //  THE DEFECT THIS EXISTS FOR — found by Gate A against a
    //  production-derived schema, pre-existing and live on `main`. A
    //  clarification question whose delivery FAILED is deliberately absent
    //  from the pending set: a reply cannot answer a question the resident
    //  never received. But that absence read as "nothing outstanding", so an
    //  ambiguous reply became a NEW WORK ORDER with needs_human unset, and the
    //  ambiguity verdict was never consulted at all.
    //
    //  FAILURE TO DELIVER A CLARIFICATION CANNOT TURN AMBIGUITY INTO
    //  OPERATING TRUTH. Proven here through the real route, the real gate and
    //  the real database — not at the decision seam alone.
    //
    //  Runs as the SECOND resident. See the fixture note: cases 9-11 leave
    //  delivered questions open for the first one, and this case would then
    //  hold via `ambiguous_open_set` and pass for the wrong reason.
    //
    //  NO `order by occurred_at` ANYWHERE BELOW — see the hazard note further
    //  down. Every row in this run shares one transaction timestamp.
    section("12 · an undelivered clarification cannot become operating truth");
    {
      const woBeforeClaim = await countWO();
      //  Deliberately the SAME wording case 9 uses to raise a clarifying
      //  question, so the branch under test is reached for a proven reason.
      nextClassification = { classification: "maintenance", field_category: "plumbing", urgency: "normal",
                             confidence: 0.95, needs_human: false, summary: "s", suggested_title: "leak" };
      nextSendFails = true;                       // the question will NOT reach her
      const rClaim = await inboundSms(RESIDENT2_PHONE, "there's a leak somewhere", `SM_UNDEL_Q_${RUN}`);
      ok(rClaim.status === 200, "the claim is acked");
      ok(await countWO() === woBeforeClaim + 1, "the claim itself legitimately opened ONE work order");

      //  Selected by PERSON, not by time: this resident has exactly one
      //  outbound in the whole run, so the row is unambiguous.
      const qRows = (await c.query(
        `select id, body, sms_status, sms_error, created_object_id from comm_events
          where property_id=$1 and person_id=$2 and direction='outbound'`,
        [prop.id, person2.id])).rows;
      ok(qRows.length === 1,
         `exactly one outbound exists for this resident (${qRows.length}) — selected without ordering`);
      const q12 = qRows[0];
      //  THE ROUTE ACKS BEFORE IT SENDS. The webhook returns 200 as soon as
      //  the claim is captured — Twilio must not be made to retry — and the
      //  reply goes on the wire after that. Reading sms_status the instant
      //  inboundSms resolves reads it BEFORE the send stamped it. The first
      //  version of this case did exactly that and reported null, while
      //  every later assertion on the same row correctly saw 'failed'.
      //  Waiting for the row to settle is not waiting for the answer.
      const settledStatus = async (id) => {
        let r;
        for (let i = 0; i < 100; i++) {
          r = (await c.query(`select sms_status, sms_error from comm_events where id=$1`, [id])).rows[0];
          if (r && r.sms_status) return r;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((res) => setTimeout(res, 20));
        }
        return r || {};
      };
      const q12s = await settledStatus(q12.id);
      ok(q12s.sms_status === "failed",
         `the clarification question is recorded as FAILED (${q12s.sms_status})`);
      ok(!!q12s.sms_error,
         "…and the failure says WHY — an unexplained failure is a blank pretending to be a fact");

      // ── the ambiguous reply to a question she never received ──────────
      const woBeforeReply = await countWO();
      const oblSnap = JSON.stringify((await openConfirm())
        .map((o) => [o.id, o.type, o.required_inputs, o.status]).sort());
      nextVerdict = "both";
      const r12 = await inboundSms(RESIDENT2_PHONE, "yes and also the hallway light is out",
                                   `SM_UNDEL_BOTH_${RUN}`);
      ok(r12.status === 200, "the ambiguous reply is acked");

      ok(await countWO() === woBeforeReply,
         "PERSISTED: an undelivered question does NOT license a new work order");
      ok(JSON.stringify((await openConfirm())
           .map((o) => [o.id, o.type, o.required_inputs, o.status]).sort()) === oblSnap,
         "PERSISTED: no obligation was created, retyped, restatused or had its required inputs changed");

      const reply12 = (await c.query(
        `select needs_human, body from comm_events where property_id=$1 and direction='inbound' and sms_sid=$2`,
        [prop.id, `SM_UNDEL_BOTH_${RUN}`])).rows[0];
      ok(!!reply12 && reply12.needs_human === true,
         "PERSISTED: the ambiguous reply is flagged needs_human=true for a human");
      const claim12 = (await c.query(
        `select needs_human, body from comm_events where property_id=$1 and direction='inbound' and sms_sid=$2`,
        [prop.id, `SM_UNDEL_Q_${RUN}`])).rows[0];
      ok(!!claim12 && /leak somewhere/.test(claim12.body),
         "PERSISTED: the original inbound claim survives, verbatim");
      ok(claim12.needs_human === true,
         "…and was re-flagged for a human when its question could not be delivered");

      //  THE HOLD MUST SPEAK. Found by this case: `held()` composes an
      //  operating receipt, the receipt vocabulary had no text for
      //  question_not_delivered, so it REFUSED and speak() THREW — the claim
      //  was flagged and the resident was told NOTHING. A hold that cannot
      //  speak is exactly the "captured, never acknowledged" state the
      //  ruling forbids.
      const heldReply = (await c.query(
        `select body from comm_events where property_id=$1 and person_id=$2
           and direction='outbound' and id <> $3`, [prop.id, person2.id, q12.id])).rows;
      ok(heldReply.length === 1,
         `the hold SPOKE — exactly one reply was written for the ambiguous message (${heldReply.length})`);
      ok(/follow up with you/i.test((heldReply[0] || {}).body || ""),
         `…telling the resident a human will follow up — "${((heldReply[0] || {}).body || "").slice(0, 60)}"`);

      const qAfter = (await c.query(
        `select id, body, sms_status, sms_error from comm_events where id=$1`, [q12.id])).rows[0];
      ok(!!qAfter && qAfter.sms_status === "failed" && qAfter.body === q12.body,
         "PERSISTED: the failed clarification event is preserved, unchanged");
      ok(!!qAfter.sms_error,
         "the delivery failure is visible as a communication exception, with its reason");

      //  THE DECISION ITSELF, from the REAL rows — the same two queries
      //  tenant_link runs, against this database, at this moment.
      const clar = require(path.join(__dirname, "../../src/conversation/clarification.js"));
      const CLAR_JOIN = `from comm_events ce
         join obligations o on o.related_type='work_order' and o.related_id=ce.created_object_id
          and o.property_id=ce.property_id and o.status='open' and o.type='confirm_urgency'
        where ce.property_id=$1 and ce.person_id=$2 and ce.direction='outbound'
          and ce.created_object_type='work_order'`;
      const openRows = (await c.query(
        `select o.id as obligation_id, o.related_id as work_order_id, ce.property_id,
                ce.id as question_event_id, ce.body as question_body ${CLAR_JOIN}
           and coalesce(ce.sms_status,'') not in ('failed','refused','undelivered')`,
        [prop.id, person2.id])).rows;
      const undelRows = (await c.query(
        `select o.id as obligation_id, o.related_id as work_order_id, ce.property_id,
                ce.id as question_event_id, ce.body as question_body ${CLAR_JOIN}
           and coalesce(ce.sms_status,'') in ('failed','refused','undelivered')`,
        [prop.id, person2.id])).rows;
      ok(openRows.length === 0 && undelRows.length === 1,
         `the real rows say: 0 delivered, 1 undelivered (${openRows.length}/${undelRows.length})`);
      const decision = clar.assessOpenClarification({
        scope: { property_id: prop.id }, open: openRows, undelivered: undelRows });
      ok(decision.action === "hold_for_human", `the decision is hold_for_human (${decision.action})`);
      ok(decision.state === "question_not_delivered", `the state is question_not_delivered (${decision.state})`);
      ok(decision.requiresHuman === true, "…and it says a human is required");

      // ── RETRY the SAME intent. A retry is not a new message. ──────────
      const evBefore = Number((await c.query(
        `select count(*)::int n from comm_events where property_id=$1`, [prop.id])).rows[0].n);
      const woBeforeRetry = await countWO();
      const retry = await commBoundary.sendPropertySms({
        property_id: prop.id, recipient: RESIDENT2_PHONE, body: q12.body,
        purpose: "ai_reply", person_id: person2.id, eventId: q12.id,
      });
      ok(retry.sent === true, `the retry reaches the double (${retry.reason})`);
      ok(Number((await c.query(
        `select count(*)::int n from comm_events where property_id=$1`, [prop.id])).rows[0].n) === evBefore,
         "PERSISTED: the retry created NO duplicate clarification event — the intent already existed");
      const qRetried = (await c.query(
        `select sms_status, sms_sid, body, sms_error from comm_events where id=$1`, [q12.id])).rows[0];
      ok(String(qRetried.sms_sid || "").startsWith(HARNESS_SID),
         "the EXISTING intent now carries the successful attempt's provider ref");
      ok(qRetried.body === q12.body, "…and its text was never rewritten by the retry");
      ok(await countWO() === woBeforeRetry,
         "PERSISTED: a successful retry creates no work order retrospectively");

      const replyAfterRetry = (await c.query(
        `select needs_human from comm_events where property_id=$1 and direction='inbound' and sms_sid=$2`,
        [prop.id, `SM_UNDEL_BOTH_${RUN}`])).rows[0];
      ok(replyAfterRetry.needs_human === true,
         "the EARLIER ambiguous reply is not retrospectively read as an answer — it stays flagged");

      //  Only a reply sent AFTER successful delivery may be judged against it.
      const woBeforeAfter = await countWO();
      nextVerdict = "answers_question";
      const r12b = await inboundSms(RESIDENT2_PHONE, "yes it is dripping steadily",
                                    `SM_UNDEL_AFTER_${RUN}`);
      ok(r12b.status === 200, "a NEW reply, sent after the question actually arrived, is acked");
      ok(await countWO() === woBeforeAfter,
         "…and IS evaluated against that question — appended, never opened as new work");
    }

    section("safety · nothing reached a real wire");
    // The double now reports success, so sends DO occur — against the double.
    // The guarantee is therefore not "zero sends" but "zero REAL sends", and
    // it is proven two ways rather than asserted once.
    // NOTE: this count can lag the number of replies WRITTEN, because the route
    // acks before awaiting the send. It is a lower bound, deliberately asserted
    // as such rather than pinned to a number that would flap.
    ok(sent.length > 0, `sends were routed through the double and recorded (${sent.length}, lower bound)`);
    ok(sent.every((s) => s.to && s.from === LINE),
       "every send used the fixture property's own line — never a real property's number");
    const sids = (await c.query(
      `select sms_sid from comm_events where property_id=$1 and direction='outbound' and sms_sid is not null`,
      [prop.id])).rows.map((r) => r.sms_sid);
    ok(sids.length > 0 && sids.every((s) => String(s).startsWith(HARNESS_SID)),
       `every provider SID is harness-minted (${sids.length} checked) — no Twilio SID exists anywhere in this run`);

    console.log(`\n════ ${pass} passed, ${fail} failed ════`);
    if (failures.length) console.error("FAILURES:\n" + failures.map((f) => "  ✗ " + f).join("\n"));
    console.log("\n  Contract cases proven at the HTTP boundary: 5, 9, 10, 11, 14.");
    console.log("  Everything above ran through the REAL router, boundary and work-order service.");
  } catch (e) {
    console.error("\nHARNESS ERROR:", e && e.stack ? e.stack : e);
    fail += 1;
  } finally {
    if (server) server.close();
    await c.query("rollback").catch(() => {});
    c.release();
    await realPool.end();
  }
  process.exit(fail ? 1 : 0);
})();
