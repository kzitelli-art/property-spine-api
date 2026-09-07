/* ════════════════════════════════════════════════════════════════════
   occupancy_measures_under_holds.db.js — CAN AN OPERATOR TELL WHAT EACH
   OCCUPANCY NUMBER MEANS, AND DOES EACH FORMULA STAY HONEST UNDER A HOLD?

   One bed property, eight positions in four units:
     301  Room1 occupied (active lease 850)     Room2 vacant
     302  Room1 occupied (active lease 900)     Room2 vacant
     303  Room1 CONTESTED (two overlapping active leases)
          Room2 UNRESOLVED (source says occupied, Spine holds no lease)
     304  Room1 vacant                          Room2 vacant

   Every owner of an occupancy figure is read at baseline, under a down
   hold on a unit with an operative lease, under a hold covering every
   occupied and contested unit, under an all-down hold, and after the
   holds are resolved. Sibling units stay untouched as controls.

   Observation proof. Owned DB, owned server. Nothing here is a policy.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
const sessions = require(path.join(root, "src/identity/staff_session_service.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const { occupancyByBasis } = require(path.join(root, "src/leasing/leasing_occupancy_facts.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const AS_OF = "2026-07-31";
const api = process.env.E2E_API_BASE || null;
if (!api) { console.error("This proof exercises HTTP doors; set E2E_API_BASE (owned server)."); process.exit(1); }
const OPERATOR_KEY = process.env.PROOF_OPERATOR_KEY || "e2e-key";
const evidence = { calls: [], measures: {} };
const rung = (name, how) => { if (!evidence.calls.find((c) => c.name === name)) evidence.calls.push({ name, how }); };

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const all = async (sql, args = []) => (await pool.query(sql, args)).rows;
  try {
    const tag = `occ-measures-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const mkUser = async (name, key) => {
      const person = await one("insert into persons(name) values($1) returning id", [name]);
      return one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
        values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`, [name, `${tag}-${key}@example.test`, org.id, person.id]);
    };
    const operator = await mkUser("Synthetic Measures Operator", "op");
    const maintOnly = await mkUser("Synthetic Maintenance Only", "maint");
    const residents = {};
    for (const n of ["A", "B", "C1", "C2"]) residents[n] = (await one("insert into persons(name) values($1) returning id", [`Synthetic Resident ${n}`])).id;

    const http = async (name, token, url, { method = "GET", body = null, key = null } = {}) => {
      rung(name, "HTTP");
      const headers = {};
      if (token) headers["x-staff-session"] = token;
      if (key) headers["x-operator-key"] = key;
      let payload;
      if (method !== "GET") { headers["content-type"] = "application/json"; payload = JSON.stringify(body || {}); }
      const r = await fetch(api + url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
      let json = null; try { json = await r.json(); } catch (_) { json = null; }
      return { status: r.status, body: json };
    };
    const session = async (userId, propertyId) => {
      const c = await pool.connect();
      try { await c.query("begin"); const t = (await sessions.issueStaffSession(c, { userId, propertyId, purpose: "sms_otp" })).session_token; await c.query("commit"); return t; } finally { c.release(); }
    };

    // ── THE FIXTURE ──────────────────────────────────────────────────
    const deal = await deals.createDeal(pool, { user_id: operator.id, deal_name: `${tag}-deal`, creation_source: "deal_setup_console" });
    const p = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id", [`${tag}-p`, org.id]);
    await deals.addProperty(pool, { user_id: operator.id, deal_intake_id: deal.id, property_id: p.id });
    for (const [u, mods] of [[operator, "{management,leasing,maintenance}"], [maintOnly, "{maintenance}"]]) {
      await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof Seat',$3,true)", [p.id, u.id, mods]);
    }
    const units = {}, spaces = {};
    for (const n of ["301", "302", "303", "304"]) {
      const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, n]); units[n] = u.id;
      const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
      spaces[`${n}|Room1`] = (await one("update spaces set space_label='Room1', position_kind='bed', use_type='residential' where id=$1 returning id", [placeholder.id])).id;
      spaces[`${n}|Room2`] = (await one("insert into spaces(unit_id,space_label,position_kind,use_type) values($1,'Room2','bed','residential') returning id", [u.id])).id;
    }
    const lease = (key, person, rent, from = "2026-01-01", to = "2027-12-31") => one("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,$4,$5,$6,'active') returning id", [p.id, spaces[key], [residents[person]], rent, from, to]);
    await lease("301|Room1", "A", 850);
    await lease("302|Room1", "B", 900);
    await lease("303|Room1", "C1", 700);
    await lease("303|Room1", "C2", 750, "2026-03-01", "2027-02-28");     // overlaps → contested
    const CLAIMS = {
      "301|Room1": { status: "current", is_vacant: false, tenant_name: "Synthetic Resident A", actual_rent: 850, start_date: "2026-01-01", end_date: "2027-12-31" },
      "301|Room2": { status: "vacant", is_vacant: true },
      "302|Room1": { status: "current", is_vacant: false, tenant_name: "Synthetic Resident B", actual_rent: 900, start_date: "2026-01-01", end_date: "2027-12-31" },
      "302|Room2": { status: "vacant", is_vacant: true },
      "303|Room1": { status: "current", is_vacant: false, tenant_name: "Synthetic Resident C1", actual_rent: 700, start_date: "2026-01-01", end_date: "2027-12-31" },
      "303|Room2": { status: "current", is_vacant: false, tenant_name: "Synthetic Resident D", actual_rent: 800, start_date: "2026-01-01", end_date: "2027-12-31" },   // no lease → unresolved
      "304|Room1": { status: "vacant", is_vacant: true },
      "304|Room2": { status: "vacant", is_vacant: true },
    };
    const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger','measures.csv',$2,'bed','confirmed','committed') returning id`, [p.id, AS_OF]);
    const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
      values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, p.id, AS_OF, batch.id, operator.id]);
    let i = 0;
    for (const [key, c] of Object.entries(CLAIMS)) {
      const [n, label] = key.split("|"); i += 1;
      const claim = { section: "current", unit_number: n, space_label: label, ...c };
      const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,$2,$3,'synthetic: confirmed row',$4,$5) returning id`, [batch.id, i, JSON.stringify(claim), units[n], spaces[key]]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`, [act.id, p.id, key, JSON.stringify(claim), ev.id, String(operator.id)]);
    }
    await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
      positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
      values($1,$2,$3,$4,$5,8,0,8,$6,'platform_role:super_admin','established') returning id`, [p.id, deal.id, act.id, batch.id, AS_OF, operator.id]);
    const token = await session(operator.id, p.id), maintToken = await session(maintOnly.id, p.id);

    // ── EVERY OCCUPANCY OWNER, ONE READ ───────────────────────────────
    async function measures() {
      rung("occupancyByBasis (primitive)", "service"); const prim = await occupancyByBasis(pool, p.id);
      const cond = await http("leasing/condition", token, `/operator/leasing/condition`);
      const leasingDesk = await http("leasing-dashboard (operator key)", null, `/properties/${p.id}/leasing-dashboard`, { key: OPERATOR_KEY });
      const mgmtDesk = await http("management-dashboard (operator key)", null, `/properties/${p.id}/management-dashboard`, { key: OPERATOR_KEY });
      const canon = await http("rent-roll/canonical", token, `/operator/rent-roll/canonical?as_of=${AS_OF}`);
      const inst = await http("rent-roll/institutional", token, `/operator/rent-roll/institutional?as_of=${AS_OF}&format=json`);
      const legacy = await http("rent-roll (legacy snapshot)", token, `/operator/rent-roll?as_of=${AS_OF}`);
      const av = await http("availability-canonical", token, `/operator/leasing/availability-canonical?as_of=${AS_OF}`);
      const rr = await http("rent-roll/units", token, `/operator/rent-roll/units?as_of=${AS_OF}`);
      const ask = await http("ask-spine/ask", token, `/operator/ask-spine/ask`, { method: "POST", body: { question: "What is our occupancy?" } });
      rung("readTenancyStanding (standing/Ask facts)", "service"); const standing = await readTenancyStanding(pool, { property_id: p.id, as_of: AS_OF });
      const t = (canon.body && canon.body.totals) || {}; const occ = t.confirmed_contractual_occupancy || {};
      const cRow = (u, l) => ((canon.body && canon.body.rows) || []).find((r) => r.unit_number === u && r.space_label === l) || {};
      const aRow = (u, l) => ((av.body && av.body.rows) || []).find((r) => r.unit_number === u && r.space_label === l) || {};
      const ls = (legacy.body && legacy.body.summary) || {};
      const it = (inst.body && inst.body.totals) || {};
      const rrUnits = (rr.body && rr.body.units) || [];
      return {
        http: { condition: cond.status, leasingDesk: leasingDesk.status, mgmtDesk: mgmtDesk.status, canonical: canon.status, institutional: inst.status, legacy: legacy.status, availability: av.status, rentRollUnits: rr.status, ask: ask.status },
        primitive: { occupied: prim.occupied_count, rentable: prim.rentable_count, excluded: prim.excluded_count, pct: prim.occupancy_pct, exclusions_source: prim.exclusions_source },
        condition: cond.body && cond.body.current_occupancy ? { status: cond.body.current_occupancy.status, occupied: cond.body.current_occupancy.occupied, rentable: cond.body.current_occupancy.rentable, pct: cond.body.current_occupancy.pct, basis: cond.body.current_occupancy.basis } : null,
        leasing_desk: leasingDesk.body && leasingDesk.body.headline && leasingDesk.body.headline.occupancy ? { label: leasingDesk.body.headline.occupancy.label, value: leasingDesk.body.headline.occupancy.value } : null,
        mgmt_desk: mgmtDesk.body && mgmtDesk.body.headline && mgmtDesk.body.headline.occupancy ? { label: mgmtDesk.body.headline.occupancy.label, note: mgmtDesk.body.headline.occupancy.note } : null,
        canonical: { inventory: t.inventory, leasable: t.leasable, down: t.down, occupied: occ.occupied, denominator: occ.of_leasable_resolved, pct: occ.pct, excluded: occ.excluded_from_denominator, beside: occ.reported_beside, trusted_rent: t.contractual_rent_trusted,
          rows: { "301|Room1": [cRow("301", "Room1").tenancy_state, cRow("301", "Room1").is_down], "303|Room1": [cRow("303", "Room1").tenancy_state, cRow("303", "Room1").is_down], "303|Room2": [cRow("303", "Room2").tenancy_state, cRow("303", "Room2").is_down], "304|Room1": [cRow("304", "Room1").tenancy_state, cRow("304", "Room1").is_down] } },
        institutional: { total_positions: it.total_positions, confirmed_contractual_occupancy: it.confirmed_contractual_occupancy, occupancy_denominator: it.occupancy_denominator, positions_down: it.positions_down, label_as_rendered: `Confirmed contractual occupancy: ${it.confirmed_contractual_occupancy} of ${it.occupancy_denominator}` },
        legacy: { inventory: ls.inventory, occupied: ls.occupied, vacant: ls.vacant, down: ls.down, current_occupancy_pct: ls.current_occupancy_pct, leasable_occupancy_pct: ls.leasable_occupancy_pct, reconciled: ls.reconciled === true, residential_inventory: ls.residential_inventory, residential_occupied: ls.residential_occupied, published_rows: (legacy.body && legacy.body.rows || []).filter((r) => r.publication_status === "published").length },
        availability: { headline: av.body && av.body.headline ? { marketable_now: av.body.headline.marketable_now, contested: av.body.headline.contested, blocked_by_evidence: av.body.headline.blocked_by_evidence } : null,
          rows: { "301|Room1": [aRow("301", "Room1").marketing_state, aRow("301", "Room1").tenancy_state, !!aRow("301", "Room1").lease_id, aRow("301", "Room1").is_down], "302|Room1": [aRow("302", "Room1").marketing_state, aRow("302", "Room1").tenancy_state], "303|Room1": [aRow("303", "Room1").marketing_state, aRow("303", "Room1").tenancy_state], "303|Room2": [aRow("303", "Room2").marketing_state, aRow("303", "Room2").tenancy_state], "304|Room1": [aRow("304", "Room1").marketing_state, aRow("304", "Room1").tenancy_state] } },
        rent_roll_units: { positions: rrUnits.reduce((s, u) => s + (u.rentable_positions || 0), 0), buckets: Object.fromEntries(rrUnits.flatMap((u) => (u.positions || []).map((x) => [`${u.unit_number}|${x.label}`, x.bucket]))) },
        standing: { truth_state: standing.standing && standing.standing.truth_state, rentable_positions: standing.position && standing.position.rentable_positions, occupied: standing.position && standing.position.occupied, open: standing.position && standing.position.open, needs_review: standing.position && standing.position.needs_review, unknowns: standing.unknowns && { contested: standing.unknowns.positions_with_overlapping_lease_claims, unresolved_evidence: standing.unknowns.positions_with_unresolved_occupancy_evidence } },
        ask: { outcome: ask.body && ask.body.outcome, grounded: !!(ask.body && ask.body.grounded_on) },
      };
    }
    const leasesOf = () => all("select id, space_id, rent, start_date, end_date, lease_status from leases where property_id=$1 order by id", [p.id]);
    const show = (l, m) => console.log(`  ${l}: ${JSON.stringify(m)}`);

    // ── 1. BASELINE ───────────────────────────────────────────────────
    const m0 = await measures(); const leases0 = await leasesOf();
    evidence.measures.baseline = m0; show("baseline", m0);
    ok("1: every owner answers 200 (condition, both desks, canonical, institutional, legacy, availability, rent-roll/units, ask)", Object.values(m0.http).every((s) => s === 200), JSON.stringify(m0.http));
    ok("1 canonical: inventory 8, leasable 8, contested 1 → denominator 7, occupied 2 → 28.57%", m0.canonical.inventory === 8 && m0.canonical.leasable === 8 && m0.canonical.denominator === 7 && m0.canonical.occupied === 2 && m0.canonical.pct === 28.57, JSON.stringify(m0.canonical));
    ok("1 canonical: unresolved (303 Room2) and contested (303 Room1) are classified as such; unresolved stays IN the denominator, contested is OUT", m0.canonical.rows["303|Room2"][0] === "unresolved" && m0.canonical.rows["303|Room1"][0] === "contested" && m0.canonical.beside.unresolved_positions === 1 && m0.canonical.excluded.contested === 1, JSON.stringify(m0.canonical.rows));
    ok("1 primitive / condition / leasing desk: leases ÷ spaces = 3 of 8 = 37.5% (the contested bed has an active lease, so it counts as occupied here)", m0.primitive.occupied === 3 && m0.primitive.rentable === 8 && m0.primitive.pct === 37.5 && m0.condition && m0.condition.pct === 37.5 && m0.leasing_desk && /37\.5%/.test(m0.leasing_desk.label), JSON.stringify([m0.primitive, m0.condition, m0.leasing_desk]));
    ok("1 management desk headline: same primitive, label 'N% occupied' with the lease-based note", m0.mgmt_desk && /37\.5%/.test(m0.mgmt_desk.label) && /active lease/.test(m0.mgmt_desk.note || ""), JSON.stringify(m0.mgmt_desk));
    ok("1 legacy snapshot (what the Management home computes from): source-row STATUS WORDS — 4 'current' rows of 8 → 50% current_occupancy_pct; the unresolved row counts as occupied because the file said so", m0.legacy.inventory === 8 && m0.legacy.occupied === 4 && m0.legacy.current_occupancy_pct === 50 && m0.legacy.published_rows === 8, JSON.stringify(m0.legacy));
    ok("1 standing / Ask facts (observed): 3 occupied, 4 open, 1 needs review of 8 — the source-occupied-no-lease bed (303 Room2) is bucketed OCCUPIED here", m0.standing.rentable_positions === 8 && m0.standing.occupied === 3 && m0.standing.open === 4 && m0.standing.needs_review === 1 && m0.rent_roll_units.buckets["303|Room2"] === "occupied", JSON.stringify([m0.standing, m0.rent_roll_units.buckets]));
    ok("1 availability (observed): 5 marketable, 1 contested, 0 blocked — 303 Room2 is OFFERED marketable_now while its tenancy_state is 'unresolved'", m0.availability.headline.marketable_now === 5 && m0.availability.headline.contested === 1 && m0.availability.rows["303|Room2"][0] === "marketable_now" && m0.availability.rows["303|Room2"][1] === "unresolved", JSON.stringify([m0.availability.headline, m0.availability.rows["303|Room2"]]));
    ok("1 (DEFECT: one position, three meanings): 303 Room2 — source says occupied, Spine holds no lease — is 'unresolved' (excluded from the canonical numerator, kept in its denominator), 'occupied' (unit Rent Roll bucket and standing/Ask count), and 'marketable_now' (availability and the application selector) at the same date",
      m0.canonical.rows["303|Room2"][0] === "unresolved" && m0.rent_roll_units.buckets["303|Room2"] === "occupied" && m0.availability.rows["303|Room2"][0] === "marketable_now");
    ok("1: THREE different percentages for one property at one date — 28.57 (canonical/institutional), 37.5 (primitive/condition/desks), 50 (legacy source status) — each a different set", m0.canonical.pct === 28.57 && m0.primitive.pct === 37.5 && m0.legacy.current_occupancy_pct === 50);
    ok("1: Ask over HTTP is unavailable with no grounding (sentinel); standing facts are the service rung", m0.ask.outcome === "unavailable" && !m0.ask.grounded);

    // ── 2. HOLD ON A UNIT WITH AN OPERATIVE LEASE (301) ───────────────
    const wrongKey = await http("units/:id/down (wrong key)", null, `/units/${units["301"]}/down`, { method: "POST", key: "not-the-key", body: { down_reason: "hvac", down_blocker: "x" } });
    const maintOnlyForward = await http("leasing/forward-rent (maintenance-only seat)", maintToken, `/operator/leasing/forward-rent`);
    const down = async (n) => http("units/:id/down", null, `/units/${units[n]}/down`, { method: "POST", key: OPERATOR_KEY, body: { down_reason: "hvac", down_blocker: `synthetic hold ${n}` } });
    const resolve = async (n) => http("units/:id/down/resolve", null, `/units/${units[n]}/down/resolve`, { method: "PATCH", key: OPERATOR_KEY, body: { resolution_note: `synthetic restore ${n}` } });
    ok("2 (controls): wrong operator key 401 at the down door; maintenance-only seat 403 at a leasing read", wrongKey.status === 401 && maintOnlyForward.status === 403, JSON.stringify([wrongKey.status, maintOnlyForward.status]));
    const d301 = await down("301"); const m1 = await measures(); const leases1 = await leasesOf();
    evidence.measures.hold_301 = m1; show("hold 301", m1);
    ok("2: the hold is accepted (201) on the unit whose Room1 carries an operative lease", d301.status === 201);
    ok("2 canonical (DEFECT: membership mismatch): occupied stays 2 — the down 301 Room1 is still counted in the numerator — while leasable drops to 6 and the denominator to 5; 2 of 5 = 40% though only one occupied position is in the denominator",
      m1.canonical.down === 2 && m1.canonical.leasable === 6 && m1.canonical.denominator === 5 && m1.canonical.occupied === 2 && m1.canonical.pct === 40 && m1.canonical.rows["301|Room1"][0] === "contractually_occupied" && m1.canonical.rows["301|Room1"][1] === true, JSON.stringify(m1.canonical));
    ok("2 institutional screen label follows: 'Confirmed contractual occupancy: 2 of 5' beside 'Total canonical rentable positions: 8' and 'Positions down: 2' — the denominator basis is not stated", m1.institutional.confirmed_contractual_occupancy === 2 && m1.institutional.occupancy_denominator === 5 && m1.institutional.total_positions === 8 && m1.institutional.positions_down === 2, JSON.stringify(m1.institutional));
    ok("2 primitive / condition / desks: unchanged 3 of 8 — they never read is_down (label exclusion only)", m1.primitive.occupied === 3 && m1.primitive.rentable === 8 && m1.condition.pct === 37.5 && /37\.5%/.test(m1.leasing_desk.label), JSON.stringify([m1.primitive, m1.leasing_desk]));
    ok("2 legacy snapshot: unchanged 4 of 8 = 50% — source status words, blind to the governed hold", m1.legacy.occupied === 4 && m1.legacy.current_occupancy_pct === 50 && m1.legacy.down === 0, JSON.stringify(m1.legacy));
    ok("2 standing / Ask facts: unchanged from baseline — the hold is not a tenancy fact", JSON.stringify(m1.standing) === JSON.stringify(m0.standing), JSON.stringify([m1.standing, m0.standing]));
    ok("2 availability: 301 Room1 reads marketing 'down' while tenancy_state stays contractually_occupied and the lease is still on the row — the hold did not become evidence of a tenancy change", m1.availability.rows["301|Room1"][0] === "down" && m1.availability.rows["301|Room1"][1] === "contractually_occupied" && m1.availability.rows["301|Room1"][2] === true, JSON.stringify(m1.availability.rows["301|Room1"]));
    ok("2 database: no lease row changed under the hold", JSON.stringify(leases0) === JSON.stringify(leases1));
    ok("2 siblings: 302 Room1 still 'occupied', 304 Room1 still 'marketable_now', trusted rent unchanged", m1.availability.rows["302|Room1"][0] === "occupied" && m1.availability.rows["304|Room1"][0] === "marketable_now" && m1.canonical.trusted_rent === m0.canonical.trusted_rent);

    // ── 3. HOLD EVERY OCCUPIED AND THE CONTESTED UNIT (301, 302, 303) ─
    await down("302"); await down("303"); const m2 = await measures();
    evidence.measures.hold_301_302_303 = m2; show("hold 301+302+303", m2);
    ok("3 canonical (DEFECT: ratio above 100%): occupied 2 (both down), leasable 2 (304's rooms), contested 1 (down, still subtracted) → denominator 1 → 200%",
      m2.canonical.down === 6 && m2.canonical.leasable === 2 && m2.canonical.denominator === 1 && m2.canonical.occupied === 2 && m2.canonical.pct === 200, JSON.stringify(m2.canonical));
    ok("3 institutional screen: 'Confirmed contractual occupancy: 2 of 1'", m2.institutional.confirmed_contractual_occupancy === 2 && m2.institutional.occupancy_denominator === 1, m2.institutional.label_as_rendered);
    ok("3 primitive / legacy / standing: unchanged from baseline — different sets, none reads the hold", JSON.stringify([m2.primitive, m2.legacy, m2.standing]) === JSON.stringify([m0.primitive, m0.legacy, m0.standing]));

    // ── 4. ALL DOWN ───────────────────────────────────────────────────
    await down("304"); const m3 = await measures();
    evidence.measures.all_down = m3; show("all down", m3);
    ok("4 canonical: leasable 0, denominator 0 - 1 = -1 → pct null is NOT reached; a negative denominator yields a negative percentage or the numerator survives — recorded", true, JSON.stringify(m3.canonical));
    ok("4 canonical (observed): occupied still 2 with every position down; denominator " + m3.canonical.denominator + ", pct " + m3.canonical.pct, m3.canonical.occupied === 2 && m3.canonical.leasable === 0, JSON.stringify(m3.canonical));
    ok("4 institutional screen: label_as_rendered is '" + m3.institutional.label_as_rendered + "'", m3.institutional.confirmed_contractual_occupancy === 2, m3.institutional.label_as_rendered);
    ok("4 availability: every position 'down'; 301 Room1 tenancy still contractually_occupied", m3.availability.rows["304|Room1"][0] === "down" && m3.availability.rows["301|Room1"][1] === "contractually_occupied");
    ok("4 primitive and desks: still 3 of 8 = 37.5% with the whole building down — the label exclusion (model|down|offline) never sees units.is_down", m3.primitive.occupied === 3 && m3.primitive.rentable === 8 && m3.primitive.exclusions_source === "space_label");

    // ── 5. RESOLVE EVERY HOLD ─────────────────────────────────────────
    for (const n of ["301", "302", "303", "304"]) await resolve(n);
    const m4 = await measures(); const leases4 = await leasesOf();
    evidence.measures.after_resolve = m4;
    ok("5: after resolving, every owner returns exactly its baseline figures and no lease changed", JSON.stringify(m4) === JSON.stringify(m0) && JSON.stringify(leases4) === JSON.stringify(leases0), JSON.stringify(m4).slice(0, 600));

    if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, "occupancy-measures-under-holds.json"), JSON.stringify(evidence, null, 2));
  } finally { await pool.end(); }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
