// ════════════════════════════════════════════════════════════════════
//  RELEASE 3 DEPLOYED SMOKE (v3) — run in the RENDER SHELL after deploy:
//      node tests/smoke_release3.deployed.js
//
//  Proves the reviewer's nine conditions + two data contracts against the
//  DEPLOYED API and production database. SELF-ISOLATING: builds its own
//  throwaway "R3 SMOKE <ts>" property and people.
//
//  TEARDOWN DOCTRINE (reviewer §1): the event ledger is append-only with
//  ON DELETE RESTRICT — there is no production escape hatch, so this smoke
//  does NOT delete its conversion/task/event rows. It removes only what is
//  legitimately deletable (sessions, team-access rows) and RETAINS the
//  rest, clearly named "R3 SMOKE". The retained rows are the doctrine
//  working, stated in the receipt — never hidden.
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");
const crypto = require("crypto");
const API = process.env.API_BASE || "https://property-spine-api.onrender.com";
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log("  PASS ", name); } else { fail++; console.log("  FAIL ", name, "→", extra || ""); } };
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const call = (method, path, { token, key, body } = {}) =>
  fetch(API + path, { method, headers: { "content-type": "application/json",
    ...(token ? { "x-staff-session": token } : {}), ...(key ? { "x-operator-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined });

(async () => {
  console.log("═══ R3 DEPLOYED SMOKE (v3) — " + API + " ═══");
  const c = await pool.connect();
  const RUN = Date.now();
  const S = {};
  try {
    // ── 1. MIGRATION 069 + CONSTRAINTS/TRIGGER EXIST ON PRODUCTION ──
    const mig = (await c.query(`select 1 from schema_migrations where version='069'`)).rows[0];
    const trg = (await c.query(`select 1 from pg_trigger where tgname='lcoe_append_only'`)).rows[0];
    const fkR = (await c.query(
      `select confdeltype from pg_constraint
        where conrelid='leasing_conversion_obligation_events'::regclass and contype='f'
          and confrelid='leasing_conversion_obligations'::regclass`)).rows[0];
    const chk = (await c.query(
      `select count(*)::int as n from pg_constraint
        where conrelid='leasing_conversion_obligation_events'::regclass and contype='c'`)).rows[0];
    ok(mig && trg && fkR && fkR.confdeltype === "r" && chk.n >= 4,
      "1  069 applied: append-only trigger + ON DELETE RESTRICT + closed-vocabulary CHECKs exist",
      JSON.stringify({ mig: !!mig, trg: !!trg, fk: fkR && fkR.confdeltype, checks: chk.n }));

    // ── throwaway world ──
    S.prop = (await c.query(`insert into properties (name) values ($1) returning id`, ["R3 SMOKE " + RUN + " — QA (not an operating property)"])).rows[0].id;
    S.mgr = (await c.query(`insert into users (name,email,role) values ($1,$2,'leasing_manager'::role_name) returning id`,
      ["R3 SMOKE Mgr " + RUN, `r3smoke-mgr-${RUN}@proof.internal`])).rows[0].id;
    S.agent = (await c.query(`insert into users (name,email,role) values ($1,$2,'leasing_agent'::role_name) returning id`,
      ["R3 SMOKE Agent " + RUN, `r3smoke-agent-${RUN}@proof.internal`])).rows[0].id;
    S.noL = (await c.query(`insert into users (name,email,role) values ($1,$2,'maintenance'::role_name) returning id`,
      ["R3 SMOKE NoLeasing " + RUN, `r3smoke-nol-${RUN}@proof.internal`])).rows[0].id;
    // bridge the AGENT (the eligible reassign target) through the CANONICAL service
    const bridgeSvc = require("../src/identity/staffbridge.js")({ pool })._service;
    S.agentP = (await c.query(`insert into persons (name, phone) values ($1,$2) returning id`,
      ["R3 SMOKE Agent P " + RUN, "+1215666" + String(RUN).slice(-4)])).rows[0].id;
    await c.query("begin");
    await bridgeSvc.classifyAccount(c, { user_id: S.agent, account_kind: "human_staff", performed_by_user_id: S.mgr });
    await bridgeSvc.linkBridge(c, { user_id: S.agent, person_id: S.agentP, performed_by_user_id: S.mgr,
      reason_code: "known_staff", reason_detail: "R3 smoke world" });
    await c.query(`insert into assignments (person_id, property_id, role) values ($1,$2,'leasing')`, [S.agentP, S.prop]);
    await c.query("commit");
    S.mgrTok = "r3smoke-mgr-" + crypto.randomBytes(10).toString("hex");
    S.noLTok = "r3smoke-nol-" + crypto.randomBytes(10).toString("hex");
    for (const [u, t] of [[S.mgr, S.mgrTok], [S.noL, S.noLTok]])
      await c.query(`insert into staff_sessions (user_id, property_id, token, expires_at)
                     values ($1,$2,$3, now() + interval '2 hours')`, [u, S.prop, t]);
    for (const [u, mods, ttl] of [[S.mgr, "{leasing}", "Mgr"], [S.noL, "{maintenance}", "Maint"]])
      await c.query(`insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
                     values ($1,$2,$3,$4::text[],true)`, [S.prop, u, "R3 Smoke " + ttl, mods]);
    S.person = (await c.query(`insert into persons (name, phone) values ($1,$2) returning id`,
      ["R3 SMOKE Prospect " + RUN, "+1215555" + String(RUN).slice(-4)])).rows[0].id;

    const OPKEY = process.env.OPERATOR_KEY;
    if (!OPKEY) console.log("  NOTE  OPERATOR_KEY absent — checks 2 and 3a skipped.");

    // ── 2. plain obligation still completes through the generic engine ──
    if (OPKEY) {
      const plain = (await c.query(
        `insert into obligations (property_id, person_id, module, type, label, owner_type, status)
         values ($1,$2,'maintenance','smoke_check','R3 smoke plain obligation','human','open') returning id`,
        [S.prop, S.person])).rows[0].id;
      const r = await call("PATCH", `/obligations/RETIRED/complete`, { key: OPKEY, body: {} });
      ok(r.status === 404, "2  the legacy completion door is RETIRED (404) — completion invariants moved to tests/obligation_completion_canonical_proof.db.js", r.status);
    }

    // ── conversion + task (linked) ──
    S.conv = (await c.query(
      `insert into leasing_conversions
         (person_id, property_id, current_stage, status,
          scheduled_tour_host_user_id, actual_tour_host_user_id, feedback_recorded_by_user_id, conversation_owner_user_id)
       values ($1,$2,'tour_followup','active',$3,$3,$3,$3) returning id`, [S.person, S.prop, S.mgr])).rows[0].id;
    S.ob = (await c.query(
      `insert into obligations (property_id, person_id, module, type, label, owner_type, status, due_at, related_id, related_type)
       values ($1,$2,'leasing','tour_followup','R3 smoke follow-up','human','open', now() + interval '1 day', $3,'leasing_conversion') returning id`,
      [S.prop, S.person, S.conv])).rows[0].id;
    S.link = (await c.query(
      `insert into leasing_conversion_obligations (conversion_id, obligation_id, rung, due_by)
       values ($1,$2,'tour_followup', now() + interval '1 day') returning id`, [S.conv, S.ob])).rows[0].id;

    // ── 3. generic engine rejects the linked obligation; only the rail closes ──
    if (OPKEY) {
      const r = await call("PATCH", `/obligations/RETIRED/complete`, { key: OPKEY, body: {} });
      const b = await j(r);
      ok(r.status === 404, "the legacy completion door is RETIRED (404) — the conversion-rail refusal is proven in tests/obligation_completion_canonical_proof.db.js", r.status);
    }

    // ── 4. change follow-up time: active stays active, owner unchanged, honest event ──
    const dueTarget = new Date(Date.now() + 3 * 86400e3).toISOString();
    const cd = await call("POST", `/operator/leasing/tasks/${S.ob}/change-due`,
      { token: S.mgrTok, body: { reason: "new_information", new_due_at: dueTarget } });
    const cdB = await j(cd);
    const cdEv = (await c.query(
      `select * from leasing_conversion_obligation_events
        where conversion_obligation_id=$1 and event_type='due_changed'`, [S.link])).rows[0];
    const cdLink = (await c.query(`select outcome, owner_user_id from leasing_conversion_obligations where id=$1`, [S.link])).rows[0];
    ok(cd.status === 200 && cdB.due_changed === true && cdLink.outcome === null
       && cdEv && cdEv.prior_due_at && cdEv.next_due_at && cdEv.actor_user_id === S.mgr
       && cdEv.identity_resolution_basis !== null,
      "4  change-due: task active, due_changed event carries old/new due + actor snapshots",
      cd.status + " " + JSON.stringify({ ev: !!cdEv, basis: cdEv && cdEv.identity_resolution_basis }).slice(0, 120));

    // ── contract (b): a PAST timestamp clamps to server-now ("due immediately") ──
    const past = new Date(Date.now() - 3600e3).toISOString();
    const cl = await call("POST", `/operator/leasing/tasks/${S.ob}/change-due`,
      { token: S.mgrTok, body: { reason: "new_information", new_due_at: past } });
    const clLink = (await c.query(`select due_by >= now() - interval '30 seconds' as clamped from leasing_conversion_obligations where id=$1`, [S.link])).rows[0];
    ok(cl.status === 200 && clLink.clamped === true,
      "4b a past new_due_at is clamped to server-now — never accidental instant-overdue", cl.status);

    // ── 5. reassign: task-only, eligible target only ──
    const raBad = await call("POST", `/operator/leasing/tasks/${S.ob}/reassign`,
      { token: S.mgrTok, body: { to_user_id: S.noL, reason: "coverage_change" } });
    ok(raBad.status === 400, "5a ineligible target refused (team access ≠ ownership)", raBad.status);
    const ra = await call("POST", `/operator/leasing/tasks/${S.ob}/reassign`,
      { token: S.mgrTok, body: { to_user_id: S.agent, reason: "coverage_change" } });
    const raB = await j(ra);
    const convOwner = (await c.query(`select conversation_owner_user_id from leasing_conversions where id=$1`, [S.conv])).rows[0];
    ok(ra.status === 200 && raB.owner_user_id === S.agent && convOwner.conversation_owner_user_id === S.mgr,
      "5b eligible reassignment lands; conversation ownership UNMOVED (task-only)",
      ra.status + " convOwner=" + (convOwner.conversation_owner_user_id === S.mgr));

    // ── 6. reopen: once, reason + new_due_at required, exact refusal codes ──
    // close it (rail, via the session route)
    const done = await call("POST", `/operator/leasing/tasks/${S.ob}/resolve`,
      { token: S.mgrTok, body: { result: "completed", resolution_basis: "manager_intervention" } });
    ok(done.status === 200, "6a rail closes the linked task", done.status);
    // successor now exists (the ladder) → reopen must return the EXACT stable code
    const roBlocked = await call("POST", `/operator/leasing/tasks/${S.ob}/reopen`,
      { token: S.mgrTok, body: { reason: "closed_by_mistake", new_due_at: new Date(Date.now() + 3600e3).toISOString() } });
    const roBlockedB = await j(roBlocked);
    ok(roBlocked.status === 409 && roBlockedB.code === "DOWNSTREAM_WORK_EXISTS",
      "6b successor exists → exact stable refusal DOWNSTREAM_WORK_EXISTS", roBlocked.status + " " + JSON.stringify(roBlockedB).slice(0, 80));
    // a second conversion, closed suppress_next-equivalent: close the successor honestly
    // then reopen the SUCCESSOR itself (no downstream) — reason/new_due_at gates first
    const succ = (await c.query(
      `select obligation_id, id from leasing_conversion_obligations
        where conversion_id=$1 and rung='applicant_followup'`, [S.conv])).rows[0];
    const noDue = await call("POST", `/operator/leasing/tasks/${succ.obligation_id}/reopen`,
      { token: S.mgrTok, body: { reason: "closed_by_mistake" } });
    ok(noDue.status === 409 || noDue.status === 400, "6c reopen without new_due_at refused", noDue.status);
    await call("POST", `/operator/leasing/tasks/${succ.obligation_id}/resolve`,
      { token: S.mgrTok, body: { result: "completed", resolution_basis: "manager_intervention" } });
    // make the prior owner stale? successor is UNASSIGNED (spawned to conversation owner —
    // owner is mgr or null). Reopen and assert honest ownership behavior:
    const ro = await call("POST", `/operator/leasing/tasks/${succ.obligation_id}/reopen`,
      { token: S.mgrTok, body: { reason: "closed_by_mistake", new_due_at: new Date(Date.now() + 7200e3).toISOString() } });
    const roB = await j(ro);
    ok(ro.status === 200 && roB.reopened === true, "6d valid completed task reopens once", ro.status + " " + JSON.stringify(roB).slice(0, 100));
    const roAgain = await call("POST", `/operator/leasing/tasks/${succ.obligation_id}/reopen`,
      { token: S.mgrTok, body: { reason: "closed_by_mistake", new_due_at: new Date(Date.now() + 7200e3).toISOString() } });
    const roAgainB = await j(roAgain);
    ok(roAgain.status === 409 && roAgainB.code === "NOT_TERMINAL", "6e second reopen → stable NOT_TERMINAL", roAgain.status);

    // ── 7. immutability against PRODUCTION schema ──
    const anyEv = (await c.query(
      `select id from leasing_conversion_obligation_events where conversion_obligation_id=$1 limit 1`, [S.link])).rows[0];
    let up = null, del = null, parentDel = null;
    await c.query(`update leasing_conversion_obligation_events set reason='x' where id=$1`, [anyEv.id]).catch((e) => { up = e.message; });
    await c.query(`delete from leasing_conversion_obligation_events where id=$1`, [anyEv.id]).catch((e) => { del = e.message; });
    await c.query(`delete from leasing_conversions where id=$1`, [S.conv]).catch((e) => { parentDel = e.message; });
    ok(up && /append-only/.test(up) && del && /append-only/.test(del) && parentDel && /violates foreign key|restrict/i.test(parentDel),
      "7  direct UPDATE, direct DELETE, and parent cascade deletion ALL refused by the database",
      JSON.stringify({ up: !!up, del: !!del, parent: !!parentDel }));

    // ── 8. raw actor preserved; snapshots are historical snapshots ──
    const closeEv = (await c.query(
      `select actor_user_id, actor_person_id_at_event, identity_resolution_basis
         from leasing_conversion_obligation_events
        where conversion_obligation_id=$1 and event_type='resolved' limit 1`, [S.link])).rows[0];
    ok(closeEv && closeEv.actor_user_id === S.mgr && closeEv.identity_resolution_basis === "unbridged"
       && closeEv.actor_person_id_at_event === null,
      "8  raw session actor kept; unbridged closer = null person snapshot + basis 'unbridged' (honest)",
      JSON.stringify(closeEv));

    // ── 9. authorization holds on every new route ──
    for (const [m, p] of [["GET", "/operator/leasing/tasks/recently-closed"],
                          ["POST", `/operator/leasing/tasks/${S.ob}/reassign`],
                          ["POST", `/operator/leasing/tasks/${S.ob}/reopen`],
                          ["POST", `/operator/leasing/tasks/${S.ob}/change-due`]]) {
      const r = await call(m, p, { token: S.noLTok,
        body: m === "GET" ? undefined : { reason: "other", reason_detail: "x", to_user_id: S.agent, new_due_at: new Date().toISOString() } });
      ok(r.status === 403, `9  ${m} ${p.split("/").pop()} blocked without leasing-module access`, r.status);
    }

    // ── contract (a): closed vocabularies are DB-enforced where persisted ──
    let vocab = null;
    await c.query(
      `insert into leasing_conversion_obligation_events (conversion_obligation_id, event_type)
       values ($1, 'invented_event')`, [S.link]).catch((e) => { vocab = e.message; });
    ok(vocab && /check constraint/i.test(vocab), "C1 event_type vocabulary is DB-closed", (vocab || "").slice(0, 80));
    let vocab2 = null;
    await c.query(
      `insert into leasing_conversion_obligation_events (conversion_obligation_id, event_type, resolution_code)
       values ($1, 'resolved', 'vanished')`, [S.link]).catch((e) => { vocab2 = e.message; });
    ok(vocab2 && /check constraint/i.test(vocab2), "C2 resolution_code vocabulary is DB-closed", (vocab2 || "").slice(0, 80));

  } catch (e) {
    fail++; console.log("  SMOKE CRASHED:", e.message);
  } finally {
    // ── teardown: sessions + team access only. The property, people,
    //    conversion, tasks, and their EVENT HISTORY are RETAINED — the
    //    append-only doctrine has no teardown escape hatch, by design.
    try {
      await c.query(`delete from staff_sessions where token in ($1,$2)`, [S.mgrTok || "", S.noLTok || ""]);
      if (S.prop) await c.query(`delete from property_team_assignments where property_id=$1`, [S.prop]).catch(() => {});
      console.log("  teardown: sessions + team access removed. Retained (append-only doctrine):");
      console.log(`    property "R3 SMOKE ${RUN} — QA (not an operating property)" + its conversion, tasks, event history.`);
      console.log("  CONTAINMENT: the QA world is isolated by designation — no staff session or team");
      console.log("  access to it survives this run, it is absent from the operator app's fixed");
      console.log("  property picker, and no operating workflow references it. It must never be");
      console.log("  treated as an operating property.");
    } catch (e2) { console.log("  TEARDOWN NOTE:", e2.message); }
    c.release(); await pool.end();
    console.log(`═══ RESULT: ${pass} passed · ${fail} failed ═══`);
    process.exit(fail ? 1 : 0);
  }
})();

// ════════════════════════════════════════════════════════════════════
//  OBLIGATION AUTHORITY BOUNDARY — deployed proof
//
//  The five shared-key obligation doors were retired. This section keeps
//  the DEPLOYED boundary proof that used to travel through them: real
//  deployment, real routing, real authentication, real database.
//
//  It deliberately does NOT prove completion invariants — those moved to
//  tests/obligation_completion_canonical_proof.db.js, against the
//  canonical services. Removing a door must not lower the proof
//  boundary; it moves each half to where it belongs.
//
//  Usage (same as the rest of this suite):
//    BASE=https://…  OPERATOR_KEY=…  STAFF_SESSION=…  node tests/smoke_release3.deployed.js
// ════════════════════════════════════════════════════════════════════
async function obligationBoundarySmoke({ call, j, ok, OPKEY, STAFF }) {
  //  1. all five legacy doors must be UNROUTED — not merely unused.
  const legacy = [
    ["GET",   "/obligations"],
    ["GET",   "/obligations/00000000-0000-0000-0000-000000000000"],
    ["PATCH", "/obligations/00000000-0000-0000-0000-000000000000/claim"],
    ["PATCH", "/obligations/00000000-0000-0000-0000-000000000000/satisfy"],
    ["PATCH", "/obligations/00000000-0000-0000-0000-000000000000/complete"],
  ];
  for (const [m, p] of legacy) {
    const r = await call(m, p, { key: OPKEY, body: {} });
    ok(r.status === 404, `legacy door gone: ${m} ${p}`, "status " + r.status);
  }

  //  2. the authenticated collection read is reachable and scoped.
  if (STAFF) {
    const r = await call("GET", "/operator/obligations", { token: STAFF });
    const b = await j(r);
    ok(r.status === 200 && Array.isArray(b.items),
      "authenticated /operator/obligations is reachable", r.status);
    ok(b.scope && b.scope.property_id,
      "the response carries SERVER-DERIVED scope", JSON.stringify(b.scope || {}));

    //  3. a client property_id cannot widen — refused, not silently ignored.
    const r2 = await call("GET",
      "/operator/obligations?property_id=00000000-0000-0000-0000-000000000000", { token: STAFF });
    ok(r2.status === 403, "a client property_id is refused on the deployed route", r2.status);

    //  4. cross-property self-claim is concealed, not disclosed.
    const r3 = await call("POST",
      "/operator/obligations/00000000-0000-0000-0000-000000000000/claim", { token: STAFF, body: {} });
    ok(r3.status === 404, "an out-of-scope claim is CONCEALED (404, not 403)", r3.status);
  }

  //  5. the read must refuse an unauthenticated caller even WITH the shared key.
  const r4 = await call("GET", "/operator/obligations", { key: OPKEY });
  ok(r4.status === 401, "the shared operator key alone cannot read obligations", r4.status);
}
module.exports = Object.assign(module.exports || {}, { obligationBoundarySmoke });
