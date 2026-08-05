#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  operations_reply_policy.db.js — REAL PostgreSQL.
//
//  Owner ruling 2026-08-04: the operations line may send outbound under a
//  strict reply_only policy. This proves the RULING IS STRUCTURAL — that
//  the things it forbids are rows the database refuses, not behaviours the
//  application remembers not to perform.
//
//  Migrations 130 (Slice A), 131, 132 and 133 are executed UNMODIFIED
//  against a scoped schema, in order, so the ordering itself is proven:
//  132 removes 130's outbound ban and must leave something stricter behind.
//
//  ── WHAT IT PROVES CANNOT EXIST ─────────────────────────────────────
//    · a proactive operations line
//    · an outbound flag that disagrees with its policy
//    · an operations reply that answers nothing
//    · an operations reply with no staff recipient, thread, reason or key
//    · two replies to one inbound message
//    · an operations message addressed to a resident
//    · a comm_event on a resident conversation AND a staff thread
//    · a work order with no human-sayable reference
//
//  ── SAFETY ──────────────────────────────────────────────────────────
//  HARNESS_DATABASE_URL only, no fallback, refuses if it matches
//  DATABASE_URL. Creates and drops its own scratch database. Opens no
//  transport; every number is in the reserved +1 555 01xx range.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const receipt = require("./_run_receipt");

const HARNESS = __filename;
const EXPECTED = 32;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const ADMIN_URL = receipt.harnessConnectionString();
const SCRATCH_DB = `ps_ops_reply_${process.pid}`;
const ROOT = path.join(__dirname, "..");
const mig = (n) => fs.readFileSync(path.join(ROOT, "migrations", n), "utf8");

let sawFatalDbError = null;
const noteDbError = (e) => {
  const m = String((e && e.message) || e);
  if (/does not exist|42P01|42703|syntax error/i.test(m)) sawFatalDbError = sawFatalDbError || m;
};
const errOf = async (db, sql, params) => {
  try { await db.query(sql, params); return null; } catch (e) { return String(e.message || ""); }
};

const SCOPED_SCHEMA = fs.readFileSync(path.join(__dirname, "_ops_scoped_schema.sql"), "utf8");

receipt.begin(HARNESS, { url: ADMIN_URL, expected: EXPECTED });

let admin = null, db = null, code = 1;
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
  await db.query(SCOPED_SCHEMA);

  // ── MIGRATIONS, IN ORDER, UNMODIFIED ───────────────────────────────
  section("1. 130 → 131 → 132 → 133 APPLY IN ORDER");
  for (const n of ["130_communication_lines.sql", "131_work_acceptance.sql",
                   "132_outbound_line_policy.sql", "133_work_order_reference.sql"]) {
    let e = null;
    try { await db.query(mig(n)); } catch (err) { e = err; noteDbError(err); }
    ok(`${n} applies cleanly, verbatim`, e === null, e && e.message);
  }
  ok("132 is idempotent",
    await (async () => { try { await db.query(mig("132_outbound_line_policy.sql")); return true; }
                         catch (e) { noteDbError(e); return false; } })());
  ok("133 is idempotent",
    await (async () => { try { await db.query(mig("133_work_order_reference.sql")); return true; }
                         catch (e) { noteDbError(e); return false; } })());

  // ── FIXTURES ───────────────────────────────────────────────────────
  const org = (await db.query(`insert into organizations (name,slug) values ('Harness Org','harness') returning id`)).rows[0].id;
  const prop = (await db.query(`insert into properties (name, organization_id) values ('Maple',$1) returning id`, [org])).rows[0].id;
  const dana = (await db.query(`insert into users (name,email,phone) values ('Dana','d@h.test','+12125550110') returning id`)).rows[0].id;
  const person = (await db.query(`insert into persons (property_id,name) values ($1,'Resident') returning id`, [prop])).rows[0].id;
  await db.query(`insert into property_team_assignments (property_id,user_id) values ($1,$2)`, [prop, dana]);

  const opsLine = (await db.query(
    `insert into communication_lines (e164, line_type, organization_id, authority_ceiling,
       permitted_audience, inbound_enabled, outbound_enabled, outbound_policy, status)
     values ('+12125550120','operations',$1,'operational','staff',true,true,'reply_only','active') returning id`,
    [org])).rows[0].id;
  const propLine = (await db.query(
    `insert into communication_lines (e164, line_type, property_id, authority_ceiling,
       permitted_audience, inbound_enabled, outbound_enabled, outbound_policy, status)
     values ('+12125550121','property_facing',$1,'external','residents_and_prospects',true,true,'proactive','active') returning id`,
    [prop])).rows[0].id;

  // ── THE POLICY IS STRUCTURAL ───────────────────────────────────────
  section("2. THE POLICY, BY CONSTRAINT NAME");
  {
    let m = await errOf(db, `update communication_lines set outbound_policy='proactive' where id=$1`, [opsLine]);
    ok("A PROACTIVE OPERATIONS LINE CANNOT EXIST — ck_cl_outbound_policy_by_type",
      !!m && m.includes("ck_cl_outbound_policy_by_type"), m);

    //  Tested on the PROPERTY-FACING line deliberately: on an operations
    //  line ck_cl_outbound_policy_by_type fires first and the vocabulary
    //  constraint is never reached, so asserting it there proves the wrong
    //  constraint. The first cut did exactly that.
    m = await errOf(db, `update communication_lines set outbound_policy='broadcast' where id=$1`, [propLine]);
    ok("the policy vocabulary is frozen — ck_cl_outbound_policy_vocab",
      !!m && m.includes("ck_cl_outbound_policy_vocab"), m);

    m = await errOf(db, `update communication_lines set outbound_enabled=false where id=$1`, [opsLine]);
    ok("the legacy flag cannot disagree with the policy — ck_cl_outbound_flag_matches_policy",
      !!m && m.includes("ck_cl_outbound_flag_matches_policy"), m);

    const gone = (await db.query(
      `select 1 from pg_constraint where conname='ck_cl_outbound_disabled_slice_a'`)).rows.length === 0;
    ok("130's blanket outbound ban is REPLACED, not merely dropped",
      gone && (await db.query(`select 1 from pg_constraint where conname='ck_cl_outbound_policy_by_type'`)).rows.length === 1);

    ok("a property-facing line MAY be proactive — resident communication is unchanged",
      (await db.query(`select outbound_policy from communication_lines where id=$1`, [propLine])).rows[0].outbound_policy === "proactive");
  }

  // ── THE FIVE BINDINGS ──────────────────────────────────────────────
  section("3. AN OPERATIONS REPLY MUST BE REPLY-BOUND");
  const thread = (await db.query(
    `insert into staff_threads (organization_id,user_id) values ($1,$2) returning id`, [org, dana])).rows[0].id;
  const inbound = (await db.query(
    `insert into comm_events (channel, direction, body, communication_line_id, staff_thread_id,
       actor_user_id, sms_sid)
     values ('sms','inbound','accept 1000',$1,$2,$3,'SM_HARNESS_IN_1') returning id`,
    [opsLine, thread, dana])).rows[0].id;
  ok("an INBOUND operations message records without reply bindings", !!inbound);

  const outbound = (over = {}) => {
    const o = Object.assign({
      in_reply_to_comm_event_id: inbound, to_user_id: dana, staff_thread_id: thread,
      reply_reason: "execution_receipt", correlation_key: "SM_HARNESS_IN_1:accept", person_id: null,
    }, over);
    return [`insert into comm_events (channel, direction, body, communication_line_id,
              in_reply_to_comm_event_id, to_user_id, staff_thread_id, reply_reason, correlation_key, person_id)
             values ('sms','outbound','ok',$1,$2,$3,$4,$5,$6,$7) returning id`,
            [opsLine, o.in_reply_to_comm_event_id, o.to_user_id, o.staff_thread_id,
             o.reply_reason, o.correlation_key, o.person_id]];
  };

  for (const [label, over, needle] of [
    ["answers nothing", { in_reply_to_comm_event_id: null }, "answers nothing"],
    ["names no staff recipient", { to_user_id: null }, "staff recipient"],
    ["belongs to no staff thread", { staff_thread_id: null }, "staff thread"],
    ["states no governed reason", { reply_reason: null }, "governed reason"],
    ["carries no correlation key", { correlation_key: null }, "correlation key"],
  ]) {
    const [sql, params] = outbound(over);
    // eslint-disable-next-line no-await-in-loop
    const m = await errOf(db, sql, params);
    ok(`an operations reply that ${label} is refused`, !!m && m.includes(needle), m);
  }

  {
    const [sql, params] = outbound({ person_id: person });
    const m = await errOf(db, sql, params);
    ok("AN OPERATIONS LINE MAY NOT ADDRESS A RESIDENT", !!m && m.includes("may not address a resident"), m);
  }
  {
    const [sql, params] = outbound({ reply_reason: "marketing_blast" });
    const m = await errOf(db, sql, params);
    ok("the reply-reason vocabulary is frozen — ck_comm_reply_reason_vocab",
      !!m && m.includes("ck_comm_reply_reason_vocab"), m);
  }

  //  The valid one.
  {
    const [sql, params] = outbound();
    const r = await db.query(sql, params);
    ok("a fully bound execution receipt IS permitted", r.rows.length === 1);
    const m = await errOf(db, ...outbound());
    ok("TWO REPLIES TO ONE INBOUND MESSAGE CANNOT EXIST — uq_comm_events_correlation_key",
      !!m && m.includes("uq_comm_events_correlation_key"), m);
  }

  for (const reason of ["clarification", "governed_read", "authorization_refusal", "delivery_failure_notice"]) {
    const [sql, params] = outbound({ reply_reason: reason, correlation_key: `SM_HARNESS_IN_1:${reason}` });
    // eslint-disable-next-line no-await-in-loop
    const m = await errOf(db, sql, params);
    ok(`a '${reason}' reply is permitted`, m === null, m);
  }

  // ── THREAD SEPARATION ──────────────────────────────────────────────
  section("4. A MESSAGE HAS ONE AUDIENCE");
  {
    const convo = (await db.query(
      `insert into conversations (property_id, person_id) values ($1,$2) returning id`, [prop, person])).rows[0].id;
    const m = await errOf(db,
      `insert into comm_events (channel, direction, body, conversation_id, staff_thread_id)
       values ('sms','inbound','x',$1,$2)`, [convo, thread]);
    ok("a comm_event on a resident conversation AND a staff thread is refused — ck_comm_one_thread",
      !!m && m.includes("ck_comm_one_thread"), m);

    const m2 = await errOf(db,
      `insert into comm_events (channel, direction, body, communication_line_id,
         in_reply_to_comm_event_id, to_user_id, conversation_id, reply_reason, correlation_key)
       values ('sms','outbound','x',$1,$2,$3,$4,'clarification','SM_WRONGTHREAD')`,
      [opsLine, inbound, dana, convo]);
    ok("an operations reply on a RESIDENT conversation is refused",
      !!m2 && m2.includes("staff thread"), m2);
  }

  // ── DISABLED STILL MEANS DISABLED ──────────────────────────────────
  section("5. DISABLED IS STILL DISABLED");
  {
    await db.query(`update communication_lines set outbound_policy='disabled', outbound_enabled=false where id=$1`, [opsLine]);
    const [sql, params] = outbound({ correlation_key: "SM_DISABLED" });
    const m = await errOf(db, sql, params);
    ok("a disabled line refuses even a perfectly bound reply", !!m && m.includes("outbound_policy=disabled"), m);
    await db.query(`update communication_lines set outbound_policy='reply_only', outbound_enabled=true where id=$1`, [opsLine]);
  }

  // ── A NUMBER A HUMAN CAN SAY ───────────────────────────────────────
  section("6. WORK-ORDER REFERENCE");
  {
    const a = (await db.query(`insert into work_orders (property_id,title) values ($1,'A') returning id, work_order_ref`, [prop])).rows[0];
    const b = (await db.query(`insert into work_orders (property_id,title) values ($1,'B') returning id, work_order_ref`, [prop])).rows[0];
    ok("every work order gets a reference with no application change",
      Number(a.work_order_ref) >= 1000 && Number(b.work_order_ref) === Number(a.work_order_ref) + 1,
      `${a.work_order_ref} → ${b.work_order_ref}`);
    const m = await errOf(db, `update work_orders set work_order_ref=$2 where id=$1`, [b.id, a.work_order_ref]);
    ok("references are unique — uq_work_orders_ref", !!m && m.includes("uq_work_orders_ref"), m);
    const m2 = await errOf(db, `update work_orders set work_order_ref=null where id=$1`, [b.id]);
    ok("a work order with no sayable reference cannot exist", !!m2 && /null/i.test(m2), m2);
  }

  section("7. RUN VALIDITY");
  ok("no swallowed database error anywhere in the run", sawFatalDbError === null, sawFatalDbError || "");

  code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
} catch (e) {
  code = receipt.died(HARNESS, e, passed + failed);
} finally {
  try { if (db) await db.end(); } catch { /* closing is not a proof step */ }
  try { if (admin) { await admin.query(`drop database if exists ${SCRATCH_DB}`); await admin.end(); } }
  catch (e) { console.error("  scratch cleanup failed:", e.message); }
}
process.exit(code);
})();
