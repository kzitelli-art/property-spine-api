/*  ════════════════════════════════════════════════════════════════════
    outbound_text_approval_instant.e2e.js — NO APPROVER, NO APPROVAL
    INSTANT.

    recordOutboundText (src/leasing/leasing_interactions.js) is the one
    interaction ledger for a human's outbound text. It stamped
    human_approved_at = now() on BOTH branches of
    `human_approved_by_user_id ? now : now`, so every staff text carried
    an approval instant with no approver — the drafted/approved split the
    ledger exists to keep was falsified on every row. The agent's own
    writer (src/agent/agent.js) already stamps `null` when nobody
    approved. Proven here through the Person Card's reply door: the ledger
    row names the sender and carries no approval instant when no one
    approved.

    Runs against the REAL server.js the verification parent booted (its
    SMS transport is the harness fake; no phone is reached).
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

(async () => {
  const tag = "OTA" + Math.floor(Math.random() * 1e6);
  const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  const prop = (await one("insert into properties (name,address) values ($1,'17 Ledger Row') returning id", [tag + " Texts"])).id;
  const person = (await one("insert into persons (name, primary_phone_e164) values ($1,$2) returning id", [tag + " Prospect", "+1555" + digits])).id;
  const conversation = (await one("insert into conversations (property_id, person_id) values ($1,$2) returning id", [prop, person])).id;
  const user = (await one(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'leasing_agent',true,'active','human_staff') returning id`, [tag + " Agent", `${tag}@example.com`])).id;
  await pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Leasing','property','{leasing}','{leasing}',false,true)`, [prop, user]);
  const c = await pool.connect();
  let session;
  try { await c.query("begin"); session = (await staffSessions.issueStaffSession(c, { userId: user, propertyId: prop, purpose: "sms_otp" })).session_token; await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  console.log("\n── a human sends a text from the Person Card; nobody 'approved' anything ──");
  const r = await fetch(`${API}/operator/leasing/conversations/${conversation}/reply`, { method: "POST",
    headers: { "content-type": "application/json", "x-staff-session": session }, body: J({ body: `Hi from ${tag}` }) });
  const body = await r.json().catch(() => null);
  check("POST /operator/leasing/conversations/:id/reply → 200 (recorded; delivery is the harness fake)", r.status === 200 && body && typeof body.receipt === "string", `${r.status} ${J(body).slice(0, 200)}`);
  const row = await one(
    `select actor_user_id, sent_by_user_id, ai_drafted_at, human_approved_by_user_id, human_approved_at
       from comm_events where conversation_id=$1 and direction='outbound' order by occurred_at desc limit 1`, [conversation]);
  check("the ledger row names the session user as actor and sender", !!row && row.actor_user_id === user && row.sent_by_user_id === user, J(row));
  check("…was not AI-drafted and names no approver", !!row && row.ai_drafted_at === null && row.human_approved_by_user_id === null, J(row));
  check("…and carries NO approval instant (was: now() with no approver)", !!row && row.human_approved_at === null, J(row && { human_approved_at: row.human_approved_at }));

  await pool.end();
  console.log(`\n══ outbound text approval instant: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
