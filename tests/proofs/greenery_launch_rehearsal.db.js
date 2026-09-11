"use strict";
// Class 3 · Greenery launch-readiness rehearsal.
//
// Owned nonce-verified database and owned HTTP server (E2E_API_BASE), fake SMS
// transport (E2E_SMS_LOG). Nothing here touches production, a provider, or a
// real workbook. It reproduces the SHAPE the September 11 production read
// found for the existing Greenery property — imported inventory, no
// organization, no active staff assignments, leasing basis unknown, one legacy
// activation, three aliases, zero leases — with synthetic rows, then walks the
// smallest setup sequence the existing services allow, recording at each
// door what is already established, what connects, and what needs an owner
// decision. It never creates a replacement property: the rehearsal property
// keeps its identity from the first row to the last.
//
// PROOF_GREENERY_ID must be the property id the owned server was booted with
// in its per-property allowlists, exactly as the real id would be on Render.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { Pool } = require("pg");
const JSZip = require("jszip");
const staffSessions = require("../../src/identity/staff_session_service");
const staffIdentity = require("../../src/identity/staff_identity_resolver");
const hierarchy = require("../../src/identity/property_hierarchy_service");
const deals = require("../../src/onboarding/deal_service");
const lines = require("../../src/comms/communication_lines");
const capability = require("../../src/identity/capability");
const { availabilityRead } = require("../../src/surfaces/availability_read");
const { occupancyByBasis } = require("../../src/leasing/leasing_occupancy_facts");

const BASE = process.env.E2E_API_BASE;
const SMS_LOG = process.env.E2E_SMS_LOG;
const GREENERY_ID = process.env.PROOF_GREENERY_ID;
assert.ok(BASE, "E2E_API_BASE (owned HTTP server) is required");
assert.ok(SMS_LOG, "E2E_SMS_LOG (fake transport log) is required");
assert.ok(/^[0-9a-f-]{36}$/.test(GREENERY_ID || ""), "PROOF_GREENERY_ID (the allowlisted rehearsal property id) is required");

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
const ymd = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
async function api(method, route, { token, key = false, body, form, query } = {}) {
  const headers = {};
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const url = BASE + route + (query ? "?" + new URLSearchParams(query).toString() : "");
  const r = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => null);
  return { status: r.status, body: data };
}
async function inboundSms({ from, to, body, sid }) {
  const r = await fetch(BASE + "/communications/inbound-sms", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ MessageSid: sid, From: from, To: to, Body: body }).toString() });
  return { status: r.status, text: await r.text() };
}
function sms() {
  if (!fs.existsSync(SMS_LOG)) return [];
  return fs.readFileSync(SMS_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
async function waitSms(from, pred) {
  for (let i = 0; i < 80; i++) { const m = sms().slice(from).find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); }
  return null;
}
async function fixtureDocx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const paragraph = "REHEARSAL LEASE FORM. Synthetic governing instrument text for the owned rehearsal database only. This is not the Greenery lease. ".repeat(6);
  const paragraphs = Array.from({ length: 6 }, () => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`).join("");
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  // Every phone number is derived from the run nonce so reruns in one owned
  // database never collide on the global active-line or phone uniqueness.
  const numBase = 2000000 + (parseInt(nonce.slice(0, 6), 16) % 7000000);
  const num = (k) => "+1215" + String(numBase + k);
  const F = {};
  const session = async (userId, propertyId) => (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
  const mikeTok = async () => { if (!F.mikeTok) F.mikeTok = await session(F.mike.id, F.g.id); return F.mikeTok; };
  async function user(name, { platform_role = "member", organization_id = F.org.id, phone = null, bridge = true, email = null } = {}) {
    const person = bridge ? await one("insert into persons (name,phone,primary_phone_e164,source) values ($1,$2,$2,'rehearsal') returning id", [name, phone]) : null;
    return one(`insert into users (name,phone,email,role,auth_provider,platform_role,organization_id,is_active,status,account_kind,person_id)
      values ($1,$2,$6,'property_manager','phone_otp',$3,$4,true,'active','human_staff',$5) returning id, person_id, email`, [name, phone, platform_role, organization_id, person && person.id, email]);
  }
  async function assign(u, propertyId, { role_key = "property_manager", modules = "{management,leasing,maintenance}", manage = false, personRole = "property_manager" } = {}) {
    await q(`insert into property_team_assignments (property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
      values ($1,$2,$3,$3,'property',$4,'{management}',$5,true)`, [propertyId, u.id, role_key, modules, manage]);
    if (u.person_id) await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,$3,$4)", [u.person_id, propertyId, personRole, JSON.stringify({ source: "rehearsal" })]);
  }
  const marketing = async (propertyId) => {
    const rows = (await availabilityRead(pool, { property_id: propertyId, as_of: plusDays(0) })).rows;
    const by = {};
    for (const r of rows) by[r.marketing_state] = (by[r.marketing_state] || 0) + 1;
    return { rows, by };
  };
  try {
    // ── fixture: the shape the production read found ─────────────────
    await section("shape-as-found", async () => {
      F.org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Rehearsal Org ${nonce}`, `rehearsal-org-${nonce}`]);
      F.s1 = await one(`insert into properties (name,display_name,address,organization_id,leasing_basis) values ($1,'Skyline (rehearsal)','1417 N 15th (rehearsal)',$2,'bed') returning id`, [`Skyline rehearsal ${nonce}`, F.org.id]);
      await q(`insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status)
        values ($2,'property_facing',$1,'external','residents_and_prospects',true,true,'proactive','active')`, [F.s1.id, num(1)]);
      F.sa = await user(`Platform Admin ${nonce}`, { platform_role: "super_admin", organization_id: null, phone: num(2) });
      await assign(F.sa, F.s1.id, { manage: true });
      F.oa = await user(`Org Admin ${nonce}`, { platform_role: "org_admin", phone: num(3) });
      await assign(F.oa, F.s1.id, { manage: true });
      F.mike = await user(`Mike (rehearsal) ${nonce}`, { phone: num(4), email: `mike-${nonce}@example.test` });
      await assign(F.mike, F.s1.id, { role_key: "property_manager", personRole: "property_manager" });
      // The Greenery-shaped property: durable id fixed by the runner, as the
      // real id is fixed in production.
      F.g = await one(`insert into properties (id,name,display_name,address,organization_id,leasing_basis,canonical_key,canonical_key_absent_reason)
        values ($1,'Greenery','The Greenery','1325 N 15th Street, Philadelphia',null,'unknown',null,'predates_canonical_identity_requirement') returning id, organization_id, leasing_basis`, [GREENERY_ID]);
      for (let i = 0; i < 171; i++) {
        const number = String(101 + i + Math.floor(i / 20) * 80);
        await q("insert into units (property_id,unit_number) values ($1,$2)", [F.g.id, number]);
      }
      for (const alias of ["greenery", "1325 n 15th", "the greenery"]) {
        await q("insert into property_aliases (property_id,source_system,alias_type,alias_value,confidence,note) values ($1,'rent_roll','address_string',$2,'resolved','rehearsal alias')", [F.g.id, `${alias} ${nonce}`]);
      }
      F.legacyActivation = await one("insert into activations (deal_id,property_id,source_label,status) values (null,$1,'legacy rent roll (rehearsal)','open') returning id", [F.g.id]);
      const counts = await one(`select (select count(*)::int from units where property_id=$1) units,
        (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1) spaces,
        (select count(*)::int from leases where property_id=$1) leases,
        (select count(*)::int from property_team_assignments where property_id=$1 and active) team,
        (select count(*)::int from property_aliases where property_id=$1) aliases,
        (select count(*)::int from activations where property_id=$1) activations`, [F.g.id]);
      check(counts.units === 171 && counts.spaces === 171 && counts.leases === 0 && counts.team === 0 && counts.aliases === 3 && counts.activations === 1 && F.g.organization_id === null && F.g.leasing_basis === "unknown",
        "the rehearsal property reproduces the production read's shape (raw counts, no organization, unknown basis)", counts);
    });
    need(F.g, "rehearsal property exists");
    const G = F.g.id;

    // ── what the raw counts do not establish ─────────────────────────
    await section("as-found-reads", async () => {
      const m = await marketing(G);
      check(m.rows.length === 171 && m.by.occupancy_unknown === 171, "canonical availability holds every one of the 171 placeholder positions as occupancy not established: raw spaces are not rentable inventory", m.by);
      const basis = await occupancyByBasis(pool, G).catch((e) => ({ error: e.message }));
      check(basis && basis.available === false || (basis && basis.reason), "occupancy by basis is honestly unavailable while the basis is unknown", { reason: basis && (basis.reason || basis.error), available: basis && basis.available });
      let mikeSession = null;
      try { mikeSession = await session(F.mike.id, G); } catch (e) { mikeSession = { refused: e.message || String(e) }; }
      check(mikeSession && mikeSession.refused, "Mike cannot hold a session at Greenery: no active assignment there", mikeSession);
      let deal = null;
      try { deal = await deals.createDeal(pool, { user_id: F.mike.id, deal_name: "Greenery", creation_source: "deal_setup_console" }); } catch (e) { deal = { refused: e.reason || e.code || e.message }; }
      check(deal && deal.refused === "insufficient_platform_role", "a member account cannot create the deal container; that is an organization-level action", deal);
      let adopt = null;
      try { adopt = await hierarchy.assignPropertyToOrganization(pool, { actor: { user_id: F.oa.id }, property_id: G, organization_id: F.org.id }); } catch (e) { adopt = { refused: e.refusalReason || e.reason || e.message }; }
      check(adopt && adopt.refused === "adoption_requires_platform_repair_authority", "an organization admin cannot adopt the unowned property: adoption is platform repair", adopt);
      // Can an org admin pull the unowned property into their deal without adopting it?
      const probeDeal = await deals.createDeal(pool, { user_id: F.oa.id, deal_name: `Probe ${nonce}`, creation_source: "deal_setup_console" });
      let added = null;
      try { added = await deals.addProperty(pool, { user_id: F.oa.id, deal_intake_id: probeDeal.id, property_id: G }); } catch (e) { added = { refused: e.reason || e.message }; }
      observe("finding candidate: an org admin can add the still-unowned property to their own deal before adoption (deal membership does not require ownership)", { added: added && !added.refused ? "allowed" : added });
      if (added && !added.refused) await deals.releaseProperty(pool, { user_id: F.oa.id, deal_intake_id: probeDeal.id, property_id: G, reason: "rehearsal probe released" });
      const legacy = await one("select status, deal_id from activations where id=$1", [F.legacyActivation.id]);
      observe("the legacy activation carries no deal and stays open; Deal Setup will not see or close it", legacy);
    });

    // ── 1 · organization: adoption through the governed repair door ──
    await section("adopt", async () => {
      F.saTok = await session(F.sa.id, F.s1.id);
      const r = await api("POST", `/admin/organizations/${F.org.id}/properties`, { token: F.saTok, body: { property_id: G, reason: "rehearsal: place The Greenery with its owner" } });
      need(r.status === 200 && r.body.ok && r.body.organization_id === F.org.id, "super admin adoption places the property with the organization without changing its id", { status: r.status, body: r.body });
      const again = await api("POST", `/admin/organizations/${F.org.id}/properties`, { token: F.saTok, body: { property_id: G } });
      check(again.status === 200 && again.body.already === true, "adoption is idempotent");
      const other = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Other Org ${nonce}`, `other-org-${nonce}`]);
      const move = await api("POST", `/admin/organizations/${other.id}/properties`, { token: F.saTok, body: { property_id: G } });
      check(move.status === 409, "an adopted property cannot be moved to another client (reparenting refused)", { status: move.status, reason: move.body && move.body.reason });
      const row = await one("select organization_id from properties where id=$1", [G]);
      check(row.organization_id === F.org.id, "the durable property row now carries the organization");
    });

    // ── 2 · staff: Mike's assignment and identity at Greenery ────────
    await section("staff", async () => {
      const before = await one("select id, platform_role, organization_id from users where id=$1", [F.mike.id]);
      // Two provisioning shapes the door cannot complete on this schema.
      const phoneOnly = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Phone Only ${nonce}`, phone: num(6), property_id: G, role_key: "leasing_agent", platform_role: "member" } });
      observe("finding: a phone-only invite through the admin door fails with 500 — its ON CONFLICT (phone) has no matching unique constraint (users has a normalized partial index)", { status: phoneOnly.status, error: phoneOnly.body && String(phoneOnly.body.error).slice(0, 90) });
      const other = await user(`Other Staff ${nonce}`, { phone: num(7), email: `other-${nonce}@example.test` });
      const wrongEmail = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Other Staff ${nonce}`, phone: num(7), email: `different-${nonce}@example.test`, property_id: G, role_key: "leasing_agent", platform_role: "member" } });
      observe("finding: an invite naming an existing phone with a different email fails with 500 — the email upsert tries to insert a second user with the same phone", { status: wrongEmail.status, error: wrongEmail.body && String(wrongEmail.body.error).slice(0, 90), user_existed: !!other.id });
      const inv = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Mike (rehearsal) ${nonce}`, phone: num(4), email: F.mike.email, property_id: G, role_key: "property_admin", platform_role: before.platform_role } });
      need(inv.status === 201 && inv.body.user && inv.body.user.id === F.mike.id, "the admin invite door attaches the existing Mike account (matched by his exact email) to Greenery without creating a second user", { status: inv.status, body: inv.body });
      const asg = await one("select role_key, can_manage_roles, allowed_modules from property_team_assignments where property_id=$1 and user_id=$2 and active", [G, F.mike.id]);
      check(asg && asg.can_manage_roles === true && asg.allowed_modules.includes("leasing") && asg.allowed_modules.includes("management"), "Mike holds an active Greenery assignment with leasing and management", asg);
      const after = await one("select platform_role, organization_id from users where id=$1", [F.mike.id]);
      check(after.platform_role === before.platform_role && after.organization_id === before.organization_id, "passing the current platform role keeps Mike's account unchanged", after);
      // Hazard: the same door with platform_role omitted rewrites the account.
      const oaBefore = await one("select platform_role from users where id=$1", [F.oa.id]);
      await q("update users set email=$2 where id=$1", [F.oa.id, `oa-${nonce}@example.test`]);
      const demote = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Org Admin ${nonce}`, phone: num(3), email: `oa-${nonce}@example.test`, property_id: G, role_key: "property_admin" } });
      const oaAfter = await one("select platform_role from users where id=$1", [F.oa.id]);
      observe("finding: the admin invite door upserts by phone and rewrites platform_role to its default when omitted (org_admin becomes member)", { status: demote.status, before: oaBefore.platform_role, after: oaAfter.platform_role });
      await q("update users set platform_role=$2 where id=$1", [F.oa.id, oaBefore.platform_role]);
      const identity = await staffIdentity.resolveStaffIdentity(pool, { user_id: F.mike.id, property_id: G });
      observe("finding: the admin invite writes the team assignment but no person-level assignment, so Mike's staff identity at Greenery is not resolved for tour hosting or offer authorship", { state: identity.state, basis: identity.basis });
      // The governed path writes both: Mike (can_manage_roles at Greenery)
      // invites a teammate, who accepts by OTP.
      F.mikeTok = await session(F.mike.id, G);
      const agentPhone = num(5);
      const person = await one("insert into persons (name,phone,primary_phone_e164,lifecycle_status,source) values ('Greenery Agent (rehearsal)',$1,$1,'lead','rehearsal') returning id", [agentPhone]);
      const noLine = await api("POST", `/properties/${G}/team-invites`, { token: F.mikeTok, body: { invited_name: "Greenery Agent (rehearsal)", phone_number: agentPhone, role_key: "leasing_agent", scope_type: "property", person_id: person.id } });
      observe("before the property has a text line, a governed invite is created link-only and its code cannot be texted", { status: noLine.status, delivery: noLine.body && noLine.body.delivery });
      const lineSet = await api("POST", `/properties/${G}/sms-number`, { key: true, body: { sms_number: num(8) } });
      need(lineSet.status < 400, "the Greenery text line is recorded through the operator route (this projects properties.sms_number; the column itself refuses direct writes)", { status: lineSet.status, body: lineSet.body });
      const newLine = await one("select outbound_enabled, outbound_policy from communication_lines where property_id=$1 and line_type='property_facing' and status='active'", [G]);
      const disabledLine = await api("POST", `/properties/${G}/team-invites`, { token: F.mikeTok, body: { invited_name: "Greenery Agent (rehearsal)", phone_number: agentPhone, role_key: "leasing_agent", scope_type: "property", person_id: person.id } });
      observe("finding: the operator route creates the property line with outbound disabled and no door enables it, so the invite text fails (sms_failed) until the line's outbound policy is changed outside the product", { line: newLine, delivery: disabledLine.body && disabledLine.body.delivery });
      // No product door exists for this write either. Repair-class SQL, labelled.
      await q("update communication_lines set outbound_enabled=true, outbound_policy='proactive' where property_id=$1 and line_type='property_facing' and status='active'", [G]);
      observe("repair-class write used to continue: outbound enabled on the Greenery line");
      const smsFrom = sms().length;
      const invite = await api("POST", `/properties/${G}/team-invites`, { token: F.mikeTok, body: { invited_name: "Greenery Agent (rehearsal)", phone_number: agentPhone, role_key: "leasing_agent", scope_type: "property", person_id: person.id } });
      need(invite.status < 400 && invite.body.link, "Mike's Greenery session can invite a leasing agent through the governed door", { status: invite.status, body: invite.body });
      check(invite.body.delivery === "sms_sent", "with an outbound-enabled line the invite is texted through the fake transport", { delivery: invite.body.delivery });
      const token = String(invite.body.link).split("/join/")[1];
      const start = await api("POST", "/auth/sms/start", { body: { token } });
      need(start.status < 400, "invite OTP start", { status: start.status, body: start.body });
      const codeText = await waitSms(smsFrom, (m) => m.to === agentPhone && /access code is \d{6}/.test(m.body || ""));
      need(codeText, "the OTP reached the fake transport only");
      const code = codeText.body.match(/access code is (\d{6})/)[1];
      const verify = await api("POST", "/auth/sms/verify", { body: { token, code } });
      need(verify.status < 400 && verify.body.session_token, "the agent accepts and receives a Greenery session", { status: verify.status, flow: verify.body && verify.body.flow });
      const agentUser = await one("select u.id, u.person_id, u.account_kind from users u where u.person_id=$1", [person.id]);
      const agentIdentity = agentUser ? await staffIdentity.resolveStaffIdentity(pool, { user_id: agentUser.id, property_id: G }) : { state: "no_user" };
      check(agentIdentity.state === "resolved", "the governed invite leaves the new teammate with a resolved staff identity at Greenery (bridge, human_staff, person assignment, team authority)", { state: agentIdentity.state, basis: agentIdentity.basis });
      F.agent = { id: agentUser && agentUser.id, tok: verify.body.session_token };
      // Mike's own login lands on one property and can switch.
      const smsFrom2 = sms().length;
      const login = await api("POST", "/auth/sms/start", { body: { phone_number: num(4) } });
      need(login.status < 400, "Mike's plain phone login starts", { status: login.status, body: login.body });
      const loginCode = await waitSms(smsFrom2, (m) => m.to === num(4) && /access code is \d{6}/.test(m.body || ""));
      need(loginCode, "Mike's login code reached the fake transport only");
      const loginToken = login.body.token || login.body.invite_token || (login.body.link && String(login.body.link).split("/join/")[1]) || null;
      const loginVerify = await api("POST", "/auth/sms/verify", { body: { token: loginToken, phone_number: num(4), code: loginCode.body.match(/access code is (\d{6})/)[1] } });
      need(loginVerify.status < 400 && loginVerify.body.session_token, "Mike's login completes", { status: loginVerify.status, body: loginVerify.body });
      observe("with two assignments, login lands on one property chosen by sms-ready then role-managing order; there is no picker at login", { landed_on: loginVerify.body.property && loginVerify.body.property.name });
      const landed = loginVerify.body.property && loginVerify.body.property.id;
      const target = landed === G ? F.s1.id : G;
      const sw = await api("POST", "/operator/properties/select", { token: loginVerify.body.session_token, body: { property_id: target } });
      check(sw.status === 200 && !!(sw.body.session_token || sw.body.session) && !sw.body.unchanged, "Mike can switch between his two properties through the property selector after login", { status: sw.status, switched_to: target === G ? "Greenery" : "Skyline (rehearsal)", keys: Object.keys(sw.body || {}) });
    });

    // ── 3 · deal container ───────────────────────────────────────────
    await section("deal", async () => {
      F.oaTok = await session(F.oa.id, F.s1.id);
      const created = await api("POST", "/deal-setup/deals", { token: F.oaTok, body: { deal_name: "The Greenery", onboarding_type: "existing_asset" } });
      need(created.status === 201 && created.body.deal && created.body.deal.id, "the organization admin creates the deal container", { status: created.status, body: created.body });
      F.deal = created.body.deal.id;
      const added = await api("POST", `/deal-setup/deals/${F.deal}/properties`, { token: F.oaTok, body: { property_id: G } });
      check(added.status === 201 && added.body.already_member === false, "the existing Greenery property joins the deal (no replacement property)", { status: added.status, receipt: added.body && added.body.receipt });
      const mikeCreate = await api("POST", "/deal-setup/deals", { token: await mikeTok(), body: { deal_name: "Greenery by Mike" } });
      check(mikeCreate.status === 403, "Mike (member) still cannot create deals; he operates the setup inside one", { status: mikeCreate.status, reason: mikeCreate.body && mikeCreate.body.reason });
    });

    // ── 4 · basis and opening position from a retained source ────────
    await section("opening-position", async () => {
      need(F.deal, "deal exists");
      await mikeTok();
      const units = (await q("select id, unit_number from units where property_id=$1 order by unit_number limit 20", [G])).rows;
      const AS_OF = plusDays(-10);
      let csv = "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n";
      let occupied = 0, vacant = 0;
      units.forEach((u, i) => {
        for (const bed of ["Bed A", "Bed B"]) {
          const occ = (i + (bed === "Bed A" ? 0 : 1)) % 3 !== 2;
          if (occ) { occupied++; csv += `${u.unit_number},${bed},Rehearsal Resident ${u.unit_number}${bed.slice(-1)},1100,1050,${plusDays(-200)},${plusDays(160)}\n`; }
          else { vacant++; csv += `${u.unit_number},${bed},VACANT,1100,,,\n`; }
        }
      });
      F.expected = { occupied, vacant, units: units.length };
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "text/csv" }), "greenery-rehearsal-rent-roll.csv");
      form.append("source_as_of_date", AS_OF);
      const up = await api("POST", `/deal-setup/deals/${F.deal}/properties/${G}/source`, { token: F.mikeTok, form });
      need(up.status === 201 && up.body.artifact, "Mike uploads the rent roll; Spine retains the bytes", { status: up.status, body: up.body });
      const opened = await api("POST", `/deal-setup/deals/${F.deal}/properties/${G}/activation`, { token: F.mikeTok, body: {} });
      need(opened.status === 201 && opened.body.activation, "a governed setup opens for the property inside the deal", { status: opened.status });
      F.activation = opened.body.activation.id;
      const read = await api("POST", `/deal-setup/activations/${F.activation}/read-source`, { token: F.mikeTok, body: { source_artifact_id: up.body.artifact.id, source_as_of_date: AS_OF, leasing_basis: "bed" } });
      need(read.status === 201, "the retained source is read with the leasing basis stated as bed", { status: read.status, body: read.body && (read.body.error || read.body.receipt) });
      const basis = await one("select leasing_basis from properties where id=$1", [G]);
      check(basis.leasing_basis === "bed", "the leasing basis is now recorded on the property", basis);
      const shaped = await one(`select count(distinct s.unit_id)::int as units_with_beds, count(*)::int as beds from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.space_label in ('Bed A','Bed B')`, [G]);
      const placeholders = await one(`select count(*)::int as n from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.space_label='(whole unit)'`, [G]);
      check(shaped.units_with_beds === units.length && shaped.beds === units.length * 2, "staging materialised the named beds on the sourced units", shaped);
      observe("the untouched units keep their placeholder position and remain outside the source", { placeholders_remaining: placeholders.n, sourced_units: units.length });
      const review = await api("GET", `/deal-setup/activations/${F.activation}`, { token: F.mikeTok });
      const staged = (review.body.proposals || []).filter((p) => p.status === "staged");
      check(staged.length === occupied + vacant, "one proposal per source row awaits a human confirmation", { staged: staged.length, rows: occupied + vacant });
      let confirmed = 0, refused = [];
      for (const p of staged) {
        const c = await api("POST", `/deal-setup/proposals/${p.id}/confirm`, { token: F.mikeTok, body: {} });
        if (c.status === 200) confirmed++; else refused.push({ key: p.natural_key, status: c.status, error: c.body && c.body.error });
      }
      check(confirmed === staged.length, "every row confirms against the established beds", { confirmed, refused: refused.slice(0, 3) });
      const est = await api("POST", `/deal-setup/activations/${F.activation}/establish`, { token: F.mikeTok, body: {} });
      need(est.status === 201 && est.body.opening_position, "the opening lease and occupancy position is established", { status: est.status, receipt: est.body && est.body.receipt });
      const m0 = await marketing(G);
      const targets0 = await api("GET", "/operator/leasing/leaseable-units", { token: F.mikeTok });
      observe("finding: beds born by Deal Setup carry no governed use type, so every vacant bed reads use_not_configured and the selector offers nothing; no operator or service door sets spaces.use_type", { marketing: m0.by, eligible: (targets0.body.eligible_targets || []).length });
      // No product door exists for this write. Repair-class SQL, used only so
      // the rest of the rehearsal can be exercised; the checklist names it.
      const configured = await q(`update spaces s set use_type='residential' from units u where u.id=s.unit_id and u.property_id=$1 and s.use_type is null and s.space_label in ('Bed A','Bed B') returning s.id`, [G]);
      observe("repair-class write used to continue: use_type=residential on the sourced beds", { rows: configured.rowCount });
      const m = await marketing(G);
      check(m.by.marketable_now === vacant && m.by.occupied === occupied && m.by.occupancy_unknown === (171 - units.length), "with use configured, canonical availability distinguishes vacant beds, leased beds and the still-unestablished units", m.by);
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.mikeTok });
      check(targets.status === 200 && (targets.body.eligible_targets || []).length === vacant && targets.body.eligible_targets.every((t) => t.resolution_basis === "chosen_space"), "the application selector offers exactly the established vacant beds", { eligible: (targets.body.eligible_targets || []).length });
      const legacy = await one("select status from activations where id=$1", [F.legacyActivation.id]);
      observe("the legacy activation is untouched by the governed setup", legacy);
      const occ = await occupancyByBasis(pool, G);
      check(occ && occ.available !== false, "occupancy by basis reads once the basis and position exist", { available: occ && occ.available, keys: Object.keys(occ || {}).slice(0, 8) });
    });

    // ── 5 · lines and Mike's SMS context ─────────────────────────────
    await section("lines-and-sms", async () => {
      const line = await one("select e164, status, outbound_enabled, outbound_policy from communication_lines where property_id=$1 and line_type='property_facing' and status='active'", [G]);
      observe("the new property line is inbound-enabled but outbound stays disabled until a deliberate policy decision", line);
      let ops = await lines.readOperationsLineForOrganization(pool, F.org.id);
      if (!ops || !ops.line) {
        await lines.activateOperationsLine(pool, { organizationId: F.org.id, phoneNumber: num(9), actorUserId: F.sa.id });
        ops = await lines.readOperationsLineForOrganization(pool, F.org.id);
      }
      const opsNumber = ops && ops.line && ops.line.e164 || num(9);
      check(!!opsNumber, "the organization has one staff operations line", { e164: opsNumber });
      const ask = await inboundSms({ from: num(4), to: opsNumber, body: "What should I do today?", sid: `SM_REH_MANY_${nonce}` });
      need(ask.status === 200, "the operations webhook accepts Mike's text");
      await new Promise((r) => setTimeout(r, 400));
      const reply = await one(`select o.body, o.classification from comm_events i left join comm_events o on o.in_reply_to_comm_event_id=i.id where i.sms_sid=$1 order by o.id desc nulls last limit 1`, [`SM_REH_MANY_${nonce}`]);
      observe("with assignments at two properties, an unscoped staff text is answered with a property clarification, not a guess", { reply: reply && reply.body && reply.body.slice(0, 160), classification: reply && reply.classification });
      const named = await inboundSms({ from: num(4), to: opsNumber, body: "Greenery: what should I do today?", sid: `SM_REH_NAMED_${nonce}` });
      await new Promise((r) => setTimeout(r, 400));
      const reply2 = await one(`select o.body, o.classification, coalesce(o.property_id, i.property_id) as property_id from comm_events i left join comm_events o on o.in_reply_to_comm_event_id=i.id where i.sms_sid=$1 order by o.id desc nulls last limit 1`, [`SM_REH_NAMED_${nonce}`]);
      observe("naming the property in the text is answered without a clarification (scope taken from the message)", { status: named.status, clarified: /Which property/.test(String(reply2 && reply2.body)), reply: reply2 && reply2.body && reply2.body.slice(0, 120) });
    });

    // ── 6 · lease configuration and governing instrument ─────────────
    await section("lease-configuration", async () => {
      await mikeTok();
      const before = await api("GET", "/operator/leasing/lease-configuration", { token: F.mikeTok });
      const bc = before.body && before.body.configuration || {};
      observe("before setup the lease configuration read names what is missing", { status: before.status, missing_terms: bc.missing_terms, ready_to_generate: bc.ready_to_generate, ready_to_execute: bc.ready_to_execute, instrument: bc.instrument && (bc.instrument.state || bc.instrument.status || Object.keys(bc.instrument)) });
      const form = new FormData();
      form.append("file", new Blob([await fixtureDocx()], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "greenery-rehearsal-lease-form.docx");
      for (const [k, v] of Object.entries({ form_code: "REHEARSAL-FORM", form_version: "0-rehearsal", source_as_of_date: plusDays(-1), landlord_entity: "Greenery Owner LLC (rehearsal)", rent_payment_location: "the resident portal", application_fee: "50.00", amenity_fee: "300.00", utility_responsibility: "Resident pays all utilities.", late_fee: "75.00", notice_requirement: "60 days written notice.", insurance_note: "Renter's insurance recommended.", confirm_company_signer: "true" })) form.append(k, v);
      const cfg = await api("POST", "/operator/leasing/lease-configuration/template", { token: F.mikeTok, form });
      need(cfg.status === 201, "Mike (management module) retains a governing lease form and the lease terms, confirming himself as company signer", { status: cfg.status, body: cfg.body && (cfg.body.receipt || cfg.body.error) });
      const after = await api("GET", "/operator/leasing/lease-configuration", { token: F.mikeTok });
      const conf = after.body && after.body.configuration || {};
      check(after.status === 200 && (!conf.missing_terms || conf.missing_terms.length === 0) && conf.ready_to_generate === true && conf.ready_to_execute === true, "the lease configuration read reports nothing missing and both readiness flags true", { missing_terms: conf.missing_terms, ready_to_generate: conf.ready_to_generate, ready_to_execute: conf.ready_to_execute });
      const row = await one("select lease_config->'execution_authority'->'company_signer_user_ids' as signers, lease_config->'governing_instrument'->>'form_code' as form from properties where id=$1", [G]);
      check(Array.isArray(row.signers) && row.signers.includes(String(F.mike.id)) && row.form === "REHEARSAL-FORM", "the durable property carries the instrument lineage and the company signer", row);
    });

    // ── 7 · pricing, activation gates, knowledge ─────────────────────
    await section("pricing-gates-knowledge", async () => {
      const inventory = require("../../src/leasing/leasing_inventory")({ pool });
      const dated = await inventory.availableUnits({ property_id: G, requested_start: plusDays(30), requested_end: plusDays(394) }).catch((e) => ({ error: e.message }));
      const legacyShape = await one("select count(*) filter (where occupancy_status='vacant')::int as vacant_flag, count(*) filter (where bedrooms is not null)::int as with_bedrooms from units where property_id=$1", [G]);
      observe("finding: the prospect agent's dated inventory still keys on units.occupancy_status='vacant' and units.bedrooms, which Deal Setup never writes, so it reports nothing for the established vacant beds", { units: dated && Array.isArray(dated.units) ? dated.units.length : null, qualification: dated && dated.qualification, legacy_columns: legacyShape });
      const budget = await inventory.availableUnits({ property_id: G, requested_start: plusDays(30), requested_end: plusDays(394), lease_term_months: 12, max_rent: 2000, discovery_mode: "exact_spaces" }).catch((e) => ({ error: e.message }));
      observe("in exact-space discovery the canonical targets are found, and without a published pricing version every eligible bed is pricing-unresolved", { units: budget && Array.isArray(budget.units) ? budget.units.length : null, qualification: budget && (budget.qualification || budget.reason || budget.error), unresolved: budget && Array.isArray(budget.pricing_unresolved) ? budget.pricing_unresolved.length : null, first_reason: budget && Array.isArray(budget.pricing_unresolved) && budget.pricing_unresolved[0] ? budget.pricing_unresolved[0].reason : null });
      const intake = await api("POST", "/leasing/intake", { body: { intake_secret: "e2e-intake", property_id: G, name: `Greenery Prospect ${nonce}`, phone: num(10), email: `greenery-${nonce}@example.com`, source: "rehearsal", attempt_sms: false } });
      check(intake.status === 200 && intake.body.person_id, "with the property on the intake allowlist an inquiry is accepted", { status: intake.status });
      await q(`insert into contact_preferences (person_id,channel,consent_state,source,updated_at) values ($1,'text','opted_in','internal_qa_enrollment',now()) on conflict (person_id,channel) do update set consent_state='opted_in'`, [intake.body.person_id]);
      // Mirror the owned server's environment in this process for the in-process gate read.
      process.env.APPLICATION_INTENT_PREPARE_ENABLED = "true";
      process.env.APPLICATION_INTENT_PROPERTY_IDS = G;
      await mikeTok();
      const birth = await capability.evaluateApplicationLinkBirth(pool, { property_id: G, person_id: intake.body.person_id });
      check(birth.allowed === true, "with the property on the application allowlist the application link may be born", { reason_code: birth.reason_code });
      const saved = process.env.APPLICATION_INTENT_PROPERTY_IDS;
      process.env.APPLICATION_INTENT_PROPERTY_IDS = "";
      const gated = await capability.evaluateApplicationLinkBirth(pool, { property_id: G, person_id: intake.body.person_id });
      process.env.APPLICATION_INTENT_PROPERTY_IDS = saved;
      check(gated.allowed === false, "off the allowlist the same property refuses application birth: the Render environment is part of launch", { reason_code: gated.reason_code });
      const content = require("../../docs/content/temple/leasing-content.json");
      const cards = (content.properties.find((p) => /greenery/i.test(p.property_name)) || { facts: [] }).facts;
      let loaded = 0; const skipped = [];
      for (const card of cards) {
        if (card.status !== "source_attributed_draft") { skipped.push({ fact_key: card.fact_key, status: card.status }); continue; }
        const r = await api("POST", "/operator/agent-facts", { token: F.mikeTok, body: { fact_key: card.fact_key, rendered_text: card.rendered_text, source_type: card.source_type } });
        if (r.status === 200) loaded++; else skipped.push({ fact_key: card.fact_key, status: r.status, error: r.body && r.body.receipt });
      }
      check(loaded === cards.filter((c) => c.status === "source_attributed_draft").length, "the prepared Greenery cards fit the existing fact writer (rehearsal load only; production loading needs owner confirmation of wording)", { loaded, skipped });
      const knowledge = await api("POST", "/operator/ask-spine/message", { token: F.mikeTok, body: { message: "What amenities does the building have?" } });
      check(knowledge.status === 200 && knowledge.body.outcome === "answered" && knowledge.body.grounded_on && knowledge.body.grounded_on.leasing_knowledge === "ESTABLISHED", "Ask Spine answers a Greenery knowledge question from the loaded cards", { outcome: knowledge.body && knowledge.body.outcome, topics: knowledge.body && knowledge.body.grounded_on && knowledge.body.grounded_on.topics });
      const skylineView = await api("GET", "/operator/leasing/leaseable-units", { token: await session(F.mike.id, F.s1.id) });
      check(skylineView.status === 200 && !(skylineView.body.eligible_targets || []).some((t) => (t.unit_id || "") && (t.property_id === G)), "Mike's Skyline session sees none of Greenery's targets", { eligible_at_skyline: (skylineView.body.eligible_targets || []).length });
    });
  } finally {
    await pool.end();
  }
  const summary = { passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length, sections: [...new Set(results.map((r) => r.section))] };
  if (process.env.PROOF_OUTPUT_DIR) {
    fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `greenery_launch_rehearsal.${process.env.PROOF_EVIDENCE_LABEL || "run"}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  }
  console.log(`\ngreenery launch rehearsal: ${summary.passed} passed, ${failed} failed, ${summary.observations} observations`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
