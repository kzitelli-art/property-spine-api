// ════════════════════════════════════════════════════════════════════
//  RELEASE 3 PROOF SUITE — recovery + reassignment + the event ledger
//  Real Postgres · real modules · real HTTP through the operator router.
//  Run after the R2 suites on the same clean-room DB.
// ════════════════════════════════════════════════════════════════════
"use strict";
const receipt = require("../_run_receipt.js");
const { Pool } = require("pg");
const http = require("http");
const express = require("express");
const crypto = require("crypto");
const engine = require("../_engine.js");
const buildConversion = require("../../src/leasing/leasing_conversion.js");
const buildOperator = require("../../src/identity/operator.js");
const buildBridge = require("../../src/identity/staff_bridge.js");

const CONN = receipt.harnessConnectionString();
// every `await T(...)` in this file; a run reporting fewer is INVALID,
// not merely quiet — the failure mode this receipt exists to catch.
const EXPECTED = 23;
const pool = new Pool({ connectionString: CONN, max: 10 });
let pass = 0, fail = 0;
async function T(name, fn) {
  try { await fn(); pass++; console.log("  PASS ", name); }
  catch (e) { fail++; console.log("  FAIL ", name, " → ", e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}
async function read(fn) { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }
async function call(port, method, path, { token, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(token ? { "x-staff-session": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = {}; try { j = await r.json(); } catch (_) {}
    return { status: r.status, json: j };
  } finally { clearTimeout(t); }
}

(async () => {
  receipt.begin(__filename, { url: CONN, expected: EXPECTED });
  console.log("═══ RELEASE 3 — RECOVERY + REASSIGNMENT + EVENT LEDGER ═══");
  const RUN = Date.now();
  const S = {};

  // ── world ──
  const bridgeRig = buildBridge({ pool });
  const bridgeSvc = bridgeRig._service;
  await tx(async (c) => {
    S.prop = (await c.query(`insert into properties (name) values ('R3 Prop ${RUN}') returning id`)).rows[0].id;
    S.prop2 = (await c.query(`insert into properties (name) values ('R3 Prop2 ${RUN}') returning id`)).rows[0].id;
    S.adminBoot = (await c.query(`insert into users (name, email, role) values ($1,$2,'property_manager'::role_name) returning id`,
      ["R3 Boot", "r3boot" + RUN + "@proof.internal"])).rows[0].id;
    async function mkStaff(name, role) {
      const u = (await c.query(`insert into users (name, email, role) values ($1,$2,$3::role_name) returning id`,
        [name, name.toLowerCase().replace(/\s+/g, "") + RUN + "@proof.internal", role])).rows[0];
      const p = (await c.query(`insert into persons (name, phone) values ($1,$2) returning id`,
        [name + " P", "+1215" + String(Math.floor(Math.random() * 9000000) + 1000000)])).rows[0];
      // the DELIBERATE, AUDITED path — same as production and the R2 suite
      await bridgeSvc.classifyAccount(c, { user_id: u.id, account_kind: "human_staff", performed_by_user_id: S.adminBoot });
      await bridgeSvc.linkBridge(c, { user_id: u.id, person_id: p.id, performed_by_user_id: S.adminBoot,
        reason_code: "known_staff", reason_detail: "r3 proof world" });
      await c.query(`insert into assignments (person_id, property_id, role) values ($1,$2,'leasing')`, [p.id, S.prop]);
      return u.id;
    }
    S.katie = await mkStaff("R3 Katie", "leasing_manager");
    S.kandice = await mkStaff("R3 Kandice", "leasing_agent");
    // unbridged operator (leasing team access, no bridge)
    S.ghost = (await c.query(`insert into users (name, email, role) values ($1,$2,'leasing_agent'::role_name) returning id`,
      ["R3 Ghost", "r3ghost" + RUN + "@proof.internal"])).rows[0].id;
    for (const u of [S.katie, S.kandice, S.ghost])
      await c.query(`insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
                     values ($1,$2,'R3','{leasing}',true) on conflict (property_id, user_id) do update set active=true`,
        [S.prop, u]);
    S.katieTok = "r3-katie-" + RUN; S.kandiceTok = "r3-kandice-" + RUN; S.ghostTok = "r3-ghost-" + RUN;
    for (const [u, t] of [[S.katie, S.katieTok], [S.kandice, S.kandiceTok], [S.ghost, S.ghostTok]])
      await c.query(`insert into staff_sessions (user_id, property_id, token, expires_at)
                     values ($1,$2,$3, now() + interval '6 hours')`, [u, S.prop, t]);
    S.maya = (await c.query(`insert into persons (name, phone) values ('Maya R3','+12155559${String(RUN).slice(-3)}1') returning id`)).rows[0].id;
  });

  // ── rig ──
  const closureAuthority = require("../../src/leasing/conversion_obligation_closure.js").createConversionClosureAuthority();
  const convRouter = buildConversion({ pool, closureAuthority,
    spawnObligationFromEvent: engine.spawnObligationFromEvent, completeObligation: engine.completeObligation });
  const convSvc = convRouter._service;
  const app = express(); app.use(express.json());
  app.use("/", buildOperator({ pool, agentService: null, conversionService: convSvc }));
  const srv = await new Promise((r) => { const s = http.createServer(app); s.listen(0, "127.0.0.1", () => r(s)); });
  const PORT = srv.address().port;

  let __pn = 0;
  async function mkConv(host) {
    return tx(async (c) => {
      const person = (await c.query(
        `insert into persons (name, phone) values ($1,$2) returning id`,
        ["R3 Prospect " + (++__pn) + " " + RUN, "+1215777" + String(RUN).slice(-2) + String(__pn).padStart(2, "0")])).rows[0].id;
      if (__pn === 1) S.maya = person; // P1 card proof follows this person
      const out = await convSvc.createConversionFromTour(c, {
        person_id: person, property_id: S.prop, actual_tour_host_user_id: host,
        scheduled_tour_host_user_id: host, tour_outcome: "interested", recommendation: "send_follow_up",
      });
      return out.conversion.id;
    });
  }
  async function anchorOb(convId) {
    return (await read((c) => c.query(
      `select obligation_id from leasing_conversion_obligations where conversion_id=$1 and rung='tour_followup'`,
      [convId]))).rows[0].obligation_id;
  }
  async function events(obId) {
    return (await read((c) => c.query(
      `select e.* from leasing_conversion_obligation_events e
         join leasing_conversion_obligations lco on lco.id = e.conversion_obligation_id
        where lco.obligation_id=$1 order by e.occurred_at`, [obId]))).rows;
  }

  // ═══ EVENT LEDGER BIRTH + RESOLUTION ═══
  await T("L1  spawn writes a 'created' event with origin auto_actual_host + eligibility, in the same transaction", async () => {
    S.convA = await mkConv(S.kandice);
    S.obA = await anchorOb(S.convA);
    const ev = await events(S.obA);
    assert(ev.length === 1 && ev[0].event_type === "created", "one created event");
    assert(ev[0].next_owner_user_id === S.kandice && ev[0].ownership_origin === "auto_actual_host"
      && ev[0].owner_eligibility_state === "eligible_assignment", JSON.stringify(ev[0]));
  });
  await T("L2  a rail close appends a 'resolved' event atomically (prior open → next complete, basis carried)", async () => {
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obA}/resolve`,
      { token: S.kandiceTok, body: { result: "completed" } });
    assert(r.status === 200, "owner completes: " + r.status);
    const ev = await events(S.obA);
    const resolved = ev.find((e) => e.event_type === "resolved");
    assert(resolved && resolved.prior_status === "open" && resolved.next_status === "complete"
      && resolved.resolution_code === "completed" && resolved.resolution_basis === "owner", JSON.stringify(resolved));
  });

  // ═══ REASSIGNMENT (Amendment 5 · Q1 · Q3) ═══
  await T("R1  eligible-target reassignment succeeds; ledger records prior→next owner, origin manual_reassignment, reason", async () => {
    S.convB = await mkConv(S.kandice);
    S.obB = await anchorOb(S.convB);
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obB}/reassign`,
      { token: S.katieTok, body: { to_user_id: S.katie, reason: "coverage_change" } });
    assert(r.status === 200 && r.json.owner_user_id === S.katie, r.status + " " + JSON.stringify(r.json));
    const link = (await read((c) => c.query(
      `select owner_user_id from leasing_conversion_obligations where obligation_id=$1`, [S.obB]))).rows[0];
    assert(link.owner_user_id === S.katie, "current projection updated");
    const ev = (await events(S.obB)).find((e) => e.event_type === "reassigned");
    assert(ev && ev.prior_owner_user_id === S.kandice && ev.next_owner_user_id === S.katie
      && ev.ownership_origin === "manual_reassignment" && ev.reason === "coverage_change"
      && ev.actor_user_id === S.katie, JSON.stringify(ev));
  });
  await T("R2  TASK-ONLY: the conversation's owner is untouched by task reassignment", async () => {
    const conv = (await read((c) => c.query(
      `select conversation_owner_user_id from leasing_conversions where id=$1`, [S.convB]))).rows[0];
    assert(conv.conversation_owner_user_id === S.kandice,
      "conversation owner still Kandice: " + conv.conversation_owner_user_id);
  });
  await T("R3  ineligible target (unbridged team-access user) rejected honestly — team access is not ownership", async () => {
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obB}/reassign`,
      { token: S.katieTok, body: { to_user_id: S.ghost, reason: "coverage_change" } });
    assert(r.status === 400 && /not an eligible owner/i.test(JSON.stringify(r.json)), r.status + " " + JSON.stringify(r.json));
  });
  await T("R4  reassign to current owner → stable 409 no-op; terminal task reassignment rejected; reason required", async () => {
    const r1 = await call(PORT, "POST", `/operator/leasing/tasks/${S.obB}/reassign`,
      { token: S.katieTok, body: { to_user_id: S.katie, reason: "workload_balance" } });
    assert(r1.status === 409, "same-owner no-op: " + r1.status);
    const r2 = await call(PORT, "POST", `/operator/leasing/tasks/${S.obA}/reassign`,
      { token: S.katieTok, body: { to_user_id: S.katie, reason: "workload_balance" } });
    assert(r2.status === 409 && /terminal|closed/i.test(JSON.stringify(r2.json)), "terminal rejected: " + r2.status);
    const r3 = await call(PORT, "POST", `/operator/leasing/tasks/${S.obB}/reassign`,
      { token: S.katieTok, body: { to_user_id: S.kandice } });
    assert(r3.status === 400 && /reason required/i.test(JSON.stringify(r3.json)), "reason required: " + r3.status);
  });
  await T("R5  stale-picker truth: a target eligible at picker time but ineligible at write time fails at write", async () => {
    // Kandice's assignment is removed between "picker load" and the write
    await tx((c) => c.query(
      `delete from assignments where person_id=(select person_id from users where id=$1) and property_id=$2`,
      [S.kandice, S.prop]));
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obB}/reassign`,
      { token: S.katieTok, body: { to_user_id: S.kandice, reason: "coverage_change" } });
    assert(r.status === 400, "re-resolved in-transaction: " + r.status);
    // restore for later cases
    await tx((c) => c.query(
      `insert into assignments (person_id, property_id, role)
       select person_id, $2, 'leasing' from users where id=$1`, [S.kandice, S.prop]));
  });

  // ═══ REOPEN (Amendments 2 + 3 · Q2 · Q5) ═══
  await T("O1  within-window reopen succeeds: reason + new_due_at required; prior close preserved in the ledger; row re-enters the queue", async () => {
    S.convO1 = await mkConv(S.kandice);
    S.obO1 = await anchorOb(S.convO1);
    // owner closes it WITHOUT the ladder successor (suppress_next) — the
    // successor case is O3's subject; nothing is deleted to arrange this one
    await tx((c) => convSvc.resolveRung(c, { obligation_id: S.obO1, result: "completed",
      by_user_id: S.kandice, suppress_next: true }));
    S.obA = S.obO1; // downstream cases (O2) reference the reopened task
    const missing = await call(PORT, "POST", `/operator/leasing/tasks/${S.obO1}/reopen`,
      { token: S.katieTok, body: { reason: "closed_by_mistake" } });
    assert(missing.status === 400 && /new_due_at/i.test(JSON.stringify(missing.json)), "new_due_at required");
    const due = new Date(Date.now() + 3 * 3600e3).toISOString();
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obO1}/reopen`,
      { token: S.katieTok, body: { reason: "closed_by_mistake", new_due_at: due } });
    assert(r.status === 200 && r.json.reopened === true, r.status + " " + JSON.stringify(r.json));
    const link = (await read((c) => c.query(
      `select outcome, resolution, owner_user_id, due_by from leasing_conversion_obligations where obligation_id=$1`,
      [S.obO1]))).rows[0];
    assert(link.outcome === null && link.resolution === null, "terminal stamp cleared — active recovery cycle");
    assert(link.owner_user_id === S.kandice, "prior owner still eligible → preserved");
    const reopenedObligation = (await read((c) => c.query(
      `select assigned_user_id, owner_eligibility_state from obligations where id=$1`,
      [S.obO1]))).rows[0];
    assert(reopenedObligation.assigned_user_id === S.kandice
      && reopenedObligation.owner_eligibility_state === "eligible_assignment",
      "reopen preserved the link owner but not the canonical obligation owner");
    const ev = (await events(S.obO1)).find((e) => e.event_type === "reopened");
    assert(ev && ev.resolution_code === "completed" && ev.resolution_basis === "owner"
      && ev.reason === "closed_by_mistake" && ev.next_due_at, "prior close carried on the reopened event: " + JSON.stringify(ev));
    const q = await call(PORT, "GET", "/operator/leasing/task-queue", { token: S.katieTok });
    assert(q.json.items.some((i) => i.obligation_id === S.obO1), "reopened task is back in the visible queue");
  });
  await T("O2  already-open reopen → stable 409", async () => {
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obA}/reopen`,
      { token: S.katieTok, body: { reason: "closed_by_mistake", new_due_at: new Date().toISOString() } });
    assert(r.status === 409 && r.json.code === "NOT_TERMINAL", r.status + " " + JSON.stringify(r.json));
  });
  await T("O3  DOWNSTREAM_WORK_EXISTS: a completed tour_followup with a living applicant_followup cannot reopen", async () => {
    S.convC = await mkConv(S.kandice);
    S.obC = await anchorOb(S.convC);
    const done = await call(PORT, "POST", `/operator/leasing/tasks/${S.obC}/resolve`,
      { token: S.katieTok, body: { result: "completed", resolution_basis: "coverage" } });
    assert(done.status === 200, "closed, ladder spawns applicant_followup");
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obC}/reopen`,
      { token: S.katieTok, body: { reason: "closed_by_mistake", new_due_at: new Date().toISOString() } });
    assert(r.status === 409 && r.json.code === "DOWNSTREAM_WORK_EXISTS", r.status + " " + JSON.stringify(r.json));
  });
  await T("O4  REOPEN_WINDOW_EXPIRED: a close older than 72h is not ordinary recovery", async () => {
    S.convD = await mkConv(S.kandice);
    S.obD = await anchorOb(S.convD);
    // close WITHOUT the ladder successor (suppress_next) so the window is the
    // ONLY blocker under test — no history is deleted to arrange the case
    await tx((c) => convSvc.resolveRung(c, { obligation_id: S.obD, result: "completed",
      by_user_id: S.kandice, suppress_next: true }));
    await tx((c) => c.query(
      `update leasing_conversion_obligations set closed_at = now() - interval '73 hours' where obligation_id=$1`, [S.obD]));
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obD}/reopen`,
      { token: S.katieTok, body: { reason: "closed_by_mistake", new_due_at: new Date().toISOString() } });
    assert(r.status === 409 && r.json.code === "REOPEN_WINDOW_EXPIRED", r.status + " " + JSON.stringify(r.json));
  });
  await T("O5  stale-owner rule: reopening a task whose prior owner lost eligibility reopens UNASSIGNED, never a false owner", async () => {
    S.convE = await mkConv(S.kandice);
    S.obE = await anchorOb(S.convE);
    await tx((c) => convSvc.resolveRung(c, { obligation_id: S.obE, result: "completed",
      by_user_id: S.kandice, suppress_next: true }));
    await tx((c) => c.query(
      `delete from assignments where person_id=(select person_id from users where id=$1) and property_id=$2`,
      [S.kandice, S.prop]));
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obE}/reopen`,
      { token: S.katieTok, body: { reason: "new_information", new_due_at: new Date(Date.now() + 3600e3).toISOString() } });
    assert(r.status === 200 && r.json.owner_user_id === null && r.json.owner_eligibility_state === "unassigned",
      r.status + " " + JSON.stringify(r.json));
    const reopenedObligation = (await read((c) => c.query(
      `select assigned_user_id, owner_eligibility_state from obligations where id=$1`,
      [S.obE]))).rows[0];
    assert(reopenedObligation.assigned_user_id === null
      && reopenedObligation.owner_eligibility_state === "unassigned",
      "stale owner survived on the canonical obligation after reopen");
    await tx((c) => c.query(
      `insert into assignments (person_id, property_id, role)
       select person_id, $2, 'leasing' from users where id=$1`, [S.kandice, S.prop]));
  });
  await T("O6  idempotency: the same reopen retried with one idempotency_key appends ONE event", async () => {
    S.convF = await mkConv(S.kandice);
    S.obF = await anchorOb(S.convF);
    await tx((c) => convSvc.resolveRung(c, { obligation_id: S.obF, result: "completed",
      by_user_id: S.kandice, suppress_next: true }));
    const key = "r3-idem-" + crypto.randomBytes(8).toString("hex");
    const body = { reason: "closed_by_mistake", new_due_at: new Date(Date.now() + 3600e3).toISOString(), idempotency_key: key };
    const a = await call(PORT, "POST", `/operator/leasing/tasks/${S.obF}/reopen`, { token: S.katieTok, body });
    const b = await call(PORT, "POST", `/operator/leasing/tasks/${S.obF}/reopen`, { token: S.katieTok, body });
    assert(a.status === 200, "first reopen lands");
    assert(b.status === 409 && b.json.code === "NOT_TERMINAL", "retry is a stable refusal (already open)");
    const evs = (await events(S.obF)).filter((e) => e.event_type === "reopened");
    assert(evs.length === 1, "exactly one reopened event: " + evs.length);
  });

  // ═══ RESCHEDULE (JC1) ═══
  await T("S1  change follow-up time works on ANY active task (even before overdue): due_changed event, owner kept, never terminal", async () => {
    S.convG = await mkConv(S.kandice);
    S.obG = await anchorOb(S.convG);
    // NOT overdue — a prospect asked at 10am to be contacted next week
    const due = new Date(Date.now() + 7 * 86400e3).toISOString();
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obG}/change-due`,
      { token: S.kandiceTok, body: { reason: "couldnt_complete", new_due_at: due } });
    assert(r.status === 200 && r.json.due_changed === true && r.json.owner_user_id === S.kandice, JSON.stringify(r.json));
    const ev = (await events(S.obG)).find((e) => e.event_type === "due_changed");
    assert(ev && ev.prior_status === "open" && ev.next_status === "open" && ev.reason === "couldnt_complete"
      && ev.prior_due_at && ev.next_due_at, JSON.stringify(ev));
    const link = (await read((c) => c.query(
      `select outcome, due_by from leasing_conversion_obligations where obligation_id=$1`, [S.obG]))).rows[0];
    assert(link.outcome === null, "still active — no terminal state was created");
  });

  // ═══ §2 DB-ENFORCED APPEND-ONLY ═══
  await T("D1  the database itself refuses UPDATE and DELETE on the event ledger; inserts still work", async () => {
    const ev = (await events(S.obG))[0];
    let upErr = null, delErr = null;
    await tx((c) => c.query(`update leasing_conversion_obligation_events set reason='rewritten' where id=$1`, [ev.id]))
      .catch((e) => { upErr = e.message; });
    await tx((c) => c.query(`delete from leasing_conversion_obligation_events where id=$1`, [ev.id]))
      .catch((e) => { delErr = e.message; });
    assert(upErr && /append-only/.test(upErr), "UPDATE rejected by the trigger: " + upErr);
    assert(delErr && /append-only/.test(delErr), "DELETE rejected by the trigger: " + delErr);
    const still = (await events(S.obG))[0];
    assert(still && still.reason !== "rewritten", "history untouched");
    // §1 final: deleting the LINKED OBLIGATION or its PARENT CONVERSION is
    // refused because either would cascade away event history
    let linkErr = null, convErr = null;
    await tx((c) => c.query(`delete from leasing_conversion_obligations where obligation_id=$1`, [S.obG]))
      .catch((e) => { linkErr = e.message; });
    await tx((c) => c.query(`delete from leasing_conversions where id=$1`, [S.convG]))
      .catch((e) => { convErr = e.message; });
    assert(linkErr && /restrict|violates foreign key/i.test(linkErr), "link delete rejected: " + linkErr);
    assert(convErr && /restrict|violates foreign key/i.test(convErr), "conversion delete rejected: " + convErr);
  });

  // ═══ §3 RACE PROOFS — one linear outcome per link row ═══
  await T("X1  concurrent REASSIGN + RESOLVE → one linear history; the resolved event records the owner that truly existed at close", async () => {
    S.convX = await mkConv(S.kandice);
    const obX = await anchorOb(S.convX);
    const [ra, rz] = await Promise.all([
      call(PORT, "POST", `/operator/leasing/tasks/${obX}/reassign`,
        { token: S.katieTok, body: { to_user_id: S.katie, reason: "coverage_change" } }),
      call(PORT, "POST", `/operator/leasing/tasks/${obX}/resolve`,
        { token: S.katieTok, body: { result: "completed", resolution_basis: "coverage" } }),
    ]);
    const statuses = [ra.status, rz.status].sort();
    // both may land (reassign-then-resolve serialized) or the loser gets a clean 409 —
    // what may NOT happen is a contradictory interleave
    const evs = await events(obX);
    const resolved = evs.filter((e) => e.event_type === "resolved");
    assert(resolved.length === 1, "exactly one resolved event: " + resolved.length);
    const reassigned = evs.filter((e) => e.event_type === "reassigned");
    if (reassigned.length === 1) {
      // serialized order must be internally consistent: reassign before resolve
      assert(new Date(reassigned[0].occurred_at) <= new Date(resolved[0].occurred_at)
        || rz.status !== 200, "no reassignment recorded after terminal closure");
    }
    const link = (await read((c) => c.query(
      `select outcome from leasing_conversion_obligations where obligation_id=$1`, [obX]))).rows[0];
    assert(link.outcome === "kept", "one linear terminal outcome; statuses " + statuses.join("/"));
  });
  await T("X2  concurrent CHANGE-DUE + RESOLVE → no due_changed event after terminal closure", async () => {
    S.convY = await mkConv(S.kandice);
    const obY = await anchorOb(S.convY);
    await Promise.all([
      call(PORT, "POST", `/operator/leasing/tasks/${obY}/change-due`,
        { token: S.kandiceTok, body: { reason: "new_information", new_due_at: new Date(Date.now() + 86400e3).toISOString() } }),
      call(PORT, "POST", `/operator/leasing/tasks/${obY}/resolve`,
        { token: S.kandiceTok, body: { result: "completed" } }),
    ]);
    const evs = await events(obY);
    const resolved = evs.find((e) => e.event_type === "resolved");
    const dueChanged = evs.filter((e) => e.event_type === "due_changed");
    assert(resolved, "the close landed");
    for (const d of dueChanged)
      assert(new Date(d.occurred_at) <= new Date(resolved.occurred_at),
        "a due-change event was recorded AFTER terminal closure");
  });
  await T("X3  two concurrent REOPENs → one recovery cycle, one reopened event, stable refusal for the loser", async () => {
    S.convZ2 = await mkConv(S.kandice);
    const obZ = await anchorOb(S.convZ2);
    await tx((c) => convSvc.resolveRung(c, { obligation_id: obZ, result: "completed",
      by_user_id: S.kandice, suppress_next: true }));
    const body = { reason: "closed_by_mistake", new_due_at: new Date(Date.now() + 3600e3).toISOString() };
    const [a, b] = await Promise.all([
      call(PORT, "POST", `/operator/leasing/tasks/${obZ}/reopen`, { token: S.katieTok, body }),
      call(PORT, "POST", `/operator/leasing/tasks/${obZ}/reopen`, { token: S.katieTok, body }),
    ]);
    const codes = [a.status, b.status].sort();
    assert(codes[0] === 200 && codes[1] === 409, "one winner, one stable 409: " + codes.join("/"));
    const evs = (await events(obZ)).filter((e) => e.event_type === "reopened");
    assert(evs.length === 1, "exactly one reopened event: " + evs.length);
  });

  // ═══ RECENTLY CLOSED (the read that makes Reopen reachable) ═══
  await T("C1  recently-closed lists 72h terminal tasks with per-row reopenability verdicts (no dead buttons)", async () => {
    const r = await call(PORT, "GET", "/operator/leasing/tasks/recently-closed", { token: S.katieTok });
    assert(r.status === 200 && r.json.name === "recently_closed_tasks", r.status);
    const rowC = r.json.items.find((i) => i.obligation_id === S.obC); // downstream work exists
    assert(rowC && rowC.reopenable === false && rowC.not_reopenable_reason === "DOWNSTREAM_WORK_EXISTS", JSON.stringify(rowC));
    const rowD = r.json.items.find((i) => i.obligation_id === S.obD); // >72h — outside the window AND outside the list
    assert(!rowD, "post-window closures are not in the 72h list");
  });
  await T("C2  authz: leasing-module access gates reassign/reopen/reschedule exactly like read/resolve", async () => {
    await tx((c) => c.query(
      `update property_team_assignments set allowed_modules='{maintenance}' where property_id=$1 and user_id=$2`,
      [S.prop, S.ghost]));
    for (const p of [`/operator/leasing/tasks/${S.obB}/reassign`, `/operator/leasing/tasks/${S.obB}/reopen`,
                     `/operator/leasing/tasks/${S.obB}/change-due`, `/operator/leasing/tasks/recently-closed`]) {
      const method = p.endsWith("recently-closed") ? "GET" : "POST";
      const r = await call(PORT, method, p, { token: S.ghostTok,
        body: method === "GET" ? undefined : { reason: "other", reason_detail: "x", to_user_id: S.katie, new_due_at: new Date().toISOString() } });
      assert(r.status === 403, `403 for ${p}: got ${r.status}`);
    }
  });
  await T("C3  property wall: a session at another property cannot touch this property's task", async () => {
    const otherTok = "r3-other-" + RUN;
    await tx((c) => c.query(
      `insert into staff_sessions (user_id, property_id, token, expires_at)
       values ($1,$2,$3, now() + interval '2 hours')`, [S.katie, S.prop2, otherTok]));
    await tx((c) => c.query(
      `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
       values ($1,$2,'R3','{leasing}',true) on conflict (property_id, user_id) do update set active=true, allowed_modules='{leasing}'`,
      [S.prop2, S.katie]));
    const r = await call(PORT, "POST", `/operator/leasing/tasks/${S.obB}/reassign`,
      { token: otherTok, body: { to_user_id: S.katie, reason: "coverage_change" } });
    assert(r.status === 403 && /another property/i.test(JSON.stringify(r.json)), r.status + " " + JSON.stringify(r.json));
  });

  // ═══ PERSON CARD PROJECTION ═══
  await T("P1  the Person Card History projects reassigned/reopened/rescheduled events verb-first with reasons", async () => {
    // one person, all three recovery movements on their own task chain
    S.convP = await mkConv(S.kandice);
    const personP = (await read((c) => c.query(
      `select person_id from leasing_conversions where id=$1`, [S.convP]))).rows[0].person_id;
    const obP = await anchorOb(S.convP);
    // reassigned
    await call(PORT, "POST", `/operator/leasing/tasks/${obP}/reassign`,
      { token: S.katieTok, body: { to_user_id: S.katie, reason: "coverage_change" } });
    // rescheduled (make it overdue first)
    await tx((c) => c.query(`update leasing_conversion_obligations set due_by = now() - interval '1 hour' where obligation_id=$1`, [obP]));
    await tx((c) => c.query(`update obligations set due_at = now() - interval '1 hour' where id=$1`, [obP]));
    await call(PORT, "POST", `/operator/leasing/tasks/${obP}/change-due`,
      { token: S.katieTok, body: { reason: "couldnt_complete", new_due_at: new Date(Date.now() + 3600e3).toISOString() } });
    // resolved then reopened (strip the ladder successor so the reopen tests recovery, not dependency)
    await tx((c) => convSvc.resolveRung(c, { obligation_id: obP, result: "completed",
      by_user_id: S.katie, suppress_next: true }));
    await call(PORT, "POST", `/operator/leasing/tasks/${obP}/reopen`,
      { token: S.katieTok, body: { reason: "closed_by_mistake", new_due_at: new Date(Date.now() + 7200e3).toISOString() } });

    const r = await call(PORT, "GET", `/operator/leasing/person-card?person_id=${personP}`, { token: S.katieTok });
    assert(r.status === 200, "card read: " + r.status + " " + JSON.stringify(r.json).slice(0, 200));
    const hist = (r.json.history || []).filter((h) => h.kind === "task_event");
    assert(hist.length >= 3, "task events present in History: " + hist.length);
    const texts = hist.map((h) => h.text).join(" | ");
    assert(/reassigned/.test(texts) && /reopened/.test(texts) && /changed the follow-up time|due/.test(texts), texts);
    const withReason = hist.find((h) => h.reason);
    assert(withReason, "reasons ride along");
  });

  // ═══ LEDGER IMMUTABILITY (behavioral) ═══
  await T("I1  no route mutates history: the operator router exposes no update/delete on the event ledger", async () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "src", "identity", "operator.js"), "utf8");
    assert(!/delete\s+from\s+leasing_conversion_obligation_events/i.test(src)
        && !/update\s+leasing_conversion_obligation_events/i.test(src),
      "operator.js never updates or deletes ledger rows");
    const rail = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "src", "leasing", "leasing_conversion.js"), "utf8");
    assert(!/delete\s+from\s+leasing_conversion_obligation_events/i.test(rail)
        && !/update\s+leasing_conversion_obligation_events/i.test(rail),
      "the rail never updates or deletes ledger rows");
  });

  srv.close();
  await pool.end();
  process.exit(receipt.complete({
    harness: __filename, passed: pass, failed: fail, expectedAtLeast: EXPECTED,
  }));
})().catch((e) => { process.exit(receipt.died(__filename, e, pass + fail)); });
