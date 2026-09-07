/* ════════════════════════════════════════════════════════════════════
   existing_mixed_inventory_hold.db.js — A PROPERTY ALREADY CARRIES A
   CONFIRMED '(whole unit)' SENTINEL BESIDE CONFIRMED NAMED ROOMS. WHAT CAN
   AN AUTHORIZED PERSON TRUTHFULLY DO TODAY TO STOP OFFERING THE DISPUTED
   POSITION WITHOUT DESTROYING ITS HISTORY?

   Observation proof. The fixture is the recorded historical shape, built
   from rows the old writer left (direct inserts, the way the e2e fixture
   is built) — NOT a new import, which the current materializer refuses.
   Every candidate path is the existing owner's own HTTP door where one
   exists, and the service where none does. Each is read through four
   consumers: canonical availability, the leaseable-units application
   selector, the unit Rent Roll, and the tenancy standing read that Ask
   Spine grounds on. A neighbouring real room is the control; an
   un-entitled session and a wrong operator key are the refusals.

   Caller-owned proof database; no production path; synthetic rows only.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const activation = require(path.join(root, "src/onboarding/activation_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
const sessions = require(path.join(root, "src/identity/staff_session_service.js"));
const retirement = require(path.join(root, "src/tenancy/inventory_retirement.js"));
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const { unitRentRoll } = require(path.join(root, "src/surfaces/rent_roll_unit_view.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const askSpine = require(path.join(root, "src/agent/ask_spine_answer.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const AS_OF = "2026-07-31";
const api = process.env.E2E_API_BASE || null;
if (!api) { console.error("This proof exercises HTTP doors; set E2E_API_BASE (owned server)."); process.exit(1); }
const OPERATOR_KEY = process.env.PROOF_OPERATOR_KEY || "e2e-key";
const evidence = { rung: "real HTTP through the owned server for every door that has one; services where none does", candidates: {} };

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const all = async (sql, args = []) => (await pool.query(sql, args)).rows;
  try {
    const tag = `mixed-hold-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const mkUser = async (name, mods) => {
      const person = await one("insert into persons(name) values($1) returning id", [name]);
      return one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
        values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`, [name, `${tag}-${mods.join("-")}@example.test`, org.id, person.id]);
    };
    const operator = await mkUser("Synthetic Hold Operator", ["management", "leasing", "maintenance"]);
    const maintOnly = await mkUser("Synthetic Maintenance Only", ["maintenance"]);

    const http = async (token, url, { method = "GET", body = null, form = null, key = null } = {}) => {
      const headers = {};
      if (token) headers["x-staff-session"] = token;
      if (key) headers["x-operator-key"] = key;
      let payload;
      if (form) payload = form; else if (method !== "GET") { headers["content-type"] = "application/json"; payload = JSON.stringify(body || {}); }
      const r = await fetch(api + url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
      let json = null; try { json = await r.json(); } catch (_) { json = null; }
      return { status: r.status, body: json };
    };
    const session = async (userId, propertyId) => {
      const c = await pool.connect();
      try { await c.query("begin"); const t = (await sessions.issueStaffSession(c, { userId, propertyId, purpose: "sms_otp" })).session_token; await c.query("commit"); return t; } finally { c.release(); }
    };

    //  ── THE HISTORICAL FIXTURE ────────────────────────────────────────
    //  Bed property. Unit 301: '(whole unit)' placeholder retained beside
    //  Room1 and Room2, ALL THREE confirmed vacant with lineage under one
    //  established baseline (the old writer's shape). Unit 302: Room1 and
    //  Room2, the property-level neighbour. Use type configured on every
    //  position so availability answers the inventory question.
    async function fixture(name) {
      const deal = await deals.createDeal(pool, { user_id: operator.id, deal_name: `${tag}-${name}`, creation_source: "deal_setup_console" });
      const p = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id", [`${tag}-${name}`, org.id]);
      await deals.addProperty(pool, { user_id: operator.id, deal_intake_id: deal.id, property_id: p.id });
      for (const [u, mods] of [[operator, "{management,leasing,maintenance}"], [maintOnly, "{maintenance}"]]) {
        await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof Seat',$3,true)", [p.id, u.id, mods]);
      }
      const units = {}, spaces = {};
      for (const [n, labels] of [["301", ["(whole unit)", "Room1", "Room2"]], ["302", ["Room1", "Room2"]]]) {
        const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, n]); units[n] = u.id;
        const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
        for (const label of labels) {
          const s = label === "(whole unit)" ? placeholder
            : (label === "Room1" && n === "302")
              ? await one("update spaces set space_label='Room1', position_kind='bed' where id=$1 returning id", [placeholder.id])
              : await one("insert into spaces(unit_id,space_label,position_kind) values($1,$2,'bed') returning id", [u.id, label]);
          spaces[`${n}|${label}`] = s.id;
        }
      }
      await pool.query("update spaces set use_type='residential' where unit_id in (select id from units where property_id=$1)", [p.id]);
      const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
        values($1,'rent_roll_ledger','historical.csv',$2,'bed','confirmed','committed') returning id`, [p.id, AS_OF]);
      const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
        values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, p.id, AS_OF, batch.id, operator.id]);
      let i = 0;
      for (const key of Object.keys(spaces)) {
        const [n, label] = key.split("|"); i += 1;
        const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
          values($1,$2,$3,'historical: confirmed vacancy',$4,$5) returning id`, [batch.id, i, JSON.stringify({ unit_number: n, space_label: label, is_vacant: true }), units[n], spaces[key]]);
        await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
          values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`, [act.id, p.id, key, JSON.stringify({ section: "current", unit_number: n, space_label: label, is_vacant: true }), ev.id, String(operator.id)]);
      }
      await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
        positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
        values($1,$2,$3,$4,$5,5,0,5,$6,'platform_role:super_admin','established') returning id`, [p.id, deal.id, act.id, batch.id, AS_OF, operator.id]);
      return { id: p.id, deal: deal.id, name, units, spaces, token: await session(operator.id, p.id), maintToken: await session(maintOnly.id, p.id) };
    }

    //  ── FOUR CONSUMERS, ONE READ ──────────────────────────────────────
    async function consumers(p) {
      const av = await http(p.token, `/operator/leasing/availability-canonical?as_of=${AS_OF}`);
      const lu = await http(p.token, `/operator/leasing/leaseable-units`);
      const rr = await http(p.token, `/operator/rent-roll/units?as_of=${AS_OF}`);
      const ask = await http(p.token, `/operator/ask-spine/ask`, { method: "POST", body: { question: "How many rentable positions are open right now?" } });
      const standing = await readTenancyStanding(pool, { property_id: p.id, as_of: AS_OF });
      const facts = await askSpine.gatherFacts(pool, { property_id: p.id, allowed_modules: ["management", "leasing"], subject: "tenancy", question: "how many positions are open" });
      const row = (label, unit = "301") => ((av.body && av.body.rows) || []).find((r) => r.unit_number === unit && r.space_label === label) || {};
      const rrUnit = (n) => ((rr.body && rr.body.units) || []).find((u) => u.unit_number === n) || {};
      const rrLine = (label, n = "301") => ((rrUnit(n).positions) || []).find((x) => x.label === label) || {};
      return {
        http_status: { availability: av.status, leaseable: lu.status, rent_roll: rr.status, ask: ask.status },
        availability: { placeholder: row("(whole unit)").marketing_state, room1: row("Room1").marketing_state, room2: row("Room2").marketing_state, n302_room1: row("Room1", "302").marketing_state, placeholder_reason: row("(whole unit)").blocking_reason || row("(whole unit)").reason || null },
        leaseable_301: ((lu.body && lu.body.eligible_targets) || []).filter((t) => t.unit_number === "301").map((t) => t.space_label).sort(),
        leaseable_302: ((lu.body && lu.body.eligible_targets) || []).filter((t) => t.unit_number === "302").map((t) => t.space_label).sort(),
        rent_roll: { positions_301: rrUnit("301").rentable_positions, placeholder_bucket: rrLine("(whole unit)").bucket, placeholder_basis: rrLine("(whole unit)").basis_state, room1_bucket: rrLine("Room1").bucket },
        standing: { truth_state: standing.standing && standing.standing.truth_state, why: standing.standing && standing.standing.why, rentable_positions: standing.position && standing.position.rentable_positions, open: standing.position && standing.position.open, not_established: standing.position && standing.position.not_established, unknowns: standing.unknowns },
        ask_http: { outcome: ask.body && ask.body.outcome, grounded_keys: ask.body && ask.body.grounded_on ? Object.keys(ask.body.grounded_on) : null, tenancy_in_grounding: !!(ask.body && ask.body.grounded_on && ask.body.grounded_on.tenancy) },
        ask_facts: facts.tenancy ? { read_state: facts.tenancy.read_state, truth_state: facts.tenancy.standing && facts.tenancy.standing.truth_state, open: facts.tenancy.position && facts.tenancy.position.open, rentable_positions: facts.tenancy.position && facts.tenancy.position.rentable_positions } : null,
      };
    }
    const show = (label, c) => console.log(`  ${label}: ${JSON.stringify(c)}`);

    // ── 0. BASELINE: the historical shape, as it reads today ───────────
    const base = await fixture("baseline");
    const b0 = await consumers(base);
    evidence.baseline = b0; show("baseline", b0);
    ok("0: every consumer answers 200 (availability, leaseable-units, rent-roll/units, ask-spine/ask)", Object.values(b0.http_status).every((s) => s === 200), JSON.stringify(b0.http_status));
    ok("0: the confirmed placeholder is offered marketable_now beside two marketable rooms", b0.availability.placeholder === "marketable_now" && b0.availability.room1 === "marketable_now" && b0.availability.room2 === "marketable_now");
    ok("0: the application selector lists three targets on 301, the placeholder included", b0.leaseable_301.join("|") === "(whole unit)|Room1|Room2", b0.leaseable_301.join("|"));
    ok("0: Rent Roll counts three rentable positions on 301 and buckets the placeholder open", b0.rent_roll.positions_301 === 3 && b0.rent_roll.placeholder_bucket === "open");
    ok("0: standing (the read Ask grounds on) says ESTABLISHED with 5 rentable positions, 5 open", b0.standing.truth_state === "ESTABLISHED" && b0.standing.rentable_positions === 5 && b0.standing.open === 5, JSON.stringify(b0.standing));
    ok("0: Ask over HTTP returns 200 with an outcome; the model is refused by the e2e sentinel so the outcome is not 'answered' (recorded, not asserted further)", b0.ask_http.outcome != null, JSON.stringify(b0.ask_http));
    ok("0: gatherFacts(subject tenancy) carries the same standing counts Ask would ground on", b0.ask_facts && b0.ask_facts.read_state === "OK" && b0.ask_facts.open === 5, JSON.stringify(b0.ask_facts));

    // ── A. SOURCE CORRECTION: a corrected rent roll in a new setup ──────
    //  The existing owner's HTTP door: upload → activation → read-source →
    //  confirm → establish. The corrected file names Room1 and Room2 only.
    const A = await fixture("source-correction");
    {
      const csv = "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n301,Room1,VACANT,900,,,\n301,Room2,VACANT,900,,,\n302,Room1,VACANT,900,,,\n302,Room2,VACANT,900,,,\n";
      const form = new FormData(); form.append("file", new Blob([csv], { type: "text/csv" }), "corrected.csv"); form.append("source_as_of_date", AS_OF);
      const up = await http(A.token, `/deal-setup/deals/${A.deal}/properties/${A.id}/source`, { method: "POST", form });
      const opened = await http(A.token, `/deal-setup/deals/${A.deal}/properties/${A.id}/activation`, { method: "POST" });
      const actId = opened.body && opened.body.activation && opened.body.activation.id;
      const read = await http(A.token, `/deal-setup/activations/${actId}/read-source`, { method: "POST", body: { source_artifact_id: up.body && up.body.artifact && up.body.artifact.id, source_as_of_date: AS_OF } });
      const proposals = ((await http(A.token, `/deal-setup/activations/${actId}`)).body || {}).proposals || [];
      const confirms = []; for (const q of proposals) confirms.push([q.natural_key, (await http(A.token, `/deal-setup/proposals/${q.id}/confirm`, { method: "POST" })).status]);
      const est = await http(A.token, `/deal-setup/activations/${actId}/establish`, { method: "POST" });
      const spacesNow = await all("select u.unit_number, s.space_label from spaces s join units u on u.id=s.unit_id where u.property_id=$1 order by 1,2", [A.id]);
      const cA = await consumers(A);
      const history = { superseded_baselines: (await one("select count(*)::int as n from opening_tenancy_positions where property_id=$1 and superseded_at is not null", [A.id])).n,
        placeholder_claim_promoted: (await one("select count(*)::int as n from proposed_records where property_id=$1 and natural_key='301|(whole unit)' and status='promoted'", [A.id])).n };
      evidence.candidates.source_correction = { upload: up.status, read: read.status, read_error: read.body && read.body.error, confirms, establish: est.status, spaces: spacesNow, consumers: cA, history };
      show("A source correction", evidence.candidates.source_correction);
      ok("A: the corrected file reads (201) with the unit already materialized — the new-writer guard is not reached, rows reconcile to existing labels", read.status === 201, JSON.stringify(read.body));
      ok("A: all four corrected rows confirm 200 and the new baseline establishes 201", confirms.every((c) => c[1] === 200) && est.status === 201, JSON.stringify(confirms));
      ok("A: no position is created or removed — 301 still carries three, the placeholder among them", spacesNow.filter((s) => s.unit_number === "301").length === 3);
      ok("A: availability holds the placeholder occupancy_unknown and keeps Room1/Room2 and 302 marketable (space-level, neighbours untouched)",
        cA.availability.placeholder === "occupancy_unknown" && cA.availability.room1 === "marketable_now" && cA.availability.room2 === "marketable_now" && cA.availability.n302_room1 === "marketable_now", JSON.stringify(cA.availability));
      ok("A: the application selector drops the placeholder and keeps both rooms", cA.leaseable_301.join("|") === "Room1|Room2", cA.leaseable_301.join("|"));
      ok("A (meaning that fails to travel): Rent Roll still counts the placeholder as a rentable position — basis not_established, no bucket, denominator unchanged at 3",
        cA.rent_roll.positions_301 === 3 && cA.rent_roll.placeholder_basis === "not_established" && cA.rent_roll.placeholder_bucket == null, JSON.stringify(cA.rent_roll));
      ok("A (meaning that fails to travel): standing/Ask says PARTIALLY_ESTABLISHED, '4 of 5 … 1 do not' — the disputed position is reported as a real position with unknown occupancy, never as disputed",
        cA.standing.truth_state === "PARTIALLY_ESTABLISHED" && cA.standing.rentable_positions === 5 && cA.standing.not_established === 1 && /4 of 5/.test(cA.standing.why || ""), JSON.stringify(cA.standing));
      ok("A: history preserved — the first baseline is superseded, not deleted, and the placeholder's promoted claim remains", history.superseded_baselines === 1 && history.placeholder_claim_promoted === 1, JSON.stringify(history));
    }

    // ── B. MARK THE UNIT DOWN (the closest thing to a marketing hold) ───
    const B = await fixture("down");
    {
      const wrongKey = await http(null, `/units/${B.units["301"]}/down`, { method: "POST", key: "not-the-key", body: { down_reason: "hvac", down_blocker: "synthetic: hold the disputed position" } });
      const down = await http(null, `/units/${B.units["301"]}/down`, { method: "POST", key: OPERATOR_KEY, body: { down_reason: "hvac", down_blocker: "synthetic: hold the disputed position" } });
      const cB = await consumers(B);
      const resolve = await http(null, `/units/${B.units["301"]}/down/resolve`, { method: "PATCH", key: OPERATOR_KEY, body: { resolution_note: "synthetic: restore" } });
      const cB2 = await consumers(B);
      evidence.candidates.down = { wrong_key: wrongKey.status, down: down.status, consumers: cB, resolve: resolve.status, after_resolve: cB2.availability };
      show("B down", evidence.candidates.down);
      ok("B (entitlement): a wrong x-operator-key is refused 401 — this door is keyed, not session-scoped to a property", wrongKey.status === 401, String(wrongKey.status));
      ok("B: marking the unit down succeeds (201/200) and availability answers 'down' for the placeholder", [200, 201].includes(down.status) && cB.availability.placeholder === "down", JSON.stringify([down.status, cB.availability]));
      ok("B (neighbour control FAILS): the hold is unit-grained — Room1 and Room2 on 301 are also 'down'; 302 is untouched",
        cB.availability.room1 === "down" && cB.availability.room2 === "down" && cB.availability.n302_room1 === "marketable_now", JSON.stringify(cB.availability));
      ok("B: the application selector offers nothing on 301 and still offers 302", cB.leaseable_301.length === 0 && cB.leaseable_302.length === 2, JSON.stringify([cB.leaseable_301, cB.leaseable_302]));
      ok("B (meaning that fails to travel): Rent Roll and standing/Ask ignore 'down' — the placeholder is still bucketed open and standing still says 5 open",
        cB.rent_roll.placeholder_bucket === "open" && cB.standing.open === 5, JSON.stringify([cB.rent_roll, cB.standing.open]));
      ok("B: resolving the down restores all three positions to marketable_now (history event kept)", resolve.status === 200 && cB2.availability.placeholder === "marketable_now" && cB2.availability.room1 === "marketable_now", JSON.stringify(cB2.availability));
    }

    // ── C. TRIAGE: a confirmed severe condition ──────────────────────
    const C = await fixture("triage");
    {
      const body = { text: "synthetic: severe condition, hold", vacancy_observation: "vacant", initial_condition: "severe", inspection_completeness: "initial_triage" };
      const other = await session(operator.id, B.id);   // a session on ANOTHER property
      const foreign = await http(other, `/operator/units/${C.units["301"]}/triage/confirm`, { method: "POST", body });
      const noModule = await http(C.token, `/operator/leasing/leaseable-units`.replace("leaseable-units", "leaseable-units"), {});
      const maintOnlyLeasing = await http(C.maintToken, `/operator/leasing/leaseable-units`);
      const triage = await http(C.token, `/operator/units/${C.units["301"]}/triage/confirm`, { method: "POST", body });
      const cC = await consumers(C);
      evidence.candidates.triage = { foreign_property: foreign.status, maintenance_only_on_leasing_selector: maintOnlyLeasing.status, triage: triage.status, consumers: cC };
      show("C triage", evidence.candidates.triage);
      ok("C (entitlement): a session on another property is refused 403 at the triage door", foreign.status === 403, String(foreign.status));
      ok("C (entitlement): a maintenance-only seat is refused 403 at the leaseable-units selector", maintOnlyLeasing.status === 403, String(maintOnlyLeasing.status));
      ok("C: the severe triage confirms (201) and availability holds the placeholder not_ready_confirmed", triage.status === 201 && cC.availability.placeholder === "not_ready_confirmed", JSON.stringify([triage.status, triage.body && triage.body.error, cC.availability]));
      ok("C (neighbour control FAILS): unit-grained again — Room1 and Room2 are held not_ready_confirmed too; 302 untouched",
        cC.availability.room1 === "not_ready_confirmed" && cC.availability.room2 === "not_ready_confirmed" && cC.availability.n302_room1 === "marketable_now", JSON.stringify(cC.availability));
      ok("C: nothing on 301 is application-offerable; 302 still is", cC.leaseable_301.length === 0 && cC.leaseable_302.length === 2);
      ok("C (meaning that fails to travel): Rent Roll and standing/Ask ignore readiness — placeholder still open, 5 open", cC.rent_roll.placeholder_bucket === "open" && cC.standing.open === 5);
      void noModule;
    }

    // ── D. ACTUAL RETIREMENT (service only — no HTTP caller exists) ────
    const D = await fixture("retirement");
    {
      const tx = async (fn) => { const c = await pool.connect(); try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
      const spaceRetire = retirement.retireInventorySpaces || retirement.retireSpace || null;
      const ret = await tx((c) => retirement.retireInventoryUnits(c, { property_id: D.id, unit_ids: [D.units["301"]], rationale: "Synthetic proof: is retirement a way to hold one disputed position?", actor: { user_id: operator.id } }));
      const cD = await consumers(D);
      const reinst = await tx((c) => retirement.reinstateInventoryUnit(c, { unit_id: D.units["301"], actor: { user_id: operator.id }, reason: "Synthetic proof: restore" }));
      const cD2 = await consumers(D);
      evidence.candidates.retirement = { space_level_writer_exported: !!spaceRetire, retired: ret && ret.retired ? ret.retired.length : null, consumers: cD, reinstated: reinst && reinst.reinstated, after: cD2.availability };
      show("D retirement", evidence.candidates.retirement);
      ok("D: no space-level retirement writer is exported by inventory_retirement.js", !spaceRetire);
      ok("D: retiring unit 301 removes ALL THREE positions from every consumer — the real rooms go with the phantom; 302 remains",
        cD.availability.placeholder == null && cD.availability.room1 == null && cD.availability.n302_room1 === "marketable_now" && cD.leaseable_301.length === 0 && cD.rent_roll.positions_301 == null && cD.standing.rentable_positions === 2, JSON.stringify(cD));
      ok("D: reinstatement restores all three, claims and baseline intact", reinst.reinstated === true && cD2.availability.placeholder === "marketable_now" && cD2.availability.room1 === "marketable_now", JSON.stringify(cD2.availability));
    }

    if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, "existing-mixed-inventory-hold.json"), JSON.stringify(evidence, null, 2));
  } finally { await pool.end(); }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
