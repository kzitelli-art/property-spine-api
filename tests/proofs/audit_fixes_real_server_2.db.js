/* ════════════════════════════════════════════════════════════════════
   audit_fixes_real_server_2.db.js — THE 2026-09-04 AUDIT FIXES, THROUGH THE REAL SERVER (second harness)

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
const TAG = "cleanup2-" + Date.now(), SUF = String(Date.now()).slice(-4);
let fails = 0, passes = 0; const T = (n, ok, d) => { console.log(`  ${ok ? "ok   " : "FAIL "} ${n}${ok ? "" : "   <- " + String(d).slice(0, 320)}`); if (ok) passes++; else fails++; };
const J = (b) => JSON.stringify(b);
const call = async (m, p, { key = true, session = null, body = undefined, raw = false } = {}) => {
  const h = {}; if (!raw) h["content-type"] = "application/json";
  if (key) h["x-operator-key"] = KEY; if (session) h["x-staff-session"] = session;
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: h, body: body === undefined ? undefined : (raw ? body : J(body)) });
  let b = null; try { b = await r.json(); } catch (_) {}
  return { status: r.status, body: b };
};
const iso = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

(async () => {
  receipt.begin(__filename, { url: URL_, expected: 16 });
  const pool = new Pool({ connectionString: URL_, ssl: false });
  const q = (sql, p) => pool.query(sql, p); const one = async (sql, p) => (await q(sql, p)).rows[0];
  const svc = R(REPO + "/src/identity/staff_session_service");
  const env = { ...process.env, DATABASE_URL: URL_, OPERATOR_KEY: KEY, OPERATOR_APP_ORIGIN: "http://localhost:8080", PORT: String(PORT), ANTHROPIC_API_KEY: "sk-test", READ_AI_CONNECTION_ID: READ_AI };
  delete env.DEMO_MODE; delete env.NODE_ENV; delete env.HARNESS_DATABASE_URL; delete env.READ_AI_WEBHOOK_SIGNING_KEY;
  //  ASK BEFORE LAUNCHING (tests/e2e/port_guard.sh's rule). A server left
  //  behind by an earlier run answers /health just as cheerfully — pointed
  //  at a different database — and every assertion then lies. Refuse.
  try { await fetch(`http://127.0.0.1:${PORT}/health`); console.error(`REFUSED: port ${PORT} already answers — a stale server.js is listening.`); process.exit(2); } catch (_) {}
  const srv = spawn("node", ["server.js"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  //  The child must not outlive this process, however this process ends.
  process.on("exit", () => { try { srv.kill("SIGTERM"); } catch (_) {} });
  let log = ""; srv.stdout.on("data", (d) => { log += d; }); srv.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch (_) {} await new Promise((x) => setTimeout(x, 500)); }

  const orgA = (await one(`insert into organizations (name) values ($1) returning id`, [TAG + "-A"])).id;
  const orgB = (await one(`insert into organizations (name) values ($1) returning id`, [TAG + "-B"])).id;
  const propA = (await one(`insert into properties (name, organization_id, leasing_basis) values ($1,$2,'unit') returning id`, [TAG + "-A", orgA])).id;
  const propB = (await one(`insert into properties (name, organization_id, leasing_basis) values ($1,$2,'unit') returning id`, [TAG + "-B", orgB])).id;
  const mkUser = async (n, x = {}) => (await one(`insert into users (name,email,phone,role,is_active,status,platform_role,organization_id) values ($1,$2,$3,'property_manager',$4,'active',$5,$6) returning id`,
    [n, `${n}@${TAG}.test`, x.phone || ("+1724" + "58" + SUF + String(Math.floor(Math.random() * 9)) ), x.active !== false, x.platform_role || "member", x.org || null])).id;
  const assign = (u, p, mods = ["leasing", "maintenance", "management", "asset_management"], manage = true) => q(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active) values ($1,$2,'Proof','property',$3,$3,$4,true)`, [p, u, mods, manage]);
  const session = async (u, p) => { const c = await pool.connect(); try { await c.query("begin"); const s = await svc.issueStaffSession(c, { userId: u, propertyId: p, purpose: "sms_otp" }); await c.query("commit"); return s.session_token; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
  const adminA = await mkUser("adminA", { platform_role: "org_admin", org: orgA }); await assign(adminA, propA); await assign(adminA, propB);
  const tokA = await session(adminA, propA);
  const person = async (n) => (await one(`insert into persons (name, phone) values ($1,$2) returning id`, [n, "+1215" + "77" + SUF + "1"])).id;
  const unit = async (n, p = propA) => (await one(`insert into units (property_id, unit_number) values ($1,$2) returning id`, [p, n])).id;
  const P = await person("Resident"); const u1 = await unit("101");

  // ── T14 legacy closeout on a COMPLETE work order → 409 ──
  {
    const wo = (await one(`insert into work_orders (property_id, unit_id, reported_by_person_id, title, status) values ($1,$2,$3,'Done job','complete') returning id`, [propA, u1, P])).id;
    const r = await call("PATCH", `/work-orders/${wo}/closeout`, { body: { done: false, not_done_reason: "needs_parts" } });
    const still = await one(`select status from work_orders where id=$1`, [wo]);
    T("T14 legacy closeout done=false on a COMPLETE work order → 409, status untouched", r.status === 409 && still.status === "complete", `${r.status} ${J(r.body)} ${J(still)}`);
    // ── T15 notify-status cannot reopen it either ──
    await q(`insert into conversations (property_id, person_id) values ($1,$2)`, [propA, P]);
    const n = await call("POST", `/work-orders/${wo}/notify-status`, { body: { status: "open", note_to_tenant: "reopening by note" } });
    const still2 = await one(`select status from work_orders where id=$1`, [wo]);
    T("T15 notify-status with status:'open' on a COMPLETE work order → 409, status untouched", n.status === 409 && still2.status === "complete", `${n.status} ${J(n.body)} ${J(still2)}`);
  }

  // ── T16 /org/users lists only THIS organization's assignments ──
  {
    const r = await call("GET", "/org/users", { key: false, session: tokA });
    const me = (r.body || []).find((u) => u.id === adminA);
    const props = ((me && me.assignments) || []).map((a) => a.property_id);
    T("T16 /org/users: adminA's propB (other org) assignment is NOT listed", r.status === 200 && me && props.includes(propA) && !props.includes(propB), `${r.status} ${J(props)}`);
  }

  // ── T17 shadow report is the session property only ──
  {
    //  FALSIFIABLE: the old code answered with the literal foreign id in
    //  `other_property_id`. Seed a property AT that id with a name no other
    //  fixture uses, so a read of it would surface as text, and require the
    //  key to be present and null — not merely absent.
    const FOREIGN = "9e2bb96e-08e2-41db-81c2-91055ceb50a3", FOREIGN_NAME = "FOREIGN-SHADOW-" + TAG;
    await q(`insert into properties (id, name, organization_id) values ($1,$2,$3) on conflict (id) do update set name = excluded.name`, [FOREIGN, FOREIGN_NAME, orgB]);
    const r = await call("GET", "/operator/economics/shadow", { key: false, session: tokA });
    T("T17 /operator/economics/shadow no longer reads the hardcoded foreign property",
      //  economic_shadow adds a scenario row "another_property" whenever it is
      //  handed another property id. With the seeded foreign property in
      //  place, the pre-fix route produces that row; the fixed one cannot.
      r.status === 200 && r.body && Array.isArray(r.body.comparisons)
        && !r.body.comparisons.some((row) => row && row.scenario === "another_property")
        && !J(r.body).includes(FOREIGN) && !J(r.body).includes(FOREIGN_NAME),
      `${r.status} ${J(r.body).slice(0, 160)}`);
  }

  // ── T18 /operator/build needs a session ──
  {
    const a = await call("GET", "/operator/build", { key: false });
    const b = await call("GET", "/operator/build", { key: false, session: tokA });
    T("T18 /operator/build → 401 anonymous, 200 with a session", a.status === 401 && b.status === 200 && b.body && b.body.build, `${a.status}/${b.status}`);
  }

  // ── T19 a superseded invite sends no code ──
  {
    const tok = "sup-" + TAG;
    await q(`insert into team_invites (property_id, phone_number, token, status, expires_at, invited_by_user_id) values ($1,$2,$3,'superseded', now() + interval '1 day', $4)`, [propA, "+1215" + "78" + SUF + "2", tok, adminA]);
    const r = await call("POST", "/auth/sms/start", { key: false, body: { token: tok } });
    T("T19 /auth/sms/start on a SUPERSEDED invite → 410 (was: sent a real code)", r.status === 410, `${r.status} ${J(r.body)}`);
  }

  // ── T20 an inactive account refuses with 403, not 500 ──
  {
    const inactive = await mkUser("inactive", { active: false, org: orgA }); await assign(inactive, propA);
    const tok = "relogin-" + TAG, code = "123456";
    const hash = crypto.createHash("sha256").update(`${code}:${tok}`).digest("hex");
    await q(`insert into team_invites (property_id, phone_number, token, status, expires_at, otp_hash, otp_expires_at, otp_sent_at, accepted_user_id, allowed_modules, invited_by_user_id)
             values ($1,$2,$3,'active', now() + interval '1 day', $4, now() + interval '10 minutes', now(), $5, '{}', $6)`, [propA, "+1215" + "79" + SUF + "3", tok, hash, inactive, adminA]);
    const r = await call("POST", "/auth/sms/verify", { key: false, body: { token: tok, code } });
    T("T20 /auth/sms/verify for an INACTIVE account → 403 with its reason (was 500)", r.status === 403, `${r.status} ${J(r.body)}`);
  }

  // ── T21 public slot booking refuses a cross-property slot ──
  {
    const lead = (await one(`insert into leasing_leads (person_id, property_id, status) values ($1,$2,'new') returning id`, [P, propA])).id;
    const slotB = (await one(`insert into tour_availability (property_id, starts_at, ends_at, status) values ($1, now() + interval '3 day', now() + interval '3 day 30 min', 'open') returning id`, [propB])).id;
    const r = await call("POST", `/leasing/slots/${slotB}/book`, { body: { lead_id: lead } });
    const slot = await one(`select status from tour_availability where id=$1`, [slotB]);
    T("T21 booking property A's lead into property B's slot → 409, slot still open", r.status === 409 && slot.status === "open", `${r.status} ${J(r.body)}`);
  }

  // ── T22 legacy tours/today: the property's day, or an honest refusal ──
  {
    const a = await call("GET", `/properties/${propA}/leasing/tours/today`);
    await q(`update properties set operating_timezone='America/New_York' where id=$1`, [propA]);
    const b = await call("GET", `/properties/${propA}/leasing/tours/today`);
    T("T22 tours/today: 409 with no operating timezone, 200 once one is configured (no UTC guess)", a.status === 409 && b.status === 200, `${a.status}/${b.status} ${J(a.body).slice(0, 120)}`);
  }

  // ── T23 exposure buckets no longer count the same dollar twice ──
  {
    const ch = (await one(`insert into scheduled_charges (property_id, charge_type, period, amount, status) values ($1,'rent','2026-09-01',1000,'claimed') returning id`, [propA])).id;
    const p1 = (await one(`insert into payments (property_id, person_id, amount, paid_date, status) values ($1,$2,600, current_date,'applied') returning id`, [propA, P])).id;
    const p2 = (await one(`insert into payments (property_id, person_id, amount, paid_date, status) values ($1,$2,500, current_date,'partially_applied') returning id`, [propA, P])).id;
    await q(`insert into payment_applications (payment_id, scheduled_charge_id, amount_applied) values ($1,$2,600), ($3,$2,200)`, [p1, ch, p2]);
    const r = await call("GET", `/properties/${propA}/income-proof`);
    const ex = r.body && r.body.income && r.body.income.exposure;
    const pbu = ex && ex.paid_but_unmatched && Number(ex.paid_but_unmatched.value);
    const unap = ex && ex.unapplied_payment && Number(ex.unapplied_payment.value);
    T("T23 paid_but_unmatched = APPLIED without cash proof (800), unapplied = the remainder (300) — no overlap", pbu === 800 && unap === 300, `${r.status} paid_but_unmatched=${pbu} unapplied=${unap}`);
  }

  // ── T24 a bodiless webhook probe is refused, not 500 ──
  {
    const r = await call("POST", "/integrations/read-ai/webhook", { key: false, raw: true });
    T("T24 POST /integrations/read-ai/webhook with no body → a refusal, not 500", r.status !== 500 && r.status >= 400, `${r.status} ${J(r.body)}`);
  }

  // ── T25 deal membership: reactivation, release-not-delete, one current deal ──
  {
    const d1 = (await call("POST", "/deal-intakes", { body: { onboarding_type: "existing_asset", deal_name: TAG + " deal 1", organization_id: orgA } })).body;
    const propD = await (async () => (await one(`insert into properties (name, organization_id) values ($1,$2) returning id`, [TAG + "-D", orgA])).id)();
    const a = await call("POST", `/deal-intakes/${d1.intake_id}/properties`, { body: { property_id: propD } });
    const rel = await call("DELETE", `/deal-intakes/${d1.intake_id}/properties/${propD}`, { body: { reason: "test release" } });
    const row1 = await one(`select id, status, released_at, released_reason from deal_intake_properties where intake_id=$1 and property_id=$2`, [d1.intake_id, propD]);
    T("T25 deal created WITH an owner; property added (201); release keeps the row as history", d1.organization_id === orgA && a.status === 201 && rel.status === 200 && row1 && row1.status === "released" && !!row1.released_at, `${J(d1)} ${a.status} ${rel.status} ${J(row1)}`);
    const b = await call("POST", `/deal-intakes/${d1.intake_id}/properties`, { body: { property_id: propD } });
    const row2 = await one(`select id, status, released_at from deal_intake_properties where intake_id=$1 and property_id=$2`, [d1.intake_id, propD]);
    //  FALSIFIABLE: delete-then-insert also ends `current`. Reactivation
    //  keeps the SAME membership row — its id survives the release.
    T("T25b re-adding a released property REACTIVATES the same row (was: a fresh row, history gone)",
      b.status === 201 && row2.status === "current" && row2.released_at === null && row1 && row2.id === row1.id, `${b.status} ${J(row1)} → ${J(row2)}`);
    const d2 = (await call("POST", "/deal-intakes", { body: { onboarding_type: "existing_asset", deal_name: TAG + " deal 2", organization_id: orgA } })).body;
    const c = await call("POST", `/deal-intakes/${d2.intake_id}/properties`, { body: { property_id: propD } });
    T("T25c a property current on another deal → 409 in a sentence (was a raw 500)", c.status === 409 && c.body.error === "property_current_on_another_deal", `${c.status} ${J(c.body)}`);
  }

  // ── T26 insurance: the same program twice, no artifact → refused ──
  {
    const body = { program: { program_name: "Test Package " + SUF, term_start: "2026-01-01", term_end: "2026-12-31", currency_code: "USD" },
                   coverages: [{ coverage_type: "property", coverage_period_start: "2026-01-01", coverage_period_end: "2026-12-31", premium_cents: 100000 }] };
    const a = await call("POST", "/operator/asset-management/insurance/establish", { key: false, session: tokA, body });
    const b = await call("POST", "/operator/asset-management/insurance/establish", { key: false, session: tokA, body });
    const progs = await one(`select count(*)::int as n from insurance_programs where program_name=$1`, [body.program.program_name]);
    T("T26 first establish accepted; the SAME program again → 409, ONE program row (was two)", (a.status === 200 || a.status === 201) && b.status === 409 && progs.n === 1, `${a.status} ${J(a.body).slice(0, 120)} / ${b.status} ${J(b.body).slice(0, 120)} / rows=${progs.n}`);
  }

  // ── T27 the obligation-pick lands on the work, not the money decision — through the REAL action ──
  {
    //  FALSIFIABLE: the billback decision is inserted FIRST in the same
    //  transaction, so the pre-fix `order by created_at asc limit 1` (equal
    //  created_at, physical order) lands on it deterministically. The real
    //  assignWork must still assign the repair and leave the billback alone.
    const actions = R(REPO + "/src/technician/operator_actions");
    const wo = (await one(`insert into work_orders (property_id, unit_id, title, status) values ($1,$2,'Tenant-caused','open') returning id`, [propA, u1])).id;
    const c = await pool.connect(); let routing, bill, out;
    try { await c.query("begin");
      bill = (await c.query(`insert into obligations (property_id, module, type, label, status, related_type, related_id, required_inputs, ownership_origin, owner_eligibility_state) values ($1,'maintenance','billback_decision','billback','open','work_order',$2,'{billback_decision}','observation_spawn','unassigned') returning id`, [propA, wo])).rows[0].id;
      routing = (await c.query(`insert into obligations (property_id, module, type, label, status, related_type, related_id) values ($1,'maintenance','standard_repair','repair','open','work_order',$2) returning id`, [propA, wo])).rows[0].id;
      await c.query("commit");
      await c.query("begin");
      out = await actions.assignWork(c, { workOrderId: wo, propertyId: propA, technicianUserId: adminA, operatorUserId: adminA });
      await c.query("commit");
    } catch (e) { await c.query("rollback"); out = { outcome: "threw", refusal: e.message }; } finally { c.release(); }
    const rep = await one(`select assigned_user_id from obligations where id=$1`, [routing]);
    const bb = await one(`select assigned_user_id from obligations where id=$1`, [bill]);
    const same = await one(`select count(distinct created_at)::int as n from obligations where related_id=$1`, [wo]);
    T("T27 two obligations born in ONE transaction share created_at; assignWork lands on the repair, never the billback",
      same.n === 1 && out && out.outcome === "assigned" && rep.assigned_user_id === adminA && bb.assigned_user_id === null,
      `distinct created_at=${same.n} outcome=${out && out.outcome} ${out && out.refusal || ""} repair=${rep.assigned_user_id} billback=${bb.assigned_user_id}`);
  }

  srv.kill("SIGTERM"); await pool.end();
  const code = receipt.complete({ harness: __filename, passed: passes, failed: fails, expectedAtLeast: 16 });
  if (fails) console.log("\n--- server log tail ---\n" + log.split("\n").slice(-15).join("\n"));
  process.exit(code);
})().catch((e) => { process.exit(receipt.died(__filename, e, 0)); });
