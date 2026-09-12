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
// This proof reproduces that SHAPE with synthetic labels (the exact production
// labels were not available to it; the assumption is stated in the receipt),
// then walks the existing owners only: super-admin adoption, the super-admin
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

// ── THE SYNTHETIC SHAPE ────────────────────────────────────────────────
// 64 parents: 101–116, 201–216, 301–316, 401–416.
// Tracker positions (105): 41 two-label parents (A/B), 23 single-label
// parents, five of them A-suffixed (208A, 308A, 404A, 408A, 414A), the other
// 18 named by the parent alone (rented whole).
// Legacy non-parent rows (107): two-label parents carry "NNN - 1"/"NNN - 2"
// except 401 which carries "401 - 1"/"401 - 3" (naming conflict); A-singles
// carry "NNNA"; 102 carries "102 - 2" (naming conflict); the other 17 plain
// singles carry "NNN - 1"; 114 and 214 each carry one extra "NNN - 3".
function shape() {
  const parents = [];
  for (const f of [1, 2, 3, 4]) for (let n = 1; n <= 16; n++) parents.push(`${f}${String(n).padStart(2, "0")}`);
  const aSingles = new Set(["208", "308", "404", "408", "414"]);
  const plainSingles = new Set(["102", "103", "106", "110", "113", "116", "203", "206", "210", "213", "216", "303", "306", "310", "313", "316", "403", "411"]);
  const positions = []; const legacy = []; const kind = {};
  for (const p of parents) {
    if (aSingles.has(p)) { kind[p] = "single_A"; positions.push({ unit: p, room: `${p}A` }); legacy.push(`${p}A`); }
    else if (plainSingles.has(p)) { kind[p] = "single_plain"; positions.push({ unit: p, room: "" }); legacy.push(p === "102" ? "102 - 2" : `${p} - 1`); }
    else { kind[p] = "two"; positions.push({ unit: p, room: `${p}A` }, { unit: p, room: `${p}B` }); legacy.push(`${p} - 1`, p === "401" ? "401 - 3" : `${p} - 2`); }
    if (p === "114" || p === "214") legacy.push(`${p} - 3`);
  }
  return { parents, positions, legacy, kind };
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
    function buildCsv({ probe }) {
      let csv = "Unit,Room,Type,Resident,Market Rent,Actual Rent,Lease From,Lease To\n";
      const expected = { occupied: 0, vacant: 0, rows: 0 };
      S.positions.forEach((p, i) => {
        const occ = i % 5 !== 4;
        const type = S.kind[p.unit] === "two" ? "2BR-SHARED" : "STUDIO";
        if (occ) { expected.occupied++; csv += `${p.unit},${p.room},${type},Rehearsal Resident ${p.room || p.unit},1150,1100,${plusDays(-220)},${plusDays(145)}\n`; }
        else { expected.vacant++; csv += `${p.unit},${p.room},${type},VACANT,1150,,,\n`; }
        expected.rows++;
      });
      if (probe) { csv += `114 - 3,,2BR-SHARED,VACANT,1150,,,\n`; expected.rows++; expected.probe = "114 - 3"; }
      return { csv, expected };
    }

    await section("read-source", async () => {
      const { csv, expected } = buildCsv({ probe: true });
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
      const expectedSpaces = 171 + twoLabel; // each two-label parent consumed its placeholder into A and created B
      check(F.afterRead.spaces === expectedSpaces && F.afterRead.beds === twoLabel * 2 + aSingles, "parents' pristine placeholders became the first named bed and the second bed was created; nothing else changed", { spaces: F.afterRead.spaces, expected_spaces: expectedSpaces, beds: F.afterRead.beds, placeholders: F.afterRead.placeholders });
      const untouched = await one(`select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.space_label='(whole unit)' and u.unit_number = any($2::text[])`, [G, S.legacy]);
      const withLineage = await one(`select count(*)::int n from import_source_rows r join units u on u.id=r.produced_unit_id where u.property_id=$1 and u.unit_number = any($2::text[])`, [G, S.legacy]);
      check(untouched.n === S.legacy.length && withLineage.n === 1, "all 107 legacy non-parent rows keep their placeholder label; exactly one (the probe) gained source lineage", { placeholders_kept: untouched.n, with_lineage: withLineage.n });
      const probe = await one("select r.produced_unit_id, r.produced_space_id, u.unit_number from import_source_rows r join units u on u.id=r.produced_unit_id where u.property_id=$1 and u.unit_number='114 - 3'", [G]);
      observe("finding: a source row whose Unit column carries a legacy room-style label resolves to that legacy record, not to its parent apartment; the reader matches unit_number text", { matched: !!probe, unit_number: probe && probe.unit_number });
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
      check(confirmed === F.expected.rows, "every source row (105 positions plus the probe) confirms against the materialised inventory", { confirmed, expected: F.expected.rows });
      const est = await api("POST", `/deal-setup/activations/${F.activation}/establish`, { token: F.mikeTok, body: {} });
      need(est.status === 201 && est.body.opening_position, "the opening lease and occupancy position is established", { status: est.status, body: est.body && (est.body.receipt || est.body.error) });
      F.after = await inventory();
      check(F.after.leases === F.expected.occupied && F.after.opening_positions === 1 && F.after.units === 171, "leases exist only for the occupied source positions; one opening position; still 171 units", { leases: F.after.leases, occupied_rows: F.expected.occupied, opening_positions: F.after.opening_positions });
      const m = await marketing();
      observe("after: canonical availability by marketing state (beds carry no use type yet; legacy placeholders stay unknown)", m.by);
      check((m.by.occupancy_unknown || 0) === S.legacy.length - 1 && (m.by.occupied || 0) === F.expected.occupied && (m.by.use_not_configured || 0) === F.expected.vacant + 1 && !m.by.marketable_now, "after: 106 legacy rows stay occupancy-unknown, every occupied source row reads occupied, every vacant one (plus the probe) reads use-not-configured, nothing is marketable", { unknown: m.by.occupancy_unknown, occupied: m.by.occupied, use_not_configured: m.by.use_not_configured, marketable_now: m.by.marketable_now || 0 });
      const occ = await occupancyByBasis(pool, G).catch((e) => ({ error: e.message }));
      observe("after: occupancy by basis", occ && occ.error ? occ : { status: occ.status, basis: occ.basis, occupied_count: occ.occupied_count, rentable_count: occ.rentable_count, excluded_count: occ.excluded_count, occupancy_pct: occ.occupancy_pct });
      F.occ = occ;
      const rr = await api("GET", "/operator/rent-roll/canonical", { token: F.mikeTok });
      const t = rr.body && rr.body.totals || {};
      observe("after: canonical rent roll totals (HTTP)", { status: rr.status, totals: t });
      const co = t.confirmed_contractual_occupancy || {};
      check(co.occupied === F.expected.occupied && (co.reported_beside || {}).unresolved_positions === S.legacy.length - 1, "the rent roll reads the occupied source positions and reports the 106 unresolved legacy rows beside them", { occupied: co.occupied, unresolved: co.reported_beside && co.reported_beside.unresolved_positions });
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
      check(r.status !== 0 && /unmapped|no ruling|refus|approved/i.test(out), "with no Greenery ruling block the tool refuses and names the unmapped source codes; nothing is classified", { exit: r.status });
      const after = await inventory();
      check(after.use_configured === 0, "no use type was written", { use_configured: after.use_configured });
    });

    await section("repeat-upload", async () => {
      const again = await api("POST", `/deal-setup/activations/${F.activation}/read-source`, { token: F.mikeTok, body: { source_artifact_id: F.artifact, source_as_of_date: AS_OF, leasing_basis: "bed" } });
      check(again.status === 409, "re-reading the same source into the established setup is refused", { status: again.status, error: again.body && again.body.error });
      const { csv } = buildCsv({ probe: true });
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

    await section("unresolved-mappings", async () => {
      // Computed from the fixture and the source: what a human still has to decide. Nothing is written.
      const established = new Set((await q(`select u.unit_number||'|'||s.space_label k from import_source_rows r join spaces s on s.id=r.produced_space_id join units u on u.id=s.unit_id where u.property_id=$1`, [G])).rows.map((r) => r.k));
      const report = {
        legacy_non_parent_rows_without_established_counterpart: S.legacy.filter((l) => l !== "114 - 3").length,
        extras_beyond_source_positions: ["114 - 3", "214 - 3"],
        naming_conflicts: [{ legacy: "102 - 2", source: "102 (single position, no room named)" }, { legacy: "401 - 3", source: "401A / 401B" }],
        suffix_equivalence_unestablished: { example: "301B", legacy_candidates: ["301 - 1", "301 - 2"], note: "B = Room 2 is not established by either label" },
        a_suffixed_singles: ["208A", "308A", "404A", "408A", "414A"].map((l) => ({ label: l, legacy_row: l, established: established.has(`${l.slice(0, 3)}|${l}`), sibling_B_inferred: false })),
        probe_row_landed_on_legacy_record: "114 - 3",
      };
      observe("decisions the owner must make before the legacy rows can be reconciled (computed, not written)", report);
      check(report.a_suffixed_singles.every((x) => x.established && !x.sibling_B_inferred), "an A-suffixed single establishes exactly one bed; no B bed is inferred", report.a_suffixed_singles);
    });
  } finally { await pool.end(); }
  const summary = { passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length };
  if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `greenery_legacy_inventory.${process.env.PROOF_EVIDENCE_LABEL || "run"}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  console.log(`\ngreenery legacy inventory rehearsal: ${summary.passed} passed, ${failed} failed, ${summary.observations} observations`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
