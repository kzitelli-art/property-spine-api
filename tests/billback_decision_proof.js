// ════════════════════════════════════════════════════════════════════
//  billback_decision_proof.js — THE OBSERVATION IS NOT THE DECISION
//
//  WHAT THIS PROTECTS
//  ------------------
//  `tenant_caused = true` records that a human OBSERVED the resident caused
//  the damage. It must never become a billback on its own. Whether the
//  property charges a resident is a DECISION: it has an owner, an actor, a
//  time, a reason, and it must be reversible by a correction that preserves
//  what it corrected. Recommendation is not dispatch.
//
//  DESIGNED AGAINST THE LAST PRIMITIVE THAT FAILED. Live `agent_review` rows
//  on this database, measured 2026-07-26:
//     272 rows total
//      19 BORN COMPLETE (completed_at within 2s of created_at)
//     173 complete with resolution_code NULL — no record of HOW they closed
//     272 with ownership_origin NULL and owner_eligibility_state NULL —
//         "nobody is eligible" and "nobody asked" are indistinguishable
//  Layers B, C and D below exist to make each of those three impossible for
//  this type. A new primitive should be designed against the last one that
//  broke, not against an ideal.
//
//  SCOPE SAFETY
//  ------------
//  Own scratch property, tracked ids, name-guarded cleanup. Never touches
//  Demo Building. Nothing in this file posts money — there is no money_event,
//  no charge, and no amount is ever invented.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  DATABASE_URL=... node tests/billback_decision_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Pool } = require("pg");

const { makeWorkOrderService } = require("../src/maintenance/work_order_service.js");
const maintenanceModule = require("../src/maintenance/maintenance.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const uuid = () => crypto.randomUUID();
const PROP = uuid();
const PROP_NAME = `__BILLBACK__P ${PROP.slice(0, 8)}`;

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`); }

const track = { users: [], persons: [] };

async function spawnObligationFromEvent(client, o) {
  const r = await client.query(
    `insert into obligations
       (property_id, person_id, unit_id, source_event_id, module, type, label,
        owner_type, assigned_role, escalates_to_role, status, priority, severity,
        due_at, required_inputs, related_id, related_type,
        ownership_origin, owner_eligibility_state, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning *`,
    [o.property_id, o.person_id ?? null, o.unit_id ?? null, o.source_event_id ?? null,
     o.module, o.type, o.label, o.owner_type ?? "human",
     o.assigned_role ?? null, o.escalates_to_role ?? null,
     o.status ?? "open", o.priority ?? "normal", o.severity ?? "normal",
     o.due_at ?? null, o.required_inputs ?? [], o.related_id ?? null, o.related_type ?? null,
     o.ownership_origin ?? null, o.owner_eligibility_state ?? null, o.dedupe_key ?? null]);
  return r.rows[0];
}

let srv, base, svc;
async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const oblFor = async (woId) => (await pool.query(
  `select * from obligations where related_type='work_order' and related_id=$1
      and type='billback_decision'`, [woId])).rows;
const entriesFor = async (woId) => (await pool.query(
  `select * from work_order_billback_decisions where work_order_id=$1 order by created_at`,
  [woId])).rows;

// ════════════════════════════════════════════════════════════════════
async function main() {
  await pool.query(`insert into properties (id,name) values ($1,$2)`, [PROP, PROP_NAME]);
  lines.push(`  scratch property ${PROP.slice(0, 8)} (${PROP_NAME})`);

  const actor = uuid(); track.users.push(actor);
  await pool.query(
    `insert into users (id,name,role,is_active,status) values ($1,'Billback QA PM [INTERNAL]','property_manager',true,'active')`,
    [actor]);
  const resident = uuid(); track.persons.push(resident);
  await pool.query(
    `insert into persons (id,name,lifecycle_status) values ($1,'Billback QA Resident [INTERNAL]','tenant')`,
    [resident]);

  svc = makeWorkOrderService({ spawnObligationFromEvent });
  const app = express();
  app.use(express.json());
  app.use("/", maintenanceModule({ pool, spawnObligationFromEvent, workOrderService: svc }));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;

  // ════════ A · THE OBSERVATION SPAWNS A DECISION, NOT A BILLBACK ════
  section("A · an observation creates a decision someone owes");
  const woA = await post("/work-orders", {
    property_id: PROP, title: "Resident put a hole in the drywall",
    field_category: "drywall", cause: "improper_use",
    tenant_caused: true, affected_person_id: resident,
  });
  const idA = woA.json.work_order && woA.json.work_order.id;
  ok("A1. tenant_caused=true spawns a billback_decision obligation",
    woA.status === 201 && (await oblFor(idA)).length === 1,
    `status=${woA.status} obligations=${(await oblFor(idA)).length}`);

  const oA = (await oblFor(idA))[0] || {};
  ok("A2. NO billback fact exists yet — only a question someone owes",
    (await entriesFor(idA)).length === 0,
    `decision entries found: ${(await entriesFor(idA)).length} — an observation must not become a billback`);

  ok("A3. it is BORN OPEN, never born complete  [agent_review defect 1]",
    oA.status === "open" && oA.completed_at === null,
    `status=${oA.status} completed_at=${oA.completed_at}`);

  ok("A4. a machine may not decide to charge a resident",
    oA.owner_type === "human", `owner_type=${oA.owner_type}`);

  ok("A5. ownership provenance is RECORDED, so 'unassigned' and 'absent' differ  [defect 3]",
    oA.ownership_origin !== null && oA.owner_eligibility_state !== null &&
      ((oA.assigned_user_id === null) === (oA.owner_eligibility_state === "unassigned")),
    `origin=${oA.ownership_origin} eligibility=${oA.owner_eligibility_state} user=${oA.assigned_user_id}`);

  ok("A6. the decision is the required input, and it is not yet satisfied",
    Array.isArray(oA.required_inputs) && oA.required_inputs.includes("billback_decision"),
    JSON.stringify(oA.required_inputs));

  ok("A7. due_at is honestly NULL — no invented SLA",
    oA.due_at === null, `due_at=${oA.due_at}`);

  // ── an observation of FALSE, or none at all, owes nothing ──
  const woNo = await post("/work-orders", {
    property_id: PROP, title: "Ordinary wear", field_category: "paint",
    cause: "normal_wear", tenant_caused: false,
  });
  ok("A8. tenant_caused=false spawns NOTHING — there is no question to answer",
    (await oblFor(woNo.json.work_order.id)).length === 0);

  const woUnk = await post("/work-orders", {
    property_id: PROP, title: "Cause not established", field_category: "plumbing",
  });
  ok("A9. an UNOBSERVED cause spawns nothing — unknown is not an accusation",
    (await oblFor(woUnk.json.work_order.id)).length === 0);

  // ── retry safety ──
  const dupe = await post("/work-orders", {
    property_id: PROP, title: "Retry", field_category: "drywall",
    tenant_caused: true, idempotency_key: "billback-retry-1",
  });
  const dupe2 = await post("/work-orders", {
    property_id: PROP, title: "Retry", field_category: "drywall",
    tenant_caused: true, idempotency_key: "billback-retry-1",
  });
  ok("A10. a retry does not create a second decision to make",
    dupe2.json.work_order && dupe.json.work_order &&
      dupe2.json.work_order.id === dupe.json.work_order.id &&
      (await oblFor(dupe.json.work_order.id)).length === 1,
    `wo same=${dupe2.json.work_order && dupe2.json.work_order.id === dupe.json.work_order.id} obl=${(await oblFor(dupe.json.work_order.id)).length}`);

  // ════════ B · THE DECISION IS ATTRIBUTED AND REASONED ══════════════
  section("B · a decision carries an actor, a time and a reason");
  const client = await pool.connect();
  let entry;
  try {
    await client.query("begin");
    entry = await svc.recordBillbackDecision(client, {
      work_order_id: idA, decision: "bill_back",
      actor_user_id: actor, reason: "Resident acknowledged putting the hole in the wall.",
    });
    await client.query("commit");
  } finally { client.release(); }

  ok("B1. the decision is recorded with actor, time and reason",
    !!entry && entry.decision === "bill_back" && entry.actor_user_id === actor &&
      !!entry.reason && !!entry.created_at,
    JSON.stringify(entry && { d: entry.decision, a: entry.actor_user_id, r: !!entry.reason }));

  ok("B2. NO AMOUNT IS INVENTED — bill_back with no known cost is amount NULL, not 0",
    entry && entry.amount_cents === null,
    `amount_cents=${entry && entry.amount_cents} — a zero here would be a fabricated number`);

  const oA2 = (await oblFor(idA))[0] || {};
  ok("B3. the obligation is now complete",
    oA2.status === "complete" && oA2.completed_at !== null,
    `status=${oA2.status}`);

  ok("B4. and it RECORDS HOW it closed  [agent_review defect 2 — 173 rows did not]",
    oA2.resolution_code === "satisfied", `resolution_code=${oA2.resolution_code}`);

  // ── a decision with no reason is refused ──
  let noReason = null;
  const c2 = await pool.connect();
  try {
    await c2.query("begin");
    await svc.recordBillbackDecision(c2, {
      work_order_id: dupe.json.work_order.id, decision: "bill_back", actor_user_id: actor,
    });
  } catch (e) { noReason = e.message; } finally {
    try { await c2.query("rollback"); } catch (_) {}
    c2.release();
  }
  ok("B5. a decision with no reason is REFUSED — no silent charges",
    noReason !== null && /reason/i.test(noReason || ""), String(noReason));

  // ── a decision with no actor is refused ──
  let noActor = null;
  const c3 = await pool.connect();
  try {
    await c3.query("begin");
    await svc.recordBillbackDecision(c3, {
      work_order_id: dupe.json.work_order.id, decision: "bill_back", reason: "because",
    });
  } catch (e) { noActor = e.message; } finally {
    try { await c3.query("rollback"); } catch (_) {}
    c3.release();
  }
  ok("B6. a decision with no human actor is REFUSED",
    noActor !== null && /actor/i.test(noActor || ""), String(noActor));

  // ── deciding NOT to charge is still a decision ──
  const c4 = await pool.connect();
  try {
    await c4.query("begin");
    await svc.recordBillbackDecision(c4, {
      work_order_id: dupe.json.work_order.id, decision: "do_not_bill_back",
      actor_user_id: actor, reason: "Wear consistent with normal use; not chargeable.",
    });
    await c4.query("commit");
  } finally { c4.release(); }
  const oDupe = (await oblFor(dupe.json.work_order.id))[0] || {};
  ok("B7. DECIDING NOT TO CHARGE completes it too — that is a decision, not an absence",
    oDupe.status === "complete" && oDupe.resolution_code === "satisfied",
    `status=${oDupe.status} rc=${oDupe.resolution_code}`);

  // ════════ C · CORRECTION, NEVER OVERWRITE ══════════════════════════
  section("C · a reversal is a correction that preserves what it corrected");
  const c5 = await pool.connect();
  let corr;
  try {
    await c5.query("begin");
    corr = await svc.recordBillbackCorrection(c5, {
      work_order_id: idA, supersedes_id: entry.id, decision: "do_not_bill_back",
      actor_user_id: actor, reason: "Manager reviewed the photo; damage predates this resident.",
    });
    await c5.query("commit");
  } finally { c5.release(); }

  const hist = await entriesFor(idA);
  ok("C1. the original decision still EXISTS — nothing was overwritten",
    hist.length === 2 && hist.some((e) => e.id === entry.id && e.decision === "bill_back"),
    `entries=${hist.length} ${JSON.stringify(hist.map((e) => e.entry_kind + ":" + e.decision))}`);

  ok("C2. the correction points at what it corrected, with its own actor and reason",
    !!corr && corr.supersedes_id === entry.id && corr.entry_kind === "correction" &&
      !!corr.reason && corr.actor_user_id === actor,
    JSON.stringify(corr && { k: corr.entry_kind, s: corr.supersedes_id === entry.id }));

  const state = await svc.readBillbackState(pool, { work_order_id: idA });
  ok("C3. CURRENT STATE IS A READ of the latest entry, not a stored status",
    state && state.decision === "do_not_bill_back" && state.entry_id === corr.id,
    JSON.stringify(state));

  ok("C4. the read exposes the observer AND the decider, so 'same person did both' is visible",
    state && "observed_by_same_actor" in state,
    JSON.stringify(state));

  // ── append-only: no update path, no delete path ──
  ok("C5. the service exposes NO update and NO delete for a decision",
    typeof svc.updateBillbackDecision === "undefined" &&
      typeof svc.deleteBillbackDecision === "undefined",
    `update=${typeof svc.updateBillbackDecision} delete=${typeof svc.deleteBillbackDecision}`);

  // ════════ D · MONEY IS NOT TOUCHED ═════════════════════════════════
  section("D · nothing here posts money");
  const money = (await pool.query(
    `select count(*)::int n from money_events where property_id=$1`, [PROP])).rows[0];
  ok("D1. no money_event was created by any of this",
    money.n === 0, `money_events=${money.n}`);

  // ── the dispute shape exists but is dormant ──
  ok("D2. the table ACCEPTS a dispute shape (designed, so we do not migrate twice)",
    (await pool.query(
      `select 1 from information_schema.columns
        where table_name='work_order_billback_decisions' and column_name='actor_person_id'`)).rows.length === 1);

  ok("D3. but NOTHING can file one yet — dormant by design, not by omission",
    typeof svc.recordBillbackDispute === "undefined",
    `recordBillbackDispute=${typeof svc.recordBillbackDispute} — a dispute needs a resident surface first`);
}

async function cleanup() {
  lines.push("");
  try {
    await pool.query("delete from work_order_billback_decisions where property_id=$1", [PROP]).catch(() => {});
    await pool.query("delete from obligations where property_id=$1", [PROP]);
    await pool.query("delete from work_orders where property_id=$1", [PROP]);
    await pool.query("delete from events where property_id=$1", [PROP]);
    if (track.users.length) await pool.query("delete from users where id = any($1::uuid[])", [track.users]);
    if (track.persons.length) await pool.query("delete from persons where id = any($1::uuid[])", [track.persons]);
    const gone = await pool.query(
      "delete from properties where id=$1 and name like '__BILLBACK__P %'", [PROP]);
    lines.push(`  cleanup complete. scratch property removed: ${gone.rowCount}`);
  } catch (e) {
    lines.push(`  CLEANUP FAILED — scratch ${PROP.slice(0, 8)} may remain: ${e.message}`);
  }
}

(async () => {
  try { await main(); }
  catch (e) {
    failed++;
    lines.push(`\n  FAIL  harness threw: ${e.message}\n        ${(e.stack || "").split("\n")[1] || ""}`);
  } finally {
    await cleanup();
    try { if (srv) srv.close(); } catch (_) {}
    await pool.end().catch(() => {});
  }
  const bar = "─".repeat(70);
  console.log(`\n${bar}\nBILLBACK — THE OBSERVATION IS NOT THE DECISION\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "The billback rail is not whole. Fix the failures above and re-run."
    : "An observation creates a decision someone owes; a decision is attributed, reasoned and reversible.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
})();
