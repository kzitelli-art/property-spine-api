// ════════════════════════════════════════════════════════════════════
//  slice9_inbound_decision_http_proof.js — THE DECISION DOOR, OVER REAL HTTP.
//
//  Real express, real staff sessions, real Postgres. Mounts the SAME two
//  routers server.js mounts (operator_obligations, operator_obligation_actions)
//  on an ephemeral port — the security lane's own proof pattern — so the
//  contract is proven through the actual authenticated route family without
//  touching server.js.
//
//  DB DISCIPLINE: fixtures are COMMITTED (HTTP requests use their own pool
//  connections), so this runs only against a disposable harness database.
//  HARNESS_DATABASE_URL is required and must differ from DATABASE_URL.
//
//  Run: HARNESS_DATABASE_URL=... node tests/proofs/slice9_inbound_decision_http_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const http = require("http");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");

const CONN = process.env.HARNESS_DATABASE_URL;
if (!CONN) { console.error("FATAL: HARNESS_DATABASE_URL required (fixtures COMMIT)."); process.exit(1); }
if (process.env.DATABASE_URL && CONN === process.env.DATABASE_URL) {
  console.error("FATAL: HARNESS_DATABASE_URL must differ from DATABASE_URL."); process.exit(1);
}

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const TAG = "s9http" + Math.floor(Math.random() * 1e6);

(async () => {
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const svc = require(path.join(REPO, "src/identity/staff_session_service.js"));
  const L = require(path.join(REPO, "src/leasing/leasing_lifecycle_service"))({ pool });
  let server = null;
  try {
    // ── FIXTURE (committed) ───────────────────────────────────────────
    const c = await pool.connect();
    let F = {};
    try {
      await c.query("begin");
      const one = async (q, a = []) => (await c.query(q, a)).rows[0];
      const P = (await one(`insert into properties (name, operating_timezone) values ($1,'America/New_York') returning id`, [TAG + "-P"])).id;
      const O = (await one(`insert into properties (name, operating_timezone) values ($1,'America/New_York') returning id`, [TAG + "-O"])).id;
      const mkUser = async (n) => (await one(
        `insert into users (name,email,phone,role,is_active,status)
         values ($1,$2,$3,'property_manager',true,'active') returning id`,
        [n, `${n}@${TAG}.test`, "+1724666" + Math.floor(Math.random() * 9000 + 1000)])).id;
      const uP = await mkUser(TAG + "-uP"), uP2 = await mkUser(TAG + "-uP2"),
            uNoLease = await mkUser(TAG + "-uNoLease"), uO = await mkUser(TAG + "-uO"),
            host = await mkUser(TAG + "-host");
      const assign = (u, p, m) => c.query(
        `insert into property_team_assignments
          (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
         values ($1,$2,'Proof','property',$3,$3,false,true)`, [p, u, m]);
      await assign(uP, P, ["leasing"]); await assign(uP2, P, ["leasing"]);
      await assign(uNoLease, P, ["maintenance"]); await assign(uO, O, ["leasing"]);

      //  One person + conversation + N opportunities; close some by EVENT.
      const mk = async (label, opps, closeIdx) => {
        const person = (await one(`insert into persons (name, lifecycle_status) values ($1,'lead') returning id`, [`${TAG}-${label}`])).id;
        const conv = (await one(`insert into conversations (property_id, person_id, channel_primary, status)
          values ($1,$2,'sms','open') returning id`, [P, person])).id;
        const lead = (await one(`insert into leasing_leads (person_id, property_id, status, received_at)
          values ($1,$2,'new',now()) returning id`, [person, P])).id;
        const ids = [];
        for (let i = 0; i < opps; i++) {
          ids.push((await one(
            `insert into leasing_conversions (person_id,property_id,lead_id,status,current_stage,opened_at,
               actual_tour_host_user_id, conversation_owner_user_id)
             values ($1,$2,$3,$4,'touring', now() - ($5||' days')::interval, $6,$6) returning id`,
            [person, P, lead, i === opps - 1 ? "active" : "released", String(50 - i * 10), host])).id);
        }
        let seq = 0;
        for (const idx of closeIdx) {
          await c.query(`insert into leasing_lead_lifecycle_events (conversation_id, conversion_id, property_id,
              event_sequence, event_type, actor_type, actor_id, reason_code, idempotency_key, occurred_at)
            values ($1,$2,$3,$4,'closed_not_fit','operator',$5,'budget_mismatch',$6, now() - interval '4 days')`,
            [conv, ids[idx], P, ++seq, host, `${TAG}-${label}-close-${idx}`]);
        }
        const inbound = (await one(`insert into comm_events (property_id, person_id, conversation_id, channel,
            direction, body, classification, sender_role)
          values ($1,$2,$3,'text','inbound',$4,'leasing','prospect') returning id`,
          [P, person, conv, `Reply from ${label}: still interested!`])).id;
        return { person, conv, lead, ids, inbound };
      };

      const A = await mk("A", 1, [0]);            // one closed opportunity
      const B = await mk("B", 2, [0]);            // two opportunities, older closed
      const C = await mk("C", 1, [0]);            // will be manually reopened later
      const zPerson = (await one(`insert into persons (name, lifecycle_status) values ($1,'lead') returning id`, [TAG + "-Z"])).id;
      const zConv = (await one(`insert into conversations (property_id, person_id, channel_primary, status)
        values ($1,$2,'sms','open') returning id`, [P, zPerson])).id;
      const zInbound = (await one(`insert into comm_events (property_id, person_id, conversation_id, channel,
          direction, body, classification, sender_role)
        values ($1,$2,$3,'text','inbound','Hello?','leasing','prospect') returning id`, [P, zPerson, zConv])).id;
      //  Z has a terminal-ish state via a conversation-level legacy event so
      //  the refusal path fires with ZERO candidates.
      await c.query(`insert into leasing_lead_lifecycle_events (conversation_id, property_id,
          event_sequence, event_type, actor_type, actor_id, reason_code, idempotency_key, occurred_at)
        values ($1,$2,1,'closed_not_fit','operator',$3,'duplicate',$4, now() - interval '4 days')`,
        [zConv, P, host, TAG + "-z-close"]);

      //  A wrong-property opportunity for A's person.
      const foreignLead = (await one(`insert into leasing_leads (person_id, property_id, status, received_at)
        values ($1,$2,'new',now()) returning id`, [A.person, O])).id;
      const foreignOpp = (await one(
        `insert into leasing_conversions (person_id,property_id,lead_id,status,current_stage,opened_at,
           actual_tour_host_user_id, conversation_owner_user_id)
         values ($1,$2,$3,'active','touring',now(),$4,$4) returning id`, [A.person, O, foreignLead, host])).id;

      await c.query("commit");
      F = { P, O, uP, uP2, uNoLease, uO, host, A, B, C, zConv, zInbound, foreignOpp };
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

    //  Open the decisions through the REAL refusal path, committed.
    const openDecision = async (conv, inbound) => {
      const cc = await pool.connect();
      try {
        await cc.query("begin");
        const r = await L.maybeReopenOnQualifyingInbound(cc, {
          conversationId: conv, sourceCommEventId: inbound });
        await cc.query("commit");
        return r;
      } catch (e) { await cc.query("rollback").catch(() => {}); throw e; }
      finally { cc.release(); }
    };
    const dA = await openDecision(F.A.conv, F.A.inbound);
    const dB = await openDecision(F.B.conv, F.B.inbound);
    const dC = await openDecision(F.C.conv, F.C.inbound);
    const dZ = await openDecision(F.zConv, F.zInbound);
    ok([dA, dB, dC, dZ].every((d) => d.refused && d.decision_obligation_id),
      "four decisions opened through the real refusal path");

    //  Manually reopen C's opportunity — the ALREADY-OPEN case.
    await L.reopen({ conversationId: F.C.conv, propertyId: F.P, conversionId: F.C.ids[0],
      actorUserId: F.host, idempotencyKey: TAG + "-manual-reopen-C" });

    // ── REAL HTTP ─────────────────────────────────────────────────────
    const express = require("express");
    const app = express(); app.use(express.json());
    app.use("/", require(path.join(REPO, "src/obligations/operator_obligations.js"))({ pool }));
    app.use("/", require(path.join(REPO, "src/obligations/operator_obligation_actions.js"))({ pool }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const PORT = server.address().port;

    const mkSession = async (u, p) => {
      const cc = await pool.connect();
      try { await cc.query("begin");
        const s = await svc.issueStaffSession(cc, { userId: u, propertyId: p, purpose: "sms_otp" });
        await cc.query("commit"); return s.session_token;
      } finally { cc.release(); }
    };
    const tokP = await mkSession(F.uP, F.P), tokP2 = await mkSession(F.uP2, F.P),
          tokNoLease = await mkSession(F.uNoLease, F.P), tokO = await mkSession(F.uO, F.O);

    const call = async (method, pth, token, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${pth}`, {
        method, headers: { "content-type": "application/json",
          ...(token ? { "x-staff-session": token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      let json = null; try { json = await r.json(); } catch (_) {}
      return { status: r.status, json, raw: JSON.stringify(json) };
    };
    const D = (id) => `/operator/obligations/${id}/inbound-decision`;

    console.log("\n── AUTHORITY ────────────────────────────────────────────");
    ok((await call("GET", D(dA.decision_obligation_id), null)).status === 401,
      "no session → 401");
    ok((await call("GET", D(dA.decision_obligation_id), tokO)).status === 404,
      "another property's session → 404, not even existence");
    ok((await call("GET", D(dA.decision_obligation_id), tokNoLease)).status === 404,
      "no leasing entitlement → 404");

    console.log("\n── THE DETAIL CONTRACT ──────────────────────────────────");
    const rd = await call("GET", D(dA.decision_obligation_id), tokP);
    ok(rd.status === 200, "the entitled operator reads the decision");
    ok(rd.json.obligation.owner === "UNASSIGNED",
      "ownership is explicit UNASSIGNED, never merely absent");
    ok(/replied after the opportunity was closed/.test(rd.json.obligation.instruction),
      "the instruction is the plain sentence");
    ok(rd.json.reply && /Reply from A/.test(rd.json.reply.body),
      "the EXACT inbound message loads");
    ok(!!rd.json.reply.occurred_at, "with its occurred time");
    ok(rd.json.person && /-A$/.test(rd.json.person.name), "safe person identity");
    ok(!/dedupe/i.test(rd.raw), "the dedupe key is NOT exposed anywhere in the response");
    ok(!/conversation_id|lifecycle|conversion_id/.test(
        JSON.stringify({ ...rd.json, candidates: rd.json.candidates.map(({ opportunity_id, ...x }) => x), action: undefined })),
      "no schema vocabulary outside the opaque action token");

    console.log("\n── CANDIDATES: ZERO, ONE, SEVERAL — NEVER RANKED ────────");
    ok(rd.json.candidate_count === 1 && rd.json.selection_required === true,
      "ONE candidate still requires human confirmation");
    const rz = await call("GET", D(dZ.decision_obligation_id), tokP);
    ok(rz.json.candidate_count === 0 && !!rz.json.blocked_reason,
      `ZERO candidates → open with a blocked reason ("${String(rz.json.blocked_reason).slice(0, 40)}…")`);
    const rb = await call("GET", D(dB.decision_obligation_id), tokP);
    ok(rb.json.candidate_count === 2, "SEVERAL candidates are all offered");
    ok(!/rank|score|recommend|best/i.test(rb.raw), "with no ranking or recommendation");
    ok(rb.json.candidates[0].state === "closed" && rb.json.candidates[1].state === "open",
      "each carries plain state from EVENTS");
    ok(rb.json.candidates[0].closed_because === "budget didn't fit",
      `and a governed reason in plain words (${rb.json.candidates[0].closed_because})`);

    console.log("\n── COVERAGE READS ───────────────────────────────────────");
    const list = await call("GET", "/operator/obligations?status=open", tokP2);
    ok((list.json.items || []).some((i) => String(i.id) === String(dA.decision_obligation_id)),
      "a second leasing operator (coverage) sees the unassigned decision in the live queue");
    const claim = await call("POST", `/operator/obligations/${dA.decision_obligation_id}/claim`, tokP, {});
    ok(claim.status === 200, "the operator claims it through the canonical claim door");
    const rd2 = await call("GET", D(dA.decision_obligation_id), tokP);
    ok(rd2.json.obligation.owner !== "UNASSIGNED"
       && String(rd2.json.obligation.owner.user_id) === String(F.uP),
      "and the detail read now names the accountable owner");

    console.log("\n── RESOLUTION REFUSALS ──────────────────────────────────");
    const noPick = await call("POST", D(dA.decision_obligation_id) + "/resolve", tokP, {});
    ok(noPick.status === 400 && noPick.json.decision_remains_open === true,
      "no selection → refused, decision stays open");
    const wrongProp = await call("POST", D(dA.decision_obligation_id) + "/resolve", tokP,
      { opportunity_id: F.foreignOpp });
    ok(wrongProp.status === 403 && wrongProp.json.decision_remains_open === true,
      "a wrong-property opportunity → refused, decision stays open");
    ok((await call("POST", D(dA.decision_obligation_id) + "/resolve", tokO,
      { opportunity_id: F.A.ids[0] })).status === 404,
      "another property's session cannot act at all");
    const stillOpen = await call("GET", D(dA.decision_obligation_id), tokP);
    ok(stillOpen.json.obligation.status !== "complete", "after every refusal it is still open");
    ok(/Reply from A/.test(stillOpen.json.reply.body), "and the message is still readable");

    console.log("\n── EXACT RESOLUTION ─────────────────────────────────────");
    const resolveB = await call("POST", D(dB.decision_obligation_id) + "/resolve", tokP,
      { opportunity_id: F.B.ids[0] });
    ok(resolveB.status === 200 && resolveB.json.ok === true, "selecting the closed opportunity resolves");
    ok(!!resolveB.json.reopen_event_id, "with a real reopen event");
    const pool2 = pool;
    const lifeRow = async (opp) => (await pool2.query(
      `select
         (select count(*)::int from leasing_lead_lifecycle_events where conversion_id=$1 and event_type='reopened') as reopens,
         (select count(*)::int from leasing_lead_lifecycle_events where conversion_id=$1 and event_type='closed_not_fit') as closes`,
      [opp])).rows[0];
    const b0 = await lifeRow(F.B.ids[0]), b1 = await lifeRow(F.B.ids[1]);
    ok(b0.reopens === 1 && b0.closes === 1,
      "ONLY the selected opportunity was reopened, and its prior close survives");
    ok(b1.reopens === 0 && b1.closes === 0, "the other opportunity is untouched");
    const obB = (await pool2.query(`select status from obligations where id=$1`, [dB.decision_obligation_id])).rows[0];
    ok(obB.status === "complete", "the decision closed only after the reopen succeeded");

    console.log("\n── IDEMPOTENT REPLAY AND STALE ──────────────────────────");
    const replay = await call("POST", D(dB.decision_obligation_id) + "/resolve", tokP,
      { opportunity_id: F.B.ids[0] });
    ok(replay.status === 200 && replay.json.idempotent === true,
      "replaying the exact same resolution is idempotent");
    ok((await lifeRow(F.B.ids[0])).reopens === 1, "and writes NO second reopen event");
    const stale = await call("POST", D(dB.decision_obligation_id) + "/resolve", tokP,
      { opportunity_id: F.B.ids[1] });
    ok(stale.status === 409 && stale.json.refusal_code === "already_resolved",
      "a DIFFERENT selection after resolution is explicitly stale");

    console.log("\n── THE ALREADY-OPEN CASE ────────────────────────────────");
    const resolveC = await call("POST", D(dC.decision_obligation_id) + "/resolve", tokP,
      { opportunity_id: F.C.ids[0] });
    ok(resolveC.status === 200 && resolveC.json.opportunity_already_open === true,
      "selecting an opportunity another actor already reopened resolves explicitly");
    ok(resolveC.json.reopen_event_id === null,
      "and creates NO duplicate reopen event merely to close the obligation");
    const cRow = await lifeRow(F.C.ids[0]);
    ok(cRow.reopens === 1, `exactly the one manual reopen exists (${cRow.reopens})`);
    ok((await pool2.query(`select status from obligations where id=$1`, [dC.decision_obligation_id])).rows[0].status === "complete",
      "while the decision itself is resolved with proof");

    console.log("\n── NOTHING WAS INFERRED ─────────────────────────────────");
    const inferred = (await pool2.query(
      `select count(*)::int n from obligations where type='resolve_inbound_opportunity'
        and related_type <> 'conversation'`)).rows[0].n;
    ok(inferred === 0, "every decision remains conversation-linked; no opportunity was ever guessed");
    ok(/Reply from B/.test((await pool2.query(
      `select body from comm_events where id=$1`, [F.B.inbound])).rows[0].body),
      "and every inbound message survives resolution");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    if (server) server.close();
    // fixtures COMMIT by design; the harness DB is disposable.
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   inbound decision HTTP: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
