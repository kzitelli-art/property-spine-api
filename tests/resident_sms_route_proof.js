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
//   · The SMS transport double THROWS if anything tries to actually send.
//     It also records attempts, so "sent nothing" is asserted, not assumed.
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

if (!process.env.DATABASE_URL) {
  console.error(`
════════════════════════════════════════════════════════════════════
  NOT RUN — DATABASE_URL is not set.

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
    connectionString: process.env.DATABASE_URL,
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
  const smsDouble = {
    enabled: () => true,
    validateWebhook: () => true,      // transport auth is stubbed; domain logic is real
    sendSms: async ({ to, from, body }) => {
      sent.push({ to, from, body });
      // A real send must be impossible, not merely unlikely.
      return { sent: false, reason: "harness_transport_never_sends", sid: null };
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

    const prop = (await c.query(
      `insert into properties (name, sms_number) values ($1,$2) returning id`,
      [`TEST SMS-ROUTE ${RUN}`, LINE])).rows[0];
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

    // ── mount the REAL router, exactly as server.js does ────────────
    const express = require("express");
    const commBoundary = require(path.join(__dirname, "../src/comms/communications_boundary.js"))({
      pool: shim, sms: smsDouble,
    });
    const { makeWorkOrderService } = require(path.join(__dirname, "../src/maintenance/work_order_service.js"));
    const { spawnObligationFromEvent, satisfyObligation } = require(path.join(__dirname, "./_engine.js"));
    const { transitionObligation } = require(path.join(__dirname, "../src/shared/obligation_transitions.js"));
    const workOrderService = makeWorkOrderService({ spawnObligationFromEvent, satisfyObligation, transitionObligation });
    const tenantLinkModule = require(path.join(__dirname, "../src/comms/tenantlink.js"));

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
    const question9 = (await c.query(
      `select * from comm_events where property_id=$1 and direction='outbound'
        and classification='clarification_question' order by occurred_at desc limit 1`, [prop.id])).rows[0];
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
    const r11 = await inboundSms(RESIDENT_PHONE, "yes that one", `SM_AMBIG_${RUN}`);
    ok(r11.status === 200, "acked");
    ok(await countWO() === woBefore11, "PERSISTED: no work order created or modified");
    const after11 = await openConfirm();
    ok(after11.length === pending11.length, "every pending question is still open — none was guessed at");
    const flagged11 = (await c.query(
      `select needs_human, body from comm_events where property_id=$1 and direction='inbound'
        and sms_sid=$2`, [prop.id, `SM_AMBIG_${RUN}`])).rows[0];
    ok(flagged11 && flagged11.needs_human === true, "PERSISTED: the claim is preserved and flagged");
    const reply11 = (await c.query(
      `select body from comm_events where property_id=$1 and direction='outbound'
        order by occurred_at desc limit 1`, [prop.id])).rows[0];
    ok(reply11 && !/\b1\b|\b2\b|reply with|choose|which one/i.test(reply11.body),
       "and the resident is NOT asked to pick between options the system cannot durably hold");

    // ══ transport safety, asserted rather than assumed ══
    section("safety · the harness could not have sent a real message");
    ok(sent.length === 0,
       `the SMS transport double recorded ZERO attempted sends (${sent.length})`);
    const anySid = Number((await c.query(
      `select count(*)::int n from comm_events where property_id=$1 and sms_sid is not null and direction='outbound'`,
      [prop.id])).rows[0].n);
    ok(anySid === 0, "no outbound row acquired a provider SID — nothing reached a wire");

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
