#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   HARNESS — AUTHORITY MUTATION CONTAINMENT (Build 1A-2)

   1A-1 gave "create a property" one meaning. Creation is not the only way
   hierarchy and authority change. This proves the other three ways are
   contained, over real Postgres and real HTTP.

   R  REPARENTING — a property cannot change client silently
      R1  adoption (null → org) is allowed and RECORDED
      R2  adoption is idempotent and writes no second event
      R3  reparenting (orgA → orgB) is refused BY THE SERVICE
      R4  reparenting is refused BY THE DATABASE, around the service
      R5  orphaning (org → null) is refused by the database
      R6  an ordinary update to a property still works
      R7  the hierarchy event cannot be updated or deleted
      R8  an org_admin cannot adopt into a sibling org
      R9  an org_admin cannot adopt an orphan AT ALL — adoption is
          platform repair, not property management

   T  TEAM INVITES — the granting actor is derived, never supplied
      T1  no session is refused
      T2  a session with no authority AT THIS PROPERTY is refused
      T3  a body-supplied invited_by_user_id is REJECTED 400, not ignored,
          and the app's real body shape still works
      T4  each of the three authority bases works
      T5  the refusals wrote no invite

   D  WHERE SYNTHETIC DATA MAY LAND — authentication is not the question
      D1-D5  the perimeter fails closed on every limb
      D3     a REAL operating property is refused as a synthetic target
      D6-D7  both fixture doors refuse over real HTTP
      D8     nothing reached the operating property

   S  FUZZY RESOLUTION — recognition proposes, ambiguity refuses
      S1  canonical key resolves
      S2  a registered alias resolves
      S3  ONE text match is PROPOSED, not resolved
      S4  several text matches are ambiguous and all are named
      S5  nothing matching is unresolved
      S6  two properties sharing an exact name are ambiguous, not "oldest"
      S7  the snapshot loader refuses rather than importing on a guess
      S8  the seed route is no longer reachable without a super-admin

   run:  HARNESS_DATABASE_URL="postgres://..." node tests/authority_mutation_containment.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const hierarchy = require("../src/identity/property_hierarchy_service.js");
const creation = require("../src/identity/property_creation_service.js");
const resolution = require("../src/identity/property_resolution_service.js");
const staffIdentity = require("../src/identity/staff_identity_resolver.js");
const snapshotLoader = require("../src/shared/snapshot_loader.js");

const URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });

const OPERATOR_KEY = "harness-key-" + crypto.randomBytes(4).toString("hex");
const TAG = "B1A2_" + process.pid;
const N = 100000 + (process.pid % 800000);

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
  return cond;
};

async function refused(label, expectedReason, fn) {
  try {
    await fn();
    return ok(label, false, "it was ALLOWED. Expected refusal: " + expectedReason);
  } catch (e) {
    return ok(label + "  → " + (e.refusalReason || "(db)"),
      e.refusalReason === expectedReason,
      "expected '" + expectedReason + "', got '" + (e.refusalReason || e.message) + "'");
  }
}

//  The real gate chain from server.js, same as the 1A-1 HTTP harness.
function buildApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const PUBLIC_EXACT = new Set(["/health", "/leasing/intake", "/communications/inbound-sms", "/applications/submit-public"]);
  const PUBLIC_PREFIXES = ["/tenant/", "/t/", "/public/", "/intake/", "/intake", "/auth/", "/demo/", "/agent/", "/legal/"];
  const isOperatorPath = (p) => p === "/operator" || p.startsWith("/operator/");
  const isTeamAccessPath = (p) => /^\/properties\/[^/]+\/(?:team|team-invites|my-access)$/.test(p)
    || /^\/property-team-assignments\/[^/]+$/.test(p);
  app.use((req, res, next) => {
    const p = req.path;
    if (PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((x) => p === x || p.startsWith(x))) return next();
    if (isOperatorPath(p)) return next();
    if (isTeamAccessPath(p)) return next();
    if (p === "/admin" || p.startsWith("/admin/")) return next();
    if (p === "/org" || p.startsWith("/org/")) return next();
    if (req.get("x-operator-key") !== OPERATOR_KEY) return res.status(401).json({ receipt: "Missing or wrong x-operator-key." });
    next();
  });
  app.use("/", require("../src/identity/super_admin.js")({ pool }));
  app.use("/", require("../src/shared/seed_endpoint.js")({ pool }));
  app.use("/", require("../src/shared/snapshot_loader.js")({ pool, upload: null }));
  const staffBridgeService = require("../src/identity/staffbridge.js")({ pool })._service;
  app.use("/", require("../src/identity/teamaccess.js")({
    pool,
    sms: { enabled: () => false, async sendSms() { return { sent: false }; }, validateWebhook: () => true },
    commBoundary: { async sendPropertySms() { return { sent: false, reason: "transport_not_configured" }; } },
    staffBridgeService,
  }));
  return app;
}

function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path,
      headers: Object.assign({ "content-type": "application/json" },
        payload ? { "content-length": Buffer.byteLength(payload) } : {}, headers) },
      (res) => { let d = ""; res.on("data", (c) => { d += c; });
        res.on("end", () => { let p = null; try { p = d ? JSON.parse(d) : null; } catch (_) { p = { _raw: d }; }
          resolve({ status: res.statusCode, body: p }); }); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  receipt.begin(__filename, { url: URL, expected: 50 });

  const server = buildApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  console.log("  real HTTP server on 127.0.0.1:" + port + "\n");

  // ── fixtures ──────────────────────────────────────────────────────
  const orgA = (await pool.query(`insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " Org A", TAG.toLowerCase() + "-a"])).rows[0].id;
  const orgB = (await pool.query(`insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " Org B", TAG.toLowerCase() + "-b"])).rows[0].id;
  const person = (await pool.query(`insert into persons (name) values ($1) returning id`, [TAG + " Human"])).rows[0].id;

  const mkUser = async (role, org) => (await pool.query(
    `insert into users (name, email, platform_role, organization_id, is_active, status, person_id)
     values ($1,$2,$3,$4,true,'active',$5) returning id`,
    [TAG + " " + role, `${TAG}.${role}.${crypto.randomBytes(3).toString("hex")}@x.test`, role, org, person])).rows[0].id;

  const superAdmin = await mkUser("super_admin", null);
  const adminA = await mkUser("org_admin", orgA);
  const adminB = await mkUser("org_admin", orgB);
  const member = await mkUser("member", orgA);

  const seat = (await pool.query(`insert into properties (name, canonical_key) values ($1,$2) returning id`,
    [TAG + " seat", TAG + "-SEAT"])).rows[0].id;
  const mkSession = async (userId, propertyId = seat, canManage = false) => {
    const raw = crypto.randomBytes(32).toString("base64url");
    await pool.query(
      `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active, can_manage_roles)
       values ($1,$2,'harness',ARRAY['management'],true,$3) on conflict do nothing`, [propertyId, userId, canManage]);
    await pool.query(
      `insert into staff_sessions (user_id, property_id, token, token_digest, issuance_purpose, expires_at)
       values ($1,$2,null,$3,'bootstrap_invite', now() + interval '2 hours')`,
      [userId, propertyId, crypto.createHash("sha256").update(raw, "utf8").digest("hex")]);
    return raw;
  };
  const sSuper = await mkSession(superAdmin);
  const sAdminA = await mkSession(adminA);
  const sMember = await mkSession(member);

  const mkOrphan = async (suffix) => (await pool.query(
    `insert into properties (name, canonical_key) values ($1,$2) returning id`,
    [`${TAG} orphan ${suffix}`, `${TAG}-ORPH-${suffix}`])).rows[0].id;

  // ══════════════════════════════════════════════════════════════════
  console.log("  ── R · REPARENTING IS REFUSED, ADOPTION IS RECORDED ──");
  // ══════════════════════════════════════════════════════════════════
  const p1 = await mkOrphan("1");
  const r1 = await hierarchy.assignPropertyToOrganization(pool, {
    actor: { user_id: superAdmin }, property_id: p1, organization_id: orgA, reason: "legacy orphan repair" });
  const p1row = (await pool.query(`select organization_id from properties where id=$1`, [p1])).rows[0];
  const r1ev = (await pool.query(
    `select from_organization_id, to_organization_id, actor_user_id, actor_person_id, authority_basis, kind
       from property_organization_events where property_id=$1`, [p1])).rows;
  ok("R1a adoption (null → org) is allowed", r1.already === false && String(p1row.organization_id) === String(orgA));
  ok("R1b and it is RECORDED, with both identities and the authority exercised",
    r1ev.length === 1 && r1ev[0].from_organization_id === null
      && String(r1ev[0].to_organization_id) === String(orgA)
      && String(r1ev[0].actor_user_id) === String(superAdmin)
      && String(r1ev[0].actor_person_id) === String(person)
      && r1ev[0].authority_basis === "platform_role:super_admin" && r1ev[0].kind === "adoption",
    JSON.stringify(r1ev));

  const r2 = await hierarchy.assignPropertyToOrganization(pool, {
    actor: { user_id: superAdmin }, property_id: p1, organization_id: orgA });
  const r2n = (await pool.query(
    `select count(*)::int n from property_organization_events where property_id=$1`, [p1])).rows[0].n;
  ok("R2  re-adopting into the same organization is idempotent and writes no second event",
    r2.already === true && r2n === 1, "events=" + r2n);

  await refused("R3  reparenting is refused BY THE SERVICE", "property_already_has_an_organization",
    () => hierarchy.assignPropertyToOrganization(pool, {
      actor: { user_id: superAdmin }, property_id: p1, organization_id: orgB }));

  //  R4/R5 — the rule must bind writers that never come through the
  //  service. Attacked directly, the way a script or a psql session would.
  let r4 = false;
  try { await pool.query(`update properties set organization_id=$1 where id=$2`, [orgB, p1]); }
  catch (e) { r4 = /cannot change organization/i.test(e.message); }
  ok("R4  reparenting is refused BY THE DATABASE, around the service", r4,
     "a bare UPDATE moved a property between clients");

  let r5 = false;
  try { await pool.query(`update properties set organization_id=null where id=$1`, [p1]); }
  catch (e) { r5 = /cannot be returned to none/i.test(e.message); }
  ok("R5  orphaning is refused by the database", r5);

  await pool.query(`update properties set name=$1 where id=$2`, [TAG + " renamed", p1]);
  const r6 = (await pool.query(`select name from properties where id=$1`, [p1])).rows[0].name;
  ok("R6  an ordinary update to a property still works", r6 === TAG + " renamed");

  let r7u = false, r7d = false;
  try { await pool.query(`update property_organization_events set authority_basis='forged' where property_id=$1`, [p1]); }
  catch (e) { r7u = /immutable/i.test(e.message); }
  try { await pool.query(`delete from property_organization_events where property_id=$1`, [p1]); }
  catch (e) { r7d = /immutable/i.test(e.message); }
  ok("R7  the hierarchy record cannot be updated or deleted", r7u && r7d);

  const p2 = await mkOrphan("2");
  await refused("R8  an org_admin cannot adopt into a SIBLING organization", "organization_scope_violation",
    () => hierarchy.assignPropertyToOrganization(pool, {
      actor: { user_id: adminA }, property_id: p2, organization_id: orgB }));

  //  R9 — the ruling's condition. Adoption is legacy REPAIR, not property
  //  management: an org admin must not be able to claim an orphan even
  //  into their OWN organization, because the orphan set is precisely the
  //  properties whose real owner was never recorded.
  await refused("R9  an org_admin cannot adopt an orphan into their OWN organization either",
    "adoption_requires_platform_repair_authority",
    () => hierarchy.assignPropertyToOrganization(pool, {
      actor: { user_id: adminA }, property_id: p2, organization_id: orgA }));

  const p2row = (await pool.query(`select organization_id from properties where id=$1`, [p2])).rows[0];
  ok("R9b the refused adoption left the property unowned", p2row.organization_id === null);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── T · THE GRANTING ACTOR IS DERIVED, NEVER SUPPLIED ──");
  // ══════════════════════════════════════════════════════════════════
  const KEY = { "x-operator-key": OPERATOR_KEY };
  const invitee = () => "+1555" + String(1000000 + Math.floor(Math.random() * 8999999)).slice(0, 7);
  const inviteBody = (extra = {}) => Object.assign({
    phone_number: invitee(), role_title: "Maintenance Tech",
    allowed_modules: ["maintenance"], invited_name: TAG + " Invitee" }, extra);

  const t1 = await request(port, "POST", `/properties/${seat}/team-invites`, { headers: KEY, body: inviteBody() });
  ok("T1  the operator key alone can no longer grant access (401)",
    t1.status === 401 && t1.body.reason === "no_authenticated_actor", JSON.stringify(t1));

  //  A REAL session — but at a different property, with no authority here.
  const otherProp = await mkOrphan("other");
  const sElsewhere = await mkSession(member, otherProp, true);
  const t2 = await request(port, "POST", `/properties/${seat}/team-invites`,
    { headers: { "x-staff-session": sElsewhere }, body: inviteBody() });
  ok("T2  a real session outside this property is refused before authority (403)",
    t2.status === 403 && t2.body.reason === "staff_session_property_mismatch", JSON.stringify(t2));

  //  T3 — the whole point. A body actor field is REJECTED, not ignored.
  //  This follows the rule already frozen by the write-authority hardening
  //  packet: silent ignoring lets a stale client keep sending a field it
  //  believes is honoured. This harness first asserted "ignored"; the rule
  //  was found during a cross-check against that packet, and both the
  //  service and this assertion were corrected to match it.
  const forged = adminB;
  const t3 = await request(port, "POST", `/properties/${seat}/team-invites`,
    { headers: { "x-staff-session": sSuper },
      body: inviteBody({ invited_by_user_id: forged }) });
  ok("T3a a body-supplied invited_by_user_id is REJECTED (400), not silently ignored",
    t3.status === 400 && t3.body.reason === "body_actor_field_rejected", JSON.stringify(t3));

  const t3n = (await pool.query(
    `select count(*)::int n from team_invites where invited_by_user_id = $1`, [forged])).rows[0].n;
  ok("T3b the forged inviter was never recorded anywhere", t3n === 0, t3n + " row(s)");

  //  The APP'S OWN body shape — measured from index.html, which sends no
  //  actor field. This is the call that must keep working.
  const t3app = await request(port, "POST", `/properties/${seat}/team-invites`, {
    headers: { "x-staff-session": sSuper },
    body: { invited_name: TAG + " App Invitee", phone_number: invitee(),
            role_title: "Maintenance Tech", allowed_modules: ["maintenance"],
            scope_type: "property", backup_user_id: null,
            escalates_to_user_id: null, can_manage_roles: false } });
  const t3row = (await pool.query(
    `select invited_by_user_id from team_invites where id=$1`, [t3app.body && t3app.body.invite_id])).rows[0];
  ok("T3c the APP's actual body shape still works, actor derived from the session",
    t3app.status === 200 && t3row && String(t3row.invited_by_user_id) === String(superAdmin),
    JSON.stringify({ status: t3app.status, recorded: t3row && t3row.invited_by_user_id }));
  ok("T3d the grant reports its own provenance",
    t3app.body.granted_by_user_id === superAdmin && t3app.body.authority_basis === "platform_role:super_admin",
    JSON.stringify({ by: t3app.body.granted_by_user_id, basis: t3app.body.authority_basis }));

  //  T4 — all three bases. orgA owns `seat`? Not yet: adopt it first so
  //  the org_admin path is a real one rather than a contrived one.
  await hierarchy.assignPropertyToOrganization(pool, {
    actor: { user_id: superAdmin }, property_id: seat, organization_id: orgA });
  const t4b = await request(port, "POST", `/properties/${seat}/team-invites`,
    { headers: { "x-staff-session": sAdminA }, body: inviteBody() });
  ok("T4a org_admin of the owning organization may grant",
    t4b.status === 200 && t4b.body.authority_basis === "platform_role:org_admin", JSON.stringify(t4b.body));

  const manager = await mkUser("member", orgA);
  const sManager = await mkSession(manager, seat, true);   // can_manage_roles at THIS property
  const t4c = await request(port, "POST", `/properties/${seat}/team-invites`,
    { headers: { "x-staff-session": sManager }, body: inviteBody() });
  ok("T4b an assignment here with can_manage_roles may grant",
    t4c.status === 200 && t4c.body.authority_basis === "assignment:can_manage_roles", JSON.stringify(t4c.body));

  const sPlain = await mkSession(await mkUser("member", orgA), seat, false); // no can_manage_roles
  const t4d = await request(port, "POST", `/properties/${seat}/team-invites`,
    { headers: { "x-staff-session": sPlain }, body: inviteBody() });
  ok("T4c an assignment here WITHOUT can_manage_roles may not grant",
    t4d.status === 403 && t4d.body.reason === "insufficient_property_authority", JSON.stringify(t4d));

  const t5 = (await pool.query(
    `select count(*)::int n from team_invites
      where invited_by_user_id is null and invited_name like $1`, [`${TAG}%`])).rows[0].n;
  ok("T5  no invite created by this harness carries a null granting actor", t5 === 0, t5 + " invite(s) with no inviter");

  const t6a = await request(port, "GET", `/properties/${seat}/team`);
  ok("T6a the team roster is not public (401)", t6a.status === 401, JSON.stringify(t6a));
  const t6b = await request(port, "GET", `/properties/${seat}/team`,
    { headers: { "x-staff-session": sElsewhere } });
  ok("T6b a staff session cannot read another property's team (403)",
    t6b.status === 403 && t6b.body.reason === "staff_session_property_mismatch", JSON.stringify(t6b));
  const t6c = await request(port, "GET", `/properties/${seat}/team`,
    { headers: { "x-staff-session": sSuper } });
  ok("T6c the signed-in app reads its live team without an operator key",
    t6c.status === 200 && Array.isArray(t6c.body.team), JSON.stringify(t6c));

  const unifiedPhone = invitee();
  const unifiedPerson = (await pool.query(
    `insert into persons (name, phone) values ($1,$2) returning id`,
    [TAG + " Unified Leasing", unifiedPhone])).rows[0];
  const t7a = await request(port, "POST", `/properties/${seat}/team-invites`, {
    headers: { "x-staff-session": sSuper },
    body: { invited_name: TAG + " Unified Leasing", phone_number: unifiedPhone,
            role_key: "leasing_agent", scope_type: "property" },
  });
  ok("T7a an existing person is proposed, never silently linked",
    t7a.status === 409 && t7a.body.reason === "existing_person_confirmation_required"
      && t7a.body.candidates.some(p => p.id === unifiedPerson.id), JSON.stringify(t7a));
  const t7aRows = (await pool.query(
    `select count(*)::int n from team_invites where phone_number=$1 and status='active'`,
    [unifiedPhone])).rows[0].n;
  ok("T7b the confirmation stop wrote no invite and sent nothing", t7aRows === 0, String(t7aRows));

  const t7c = await request(port, "POST", `/properties/${seat}/team-invites`, {
    headers: { "x-staff-session": sSuper },
    body: { invited_name: TAG + " Unified Leasing", phone_number: unifiedPhone,
            role_key: "leasing_agent", person_id: unifiedPerson.id, scope_type: "property" },
  });
  ok("T7c the manager-confirmed person creates one canonical-role invite",
    t7c.status === 200 && t7c.body.person_id === unifiedPerson.id
      && t7c.body.role_key === "leasing_agent", JSON.stringify(t7c));

  const inviteToken = String(t7c.body.link || "").split("/join/")[1];
  const t7start = await request(port, "POST", "/auth/sms/start", { body: { token: inviteToken } });
  ok("T7d invite acceptance uses the existing OTP door",
    t7start.status === 200 && t7start.body.dev_code, JSON.stringify(t7start));
  const t7verify = await request(port, "POST", "/auth/sms/verify",
    { body: { token: inviteToken, code: t7start.body.dev_code } });
  ok("T7e one acceptance returns a session and the confirmed person",
    t7verify.status === 200 && t7verify.body.session_token
      && t7verify.body.person_id === unifiedPerson.id, JSON.stringify(t7verify));

  const unified = (await pool.query(
    `select u.id, u.person_id, u.account_kind, pta.role_key, pta.allowed_modules,
            exists(select 1 from person_contexts pc
                    where pc.person_id=u.person_id and pc.context_type='staff'
                      and pc.property_id=$2 and pc.active_to is null) as has_context,
            exists(select 1 from assignments a
                    where a.person_id=u.person_id and a.property_id=$2
                      and a.role='leasing' and a.is_active=true) as has_assignment
       from users u
       join property_team_assignments pta on pta.user_id=u.id and pta.property_id=$2 and pta.active=true
      where u.phone=$1`, [unifiedPhone, seat])).rows[0];
  ok("T7f acceptance classifies and audits the login-to-person bridge",
    unified && unified.account_kind === "human_staff" && unified.person_id === unifiedPerson.id,
    JSON.stringify(unified));
  ok("T7g acceptance grants property access from the canonical role",
    unified && unified.role_key === "leasing_agent" && unified.allowed_modules.includes("leasing"),
    JSON.stringify(unified));
  ok("T7h acceptance establishes staff context and work eligibility together",
    unified && unified.has_context === true && unified.has_assignment === true,
    JSON.stringify(unified));
  const unifiedEligibility = await staffIdentity.resolveStaffIdentity(pool, {
    user_id: unified.id, property_id: seat, work_type: "tour_follow_up",
  });
  ok("T7i the canonical work-owner resolver recognizes the onboarded teammate",
    unifiedEligibility.state === "resolved" && unifiedEligibility.person_id === unifiedPerson.id,
    JSON.stringify(unifiedEligibility));

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── S · RECOGNITION PROPOSES. AMBIGUITY REFUSES. ──");
  // ══════════════════════════════════════════════════════════════════
  const solo = (await creation.createProperty(pool, { actor: { user_id: superAdmin }, organization_id: orgA,
    name: TAG + " Solo on Chestnut", address: `${N + 4233} Chestnut Street`,
    aliases: [TAG + " solo roll"], source: "super_admin_wizard" })).property;
  const uno = (await creation.createProperty(pool, { actor: { user_id: superAdmin }, organization_id: orgA,
    name: TAG + " Uno on Chestnut", address: `${N + 4125} Chestnut Street`,
    source: "super_admin_wizard" })).property;

  const s1 = await resolution.resolvePropertyForImport(pool, { canonical_key: solo.canonical_key });
  ok("S1  a canonical key resolves", s1.status === "resolved" && s1.property_id === solo.id && s1.via === "canonical_key");

  const s2 = await resolution.resolvePropertyForImport(pool, { match_tokens: [TAG + " solo roll"] });
  ok("S2  a registered alias resolves", s2.status === "resolved" && s2.property_id === solo.id && s2.via === "registry_alias");

  //  ONE text match. The old resolver would have returned it silently.
  const s3 = await resolution.resolvePropertyForImport(pool, { match_tokens: [TAG + " Solo on"] });
  ok("S3  ONE text match is PROPOSED, not resolved",
    s3.status === "proposed" && s3.property_id === null && s3.candidates.length === 1
      && s3.candidates[0].property_id === solo.id,
    JSON.stringify(s3));

  //  The real collision: "Chestnut" means both buildings.
  const s4 = await resolution.resolvePropertyForImport(pool, { match_tokens: ["Chestnut"] });
  const ids = s4.candidates.map((c) => String(c.property_id));
  ok("S4  several text matches are ambiguous, and ALL of them are named",
    s4.status === "ambiguous" && s4.property_id === null
      && ids.includes(String(solo.id)) && ids.includes(String(uno.id)),
    JSON.stringify({ status: s4.status, n: s4.candidates.length }));

  const s5 = await resolution.resolvePropertyForImport(pool, { match_tokens: [TAG + " nothing like this"] });
  ok("S5  nothing matching is unresolved", s5.status === "unresolved" && s5.candidates.length === 0);

  const dupName = TAG + " Twin Towers";
  await pool.query(`insert into properties (name, canonical_key) values ($1,$2),($1,$3)`,
    [dupName, TAG + "-TWIN-A", TAG + "-TWIN-B"]);
  const s6 = await resolution.resolvePropertyForImport(pool, { name_exact: dupName });
  ok("S6  two properties sharing an exact name are ambiguous, not 'the oldest'",
    s6.status === "ambiguous" && s6.property_id === null && s6.candidates.length === 2, JSON.stringify(s6.status));

  //  S7 — the loader itself. Given an ambiguous config and NO explicit
  //  target, it must refuse rather than import onto a guess.
  const s7 = await snapshotLoader.loadSnapshot(pool,
    { key: "harness", property_match: ["Chestnut"], leasing_model: "unit",
      source_file: TAG + " roll.xlsx", source_as_of_date: "2026-06-30", confidence: "confirmed" },
    [{ unit_number: "101", tenant: "A Person", actual: 1000 }], {});
  ok("S7  the snapshot loader REFUSES rather than importing on a guess",
    s7.error === "property_not_resolved" && s7.resolution_status === "ambiguous"
      && Array.isArray(s7.candidates) && s7.candidates.length >= 2,
    JSON.stringify(s7).slice(0, 240));

  //  S8 — and the route that used to reach it unauthenticated.
  const s8a = await request(port, "POST", "/admin/seed-snapshot/skyline", {});
  const s8b = await request(port, "POST", "/admin/seed-snapshot/skyline",
    { headers: { "x-staff-session": sMember } });
  ok("S8a POST /admin/seed-snapshot is no longer reachable unauthenticated (401)",
    s8a.status === 401 && s8a.body.reason === "no_authenticated_actor", JSON.stringify(s8a));
  ok("S8b and a non-super-admin session is refused (403)",
    s8b.status === 403 && s8b.body.reason === "insufficient_platform_role", JSON.stringify(s8b));

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── D · WHERE SYNTHETIC DATA MAY LAND (the ruling's condition) ──");
  // ══════════════════════════════════════════════════════════════════
  //  Authentication answers WHO may call the fixture loaders. This answers
  //  WHERE their output may land. The claim under test is the strong one:
  //  a fully authenticated caller cannot put a fixture rent roll on an
  //  operating property.
  const perimeter = require("../src/shared/synthetic_data_perimeter.js");

  const realProperty = (await creation.createProperty(pool, {
    actor: { user_id: superAdmin }, organization_id: orgA,
    name: TAG + " Operating Building", address: `${N + 77} Real Street`,
    source: "super_admin_wizard" })).property;
  const demoProperty = (await creation.createProperty(pool, {
    actor: { user_id: superAdmin }, organization_id: orgA,
    name: TAG + " Demo Building", address: `${N + 88} Demo Street`,
    source: "super_admin_wizard" })).property;

  //  1. disabled deployment: nothing lands anywhere, even a demo target.
  delete process.env.DEMO_MODE; delete process.env.SYNTHETIC_SEED_ENABLED;
  process.env.SYNTHETIC_SEED_PROPERTY_IDS = demoProperty.id;
  ok("D1  with synthetic writes disabled, even a demo target is refused",
    perimeter.syntheticTargetAllowed(demoProperty.id).reason === "synthetic_writes_disabled");

  //  2. enabled but unconfigured: still nothing. Fail closed on each limb.
  process.env.SYNTHETIC_SEED_ENABLED = "true";
  delete process.env.SYNTHETIC_SEED_PROPERTY_IDS;
  ok("D2  enabled but with no allowlist configured, nothing is seedable",
    perimeter.syntheticTargetAllowed(demoProperty.id).reason === "no_synthetic_target_configured");

  //  3. THE ONE THAT MATTERS. Fully enabled, allowlist configured, and a
  //     real operating property is still refused.
  process.env.SYNTHETIC_SEED_PROPERTY_IDS = demoProperty.id;
  const onReal = perimeter.syntheticTargetAllowed(realProperty.id);
  ok("D3  a REAL operating property is refused as a synthetic target",
    onReal.allowed === false && onReal.reason === "target_not_a_demo_property",
    JSON.stringify(onReal));
  ok("D4  the configured demo property IS permitted",
    perimeter.syntheticTargetAllowed(demoProperty.id).allowed === true);

  //  5. an unresolved target cannot slip through as "no id, no check"
  ok("D5  an unresolved target is refused, not waved through",
    perimeter.syntheticTargetAllowed(null).reason === "target_not_resolved");

  //  6. through REAL HTTP, on the fixture route, with a super-admin session.
  //     The dataset resolves by substring; the perimeter is what stops it.
  const d6 = await request(port, "POST", "/admin/seed-snapshot/skyline",
    { headers: { "x-staff-session": sSuper } });
  ok("D6  the seed route refuses over HTTP even for a super admin (403)",
    d6.status === 403 && d6.body.reason && d6.body.reason.startsWith("target_not"),
    JSON.stringify(d6).slice(0, 200));

  //  7. and the config-keyed snapshot door is behind the same perimeter.
  const d7 = await request(port, "POST", "/snapshot/skyline/load",
    { headers: KEY, body: { rows: [{ unit_number: "1", tenant: "X", actual: 1 }] } });
  ok("D7  the /snapshot/:property fixture door is behind the same perimeter (403)",
    d7.status === 403 && typeof d7.body.reason === "string",
    JSON.stringify(d7).slice(0, 200));

  //  8. nothing landed on the real property from any of it.
  const d8 = (await pool.query(
    `select count(*)::int n from import_batches where property_id = $1`, [realProperty.id])).rows[0].n;
  ok("D8  no import batch reached the operating property", d8 === 0, d8 + " batch(es)");
  delete process.env.SYNTHETIC_SEED_ENABLED; delete process.env.SYNTHETIC_SEED_PROPERTY_IDS;

  console.log("");
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 50 });
  server.close();
  await pool.end();
  process.exit(code);
})().catch(async (e) => {
  console.error("\n  " + (e && e.stack || e));
  const code = receipt.died(__filename, e, pass + fail);
  try { await pool.end(); } catch (_) {}
  process.exit(code);
});
