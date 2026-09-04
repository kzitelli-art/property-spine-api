/* ════════════════════════════════════════════════════════════════════
   audit_fixes_real_server.db.js — THE 2026-09-04 AUDIT FIXES, THROUGH THE REAL SERVER (first harness)

   Born as a scratch harness on the 2026-09-04 audit passes and committed
   so CI runs it (tests/proofs/db_proofs.manifest). Every assertion here
   was first shown RED on the commit before its fix, then GREEN with it —
   the counts are in docs/CURRENT_STATE.md.

   Real Postgres (HARNESS_DATABASE_URL, same-target guarded), the REAL server.js booted as a child process against that database, real staff sessions issued by the canonical issuer.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..", "..");
const receipt = require("../_run_receipt");
const R = (m) => require(require.resolve(m, { paths: [REPO, REPO + "/node_modules"] }));
const { Pool } = R("pg"); const { spawn } = require("child_process"); const crypto = require("crypto");
const URL_ = receipt.harnessConnectionString(); // refuses when it is the same target as DATABASE_URL
const PORT = 3300 + (process.pid % 600), KEY = "test-key", READ_AI = "11111111-2222-4333-8444-555555555555";
const TAG = "cleanup-" + Date.now();
const SUF = String(Date.now()).slice(-4); // per-run phone suffix: the harness DB is not reset between runs
let fails = 0, passes = 0; const T = (n, ok, d) => { console.log(`  ${ok ? "ok   " : "FAIL "} ${n}${ok ? "" : "   <- " + String(d).slice(0, 300)}`); if (ok) passes++; else fails++; };
const J = (b) => JSON.stringify(b);
const call = async (m, p, { key = true, session = null, tenant = null, body = undefined } = {}) => {
  const h = { "content-type": "application/json" };
  if (key) h["x-operator-key"] = KEY; if (session) h["x-staff-session"] = session; if (tenant) h["x-tenant-session"] = tenant;
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: h, body: body === undefined ? undefined : J(body) });
  let b = null; try { b = await r.json(); } catch (_) {}
  return { status: r.status, body: b };
};

(async () => {
  receipt.begin(__filename, { url: URL_, expected: 36 });
  const pool = new Pool({ connectionString: URL_, ssl: false });
  const q = (sql, params) => pool.query(sql, params);
  const one = async (sql, params) => (await q(sql, params)).rows[0];
  const svc = R(REPO + "/src/identity/staff_session_service");

  // ── BOOT THE REAL SERVER ──
  const env = { ...process.env, DATABASE_URL: URL_, OPERATOR_KEY: KEY, OPERATOR_APP_ORIGIN: "http://localhost:8080",
                PORT: String(PORT), ANTHROPIC_API_KEY: "sk-test", READ_AI_CONNECTION_ID: READ_AI };
  delete env.DEMO_MODE; delete env.NODE_ENV; delete env.HARNESS_DATABASE_URL;
  //  ASK BEFORE LAUNCHING (tests/e2e/port_guard.sh's rule). A server left
  //  behind by an earlier run answers /health just as cheerfully — pointed
  //  at a different database — and every assertion then lies. Refuse.
  try { await fetch(`http://127.0.0.1:${PORT}/health`); console.error(`REFUSED: port ${PORT} already answers — a stale server.js is listening.`); process.exit(2); } catch (_) {}
  const srv = spawn("node", ["server.js"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  //  The child must not outlive this process, however this process ends.
  process.on("exit", () => { try { srv.kill("SIGTERM"); } catch (_) {} });
  let log = ""; srv.stdout.on("data", (d) => { log += d; }); srv.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch (_) {} await new Promise((x) => setTimeout(x, 500)); }
  const health = await call("GET", "/health", { key: false });
  T("real server.js boots against the harness schema", health.status === 200 && health.body.ok === true, J(health.body));

  // ── SEED ──
  const orgA = (await one(`insert into organizations (name) values ($1) returning id`, [TAG + "-orgA"])).id;
  const orgB = (await one(`insert into organizations (name) values ($1) returning id`, [TAG + "-orgB"])).id;
  const propA = (await one(`insert into properties (name, organization_id) values ($1,$2) returning id`, [TAG + "-A", orgA])).id;
  const propB = (await one(`insert into properties (name, organization_id) values ($1,$2) returning id`, [TAG + "-B", orgB])).id;
  const mkUser = async (n, extra = {}) => (await one(
    `insert into users (name,email,phone,role,is_active,status,platform_role,organization_id)
     values ($1,$2,$3,'property_manager',true,'active',$4,$5) returning id`,
    [n, `${n}@${TAG}.test`, extra.phone || ("+1724555" + Math.floor(Math.random() * 9000 + 1000)), extra.platform_role || "member", extra.org || null])).id;
  const assign = (u, p, mods = ["leasing", "maintenance", "management"], manage = false) => q(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof','property',$3,$3,$4,true)`, [p, u, mods, manage]);
  const session = async (u, p) => { const c = await pool.connect(); try { await c.query("begin");
    const s = await svc.issueStaffSession(c, { userId: u, propertyId: p, purpose: "sms_otp" }); await c.query("commit"); return s.session_token;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };

  const adminA = await mkUser("adminA", { platform_role: "org_admin", org: orgA }); await assign(adminA, propA, ["leasing", "maintenance", "management"], true);
  const tokA = await session(adminA, propA);
  const victimPhone = "+1724" + "55" + SUF + "0";
  const victim = await mkUser("victim", { org: orgB, phone: victimPhone }); await assign(victim, propB);

  // ── T1 ORG INVITE: cross-org takeover refused; phone-only invite works ──
  {
    const r = await call("POST", "/org/users/invite", { key: false, session: tokA,
      body: { name: "Attacker Name", phone: "724" + "56" + SUF + "1", email: `victim@${TAG}.test`, property_id: propA, role_key: "leasing_agent" } });
    const v = await one(`select organization_id, phone from users where id=$1`, [victim]);
    T("T1a inviting another org's user by EMAIL → 409, not adopted", r.status === 409 && r.body.error === "user_belongs_to_another_organization", `${r.status} ${J(r.body)}`);
    T("T1b …their organization and sign-in phone are untouched", v.organization_id === orgB && v.phone === victimPhone, J(v));
    const r2 = await call("POST", "/org/users/invite", { key: false, session: tokA,
      body: { name: "Attacker Name", phone: "(724) 55" + SUF + "-0".replace("-","") , property_id: propA, role_key: "leasing_agent" } });
    T("T1c inviting another org's user by PHONE → 409", r2.status === 409, `${r2.status} ${J(r2.body)}`);
    const r3 = await call("POST", "/org/users/invite", { key: false, session: tokA,
      body: { name: "New Tech", phone: "724" + "57" + SUF + "2", property_id: propA, role_key: "maintenance_tech" } });
    T("T1d phone-only invite of a NEW person → 201 (no 42P10)", r3.status === 201 && r3.body.user && r3.body.user.id, `${r3.status} ${J(r3.body)}`);
    const r4 = await call("POST", "/org/users/invite", { key: false, session: tokA,
      body: { name: "New Tech Renamed", phone: "+1 724 " + "57" + SUF + "2", property_id: propA, role_key: "maintenance_tech" } });
    T("T1e re-inviting the same phone hits the expression-index conflict path → same user, updated", r4.status === 201 && r4.body.user.id === r3.body.user.id && r4.body.user.name === "New Tech Renamed", `${r4.status} ${J(r4.body)}`);
  }

  // ── residents, units, leases ──
  const person = async (n) => (await one(`insert into persons (name) values ($1) returning id`, [n])).id;
  const unit = async (n, p = propA) => (await one(`insert into units (property_id, unit_number) values ($1,$2) returning id`, [p, n])).id;
  const spaceOf = async (u) => (await one(`select id from spaces where unit_id=$1 order by created_at limit 1`, [u])).id;
  const lease = async (u, ids, p = propA, status = "active") => (await one(
    `insert into leases (property_id, space_id, tenant_ids, lease_status, start_date, end_date, rent)
     values ($1,$2,$3,$4, current_date - 30, current_date + 300, 1500) returning id`, [p, await spaceOf(u), ids, status])).id;
  const P = await person("Resident One"); const u1 = await unit("101"); const L1 = await lease(u1, [P]);
  const tenantTok = "tenant-" + TAG;
  await q(`insert into tenant_sessions (person_id, property_id, token, expires_at) values ($1,$2,$3, now() + interval '1 hour')`, [P, propA, tenantTok]);
  const woAffected = (await one(`insert into work_orders (property_id, unit_id, affected_person_id, title, status) values ($1,$2,$3,'Kitchen leak','open') returning id`, [propA, u1, P])).id;
  const woReported = (await one(`insert into work_orders (property_id, unit_id, reported_by_person_id, title, status) values ($1,$2,$3,'Hall light','open') returning id`, [propA, u1, P])).id;

  // ── T2 /tenant/me — the resident portal home ──
  {
    const r = await call("GET", "/tenant/me", { key: false, tenant: tenantTok });
    const ids = ((r.body && r.body.open_work_orders) || []).map((w) => w.id).sort();
    T("T2  GET /tenant/me → 200 (was a 500 on a dropped column)", r.status === 200, `${r.status} ${J(r.body)}`);
    T("T2b …lists the work order that AFFECTS the resident and the one they REPORTED", ids.length === 2 && ids.includes(woAffected) && ids.includes(woReported), J(ids));
  }

  // ── T3 sms-number: one client, atomic, no idle-in-transaction connection left behind ──
  {
    const r = await call("POST", `/properties/${propA}/sms-number`, { body: { sms_number: "215" + "50" + SUF + "8" } });
    const idle = await one(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`);
    const lines = (await q(`select e164, status from communication_lines where property_id=$1 order by created_at`, [propA])).rows;
    T("T3  set the property line → 200", r.status === 200, `${r.status} ${J(r.body)}`);
    T("T3b no connection is left idle-in-transaction", idle.n === 0, `idle in transaction: ${idle.n}`);
    const r2 = await call("POST", `/properties/${propA}/sms-number`, { body: { sms_number: "215" + "50" + SUF + "9" } });
    const lines2 = (await q(`select e164, status from communication_lines where property_id=$1 order by created_at`, [propA])).rows;
    T("T3c replacing it retires the old line and activates the new one in ONE transaction", r2.status === 200 && lines2.length === 2 && lines2[0].status === "retired" && lines2[1].status === "active" && lines2[1].e164 === "+1215" + "50" + SUF + "9", J(lines2));
  }

  // ── T4 notice writes space_id; the canonical space reader can see it ──
  {
    const r = await call("POST", `/units/${u1}/notice`, { body: { move_out_date: "2027-01-31" } });
    const ev = await one(`select space_id, status from unit_events where unit_id=$1 and event_type='notice_given' order by created_at desc limit 1`, [u1]);
    const sid = await spaceOf(u1);
    T("T4  POST /units/:id/notice → 201", r.status === 201, `${r.status} ${J(r.body)}`);
    T("T4b unit_events.space_id is the resolved space (was NULL — invisible to space_position)", ev && ev.space_id === sid, J(ev));
    const seen = await one(`select effective_date from unit_events ue join spaces s on ue.space_id=s.id where s.id=$1 and ue.event_type='notice_given' and ue.status='scheduled'`, [sid]);
    T("T4c the space reader's own predicate now finds the notice", !!seen, J(seen));
  }

  // ── T5 tours: settled tours refuse; a scheduled one still cancels ──
  {
    const lead = (await one(`insert into leasing_leads (person_id, property_id, status) values ($1,$2,'tour_scheduled') returning id`, [P, propA])).id;
    const done = (await one(`insert into leasing_tours (lead_id, property_id, status, scheduled_for, completed_at) values ($1,$2,'completed', now() - interval '1 day', now() - interval '1 day') returning id`, [lead, propA])).id;
    await q(`insert into tour_events (tour_id, lead_id, event_type, actor_type, metadata) values ($1,$2,'completed','human',$3)`, [done, lead, J({ outcome: { disposition: "hot" } })]);
    for (const verb of ["cancel", "no-show"]) {
      const r = await call("POST", `/leasing/tours/${done}/${verb}`, { body: { reason: "test" } });
      T(`T5  ${verb} on a COMPLETED tour → 409, outcome kept`, r.status === 409 && /already completed/.test(r.body.receipt || ""), `${r.status} ${J(r.body)}`);
    }
    const still = await one(`select status from leasing_tours where id=$1`, [done]);
    T("T5b …status is still completed", still.status === "completed", J(still));
    const slot = (await one(`insert into tour_availability (property_id, starts_at, ends_at, status) values ($1, now() + interval '2 day', now() + interval '2 day 30 min', 'booked') returning id`, [propA])).id;
    const sched = (await one(`insert into leasing_tours (lead_id, property_id, status, scheduled_for, slot_id) values ($1,$2,'scheduled', now() + interval '2 day', $3) returning id`, [lead, propA, slot])).id;
    await q(`update tour_availability set booked_tour_id=$1 where id=$2`, [sched, slot]);
    const rc = await call("POST", `/leasing/tours/${sched}/cancel`, { body: {} });
    const after = await one(`select t.status, t.cancelled_at, a.status as slot_status from leasing_tours t join tour_availability a on a.id=$2 where t.id=$1`, [sched, slot]);
    T("T5c cancelling a SCHEDULED tour still works → 200, status cancelled, slot reopened", rc.status === 200 && after.status === "cancelled" && !!after.cancelled_at && after.slot_status === "open", `${rc.status} ${J(after)}`);
    const rx = await call("POST", `/leasing/tours/${done}/correct-outcome`, { session: tokA, body: { reason: "wrong disposition", revised: { disposition: "warm" } } });
    //  Migration 188 widened tour_events.event_type; the correction lane now
    //  lands an append-only outcome_corrected event and leaves status alone.
    const corr = await one(`select count(*)::int n from tour_events where tour_id=$1 and event_type='outcome_corrected'`, [done]);
    const stillDone = await one(`select status from leasing_tours where id=$1`, [done]);
    T("T5d correct-outcome → accepted, ONE outcome_corrected event, status still completed (was: 409 outcome_correction_not_enabled before 188)",
      rx.status === 200 && corr.n === 1 && stillDone.status === "completed", `${rx.status} ${J(rx.body).slice(0, 160)} events=${corr.n} status=${stillDone.status}`);
  }

  // ── T6 link-bank: a deposit proves cash only up to its own amount ──
  {
    const ba = (await one(`insert into bank_accounts (property_id, account_label, account_last4, bank_name) values ($1,'Operating','1234','Test Bank') returning id`, [propA])).id;
    const dep = (await one(`insert into bank_transactions (bank_account_id, txn_date, description, amount, txn_type) values ($1, current_date, 'ACH batch', 500, 'deposit') returning id`, [ba])).id;
    const pay = async (amt) => (await one(`insert into payments (property_id, person_id, lease_id, amount, paid_date) values ($1,$2,$3,$4, current_date) returning id`, [propA, P, L1, amt])).id;
    const p1 = await pay(500), p2 = await pay(500), p3 = await pay(200);
    const r1 = await call("POST", `/payments/${p1}/link-bank`, { body: { bank_transaction_id: dep } });
    T("T6  first $500 payment links to the $500 deposit → 200", r1.status === 200, `${r1.status} ${J(r1.body)}`);
    const r2 = await call("POST", `/payments/${p2}/link-bank`, { body: { bank_transaction_id: dep } });
    T("T6b second $500 payment against the SAME $500 deposit → 409 (deposit exhausted)", r2.status === 409 && r2.body.remaining === 0, `${r2.status} ${J(r2.body)}`);
    const r3 = await call("POST", `/payments/${p3}/link-bank`, { body: { bank_transaction_id: dep, amount_matched: 300 } });
    T("T6c a link attributing more than its own payment → 409", r3.status === 409 && /cannot attribute more/.test(r3.body.receipt || ""), `${r3.status} ${J(r3.body)}`);
    const links = await one(`select count(*)::int as n, coalesce(sum(amount_matched),0)::numeric as attributed from payment_bank_links where bank_transaction_id=$1`, [dep]);
    T("T6d exactly one link, attributing exactly the deposit", links.n === 1 && Number(links.attributed) === 500, J(links));
  }

  // ── T7 active pricing is the EFFECTIVE published version ──
  {
    const oldV = (await one(`insert into property_pricing_versions (property_id, status, effective_from, effective_until) values ($1,'published', now() - interval '60 day', now() - interval '1 day') returning id`, [propA])).id;
    const newV = (await one(`insert into property_pricing_versions (property_id, status, effective_from, effective_until) values ($1,'published', now() - interval '1 day', null) returning id`, [propA])).id;
    const r = await call("GET", `/pricing/${propA}/active`);
    T("T7  GET /pricing/:id/active returns the EFFECTIVE version, not an arbitrary published one", r.status === 200 && r.body.version && r.body.version.id === newV, `${r.status} ${J(r.body && r.body.version)} (old=${oldV})`);
  }

  // ── T8 move-in: a lease named must be this unit's ──
  {
    const uA = await unit("201"), uB = await unit("202"); const LB = await lease(uB, [await person("B Resident")]);
    const bad = await call("POST", `/units/${uA}/schedule-move-in`, { body: { move_in_date: "2027-03-01", lease_id: LB } });
    T("T8  scheduling unit A's move-in against unit B's lease → 409 LEASE_NOT_ON_UNIT", bad.status === 409 && (bad.body.code === "LEASE_NOT_ON_UNIT" || /not on this unit/.test(J(bad.body))), `${bad.status} ${J(bad.body)}`);
    const good = await call("POST", `/units/${uB}/schedule-move-in`, { body: { move_in_date: "2027-03-01", lease_id: LB } });
    T("T8b the same lease on ITS unit → 201", good.status === 201, `${good.status} ${J(good.body)}`);
  }

  // ── T9 a consumed application link stays 'already submitted' after its date ──
  {
    const raw = "tok-" + TAG; const digest = crypto.createHash("sha256").update(raw).digest("hex");
    const inv = (await one(`insert into application_invitations (token_digest, property_id, status, expires_at, consumed_at) values ($1,$2,'consumed', now() - interval '1 day', now() - interval '2 day') returning id`, [digest, propA])).id;
    const r = await call("GET", `/t/application/${raw}/context`, { key: false });
    const row = await one(`select status from application_invitations where id=$1`, [inv]);
    T("T9  consumed + past expiry → 'already_submitted' (was flipped to expired)", r.body && r.body.state === "already_submitted", `${r.status} ${J(r.body)}`);
    T("T9b …and the row still says consumed", row.status === "consumed", J(row));
  }

  // ── T10 Read AI connection: revoked stays revoked; re-authorization is recorded ──
  {
    const me = R(REPO + "/src/meeting_evidence/meeting_evidence_service");
    const u2 = await mkUser("authorizer2");
    await q(`delete from integration_connections where id=$1`, [READ_AI]);
    const a = await me.ensureReadAiConnection(pool, { connectionId: READ_AI, authorizedByUserId: adminA });
    T("T10 first authorization → active by adminA", a.connection_status === "active" && a.authorized_by_user_id === adminA, J(a));
    const b = await me.ensureReadAiConnection(pool, { connectionId: READ_AI, authorizedByUserId: u2 });
    T("T10b re-authorization by another user is RECORDED as theirs", b.authorized_by_user_id === u2, J(b));
    await q(`update integration_connections set connection_status='revoked' where id=$1`, [READ_AI]);
    let err = null; try { await me.ensureReadAiConnection(pool, { connectionId: READ_AI, authorizedByUserId: adminA }); } catch (e) { err = e; }
    const after = await one(`select connection_status from integration_connections where id=$1`, [READ_AI]);
    T("T10c a REVOKED connection refuses re-activation (409) and stays revoked", err && (err.status === 409 || err.httpStatus === 409 || /revoked/.test(err.message)) && after.connection_status === "revoked", `${err && err.message} / ${J(after)}`);
  }

  // ── T11 every live grant counts ──
  {
    const ac = R(REPO + "/src/identity/actor_context");
    const Pg = await person("Grant Holder"); const Ug = await mkUser("grantuser"); await assign(Ug, propA);
    await q(`update users set person_id=$1 where id=$2`, [Pg, Ug]);
    //  a grant hangs off a NON-full-authority assignment (leasing), so the
    //  capabilities must come from the grants themselves
    const asg = (await one(`insert into assignments (person_id, property_id, role, scope) values ($1,$2,'leasing','leasing') returning id`, [Pg, propA])).id;
    await q(`insert into concession_authority_grants (property_id, person_id, assignment_id, effective_from, may_review_pricing) values ($1,$2,$3, now() - interval '1 day', true)`, [propA, Pg, asg]);
    await q(`insert into concession_authority_grants (property_id, person_id, assignment_id, effective_from, may_publish_public_offers) values ($1,$2,$3, now() - interval '1 day', true)`, [propA, Pg, asg]);
    const ctx = await ac.resolveActorContext(pool, { user_id: Ug, property_id: propA });
    const caps = ctx && ctx.capabilities || {};
    T("T11 two live grants → BOTH review and publish granted (grants[0] gave an arbitrary one)", ctx && ctx.ok && caps.may_review_pricing === true && caps.may_publish_pricing === true, J(ctx && (ctx.capabilities || ctx.reason)));
  }

  // ── T12 completion closes the WORK, not the money decision or routed follow-ups (predicate, real rows) ──
  {
    const { FOLLOW_UP_TYPES } = R(REPO + "/src/maintenance/not_done_reasons");
    const wo = (await one(`insert into work_orders (property_id, unit_id, title, status) values ($1,$2,'Tenant-caused damage','open') returning id`, [propA, u1])).id;
    //  billback rows must satisfy ck_oblig_billback_ownership, as the writer does
    const ob = (type, inputs) => one(`insert into obligations (property_id, module, type, label, status, related_type, related_id, required_inputs, ownership_origin, owner_eligibility_state)
                                        values ($1,'maintenance',$2,$2,'open','work_order',$3,$4, 'observation_spawn', 'unassigned') returning id`, [propA, type, wo, inputs]);
    const routing = (await ob("standard_repair", [])).id, billback = (await ob("billback_decision", ["billback_decision"])).id, supply = (await ob("supply_followup", [])).id;
    await q(`update obligations set status = 'complete', completed_at = now(), resolution_code = 'satisfied', updated_at = now()
              where related_type = 'work_order' and related_id = $1 and property_id = $2 and status <> 'complete'
                and type <> 'billback_decision' and not (type = any($3::text[]))`, [wo, propA, FOLLOW_UP_TYPES]);
    const st = Object.fromEntries((await q(`select id, status from obligations where related_id=$1`, [wo])).rows.map((r) => [r.id, r.status]));
    T("T12 the completion predicate closes the repair obligation only", st[routing] === "complete" && st[billback] === "open" && st[supply] === "open", J(st));
  }

  // ── T13 the two gated routes through the REAL gate ──
  {
    const a = await call("GET", "/agent/capability", { key: false });
    T("T13 /agent/capability anonymous → 401 through the real server", a.status === 401, String(a.status));
    const d = await call("GET", "/demo/intake/health", { key: false });
    T("T13b /demo/intake/health without DEMO_MODE → 403", d.status === 403, String(d.status));
    const g = await call("PATCH", `/leases/${L1}/approval`, { body: { decision: "approve" } });
    T("T13c PATCH /leases/:id/approval through the real server → 410", g.status === 410, String(g.status));
  }

  srv.kill("SIGTERM"); await pool.end();
  const code = receipt.complete({ harness: __filename, passed: passes, failed: fails, expectedAtLeast: 36 });
  if (fails) console.log("\n--- server log tail ---\n" + log.split("\n").slice(-12).join("\n"));
  process.exit(code);
})().catch((e) => { process.exit(receipt.died(__filename, e, 0)); });
