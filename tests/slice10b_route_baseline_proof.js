#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  slice10b_route_baseline_proof.js — PHASE 1: WHAT THE ROUTE ALREADY DOES.
//
//  Establishes the proof ceiling on GET /operator/rent-roll/future-facts
//  BEFORE any behaviour is changed. Real server.js child process, real
//  Postgres, canonical staff sessions. Records the current response
//  contract and query count as a baseline, so any later change is a
//  measured delta rather than an assertion.
//
//  Requires HARNESS_DATABASE_URL (disposable) distinct from DATABASE_URL.
//  Synthetic records only — no production data of any kind.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const { spawn } = require("child_process");
const { Pool } = require("pg");

const CONN = process.env.HARNESS_DATABASE_URL;
if (!CONN) { console.error("need HARNESS_DATABASE_URL"); process.exit(1); }
if (CONN === process.env.DATABASE_URL) { console.error("HARNESS_DATABASE_URL must differ from DATABASE_URL"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log("   PASS  " + msg); } else { fail++; console.log("   FAIL  " + msg); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));

const PORT = 3251;
const BASE = `http://127.0.0.1:${PORT}`;
const svc = require(path.join(__dirname, "..", "src/identity/staff_session_service.js"));

async function seed(pool) {
  const c = await pool.connect();
  const one = async (q, a = []) => (await c.query(q, a)).rows[0];
  try {
    await c.query("begin");
    const A = (await one(`insert into properties (name, operating_timezone) values ('10B Proof Tower','America/New_York') returning id`)).id;
    const B = (await one(`insert into properties (name, operating_timezone) values ('10B Neighbour','America/New_York') returning id`)).id;
    const mkUser = async (n) => (await one(
      `insert into users (name,email,phone,role,is_active,status)
       values ($1,$2,$3,'property_manager',true,'active') returning id`,
      [n, `${n}-${Date.now()}@10b.test`, "+1724" + String(Date.now()).slice(-7) + Math.floor(Math.random()*9)])).id;
    const uLease = await mkUser("s10b-lease");
    const uMaint = await mkUser("s10b-maint");
    const uB     = await mkUser("s10b-other");
    const assign = (u, p, mods) => c.query(
      `insert into property_team_assignments
        (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
       values ($1,$2,'Proof','property',$3,$3,false,true)`, [p, u, mods]);
    await assign(uLease, A, ["leasing"]);
    await assign(uMaint, A, ["maintenance"]);   // NO leasing entitlement
    await assign(uB, B, ["leasing"]);

    //  One space on each property, each with a covering active lease.
    const mkSpace = async (prop, num) => {
      const unit = (await one(`insert into units (property_id, unit_number) values ($1,$2) returning id`, [prop, num])).id;
      const sp = (await c.query(`select id from spaces where unit_id=$1`, [unit])).rows[0];
      return { unit, space: sp ? sp.id : (await one(`insert into spaces (unit_id) values ($1) returning id`, [unit])).id };
    };
    const sA = await mkSpace(A, "A-101");
    const sB = await mkSpace(B, "B-101");
    const person = (await one(`insert into persons (name, lifecycle_status) values ('10B Synthetic Resident','tenant') returning id`)).id;
    const mkLease = (prop, space, start, end, status, rent) => c.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,$3,$4,$5,$6,$7)`, [prop, space, [person], rent, start, end, status]);
    await mkLease(A, sA.space, "2026-01-01", "2026-12-31", "active", 1500);
    await mkLease(B, sB.space, "2026-01-01", "2026-12-31", "active", 9999);
    await c.query("commit");
    return { A, B, uLease, uMaint, uB, sA, sB };
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

async function session(pool, userId, propertyId) {
  const c = await pool.connect();
  try { await c.query("begin");
    const s = await svc.issueStaffSession(c, { userId, propertyId, purpose: "sms_otp" });
    await c.query("commit"); return s.session_token;
  } finally { c.release(); }
}

const get = async (p, token) => {
  const r = await fetch(BASE + p, { headers: token ? { "x-staff-session": token } : {} });
  let b = null; try { b = await r.json(); } catch (_) {}
  return { status: r.status, body: b };
};

(async () => {
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const F = await seed(pool);
  const tokLease = await session(pool, F.uLease, F.A);
  const tokMaint = await session(pool, F.uMaint, F.A);
  const tokB     = await session(pool, F.uB, F.B);

  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, DATABASE_URL: CONN, PORT: String(PORT), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((res) => { const t = setTimeout(res, 6000);
    server.stdout.on("data", (d) => { if (/listening/i.test(String(d))) { clearTimeout(t); setTimeout(res, 400); } }); });

  try {
    console.log("\n════ SLICE 10B PHASE 1 — ROUTE BASELINE (no behaviour changed) ════");

    section("A  authentication and session authority");
    const anon = await get("/operator/rent-roll/future-facts", null);
    ok("no session is refused (not 200)", anon.status !== 200);
    const bogus = await get("/operator/rent-roll/future-facts", "not-a-real-session-token");
    ok("a bogus session token is refused", bogus.status !== 200);
    const good = await get("/operator/rent-roll/future-facts", tokLease);
    ok("a valid leasing session is served (200)", good.status === 200);

    section("B  MODULE ENTITLEMENT — the route omits requireLeasingModuleAccess");
    const maint = await get("/operator/rent-roll/future-facts", tokMaint);
    //  Truthful assertion: record what it DOES, do not assert what it should do.
    console.log(`   OBSERVED  maintenance-only session -> HTTP ${maint.status}`);
    ok("a maintenance-only operator's outcome is recorded (see OBSERVED above)",
      typeof maint.status === "number");
    if (maint.status === 200) {
      console.log("   FINDING   the route serves leasing rent-roll facts to a session with NO leasing entitlement.");
    }

    section("C  property scope is server-derived");
    const bScoped = await get("/operator/rent-roll/future-facts", tokB);
    ok("neighbouring property's session gets its OWN property", bScoped.status === 200 && bScoped.body.property_id === F.B);
    const forged = await get(`/operator/rent-roll/future-facts?property_id=${F.B}`, tokLease);
    ok("a client-supplied property_id cannot change scope",
      forged.status === 200 && forged.body.property_id === F.A);
    const aIds = (good.body.rows || []).map((r) => r.space_id);
    ok("no neighbouring-property space leaks into the response",
      !aIds.includes(F.sB.space) && aIds.includes(F.sA.space));
    ok("exactly one row per canonical space on this property", (good.body.rows || []).length === 1);

    section("D  target date handling");
    const dated = await get("/operator/rent-roll/future-facts?as_of=2026-09-01", tokLease);
    ok("a valid property-local target date is accepted", dated.status === 200);
    const bad = await get("/operator/rent-roll/future-facts?as_of=not-a-date", tokLease);
    console.log(`   OBSERVED  as_of=not-a-date -> HTTP ${bad.status}`);
    ok("an invalid date's outcome is recorded (see OBSERVED above)", typeof bad.status === "number");

    section("E  the CURRENT response contract, recorded verbatim");
    const top = Object.keys(good.body || {}).sort();
    const rowKeys = Object.keys((good.body.rows || [])[0] || {}).sort();
    console.log("   top-level: " + top.join(" "));
    console.log("   row keys : " + rowKeys.join(" "));
    ok("response carries rows", Array.isArray(good.body.rows));
    ok("row is keyed on space_id", rowKeys.includes("space_id"));
    ok("economics is a separate axis (economics_state present)", rowKeys.includes("economics_state"));
    ok("conflict is exposed (conflict_state present)", rowKeys.includes("conflict_state"));
    ok("NO denominator class is currently emitted", !rowKeys.includes("denominator_class"));
    ok("NO use_type is currently emitted", !rowKeys.includes("use_type"));
    ok("NO existing-action projection is currently emitted",
      !rowKeys.some((k) => /obligation|action/.test(k)));
    ok("NO rent authority/provenance is currently emitted",
      !rowKeys.some((k) => /rent_authority|provenance/.test(k)));

    section("F  read-only");
    const before = await pool.query("select (select count(*) from leases) l, (select count(*) from events) e, (select count(*) from obligations) o");
    await get("/operator/rent-roll/future-facts?as_of=2026-10-01", tokLease);
    const after = await pool.query("select (select count(*) from leases) l, (select count(*) from events) e, (select count(*) from obligations) o");
    ok("the route writes nothing",
      before.rows[0].l === after.rows[0].l && before.rows[0].e === after.rows[0].e && before.rows[0].o === after.rows[0].o);

    section("G  query count baseline");
    //  Counted at the pool used by this harness, against the same service the
    //  route calls — the route's own process cannot be instrumented from here.
    const { futureRentRollFacts } = require(path.join(__dirname, "..", "src/surfaces/future_rent_roll_facts"));
    let n = 0;
    const counting = { query: (...a) => { n++; return pool.query(...a); }, connect: (...a) => pool.connect(...a), totalCount: pool.totalCount };
    await futureRentRollFacts(counting, { property_id: F.A, as_of: "2026-09-01" });
    console.log(`   OBSERVED  query count for one property, one space: ${n}`);
    ok("query count is bounded (not per-row)", n > 0 && n < 40);

    console.log(`\n════ route baseline: ${pass} passed, ${fail} failed ════\n`);
  } finally {
    server.kill("SIGKILL");
    await pool.end();
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("PROOF CRASHED: " + e.message); process.exit(1); });
