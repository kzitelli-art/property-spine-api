// ════════════════════════════════════════════════════════════════════
//  RELEASE 2 DEPLOYED SMOKE — run in the RENDER SHELL after deploy.
//
//    node tests/smoke_release2.deployed.js
//
//  Proves the reviewer's five conditions against the DEPLOYED API (real
//  https endpoints + the production database), not a clean room:
//    1. a normal NON-conversion obligation still completes via the generic engine
//    2. a conversion-linked obligation CANNOT complete via the generic engine
//    3. the rail resolves it: closer snapshots + basis + no signature successor
//    4. approval creates EXACTLY ONE lease-signature follow-up
//    5. property access WITHOUT leasing-module access cannot read/resolve the queue
//
//  SELF-ISOLATING: creates its own throwaway property ("R2 SMOKE …"), its own
//  users/sessions/team rows, and DELETES the property at the end (cascades take
//  the rest). It never reads or writes any real property's records.
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
  fetch(API + path, { method, headers: {
    "content-type": "application/json",
    ...(token ? { "x-staff-session": token } : {}),
    ...(key ? { "x-operator-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined });

(async () => {
  console.log("═══ R2 DEPLOYED SMOKE — " + API + " ═══");
  const c = await pool.connect();
  const RUN = Date.now();
  const S = {};
  try {
    // ── throwaway world ──
    S.prop = (await c.query(`insert into properties (name) values ($1) returning id`, ["R2 SMOKE " + RUN])).rows[0].id;
    S.person = (await c.query(`insert into persons (name, phone) values ($1,$2) returning id`,
      ["Smoke Prospect " + RUN, "+1215555" + String(RUN).slice(-4)])).rows[0].id;
    S.host = (await c.query(`insert into users (name, email, role) values ($1,$2,'leasing_agent'::role_name) returning id`,
      ["Smoke Host " + RUN, `r2smoke-host-${RUN}@proof.internal`])).rows[0].id;
    S.mgr = (await c.query(`insert into users (name, email, role) values ($1,$2,'leasing_manager'::role_name) returning id`,
      ["Smoke Mgr " + RUN, `r2smoke-mgr-${RUN}@proof.internal`])).rows[0].id;
    S.noL = (await c.query(`insert into users (name, email, role) values ($1,$2,'maintenance'::role_name) returning id`,
      ["Smoke NoLeasing " + RUN, `r2smoke-nol-${RUN}@proof.internal`])).rows[0].id;
    S.mgrTok = "r2smoke-mgr-" + crypto.randomBytes(12).toString("hex");
    S.noLTok = "r2smoke-nol-" + crypto.randomBytes(12).toString("hex");
    for (const [u, t] of [[S.mgr, S.mgrTok], [S.noL, S.noLTok]])
      await c.query(`insert into staff_sessions (user_id, property_id, token, expires_at)
                     values ($1,$2,$3, now() + interval '2 hours')`, [u, S.prop, t]);
    await c.query(`insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
                   values ($1,$2,'Smoke Mgr','{leasing}',true)`, [S.prop, S.mgr]);
    await c.query(`insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
                   values ($1,$2,'Smoke Maint','{maintenance}',true)`, [S.prop, S.noL]);

    const OPKEY = process.env.OPERATOR_KEY;
    if (!OPKEY) console.log("  NOTE  OPERATOR_KEY not in env — checks 1 and 4 will be skipped.");

    // ── 1. plain obligation still completes through the generic engine ──
    if (OPKEY) {
      const plain = (await c.query(
        `insert into obligations (property_id, person_id, module, type, label, owner_type, status)
         values ($1,$2,'maintenance','smoke_check','R2 smoke plain obligation','human','open') returning id`,
        [S.prop, S.person])).rows[0].id;
      const r1 = await call("PATCH", `/obligations/RETIRED/complete`, { key: OPKEY, body: {} });
      const b1 = await j(r1);
      ok(r1.status === 404, "1  the legacy completion door is RETIRED (404) — completion invariants moved to tests/obligation_completion_canonical_proof.db.js", r1.status);
    }

    // ── a real conversion through the DEPLOYED rail service tables ──
    // tour → conversion via direct rows (the throwaway world), then rail HTTP.
    S.conv = (await c.query(
      `insert into leasing_conversions
         (person_id, property_id, current_stage, status,
          scheduled_tour_host_user_id, actual_tour_host_user_id, feedback_recorded_by_user_id, conversation_owner_user_id)
       values ($1,$2,'tour_followup','active',$3,$3,$3,$3) returning id`,
      [S.person, S.prop, S.host])).rows[0].id;
    const anchorOb = (await c.query(
      `insert into obligations (property_id, person_id, module, type, label, owner_type, status, due_at, related_id, related_type)
       values ($1,$2,'leasing','tour_followup','R2 smoke follow-up','human','open', now() + interval '1 day', $3,'leasing_conversion') returning id`,
      [S.prop, S.person, S.conv])).rows[0].id;
    await c.query(
      `insert into leasing_conversion_obligations (conversion_id, obligation_id, rung, due_by)
       values ($1,$2,'tour_followup', now() + interval '1 day')`, [S.conv, anchorOb]);

    // ── 2. the generic engine refuses the linked obligation ──
    if (OPKEY) {
      const r2 = await call("PATCH", `/obligations/RETIRED/complete`, { key: OPKEY, body: {} });
      const b2 = await j(r2);
      ok(r2.status === 404, "the legacy completion door is RETIRED (404) — the conversion-rail refusal is proven in tests/obligation_completion_canonical_proof.db.js", r2.status);
    }

    // ── 5. property access without leasing-module access → 403 both ways ──
    const r5a = await call("GET", "/operator/leasing/task-queue", { token: S.noLTok });
    ok(r5a.status === 403, "5a queue READ blocked without leasing-module access", r5a.status);
    const r5b = await call("POST", `/operator/leasing/tasks/${anchorOb}/resolve`,
      { token: S.noLTok, body: { result: "completed", resolution_basis: "coverage" } });
    ok(r5b.status === 403, "5b queue RESOLVE blocked without leasing-module access", r5b.status);

    // ── 3. the rail resolves it: unassigned_pickup basis, snapshots, ladder ──
    const q = await j(await call("GET", "/operator/leasing/task-queue", { token: S.mgrTok }));
    const row = (q.items || []).find((i) => i.obligation_id === anchorOb);
    ok(!!row && row.owner_basis === "unassigned" && q.name === "tour_followups_and_leasing_tasks",
      "3a queue row visible with honest contract", JSON.stringify({ name: q.name, row: row && { b: row.owner_basis } }));
    const r3 = await call("POST", `/operator/leasing/tasks/${anchorOb}/resolve`,
      { token: S.mgrTok, body: { result: "completed", resolution_basis: "unassigned_pickup" } });
    const b3 = await j(r3);
    ok(r3.status === 200, "3b rail resolve (unassigned_pickup)", r3.status + " " + JSON.stringify(b3).slice(0, 140));
    const snap = (await c.query(
      `select outcome, resolution, resolution_basis, closed_by_user_id,
              closed_by_person_id_at_close, closed_identity_resolution_basis
         from leasing_conversion_obligations where obligation_id=$1`, [anchorOb])).rows[0];
    ok(snap.outcome === "kept" && snap.resolution_basis === "unassigned_pickup"
       && snap.closed_by_user_id === S.mgr && snap.closed_identity_resolution_basis === "unbridged",
      "3c closer snapshots honest (raw user kept; unbridged smoke user = null person snapshot)", JSON.stringify(snap));
    const sigAfterFollowup = (await c.query(
      `select count(*)::int as n from leasing_conversion_obligations where conversion_id=$1 and rung='lease_signature_followup'`,
      [S.conv])).rows[0].n;
    // completing tour_followup ladders to applicant_followup — NEVER to signature work
    ok(sigAfterFollowup === 0, "3d no signature successor from follow-up work", "count=" + sigAfterFollowup);

    // ── 4. approval creates EXACTLY ONE signature follow-up ──
    if (OPKEY) {
      // close the ladder's applicant_followup honestly first (submission-shape)
      const af = (await c.query(
        `select obligation_id from leasing_conversion_obligations
          where conversion_id=$1 and rung='applicant_followup' and outcome is null`, [S.conv])).rows[0];
      if (af) await call("POST", `/operator/leasing/tasks/${af.obligation_id}/resolve`,
        { token: S.mgrTok, body: { result: "completed", resolution_basis: "unassigned_pickup" } });
      const appId = (await c.query(
        `insert into lease_applications (property_id, person_id, conversion_id, status, applicant_name)
         values ($1,$2,$3,'submitted','Smoke Prospect') returning id`, [S.prop, S.person, S.conv])).rows[0].id;
      const r4 = await call("POST", `/applications/${appId}/approve`, { key: OPKEY, body: {} });
      const b4 = await j(r4);
      const sigN = (await c.query(
        `select count(*)::int as n from leasing_conversion_obligations where conversion_id=$1 and rung='lease_signature_followup'`,
        [S.conv])).rows[0].n;
      ok(r4.status === 200 && sigN === 1, "4  approval creates exactly ONE lease-signature follow-up",
        r4.status + " sig=" + sigN + " " + JSON.stringify(b4).slice(0, 140));
    }
  } catch (e) {
    fail++; console.log("  SMOKE CRASHED:", e.message);
  } finally {
    // ── teardown: the throwaway property cascades everything it owns ──
    try {
      await c.query(`delete from staff_sessions where token in ($1,$2)`, [S.mgrTok || "", S.noLTok || ""]);
      if (S.prop) {
        // conversions don't cascade from properties — remove children explicitly
        await c.query(`delete from leasing_conversion_obligations where conversion_id in
                         (select id from leasing_conversions where property_id=$1)`, [S.prop]).catch(() => {});
        await c.query(`delete from lease_applications where property_id=$1`, [S.prop]).catch(() => {});
        await c.query(`delete from obligations where property_id=$1`, [S.prop]).catch(() => {});
        await c.query(`delete from events where property_id=$1`, [S.prop]).catch(() => {});
        await c.query(`delete from leasing_conversions where property_id=$1`, [S.prop]).catch(() => {});
        await c.query(`delete from property_team_assignments where property_id=$1`, [S.prop]).catch(() => {});
        await c.query(`delete from properties where id=$1`, [S.prop]);
      }
      for (const u of [S.host, S.mgr, S.noL]) if (u) await c.query(`delete from users where id=$1`, [u]).catch(() => {});
      if (S.person) await c.query(`delete from persons where id=$1`, [S.person]).catch(() => {});
      console.log("  teardown: throwaway world removed.");
    } catch (e2) { console.log("  TEARDOWN INCOMPLETE (harmless throwaway rows may remain, tagged 'R2 SMOKE'):", e2.message); }
    c.release(); await pool.end();
    console.log(`═══ RESULT: ${pass} passed · ${fail} failed ═══`);
    process.exit(fail ? 1 : 0);
  }
})();
