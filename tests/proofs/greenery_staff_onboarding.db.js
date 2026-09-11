"use strict";
// Class 3 · Greenery staff onboarding rehearsal.
//
// Owned nonce-verified database, owned HTTP server (E2E_API_BASE), fake SMS
// transport (E2E_SMS_LOG). Synthetic accounts only; no production identity,
// credential, provider or message.
//
// Question: can the EXISTING governed path bring an already-existing, active
// human_staff account — classified, uniquely bridged to a person, phone
// verified, assigned at a Skyline-shaped property — into a newly adopted
// Greenery-shaped property so that resolveStaffIdentity resolves them there
// with Leasing access? Every state change after the fixture is an HTTP call
// against the real routes; nothing is patched with SQL to manufacture the
// outcome. Reads are SQL.
//
// The fixture itself is built the way production was: the "Mike" account is
// created through the governed invite + OTP path at the Skyline-shaped
// property, not inserted by hand.
//
// PROOF_EXPECT_DEFECT=1 is the baseline witness: the two admin provisioning
// doors are expected to fail for a phone-only account and to reset an omitted
// platform role. The default is the successor contract.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service");
const staffIdentity = require("../../src/identity/staff_identity_resolver");

const BASE = process.env.E2E_API_BASE;
const SMS_LOG = process.env.E2E_SMS_LOG;
const WITNESS = process.env.PROOF_EXPECT_DEFECT === "1";
assert.ok(BASE, "E2E_API_BASE (owned HTTP server) is required");
assert.ok(SMS_LOG, "E2E_SMS_LOG (fake transport log) is required");

const results = [];
let failed = 0;
let current = "setup";
function record(ok, label, detail, kind = "check") {
  results.push({ section: current, label, ok, kind, detail: detail === undefined ? null : detail });
  if (!ok && kind === "check") failed++;
  console.log(`  ${kind === "observe" ? "NOTE" : ok ? "PASS" : "FAIL"}  [${current}] ${label}${detail !== undefined ? " | " + JSON.stringify(detail) : ""}`);
}
const check = (c, l, d) => { record(!!c, l, d); return !!c; };
const observe = (l, d) => record(true, l, d, "observe");
const need = (c, l, d) => { record(!!c, l, d); if (!c) throw new Error(`need: ${l}`); };
async function section(name, fn) {
  current = name; console.log(`\n== ${name} ==`);
  try { await fn(); } catch (e) { record(false, `section aborted: ${e.message}`, null); }
}
async function api(method, route, { token, key = false, body } = {}) {
  const headers = {};
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + route, { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => null);
  return { status: r.status, body: data };
}
function sms() {
  if (!fs.existsSync(SMS_LOG)) return [];
  return fs.readFileSync(SMS_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
async function waitSms(from, pred) {
  for (let i = 0; i < 80; i++) { const m = sms().slice(from).find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); }
  return null;
}

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  const numBase = 2000000 + (parseInt(nonce.slice(0, 6), 16) % 7000000);
  const num = (k) => "+1215" + String(numBase + k);
  const F = {};
  const session = async (userId, propertyId) => (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
  const counts = async () => one(`select (select count(*)::int from users) users, (select count(*)::int from persons) persons`);
  const mikeState = async (propertyId) => {
    const u = await one("select id, email, phone, person_id, account_kind, platform_role, organization_id, status, phone_verified_at from users where id=$1", [F.mike.id]);
    const teams = (await q("select property_id, active, allowed_modules, role_key from property_team_assignments where user_id=$1 order by property_id", [F.mike.id])).rows;
    const asg = (await q("select property_id, role, is_active from assignments where person_id=$1 order by property_id", [u.person_id])).rows;
    const ctx = (await q("select property_id from person_contexts where person_id=$1 and context_type='staff' and active_to is null order by property_id", [u.person_id])).rows;
    const identity = propertyId ? await staffIdentity.resolveStaffIdentity(pool, { user_id: F.mike.id, property_id: propertyId }) : null;
    return { user: u, teams, assignments: asg, contexts: ctx, identity };
  };
  // Governed invite + OTP acceptance for a phone at a property, driven by a
  // session that holds authority there. Returns the acceptance response.
  async function inviteAndAccept({ token, propertyId, phone, name, role_key, person_id = null, expectDelivery = "sms_sent" }) {
    const from = sms().length;
    const invite = await api("POST", `/properties/${propertyId}/team-invites`, { token, body: { invited_name: name, phone_number: phone, role_key, scope_type: "property", ...(person_id ? { person_id } : {}) } });
    if (invite.status >= 400) return { invite };
    const joinToken = String(invite.body.link || "").split("/join/")[1];
    const start = await api("POST", "/auth/sms/start", { body: { token: joinToken } });
    let code = null;
    if (invite.body.delivery === "sms_sent") {
      const text = await waitSms(from, (m) => m.to === phone && /access code is \d{6}/.test(m.body || ""));
      code = text ? text.body.match(/access code is (\d{6})/)[1] : null;
    } else if (start.body && start.body.dev_code) code = start.body.dev_code;
    const verify = code ? await api("POST", "/auth/sms/verify", { body: { token: joinToken, code } }) : { status: 0, body: null };
    return { invite, joinToken, start, verify, delivery: invite.body.delivery, expectDelivery };
  }

  try {
    await section("fixture", async () => {
      F.org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`OneFive-shaped ${nonce}`, `onefive-${nonce}`]);
      F.org2 = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Other client ${nonce}`, `other-${nonce}`]);
      F.s1 = await one("insert into properties (name,display_name,address,organization_id,leasing_basis) values ($1,'Skyline (rehearsal)','1417 N 15th (rehearsal)',$2,'bed') returning id", [`Skyline rehearsal ${nonce}`, F.org.id]);
      F.g = await one("insert into properties (name,display_name,address,organization_id,leasing_basis,canonical_key_absent_reason) values ($1,'The Greenery (rehearsal)','1325 N 15th (rehearsal)',null,'unknown','predates_canonical_identity_requirement') returning id", [`Greenery rehearsal ${nonce}`]);
      // Text lines are fixture (line policy is outside this lane): the invite
      // code has to reach the fake transport for acceptance to be real.
      for (const [p, k] of [[F.s1.id, 1], [F.g.id, 2]]) {
        await q(`insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status)
          values ($1,'property_facing',$2,'external','residents_and_prospects',true,true,'proactive','active')`, [num(k), p]);
      }
      async function staffUser(name, { platform_role, organization_id, phone, email }) {
        const person = await one("insert into persons (name,phone,primary_phone_e164,source) values ($1,$2,$2,'rehearsal') returning id", [name, phone]);
        const u = await one(`insert into users (name,phone,email,role,auth_provider,platform_role,organization_id,is_active,status,account_kind,person_id,phone_verified_at)
          values ($1,$2,$3,'property_manager','phone_otp',$4,$5,true,'active','human_staff',$6,now()) returning id, person_id, email, phone`, [name, phone, email, platform_role, organization_id, person.id]);
        await q("insert into person_contexts (person_id,context_type,property_id) values ($1,'staff',$2)", [person.id, F.s1.id]);
        return u;
      }
      async function team(u, propertyId, role_key, modules, manage) {
        await q(`insert into property_team_assignments (property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
          values ($1,$2,$3,$3,'property',$4,'{management}',$5,true)`, [propertyId, u.id, role_key, modules, manage]);
        await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,'property_manager','{\"source\":\"rehearsal\"}')", [u.person_id, propertyId]);
      }
      F.sa = await staffUser(`Platform Admin ${nonce}`, { platform_role: "super_admin", organization_id: null, phone: num(11), email: `sa-${nonce}@example.test` });
      await team(F.sa, F.s1.id, "property_admin", "{management,leasing,maintenance,reporting}", true);
      F.oa = await staffUser(`Org Admin ${nonce}`, { platform_role: "org_admin", organization_id: F.org.id, phone: num(12), email: `oa-${nonce}@example.test` });
      await team(F.oa, F.s1.id, "property_admin", "{management,leasing,maintenance,reporting}", true);
      F.oaPhoneOnly = await staffUser(`Phone-only Org Admin ${nonce}`, { platform_role: "org_admin", organization_id: F.org.id, phone: num(13), email: null });
      await team(F.oaPhoneOnly, F.s1.id, "property_admin", "{management,leasing,maintenance,reporting}", true);
      F.oa2 = await staffUser(`Other Client Admin ${nonce}`, { platform_role: "org_admin", organization_id: F.org2.id, phone: num(14), email: `oa2-${nonce}@example.test` });
      F.s2 = await one("insert into properties (name,address,organization_id) values ($1,'2 Other St',$2) returning id", [`Other property ${nonce}`, F.org2.id]);
      await team(F.oa2, F.s2.id, "property_admin", "{management,leasing}", true);
      F.saTok = await session(F.sa.id, F.s1.id);
      F.oaTok = await session(F.oa.id, F.s1.id);
      F.oaPhoneOnlyTok = await session(F.oaPhoneOnly.id, F.s1.id);
      F.oa2Tok = await session(F.oa2.id, F.s2.id);
      // "Mike": an existing staff member created through the governed path
      // at the Skyline-shaped property. Phone only, no email.
      F.mikePhone = num(20);
      const made = await inviteAndAccept({ token: F.oaTok, propertyId: F.s1.id, phone: F.mikePhone, name: `Mike (rehearsal) ${nonce}`, role_key: "property_manager" });
      need(made.verify && made.verify.status === 200 && made.verify.body.session_token, "the existing account is created by the governed invite and OTP acceptance at the Skyline-shaped property", { invite: made.invite && made.invite.status, delivery: made.delivery, verify: made.verify && made.verify.status, body: made.verify && made.verify.body });
      F.mike = { id: made.verify.body.user.id, s1Tok: made.verify.body.session_token };
      const st = await mikeState(F.s1.id);
      check(st.user.account_kind === "human_staff" && !!st.user.person_id && !!st.user.phone_verified_at && st.user.email === null && st.user.platform_role === "member"
        && st.teams.length === 1 && st.teams[0].property_id === F.s1.id && st.identity.state === "resolved",
        "the account matches QB's read of the real one: human_staff, unique person bridge, verified phone, Skyline assignment and team, resolved there, no email", { platform_role: st.user.platform_role, identity: st.identity.state, contexts: st.contexts.length });
      F.before = await counts();
    });
    need(F.mike, "existing staff account exists");
    const G = F.g.id;

    await section("custody", async () => {
      const before = await api("POST", `/properties/${G}/team-invites`, { token: F.oaTok, body: { invited_name: "x", phone_number: F.mikePhone, role_key: "leasing_agent" } });
      check(before.status === 403 && before.body.reason === "staff_session_property_mismatch", "before custody nobody can invite at the property from another property's session", { status: before.status, reason: before.body && before.body.reason });
      const select = await api("POST", "/operator/properties/select", { token: F.oaTok, body: { property_id: G } });
      check(select.status === 403, "an org admin without an assignment cannot open the property", { status: select.status });
      observe("an unowned property could be adopted into any client; which client is the owner's decision and must be right the first time, because the next check shows it cannot be moved");
      const adopt = await api("POST", `/admin/organizations/${F.org.id}/properties`, { token: F.saTok, body: { property_id: G, reason: "rehearsal: place The Greenery with its client" } });
      need(adopt.status === 200 && adopt.body.organization_id === F.org.id, "super admin adoption places the property with the client without changing its id", { status: adopt.status, body: adopt.body });
      const wrongOrg = await api("POST", `/admin/organizations/${F.org2.id}/properties`, { token: F.saTok, body: { property_id: G } });
      check(wrongOrg.status === 409 && wrongOrg.body.reason === "property_already_has_an_organization", "once owned, a property cannot be moved to another client", { status: wrongOrg.status, reason: wrongOrg.body && wrongOrg.body.reason });
      const orgAdminAdopt = await api("POST", `/admin/organizations/${F.org.id}/properties`, { token: F.oaTok, body: { property_id: G } });
      check(orgAdminAdopt.status === 403, "an org admin cannot use the adoption door", { status: orgAdminAdopt.status });
      const otherOrgInvite = await api("POST", "/org/users/invite", { token: F.oa2Tok, body: { name: "x", phone: num(30), email: `x-${nonce}@example.test`, property_id: G, role_key: "leasing_agent" } });
      check(otherOrgInvite.status === 400 && /does not belong/.test(String(otherOrgInvite.body && otherOrgInvite.body.error)), "another client's org admin cannot provision staff at this property", { status: otherOrgInvite.status, error: otherOrgInvite.body && otherOrgInvite.body.error });
    });

    await section("first-property-access", async () => {
      // The governed invite needs a session AT the property; a session needs an
      // assignment there. The first assignment can only come from the two
      // admin provisioning doors. Both are exercised for a phone-only account
      // and for an email-bearing one.
      const roleBefore = (await one("select platform_role from users where id=$1", [F.oaPhoneOnly.id])).platform_role;
      const c0 = await counts();
      const phoneOnly = await api("POST", "/org/users/invite", { token: F.oaPhoneOnlyTok, body: { name: `Phone-only Org Admin ${nonce}`, phone: F.oaPhoneOnly.phone, property_id: G, role_key: "property_admin" } });
      const c1 = await counts();
      if (WITNESS) {
        check(phoneOnly.status === 500 && /ON CONFLICT/.test(String(phoneOnly.body && phoneOnly.body.error)), "WITNESS: the org-admin invite door fails for a phone-only account (ON CONFLICT (phone) has no matching constraint)", { status: phoneOnly.status, error: phoneOnly.body && String(phoneOnly.body.error).slice(0, 90) });
      } else {
        check(phoneOnly.status === 201 && phoneOnly.body.user.id === F.oaPhoneOnly.id, "the org-admin invite door attaches a phone-only existing account to the property", { status: phoneOnly.status, body: phoneOnly.body });
        check(c1.users === c0.users && c1.persons === c0.persons, "no duplicate user or person was created by the phone-only provisioning", { before: c0, after: c1 });
      }
      const superPhoneOnly = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Phone-only Org Admin ${nonce}`, phone: F.oaPhoneOnly.phone, property_id: G, role_key: "property_admin" } });
      const roleAfter = (await one("select platform_role from users where id=$1", [F.oaPhoneOnly.id])).platform_role;
      if (WITNESS) {
        check(superPhoneOnly.status === 500, "WITNESS: the super-admin invite door fails the same way for a phone-only account", { status: superPhoneOnly.status, error: superPhoneOnly.body && String(superPhoneOnly.body.error).slice(0, 90) });
      } else {
        check(superPhoneOnly.status === 201 && superPhoneOnly.body.user.id === F.oaPhoneOnly.id, "the super-admin invite door attaches a phone-only existing account to the property", { status: superPhoneOnly.status });
        check(roleAfter === roleBefore, "an omitted platform_role leaves the existing account's platform role unchanged", { before: roleBefore, after: roleAfter });
      }
      // Email-bearing org admin: the door that works on the baseline.
      const emailRoleBefore = (await one("select platform_role from users where id=$1", [F.oa.id])).platform_role;
      const c2 = await counts();
      const emailDoor = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Org Admin ${nonce}`, phone: F.oa.phone, email: F.oa.email, property_id: G, role_key: "property_admin", platform_role: "org_admin" } });
      const c3 = await counts();
      need(emailDoor.status === 201 && emailDoor.body.user.id === F.oa.id, "the super-admin invite door attaches the email-bearing org admin to the property when the exact email and platform role are supplied", { status: emailDoor.status, body: emailDoor.body });
      check(c3.users === c2.users && c3.persons === c2.persons && (await one("select platform_role from users where id=$1", [F.oa.id])).platform_role === emailRoleBefore, "no duplicate account and the platform role is preserved", { before: c2, after: c3 });
      const demoteProbe = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Org Admin ${nonce}`, phone: F.oa.phone, email: F.oa.email, property_id: G, role_key: "property_admin" } });
      const roleAfterOmit = (await one("select platform_role from users where id=$1", [F.oa.id])).platform_role;
      if (WITNESS) {
        check(demoteProbe.status === 201 && roleAfterOmit === "member", "WITNESS: repeating the super-admin door without platform_role resets an org admin to member", { status: demoteProbe.status, before: emailRoleBefore, after: roleAfterOmit });
        await q("update users set platform_role=$2 where id=$1", [F.oa.id, emailRoleBefore]);
        observe("fixture restore after the witnessed reset so the rest of the rehearsal keeps an org admin");
      } else {
        check(demoteProbe.status === 201 && roleAfterOmit === emailRoleBefore, "repeating the super-admin door without platform_role keeps the org admin's platform role", { status: demoteProbe.status, before: emailRoleBefore, after: roleAfterOmit });
      }
      const openG = await api("POST", "/operator/properties/select", { token: F.oaTok, body: { property_id: G } });
      need(openG.status === 200 && openG.body.session_token, "with the first assignment in place the org admin opens the property through the selector", { status: openG.status });
      F.oaGTok = openG.body.session_token;
      observe("the first-property access order on this baseline: adoption → an admin provisioning door creates the first team assignment (email-bearing account on the unfixed baseline) → property selector → governed invites from that session");
    });

    await section("governed-invite", async () => {
      need(F.oaGTok, "org admin session at the property");
      const unconfirmed = await api("POST", `/properties/${G}/team-invites`, { token: F.oaGTok, body: { invited_name: "Mike", phone_number: F.mikePhone, role_key: "leasing_agent", scope_type: "property" } });
      const person = (await one("select person_id from users where id=$1", [F.mike.id])).person_id;
      check(unconfirmed.status === 409 && unconfirmed.body.reason === "existing_person_confirmation_required" && (unconfirmed.body.candidates || []).some((c) => c.id === person), "inviting an existing phone requires confirming the existing person; the candidate is the same person", { status: unconfirmed.status, reason: unconfirmed.body && unconfirmed.body.reason, candidates: (unconfirmed.body && unconfirmed.body.candidates || []).length });
      const wrongPerson = await api("POST", `/properties/${G}/team-invites`, { token: F.oaGTok, body: { invited_name: "Mike", phone_number: F.mikePhone, role_key: "leasing_agent", scope_type: "property", person_id: F.oa.person_id } });
      check(wrongPerson.status === 409 && wrongPerson.body.reason === "person_phone_mismatch", "confirming a person who does not carry that phone is refused", { status: wrongPerson.status, reason: wrongPerson.body && wrongPerson.body.reason });
      const c0 = await counts();
      const done = await inviteAndAccept({ token: F.oaGTok, propertyId: G, phone: F.mikePhone, name: `Mike (rehearsal) ${nonce}`, role_key: "leasing_agent", person_id: person });
      F.firstJoinToken = done.joinToken;
      need(done.invite.status === 200 && done.invite.body.person_id === person, "the governed invite is created for the confirmed existing person", { status: done.invite.status, delivery: done.delivery, person_matches: done.invite.body && done.invite.body.person_id === person });
      check(done.delivery === "sms_sent", "the invite code is delivered through the fake transport", { delivery: done.delivery });
      need(done.verify.status === 200 && done.verify.body.session_token, "the existing account accepts by OTP and receives a session at the new property", { status: done.verify.status, body: done.verify.body && { flow: done.verify.body.flow, error: done.verify.body.error, receipt: done.verify.body.receipt } });
      F.mike.gTok = done.verify.body.session_token;
      check(done.verify.body.user.id === F.mike.id && done.verify.body.person_id === person && (done.verify.body.allowed_modules || []).includes("leasing"), "acceptance names the same user and person and grants the leasing module", { user_same: done.verify.body.user.id === F.mike.id, person_same: done.verify.body.person_id === person, modules: done.verify.body.allowed_modules });
      const c1 = await counts();
      check(c1.users === c0.users && c1.persons === c0.persons, "no duplicate user or person was created by acceptance", { before: c0, after: c1 });
    });

    await section("identity-at-property", async () => {
      need(F.mike.gTok, "session at the property");
      const st = await mikeState(G);
      check(st.identity.state === "resolved", "resolveStaffIdentity resolves the account as staff at the new property", { state: st.identity.state, basis: st.identity.basis });
      check(st.contexts.some((c) => c.property_id === G) && st.contexts.some((c) => c.property_id === F.s1.id), "the person now holds staff contexts at both properties", { contexts: st.contexts.length });
      check(st.assignments.some((a) => a.property_id === G && a.is_active) && st.assignments.some((a) => a.property_id === F.s1.id && a.is_active), "person-level assignments exist at both properties", { assignments: st.assignments.map((a) => a.role) });
      check(st.teams.filter((t) => t.active).length === 2 && st.teams.find((t) => t.property_id === G).allowed_modules.includes("leasing") && st.teams.find((t) => t.property_id === F.s1.id).active, "the Skyline team assignment is untouched and the new one carries leasing", { teams: st.teams.map((t) => ({ p: t.property_id === G ? "greenery" : "skyline", modules: t.allowed_modules, active: t.active })) });
      check(st.user.platform_role === "member" && st.user.account_kind === "human_staff" && st.user.email === null, "platform role, classification and phone-only shape are preserved", { platform_role: st.user.platform_role, account_kind: st.user.account_kind, email: st.user.email });
      observe("users.organization_id is never written by the governed invite path; org scope for staff comes from property_team_assignments through the property", { organization_id: st.user.organization_id });
      const access = await api("GET", `/properties/${G}/my-access`, { token: F.mike.gTok });
      check(access.status === 200 && (access.body.allowed_modules || []).includes("leasing") && access.body.landing_module === "leasing", "the property session reports leasing access", { status: access.status, modules: access.body && access.body.allowed_modules, landing: access.body && access.body.landing_module });
      const leasing = await api("GET", "/operator/leasing/leaseable-units", { token: F.mike.gTok });
      check(leasing.status === 200, "a leasing-module route answers the new property session", { status: leasing.status });
      const mgmt = await api("GET", "/operator/leasing/lease-configuration", { token: F.mike.gTok });
      observe("a management-gated read reports the leasing agent's ceiling", { status: mgmt.status, can_configure: mgmt.body && mgmt.body.configuration && mgmt.body.configuration.can_configure });
      const skylineStill = await api("GET", `/properties/${F.s1.id}/my-access`, { token: F.mike.s1Tok });
      check(skylineStill.status === 200 && (skylineStill.body.allowed_modules || []).includes("leasing"), "the original Skyline session and access still work", { status: skylineStill.status });
      const crossInvite = await api("POST", `/properties/${F.s1.id}/team-invites`, { token: F.mike.gTok, body: { invited_name: "x", phone_number: num(31), role_key: "leasing_agent" } });
      check(crossInvite.status === 403, "the new property session cannot invite at another property", { status: crossInvite.status, reason: crossInvite.body && crossInvite.body.reason });
      const switchBack = await api("POST", "/operator/properties/select", { token: F.mike.gTok, body: { property_id: F.s1.id } });
      check(switchBack.status === 200 && !!switchBack.body.session_token, "the account can switch between its two properties (the selector revokes the prior session and issues a new one)", { status: switchBack.status });
      F.mike.gTok = (await api("POST", "/operator/properties/select", { token: switchBack.body.session_token, body: { property_id: G } })).body.session_token;
    });

    await section("repeat", async () => {
      need(F.mike.gTok, "session at the property");
      const person = (await one("select person_id from users where id=$1", [F.mike.id])).person_id;
      const c0 = await counts();
      const again = await inviteAndAccept({ token: F.oaGTok, propertyId: G, phone: F.mikePhone, name: `Mike (rehearsal) ${nonce}`, role_key: "leasing_agent", person_id: person });
      check(again.invite.status === 200 && again.verify.status === 200, "a repeated invitation and acceptance succeed without error", { invite: again.invite.status, verify: again.verify.status });
      const prior = await one("select status from team_invites where token=$1", [F.firstJoinToken]);
      observe("the earlier invite's status after a repeat", prior);
      const st = await mikeState(G);
      const c1 = await counts();
      check(c1.users === c0.users && c1.persons === c0.persons && st.teams.filter((t) => t.property_id === G && t.active).length === 1 && st.assignments.filter((a) => a.property_id === G && a.is_active).length === 1 && st.contexts.filter((c) => c.property_id === G).length === 1 && st.identity.state === "resolved",
        "repetition is idempotent: one team assignment, one person assignment, one context, no duplicate user or person, still resolved", { before: c0, after: c1 });
      const replayStart = await api("POST", "/auth/sms/start", { body: { token: again.joinToken } });
      observe("starting the OTP again on an accepted invite", { status: replayStart.status, receipt: replayStart.body && replayStart.body.receipt, flow: replayStart.body && replayStart.body.flow });
      const staleStart = await api("POST", "/auth/sms/start", { body: { token: F.firstJoinToken } });
      observe("starting the OTP on the superseded first invite", { status: staleStart.status, receipt: staleStart.body && staleStart.body.receipt });
      const otherRole = await inviteAndAccept({ token: F.oaGTok, propertyId: G, phone: F.mikePhone, name: `Mike (rehearsal) ${nonce}`, role_key: "property_manager", person_id: person });
      const st2 = await mikeState(G);
      const team = st2.teams.find((t) => t.property_id === G);
      observe("a later invite with a different role replaces the team assignment's role and modules in place", { invite: otherRole.invite.status, verify: otherRole.verify.status, role_key: team && team.role_key, modules: team && team.allowed_modules, person_assignments_at_property: st2.assignments.filter((a) => a.property_id === G && a.is_active).map((a) => a.role) });
    });

    await section("no-line-delivery", async () => {
      // What acceptance looks like at a property whose line cannot send.
      const noLine = await one("insert into properties (name,address,organization_id) values ($1,'3 Silent St',$2) returning id", [`Silent property ${nonce}`, F.org.id]);
      const prov = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Org Admin ${nonce}`, phone: F.oa.phone, email: F.oa.email, property_id: noLine.id, role_key: "property_admin", platform_role: "org_admin" } });
      const open = await api("POST", "/operator/properties/select", { token: F.oaTok, body: { property_id: noLine.id } });
      if (prov.status === 201 && open.status === 200) {
        const person = (await one("select person_id from users where id=$1", [F.mike.id])).person_id;
        const r = await inviteAndAccept({ token: open.body.session_token, propertyId: noLine.id, phone: F.mikePhone, name: `Mike (rehearsal) ${nonce}`, role_key: "leasing_agent", person_id: person });
        observe("without a property text line the invite is link-only; the start response carries dev_code on this server, so acceptance completes without any message leaving", { delivery: r.delivery, start_keys: r.start && r.start.body ? Object.keys(r.start.body) : null, verify: r.verify && r.verify.status });
      }
    });
  } finally {
    await pool.end();
  }
  const summary = { mode: WITNESS ? "baseline_witness" : "successor", passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length };
  if (process.env.PROOF_OUTPUT_DIR) {
    fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `greenery_staff_onboarding.${process.env.PROOF_EVIDENCE_LABEL || summary.mode}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  }
  console.log(`\ngreenery staff onboarding (${summary.mode}): ${summary.passed} passed, ${failed} failed, ${summary.observations} observations`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
