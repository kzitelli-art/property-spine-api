#!/usr/bin/env node
"use strict";

// Real-Postgres proof for the governed property display-name command.
// Requires the caller-owned HARNESS_DATABASE_URL and never falls back to the
// deployed DATABASE_URL.

const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const express = require("express");
const receipt = require("../_run_receipt");
const superAdminModule = require("../../src/identity/super_admin");
const { issueStaffSession } = require("../../src/identity/staff_session_service");
const {
  setPropertyDisplayName,
  propertyDisplayNameHistory,
} = require("../../src/shared/property_display_name_command");

const HARNESS = "property_display_name_command.db.js";
const EXPECTED = 29;
const CONN = receipt.harnessConnectionString();
let passed = 0;
let failed = 0;
function ok(label, condition) {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.error("  FAIL  " + label); }
}
async function refuses(run, code) {
  try { await run(); return null; }
  catch (e) { return e && e.code === code ? e : null; }
}

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const tag = randomUUID();
  let propertyId = null;
  try {
    const org = (await pool.query(
      "insert into organizations(name,slug) values($1,$2) returning id",
      [`Display Proof ${tag}`, `display-proof-${tag}`])).rows[0];
    const person = (await pool.query(
      "insert into persons(name) values($1) returning id", [`Display Proof Actor ${tag}`])).rows[0];
    const admin = (await pool.query(
      `insert into users(name,email,person_id,is_active,status,platform_role,organization_id)
       values($1,$2,$3,true,'active','super_admin',$4) returning id`,
      [`Display Proof Admin ${tag}`, `admin-${tag}@example.invalid`, person.id, org.id])).rows[0];
    const member = (await pool.query(
      `insert into users(name,email,is_active,status,platform_role,organization_id)
       values($1,$2,true,'active','member',$3) returning id`,
      [`Display Proof Member ${tag}`, `member-${tag}@example.invalid`, org.id])).rows[0];
    const property = (await pool.query(
      `insert into properties(name,display_name,organization_id,canonical_key)
       values($1,$2,$3,$4) returning id,name,display_name,canonical_key`,
      [`Internal ${tag}`, "Old Public Label", org.id, `DISPLAY-${tag}`])).rows[0];
    propertyId = property.id;
    for (const userId of [admin.id, member.id]) {
      await pool.query(
        `insert into property_team_assignments
           (property_id,user_id,role_title,allowed_modules,primary_for_modules,can_manage_roles,active)
         values($1,$2,'Proof Admin',array['management'],array[]::text[],true,true)`,
        [property.id, userId]);
    }

    const changed = await setPropertyDisplayName(pool, {
      property_id: property.id,
      display_name: "  New Public Label  ",
      actor_user_id: admin.id,
      reason: "portfolio identity cleanup",
      idempotency_key: "display-proof-1",
    });
    ok("the command changes the display label", changed.changed === true && changed.after === "New Public Label");
    ok("the command records the prior display label", changed.before === "Old Public Label");
    ok("the authenticated user is recorded", changed.actor_user_id === admin.id);
    ok("the canonical business person is recorded", changed.actor_person_id === person.id);
    ok("the authority basis is explicit", changed.authority_basis === "platform_role:super_admin");

    const stored = (await pool.query(
      "select name,display_name,canonical_key from properties where id=$1", [property.id])).rows[0];
    ok("the human-facing display label changed", stored.display_name === "New Public Label");
    ok("the internal property name did not change", stored.name === property.name);
    ok("the canonical key did not change", stored.canonical_key === property.canonical_key);

    const history = await propertyDisplayNameHistory(pool, { property_id: property.id });
    ok("one immutable history row exists", history.changes.length === 1);
    ok("history carries before and after", history.changes[0].before === "Old Public Label" && history.changes[0].after === "New Public Label");
    ok("history carries the reason", history.changes[0].reason === "portfolio identity cleanup");

    const replay = await setPropertyDisplayName(pool, {
      property_id: property.id,
      display_name: "New Public Label",
      actor_user_id: admin.id,
      idempotency_key: "display-proof-1",
    });
    ok("same command identity replays without a write", replay.idempotent_replay === true && replay.changed === false);
    ok("replay leaves one history row", (await propertyDisplayNameHistory(pool, { property_id: property.id })).changes.length === 1);

    const unchanged = await setPropertyDisplayName(pool, {
      property_id: property.id,
      display_name: "New Public Label",
      actor_user_id: admin.id,
    });
    ok("same value without a key is unchanged", unchanged.unchanged === true && unchanged.changed === false);

    ok("blank display names are refused with a useful code", !!(await refuses(
      () => setPropertyDisplayName(pool, { property_id: property.id, display_name: "  ", actor_user_id: admin.id }),
      "display_name_required")));
    ok("a non-admin actor is refused", !!(await refuses(
      () => setPropertyDisplayName(pool, { property_id: property.id, display_name: "Other", actor_user_id: member.id }),
      "super_admin_required")));
    await pool.query("update users set status='suspended' where id=$1", [admin.id]);
    ok("a suspended super admin is refused from current database state", !!(await refuses(
      () => setPropertyDisplayName(pool, { property_id: property.id, display_name: "Other", actor_user_id: admin.id }),
      "super_admin_required")));
    await pool.query("update users set status='active' where id=$1", [admin.id]);
    ok("a missing actor is refused", !!(await refuses(
      () => setPropertyDisplayName(pool, { property_id: property.id, display_name: "Other" }),
      "actor_required")));
    ok("reusing a command key for a different name is refused", !!(await refuses(
      () => setPropertyDisplayName(pool, { property_id: property.id, display_name: "Conflict", actor_user_id: admin.id, idempotency_key: "display-proof-1" }),
      "idempotency_conflict")));

    const concurrent = await Promise.all([
      setPropertyDisplayName(pool, {
        property_id: property.id, display_name: "Concurrent Public Label",
        actor_user_id: admin.id, idempotency_key: "display-concurrent-1",
      }),
      setPropertyDisplayName(pool, {
        property_id: property.id, display_name: "Concurrent Public Label",
        actor_user_id: admin.id, idempotency_key: "display-concurrent-1",
      }),
    ]);
    ok("concurrent duplicate commands yield one change and one replay",
      concurrent.filter((x) => x.changed).length === 1
      && concurrent.filter((x) => x.idempotent_replay).length === 1);
    ok("concurrent duplicate commands write one history row",
      (await propertyDisplayNameHistory(pool, { property_id: property.id })).changes.length === 2);

    const adminSession = await issueStaffSession(pool, { userId: admin.id, propertyId: property.id, purpose: "bootstrap_invite" });
    const memberSession = await issueStaffSession(pool, { userId: member.id, propertyId: property.id, purpose: "bootstrap_invite" });
    const app = express();
    app.use(express.json());
    app.use("/", superAdminModule({ pool }));
    const server = await new Promise((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const denied = await fetch(`${base}/admin/properties/${property.id}/display-name`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-staff-session": memberSession.session_token },
        body: JSON.stringify({ display_name: "Member Attempt" }),
      });
      ok("the HTTP door refuses a signed-in non-super-admin", denied.status === 403);

      const accepted = await fetch(`${base}/admin/properties/${property.id}/display-name`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-staff-session": adminSession.session_token },
        body: JSON.stringify({
          display_name: "Route Public Label",
          actor_user_id: member.id,
          reason: "HTTP boundary proof",
          idempotency_key: "display-route-1",
        }),
      });
      const body = await accepted.json();
      ok("the HTTP door accepts the current super-admin session", accepted.status === 200 && body.changed === true);
      ok("the HTTP door ignores browser-supplied actor identity", body.actor_user_id === admin.id);
      ok("the receipt explains that internal identity was preserved", /internal identity was not changed/i.test(body.receipt || ""));
      const afterRoute = (await pool.query("select name,display_name from properties where id=$1", [property.id])).rows[0];
      ok("the HTTP door changes only the display label", afterRoute.name === property.name && afterRoute.display_name === "Route Public Label");
      const routeHistory = await propertyDisplayNameHistory(pool, { property_id: property.id });
      ok("the HTTP decision is a second immutable change with its true actor",
        routeHistory.changes.length === 3 && routeHistory.changes[0].before === "Concurrent Public Label"
        && routeHistory.changes[0].after === "Route Public Label"
        && routeHistory.changes[0].actor.user_id === admin.id);
    } finally {
      await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }

    let mutationRefused = false;
    try { await pool.query("update property_display_name_changes set reason='rewritten' where property_id=$1", [property.id]); }
    catch (e) { mutationRefused = e && e.code === "P0001"; }
    ok("history rows cannot be updated", mutationRefused);

    let deletionRefused = false;
    try { await pool.query("delete from property_display_name_changes where property_id=$1", [property.id]); }
    catch (e) { deletionRefused = e && e.code === "P0001"; }
    ok("history rows cannot be deleted", deletionRefused);
  } finally {
    // The database is caller-owned and disposable. We deliberately do not
    // weaken the immutable-history trigger to clean one fixture row.
    await pool.end();
  }

  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})().catch((e) => {
  process.exit(receipt.died(HARNESS, e, passed + failed));
});
