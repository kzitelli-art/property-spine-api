"use strict";
// Class 3 · Greenery legacy-inventory establishment rehearsal.
//
// Owned nonce-verified database and owned HTTP server (E2E_API_BASE), fake SMS
// transport. Nothing touches production, a provider or a real workbook.
//
// The September 12 production read found The Greenery as 171 legacy unit rows
// with one '(whole unit)' placeholder space each: 64 apartment (parent) records
// and 107 other records, no use classification, no import lineage, no
// organization, leasing basis unknown. The August 31 workpaper and the Google
// tracker describe 64 parents carrying 105 positions (41 two-label parents,
// 23 single-label parents, five singles suffixed A), with the 107 legacy
// non-parent rows exceeding the 105 positions by one at 114 and one at 214,
// and naming conflicts at "102 - 2" and "401 - 3".
//
// This proof reproduces that shape with the retained non-PII production,
// tracker and workpaper labels (no ids, no residents), then walks the existing owners only: super-admin adoption, the super-admin
// provisioning door for an organization-less existing account, Deal Setup
// source upload, read-source with the bed basis, per-row confirmation and
// establishment, then reads inventory, availability, occupancy and the rent
// roll before and after, and the reviewed classification tool in dry-run.
// It never deletes, merges, retires or manufactures a bed, and it writes no
// SQL after a business action.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service");
const staffIdentity = require("../../src/identity/staff_identity_resolver");
const { availabilityRead } = require("../../src/surfaces/availability_read");
const { occupancyByBasis } = require("../../src/leasing/leasing_occupancy_facts");

const BASE = process.env.E2E_API_BASE;
// The rehearsal property id is fixed before any action, as the real id is
// fixed in production. No per-property allowlist is needed: nothing here
// captures an inquiry or births an application.
const GREENERY_ID = process.env.PROOF_GREENERY_ID || randomUUID();
assert.ok(BASE, "E2E_API_BASE (owned HTTP server) is required");
assert.ok(/^[0-9a-f-]{36}$/.test(GREENERY_ID), "PROOF_GREENERY_ID must be a uuid when supplied");

const results = [];
let failed = 0;
let current = "setup";
function record(ok, label, detail, kind = "check") {
  results.push({ section: current, label, ok, kind, detail: detail === undefined ? null : detail });
  if (!ok && kind === "check") failed++;
  console.log(`  ${kind === "observe" ? "NOTE" : ok ? "PASS" : "FAIL"}  [${current}] ${label}${detail !== undefined ? " | " + JSON.stringify(detail).slice(0, 600) : ""}`);
}
const check = (c, l, d) => { record(!!c, l, d); return !!c; };
const observe = (l, d) => record(true, l, d, "observe");
const need = (c, l, d) => { record(!!c, l, d); if (!c) throw new Error(`need: ${l}`); };
async function section(name, fn) { current = name; console.log(`\n== ${name} ==`); try { await fn(); } catch (e) { record(false, `section aborted: ${e.message}`, null); } }
const ymd = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
async function api(method, route, { token, key = false, body, form, query } = {}) {
  const headers = {};
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  let payload;
  if (form) payload = form; else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const url = BASE + route + (query ? "?" + new URLSearchParams(query).toString() : "");
  const r = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => null);
  return { status: r.status, body: data };
}

// ── THE PRODUCTION SHAPE, LABELS ONLY ─────────────────────────────────
// Non-PII labels retained from QB's read-only production read of
// 2026-09-12 (tmp/greenery-legacy-space-shape-20260912.json), the current
// Google tracker (Greenery 2026-2027 RR, D9:D113) and the August 31
// workpaper hierarchy (unit-type codes per parent). No ids, no residents.
const LEGACY_LABELS = ["101 - 1", "101 - 2", "102 - 2", "103", "104", "105", "106", "107 - 1", "107 - 2", "108", "109 - 1", "109 - 2", "110 - 1", "110 - 2", "111 - 1", "111 - 2", "112 - 1", "112 - 2", "113 - 1", "113 - 2", "114 - 1", "114 - C", "115 - 1", "115 - 2", "116", "1325-101", "1325-102", "1325-103", "1325-104", "1325-105", "1325-106", "1325-107", "1325-108", "1325-109", "1325-110", "1325-111", "1325-112", "1325-113", "1325-114", "1325-115", "1325-116", "1325-201", "1325-202", "1325-203", "1325-204", "1325-205", "1325-206", "1325-207", "1325-208", "1325-209", "1325-210", "1325-211", "1325-212", "1325-213", "1325-214", "1325-215", "1325-216", "1325-301", "1325-302", "1325-303", "1325-304", "1325-305", "1325-306", "1325-307", "1325-308", "1325-309", "1325-310", "1325-311", "1325-312", "1325-313", "1325-314", "1325-315", "1325-316", "1325-401", "1325-402", "1325-403", "1325-404", "1325-405", "1325-406", "1325-407", "1325-408", "1325-409", "1325-410", "1325-411", "1325-412", "1325-413", "1325-414", "1325-415", "1325-416", "201 - 1", "201 - 2", "202 - 1", "202 - 2", "203 - 1", "203 - 2", "204", "205", "206", "207 - 1", "207 - 2", "208", "209 - 1", "209 - 2", "210 - 1", "210 - 2", "211 - 1", "211 - 2", "212 - 1", "212 - 2", "213 - 1", "213 - 2", "214 - 1", "214 - 2", "215 - 1", "215 - 2", "216 - 1", "216 - 2", "301 - 1", "301 - B", "302 - 1", "302 - 2", "303 - 1", "303 - 2", "304", "305", "306 - 1", "307 - 1", "307 - 2", "308", "309 - 1", "309 - 2", "310 - 1", "310 - 2", "311 - 1", "311 - 2", "312 - 1", "312 - 2", "313 - 1", "313 - 2", "314", "315 - 1", "315 - 2", "316 - 1", "316 - 2", "401 - 1", "401 - 3", "402 - 1", "402 - 2", "403 - 1", "403 - 2", "404", "405", "406", "407 - 1", "407 - 2", "408", "409 - 1", "409 - 2", "410 - 1", "410 - 2", "411 - 1", "411 - 2", "412 - 1", "412 - 2", "413 - 1", "413 - 2", "414 - 1", "415 - 1", "415 - 2", "416 - 1", "416 - 2"];
const TRACKER_LABELS = ["101A", "101B", "102", "103", "104", "105", "106", "107A", "107B", "108", "109A", "109B", "110A", "110B", "111A", "111B", "112A", "112B", "113A", "113B", "114", "115A", "115B", "116", "201A", "201B", "202A", "202B", "203A", "203B", "204", "205", "206", "207A", "207B", "208A", "209A", "209B", "210A", "210B", "211A", "211B", "212A", "212B", "213A", "213B", "214", "215A", "215B", "216A", "216B", "301A", "301B", "302A", "302B", "303A", "303B", "304", "305", "306", "307A", "307B", "308A", "309A", "309B", "310A", "310B", "311A", "311B", "312A", "312B", "313A", "313B", "314", "315A", "315B", "316A", "316B", "401A", "401B", "402A", "402B", "403A", "403B", "404A", "405", "406", "407A", "407B", "408A", "409A", "409B", "410A", "410B", "411A", "411B", "412A", "412B", "413A", "413B", "414A", "415A", "415B", "416A", "416B"];
const AUGUST_UNIT_TYPES = {"1325-101": "STU00011", "1325-102": "STU00010", "1325-103": "STU00010", "1325-104": "STU00010", "1325-105": "STU00012", "1325-106": "STU00012", "1325-107": "STU00011", "1325-108": "STU00012", "1325-109": "STU00011", "1325-110": "STU00011", "1325-111": "STU00011", "1325-112": "STU00011", "1325-113": "STU00011", "1325-114": "STU00010", "1325-115": "STU00011", "1325-116": "STU00010", "1325-201": "STU00011", "1325-202": "STU00011", "1325-203": "STU00011", "1325-204": "STU00010", "1325-205": "STU00012", "1325-206": "STU00012", "1325-207": "STU00011", "1325-208": "STU00012", "1325-209": "STU00011", "1325-210": "STU00011", "1325-211": "STU00011", "1325-212": "STU00011", "1325-213": "STU00011", "1325-214": "STU00010", "1325-215": "STU00011", "1325-216": "STU00011", "1325-301": "STU00011", "1325-302": "STU00011", "1325-303": "STU00011", "1325-304": "STU00010", "1325-305": "STU00012", "1325-306": "STU00012", "1325-307": "STU00011", "1325-308": "STU00012", "1325-309": "STU00011", "1325-310": "STU00011", "1325-311": "STU00011", "1325-312": "STU00011", "1325-313": "STU00011", "1325-314": "STU00010", "1325-315": "STU00011", "1325-316": "STU00011", "1325-401": "STU00011", "1325-402": "STU00011", "1325-403": "STU00011", "1325-404": "STU00010", "1325-405": "STU00012", "1325-406": "STU00012", "1325-407": "STU00011", "1325-408": "STU00012", "1325-409": "STU00011", "1325-410": "STU00011", "1325-411": "STU00011", "1325-412": "STU00011", "1325-413": "STU00011", "1325-414": "STU00010", "1325-415": "STU00011", "1325-416": "STU00011"};
function shape() {
  const parents = LEGACY_LABELS.filter((l) => /^1325-/.test(l));
  const legacy = LEGACY_LABELS.filter((l) => !/^1325-/.test(l));
  const stem = (l) => String(l).match(/\d{3}/)[0];
  const positions = TRACKER_LABELS.map((room) => ({ unit: `1325-${stem(room)}`, room, stem: stem(room) }));
  const byParent = new Map();
  for (const p of positions) byParent.set(p.unit, (byParent.get(p.unit) || 0) + 1);
  const kind = {}; for (const [u, n] of byParent) kind[u] = n === 2 ? "two" : /A$/.test(positions.find((p) => p.unit === u).room) ? "single_A" : "single_plain";
  return { parents, legacy, positions, kind, stem };
}
(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  const numBase = 3000000 + (parseInt(nonce.slice(0, 6), 16) % 6000000);
  const num = (k) => "+1215" + String(numBase + k);
  const F = {};
  const S = shape();
  const G = GREENERY_ID;
  const session = async (userId, propertyId) => (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
  async function user(name, { platform_role = "member", organization_id = null, phone = null, email = null } = {}) {
    const person = await one("insert into persons (name,phone,primary_phone_e164,source) values ($1,$2,$2,'rehearsal') returning id", [name, phone]);
    return one(`insert into users (name,phone,email,role,auth_provider,platform_role,organization_id,is_active,status,account_kind,person_id)
      values ($1,$2,$6,'property_manager','phone_otp',$3,$4,true,'active','human_staff',$5) returning id, person_id, email, platform_role, organization_id`, [name, phone, platform_role, organization_id, person.id, email]);
  }
  async function assign(u, propertyId, { role_key = "property_manager", modules = "{management,leasing,maintenance}", manage = false } = {}) {
    await q(`insert into property_team_assignments (property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
      values ($1,$2,$3,$3,'property',$4,'{management}',$5,true)`, [propertyId, u.id, role_key, modules, manage]);
    await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,'property_manager',$3)", [u.person_id, propertyId, JSON.stringify({ source: "rehearsal" })]);
  }
  const marketing = async () => {
    const rows = (await availabilityRead(pool, { property_id: G, as_of: plusDays(0) })).rows;
    const by = {}; for (const r of rows) by[r.marketing_state] = (by[r.marketing_state] || 0) + 1;
    return { rows: rows.length, by };
  };
  const inventory = async () => one(`select
      (select count(*)::int from units u where u.property_id=$1) units,
      (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1) spaces,
      (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.space_label='(whole unit)') placeholders,
      (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.use_type is not null) use_configured,
      (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.position_kind='bed') beds,
      (select count(*)::int from leases where property_id=$1) leases,
      (select count(*)::int from import_source_rows r join import_batches b on b.id=r.import_batch_id where b.property_id=$1) source_rows,
      (select count(*)::int from opening_tenancy_positions where property_id=$1) opening_positions,
      (select leasing_basis from properties where id=$1) basis,
      (select organization_id from properties where id=$1) organization_id`, [G]);

  try {
    await section("shape-as-found", async () => {
      // Fixture SQL before any business action. Labelled: the production read's shape, synthetic labels.
      F.org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Greenery Client ${nonce}`, `greenery-client-${nonce}`]);
      F.anchor = await one("insert into properties (name,organization_id,leasing_basis) values ($1,$2,'bed') returning id", [`Skyline rehearsal ${nonce}`, F.org.id]);
      F.sa = await user(`Platform Admin ${nonce}`, { platform_role: "super_admin", phone: num(1), email: `sa-${nonce}@example.test` });
      await assign(F.sa, F.anchor.id, { manage: true });
      F.oa = await user(`Org Admin ${nonce}`, { platform_role: "org_admin", organization_id: F.org.id, phone: num(2), email: `oa-${nonce}@example.test` });
      await assign(F.oa, F.anchor.id, { manage: true });
      // Mike-shaped: existing human_staff, person-bridged, assigned elsewhere, NO organization on the account.
      F.mike = await user(`Mike (rehearsal) ${nonce}`, { phone: num(3), email: `mike-${nonce}@example.test` });
      await assign(F.mike, F.anchor.id);
      F.g = await one(`insert into properties (id,name,display_name,address,organization_id,leasing_basis,canonical_key,canonical_key_absent_reason)
        values ($1,'Greenery','The Greenery (rehearsal)','1325 N 15th (rehearsal)',null,'unknown',null,'predates_canonical_identity_requirement') returning id`, [G]);
      for (const label of [...S.parents, ...S.legacy]) await q("insert into units (property_id,unit_number) values ($1,$2)", [G, label]);
      F.legacyUnitIds = new Map((await q("select id, unit_number from units where property_id=$1", [G])).rows.map((r) => [r.unit_number, r.id]));
      F.before = await inventory();
      const nonParent = S.legacy.length, parents = S.parents.length;
      const groups = { unprefixed_with_suffix: S.legacy.filter((l) => / - /.test(l)).length, unprefixed_without_suffix: S.legacy.filter((l) => !/ - /.test(l)).length, prefixed_apartment: parents };
      check(groups.unprefixed_with_suffix === 89 && groups.unprefixed_without_suffix === 18 && groups.prefixed_apartment === 64, "the label groups match the production read (89 suffixed, 18 unsuffixed, 64 prefixed)", groups);
      check(F.before.units === 171 && F.before.spaces === 171 && F.before.placeholders === 171 && F.before.use_configured === 0 && F.before.source_rows === 0 && F.before.leases === 0 && F.before.opening_positions === 0 && F.before.basis === "unknown" && F.before.organization_id === null && parents === 64 && nonParent === 107,
        "the rehearsal property reproduces the production read's shape: 64 parent and 107 other legacy units, one placeholder each, no use, no lineage, no organization, basis unknown", { ...F.before, parents, non_parent: nonParent, tracker_positions: S.positions.length });
      const m = await marketing();
      check(m.rows === 171 && m.by.occupancy_unknown === 171, "before: canonical availability holds all 171 placeholders as occupancy not established", m.by);
      const occ = await occupancyByBasis(pool, G).catch((e) => ({ error: e.message }));
      observe("before: occupancy by basis", { available: occ && occ.available, reason: occ && (occ.reason || occ.error) });
    });
    need(F.g, "rehearsal property exists");

    await section("adopt", async () => {
      F.saTok = await session(F.sa.id, F.anchor.id);
      const r = await api("POST", `/admin/organizations/${F.org.id}/properties`, { token: F.saTok, body: { property_id: G, reason: "rehearsal: place The Greenery with its client" } });
      need(r.status === 200 && r.body.ok && r.body.organization_id === F.org.id, "super-admin adoption places the existing property with the organization, keeping its id", { status: r.status, body: r.body });
      const again = await api("POST", `/admin/organizations/${F.org.id}/properties`, { token: F.saTok, body: { property_id: G } });
      check(again.status === 200 && again.body.already === true, "adoption is idempotent");
      const oaTry = await api("POST", `/admin/organizations/${F.org.id}/properties`, { token: await session(F.oa.id, F.anchor.id), body: { property_id: G } });
      check(oaTry.status === 403, "an organization admin cannot use the adoption door", { status: oaTry.status });
    });

    await section("first-access", async () => {
      // Mike's account carries no organization: the org-admin door refuses it by design (QB review), so the
      // super-admin provisioning door is the reviewed path for the first assignment at the adopted property.
      const orgDoor = await api("POST", "/org/users/invite", { token: await session(F.oa.id, F.anchor.id), body: { name: F.mike.email && `Mike (rehearsal) ${nonce}`, phone: num(3), email: F.mike.email, property_id: G, role_key: "property_admin" } });
      observe("the organization-admin door for an organization-less existing account", { status: orgDoor.status, reason: orgDoor.body && (orgDoor.body.reason || orgDoor.body.error) });
      const before = await one("select platform_role, organization_id, person_id from users where id=$1", [F.mike.id]);
      const inv = await api("POST", `/admin/organizations/${F.org.id}/invite`, { token: F.saTok, body: { name: `Mike (rehearsal) ${nonce}`, phone: num(3), email: F.mike.email, property_id: G, role_key: "property_admin" } });
      need(inv.status === 201 && inv.body.user && inv.body.user.id === F.mike.id, "the super-admin door attaches the existing account to the adopted property without a second user", { status: inv.status, body: inv.body });
      const after = await one("select platform_role, organization_id, person_id from users where id=$1", [F.mike.id]);
      check(after.platform_role === before.platform_role && after.person_id === before.person_id, "the account's platform role and person identity are unchanged", { before, after });
      const asg = await one("select role_key, can_manage_roles, allowed_modules, active from property_team_assignments where property_id=$1 and user_id=$2", [G, F.mike.id]);
      check(asg && asg.active && asg.allowed_modules.includes("management"), "one active team assignment exists at the property", asg);
      const pa = await one("select count(*)::int n from assignments where person_id=$1 and property_id=$2", [F.mike.person_id, G]);
      const identity = await staffIdentity.resolveStaffIdentity(pool, { user_id: F.mike.id, property_id: G });
      observe("person-level assignment and staff identity after the admin door (tour hosting and offer authorship need a resolved identity; Deal Setup does not)", { person_assignments: pa.n, identity: identity.state, basis: identity.basis });
      F.mikeTok = await session(F.mike.id, G);
      check(!!F.mikeTok, "Mike holds a session at the property");
      F.oaTok = await session(F.oa.id, F.anchor.id);
    });

    await section("deal", async () => {
      const created = await api("POST", "/deal-setup/deals", { token: F.oaTok, body: { deal_name: "The Greenery", onboarding_type: "existing_asset" } });
      need(created.status === 201 && created.body.deal, "the organization admin creates the deal container", { status: created.status, body: created.body });
      F.deal = created.body.deal.id;
      const added = await api("POST", `/deal-setup/deals/${F.deal}/properties`, { token: F.oaTok, body: { property_id: G } });
      need(added.status === 201, "the existing property joins the deal; no replacement property is created", { status: added.status, receipt: added.body && added.body.receipt });
    });

    // ── source: 105 tracker positions under 64 parents, plus one labelled probe row ──
    const AS_OF = plusDays(-3);
    // Convention A: Unit = the prefixed parent as production names it, Room = the tracker label.
    // Convention B: Unit = the bare tracker stem, Room = the A/B letter (blank for singles) — the
    // shape a tracker export would take if nobody adds the prefix.
    function buildCsv(convention = "A") {
      let csv = "Unit,Room,Type,Resident,Market Rent,Actual Rent,Lease From,Lease To\n";
      const expected = { occupied: 0, vacant: 0, rows: 0 };
      S.positions.forEach((p, i) => {
        const occ = i % 5 !== 4;
        const type = AUGUST_UNIT_TYPES[p.unit] || "";
        const unit = convention === "A" ? p.unit : p.stem;
        const room = convention === "A" ? p.room : (p.room.replace(/^\d{3}/, "") || "");
        if (occ) { expected.occupied++; csv += `${unit},${room},${type},Rehearsal Resident ${p.room},1150,1100,${plusDays(-220)},${plusDays(145)}\n`; }
        else { expected.vacant++; csv += `${unit},${room},${type},VACANT,1150,,,\n`; }
        expected.rows++;
      });
      return { csv, expected };
    }

    await section("read-source", async () => {
      const { csv, expected } = buildCsv("A");
      F.expected = expected;
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "text/csv" }), "greenery-legacy-rehearsal-rent-roll.csv");
      form.append("source_as_of_date", AS_OF);
      const up = await api("POST", `/deal-setup/deals/${F.deal}/properties/${G}/source`, { token: F.mikeTok, form });
      need(up.status === 201 && up.body.artifact, "the rent roll is uploaded and its bytes retained", { status: up.status, body: up.body });
      F.artifact = up.body.artifact.id;
      const opened = await api("POST", `/deal-setup/deals/${F.deal}/properties/${G}/activation`, { token: F.mikeTok, body: {} });
      need(opened.status === 201 && opened.body.activation, "a governed setup opens for the property", { status: opened.status, body: opened.body });
      F.activation = opened.body.activation.id;
      const read = await api("POST", `/deal-setup/activations/${F.activation}/read-source`, { token: F.mikeTok, body: { source_artifact_id: F.artifact, source_as_of_date: AS_OF, leasing_basis: "bed" } });
      need(read.status === 201, "the retained source is read with the bed basis", { status: read.status, body: read.body && (read.body.error ? { error: read.body.error, receipt: read.body.receipt, detail: read.body.detail } : read.body.receipt) });
      F.read = read.body;
      observe("read-source counts", { rows_read: read.body.rows_read, counts: read.body.counts, mapping: read.body.mapping });
      F.afterRead = await inventory();
      const twoLabel = Object.values(S.kind).filter((k) => k === "two").length; const aSingles = Object.values(S.kind).filter((k) => k === "single_A").length;
      check(F.afterRead.basis === "bed", "the leasing basis is recorded on the property", { basis: F.afterRead.basis });
      check(F.afterRead.units === 171, "no unit was created or removed: every legacy identity survives", { units: F.afterRead.units });
      const expectedSpaces = 171 + twoLabel; // each two-label parent consumed its placeholder into its first label and created the second
      check(F.afterRead.spaces === expectedSpaces && F.afterRead.beds === S.positions.length && F.afterRead.placeholders === S.legacy.length, "every parent's pristine placeholder became its first tracker label, second labels were created, and the 107 legacy placeholders are untouched", { spaces: F.afterRead.spaces, expected_spaces: expectedSpaces, beds: F.afterRead.beds, placeholders: F.afterRead.placeholders, aSingles });
      const untouched = await one(`select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.space_label='(whole unit)' and u.unit_number = any($2::text[])`, [G, S.legacy]);
      const withLineage = await one(`select count(*)::int n from import_source_rows r join units u on u.id=r.produced_unit_id where u.property_id=$1 and u.unit_number = any($2::text[])`, [G, S.legacy]);
      check(untouched.n === S.legacy.length && withLineage.n === 0, "all 107 legacy non-parent rows keep their placeholder and gained no source lineage", { placeholders_kept: untouched.n, with_lineage: withLineage.n });
      const review = await api("GET", `/deal-setup/activations/${F.activation}`, { token: F.mikeTok });
      const proposals = review.body.proposals || [];
      const byStatus = {}; for (const p of proposals) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      check(proposals.length === expected.rows, "one proposal per source row awaits a human", { proposals: proposals.length, by_status: byStatus });
      F.proposals = proposals;
    });

    await section("confirm-and-establish", async () => {
      need(F.proposals, "proposals exist");
      let confirmed = 0; const refused = [];
      for (const p of F.proposals.filter((x) => x.status === "staged")) {
        const c = await api("POST", `/deal-setup/proposals/${p.id}/confirm`, { token: F.mikeTok, body: {} });
        if (c.status === 200) confirmed++; else refused.push({ key: p.natural_key, status: c.status, error: c.body && c.body.error, receipt: c.body && c.body.receipt });
      }
      observe("row confirmations", { confirmed, refused: refused.slice(0, 5), refused_total: refused.length });
      check(confirmed === F.expected.rows, "every one of the 105 source positions confirms against the materialised inventory", { confirmed, expected: F.expected.rows });
      const est = await api("POST", `/deal-setup/activations/${F.activation}/establish`, { token: F.mikeTok, body: {} });
      need(est.status === 201 && est.body.opening_position, "the opening lease and occupancy position is established", { status: est.status, body: est.body && (est.body.receipt || est.body.error) });
      F.after = await inventory();
      check(F.after.leases === F.expected.occupied && F.after.opening_positions === 1 && F.after.units === 171, "leases exist only for the occupied source positions; one opening position; still 171 units", { leases: F.after.leases, occupied_rows: F.expected.occupied, opening_positions: F.after.opening_positions });
      const m = await marketing();
      observe("after: canonical availability by marketing state (beds carry no use type yet; legacy placeholders stay unknown)", m.by);
      check((m.by.occupancy_unknown || 0) === S.legacy.length && (m.by.occupied || 0) === F.expected.occupied && (m.by.use_not_configured || 0) === F.expected.vacant && !m.by.marketable_now, "after: the 107 legacy rows stay occupancy-unknown, every occupied source row reads occupied, every vacant one reads use-not-configured, nothing is marketable", { unknown: m.by.occupancy_unknown, occupied: m.by.occupied, use_not_configured: m.by.use_not_configured, marketable_now: m.by.marketable_now || 0 });
      const occ = await occupancyByBasis(pool, G).catch((e) => ({ error: e.message }));
      observe("after: occupancy by basis", occ && occ.error ? occ : { status: occ.status, basis: occ.basis, occupied_count: occ.occupied_count, rentable_count: occ.rentable_count, excluded_count: occ.excluded_count, occupancy_pct: occ.occupancy_pct });
      F.occ = occ;
      const rr = await api("GET", "/operator/rent-roll/canonical", { token: F.mikeTok });
      const t = rr.body && rr.body.totals || {};
      observe("after: canonical rent roll totals (HTTP)", { status: rr.status, totals: t });
      const co = t.confirmed_contractual_occupancy || {};
      check(co.occupied === F.expected.occupied && (co.reported_beside || {}).unresolved_positions === S.legacy.length, "the rent roll reads the occupied source positions and reports the 107 unresolved legacy rows beside them", { occupied: co.occupied, unresolved: co.reported_beside && co.reported_beside.unresolved_positions });
      observe("finding: the legacy placeholders are counted in inventory and leasable totals, so the headline occupancy percentage is computed over " + t.leasable + " positions, not the " + S.positions.length + " the source establishes", { inventory: t.inventory, leasable: t.leasable, occupied: co.occupied, pct_reported: co.pct, pct_over_source_positions: Number((100 * co.occupied / S.positions.length).toFixed(2)), occupancy_by_basis_pct: F.occ && F.occ.occupancy_pct, occupancy_by_basis_rentable: F.occ && F.occ.rentable_count });
      const units = await api("GET", "/operator/rent-roll/units", { token: F.mikeTok });
      observe("after: rent roll units read (HTTP)", { status: units.status, units: Array.isArray(units.body && units.body.units) ? units.body.units.length : null, keys: Object.keys(units.body || {}).slice(0, 10) });
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.mikeTok });
      check(targets.status === 200 && (targets.body.eligible_targets || []).length === 0, "after: the application selector offers nothing while no bed carries a governed use type", { eligible: (targets.body.eligible_targets || []).length });
      const legacyLeases = await one(`select count(*)::int n from leases l join spaces s on s.id=l.space_id join units u on u.id=s.unit_id where u.property_id=$1 and u.unit_number = any($2::text[])`, [G, S.legacy]);
      check(legacyLeases.n === 0, "no lease was attached to any legacy non-parent record by the establishment", legacyLeases);
    });

    await section("classification", async () => {
      const url = boundary.manifest().url;
      const r = spawnSync(process.execPath, ["tools/apply_unit_type_mapping.js", "--property", G], { cwd: path.join(__dirname, "..", ".."), env: { ...process.env, DATABASE_URL: url, PGSSLMODE: "disable" }, encoding: "utf8", timeout: 60000 });
      const out = (r.stdout || "") + (r.stderr || "");
      observe("the reviewed classification tool, dry run, against the established rehearsal property", { exit: r.status, tail: out.trim().split("\n").slice(-6) });
      check(r.status !== 0 && /REFUSING/.test(out) && /STU00010/.test(out) && /STU00011/.test(out) && /STU00012/.test(out), "with no Greenery ruling block the tool refuses and names the three August workpaper codes; nothing is classified", { exit: r.status });
      const after = await inventory();
      check(after.use_configured === 0, "no use type was written", { use_configured: after.use_configured });
    });

    await section("repeat-upload", async () => {
      const again = await api("POST", `/deal-setup/activations/${F.activation}/read-source`, { token: F.mikeTok, body: { source_artifact_id: F.artifact, source_as_of_date: AS_OF, leasing_basis: "bed" } });
      check(again.status === 409, "re-reading the same source into the established setup is refused", { status: again.status, error: again.body && again.body.error });
      const { csv } = buildCsv("A");
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "text/csv" }), "greenery-legacy-rehearsal-rent-roll.csv");
      form.append("source_as_of_date", AS_OF);
      const up = await api("POST", `/deal-setup/deals/${F.deal}/properties/${G}/source`, { token: F.mikeTok, form });
      observe("uploading the identical file again", { status: up.status, artifact_new: up.body && up.body.artifact && up.body.artifact.id !== F.artifact, receipt: up.body && up.body.receipt });
      const opened = await api("POST", `/deal-setup/deals/${F.deal}/properties/${G}/activation`, { token: F.mikeTok, body: {} });
      observe("opening another setup after establishment", { status: opened.status, receipt: opened.body && (opened.body.receipt || opened.body.error), activation_same: opened.body && opened.body.activation && opened.body.activation.id === F.activation });
      if (opened.status === 201 && opened.body.activation && opened.body.activation.id !== F.activation && up.body && up.body.artifact) {
        const read = await api("POST", `/deal-setup/activations/${opened.body.activation.id}/read-source`, { token: F.mikeTok, body: { source_artifact_id: up.body.artifact.id, source_as_of_date: AS_OF, leasing_basis: "bed" } });
        observe("reading the identical file into a second setup", { status: read.status, error: read.body && read.body.error, receipt: read.body && read.body.receipt });
      }
      const inv = await inventory();
      check(inv.units === F.after.units && inv.spaces === F.after.spaces && inv.leases === F.after.leases && inv.opening_positions === 1, "the repeat changed no inventory, lease or position", { units: inv.units, spaces: inv.spaces, leases: inv.leases });
    });

    // ── convention B on a second property of the same shape: read only, never confirmed ──
    await section("stem-convention-probe", async () => {
      const G2 = randomUUID();
      await one(`insert into properties (id,name,display_name,organization_id,leasing_basis) values ($1,'Greenery (convention probe)','Greenery (convention probe)',$2,'unknown') returning id`, [G2, F.org.id]);
      for (const label of [...S.parents, ...S.legacy]) await q("insert into units (property_id,unit_number) values ($1,$2)", [G2, label]);
      const added = await api("POST", `/deal-setup/deals/${F.deal}/properties`, { token: F.oaTok, body: { property_id: G2 } });
      need(added.status === 201, "the second same-shaped property joins the deal", { status: added.status });
      const tok = await session(F.sa.id, G2).catch(() => null) || (await (async () => { await q("insert into property_team_assignments (property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active) values ($1,$2,'property_admin','property_admin','property','{management,leasing}','{management}',true,true)", [G2, F.mike.id]); return session(F.mike.id, G2); })());
      const { csv, expected } = buildCsv("B");
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "text/csv" }), "greenery-tracker-export-as-is.csv");
      form.append("source_as_of_date", AS_OF);
      const up = await api("POST", `/deal-setup/deals/${F.deal}/properties/${G2}/source`, { token: tok, form });
      need(up.status === 201, "the stem-convention export is uploaded", { status: up.status, body: up.body });
      const opened = await api("POST", `/deal-setup/deals/${F.deal}/properties/${G2}/activation`, { token: tok, body: {} });
      need(opened.status === 201, "a setup opens on the probe property", { status: opened.status });
      const before = await one("select count(*)::int n from units where property_id=$1", [G2]);
      const read = await api("POST", `/deal-setup/activations/${opened.body.activation.id}/read-source`, { token: tok, body: { source_artifact_id: up.body.artifact.id, source_as_of_date: AS_OF, leasing_basis: "bed" } });
      const after = await one("select count(*)::int n, count(*) filter (where unit_number !~ '^1325-' and unit_number !~ ' - ' and unit_number ~ '^\\d{3}$')::int stems from units where property_id=$1", [G2]);
      const created = (await q("select unit_number from units where property_id=$1 and unit_number <> all($2::text[]) order by unit_number", [G2, [...S.parents, ...S.legacy]])).rows.map((r) => r.unit_number);
      const landedOnLegacy = (await q("select u.unit_number from import_source_rows r join units u on u.id=r.produced_unit_id where u.property_id=$1 and u.unit_number = any($2::text[]) order by 1", [G2, S.legacy])).rows.map((r) => r.unit_number);
      const parentsTouched = await one("select count(*)::int n from import_source_rows r join units u on u.id=r.produced_unit_id where u.property_id=$1 and u.unit_number ~ '^1325-'", [G2]);
      observe("convention B (bare stems in the Unit column) read-source result", { status: read.status, counts: read.body && read.body.counts, receipt: read.body && (read.body.receipt || read.body.error) });
      check(read.status === 201 && after.n === before.n + created.length && created.length > 0 && parentsTouched.n === 0, "finding: with bare stems the reader creates NEW units for every stem that has no legacy row of that exact text, and touches no prefixed parent", { units_before: before.n, units_after: after.n, created: created.length, created_sample: created.slice(0, 6), parents_touched: parentsTouched.n });
      check(landedOnLegacy.length === 18 && landedOnLegacy.every((l) => /^\d{3}$/.test(l)), "finding: the 18 unsuffixed stems land on the legacy rows of that exact text (103, 104, …), not on their prefixed parents", { landed_on_legacy: landedOnLegacy });
      observe("nothing on the probe property was confirmed or established; it exists only to show what the export convention decides", { expected_rows: expected.rows });
    });

    await section("unresolved-mappings", async () => {
      // QB's narrow textual rule, recomputed here from the retained labels: a numeric suffix N corresponds
      // to August RoomN under the same parent; an unsuffixed label corresponds to a sole Room1. Nothing is written.
      const roomsByParent = new Map(); for (const p of S.positions) roomsByParent.set(p.unit, (roomsByParent.get(p.unit) || 0) + 1);
      const matched = [], unmatched = [];
      for (const l of S.legacy) {
        const parent = `1325-${S.stem(l)}`; const rooms = roomsByParent.get(parent) || 0;
        const m = l.match(/ - (.+)$/); const suffix = m ? m[1] : null;
        if (suffix === null) { (rooms === 1 ? matched : unmatched).push({ label: l, parent, rooms, rule: rooms === 1 ? "sole Room1" : "unsuffixed under a two-room parent" }); continue; }
        if (/^\d+$/.test(suffix) && Number(suffix) <= rooms) matched.push({ label: l, parent, room: `Room${suffix}` });
        else unmatched.push({ label: l, parent, rooms, suffix });
      }
      const coveredRooms = new Set(matched.map((x) => `${x.parent}|${x.room || "Room1"}`));
      const roomsLackingCandidates = [];
      for (const [parent, n] of roomsByParent) for (let i = 1; i <= n; i++) if (!coveredRooms.has(`${parent}|Room${i}`)) roomsLackingCandidates.push(`${parent}/Room${i}`);
      const extras = ["1325-114", "1325-214"].map((p) => ({ parent: p, legacy_rows: S.legacy.filter((l) => S.stem(l) === p.slice(5)), tracker_labels: S.positions.filter((x) => x.unit === p).map((x) => x.room) }));
      const report = { textual_correspondences: matched.length, unmatched_legacy_labels: unmatched.map((x) => x.label), source_rooms_lacking_candidates: roomsLackingCandidates, count_differences: extras, a_suffixed_singles: S.positions.filter((x) => S.kind[x.unit] === "single_A").map((x) => x.room), note: "correspondences are proposals for the existing recognition authority; none is an identity mapping and none was written" };
      observe("decisions the owner must make before the 107 legacy rows can be reconciled (computed, not written)", report);
      check(matched.length === 102 && unmatched.map((x) => x.label).sort().join(",") === ["102 - 2", "114 - C", "214 - 2", "301 - B", "401 - 3"].join(",") && roomsLackingCandidates.length === 3, "the retained labels reproduce QB's comparison: 102 textual correspondences, five unmatched legacy labels, three source rooms without a candidate", { unmatched: unmatched.map((x) => x.label), rooms_lacking: roomsLackingCandidates });
      const aBeds = await q("select s.space_label from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.space_label = any($2::text[])", [G, report.a_suffixed_singles]);
      const bBeds = await q("select s.space_label from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.space_label = any($2::text[])", [G, report.a_suffixed_singles.map((l) => l.replace(/A$/, "B"))]);
      check(aBeds.rowCount === 5 && bBeds.rowCount === 0, "each A-suffixed single established exactly one bed; no B bed was inferred", { a_beds: aBeds.rowCount, b_beds: bBeds.rowCount });
    });
  } finally { await pool.end(); }
  const summary = { passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length };
  if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `greenery_legacy_inventory.${process.env.PROOF_EVIDENCE_LABEL || "run"}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  console.log(`\ngreenery legacy inventory rehearsal: ${summary.passed} passed, ${failed} failed, ${summary.observations} observations`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
