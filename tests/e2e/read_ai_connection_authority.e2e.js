/*  ════════════════════════════════════════════════════════════════════
    read_ai_connection_authority.e2e.js — A REVOKED READ AI CONNECTION
    STAYS REVOKED.

    POST /operator/meeting-evidence/read-ai/connection upserts the one
    provider connection. Its ON CONFLICT set connection_status = 'active'
    unconditionally, so a connection an administrator had revoked to stop
    ingress came back to life the moment any meeting-evidence user (three
    modules qualify) called the route again. Proven shut here: revoked →
    409, nothing written, still revoked.

    CLASSIFIED, not decided: on a re-post the ORIGINAL authorizer stays on
    the row. Delivery-finality qualification is bound to that user, so
    rewriting it on re-post would hand that authority to whoever posted
    last. Asserted so it cannot drift silently. Whether a different user
    may re-authorize at all is an owner decision.

    Runs against the REAL server.js the verification parent booted, which
    names the connection id in its environment (tests/e2e/boot.sh).
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const CONNECTION = "11111111-2222-4333-8444-555555555555";
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
async function post(session, body = {}) {
  const r = await fetch(API + "/operator/meeting-evidence/read-ai/connection", { method: "POST",
    headers: { "content-type": "application/json", "x-staff-session": session }, body: J(body) });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const row = () => one("select authorized_by_user_id, connection_status, provider_account_metadata from integration_connections where id=$1", [CONNECTION]);

(async () => {
  const tag = "RAC" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'3 Meeting Way') returning id", [tag + " Meetings"])).id;
  const mkUser = async (n) => (await one(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'property_manager',true,'active','human_staff') returning id`, [tag + " " + n, `${tag}-${n}@example.com`])).id;
  const seat = (user) => pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof','property','{management}','{management}',false,true)`, [prop, user]);
  const session = async (user) => { const c = await pool.connect();
    try { await c.query("begin"); const s = await staffSessions.issueStaffSession(c, { userId: user, propertyId: prop, purpose: "sms_otp" }); await c.query("commit"); return s.session_token; }
    catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
  const first = await mkUser("First"); await seat(first); const tokFirst = await session(first);
  const other = await mkUser("Other"); await seat(other); const tokOther = await session(other);
  //  the one connection row is shared by the whole database; start from a known state
  await pool.query("delete from integration_connections where id=$1", [CONNECTION]).catch(() => {});

  console.log("\n── 1 · first authorization ──");
  const a = await post(tokFirst, { provider_metadata: { workspace: tag } });
  let r = await row();
  check("POST → 200 active, authorized by the first user", a.status === 200 && a.body.connection_status === "active" && r && r.authorized_by_user_id === first, `${a.status} ${J(a.body)}`);

  console.log("\n── 2 · a REVOKED connection is not re-opened by a re-post ──");
  await pool.query("update integration_connections set connection_status='revoked', updated_at=now() where id=$1", [CONNECTION]);
  const b = await post(tokOther, { provider_metadata: { workspace: tag + " again" } });
  r = await row();
  check("re-post against a revoked connection → 409 read_ai_connection_revoked (was: 200, active again)", b.status === 409 && b.body && b.body.code === "read_ai_connection_revoked", `${b.status} ${J(b.body)}`);
  check("…the row is still revoked and its metadata untouched", r.connection_status === "revoked" && r.provider_account_metadata && r.provider_account_metadata.workspace === tag, J(r));
  const b2 = await post(tokFirst);
  check("…even from the original authorizer: 409, still revoked", b2.status === 409 && (await row()).connection_status === "revoked", `${b2.status}`);

  console.log("\n── 3 · CLASSIFIED, not decided: on an ACTIVE connection a re-post by another user leaves the ORIGINAL authorizer ──");
  await pool.query("update integration_connections set connection_status='active', updated_at=now() where id=$1", [CONNECTION]);
  const c = await post(tokOther, { provider_metadata: { workspace: tag + " re-post" } });
  r = await row();
  check("[classified] re-post by another user → 200; authorized_by_user_id is STILL the first user (finality qualification is bound to it)",
        c.status === 200 && r.authorized_by_user_id === first && r.connection_status === "active", `${c.status} ${J(r)}`);

  await pool.query("delete from integration_connections where id=$1", [CONNECTION]).catch(() => {});
  await pool.end();
  console.log(`\n══ read ai connection authority: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
