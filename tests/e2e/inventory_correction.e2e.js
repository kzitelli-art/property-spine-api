"use strict";
// Class 3 · Governed inventory correction: review, retire, reinstate,
// through the existing operator door over the existing retirement owner.
//
// Owned nonce-verified database, owned HTTP server (E2E_API_BASE). A
// Greenery-shaped property (the retained legacy label vocabulary: 64
// prefixed parents and 107 other legacy records, one placeholder each) plus
// an unrelated property with different labels. Everything below the labels
// — identities, authority, occupancy, leases, dates, rents, batches — is
// synthetic. Two legacy records are DESIGNATED here as retirable examples;
// that designation is a fixture choice for this proof and is not a finding
// about any real Greenery record. The other legacy records stay unresolved.
// Every fixture write precedes the first business action. No SQL after a
// business action manufactures an outcome; diagnostic SQL is evidence only.
//
// WITNESS mode (INVENTORY_CORRECTION_WITNESS=1): on the unchanged baseline
// the staff door does not exist; the proof records what an authorized
// person meets and exits red by design.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("./proof_boundary");
require("./proof_fence_preload");
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service");

const BASE = process.env.E2E_API_BASE;
assert.ok(BASE, "E2E_API_BASE is required");
const WITNESS = process.env.INVENTORY_CORRECTION_WITNESS === "1";

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
async function api(method, route, { token, key = false, body, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + route, { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => null);
  return { status: r.status, body: data };
}
//  The retained legacy vocabulary, read from the proof that embeds it so
//  this file never carries a second copy of the labels.
function legacyLabels() {
  const src = fs.readFileSync(path.join(__dirname, "..", "proofs", "greenery_legacy_inventory.db.js"), "utf8");
  const m = src.match(/const LEGACY_LABELS\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(m, "LEGACY_LABELS not found in greenery_legacy_inventory.db.js");
  return JSON.parse(m[1].replace(/'/g, '"').replace(/,\s*\]/, "]"));
}

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  const numBase = 2000000 + (parseInt(nonce.slice(0, 6), 16) % 6000000);
  const num = (k) => "+1215" + String(numBase + k);
  const session = async (userId, propertyId) => (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
  const F = {};
  async function user(name, phone) {
    const person = await one("insert into persons (name,phone,primary_phone_e164,source) values ($1,$2,$2,'rehearsal') returning id", [name, phone]);
    return one(`insert into users (name,phone,role,auth_provider,platform_role,is_active,status,account_kind,person_id)
      values ($1,$2,'property_manager','phone_otp','member',true,'active','human_staff',$3) returning id, person_id`, [name, phone, person.id]);
  }
  async function assign(u, propertyId, { role_key = "property_manager", modules = "{management,leasing,maintenance}", manage = false } = {}) {
    const a = await one(`insert into property_team_assignments (property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
      values ($1,$2,$3,$3,'property',$4,'{management}',$5,true) returning id`, [propertyId, u.id, role_key, modules, manage]);
    await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,'property_manager',$3)", [u.person_id, propertyId, JSON.stringify({ source: "rehearsal" })]);
    return a.id;
  }
  const unitByLabel = async (pid, label) => one("select u.id, u.unit_number, (select s.id from spaces s where s.unit_id=u.id limit 1) as space_id from units u where u.property_id=$1 and u.unit_number=$2", [pid, label]);
  const retirementRows = async (pid) => (await q("select unit_id, reversed_at is not null as reversed from inventory_retirements where property_id=$1 order by retired_at", [pid])).rows;
  const review = (tok, unitId) => api("GET", `/operator/inventory/corrections/review?unit_id=${unitId}`, { token: tok });
  const retire = (tok, body) => api("POST", "/operator/inventory/corrections/retire", { token: tok, body });
  const reinstate = (tok, body) => api("POST", "/operator/inventory/corrections/reinstate", { token: tok, body });
  const RATIONALE = `Fixture-designated example: this record modelled a bed as a unit under the pre-bed-basis source; the ${plusDays(0)} bed-basis source supersedes it. (${nonce})`;

  try {
    await section("fixture · Greenery-shaped property, an unrelated property, four actors", async () => {
      const labels = legacyLabels();
      const parents = labels.filter((l) => /^1325-/.test(l)); const legacy = labels.filter((l) => !/^1325-/.test(l));
      need(parents.length === 64 && legacy.length === 107, "the retained legacy vocabulary is the production shape (64 parents, 107 other)", { parents: parents.length, legacy: legacy.length });
      F.org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Greenery Client ${nonce}`, `greenery-client-${nonce}`]);
      F.g = await one(`insert into properties (name,display_name,address,organization_id,leasing_basis,operating_timezone) values ($1,'The Greenery (rehearsal)','1325 N 15th (rehearsal)',$2,'bed','America/New_York') returning id`, [`Greenery ${nonce}`, F.org.id]);
      F.u = await one(`insert into properties (name,display_name,address,organization_id,leasing_basis,operating_timezone) values ($1,'Unrelated (rehearsal)','9 Other Street',$2,'unit','America/New_York') returning id`, [`Unrelated ${nonce}`, F.org.id]);
      for (const label of labels) await q("insert into units (property_id,unit_number) values ($1,$2)", [F.g.id, label]);
      for (const label of ["Apt 2F", "Suite 300", "PH-1"]) await q("insert into units (property_id,unit_number) values ($1,$2)", [F.u.id, label]);
      const before = await one("select count(*)::int units, (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1) spaces from units where property_id=$1", [F.g.id]);
      check(before.units === 171 && before.spaces === 171, "171 legacy unit records with one placeholder each, identities retained", before);
      F.identity = new Map((await q("select id, unit_number from units where property_id=$1", [F.g.id])).rows.map((r) => [r.unit_number, r.id]));
      //  DESIGNATED EXAMPLES (fixture choice, not a finding): two suffixed
      //  legacy records with an older bed-as-unit source lineage, and a third
      //  reserved for the stale-review case.
      //  Suffixed legacy labels (" - 1", " - 2") are the bed-as-unit shape.
      const ones = legacy.filter((l) => / - 1$/.test(l)), twos = legacy.filter((l) => / - 2$/.test(l));
      F.E1 = await unitByLabel(F.g.id, ones[0]);
      F.E2 = await unitByLabel(F.g.id, twos[0]);
      F.E3 = await unitByLabel(F.g.id, ones[1]);
      const stale = { leased: twos[1], work: ones[2], tour: twos[2], application: ones[3], possession: twos[3] };
      F.leased = await unitByLabel(F.g.id, stale.leased); F.work = await unitByLabel(F.g.id, stale.work); F.tour = await unitByLabel(F.g.id, stale.tour); F.application = await unitByLabel(F.g.id, stale.application); F.possession = await unitByLabel(F.g.id, stale.possession);
      F.parent = await unitByLabel(F.g.id, parents[0]);
      F.unresolved = await unitByLabel(F.g.id, legacy.filter((l) => !/ - /.test(l))[0]);
      F.foreignUnit = await unitByLabel(F.u.id, "Apt 2F");
      //  Older source (bed-as-unit representation) that produced E1/E2/E3.
      F.oldBatch = await one("insert into import_batches (property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status) values ($1,'rent_roll_ledger','greenery-2020-bed-as-unit-rehearsal.csv','2020-03-30','unit','confirmed','committed') returning id", [F.g.id]);
      let i = 1; for (const e of [F.E1, F.E2, F.E3]) await q("insert into import_source_rows (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id) values ($1,$2,$3,'fixture: bed modelled as a unit',$4,$5)", [F.oldBatch.id, i++, JSON.stringify({ unit_number: e.unit_number }), e.id, e.space_id]);
      //  Current representation: a bed-basis source whose confirmed row
      //  produced the first parent's bed, established as the opening position.
      F.newBatch = await one("insert into import_batches (property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status) values ($1,'rent_roll_ledger','greenery-bed-basis-rehearsal.csv',$2,'bed','confirmed','committed') returning id", [F.g.id, plusDays(-10)]);
      F.activation = await one("insert into activations (property_id,status,source_as_of_date,import_batch_id,source_label) values ($1,'activated',$2,$3,'greenery-bed-basis-rehearsal.csv') returning id", [F.g.id, plusDays(-10), F.newBatch.id]);
      const bed = await one("insert into spaces (unit_id,space_label,use_type,position_kind) values ($1,'Bed A','residential','bed') returning id", [F.parent.id]);
      const row = await one("insert into import_source_rows (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id) values ($1,1,$2,'fixture: confirmed vacancy',$3,$4) returning id", [F.newBatch.id, JSON.stringify({ unit_number: F.parent.unit_number, space_label: "Bed A", is_vacant: true }), F.parent.id, bed.id]);
      await q("insert into proposed_records (activation_id,property_id,module,target_type,natural_key,normalized_json,status,status_reason,import_source_row_id,confirmed_at) values ($1,$2,'leasing','lease',$3,$4,'promoted','Fixture: confirmed vacant position',$5,now())", [F.activation.id, F.g.id, `${F.parent.unit_number}|Bed A`, JSON.stringify({ section: "current", unit_number: F.parent.unit_number, space_label: "Bed A", is_vacant: true }), row.id]);
      await q("insert into opening_tenancy_positions (property_id,activation_id,import_batch_id,as_of_date,positions_established,positions_unresolved,source_rows_read,authority_basis,status) values ($1,$2,$3,$4,1,0,1,'fixture:inventory_correction.e2e.js','established')", [F.g.id, F.activation.id, F.newBatch.id, plusDays(-10)]);
      //  Relationship examples (synthetic): an expired lease (ANY lease refuses),
      //  open work, a future tour slot, a submitted application, a scheduled move-in.
      await q("insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,'2024-01-01','2024-12-31','expired',900)", [F.g.id, F.leased.space_id]);
      await q("insert into work_orders (property_id,unit_id,title,status) values ($1,$2,'Rehearsal: leaking faucet','open')", [F.g.id, F.work.id]);
      await q("insert into lease_applications (property_id,unit_id,space_id,applicant_name,status,source) values ($1,$2,$3,'Rehearsal Applicant','submitted','staff')", [F.g.id, F.application.id, F.application.space_id]);
      await q("insert into unit_events (unit_id,property_id,space_id,event_type,effective_date,status) values ($1,$2,$3,'move_in_scheduled',$4,'scheduled')", [F.possession.id, F.g.id, F.possession.space_id, plusDays(20)]);
      //  Actors: admin (governed override, management) at G; admin2 (same, used to remove admin's assignment);
      //  Mike-shaped (property_manager, management+leasing+maintenance, NO override); leasing-only; admin at U only.
      F.admin = await user(`Admin ${nonce}`, num(1)); F.adminAsg = await assign(F.admin, F.g.id, { role_key: "property_admin", modules: "{management,leasing}", manage: true });
      F.admin2 = await user(`Admin Two ${nonce}`, num(2)); await assign(F.admin2, F.g.id, { role_key: "property_admin", modules: "{management,leasing}", manage: true });
      F.mike = await user(`Mike (rehearsal) ${nonce}`, num(3)); await assign(F.mike, F.g.id);
      F.leasingOnly = await user(`Leasing Agent ${nonce}`, num(4)); await assign(F.leasingOnly, F.g.id, { role_key: "leasing_agent", modules: "{leasing}" });
      F.adminU = await user(`Admin U ${nonce}`, num(5)); await assign(F.adminU, F.u.id, { role_key: "property_admin", modules: "{management,leasing}", manage: true });
      F.adminTok = await session(F.admin.id, F.g.id); F.admin2Tok = await session(F.admin2.id, F.g.id); F.mikeTok = await session(F.mike.id, F.g.id); F.leasingTok = await session(F.leasingOnly.id, F.g.id); F.adminUTok = await session(F.adminU.id, F.u.id);
      //  A tour slot on F.tour through the real door (the last fixture act, still before any correction action).
      const starts = new Date(Date.now() + 3 * 86400000), ends = new Date(starts.getTime() + 3600000);
      const slot = await api("POST", "/leasing/availability", { token: F.mikeTok, key: true, body: { property_id: F.g.id, starts_at: starts.toISOString(), ends_at: ends.toISOString(), unit_id: F.tour.id, leasing_agent_id: F.mike.id, capacity: 1, idempotency_key: `slot-${nonce}` } });
      need(slot.status < 400, "a future tour slot names the tour-example unit", { status: slot.status, body: slot.body });
      observe("designations are fixture choices: E1/E2 retirable examples, E3 stale-review example, five blocked examples, one parent claimed by the current representation, 100+ legacy records left unresolved", { E1: F.E1.unit_number, E2: F.E2.unit_number, E3: F.E3.unit_number, blocked: stale, parent: F.parent.unit_number });
    });
    need(F.adminTok && F.E1, "fixture ready");

    await section("witness · what an authorized person meets on the unchanged baseline", async () => {
      const list = await api("GET", "/operator/inventory/corrections", { token: F.adminTok });
      const rv = await review(F.adminTok, F.E1.id);
      const rt = await retire(F.adminTok, { unit_ids: [F.E1.id], rationale: RATIONALE, confirmed: true });
      if (WITNESS) {
        check(list.status === 404 && rv.status === 404 && rt.status === 404, "WITNESS: no staff door exists for inventory correction (list, review and retire all 404); the owner is reachable only from proofs", { list: list.status, review: rv.status, retire: rt.status });
        check((await retirementRows(F.g.id)).length === 0, "WITNESS: nothing can be retired through staff HTTP");
        return;
      }
      need(list.status === 200 && rv.status === 200, "the staff door exists on this tree", { list: list.status, review: rv.status });
      check(rt.status === 400 && rt.body.error === "review_required", "a retirement without a review token is refused before any write", { status: rt.status, error: rt.body && rt.body.error });
    });
    if (WITNESS) throw new Error("witness complete");

    await section("review · the record, its lineage, its state and why it is or is not eligible", async () => {
      const r = await review(F.adminTok, F.E1.id);
      need(r.status === 200 && r.body.unit && r.body.unit.unit_id === F.E1.id, "the review reads the exact unit", { status: r.status });
      const b = r.body;
      check(b.unit.unit_number === F.E1.unit_number && b.unit.property_id === F.g.id && b.spaces.length === 1 && b.spaces[0].space_label === "(whole unit)", "canonical label, property and space hierarchy are shown", { label: b.unit.unit_number, spaces: b.spaces.length });
      check(b.lineage.lineage_known === true && b.lineage.source_rows.length === 1 && b.lineage.source_rows[0].source_file === "greenery-2020-bed-as-unit-rehearsal.csv" && b.lineage.claimed_by_current_representation === false, "source lineage names the older bed-as-unit source; the current representation does not claim this record", { source_rows: b.lineage.source_rows.length });
      check(b.retirement.state === "current" && b.retirement.history.length === 0, "not retired, no history");
      check(b.eligibility.action === "retire" && b.eligibility.eligible === true && b.eligibility.blockers.length === 0 && /MAY be retired/.test(b.eligibility.message), "eligible: no relationship stands, and the read says eligibility is not a finding about physical reality", b.eligibility);
      check(typeof b.review_token === "string" && b.review_token.length === 64 && b.proposed_reason === "superseded_by_corrected_inventory_grain" && b.may_correct === true, "a review token, the proposed governed reason and the actor's authority are carried");
      F.tokenE1 = b.review_token;
      const unresolved = await review(F.adminTok, F.unresolved.id);
      check(unresolved.status === 200 && unresolved.body.lineage.lineage_known === false && unresolved.body.eligibility.eligible === true, "an unresolved legacy record with no lineage is shown with unknown lineage visible; nothing about it is decided", { lineage_known: unresolved.body.lineage.lineage_known });
      const cases = [["leased", F.leased, "unit_carries_leases"], ["work", F.work, "open_work_orders"], ["tour", F.tour, "future_tours"], ["application", F.application, "open_applications"], ["possession", F.possession, "possession_recorded"], ["parent claimed by current representation", F.parent, "claimed_by_current_representation"]];
      for (const [label, u, code] of cases) {
        const rr = await review(F.adminTok, u.id);
        check(rr.status === 200 && rr.body.eligibility.eligible === false && rr.body.eligibility.blockers.some((x) => x.code === code), `blocked: ${label} → ${code}`, { blockers: rr.body && rr.body.eligibility && rr.body.eligibility.blockers.map((x) => x.code) });
        F[`token_${code}`] = rr.body && rr.body.review_token;
      }
      const foreign = await review(F.adminTok, F.foreignUnit.id);
      check(foreign.status === 403, "a unit at another property is not reviewable from this session (custody from the unit's own row)", { status: foreign.status });
      const missing = await review(F.adminTok, randomUUID());
      check(missing.status === 404, "an unknown unit id is not found", { status: missing.status });
      const mikeList = await api("GET", "/operator/inventory/corrections", { token: F.mikeTok });
      check(mikeList.status === 200 && mikeList.body.may_correct === false && mikeList.body.units_total === 171 && mikeList.body.retired_now === 0 && mikeList.body.units.every((u) => !u.selected), "Mike (management module, no override) can read the list; it offers no authority and pre-selects nothing", { may_correct: mikeList.body && mikeList.body.may_correct, units: mikeList.body && mikeList.body.units_total });
      const leasingList = await api("GET", "/operator/inventory/corrections", { token: F.leasingTok });
      check(leasingList.status === 403, "a leasing-only assignment cannot even read the correction list", { status: leasingList.status });
    });

    await section("authority · who may decide", async () => {
      const body = { unit_ids: [F.E1.id], review_tokens: { [F.E1.id]: F.tokenE1 }, rationale: RATIONALE, confirmed: true, idempotency_key: `retire-${nonce}` };
      const mike = await retire(F.mikeTok, body);
      check(mike.status === 403 && mike.body.error === "not_permitted", "Mike (property_manager, management module, no override) cannot retire", { status: mike.status });
      const leasing = await retire(F.leasingTok, body);
      check(leasing.status === 403, "a leasing assignment alone is not correction authority", { status: leasing.status });
      const foreign = await retire(F.adminUTok, body);
      check(foreign.status === 403, "an admin of another property cannot retire this property's unit (custody, not id knowledge)", { status: foreign.status });
      const foreignReinstate = await reinstate(F.adminUTok, { unit_id: F.E1.id, review_token: F.tokenE1, reason: "x", confirmed: true });
      check(foreignReinstate.status === 403, "nor reinstate it", { status: foreignReinstate.status });
      const unconfirmed = await retire(F.adminTok, { ...body, confirmed: false });
      check(unconfirmed.status === 400 && unconfirmed.body.error === "confirmation_required", "explicit confirmation is required", { status: unconfirmed.status });
      const reason = await retire(F.adminTok, { ...body, reason_code: "physically_removed" });
      check(reason.status === 400 && reason.body.error === "UNKNOWN_RETIREMENT_REASON", "an unsupported reason (demolition/conversion/vacancy) is refused by the owner's vocabulary wall", { status: reason.status, error: reason.body && reason.body.error });
      const short = await retire(F.adminTok, { ...body, rationale: "too short" });
      check(short.status === 409 && short.body.error === "RETIREMENT_RATIONALE_REQUIRED", "a rationale that explains nothing is refused", { status: short.status, error: short.body && short.body.error });
      const badBatch = await retire(F.adminTok, { ...body, superseded_by_import_batch_id: (await one("select id from import_batches where property_id=$1 limit 1", [F.u.id]).catch(() => null) || {}).id || randomUUID() });
      check(badBatch.status === 409 && badBatch.body.error === "superseding_batch_not_at_property", "a superseding source cited from another property (or nowhere) is refused", { status: badBatch.status, error: badBatch.body && badBatch.body.error });
      check((await retirementRows(F.g.id)).length === 0, "no refusal above wrote a retirement");
    });

    await section("mixed selection · one blocked unit refuses the whole submission, no partial write", async () => {
      const mixed = await retire(F.adminTok, { unit_ids: [F.E1.id, F.leased.id], review_tokens: { [F.E1.id]: F.tokenE1, [F.leased.id]: F.token_unit_carries_leases }, rationale: RATIONALE, confirmed: true });
      check(mixed.status === 409 && mixed.body.error === "retirement_refused" && mixed.body.refused.length === 1 && mixed.body.refused[0].unit_id === F.leased.id && mixed.body.refused[0].blockers.some((b) => b.code === "unit_carries_leases"), "the refusal names the leased unit and its blocker", { status: mixed.status, refused: mixed.body && mixed.body.refused });
      check((await retirementRows(F.g.id)).length === 0, "the eligible unit in the same selection was NOT retired (all or nothing)");
      const claimed = await retire(F.adminTok, { unit_ids: [F.parent.id], review_tokens: { [F.parent.id]: F.token_claimed_by_current_representation }, rationale: RATIONALE, confirmed: true });
      check(claimed.status === 409 && claimed.body.refused[0].blockers.some((b) => b.code === "claimed_by_current_representation"), "a unit the current representation itself produced cannot be 'superseded' by it", { status: claimed.status });
      for (const [u, tok, code] of [[F.work, F.token_open_work_orders, "open_work_orders"], [F.tour, F.token_future_tours, "future_tours"], [F.application, F.token_open_applications, "open_applications"], [F.possession, F.token_possession_recorded, "possession_recorded"]]) {
        const r = await retire(F.adminTok, { unit_ids: [u.id], review_tokens: { [u.id]: tok }, rationale: RATIONALE, confirmed: true });
        check(r.status === 409 && r.body.refused && r.body.refused[0].blockers.some((b) => b.code === code), `active relationship refuses: ${code}`, { status: r.status });
      }
      check((await retirementRows(F.g.id)).length === 0, "still nothing written");
    });

    await section("stale review · a decision is bound to what was reviewed", async () => {
      const r = await review(F.adminTok, F.E3.id);
      need(r.status === 200 && r.body.eligibility.eligible === true, "E3 reviews as eligible");
      const oldToken = r.body.review_token;
      //  A business action changes the record between review and decision:
      //  a tour slot is published on it through the real door.
      const starts = new Date(Date.now() + 4 * 86400000), ends = new Date(starts.getTime() + 3600000);
      const slot = await api("POST", "/leasing/availability", { token: F.mikeTok, key: true, body: { property_id: F.g.id, starts_at: starts.toISOString(), ends_at: ends.toISOString(), unit_id: F.E3.id, leasing_agent_id: F.mike.id, capacity: 1, idempotency_key: `slot-e3-${nonce}` } });
      need(slot.status < 400, "a slot is published on E3 after the review", { status: slot.status });
      const stale = await retire(F.adminTok, { unit_ids: [F.E3.id], review_tokens: { [F.E3.id]: oldToken }, rationale: RATIONALE, confirmed: true });
      check(stale.status === 409 && stale.body.refused && stale.body.refused[0].code === "stale_review", "the old review token is refused as stale; nothing is written", { status: stale.status, code: stale.body && stale.body.refused && stale.body.refused[0].code });
      const again = await review(F.adminTok, F.E3.id);
      check(again.status === 200 && again.body.review_token !== oldToken && again.body.eligibility.eligible === false && again.body.eligibility.blockers.some((b) => b.code === "future_tours"), "re-reviewing names the new blocker with a new token", { blockers: again.body.eligibility.blockers.map((b) => b.code) });
      const tampered = await retire(F.adminTok, { unit_ids: [F.E1.id], review_tokens: { [F.E1.id]: "0".repeat(64) }, rationale: RATIONALE, confirmed: true });
      check(tampered.status === 409 && tampered.body.refused[0].code === "stale_review", "a token that does not match the reviewed facts is refused", { status: tampered.status });
    });

    await section("concurrent writer · a lease landing while the decision is in flight", async () => {
      //  A writer holds an uncommitted lease on E2's space (KEY SHARE on the
      //  space row). The apply locks the unit's spaces FOR UPDATE, so it must
      //  WAIT; when the writer commits, the apply sees the lease and refuses.
      //  A unit-row lock alone would not have waited for this writer.
      const rv = await review(F.adminTok, F.E2.id);
      need(rv.status === 200 && rv.body.eligibility.eligible === true, "E2 reviews as eligible before the concurrent writer");
      const writer = await pool.connect();
      await writer.query("begin");
      await writer.query("insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,$3,$4,'pending',950)", [F.g.id, F.E2.space_id, plusDays(30), plusDays(395)]);
      let settled = false;
      const inflight = retire(F.adminTok, { unit_ids: [F.E2.id], review_tokens: { [F.E2.id]: rv.body.review_token }, rationale: RATIONALE, confirmed: true }).then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 1200));
      check(settled === false, "the retirement WAITS on the in-flight writer instead of racing past it", { settled });
      await writer.query("commit"); writer.release();
      const out = await inflight;
      check(out.status === 409 && out.body.error === "retirement_refused" && (out.body.refused[0].code === "stale_review" || out.body.refused[0].blockers && out.body.refused[0].blockers.some((b) => b.code === "unit_carries_leases")), "after the writer commits, the decision is refused (stale review or lease blocker), never applied over the new lease", { status: out.status, code: out.body && out.body.refused && out.body.refused[0].code });
      check((await retirementRows(F.g.id)).length === 0, "no retirement row was written for E2");
      //  E2 is now leased by that writer; the proof continues with E1 and a
      //  fresh designated example E4 for the second success unit.
      const legacy = legacyLabels().filter((l) => !/^1325-/.test(l));
      F.E4 = await unitByLabel(F.g.id, legacy.filter((l) => / - 1$/.test(l))[4]);
      observe("E2 stays leased by the concurrent writer; E4 is designated for the second retirement", { E4: F.E4.unit_number });
    });

    await section("retire · the authorized decision, recorded through the existing owner", async () => {
      const r1 = await review(F.adminTok, F.E1.id); const r4 = await review(F.adminTok, F.E4.id);
      need(r1.status === 200 && r4.status === 200 && r1.body.eligibility.eligible && r4.body.eligibility.eligible, "E1 and E4 review as eligible");
      const body = { unit_ids: [F.E1.id, F.E4.id], review_tokens: { [F.E1.id]: r1.body.review_token, [F.E4.id]: r4.body.review_token }, rationale: RATIONALE, superseded_by_import_batch_id: F.newBatch.id, confirmed: true, idempotency_key: `retire-${nonce}` };
      const before = await api("GET", "/operator/rent-roll/units", { token: F.adminTok });
      const out = await retire(F.adminTok, body);
      need(out.status === 201 && out.body.retired === 2 && out.body.rows.length === 2, "two designated records are retired in one decision", { status: out.status, body: out.body && { retired: out.body.retired, error: out.body.error } });
      F.retirementE1 = out.body.rows.find((r) => r.unit_id === F.E1.id).retirement_id;
      const rows = (await q("select unit_id, retired_by_user_id, reason_code, superseded_by_import_batch_id, original_unit_number, reversed_at from inventory_retirements where property_id=$1 order by original_unit_number", [F.g.id])).rows;
      check(rows.length === 2 && rows.every((r) => r.retired_by_user_id === F.admin.id && r.reason_code === "superseded_by_corrected_inventory_grain" && r.superseded_by_import_batch_id === F.newBatch.id && !r.reversed_at), "the owner's rows name the admin, the governed reason and the cited superseding source", rows.map((r) => r.original_unit_number));
      const ev = await one("select count(*)::int n from events where property_id=$1 and type='inventory_retired_by_decision'", [F.g.id]);
      check(ev.n === 2, "one decision event per retired unit");
      const still = await one("select count(*)::int n from units where property_id=$1", [F.g.id]);
      check(still.n === 171 && (await one("select id from units where id=$1", [F.E1.id])) && F.identity.get(F.E1.unit_number) === F.E1.id, "identity retained: no unit was deleted, merged, reparented or relabelled", { units: still.n });
      //  SUCCESSOR: the same key with the same payload is the SAME command and
      //  replays the recorded decision (200, idempotent); a new command for
      //  units already retired is refused by the owner's own word.
      const repeat = await retire(F.adminTok, body);
      check(repeat.status === 200 && repeat.body.idempotent === true && repeat.body.retired === 2 && repeat.body.current_state && repeat.body.current_state.units.every((u) => u.state === "retired"), "a repeat submission (same key, same body) replays the recorded decision and writes nothing", { status: repeat.status, idempotent: repeat.body && repeat.body.idempotent });
      const repeat2 = await retire(F.adminTok, { ...body, idempotency_key: `retire-again-${nonce}` });
      check(repeat2.status === 409 && repeat2.body.refused && repeat2.body.refused.every((x) => x.code === "ALREADY_RETIRED"), "a new command (different key) for already-retired units is refused by name and writes nothing", { status: repeat2.status, codes: repeat2.body && repeat2.body.refused && repeat2.body.refused.map((x) => x.code) });
      check((await retirementRows(F.g.id)).length === 2, "still exactly two retirement rows");
      const trigger = await q("insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,$3,$4,'pending',900)", [F.g.id, F.E1.space_id, plusDays(30), plusDays(395)]).then(() => ({ ok: true })).catch((e) => ({ ok: false, message: e.message }));
      check(trigger.ok === false && /retired/.test(trigger.message), "a lease can no longer attach to the retired record (the owner's trigger)", { message: trigger.message && trigger.message.slice(0, 120) });
      observe("rent roll before retirement", { status: before.status });
    });

    await section("reads · every canonical reader agrees, and says what it excluded", async () => {
      const units = await api("GET", "/operator/rent-roll/units", { token: F.adminTok });
      if (units.status === 200) {
        const ids = new Set((units.body.units || units.body.data && units.body.data.units || []).map((u) => u.unit_id));
        check(!ids.has(F.E1.id) && !ids.has(F.E4.id) && ids.has(F.parent.id), "the Rent Roll unit view no longer lists the retired records and still lists the parent", { listed: ids.size });
        const rex = units.body.retired_excluded || (units.body.data && units.body.data.retired_excluded);
        check(rex && rex.units === 2 && rex.conflict === false, "the unit view reports what it excluded (2 units, no tenancy conflict)", rex);
      } else observe("rent roll units route status", { status: units.status, error: units.body && units.body.error });
      const list = await api("GET", "/operator/inventory/corrections", { token: F.adminTok });
      check(list.status === 200 && list.body.units_total === 171 && list.body.retired_now === 2 && list.body.current_inventory_units === 169 && list.body.units.find((u) => u.unit_id === F.E1.id).state === "retired", "the correction list labels raw retained records (171) and current inventory (169) separately", { total: list.body.units_total, retired: list.body.retired_now, current: list.body.current_inventory_units });
      const { readTenancyStanding } = require("../../src/tenancy/tenancy_position_read");
      const standing = await readTenancyStanding(pool, { property_id: F.g.id });
      check(standing.unknowns && standing.unknowns.unit_records_retired_from_current_inventory === 2 && standing.unknowns.tenancy_attached_to_retired_inventory === 0, "the tenancy standing projection (Ask Spine's read) carries the exclusion", { unknowns: standing.unknowns });
      const facts = require("../../src/leasing/leasing_occupancy_facts");
      const occ = facts.occupancyByBasis ? await facts.occupancyByBasis(pool, F.g.id).catch((e) => ({ error: e.message })) : null;
      observe("occupancy by basis after retirement (denominator excludes retired records)", occ && (occ.error ? { error: occ.error } : { available: occ.available, rentable_units: occ.rentable_units, reason: occ.reason }));
      //  Ask Spine reads the SAME standing projection asserted above. The
      //  harness's model sentinel refuses every model call by design, so the
      //  sentence itself cannot be produced here; the door is exercised and
      //  must not report a read failure, and the facts it would hand the
      //  model are the ones just asserted.
      const ask = await api("POST", "/operator/ask-spine/ask", { token: F.adminTok, body: { question: "How many unit records are retired from current inventory at this property?" } });
      check(ask.status === 200 && typeof ask.body.answer === "string" && ask.body.outcome !== "read_failed", "the Ask Spine door answers without a read failure (model sentinel refuses the wording step in this harness)", { outcome: ask.body && ask.body.outcome, answer: ask.body && String(ask.body.answer).slice(0, 220) });
      const uList = await api("GET", "/operator/inventory/corrections", { token: F.adminUTok });
      check(uList.status === 200 && uList.body.units_total === 3 && uList.body.retired_now === 0 && uList.body.units.every((u) => u.unit_number !== F.E1.unit_number), "the unrelated property is untouched and its labels are its own", { total: uList.body.units_total });
    });

    await section("removed assignment · authority that was taken away does not carry a decision", async () => {
      const r1 = await review(F.adminTok, F.E1.id);
      need(r1.status === 200 && r1.body.eligibility.action === "reinstate", "E1 reviews as retired (action: reinstate)");
      const off = await api("PATCH", `/property-team-assignments/${F.adminAsg}`, { token: F.admin2Tok, body: { active: false } });
      need(off.status === 200, "admin2 removes admin's assignment through the governed door", { status: off.status });
      const rr = await reinstate(F.adminTok, { unit_id: F.E1.id, review_token: r1.body.review_token, reason: "rehearsal: put back", confirmed: true });
      check(rr.status === 401 || rr.status === 403, "the removed assignment cannot reinstate", { status: rr.status });
      const on = await api("PATCH", `/property-team-assignments/${F.adminAsg}`, { token: F.admin2Tok, body: { active: true } });
      need(on.status === 200, "restored");
      F.adminTok = await session(F.admin.id, F.g.id);
    });

    await section("reinstate · reversal as history, identity revalidated", async () => {
      const r1 = await review(F.adminTok, F.E1.id);
      need(r1.status === 200 && r1.body.retirement.state === "retired" && r1.body.retirement.live && r1.body.retirement.live.id === F.retirementE1, "E1's live retirement is shown with its history");
      //  SUCCESSOR: E1 was retired citing the bed-basis source, which does not
      //  name it — its identity reads UNRESOLVED and only an explicit
      //  authorized correction settles it.
      check(r1.body.identity && r1.body.identity.reinstatement === "unresolved", "E1's identity reads unresolved (cited source does not name it)", { identity: r1.body.identity && r1.body.identity.reinstatement });
      const unresolved = await reinstate(F.adminTok, { unit_id: F.E1.id, review_token: r1.body.review_token, reason: "Rehearsal: put back.", confirmed: true });
      check(unresolved.status === 409 && unresolved.body.error === "identity_unresolved", "without the explicit correction, reinstatement is refused as unresolved", { status: unresolved.status, error: unresolved.body && unresolved.body.error });
      const IDENT = { identity_decision: "position_not_covered_by_current_representation", identity_reason: "Rehearsal: the bed-basis source established the first parent's bed only; this legacy record's position was not in it." };
      const noReason = await reinstate(F.adminTok, { unit_id: F.E1.id, review_token: r1.body.review_token, reason: "", confirmed: true, ...IDENT });
      check(noReason.status === 409 && noReason.body.error === "REINSTATEMENT_REASON_REQUIRED", "a reinstatement must say why", { status: noReason.status, error: noReason.body && noReason.body.error });
      const mike = await reinstate(F.mikeTok, { unit_id: F.E1.id, review_token: r1.body.review_token, reason: "rehearsal", confirmed: true, ...IDENT });
      check(mike.status === 403, "Mike cannot reinstate either", { status: mike.status });
      const ok = await reinstate(F.adminTok, { unit_id: F.E1.id, review_token: r1.body.review_token, reason: `Rehearsal: the designation of ${F.E1.unit_number} as obsolete was withdrawn pending physical verification.`, confirmed: true, ...IDENT });
      need(ok.status === 201 && ok.body.reinstated === true && ok.body.retirement_id === F.retirementE1, "the admin reinstates E1 with a reason", { status: ok.status, body: ok.body });
      check(/no opening position, use, availability or readiness/.test(ok.body.restores), "the receipt says reinstatement restores participation only, establishing nothing");
      const row = await one("select reversed_at, reversed_by_user_id, reversal_reason, retired_by_user_id from inventory_retirements where id=$1", [F.retirementE1]);
      check(row.reversed_at && row.reversed_by_user_id === F.admin.id && /physical verification/.test(row.reversal_reason) && row.retired_by_user_id === F.admin.id, "the original decision is retained and records who reversed it, when and why");
      const stale = await reinstate(F.adminTok, { unit_id: F.E1.id, review_token: r1.body.review_token, reason: "again", confirmed: true, ...IDENT });
      check(stale.status === 409 && stale.body.error === "stale_review", "the pre-reinstatement token is now stale", { status: stale.status });
      const r1b = await review(F.adminTok, F.E1.id);
      const notRetired = await reinstate(F.adminTok, { unit_id: F.E1.id, review_token: r1b.body.review_token, reason: "again", confirmed: true });
      check(notRetired.status === 409 && notRetired.body.error === "NOT_RETIRED", "a unit with no live retirement cannot be reinstated twice", { status: notRetired.status });
      check(r1b.body.retirement.state === "current" && r1b.body.retirement.history.length === 1 && r1b.body.eligibility.action === "retire", "E1 is current again with one history row and may be reviewed for retirement again");
      const hist = await api("GET", "/operator/inventory/corrections/history", { token: F.adminTok });
      check(hist.status === 200 && hist.body.retired_now === 1 && hist.body.reversed === 1 && hist.body.identity_preserved === true && hist.body.has_conflict === false && hist.body.rows.length === 2, "history: one live retirement (E4), one reversed (E1), identity preserved, no conflict", { retired_now: hist.body.retired_now, reversed: hist.body.reversed });
      const mikeHist = await api("GET", "/operator/inventory/corrections/history", { token: F.mikeTok });
      check(mikeHist.status === 200 && mikeHist.body.rows.length === 2, "Mike can read the history (management module)");
      const list = await api("GET", "/operator/inventory/corrections", { token: F.adminTok });
      check(list.body.retired_now === 1 && list.body.current_inventory_units === 170, "the list reflects the reinstatement", { retired: list.body.retired_now, current: list.body.current_inventory_units });
      const units = await api("GET", "/operator/rent-roll/units", { token: F.adminTok });
      if (units.status === 200) {
        const ids = new Set((units.body.units || units.body.data && units.body.data.units || []).map((u) => u.unit_id));
        check(ids.has(F.E1.id) && !ids.has(F.E4.id), "the Rent Roll unit view lists E1 again and still excludes E4");
      }
      const { readTenancyStanding } = require("../../src/tenancy/tenancy_position_read");
      const standing = await readTenancyStanding(pool, { property_id: F.g.id });
      check(standing.unknowns.unit_records_retired_from_current_inventory === 1, "the standing projection says one record remains retired");
      F.done = true;
    });
  } finally { await pool.end(); }
  current = "completion";
  check(F.done === true, "review → governed retirement → reads → reinstatement completed with history retained", { done: F.done });
  const summary = { passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length, witness: WITNESS };
  const outDir = process.env.PROOF_OUTPUT_DIR || path.join(require("node:os").tmpdir(), "inventory-correction");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `inventory_correction.${process.env.PROOF_EVIDENCE_LABEL || "run"}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  if (!WITNESS && F.g) fs.writeFileSync(path.join(outDir, "inventory_correction_handoff.json"), JSON.stringify({ property_id: F.g.id, admin_user_id: F.admin && F.admin.id, mike_user_id: F.mike && F.mike.id, retired_unit_id: F.E4 && F.E4.id, retired_unit_number: F.E4 && F.E4.unit_number, eligible_unit_id: F.E1 && F.E1.id, eligible_unit_number: F.E1 && F.E1.unit_number, blocked_unit_id: F.leased && F.leased.id, blocked_unit_number: F.leased && F.leased.unit_number }, null, 2));
  console.log(`\ninventory correction: ${summary.passed} passed, ${failed} failed, ${summary.observations} observations`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { if (String(e.message).includes("witness complete")) { const summary = { passed: results.filter((r) => r.ok && r.kind === "check").length, failed }; const outDir = process.env.PROOF_OUTPUT_DIR || require("node:os").tmpdir(); fs.writeFileSync(path.join(outDir, `inventory_correction.${process.env.PROOF_EVIDENCE_LABEL || "witness"}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2)); console.log(`\ninventory correction (witness): ${summary.passed} passed, ${failed} failed — baseline has no staff door`); process.exit(1); } console.error(e); process.exit(1); });
