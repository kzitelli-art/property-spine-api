// ════════════════════════════════════════════════════════════════════
//  DB-BACKED PROOF — STAFF IDENTITY BRIDGE (migration 067)
//
//  Runs the REAL resolver, REAL bridge workflow module, REAL conversion
//  service (with the REAL obligation engine extracted verbatim in
//  tests/_engine.js), and REAL HTTP through express, against a REAL
//  Postgres carrying production-shaped prerequisites + the REAL 047 and
//  067 migrations applied through the real schema_migrations ledger.
//  No in-memory simulation.
//
//  Run:  DATABASE_URL=... node tests/test_identity_bridge.db.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");
const http = require("http");
const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const engine = require("./_engine.js");
const resolver = require("../src/identity/staff_identity_resolver.js");
const buildStaffBridge = require("../src/identity/staffbridge.js");
const buildConversion = require("../src/leasing/leasingconversion.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let pass = 0, fail = 0;
function ok(l) { console.log("  PASS  " + l); pass++; }
function bad(l, e) { console.log("  FAIL  " + l + "  →  " + (e && e.message || e)); fail++; }
async function T(l, fn) { try { await fn(); ok(l); } catch (e) { bad(l, e); } }
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; }
  finally { c.release(); }
}
async function read(fn) { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }
async function expectThrow(fn, frag) {
  try { await fn(); } catch (e) {
    if (!frag || (e.message || "").includes(frag)) return;
    throw new Error(`threw but not "${frag}": ${e.message}`);
  }
  throw new Error(`expected a throw containing "${frag}"`);
}

// ── seed handles ──
const S = {};

// ── PER-RUN UNIQUENESS. This harness COMMITS its fixtures (tx() below ends in
//  `commit`, not `rollback`) and never deletes them, so every row it writes
//  outlives the run. With FIXED emails and FIXED session tokens it was
//  therefore SINGLE-USE per database: the first run passed, and every run after
//  it died in seed on users_email_key before a single assertion executed.
//
//  Stale session tokens were the quieter half of the same bug — staff_sessions
//  is unique on token_digest, not token, so a duplicate literal token inserted
//  within its 6-hour window could resolve to a PRIOR run's user.
//
//  tests/test_release3.db.js already solved this with a per-run token; this is
//  the same pattern, not a new one. Nothing about any assertion changes — the
//  fixtures are merely made distinguishable between runs.
const RUN = Date.now();
const em = (local) => `${local}${RUN}@proof.internal`;
const tok = (name) => `proof-${name}-token-${RUN}`;

async function seed() {
  await tx(async (c) => {
    S.prop = (await c.query(`insert into properties (name) values ('Bridge Proof Property') returning id`)).rows[0].id;
    S.prop2 = (await c.query(`insert into properties (name) values ('Other Property (the wall)') returning id`)).rows[0].id;

    const mkUser = async (name, email, role, extra = "") =>
      (await c.query(`insert into users (name, email, role${extra ? "," + extra.split("=")[0] : ""})
                      values ($1,$2,$3::role_name${extra ? ",'" + extra.split("=")[1] + "'" : ""}) returning id`,
        [name, email, role])).rows[0].id;

    S.admin      = await mkUser("Admin PM", em("admin"), "property_manager");
    S.kandice    = await mkUser("Kandice", em("kandice"), "leasing_agent");
    S.katie      = await mkUser("Katie", em("katie"), "leasing_manager");
    S.john       = await mkUser("John Banks", em("john"), "maintenance");       // stays unbridged
    S.suspended  = await mkUser("Sam Suspended", em("sam"), "leasing_agent");
    S.invited    = await mkUser("Ivy Invited", em("ivy"), "leasing_agent");
    S.frozen     = await mkUser("Frank Frozen", em("frank"), "leasing_agent");  // unknown future status
    S.inactive   = await mkUser("Ida Inactive", em("ida"), "leasing_agent");
    S.svc        = await mkUser("Twilio Webhook", em("svc"), "system");
    S.dupA       = await mkUser("Dup A", em("dupa"), "leasing_agent");
    S.dupB       = await mkUser("Dup B", em("dupb"), "leasing_agent");
    S.nonadmin   = await mkUser("Norm Nonadmin", em("norm"), "leasing_agent");

    await c.query(`update users set status='suspended' where id=$1`, [S.suspended]);
    await c.query(`update users set status='invited'   where id=$1`, [S.invited]);
    await c.query(`update users set status='frozen'    where id=$1`, [S.frozen]);   // unknown status → must fail closed
    await c.query(`update users set is_active=false    where id=$1`, [S.inactive]);

    // an existing ORDINARY lead person (for the leak-guard contrast)
    S.leadPerson = (await c.query(
      `insert into persons (name, phone, lifecycle_status, leasing_stage, source)
       values ('Larry Lead','+12155550101','lead','lead','zillow') returning id`)).rows[0].id;
    S.lead = (await c.query(
      `insert into leasing_leads (person_id, property_id) values ($1,$2) returning id`,
      [S.leadPerson, S.prop])).rows[0].id;
    S.tour = (await c.query(
      `insert into leasing_tours (lead_id, property_id, scheduled_for)
       values ($1,$2, now() + interval '1 day') returning id`, [S.lead, S.prop])).rows[0].id;

    // parallel 035 roster row for divergence reporting (John: 035-only)
    await c.query(
      `insert into property_team_assignments (property_id, user_id, role_title)
       values ($1,$2,'Senior Maintenance Tech')`, [S.prop, S.john]);

    // real admin staff session (HTTP proofs)
    S.adminToken = tok("admin");
    await c.query(`insert into staff_sessions (user_id, property_id, token, expires_at)
                   values ($1,$2,$3, now() + interval '6 hours')`, [S.admin, S.prop, S.adminToken]);
    S.nonadminToken = tok("nonadmin");
    await c.query(`insert into staff_sessions (user_id, property_id, token, expires_at)
                   values ($1,$2,$3, now() + interval '6 hours')`, [S.nonadmin, S.prop, S.nonadminToken]);
    S.katieToken = tok("katie"); // leasing_manager — the DEMO_MODE widening subject
    await c.query(`insert into staff_sessions (user_id, property_id, token, expires_at)
                   values ($1,$2,$3, now() + interval '6 hours')`, [S.katie, S.prop, S.katieToken]);
  });
}

// ── HTTP rig: mount the real router in a real express app on an ephemeral port ──
function serve(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}
async function call(port, method, urlPath, { token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-staff-session": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

(async () => {
  console.log("\n═══ STAFF IDENTITY BRIDGE — PROOF SUITE (067) ═══\n");
  await seed();
  const bridgeSvc = buildStaffBridge({ pool })._service;

  // ────────────────────────────────────────────────────────────────
  console.log("A. MIGRATION SUBSTRATE (real ledger apply verified upstream)");
  // ────────────────────────────────────────────────────────────────
  await T("A1  067 recorded in schema_migrations", async () => {
    const r = await read((c) => c.query(`select 1 from schema_migrations where version='067'`));
    assert(r.rows.length === 1);
  });
  await T("A2  users.person_id + account_kind exist; default classification is 'unclassified' (fail-closed)", async () => {
    const r = await read((c) => c.query(`select person_id, account_kind from users where id=$1`, [S.admin]));
    assert(r.rows[0].person_id === null, "no backfill — person_id must start null");
    assert(r.rows[0].account_kind === "unclassified");
  });
  await T("A3  bridge audit + person_contexts tables exist with open-range unique index", async () => {
    const r = await read((c) => c.query(
      `select indexname from pg_indexes where tablename='user_person_bridge_audit'
        and indexname='uq_bridge_audit_open_range'`));
    assert(r.rows.length === 1);
  });

  // ────────────────────────────────────────────────────────────────
  console.log("\nB. BRIDGE WORKFLOW — deliberate, audited, transactional");
  // ────────────────────────────────────────────────────────────────
  await T("B1  an UNCLASSIFIED account cannot be bridged", async () => {
    await expectThrow(() => tx((c) => bridgeSvc.linkBridge(c, {
      user_id: S.kandice, create_staff_person: { name: "Kandice" },
      reason_code: "x", performed_by_user_id: S.admin })), "human_staff");
  });
  await T("B2  a service account, once classified, still cannot be bridged", async () => {
    await tx((c) => bridgeSvc.classifyAccount(c, { user_id: S.svc, account_kind: "service_account", performed_by_user_id: S.admin }));
    await expectThrow(() => tx((c) => bridgeSvc.linkBridge(c, {
      user_id: S.svc, create_staff_person: { name: "Twilio" },
      reason_code: "x", performed_by_user_id: S.admin })), "human_staff");
  });
  await T("B3  classify → link creates staff person WITH active staff context, audit range, pointer — one transaction", async () => {
    for (const uid of [S.admin, S.kandice, S.katie, S.john, S.suspended, S.invited, S.frozen, S.inactive, S.dupA, S.dupB])
      await tx((c) => bridgeSvc.classifyAccount(c, { user_id: uid, account_kind: "human_staff", performed_by_user_id: S.admin }));
    const out = await tx((c) => bridgeSvc.linkBridge(c, {
      user_id: S.kandice, create_staff_person: { name: "Kandice", property_id: S.prop },
      reason_code: "proof_seed", evidence_type: "operator_attestation",
      performed_by_user_id: S.admin, request_id: "req-kandice-1" }));
    S.kandicePerson = out.person_id;
    const chk = await read((c) => c.query(`
      select u.person_id,
             (select count(*)::int from person_contexts pc where pc.person_id=$2 and pc.context_type='staff' and pc.active_to is null) as ctx,
             (select count(*)::int from user_person_bridge_audit b where b.user_id=$1 and b.action='linked' and b.effective_to is null) as open_range,
             (select performed_by_user_id from user_person_bridge_audit b where b.user_id=$1 order by performed_at desc limit 1) as by_whom
        from users u where u.id=$1`, [S.kandice, out.person_id]));
    const r = chk.rows[0];
    assert(r.person_id === out.person_id && r.ctx === 1 && r.open_range === 1);
    assert(r.by_whom === S.admin, "performed_by is the admin, recorded in the audit");
  });
  await T("B4  idempotent replay by request_id writes NOTHING new", async () => {
    const before = await read((c) => c.query(`select count(*)::int n from user_person_bridge_audit`));
    const out = await tx((c) => bridgeSvc.linkBridge(c, {
      user_id: S.kandice, create_staff_person: { name: "Kandice" },
      reason_code: "proof_seed", performed_by_user_id: S.admin, request_id: "req-kandice-1" }));
    const after = await read((c) => c.query(`select count(*)::int n from user_person_bridge_audit`));
    assert(out.replayed === true && after.rows[0].n === before.rows[0].n);
  });
  await T("B5  relink CLOSES the prior range and opens a new one; prior row otherwise immutable", async () => {
    const p2 = await tx((c) => bridgeSvc.createStaffPerson(c, { name: "Kandice (corrected)", created_by_user_id: S.admin }));
    await tx((c) => bridgeSvc.linkBridge(c, {
      user_id: S.kandice, person_id: p2.id, reason_code: "correction",
      reason_detail: "wrong person chosen at seed", performed_by_user_id: S.admin }));
    const rows = (await read((c) => c.query(
      `select action, new_person_id, effective_to from user_person_bridge_audit
        where user_id=$1 order by performed_at asc`, [S.kandice]))).rows;
    assert(rows.length === 2, "two audit rows — history appended, never rewritten");
    assert(rows[0].action === "linked" && rows[0].effective_to !== null, "prior range closed");
    assert(rows[1].action === "relinked" && rows[1].effective_to === null, "new range open");
    assert(String(rows[0].new_person_id) === String(S.kandicePerson), "old row still names the OLD person — the past is not rewritten");
    S.kandicePerson = p2.id;
  });
  await T("B6  unlink closes the range, clears the pointer, writes a zero-width event; history intact", async () => {
    const p = await tx((c) => bridgeSvc.createStaffPerson(c, { name: "Temp T", created_by_user_id: S.admin }));
    await tx((c) => bridgeSvc.classifyAccount(c, { user_id: S.nonadmin, account_kind: "human_staff", performed_by_user_id: S.admin }));
    await tx((c) => bridgeSvc.linkBridge(c, { user_id: S.nonadmin, person_id: p.id, reason_code: "t", performed_by_user_id: S.admin }));
    await tx((c) => bridgeSvc.unlinkBridge(c, { user_id: S.nonadmin, reason_code: "departure", performed_by_user_id: S.admin }));
    const u = (await read((c) => c.query(`select person_id from users where id=$1`, [S.nonadmin]))).rows[0];
    const a = (await read((c) => c.query(
      `select action, effective_to from user_person_bridge_audit where user_id=$1 order by performed_at asc`, [S.nonadmin]))).rows;
    assert(u.person_id === null);
    assert(a.length === 2 && a[0].effective_to !== null && a[1].action === "unlinked" && a[1].effective_to !== null);
  });
  await T("B7  candidates endpoint SUGGESTS by exact email only and WRITES NOTHING", async () => {
    // the person's email must match S.katie's USER email exactly — that exact
    // match is the whole subject of this assertion, so both move together.
    await tx((c) => c.query(`insert into persons (name, email) values ('Katie P',$1)`, [em("katie")]));
    const before = (await read((c) => c.query(`select count(*)::int n from user_person_bridge_audit`))).rows[0].n;
    const out = await read((c) => bridgeSvc.bridgeCandidates(c, S.katie));
    const after = (await read((c) => c.query(`select count(*)::int n from user_person_bridge_audit`))).rows[0].n;
    const kt = (await read((c) => c.query(`select person_id from users where id=$1`, [S.katie]))).rows[0];
    assert(out.candidates.length === 1 && out.candidates[0].suggestion_basis === "exact_email_match");
    assert(before === after && kt.person_id === null, "suggestion is not a bridge");
  });
  await T("B8  atomicity: a failing link leaves NO audit row and NO pointer", async () => {
    const before = (await read((c) => c.query(`select count(*)::int n from user_person_bridge_audit`))).rows[0].n;
    await expectThrow(() => tx((c) => bridgeSvc.linkBridge(c, {
      user_id: S.john, person_id: "00000000-0000-0000-0000-00000000dead",
      reason_code: "x", performed_by_user_id: S.admin })), "person not found");
    const after = (await read((c) => c.query(`select count(*)::int n from user_person_bridge_audit`))).rows[0].n;
    const j = (await read((c) => c.query(`select person_id from users where id=$1`, [S.john]))).rows[0];
    assert(before === after && j.person_id === null, "rolled back together — commit together or not at all");
  });

  // finish the working roster: Katie bridged + assigned; Kandice assigned;
  // suspended/invited/frozen/inactive bridged + assigned (their ACCOUNTS are
  // the failure subjects); dupA/dupB → SAME person (the conflict subject).
  await tx(async (c) => {
    const katieOut = await bridgeSvc.linkBridge(c, {
      user_id: S.katie, create_staff_person: { name: "Katie", property_id: S.prop },
      reason_code: "proof_seed", performed_by_user_id: S.admin });
    S.katiePerson = katieOut.person_id;
    const mkAsg = (pid, prop) => c.query(
      `insert into assignments (person_id, property_id, role, scope) values ($1,$2,'leasing','leasing')`, [pid, prop]);
    await mkAsg(S.kandicePerson, S.prop);
    await mkAsg(S.katiePerson, S.prop);
    for (const [key, uid] of [["susP", S.suspended], ["invP", S.invited], ["froP", S.frozen], ["inaP", S.inactive]]) {
      const o = await bridgeSvc.linkBridge(c, {
        user_id: uid, create_staff_person: { name: key }, reason_code: "proof_seed",
        performed_by_user_id: S.admin });
      S[key] = o.person_id; await mkAsg(o.person_id, S.prop);
    }
    const dp = await bridgeSvc.linkBridge(c, {
      user_id: S.dupA, create_staff_person: { name: "Dup Person" }, reason_code: "proof_seed",
      performed_by_user_id: S.admin });
    S.dupPerson = dp.person_id;
    await bridgeSvc.linkBridge(c, { user_id: S.dupB, person_id: S.dupPerson,
      reason_code: "proof_seed_conflict", performed_by_user_id: S.admin });
    await mkAsg(S.dupPerson, S.prop);
    // an INACTIVE assignment subject: bridged person, assignment exists but off
    const iaOut = await bridgeSvc.classifyAccount(c, { user_id: S.nonadmin, account_kind: "human_staff", performed_by_user_id: S.admin });
    const iap = await bridgeSvc.linkBridge(c, { user_id: S.nonadmin,
      create_staff_person: { name: "Norm" }, reason_code: "proof_seed", performed_by_user_id: S.admin });
    S.normPerson = iap.person_id;
    await c.query(`insert into assignments (person_id, property_id, role, scope, is_active)
                   values ($1,$2,'leasing','leasing', false)`, [S.normPerson, S.prop]);
  });

  // ────────────────────────────────────────────────────────────────
  console.log("\nC. THE RESOLVER — every live state reads a real column; reserved states never returned");
  // ────────────────────────────────────────────────────────────────
  const rs = (uid, prop = S.prop) => read((c) => resolver.resolveStaffIdentity(c, { user_id: uid, property_id: prop }));
  const seen = [];
  const check = async (label, uid, expectState, prop) => T(label, async () => {
    const r = await rs(uid, prop); seen.push(r.state);
    assert(r.state === expectState, `expected ${expectState}, got ${r.state} (${r.basis})`);
  });

  await check("C1  resolved: bridge + human_staff + active account + active assignment HERE", S.kandice, "resolved");
  await T("C1b resolved result carries user/person/assignment/role/basis", async () => {
    const r = await rs(S.kandice);
    assert(r.person_id && r.assignment_id && r.role === "leasing" && r.basis === "bridge_plus_active_assignment");
  });
  await check("C2  unbridged: no person_id", S.john, "unbridged");
  await check("C3  user_inactive: is_active=false fails closed", S.inactive, "user_inactive");
  await check("C4  user_inactive: status='suspended' fails closed", S.suspended, "user_inactive");
  await check("C5  user_inactive: status='invited' fails closed", S.invited, "user_inactive");
  await check("C6  user_inactive: UNKNOWN future status ('frozen') fails closed", S.frozen, "user_inactive");
  await check("C7  assignment_inactive: assignment exists but is off", S.nonadmin, "assignment_inactive");
  await check("C8  not_assigned_here: the cross-property wall (eligible at A, asked at B)", S.kandice, "not_assigned_here", S.prop2);
  await check("C9  conflicted: one person linked from two active accounts → no automatic ownership", S.dupA, "conflicted");
  await T("C10 free_text_claim: no user id at all", async () => {
    const r = await read((c) => resolver.resolveStaffIdentity(c, { user_id: null, property_id: S.prop }));
    seen.push(r.state); assert(r.state === "free_text_claim");
  });
  await T("C11 defense in depth: a pointer on a non-human account never resolves", async () => {
    await tx((c) => c.query(`update users set person_id=$2 where id=$1`, [S.svc, S.katiePerson])); // simulate corruption
    const r = await rs(S.svc); seen.push(r.state);
    assert(r.state !== "resolved" && r.basis.startsWith("account_kind_not_bridgeable"));
    await tx((c) => c.query(`update users set person_id=null where id=$1`, [S.svc]));
  });
  await T("C12 RESERVED states are exported, documented, and NEVER returned", async () => {
    assert(resolver.RESERVED_STATES.includes("assignment_ended"));
    assert(resolver.RESERVED_STATES.includes("assignment_not_eligible_by_work_type"));
    for (const s of seen) assert(resolver.LIVE_STATES.includes(s), `state ${s} outside the live vocabulary`);
    for (const s of seen) assert(!resolver.RESERVED_STATES.includes(s), `reserved state ${s} was returned`);
  });

  // ────────────────────────────────────────────────────────────────
  console.log("\nD. OWNERSHIP FALLBACK — eligible actual host → eligible scheduled host → UNASSIGNED");
  // ────────────────────────────────────────────────────────────────
  const ro = (cands, prop = S.prop) => read((c) => resolver.resolveEligibleOwner(c, prop, cands));
  await T("D1  eligible actual host owns", async () => {
    const r = await ro([S.kandice, S.katie]);
    assert(r.owner === S.kandice && r.basis === "eligible_assignment");
  });
  await T("D2  unbridged actual host → falls to eligible scheduled host", async () => {
    const r = await ro([S.john, S.katie]);
    assert(r.owner === S.katie, "John's claim is preserved elsewhere; ownership falls back honestly");
  });
  await T("D3  suspended actual + inactive scheduled → UNASSIGNED, never faked", async () => {
    const r = await ro([S.suspended, S.inactive]);
    assert(r.owner === null && r.basis === "unassigned");
  });
  await T("D4  conflicted candidate never owns", async () => {
    const r = await ro([S.dupA, S.dupB]);
    assert(r.owner === null, "both accounts share one person — conflict blocks both");
  });
  await T("D5  cross-property: eligible at A owns NOTHING at B", async () => {
    const r = await ro([S.kandice, S.katie], S.prop2);
    assert(r.owner === null);
  });

  // ────────────────────────────────────────────────────────────────
  console.log("\nE. THE ROSTER — only fully-resolving people; honest exclusions");
  // ────────────────────────────────────────────────────────────────
  await T("E1  roster = Kandice + Katie only (excludes unbridged, inactive-account, inactive-assignment, conflicted, service)", async () => {
    const rows = await read((c) => resolver.listEligibleStaff(c, S.prop));
    const names = rows.map((r) => r.name).sort();
    assert(JSON.stringify(names) === JSON.stringify(["Kandice", "Katie"]), `got: ${names.join(", ")}`);
  });
  await T("E2  roster at the other property is honestly empty", async () => {
    const rows = await read((c) => resolver.listEligibleStaff(c, S.prop2));
    assert(rows.length === 0);
  });

  // ────────────────────────────────────────────────────────────────
  console.log("\nF. HTTP — session-derived authority, admin gate, DEMO_MODE widening");
  // ────────────────────────────────────────────────────────────────
  process.env.DEMO_MODE = "true";   // prod reality: the boardroom bootstrap requires it
  const appProd = express(); appProd.use(express.json()); appProd.use("/", buildStaffBridge({ pool }));
  const prod = await serve(appProd);
  delete process.env.DEMO_MODE;

  await T("F1  no session → 403", async () => {
    const r = await call(prod.port, "GET", "/operator/admin/bridge/coverage");
    assert(r.status === 403);
  });
  await T("F2  non-admin role session → 403", async () => {
    const r = await call(prod.port, "GET", "/operator/admin/bridge/coverage", { token: S.nonadminToken });
    assert(r.status === 403);
  });
  await T("F3  leasing_manager blocked EVEN under DEMO_MODE=true — the public demo code can never reach bridge admin", async () => {
    const a = await call(prod.port, "GET", "/operator/admin/bridge/coverage", { token: S.katieToken });
    assert(a.status === 403, `expected 403, got ${a.status} — the widening must not exist`);
  });
  await T("F3b a SERVICE account holding an admin role is still refused (kind defense)", async () => {
    const botToken = tok("bot");
    const bot = (await read((c) => c.query(
      `insert into users (name, email, role) values ('Bot PM',$1,'property_manager') returning id`,
      [em("botpm")]))).rows[0].id;
    await tx((c) => bridgeSvc.classifyAccount(c, { user_id: bot, account_kind: "service_account", performed_by_user_id: S.admin }));
    await tx((c) => c.query(`insert into staff_sessions (user_id, property_id, token, expires_at)
                             values ($1,$2,$3, now() + interval '6 hours')`, [bot, S.prop, botToken]));
    const r = await call(prod.port, "GET", "/operator/admin/bridge/coverage", { token: botToken });
    assert(r.status === 403);
  });
  await T("F4  performed_by is SERVER-DERIVED — a body-supplied performed_by_user_id is ignored", async () => {
    const r = await call(prod.port, "POST", "/operator/admin/bridge/link", {
      token: S.adminToken,
      body: { user_id: S.john, create_staff_person: { name: "John Banks" },
              reason_code: "http_proof",
              performed_by_user_id: S.nonadmin,        // an attacker's claim — must be ignored
              request_id: "req-john-http-1" } });
    assert(r.status === 200, JSON.stringify(r.json));
    const a = (await read((c) => c.query(
      `select performed_by_user_id from user_person_bridge_audit
        where user_id=$1 order by performed_at desc limit 1`, [S.john]))).rows[0];
    assert(a.performed_by_user_id === S.admin, "audit names the SESSION admin, not the body claim");
    // restore John to unbridged for the suppression proof below
    await tx((c) => bridgeSvc.unlinkBridge(c, { user_id: S.john, reason_code: "proof_reset", performed_by_user_id: S.admin }));
  });
  await T("F5  coverage report: states + 004↔035 divergence (John = unbridged, team_035_only)", async () => {
    const r = await call(prod.port, "GET", "/operator/admin/bridge/coverage", { token: S.adminToken });
    assert(r.status === 200);
    const john = r.json.users.find((u) => u.id === S.john);
    assert(john.bridge_state === "unbridged");
    assert(john.divergence.some((d) => d.kind === "team_035_only"), "035 row grants NO eligibility — flagged, not honored");
    const kandice = r.json.users.find((u) => u.id === S.kandice);
    assert(kandice.bridge_state === "linked_and_eligible" && kandice.eligible_to_receive_new_work === true);
    const dup = r.json.users.find((u) => u.id === S.dupA);
    assert(dup.bridge_state === "conflicted");
  });
  prod.srv.close();

  // ────────────────────────────────────────────────────────────────
  console.log("\nG. THE STAFF LEAK — closed (patched persons-list predicate)");
  // ────────────────────────────────────────────────────────────────
  const LEAK_GUARD_SQL = `
    select id, name from persons
     where not exists (select 1 from person_contexts pc
                        where pc.person_id = persons.id
                          and pc.context_type = 'staff' and pc.active_to is null
                          and not exists (select 1 from leasing_leads ll
                                           where ll.person_id = persons.id))
     order by created_at desc`;
  await T("G1  a staff-only person (floor lifecycle 'lead') is EXCLUDED from the inquiries list", async () => {
    const rows = (await read((c) => c.query(LEAK_GUARD_SQL))).rows;
    assert(!rows.some((r) => String(r.id) === String(S.kandicePerson)), "Kandice must not appear as an inquiry");
    assert(!rows.some((r) => String(r.id) === String(S.katiePerson)));
  });
  await T("G2  an ordinary lead still appears; a staff person WITH a real leasing relationship also appears (additive contexts)", async () => {
    await tx((c) => c.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [S.katiePerson, S.prop2]));
    const rows = (await read((c) => c.query(LEAK_GUARD_SQL))).rows;
    assert(rows.some((r) => String(r.id) === String(S.leadPerson)), "Larry Lead visible");
    assert(rows.some((r) => String(r.id) === String(S.katiePerson)), "Katie-as-genuine-prospect visible — additive, not mutually exclusive");
    await tx((c) => c.query(`delete from leasing_leads where person_id=$1 and property_id=$2`, [S.katiePerson, S.prop2]));
  });

  // ────────────────────────────────────────────────────────────────
  console.log("\nH. LOOP-B SIBLINGS — suppressed; nothing invisible, nothing lost");
  // ────────────────────────────────────────────────────────────────
  const convRouter = buildConversion({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
    completeObligation: engine.completeObligation });
  const convSvc = convRouter._service || convRouter.services;
  await T("H1  multi-move conversion spawns the ANCHOR only; zero leasing_task obligations; extras recorded as a durable event", async () => {
    const prospect = (await read((c) => c.query(
      `insert into persons (name, phone) values ('Pat Prospect','+12155550188') returning id`))).rows[0];
    const out = await tx((c) => convSvc.createConversionFromTour(c, {
      person_id: prospect.id, property_id: S.prop, origin_tour_id: S.tour, lead_id: S.lead,
      scheduled_tour_host_user_id: S.katie, actual_tour_host_user_id: S.kandice,
      tour_outcome: "interested",
      recommendations: ["send_application", "send_floor_plans", "set_follow_up_time"],
    }));
    assert(out.sibling_tasks.length === 0, "no sibling obligations spawned");
    assert(out.sibling_tasks_suppressed === true);
    assert(JSON.stringify(out.suppressed_move_codes) === JSON.stringify(["send_floor_plans", "set_follow_up_time"]));
    assert(out.next_move_code === "send_application", "primary anchor intact");
    const sib = (await read((c) => c.query(
      `select count(*)::int n from obligations where type='leasing_task' and related_id=$1`, [out.conversion.id]))).rows[0];
    assert(sib.n === 0, "database confirms: zero invisible owned work");
    const ev = (await read((c) => c.query(
      `select note from events where type='leasing_next_moves_recorded' and person_id=$1`, [prospect.id]))).rows;
    assert(ev.length === 1 && ev[0].note.includes("[send_floor_plans,set_follow_up_time]")
        && ev[0].note.includes("send floor plans of available units"),
      "the operator's full intent survives as a fact, in human language with machine codes");
    // the OWNER lives on the conversion-link row (leasing_conversion_obligations)
    const anchor = (await read((c) => c.query(
      `select owner_user_id from leasing_conversion_obligations
        where conversion_id=$1 and rung='tour_followup'`, [out.conversion.id]))).rows;
    assert(anchor.length === 1 && anchor[0].owner_user_id === S.kandice,
      "bridged actual host OWNS the anchor follow-up — the primary activation, live");
  });
  await T("H2  unbridged actual host: claim preserved, anchor falls back to the eligible scheduled host", async () => {
    const prospect = (await read((c) => c.query(
      `insert into persons (name, phone) values ('Quinn Prospect','+12155550189') returning id`))).rows[0];
    const out = await tx((c) => convSvc.createConversionFromTour(c, {
      person_id: prospect.id, property_id: S.prop, origin_tour_id: S.tour, lead_id: S.lead,
      scheduled_tour_host_user_id: S.katie, actual_tour_host_user_id: S.john,   // John: unbridged
      tour_outcome: "interested", recommendation: "send_application",
    }));
    assert(out.conversion.actual_tour_host_user_id === S.john, "the CLAIM stands — attribution is not ownership");
    const anchor = (await read((c) => c.query(
      `select owner_user_id from leasing_conversion_obligations
        where conversion_id=$1 and rung='tour_followup'`, [out.conversion.id]))).rows[0];
    assert(anchor.owner_user_id === S.katie, "ownership fell back to the eligible scheduled host — never faked onto John");
  });

  // ────────────────────────────────────────────────────────────────
  console.log("\nI. WHAT STAYS DARK — the ledger cannot wake up from this deploy");
  // ────────────────────────────────────────────────────────────────
  await T("I1  Commitment Ledger dormant gate still fail-closed (COMMITMENT_LEDGER_MODE unset)", async () => {
    delete process.env.COMMITMENT_LEDGER_MODE;
    const gate = require("../src/identity/dormant_gate.js");
    assert(gate.resolveMode() === "dormant", `expected dormant, got ${gate.resolveMode()}`);
  });

  // ────────────────────────────────────────────────────────────────
  console.log("\nJ. THE STATIC GATE — no raw bridge joins outside the resolver");
  // ────────────────────────────────────────────────────────────────
  await T("J1  gate PASSES on the patched tree", async () => {
    execSync(`node ${path.join(__dirname, "gate_no_raw_bridge_joins.js")}`, { stdio: "pipe" });
  });
  await T("J2  gate FAILS when a raw join is planted", async () => {
    const plant = path.join(__dirname, "..", "zz_planted_violation.js");
    fs.writeFileSync(plant, `// planted\nconst q = "select 1 from assignments a join users u on u.person_id = a.person_id";\n`);
    let failed = false;
    try { execSync(`node ${path.join(__dirname, "gate_no_raw_bridge_joins.js")}`, { stdio: "pipe" }); }
    catch (_) { failed = true; }
    fs.unlinkSync(plant);
    assert(failed, "the gate must catch the planted join");
  });

  console.log(`\n═══ RESULT: ${pass} passed · ${fail} failed ═══\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE CRASHED:", e); process.exit(1); });
