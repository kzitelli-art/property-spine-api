"use strict";
// Class 3 · Inventory correction HARDENING: the safety gaps QB named on the
// delivered candidate (API 5be5c1c), each first shown red there and then
// proven closed here.
//
//   1. relationship policy + database wall: nothing operative attaches to
//      retired inventory through a real writer (insert, re-target, reopen,
//      new child position), history and closing stay possible, existing
//      conflicts are named — never zeroed, never repaired
//   2. concurrency, both orders, for an application writer and a work /
//      obligation writer; mixed selection leaves nothing; the authority
//      race (assignment revoked while the correction waits for its lock)
//      and actor disablement, through the governed doors
//   3. reinstatement is an identity decision: covered / unresolved / clear,
//      with both Deal Setup confirmation shapes (occupied, vacant) written
//      through the real Deal Setup door and followed by produced links
//   4. durable command identity: replay, changed payload, independent
//      identities, concurrent duplicates, no receipt for a refused command,
//      entitlement before replay
//   5. reader contracts (occupancy, availability, unit view, standing) with
//      exact counts, and the entitled Ask Spine gather/answer path carrying
//      the same bounded explanation as the staff history, through a
//      deterministic wording stub (no model call)
//
// Owned nonce-verified database, owned HTTP server (E2E_API_BASE). Every
// label is obviously synthetic (H-P1, H-L03). Every fixture write precedes
// the business action it serves; the ONE labelled exception is the
// legacy-shaped conflict fixture (an attachment inserted with the 197
// triggers held off, representing a row that attached before the wall
// existed) — it exists so the conflict READS and the close allowance can
// be exercised, and it is named as fixture in its section.
//
// WITNESS mode (INVENTORY_HARDENING_WITNESS=1): run on the delivered
// candidate. The hardening claims go red by design; the run records what
// an operator meets there and exits 1.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("./proof_boundary");
require("./proof_fence_preload");
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service");
const { reviewedHttp } = require("../helpers/reviewed_source");

const BASE = process.env.E2E_API_BASE;
assert.ok(BASE, "E2E_API_BASE is required");
const WITNESS = process.env.INVENTORY_HARDENING_WITNESS === "1";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const results = [];
let failed = 0;
let current = "setup";
function record(ok, label, detail, kind = "check") {
  results.push({ section: current, label, ok, kind, detail: detail === undefined ? null : detail });
  if (!ok && kind === "check") failed++;
  console.log(`  ${kind === "observe" ? "NOTE" : ok ? "PASS" : "FAIL"}  [${current}] ${label}${detail !== undefined ? " | " + JSON.stringify(detail).slice(0, 420) : ""}`);
}
const check = (c, l, d) => { record(!!c, l, d); return !!c; };
const observe = (l, d) => record(true, l, d, "observe");
const need = (c, l, d) => { record(!!c, l, d); if (!c) throw new Error(`need: ${l}`); };
async function section(name, fn) { current = name; console.log(`\n== ${name} ==`); try { await fn(); } catch (e) { record(false, `section aborted: ${e.message}`, null); } }
const ymd = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, route, { token, key = false, body, form } = {}) {
  const headers = {};
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  let payload;
  if (form) payload = form; else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + route, { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => null);
  return { status: r.status, body: data };
}

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  const numBase = 3000000 + (parseInt(nonce.slice(0, 6), 16) % 6000000);
  const num = (k) => "+1215" + String(numBase + k);
  const session = async (userId, propertyId) => (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
  const F = {};
  async function user(name, phone, { platform_role = "member", organization_id = null } = {}) {
    const person = await one("insert into persons (name,phone,primary_phone_e164,source) values ($1,$2,$2,'rehearsal') returning id", [name, phone]);
    return one(`insert into users (name,phone,role,auth_provider,platform_role,organization_id,is_active,status,account_kind,person_id)
      values ($1,$2,'property_manager','phone_otp',$3,$4,true,'active','human_staff',$5) returning id, person_id`, [name, phone, platform_role, organization_id, person.id]);
  }
  async function assign(u, propertyId, { role_key = "property_manager", modules = "{management,leasing,maintenance}", manage = false } = {}) {
    const a = await one(`insert into property_team_assignments (property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
      values ($1,$2,$3,$3,'property',$4,'{management}',$5,true) returning id`, [propertyId, u.id, role_key, modules, manage]);
    await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,'property_manager',$3)", [u.person_id, propertyId, JSON.stringify({ source: "rehearsal" })]);
    return a.id;
  }
  const unitByLabel = async (pid, label) => one("select u.id, u.unit_number, (select s.id from spaces s where s.unit_id=u.id order by s.space_label limit 1) as space_id from units u where u.property_id=$1 and u.unit_number=$2", [pid, label]);
  const liveRetired = async (pid) => (await q("select unit_id, original_unit_number as label from inventory_retirements where property_id=$1 and reversed_at is null order by original_unit_number", [pid])).rows;
  const commandRows = async (pid, key) => (await q("select command_type, payload_hash, input, result from inventory_correction_commands where property_id=$1 and idempotency_key=$2 order by recorded_at", [pid, key]).catch(() => ({ rows: null }))).rows;
  const review = (tok, unitId) => api("GET", `/operator/inventory/corrections/review?unit_id=${unitId}`, { token: tok });
  const retire = (tok, body) => api("POST", "/operator/inventory/corrections/retire", { token: tok, body });
  const reinstate = (tok, body) => api("POST", "/operator/inventory/corrections/reinstate", { token: tok, body });
  const setupRequest = (method, route, { headers = {}, body } = {}) =>
    api(method, route, { token: headers["x-staff-session"], body });
  const RATIONALE = `Rehearsal-designated example: this record modelled a bed as a unit under an older representation; the corrected bed-basis source supersedes it. (${nonce})`;
  async function retireNow(tok, unit, { key = null, batch = null, rationale = RATIONALE } = {}) {
    const r = await review(tok, unit.id);
    const out = await retire(tok, { unit_ids: [unit.id], review_tokens: { [unit.id]: r.body && r.body.review_token }, rationale, confirmed: true, idempotency_key: key, superseded_by_import_batch_id: batch });
    return { review: r, out };
  }
  const { readTenancyStanding } = require("../../src/tenancy/tenancy_position_read");
  const { occupancyByBasis } = require("../../src/leasing/leasing_occupancy_facts");
  const { availabilityRead } = require("../../src/surfaces/availability_read");
  const unitView = (tok) => api("GET", "/operator/rent-roll/units", { token: tok });
  async function readers(tok, pid) {
    const uv = await unitView(tok);
    return {
      occupancy: await occupancyByBasis(pool, pid),
      availability: await availabilityRead(pool, { property_id: pid }),
      unit_view: uv.status === 200 ? uv.body : { status: uv.status },
      standing: await readTenancyStanding(pool, { property_id: pid }),
    };
  }

  try {
    await section("fixture · a synthetic bed-basis property, an unrelated property, six actors, an older bed-as-unit source", async () => {
      F.org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Hardening Client ${nonce}`, `hardening-client-${nonce}`]);
      F.h = await one(`insert into properties (name,display_name,address,organization_id,leasing_basis,operating_timezone) values ($1,'Hardening (rehearsal)','1 Rehearsal Way',$2,'bed','America/New_York') returning id`, [`Hardening ${nonce}`, F.org.id]);
      F.u = await one(`insert into properties (name,display_name,address,organization_id,leasing_basis,operating_timezone) values ($1,'Unrelated (rehearsal)','9 Other Street',$2,'unit','America/New_York') returning id`, [`Unrelated ${nonce}`, F.org.id]);
      F.labels = { parents: ["H-P1", "H-P2", "H-P3"], legacyBeds: ["H-P1-A", "H-P2-A", "H-P3-A"], legacy: Array.from({ length: 16 }, (_, i) => `H-L${String(i + 1).padStart(2, "0")}`) };
      for (const label of [...F.labels.parents, ...F.labels.legacyBeds, ...F.labels.legacy]) await q("insert into units (property_id,unit_number) values ($1,$2)", [F.h.id, label]);
      for (const label of ["Apt 2F", "Suite 300"]) await q("insert into units (property_id,unit_number) values ($1,$2)", [F.u.id, label]);
      const counts = await one("select count(*)::int units, (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1) spaces from units where property_id=$1", [F.h.id]);
      check(counts.units === 22 && counts.spaces === 22, "22 synthetic unit records with one placeholder each", counts);
      F.U = {}; for (const l of [...F.labels.parents, ...F.labels.legacyBeds, ...F.labels.legacy]) F.U[l] = await unitByLabel(F.h.id, l);
      F.foreignUnit = await unitByLabel(F.u.id, "Apt 2F");
      //  Older source (bed-as-unit representation) that produced the legacy bed records.
      F.oldBatch = await one("insert into import_batches (property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status) values ($1,'rent_roll_ledger','hardening-2020-bed-as-unit-rehearsal.csv','2020-03-30','unit','confirmed','committed') returning id", [F.h.id]);
      let i = 1; for (const l of F.labels.legacyBeds) await q("insert into import_source_rows (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id) values ($1,$2,$3,'fixture: bed modelled as a unit',$4,$5)", [F.oldBatch.id, i++, JSON.stringify({ unit_number: l }), F.U[l].id, F.U[l].space_id]);
      //  Relationship examples for the wall: a declined application (terminal) on H-L06, an open one on H-L07, a lease on H-L16.
      F.declinedApp = await one("insert into lease_applications (property_id,unit_id,space_id,applicant_name,status,source) values ($1,$2,$3,'Rehearsal Declined','declined','staff') returning id", [F.h.id, F.U["H-L06"].id, F.U["H-L06"].space_id]);
      F.openApp = await one("insert into lease_applications (property_id,unit_id,space_id,applicant_name,status,source) values ($1,$2,$3,'Rehearsal Open','submitted','staff') returning id", [F.h.id, F.U["H-L07"].id, F.U["H-L07"].space_id]);
      await q("insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,'2024-01-01','2024-12-31','expired',900)", [F.h.id, F.U["H-L16"].space_id]);
      //  A durable person for the late applicant (the internal door never infers identity from a name).
      F.applicant = await one("insert into persons (name,phone,primary_phone_e164,source) values ($1,$2,$2,'rehearsal') returning id", [`Rehearsal Late Applicant ${nonce}`, num(9)]);
      //  Actors.
      F.admin = await user(`Admin ${nonce}`, num(1), { organization_id: F.org.id }); F.adminAsg = await assign(F.admin, F.h.id, { role_key: "property_admin", modules: "{management,leasing,maintenance}", manage: true });
      F.admin2 = await user(`Admin Two ${nonce}`, num(2), { organization_id: F.org.id }); await assign(F.admin2, F.h.id, { role_key: "property_admin", modules: "{management,leasing}", manage: true });
      F.admin3 = await user(`Admin Three ${nonce}`, num(3), { organization_id: F.org.id }); await assign(F.admin3, F.h.id, { role_key: "property_admin", modules: "{management,leasing}", manage: true });
      F.mike = await user(`Mike (rehearsal) ${nonce}`, num(4), { organization_id: F.org.id }); await assign(F.mike, F.h.id);
      F.oa = await user(`Org Admin ${nonce}`, num(5), { platform_role: "org_admin", organization_id: F.org.id }); await assign(F.oa, F.h.id, { role_key: "property_admin", modules: "{management,leasing}", manage: true });
      F.adminU = await user(`Admin U ${nonce}`, num(6)); await assign(F.adminU, F.u.id, { role_key: "property_admin", modules: "{management,leasing}", manage: true });
      F.adminTok = await session(F.admin.id, F.h.id); F.admin2Tok = await session(F.admin2.id, F.h.id); F.admin3Tok = await session(F.admin3.id, F.h.id);
      F.mikeTok = await session(F.mike.id, F.h.id); F.oaTok = await session(F.oa.id, F.h.id); F.adminUTok = await session(F.adminU.id, F.u.id);
      observe("designations are fixture choices: parents H-P1..3, legacy bed-as-unit records H-P1-A..H-P3-A, legacy H-L01..H-L16; H-L06 declined application, H-L07 open application, H-L16 expired lease", F.labels);
    });
    need(F.adminTok && F.U, "fixture ready");

    await section("deal setup · both confirmation shapes (occupied and vacant) through the real door, followed by produced links", async () => {
      const created = await api("POST", "/deal-setup/deals", { token: F.oaTok, body: { deal_name: `Hardening Deal ${nonce}`, onboarding_type: "existing_asset" } });
      need(created.status === 201 && created.body.deal, "the organization admin creates the deal container", { status: created.status, body: created.body });
      F.deal = created.body.deal.id;
      const added = await api("POST", `/deal-setup/deals/${F.deal}/properties`, { token: F.oaTok, body: { property_id: F.h.id } });
      need(added.status === 201, "the property joins the deal", { status: added.status, body: added.body });
      const AS_OF = plusDays(-3);
      // The retained source's parent labels deliberately differ from the
      // selected canonical parents. Only the explicit reviewed decision can
      // connect SOURCE-P1/P2 to H-P1/P2; a matching label is never identity.
      const csv = "Unit,Room,Type,Resident,Market Rent,Actual Rent,Lease From,Lease To\n" +
        `SOURCE-P1,H-P1-A,,Rehearsal Resident One,1150,1100,${plusDays(-200)},${plusDays(165)}\n` +
        "SOURCE-P2,H-P2-A,,VACANT,1150,,,\n";
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "text/csv" }), "hardening-bed-basis-rehearsal.csv");
      form.append("source_as_of_date", AS_OF);
      const up = await api("POST", `/deal-setup/deals/${F.deal}/properties/${F.h.id}/source`, { token: F.mikeTok, form });
      need(up.status === 201 && up.body.artifact, "the rent roll is uploaded", { status: up.status, body: up.body });
      const opened = await api("POST", `/deal-setup/deals/${F.deal}/properties/${F.h.id}/activation`, { token: F.mikeTok, body: {} });
      need(opened.status === 201 && opened.body.activation, "a governed setup opens", { status: opened.status, body: opened.body });
      F.activation = opened.body.activation.id;
      const reviewed = await reviewedHttp(setupRequest, F.activation, { "x-staff-session": F.mikeTok }, {
        source_artifact_id: up.body.artifact.id, source_as_of_date: AS_OF, leasing_basis: "bed",
      }, (identity, preview) => {
        const selectedLabel = identity.source.unit_number === "SOURCE-P1" ? "H-P1" : "H-P2";
        const selected = preview.available_units.find((candidate) => candidate.label === selectedLabel);
        if (!selected || !selected.parent_choice_fingerprint) throw new Error(`missing explicit selected parent: ${selectedLabel}`);
        return { action: "create_children", unit_id: selected.id, fingerprint: selected.parent_choice_fingerprint };
      });
      const read = reviewed.applied;
      need(reviewed.preview.status === 200 && read && read.status === 201,
        "the retained source is previewed and explicitly mapped to the reviewed bed parents",
        { preview: reviewed.preview.status, status: read && read.status, body: read && read.body && (read.body.error ? { error: read.body.error, receipt: read.body.receipt } : read.body.receipt) });
      const rv = await api("GET", `/deal-setup/activations/${F.activation}`, { token: F.mikeTok });
      const proposals = (rv.body && rv.body.proposals) || [];
      need(proposals.length === 2, "one proposal per source row: one occupied, one vacant", { proposals: proposals.length, statuses: proposals.map((p) => p.status) });
      const confirms = []; for (const p of proposals) confirms.push(await api("POST", `/deal-setup/proposals/${p.id}/confirm`, { token: F.mikeTok, body: {} }));
      need(confirms.every((c) => c.status === 200), "both shapes confirm", confirms.map((c) => ({ status: c.status, error: c.body && c.body.error })));
      const est = await api("POST", `/deal-setup/activations/${F.activation}/establish`, { token: F.mikeTok, body: {} });
      need(est.status === 201, "the opening position is established", { status: est.status, body: est.body && (est.body.receipt || est.body.error) });
      const promoted = (await q("select pr.natural_key, pr.status, pr.normalized_json->>'is_vacant' as is_vacant, r.produced_unit_id, r.produced_space_id, u.unit_number as produced_unit, s.space_label as produced_space from proposed_records pr join import_source_rows r on r.id=pr.import_source_row_id left join units u on u.id=r.produced_unit_id left join spaces s on s.id=r.produced_space_id where pr.activation_id=$1 order by pr.natural_key", [F.activation])).rows;
      check(promoted.length === 2 && promoted.every((p) => p.status === "promoted") && promoted.some((p) => p.is_vacant === "true") && promoted.some((p) => p.is_vacant === "false"), "BOTH shapes wrote status='promoted' (occupied and vacant), each with a produced unit and position", promoted.map((p) => ({ key: p.natural_key, status: p.status, vacant: p.is_vacant, unit: p.produced_unit, space: p.produced_space })));
      const lineage = (await q(`select l.id as lease_proposal_id,l.inventory_identity_decision_id,
          d.selected_unit_id,d.selected_space_id,r.produced_unit_id,r.produced_space_id,
          r.raw->'_source_cells'->>'Unit' as source_parent,u.unit_number as selected_parent
        from proposed_records l
        join import_source_rows r on r.id=l.import_source_row_id
        join proposed_records d on d.id=l.inventory_identity_decision_id
        join units u on u.id=d.selected_unit_id
        where l.activation_id=$1 and l.target_type='lease'
        order by source_parent`, [F.activation])).rows;
      check(lineage.length === 2
        && lineage.every((row) => row.inventory_identity_decision_id && row.selected_unit_id === row.produced_unit_id && row.selected_space_id === row.produced_space_id)
        && lineage.map((row) => `${row.source_parent}:${row.selected_parent}`).join("|") === "SOURCE-P1:H-P1|SOURCE-P2:H-P2",
      "each confirmed source lease traces through its reviewed identity decision to selected durable parent and position IDs despite different source labels", lineage);
      const leases = await one("select count(*)::int n from leases l join spaces s on s.id=l.space_id join units u on u.id=s.unit_id where u.property_id=$1 and u.unit_number='H-P1'", [F.h.id]);
      check(leases.n === 1, "the occupied shape produced a lease on H-P1's position; the vacant shape produced none", leases);
      F.batch = (await one("select import_batch_id from opening_tenancy_positions where property_id=$1 and status='established' order by established_at desc limit 1", [F.h.id]) || {}).import_batch_id;
      need(F.batch, "the established opening position names its source batch");
      for (const l of ["H-P1", "H-P2"]) {
        const sourceParent = l === "H-P1" ? "SOURCE-P1" : "SOURCE-P2";
        const r = await review(F.adminTok, F.U[l].id);
        check(r.status === 200 && r.body.eligibility.eligible === false && r.body.eligibility.blockers.some((b) => b.code === "claimed_by_current_representation"), `${l} remains protected from retirement through its selected durable home despite raw source parent ${sourceParent} (${l === "H-P1" ? "occupied" : "vacant"} shape)`, { blockers: r.body && r.body.eligibility && r.body.eligibility.blockers.map((b) => b.code) });
      }
      F.readersBefore = await readers(F.adminTok, F.h.id);
      observe("readers before any retirement", { occupancy: { rentable: F.readersBefore.occupancy.rentable_count, occupied: F.readersBefore.occupancy.occupied_count }, availability_count: F.readersBefore.availability.count, unit_view_units: F.readersBefore.unit_view.totals && F.readersBefore.unit_view.totals.units, standing_units: F.readersBefore.standing.position && F.readersBefore.standing.position.units });
    });

    await section("identity · covered, unresolved and clear reinstatements", async () => {
      //  H-P1-A: the bed-basis source relabelled H-P1's position "H-P1-A" — a
      //  differently labelled parent/bed record covering the same position.
      const r1 = await review(F.adminTok, F.U["H-P1-A"].id);
      check(r1.status === 200 && r1.body.identity && r1.body.identity.covering_records && r1.body.identity.covering_records.some((c) => c.evidence === "current_position_carrying_this_label" && c.produced_unit_label === "H-P1"), "review names the covering record: a current position under H-P1 carries the label H-P1-A", { identity: r1.body && r1.body.identity });
      const ret1 = await retire(F.adminTok, { unit_ids: [F.U["H-P1-A"].id], review_tokens: { [F.U["H-P1-A"].id]: r1.body && r1.body.review_token }, rationale: RATIONALE, confirmed: true, superseded_by_import_batch_id: F.batch, idempotency_key: `retire-p1a-${nonce}` });
      need(ret1.status === 201, "H-P1-A is retired citing the bed-basis source", { status: ret1.status, body: ret1.body && (ret1.body.error || ret1.body.retired) });
      const r1b = await review(F.adminTok, F.U["H-P1-A"].id);
      check(r1b.body.identity && r1b.body.identity.reinstatement === "covered" && r1b.body.eligibility.eligible === false, "the retired record's identity reads COVERED; reinstatement is not offered", { identity: r1b.body.identity && r1b.body.identity.reinstatement, eligible: r1b.body.eligibility && r1b.body.eligibility.eligible });
      const rc = await reinstate(F.adminTok, { unit_id: F.U["H-P1-A"].id, review_token: r1b.body.review_token, reason: "Rehearsal: trying to put back a covered position.", confirmed: true, idempotency_key: `reinstate-p1a-${nonce}` });
      check(rc.status === 409 && rc.body.error === "identity_covered" && Array.isArray(rc.body.covering_records) && rc.body.covering_records.length > 0, "reinstating over a covering record is refused by name with the covering records (no double count)", { status: rc.status, error: rc.body && rc.body.error });
      const rcx = await reinstate(F.adminTok, { unit_id: F.U["H-P1-A"].id, review_token: r1b.body.review_token, reason: "Rehearsal: trying to put back a covered position anyway.", confirmed: true, identity_decision: "position_not_covered_by_current_representation", identity_reason: "Rehearsal: the operator insists the covering record is unrelated." });
      check(rcx.status === 409 && rcx.body.error === "identity_covered", "an explicit correction cannot override a covered identity — the covering record must be corrected first", { status: rcx.status, error: rcx.body && rcx.body.error });
      //  H-P3-A: retired citing the same source, which does not name it.
      const r3 = await retireNow(F.adminTok, F.U["H-P3-A"], { batch: F.batch, key: `retire-p3a-${nonce}` });
      need(r3.out.status === 201, "H-P3-A is retired citing the bed-basis source", { status: r3.out.status });
      const r3b = await review(F.adminTok, F.U["H-P3-A"].id);
      check(r3b.body.identity && r3b.body.identity.reinstatement === "unresolved" && r3b.body.identity.covering_records.length === 0 && r3b.body.identity.cited_superseding_source && r3b.body.identity.cited_superseding_source.source_file, "identity reads UNRESOLVED: the cited source neither names the record nor claims it", { identity: r3b.body.identity });
      const noDecision = await reinstate(F.adminTok, { unit_id: F.U["H-P3-A"].id, review_token: r3b.body.review_token, reason: "Rehearsal: put H-P3-A back.", confirmed: true, idempotency_key: `reinstate-p3a-nd-${nonce}` });
      check(noDecision.status === 409 && noDecision.body.error === "identity_unresolved" && /explicit correction/.test(noDecision.body.receipt || ""), "without an explicit correction, an unresolved identity refuses reinstatement and says what would settle it", { status: noDecision.status, error: noDecision.body && noDecision.body.error });
      const shortReason = await reinstate(F.adminTok, { unit_id: F.U["H-P3-A"].id, review_token: r3b.body.review_token, reason: "Rehearsal: put H-P3-A back.", confirmed: true, identity_decision: "position_not_covered_by_current_representation", identity_reason: "because", idempotency_key: `reinstate-p3a-sr-${nonce}` });
      check(shortReason.status === 409 && shortReason.body.error === "identity_unresolved", "a correction with no real reason does not settle it", { status: shortReason.status });
      check((await commandRows(F.h.id, `reinstate-p3a-nd-${nonce}`) || []).length === 0, "refused reinstatements leave no command receipt");
      const ok = await reinstate(F.adminTok, { unit_id: F.U["H-P3-A"].id, review_token: r3b.body.review_token, reason: "Rehearsal: H-P3-A is being put back pending a physical walk.", confirmed: true, identity_decision: "position_not_covered_by_current_representation", identity_reason: "Rehearsal: the bed-basis source covered H-P1 and H-P2 only; H-P3's positions were not in it.", idempotency_key: `reinstate-p3a-${nonce}` });
      check(ok.status === 201 && ok.body.identity && ok.body.identity.read === "unresolved" && ok.body.identity.decision === "position_not_covered_by_current_representation", "with the explicit authorized correction, the reinstatement proceeds and records the identity decision", { status: ok.status, identity: ok.body && ok.body.identity, error: ok.body && ok.body.error });
      const ev = await one("select note from events where unit_id=$1 and type='inventory_reinstated_by_decision' order by occurred_at desc limit 1", [F.U["H-P3-A"].id]);
      check(ev && /identity unresolved → position_not_covered_by_current_representation/.test(ev.note) && /physical|H-P1 and H-P2/.test(ev.note), "the reversing decision names the identity read, the correction and its reason; the original decision stays", { note: ev && ev.note.slice(0, 200) });
      const orig = await one("select reversed_at is not null as reversed, reversal_reason, superseded_rationale from inventory_retirements where unit_id=$1", [F.U["H-P3-A"].id]);
      check(orig && orig.reversed && /physical walk/.test(orig.reversal_reason) && /older representation/.test(orig.superseded_rationale), "original and reversing decisions are both preserved on the owner's row", orig);
      const av = await availabilityRead(pool, { property_id: F.h.id });
      const row = (av.rows || []).find((r) => String(r.unit_id) === String(F.U["H-P3-A"].id));
      check(row && row.state !== "marketable_now" && !["occupied", "successor_locked"].includes(row.state), "reinstating established no availability: the position is back in the reads with its own (unestablished) state", { state: row && row.state });
      //  H-L01: retired without citing a source; the established record settles it.
      const l1 = await retireNow(F.adminTok, F.U["H-L01"], { key: `retire-l01-${nonce}` });
      need(l1.out.status === 201, "H-L01 is retired without a cited source", { status: l1.out.status });
      const l1r = await review(F.adminTok, F.U["H-L01"].id);
      check(l1r.body.identity && l1r.body.identity.reinstatement === "clear", "identity reads CLEAR: nothing covers it and no superseding source was cited", { identity: l1r.body.identity && l1r.body.identity.reinstatement });
      F.tokL01 = l1r.body.review_token;
    });

    await section("wall · operative writes cannot attach to retired inventory; history, audit and closing still can", async () => {
      //  ORDER A (application): the writer commits first — the retirement WAITS, then refuses.
      const r2 = await review(F.adminTok, F.U["H-L02"].id);
      need(r2.status === 200 && r2.body.eligibility.eligible === true, "H-L02 reviews as eligible");
      const w = await pool.connect(); await w.query("begin");
      await w.query("insert into lease_applications (property_id,unit_id,space_id,applicant_name,status,source) values ($1,$2,$3,'Rehearsal Racer','submitted','staff')", [F.h.id, F.U["H-L02"].id, F.U["H-L02"].space_id]);
      let settled = false;
      const inflight = retire(F.adminTok, { unit_ids: [F.U["H-L02"].id], review_tokens: { [F.U["H-L02"].id]: r2.body.review_token }, rationale: RATIONALE, confirmed: true }).then((r) => { settled = true; return r; });
      await sleep(1200);
      check(settled === false, "ORDER A (application): the retirement waits on the in-flight application writer", { settled });
      await w.query("commit"); w.release();
      const outA = await inflight;
      check(outA.status === 409 && outA.body.error === "retirement_refused" && (outA.body.refused[0].code === "stale_review" || (outA.body.refused[0].blockers || []).some((b) => b.code === "open_applications")), "ORDER A (application): after the writer commits the retirement is refused; nothing written", { status: outA.status, code: outA.body && outA.body.refused && outA.body.refused[0].code });
      //  ORDER B (application): the retirement commits first — the writer cannot attach.
      const l3 = await retireNow(F.adminTok, F.U["H-L03"], { key: `retire-l03-${nonce}` });
      need(l3.out.status === 201, "H-L03 is retired", { status: l3.out.status });
      const app = await api("POST", `/properties/${F.h.id}/applications/internal`, { token: F.adminTok, key: true, body: { applicant_name: "Rehearsal Late Applicant", person_id: F.applicant.id, unit_id: F.U["H-L03"].id } });
      const appRows = await one("select count(*)::int n from lease_applications where unit_id=$1", [F.U["H-L03"].id]);
      //  The internal door carries its own offerability guard ahead of the
      //  database wall; either refusal is the writer failing to attach, and
      //  the wall itself is exercised directly below and through the
      //  work-order door. Which guard answered is recorded, not assumed.
      check(app.status === 409 && appRows.n === 0, "ORDER B (application): the real internal-application door refuses; no application attached", { status: app.status, error: app.body && app.body.error, receipt: app.body && app.body.receipt, rows: appRows.n });
      //  ORDER A (work / obligation): writer first, retirement waits.
      const r4 = await review(F.adminTok, F.U["H-L04"].id);
      need(r4.status === 200 && r4.body.eligibility.eligible === true, "H-L04 reviews as eligible");
      const w2 = await pool.connect(); await w2.query("begin");
      await w2.query("insert into work_orders (property_id,unit_id,title,status) values ($1,$2,'Rehearsal: racing work','open')", [F.h.id, F.U["H-L04"].id]);
      let settled2 = false;
      const inflight2 = retire(F.adminTok, { unit_ids: [F.U["H-L04"].id], review_tokens: { [F.U["H-L04"].id]: r4.body.review_token }, rationale: RATIONALE, confirmed: true }).then((r) => { settled2 = true; return r; });
      await sleep(1200);
      check(settled2 === false, "ORDER A (work): the retirement waits on the in-flight work-order writer (unit-row KEY SHARE vs FOR UPDATE)", { settled: settled2 });
      await w2.query("commit"); w2.release();
      const outA2 = await inflight2;
      check(outA2.status === 409 && outA2.body.error === "retirement_refused" && (outA2.body.refused[0].code === "stale_review" || (outA2.body.refused[0].blockers || []).some((b) => b.code === "open_work_orders")), "ORDER A (work): refused after the writer commits", { status: outA2.status, code: outA2.body && outA2.body.refused && outA2.body.refused[0].code });
      //  ORDER B (work / obligation): retirement first, the work-order door (which spawns an obligation) cannot attach.
      const l5 = await retireNow(F.adminTok, F.U["H-L05"], { key: `retire-l05-${nonce}` });
      need(l5.out.status === 201, "H-L05 is retired", { status: l5.out.status });
      const wo = await api("POST", "/operator/work-orders", { token: F.adminTok, key: true, body: { unit_id: F.U["H-L05"].id, title: "Rehearsal: work on retired inventory", description: "should be refused", idempotency_key: `wo-l05-${nonce}` } });
      const woRows = await one("select (select count(*)::int from work_orders where unit_id=$1) as work_orders, (select count(*)::int from obligations where unit_id=$1) as obligations", [F.U["H-L05"].id]);
      check(wo.status === 409 && wo.body && wo.body.error === "retired_inventory" && /H-L05/.test(wo.body.receipt || "") && woRows.work_orders === 0 && woRows.obligations === 0, "ORDER B (work/obligation): the real work-order door refuses; no work order and no obligation attached", { status: wo.status, error: wo.body && wo.body.error, rows: woRows });
      //  The database wall by cause class (diagnostic writes expected to be REFUSED; a refused write manufactures nothing).
      const tryWrite = (sql, args) => q(sql, args).then(() => ({ ok: true })).catch((e) => ({ ok: false, message: e.message }));
      const newSpace = await tryWrite("insert into spaces (unit_id,space_label,use_type,position_kind) values ($1,'Bed Z','residential','bed')", [F.U["H-L05"].id]);
      check(newSpace.ok === false && /retired from current inventory/.test(newSpace.message) && /new attachment/.test(newSpace.message), "a NEW child position under a retired unit is refused", { message: newSpace.message && newSpace.message.slice(0, 140) });
      const l6 = await retireNow(F.adminTok, F.U["H-L06"], { key: `retire-l06-${nonce}` });
      need(l6.out.status === 201, "H-L06 (declined application only) is retired: a terminal row does not block");
      const reopen = await tryWrite("update lease_applications set status='submitted' where id=$1", [F.declinedApp.id]);
      check(reopen.ok === false && /reopen/.test(reopen.message), "REOPENING a terminal row on a retired unit is refused", { message: reopen.message && reopen.message.slice(0, 140) });
       const retarget = await tryWrite("update lease_applications set unit_id=$2, space_id=$3 where id=$1", [F.openApp.id, F.U["H-L05"].id, F.U["H-L05"].space_id]);
       check(retarget.ok === false && /re-target/.test(retarget.message), "RE-TARGETING an operative row onto a retired unit is refused", { message: retarget.message && retarget.message.slice(0, 140) });
       // unit_events carries both relations but does not use the application
       // grain trigger. The retirement wall must independently inspect every
       // populated target, not let a current direct unit hide a retired space.
       const divergentInsert = await tryWrite("insert into unit_events (property_id,unit_id,space_id,event_type,effective_date,status,source) values ($1,$2,$3,'move_in_scheduled',current_date,'scheduled','rehearsal divergent insert')", [F.h.id, F.U["H-L04"].id, F.U["H-L05"].space_id]);
       check(divergentInsert.ok === false && /new attachment/.test(divergentInsert.message), "a current unit plus retired space is refused on INSERT", { message: divergentInsert.message && divergentInsert.message.slice(0, 140) });
       const currentEvent = await one("insert into unit_events (property_id,unit_id,space_id,event_type,effective_date,status,source) values ($1,$2,$3,'move_in_scheduled',current_date,'scheduled','rehearsal current event') returning id", [F.h.id, F.U["H-L04"].id, F.U["H-L04"].space_id]);
       const divergentUpdate = await tryWrite("update unit_events set space_id=$2 where id=$1", [currentEvent.id, F.U["H-L05"].space_id]);
       check(divergentUpdate.ok === false && /re-target/.test(divergentUpdate.message), "a current unit plus retired space is refused on UPDATE", { message: divergentUpdate.message && divergentUpdate.message.slice(0, 140) });
      const audit = await tryWrite("insert into events (property_id,unit_id,type,note) values ($1,$2,'rehearsal_note','audit on retired inventory is allowed')", [F.h.id, F.U["H-L05"].id]);
      const observation = await tryWrite("insert into documents (property_id,unit_id,kind,file_name,storage_ref) values ($1,$2,'photo','rehearsal.jpg','rehearsal://x')", [F.h.id, F.U["H-L05"].id]).catch(() => ({ ok: null }));
      check(audit.ok === true, "audit recording (events) on retired inventory is allowed — history keeps its identity", { audit, observation: observation.ok });
      const lease = await tryWrite("insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,$3,$4,'pending',900)", [F.h.id, F.U["H-L05"].space_id, plusDays(30), plusDays(395)]);
      check(lease.ok === false && /retired from current inventory/.test(lease.message), "the any-lease wall (180) still stands", { message: lease.message && lease.message.slice(0, 100) });
      const c = await one("select count(*)::int n from inventory_retirements where property_id=$1 and reversed_at is null", [F.h.id]);
      F.retiredSoFar = c.n;
    });

    await section("legacy conflict · an attachment that pre-dates the wall is named in every read, closable, never zeroed and never repaired", async () => {
      //  LABELLED FIXTURE, NOT A BUSINESS ACTION: a row attached to retired
      //  H-L05 while no wall existed. Inserted with the 197 triggers held off
      //  for this statement only, so the conflict READS can be exercised.
      const fx = await pool.connect();
      try {
        await fx.query("begin"); await fx.query("set local session_replication_role = replica");
       F.legacyApp = (await fx.query("insert into lease_applications (property_id,unit_id,space_id,applicant_name,status,source) values ($1,$2,$3,'Rehearsal Legacy (pre-wall fixture)','submitted','staff') returning id", [F.h.id, F.U["H-L05"].id, F.U["H-L05"].space_id])).rows[0];
       F.legacyEvent = (await fx.query("insert into unit_events (property_id,unit_id,space_id,event_type,effective_date,status,source) values ($1,$2,$3,'move_in_scheduled',current_date,'scheduled','rehearsal legacy divergent fixture') returning id", [F.h.id, F.U["H-L04"].id, F.U["H-L05"].space_id])).rows[0];
        await fx.query("commit");
      } catch (e) { await fx.query("rollback").catch(() => {}); observe("legacy conflict fixture could not be written on this tree", { message: e.message }); } finally { fx.release(); }
      const hist = await api("GET", "/operator/inventory/corrections/history", { token: F.adminTok });
      const ex = hist.body && hist.body.explanation;
      const conf = ex && (ex.operative_work_on_retired_inventory || []).find((c) => c.label === "H-L05");
       check(hist.status === 200 && ex && ex.conflict === true && conf && conf.attachments.some((a) => a.kind === "application" && a.count === 1) && conf.attachments.some((a) => a.kind === "unit event" && a.count === 1), "the staff history names direct and space-scoped conflicts once each on H-L05", { conflict: ex && ex.conflict, conf });
      const standing = await readTenancyStanding(pool, { property_id: F.h.id });
      const sc = standing.inventory_correction;
      check(sc && sc.read_state === "OK" && sc.conflict === true && (sc.operative_work_on_retired_inventory || []).some((c) => c.label === "H-L05"), "the tenancy standing (Ask Spine's read) carries the same named conflict", { conflict: sc && sc.conflict });
      check(JSON.stringify(ex) === JSON.stringify(sc), "staff history and standing carry the SAME explanation object");
      const r5 = await review(F.adminTok, F.U["H-L05"].id);
       check(r5.status === 200 && r5.body.eligibility.action === "reinstate" && r5.body.eligibility.blockers.some((b) => b.code === "open_applications") && r5.body.eligibility.blockers.some((b) => b.code === "possession_recorded"), "the record's own review reports direct and space-scoped conflicts as blocker-shaped facts", { blockers: r5.body && r5.body.eligibility.blockers.map((b) => b.code) });
       const closing = await q("update lease_applications set status='withdrawn' where id=$1", [F.legacyApp.id]).then(() => ({ ok: true })).catch((e) => ({ ok: false, message: e.message }));
       const closingEvent = await q("update unit_events set status='cancelled' where id=$1", [F.legacyEvent.id]).then(() => ({ ok: true })).catch((e) => ({ ok: false, message: e.message }));
       check(closing.ok === true && closingEvent.ok === true, "CLOSING existing direct and space-scoped conflicts is allowed on retired inventory", { closing, closingEvent });
      const hist2 = await api("GET", "/operator/inventory/corrections/history", { token: F.adminTok });
      check(hist2.body && hist2.body.explanation && hist2.body.explanation.conflict === false, "after closing, the conflict is gone from the read — resolved by the writer, not repaired by SQL", { conflict: hist2.body && hist2.body.explanation && hist2.body.explanation.conflict });
    });

    await section("authority race · revoked while the correction waits for its inventory lock; actor disablement", async () => {
      const r8 = await review(F.adminTok, F.U["H-L08"].id);
      need(r8.status === 200 && r8.body.eligibility.eligible === true, "H-L08 reviews as eligible");
      const lock = await pool.connect(); await lock.query("begin");
      await lock.query("select id from units where id=$1 for update", [F.U["H-L08"].id]);
      let settled = false;
      const inflight = retire(F.adminTok, { unit_ids: [F.U["H-L08"].id], review_tokens: { [F.U["H-L08"].id]: r8.body.review_token }, rationale: RATIONALE, confirmed: true, idempotency_key: `retire-l08-${nonce}` }).then((r) => { settled = true; return r; });
      await sleep(1000);
      need(settled === false, "the correction is blocked on its inventory lock (external transaction holds the unit row)", { settled });
      const revoke = await api("PATCH", `/property-team-assignments/${F.adminAsg}`, { token: F.admin2Tok, body: { can_manage_roles: false } });
      need(revoke.status === 200, "admin2 revokes admin's governed override through the governed door while the correction waits", { status: revoke.status });
      await lock.query("commit"); lock.release();
      const out = await inflight;
      const rows = await one("select count(*)::int n from inventory_retirements where unit_id=$1", [F.U["H-L08"].id]);
      check(out.status === 403 && out.body.error === "authority_changed" && rows.n === 0, "after the lock is released the correction re-reads authority AFTER the lock and refuses; nothing written", { status: out.status, error: out.body && out.body.error, rows: rows.n });
      const restore = await api("PATCH", `/property-team-assignments/${F.adminAsg}`, { token: F.admin2Tok, body: { can_manage_roles: true } });
      need(restore.status === 200, "authority restored");
      //  Actor disablement through the org-admin door, same shape.
      const r9 = await review(F.admin3Tok, F.U["H-L09"].id);
      need(r9.status === 200 && r9.body.eligibility.eligible === true, "H-L09 reviews as eligible for admin3");
      const lock2 = await pool.connect(); await lock2.query("begin");
      await lock2.query("select id from units where id=$1 for update", [F.U["H-L09"].id]);
      let settled2 = false;
      const inflight2 = retire(F.admin3Tok, { unit_ids: [F.U["H-L09"].id], review_tokens: { [F.U["H-L09"].id]: r9.body.review_token }, rationale: RATIONALE, confirmed: true }).then((r) => { settled2 = true; return r; });
      await sleep(1000);
      need(settled2 === false, "admin3's correction is blocked on its inventory lock", { settled: settled2 });
      const suspend = await api("PATCH", `/org/users/${F.admin3.id}`, { token: F.oaTok, body: { status: "suspended" } });
      need(suspend.status === 200, "the organization admin suspends admin3 through the org door while the correction waits", { status: suspend.status, body: suspend.body });
      await lock2.query("commit"); lock2.release();
      const out2 = await inflight2;
      const rows2 = await one("select count(*)::int n from inventory_retirements where unit_id=$1", [F.U["H-L09"].id]);
      check(out2.status === 403 && (out2.body.error === "actor_disabled" || out2.body.error === "authority_changed") && rows2.n === 0, "a suspended actor's in-flight correction is refused after the wait; nothing written", { status: out2.status, error: out2.body && out2.body.error, rows: rows2.n });
      const unsuspend = await api("PATCH", `/org/users/${F.admin3.id}`, { token: F.oaTok, body: { status: "active" } });
      check(unsuspend.status === 200, "admin3 restored");
      const afterRevoke = await api("PATCH", `/property-team-assignments/${F.adminAsg}`, { token: F.admin2Tok, body: { can_manage_roles: false } });
      need(afterRevoke.status === 200, "revoke again for the replay-entitlement check");
      const replayNoAuth = await retire(F.adminTok, { unit_ids: [F.U["H-L03"].id], review_tokens: { [F.U["H-L03"].id]: "x" }, rationale: RATIONALE, confirmed: true, idempotency_key: `retire-l03-${nonce}` });
      check(replayNoAuth.status === 403, "a replay of a recorded command is refused when the actor no longer holds authority (entitlement before replay)", { status: replayNoAuth.status, error: replayNoAuth.body && replayNoAuth.body.error });
      need((await api("PATCH", `/property-team-assignments/${F.adminAsg}`, { token: F.admin2Tok, body: { can_manage_roles: true } })).status === 200, "authority restored again");
    });

    await section("command identity · replay, changed payload, independent identities, concurrent duplicates, no receipt on refusal", async () => {
      const r10 = await review(F.adminTok, F.U["H-L10"].id);
      need(r10.status === 200 && r10.body.eligibility.eligible === true, "H-L10 reviews as eligible");
      const KEY = `retire-l10-${nonce}`;
      const body = { unit_ids: [F.U["H-L10"].id], review_tokens: { [F.U["H-L10"].id]: r10.body.review_token }, rationale: RATIONALE, confirmed: true, idempotency_key: KEY };
      const first = await retire(F.adminTok, body);
      need(first.status === 201 && first.body.retired === 1, "the retirement is recorded", { status: first.status, body: first.body && (first.body.error || first.body.retired) });
      check(first.body.command_identity === "recorded" && typeof first.body.command_id === "string", "the command has a durable identity", { command_identity: first.body.command_identity });
      const again = await retire(F.adminTok, body);
      check(again.status === 200 && again.body.idempotent === true && again.body.retired === 1 && again.body.replayed_from && again.body.current_state && again.body.current_state.units[0].state === "retired", "same key + same payload REPLAYS the recorded result (200) and separately reports the CURRENT state", { status: again.status, idempotent: again.body && again.body.idempotent, current: again.body && again.body.current_state });
       const changed = await retire(F.adminTok, { ...body, rationale: RATIONALE + " (edited)" });
       check(changed.status === 409 && changed.body.error === "command_payload_conflict", "same key + different payload is a conflict, not a silent replay", { status: changed.status, error: changed.body && changed.body.error });
       const longPrefix = "x".repeat(200);
       const longA = await retire(F.adminTok, { ...body, idempotency_key: longPrefix + "A" });
       const longB = await retire(F.adminTok, { ...body, idempotency_key: longPrefix + "B" });
       const longRows = await commandRows(F.h.id, longPrefix);
       check(longA.status === 400 && longB.status === 400 && longA.body.error === "idempotency_key_too_long" && longB.body.error === "idempotency_key_too_long" && Array.isArray(longRows) && longRows.length === 0, "distinct oversized keys are explicitly refused; neither is truncated into a replay identity", { a: longA.status, b: longB.status, rows: longRows && longRows.length });
      const otherKey = await retire(F.adminTok, { ...body, idempotency_key: `retire-l10-b-${nonce}` });
      check(otherKey.status === 409 && otherKey.body.error === "retirement_refused" && otherKey.body.refused[0].code === "ALREADY_RETIRED", "a DIFFERENT key for the same unit is a new command and is refused by name (ALREADY_RETIRED)", { status: otherKey.status, code: otherKey.body && otherKey.body.refused && otherKey.body.refused[0].code });
      const r10b = await review(F.adminTok, F.U["H-L10"].id);
      const rein = await reinstate(F.adminTok, { unit_id: F.U["H-L10"].id, review_token: r10b.body.review_token, reason: "Rehearsal: H-L10 goes back (same key string as the retirement).", confirmed: true, idempotency_key: KEY });
      check(rein.status === 201 && rein.body.reinstated === true, "the same key string under the REINSTATE identity is independent of the retire identity", { status: rein.status, error: rein.body && rein.body.error });
      const reinAgain = await reinstate(F.adminTok, { unit_id: F.U["H-L10"].id, review_token: r10b.body.review_token, reason: "Rehearsal: H-L10 goes back (same key string as the retirement).", confirmed: true, idempotency_key: KEY });
      check(reinAgain.status === 200 && reinAgain.body.idempotent === true && reinAgain.body.current_state.units[0].state === "current", "a lost response after the reinstatement commit replays it instead of becoming NOT_RETIRED or stale_review", { status: reinAgain.status, idempotent: reinAgain.body && reinAgain.body.idempotent });
      const kinds = await commandRows(F.h.id, KEY);
      check(Array.isArray(kinds) && kinds.length === 2 && kinds.map((k) => k.command_type).sort().join(",") === "reinstate,retire", "two receipts under one key string: one retire, one reinstate", { kinds: kinds && kinds.map((k) => k.command_type) });
      //  Concurrent duplicates: two identical submissions at once produce ONE decision.
      const r11 = await review(F.adminTok, F.U["H-L11"].id);
      const K2 = `retire-l11-${nonce}`;
      const dup = { unit_ids: [F.U["H-L11"].id], review_tokens: { [F.U["H-L11"].id]: r11.body.review_token }, rationale: RATIONALE, confirmed: true, idempotency_key: K2 };
      const both = await Promise.all([retire(F.adminTok, dup), retire(F.adminTok, dup)]);
      const statuses = both.map((b) => b.status).sort();
      const rows11 = await one("select (select count(*)::int from inventory_retirements where unit_id=$1) as retirements, (select count(*)::int from inventory_correction_commands where idempotency_key=$2) as commands", [F.U["H-L11"].id, K2]).catch(() => ({ retirements: null, commands: null }));
      check(statuses.join(",") === "200,201" && rows11.retirements === 1 && rows11.commands === 1, "concurrent duplicates: one 201 decision, one 200 replay, one retirement row, one receipt", { statuses, rows: rows11 });
      //  A refused mixed selection leaves no partial correction and no receipt.
      const r12 = await review(F.adminTok, F.U["H-L12"].id); const r16 = await review(F.adminTok, F.U["H-L16"].id);
      const K3 = `retire-mixed-${nonce}`;
      const mixed = await retire(F.adminTok, { unit_ids: [F.U["H-L12"].id, F.U["H-L16"].id], review_tokens: { [F.U["H-L12"].id]: r12.body.review_token, [F.U["H-L16"].id]: r16.body.review_token }, rationale: RATIONALE, confirmed: true, idempotency_key: K3 });
      const rows12 = await one("select (select count(*)::int from inventory_retirements where unit_id=$1) as l12, (select count(*)::int from inventory_correction_commands where idempotency_key=$2) as commands", [F.U["H-L12"].id, K3]).catch(() => ({ l12: null, commands: null }));
      check(mixed.status === 409 && mixed.body.error === "retirement_refused" && rows12.l12 === 0 && rows12.commands === 0, "a mixed selection is refused whole: the eligible unit is not retired and no receipt is written", { status: mixed.status, rows: rows12 });
      const mikeReplay = await retire(F.mikeTok, body);
      check(mikeReplay.status === 403, "Mike cannot replay a recorded command either", { status: mikeReplay.status });
    });

    await section("readers · exact contracts after the corrections, and the unrelated property's silence", async () => {
      const live = await liveRetired(F.h.id);
      const retiredIds = new Set(live.map((r) => String(r.unit_id)));
      const reversed = (await one("select count(*)::int n from inventory_retirements where property_id=$1 and reversed_at is not null", [F.h.id])).n;
      const spacesRetired = (await one("select count(*)::int n from spaces s where s.unit_id = any($1::uuid[])", [[...retiredIds]])).n;
      const after = await readers(F.adminTok, F.h.id);
      const before = F.readersBefore;
      check(after.occupancy.status === "ok" && after.occupancy.basis === "bed" && before.occupancy.rentable_count - after.occupancy.rentable_count === spacesRetired && after.occupancy.occupied_count === before.occupancy.occupied_count, `occupancyByBasis: rentable_count dropped by exactly the retired positions (${spacesRetired}); occupied unchanged`, { before: before.occupancy.rentable_count, after: after.occupancy.rentable_count, occupied: after.occupancy.occupied_count });
      const avIds = new Set((after.availability.rows || []).map((r) => String(r.unit_id)));
      check(before.availability.count - after.availability.count === spacesRetired && [...retiredIds].every((id) => !avIds.has(id)) && avIds.has(String(F.U["H-P1"].id)), "availabilityRead: count dropped by the retired positions; no retired unit appears; the parent still does", { before: before.availability.count, after: after.availability.count, retired: live.map((r) => r.label) });
      const uv = after.unit_view;
      const uvIds = new Set((uv.units || []).map((u) => String(u.unit_id)));
      check(uv.totals && before.unit_view.totals.units - uv.totals.units === retiredIds.size && uv.retired_excluded && uv.retired_excluded.units === retiredIds.size && uv.retired_excluded.conflict === false && uv.retired_excluded.leases_on_retired_inventory === 0 && [...retiredIds].every((id) => !uvIds.has(id)), "rent-roll unit view: units dropped by the retired count; retired_excluded names the count and no tenancy conflict; no retired unit listed", { units_before: before.unit_view.totals && before.unit_view.totals.units, units_after: uv.totals && uv.totals.units, retired_excluded: uv.retired_excluded });
      const st = after.standing;
      check(st.position && before.standing.position.units - st.position.units === retiredIds.size && st.unknowns.unit_records_retired_from_current_inventory === retiredIds.size && st.unknowns.tenancy_attached_to_retired_inventory === 0, "tenancy standing: position.units dropped by the retired count; the exclusion unknowns carry the exact count and zero attached tenancy", { units_before: before.standing.position.units, units_after: st.position && st.position.units, unknowns: st.unknowns && { retired: st.unknowns.unit_records_retired_from_current_inventory, attached: st.unknowns.tenancy_attached_to_retired_inventory } });
      const ic = st.inventory_correction;
      check(ic && ic.read_state === "OK" && ic.excluded_from_current_inventory === retiredIds.size && ic.excluded_records.map((r) => r.label).sort().join(",") === live.map((r) => r.label).sort().join(",") && ic.excluded_records_truncated === false && ic.conflict === false && ic.reinstated_records === reversed, "standing.inventory_correction: which records are excluded (by label), why, provenance, conflicts — and the reinstated decisions", { excluded: ic && ic.excluded_records && ic.excluded_records.map((r) => [r.label, r.reason, r.decided_by, r.superseding_source && r.superseding_source.source_file]), reinstated: ic && ic.reinstated_records });
      check(ic && ic.excluded_records.every((r) => r.reason_meaning && r.rationale && r.retired_on) && !UUID_RE.test(JSON.stringify(ic)), "every excluded record carries its reason meaning, rationale and date; the explanation carries no record or actor ids", { sample: ic && ic.excluded_records[0] });
      //  The unrelated property: no opening position; a retirement there keeps unknowns honest.
      const ru = await retireNow(F.adminUTok, F.foreignUnit, { key: `retire-u-${nonce}` });
      need(ru.out.status === 201, "the unrelated property's admin retires Apt 2F (no citation)", { status: ru.out.status, error: ru.out.body && ru.out.body.error });
      const su = await readTenancyStanding(pool, { property_id: F.u.id });
      check(su.standing.truth_state === "NOT_ESTABLISHED" || su.standing.truth_state === "PARTIALLY_ESTABLISHED" || su.standing.truth_state === "ESTABLISHED", "the unrelated property's standing reads", { truth_state: su.standing && su.standing.truth_state });
      check(su.inventory_correction && su.inventory_correction.excluded_from_current_inventory === 1 && su.inventory_correction.excluded_records[0].label === "Apt 2F" && su.inventory_correction.excluded_records[0].superseding_source === null, "with no opening position the correction explanation still names the excluded record and its missing citation", { ic: su.inventory_correction && su.inventory_correction.excluded_records });
      check(su.unknowns === null || su.unknowns.unit_records_retired_from_current_inventory === 1, "unknowns stay null when no baseline read completed, or carry the exact count — never a bag of zeroes", { unknowns: su.unknowns });
      const hu = await api("GET", "/operator/inventory/corrections/history", { token: F.adminUTok });
      check(hu.status === 200 && hu.body.explanation && hu.body.explanation.excluded_records.length === 1 && hu.body.explanation.excluded_records[0].label === "Apt 2F" && !hu.body.explanation.excluded_records.some((r) => /H-/.test(r.label)), "the unrelated property's history explains only its own record", { labels: hu.body && hu.body.explanation && hu.body.explanation.excluded_records.map((r) => r.label) });
      //  Pagination with whole-property totals.
      const page = await api("GET", "/operator/inventory/corrections?limit=2&offset=0&state=retired", { token: F.adminTok });
      check(page.status === 200 && page.body.units.length === 2 && page.body.page.filtered_total === retiredIds.size && page.body.units_total === 22 && page.body.retired_now === retiredIds.size && page.body.units.every((u) => u.state === "retired"), "list: bounded page of retired records with whole-property totals", { page: page.body && page.body.page, units_total: page.body && page.body.units_total });
      const page2 = await api("GET", "/operator/inventory/corrections?limit=2&offset=2&state=retired", { token: F.adminTok });
      check(page2.status === 200 && page2.body.units.length === Math.min(2, Math.max(0, retiredIds.size - 2)) && page2.body.units[0] && page2.body.units[0].unit_id !== page.body.units[0].unit_id, "list: the second page differs", { returned: page2.body && page2.body.page.returned });
      const search = await api("GET", "/operator/inventory/corrections?q=H-P&limit=50", { token: F.adminTok });
      check(search.status === 200 && search.body.page.filtered_total === 6 && search.body.units.every((u) => /^H-P/.test(u.unit_number)), "list: a label search filters and reports its own total", { filtered: search.body && search.body.page.filtered_total });
      const h1 = await api("GET", "/operator/inventory/corrections/history?limit=2&offset=0", { token: F.adminTok });
      check(h1.status === 200 && h1.body.rows.length === 2 && h1.body.page.total === retiredIds.size + reversed && h1.body.retired_now === retiredIds.size && h1.body.reversed === reversed, "history: bounded rows with whole-property totals (retired now, reversed)", { page: h1.body && h1.body.page, retired_now: h1.body && h1.body.retired_now, reversed: h1.body && h1.body.reversed });
      F.live = live;
    });

    await section("ask spine · the entitled gather and answer path carries the same bounded explanation as the staff view", async () => {
      const ask = require("../../src/agent/ask_spine_answer");
      const facts = await ask.gatherFacts(pool, { property_id: F.h.id, allowed_modules: ["management"], subject: "tenancy", question: "Which units are retired from the rent roll and why?" });
      const ic = facts.tenancy && facts.tenancy.inventory_correction;
      const staff = (await api("GET", "/operator/inventory/corrections/history", { token: F.adminTok })).body.explanation;
      check(ic && ic.read_state === "OK" && ic.excluded_from_current_inventory === F.live.length && ic.excluded_records.map((r) => r.label).sort().join(",") === F.live.map((r) => r.label).sort().join(","), "gatherFacts (tenancy, management-entitled) carries the excluded records by label", { labels: ic && ic.excluded_records && ic.excluded_records.map((r) => r.label) });
      check(JSON.stringify(ic) === JSON.stringify(staff), "Ask Spine's gathered explanation is byte-identical to the staff history's explanation (same read, two projections)");
      check(!UUID_RE.test(JSON.stringify(facts.tenancy)) && !("property_id" in (facts.tenancy || {})), "no record, actor or property id survives sanitization in the tenancy facts", {});
      const none = await ask.gatherFacts(pool, { property_id: F.h.id, allowed_modules: ["maintenance"], subject: "tenancy", question: "Which units are retired from the rent roll and why?" });
      check(!none.tenancy || !none.tenancy.inventory_correction, "a session without leasing/management entitlement gathers no tenancy explanation", { tenancy: none.tenancy && none.tenancy.read_state });
      //  Deterministic wording stub: the sentence is BUILT FROM THE FACTS THE
      //  SERVER HANDED OVER — no model call. It proves what reaches the model
      //  and that the answer round-trips through the server's decision gate.
      let captured = null;
      const stub = { messages: { create: async (req) => {
        captured = req;
        const text = req.messages[0].content;
        const f = JSON.parse(text.slice(text.indexOf("FACTS:\n") + 7, text.lastIndexOf("\n\nOPERATOR ASKED:")));
        const x = f.tenancy && f.tenancy.inventory_correction;
        const answer = x ? `${x.excluded_from_current_inventory} unit records are retired from current inventory: ${x.excluded_records.map((r) => `${r.label} (${r.reason})`).join(", ")}. ${x.conflict ? "Operative work is attached to retired inventory." : "No operative work is attached to them."}` : "no correction facts";
        return { content: [{ type: "text", text: JSON.stringify({ outcome: "answered", answer }) }] };
      } } };
      const out = await ask.answer(pool, stub, { property_id: F.h.id, allowed_modules: ["management"], question: "Which units are retired from the rent roll and why?" });
      const payload = captured && captured.messages[0].content;
      check(out.outcome === "answered" && F.live.every((r) => out.answer.includes(r.label)) && out.answer.includes("superseded_by_corrected_inventory_grain") && /No operative work/.test(out.answer), "the answer names every excluded record and its reason from the gathered facts", { answer: out.answer });
      check(payload && !UUID_RE.test(payload) && payload.includes('"inventory_correction"') && F.live.every((r) => payload.includes(r.label)), "the model payload carried the explanation with labels and no internal ids", { bytes: payload && payload.length });
      const noAuth = await ask.answer(pool, stub, { property_id: F.h.id, allowed_modules: ["maintenance"], question: "Which units are retired from the rent roll and why?" });
      check(noAuth.outcome !== "answered" || !F.live.some((r) => (noAuth.answer || "").includes(r.label)), "an unentitled session gets no retired-record names", { outcome: noAuth.outcome, answer: noAuth.answer && noAuth.answer.slice(0, 120) });
      F.done = true;
    });
  } finally { await pool.end(); }
  current = "completion";
  check(F.done === true, "hardening: wall → concurrency → authority → identity → command identity → readers → Ask completed", { done: F.done });
  const summary = { passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length, witness: WITNESS };
  const outDir = process.env.PROOF_OUTPUT_DIR || path.join(require("node:os").tmpdir(), "inventory-correction-hardening");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `inventory_correction_hardening.${process.env.PROOF_EVIDENCE_LABEL || "run"}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  console.log(`\ninventory correction hardening${WITNESS ? " (witness)" : ""}: ${summary.passed} passed, ${failed} failed, ${summary.observations} observations`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
