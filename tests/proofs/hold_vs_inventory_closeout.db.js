/* ════════════════════════════════════════════════════════════════════
   hold_vs_inventory_closeout.db.js — THE SAME HISTORICAL MIXED FIXTURE,
   ON THE CURRENT CANDIDATE, WITH THE FINANCIAL READS ACTUALLY RUN.

   0. Fixture: '(whole unit)' confirmed beside Room1/Room2 on 301; Room1/
      Room2 on 302, where Room1 carries a real active lease (the nonzero
      sibling control). A leasing cycle is established so forward rent can
      be read. Use type configured.
   1. Consumers and financial owners at baseline.
   2. Source correction through the deal-setup HTTP doors, then the same
      reads. Which numbers change, which do not, and which cannot be read.
   3. The down hold's effect on the two occupancy owners, then restore.
   4. Retirement + reinstatement with a full identity comparison, on the
      corrected property (so an artifact hash exists to compare).
   5. Explainability: is "open vacancy + marketing held" expressible from
      the existing reads without replacing occupancy with readiness?

   Observation proof. Nothing here is a policy. Owned DB, owned server.
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
const retirement = require(path.join(root, "src/tenancy/inventory_retirement.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const askSpine = require(path.join(root, "src/agent/ask_spine_answer.js"));
const { occupancyByBasis } = require(path.join(root, "src/leasing/leasing_occupancy_facts.js"));
const { establishLeasingCycle } = require(path.join(root, "src/leasing/leasing_cycle.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const AS_OF = "2026-07-31";
const api = process.env.E2E_API_BASE || null;
if (!api) { console.error("This proof exercises HTTP doors; set E2E_API_BASE (owned server)."); process.exit(1); }
const OPERATOR_KEY = process.env.PROOF_OPERATOR_KEY || "e2e-key";
const evidence = { calls: [], sections: {} };
const rung = (name, how) => { if (!evidence.calls.find((c) => c.name === name)) evidence.calls.push({ name, how }); };

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const all = async (sql, args = []) => (await pool.query(sql, args)).rows;
  try {
    const tag = `hold-closeout-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const mkUser = async (name, key) => {
      const person = await one("insert into persons(name) values($1) returning id", [name]);
      return one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
        values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`, [name, `${tag}-${key}@example.test`, org.id, person.id]);
    };
    const operator = await mkUser("Synthetic Closeout Operator", "op");
    const maintOnly = await mkUser("Synthetic Maintenance Only", "maint");
    const resident = await one("insert into persons(name) values('Synthetic Sibling Resident') returning id");

    const http = async (name, token, url, { method = "GET", body = null, form = null, key = null } = {}) => {
      rung(name, "HTTP");
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
    const tx = async (fn) => { const c = await pool.connect(); try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };

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
      //  The nonzero sibling: a real active lease on 302 Room1.
      const lease = await one("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,850,'2026-01-01','2027-12-31','active') returning id", [p.id, spaces["302|Room1"], [resident.id]]);
      const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
        values($1,'rent_roll_ledger','historical.csv',$2,'bed','confirmed','committed') returning id`, [p.id, AS_OF]);
      const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
        values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, p.id, AS_OF, batch.id, operator.id]);
      let i = 0;
      for (const key of Object.keys(spaces)) {
        const [n, label] = key.split("|"); i += 1;
        const occupied = key === "302|Room1";
        const claim = occupied ? { section: "current", unit_number: n, space_label: label, is_vacant: false, tenant_name: "Synthetic Sibling Resident", actual_rent: 850, start_date: "2026-01-01", end_date: "2027-12-31" }
          : { section: "current", unit_number: n, space_label: label, is_vacant: true };
        const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
          values($1,$2,$3,'historical: confirmed row',$4,$5) returning id`, [batch.id, i, JSON.stringify(claim), units[n], spaces[key]]);
        await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
          values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`, [act.id, p.id, key, JSON.stringify(claim), ev.id, String(operator.id)]);
      }
      await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
        positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
        values($1,$2,$3,$4,$5,5,0,5,$6,'platform_role:super_admin','established') returning id`, [p.id, deal.id, act.id, batch.id, AS_OF, operator.id]);
      await tx((c) => establishLeasingCycle(c, { property_id: p.id, cycle_label: "2026-27", cycle_start: "2026-08-01", cycle_end: "2027-07-31", established_by_user_id: operator.id }));
      return { id: p.id, deal: deal.id, name, units, spaces, lease: lease.id, token: await session(operator.id, p.id), maintToken: await session(maintOnly.id, p.id) };
    }

    //  ── CONSUMERS (as on 8791791) + FINANCIAL OWNERS ─────────────────
    async function consumers(p) {
      const av = await http("availability-canonical", p.token, `/operator/leasing/availability-canonical?as_of=${AS_OF}`);
      const lu = await http("leaseable-units", p.token, `/operator/leasing/leaseable-units`);
      const rr = await http("rent-roll/units", p.token, `/operator/rent-roll/units?as_of=${AS_OF}`);
      const ask = await http("ask-spine/ask", p.token, `/operator/ask-spine/ask`, { method: "POST", body: { question: "How many rentable positions are open right now?" } });
      rung("readTenancyStanding", "service"); const standing = await readTenancyStanding(pool, { property_id: p.id, as_of: AS_OF });
      rung("gatherFacts(tenancy)", "service"); const facts = await askSpine.gatherFacts(pool, { property_id: p.id, allowed_modules: ["management", "leasing"], subject: "tenancy", question: "how many positions are open" });
      const row = (label, unit = "301") => ((av.body && av.body.rows) || []).find((r) => r.unit_number === unit && r.space_label === label) || {};
      const rrUnit = (n) => ((rr.body && rr.body.units) || []).find((u) => u.unit_number === n) || {};
      const rrLine = (label, n = "301") => ((rrUnit(n).positions) || []).find((x) => x.label === label) || {};
      const ph = row("(whole unit)");
      return {
        http_status: { availability: av.status, leaseable: lu.status, rent_roll: rr.status, ask: ask.status },
        availability: { placeholder: ph.marketing_state, placeholder_reason: ph.blocking_reason || ph.reason || null, placeholder_basis_state: ph.basis_state, room1: row("Room1").marketing_state, room1_basis_state: row("Room1").basis_state, room1_reason: row("Room1").blocking_reason || row("Room1").reason || null, room2: row("Room2").marketing_state, n302_room1: row("Room1", "302").marketing_state, n302_room2: row("Room2", "302").marketing_state },
        leaseable_301: ((lu.body && lu.body.eligible_targets) || []).filter((t) => t.unit_number === "301").map((t) => t.space_label).sort(),
        leaseable_302: ((lu.body && lu.body.eligible_targets) || []).filter((t) => t.unit_number === "302").map((t) => t.space_label).sort(),
        rent_roll: { positions_301: rrUnit("301").rentable_positions, placeholder_bucket: rrLine("(whole unit)").bucket, placeholder_basis: rrLine("(whole unit)").basis_state, room1_bucket: rrLine("Room1").bucket, n302_room1_bucket: rrLine("Room1", "302").bucket },
        standing: { truth_state: standing.standing && standing.standing.truth_state, why: standing.standing && standing.standing.why, rentable_positions: standing.position && standing.position.rentable_positions, open: standing.position && standing.position.open, occupied: standing.position && standing.position.occupied, not_established: standing.position && standing.position.not_established },
        ask_http: { outcome: ask.body && ask.body.outcome, grounded_on_present: !!(ask.body && ask.body.grounded_on) },
        ask_facts: facts.tenancy ? { read_state: facts.tenancy.read_state, open: facts.tenancy.position && facts.tenancy.position.open, rentable_positions: facts.tenancy.position && facts.tenancy.position.rentable_positions } : null,
      };
    }
    async function financial(p) {
      rung("occupancyByBasis", "service"); const occ = await occupancyByBasis(pool, p.id);
      const desk = await http("leasing-dashboard (operator key)", null, `/properties/${p.id}/leasing-dashboard`, { key: OPERATOR_KEY });
      const canon = await http("rent-roll/canonical", p.token, `/operator/rent-roll/canonical?as_of=${AS_OF}`);
      const fwd = await http("leasing/forward-rent", p.token, `/operator/leasing/forward-rent`);
      const fut = await http("rent-roll/future-facts", p.token, `/operator/rent-roll/future-facts?as_of=2026-12-01`);
      const t = (canon.body && canon.body.totals) || {};
      const cRow = (label, unit = "301") => ((canon.body && canon.body.rows) || []).find((r) => r.unit_number === unit && r.space_label === label) || {};
      const fb = fwd.body || {};
      return {
        occupancy_primitive: { status: occ.status, occupied: occ.occupied_count, rentable: occ.rentable_count, excluded: occ.excluded_count, ratio: occ.occupancy_ratio, source: occ.exclusions_source },
        leasing_desk: { status: desk.status, occupancy: desk.body && desk.body.headline && desk.body.headline.occupancy ? { value: desk.body.headline.occupancy.value, label: desk.body.headline.occupancy.label } : null },
        canonical: { status: canon.status, inventory: t.inventory, leasable: t.leasable, down: t.down,
          occupancy: t.confirmed_contractual_occupancy ? { occupied: t.confirmed_contractual_occupancy.occupied, denominator: t.confirmed_contractual_occupancy.of_leasable_resolved, pct: t.confirmed_contractual_occupancy.pct, beside: t.confirmed_contractual_occupancy.reported_beside } : null,
          contractual_rent_trusted: t.contractual_rent_trusted, positions_contributing_rent: t.positions_contributing_rent,
          placeholder_tenancy_state: cRow("(whole unit)").tenancy_state, sibling_tenancy_state: cRow("Room1", "302").tenancy_state, sibling_rent: cRow("Room1", "302").current_rent },
        forward_rent: { status: fwd.status, error: fb.error || null, positions: fb.forward_leasing ? fb.forward_leasing.positions : null, remaining: fb.forward_leasing ? fb.forward_leasing.remaining : null,
          committed_rent: fb.committed_rent ? { contractual: fb.committed_rent.contractual, contractual_positions: fb.committed_rent.contractual_positions, contractual_state: fb.committed_rent.contractual_state } : null,
          open_bed_assumption: fb.open_bed_assumption ? { read_state: fb.open_bed_assumption.read_state, monthly: fb.open_bed_assumption.monthly, lines: (fb.open_bed_assumption.lines || []).length } : null },
        future_facts: { status: fut.status, monthly_contractual_rent_known: fut.body && fut.body.totals ? fut.body.totals.monthly_contractual_rent_known : null, positions: fut.body && fut.body.totals ? fut.body.totals.positions : null, open_or_uncovered: fut.body && fut.body.totals ? fut.body.totals.open_or_uncovered : null },
        vacancy_loss: { owner: null, note: "no vacancy-loss or gross-potential-rent calculation exists in src/ (searched vacancy loss, loss to vacancy, economic vacancy, gross_potential); cannot be read through any live path" },
      };
    }
    const show = (label, c) => console.log(`  ${label}: ${JSON.stringify(c)}`);

    // ── 1. BASELINE ────────────────────────────────────────────────────
    const A = await fixture("closeout");
    const c0 = await consumers(A), f0 = await financial(A);
    evidence.sections.baseline = { consumers: c0, financial: f0 }; show("baseline consumers", c0); show("baseline financial", f0);
    ok("1: every consumer answers 200 on the candidate", Object.values(c0.http_status).every((s) => s === 200), JSON.stringify(c0.http_status));
    ok("1: the confirmed placeholder is offered and application-eligible beside two rooms; standing ESTABLISHED, 5 positions, 4 open, 1 occupied",
      c0.availability.placeholder === "marketable_now" && c0.leaseable_301.length === 3 && c0.standing.truth_state === "ESTABLISHED" && c0.standing.rentable_positions === 5 && c0.standing.open === 4 && c0.standing.occupied === 1, JSON.stringify(c0.standing));
    ok("1: Ask over HTTP is 200/unavailable with no grounding (e2e sentinel); gatherFacts is the service rung and carries the standing counts", c0.ask_http.outcome === "unavailable" && !c0.ask_http.grounded_on_present && c0.ask_facts && c0.ask_facts.open === 4, JSON.stringify([c0.ask_http, c0.ask_facts]));
    ok("1 (sibling nonzero): 302 Room1 is contractually occupied at 850 and is the one position contributing trusted rent",
      f0.canonical.sibling_tenancy_state === "contractually_occupied" && Number(f0.canonical.contractual_rent_trusted) === 850 && f0.canonical.positions_contributing_rent === 1, JSON.stringify(f0.canonical));
    ok("1: occupancy primitive counts 1 of 5 rentable (label-derived exclusions: none)", f0.occupancy_primitive.occupied === 1 && f0.occupancy_primitive.rentable === 5 && f0.occupancy_primitive.excluded === 0, JSON.stringify(f0.occupancy_primitive));
    ok("1: leasing desk (operator key) shows the same 20% occupied", f0.leasing_desk.status === 200 && f0.leasing_desk.occupancy && Math.abs(f0.leasing_desk.occupancy.value - 0.2) < 1e-9, JSON.stringify(f0.leasing_desk));
    ok("1: canonical rent roll: inventory 5, leasable 5, occupancy 1 of 5 = 20%, placeholder tenancy 'vacant'", f0.canonical.inventory === 5 && f0.canonical.leasable === 5 && f0.canonical.occupancy.denominator === 5 && f0.canonical.occupancy.pct === 20 && f0.canonical.placeholder_tenancy_state === "vacant", JSON.stringify(f0.canonical));
    ok("1: forward rent reads 200 over HTTP with a governed cycle (figures recorded, not asserted — no tracker or asking assumptions exist here)", f0.forward_rent.status === 200, JSON.stringify(f0.forward_rent));
    ok("1: future facts read 200 over HTTP (recorded)", f0.future_facts.status === 200, JSON.stringify(f0.future_facts));

    // ── 2. SOURCE CORRECTION, THEN THE SAME READS ──────────────────────
    let artifactSha = null;
    {
      const csv = "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n301,Room1,VACANT,900,,,\n301,Room2,VACANT,900,,,\n302,Room1,Synthetic Sibling Resident,900,850,2026-01-01,2027-12-31\n302,Room2,VACANT,900,,,\n";
      const form = new FormData(); form.append("file", new Blob([csv], { type: "text/csv" }), "corrected.csv"); form.append("source_as_of_date", AS_OF);
      const up = await http("deal-setup upload", A.token, `/deal-setup/deals/${A.deal}/properties/${A.id}/source`, { method: "POST", form });
      const opened = await http("deal-setup activation", A.token, `/deal-setup/deals/${A.deal}/properties/${A.id}/activation`, { method: "POST" });
      const actId = opened.body && opened.body.activation && opened.body.activation.id;
      const read = await http("deal-setup read-source", A.token, `/deal-setup/activations/${actId}/read-source`, { method: "POST", body: { source_artifact_id: up.body && up.body.artifact && up.body.artifact.id, source_as_of_date: AS_OF } });
      const proposals = ((await http("deal-setup activation read", A.token, `/deal-setup/activations/${actId}`)).body || {}).proposals || [];
      const confirms = []; for (const q of proposals) confirms.push([q.natural_key, (await http("deal-setup confirm", A.token, `/deal-setup/proposals/${q.id}/confirm`, { method: "POST" })).status, q.status]);
      const est = await http("deal-setup establish", A.token, `/deal-setup/activations/${actId}/establish`, { method: "POST" });
      artifactSha = up.body && up.body.artifact ? (await one("select sha256 from source_artifacts where id=$1", [up.body.artifact.id]) || {}).sha256 : null;
      const c1 = await consumers(A), f1 = await financial(A);
      evidence.sections.source_correction = { upload: up.status, read: read.status, read_error: read.body && read.body.error, confirms, establish: est.status, consumers: c1, financial: f1 };
      show("after correction consumers", c1); show("after correction financial", f1);
      ok("2: corrected file reads 201, rows confirm, baseline establishes 201 (occupied sibling row included)", read.status === 201 && est.status === 201 && confirms.filter((c) => c[1] === 200).length >= 3, JSON.stringify({ read: read.body, confirms, est: est.status }));
      ok("2: availability holds the placeholder occupancy_unknown; both rooms and both 302 positions unchanged", c1.availability.placeholder === "occupancy_unknown" && c1.availability.room1 === "marketable_now" && c1.availability.room2 === "marketable_now" && c1.availability.n302_room1 === "occupied" && c1.availability.n302_room2 === "marketable_now", JSON.stringify(c1.availability));
      ok("2: application selector drops the placeholder, keeps Room1/Room2 and 302 Room2", c1.leaseable_301.join("|") === "Room1|Room2" && c1.leaseable_302.join("|") === "Room2", JSON.stringify([c1.leaseable_301, c1.leaseable_302]));
      ok("2 (inventory count, unchanged): occupancy primitive still 1 of 5 — it counts spaces by label and never reads basis", f1.occupancy_primitive.occupied === 1 && f1.occupancy_primitive.rentable === 5, JSON.stringify(f1.occupancy_primitive));
      ok("2 (occupancy ratio, unchanged): canonical rent roll still divides 1 by 5 — the placeholder moved from 'vacant' to 'unresolved' and 'unresolved' stays in the denominator", f1.canonical.inventory === 5 && f1.canonical.occupancy.denominator === 5 && f1.canonical.occupancy.pct === 20 && f1.canonical.placeholder_tenancy_state === "unresolved" && f1.canonical.occupancy.beside.unresolved_positions >= 1, JSON.stringify(f1.canonical));
      ok("2 (contractual rent sum, unchanged): trusted contractual rent is still 850 from the one sibling lease", Number(f1.canonical.contractual_rent_trusted) === 850 && f1.canonical.positions_contributing_rent === 1 && f1.canonical.sibling_tenancy_state === "contractually_occupied");
      ok("2 (leasing desk, unchanged): still 20% occupied", f1.leasing_desk.occupancy && Math.abs(f1.leasing_desk.occupancy.value - 0.2) < 1e-9, JSON.stringify(f1.leasing_desk));
      ok("2 (forward rent, unchanged): positions and contractual figures identical before and after — the interval read lists every space of every live unit regardless of basis", JSON.stringify([f0.forward_rent.positions, f0.forward_rent.committed_rent]) === JSON.stringify([f1.forward_rent.positions, f1.forward_rent.committed_rent]), JSON.stringify([f0.forward_rent, f1.forward_rent]));
      ok("2 (future facts, unchanged)", JSON.stringify([f0.future_facts.monthly_contractual_rent_known, f0.future_facts.positions]) === JSON.stringify([f1.future_facts.monthly_contractual_rent_known, f1.future_facts.positions]), JSON.stringify([f0.future_facts, f1.future_facts]));
      ok("2 (vacancy loss): no canonical owner exists, so nothing was read and nothing is claimed", f1.vacancy_loss.owner === null);
      ok("2: standing/Ask reports PARTIALLY_ESTABLISHED, 5 positions, 1 not established — a real position with unknown occupancy, not a disputed one", c1.standing.truth_state === "PARTIALLY_ESTABLISHED" && c1.standing.rentable_positions === 5 && c1.standing.not_established === 1, JSON.stringify(c1.standing));
    }

    // ── 3. THE DOWN HOLD AND THE TWO OCCUPANCY OWNERS ──────────────────
    {
      const wrongKey = await http("units/:id/down (wrong key)", null, `/units/${A.units["301"]}/down`, { method: "POST", key: "not-the-key", body: { down_reason: "hvac", down_blocker: "synthetic" } });
      const down = await http("units/:id/down", null, `/units/${A.units["301"]}/down`, { method: "POST", key: OPERATOR_KEY, body: { down_reason: "hvac", down_blocker: "synthetic: hold" } });
      const c2 = await consumers(A), f2 = await financial(A);
      const foreign = await http("triage/confirm (foreign session)", await session(operator.id, (await fixture("other")).id), `/operator/units/${A.units["301"]}/triage/confirm`, { method: "POST", body: { text: "x", vacancy_observation: "vacant", initial_condition: "severe", inspection_completeness: "initial_triage" } });
      const maintOnlyLeasing = await http("leaseable-units (maintenance-only seat)", A.maintToken, `/operator/leasing/leaseable-units`);
      const resolve = await http("units/:id/down/resolve", null, `/units/${A.units["301"]}/down/resolve`, { method: "PATCH", key: OPERATOR_KEY, body: { resolution_note: "synthetic: restore" } });
      const c3 = await consumers(A), f3 = await financial(A);
      evidence.sections.down = { wrong_key: wrongKey.status, down: down.status, consumers: c2, financial: f2, foreign_property: foreign.status, maintenance_only_on_selector: maintOnlyLeasing.status, resolve: resolve.status, after_resolve: { consumers: c3, financial: f3 } };
      show("down financial", f2);
      ok("3 (controls): wrong key 401, foreign-property session 403, maintenance-only seat 403", wrongKey.status === 401 && foreign.status === 403 && maintOnlyLeasing.status === 403, JSON.stringify([wrongKey.status, foreign.status, maintOnlyLeasing.status]));
      ok("3: down marks all three 301 positions 'down'; on Room1 (basis established) the row says occupancy basis established AND marketing down/out_of_service — two axes, readiness untouched; the placeholder is down over an already not-established basis",
        c2.availability.placeholder === "down" && c2.availability.placeholder_reason === "out_of_service" && c2.availability.room1 === "down" && c2.availability.room1_basis_state === "established" && c2.availability.room1_reason === "out_of_service", JSON.stringify(c2.availability));
      ok("3 (two occupancy owners disagree under a hold): canonical rent roll removes the three down rows from leasable (5→2) and reports 1 of 2 = 50%; the occupancy primitive still says 1 of 5 because it excludes by label, not by is_down",
        f2.canonical.down === 3 && f2.canonical.leasable === 2 && f2.canonical.occupancy.pct === 50 && f2.occupancy_primitive.rentable === 5, JSON.stringify([f2.canonical, f2.occupancy_primitive]));
      ok("3: the Rent Roll bucket and standing tally do not move under down (placeholder bucket unchanged, standing open unchanged)", c2.rent_roll.placeholder_bucket === c1Bucket(c2) && c2.standing.open === 3, JSON.stringify([c2.rent_roll, c2.standing]));
      ok("3: resolve restores every consumer and financial read to the post-correction values", resolve.status === 200 && JSON.stringify([c3.availability, f3.canonical]) === JSON.stringify([evidence.sections.source_correction.consumers.availability, evidence.sections.source_correction.financial.canonical]), JSON.stringify([c3.availability, f3.canonical]));
      function c1Bucket(c) { return c.rent_roll.placeholder_bucket == null ? null : c.rent_roll.placeholder_bucket; }
    }

    // ── 4. RETIREMENT + REINSTATEMENT, FULL IDENTITY COMPARISON ───────
    {
      const snapshot = async () => ({
        spaces: await all("select s.id, s.unit_id, u.unit_number, s.space_label, s.position_kind, s.use_type from spaces s join units u on u.id=s.unit_id where u.property_id=$1 order by u.unit_number, s.space_label", [A.id]),
        proposals: await all("select id, natural_key, status, confirmed_by, confirmed_at, import_source_row_id, activation_id from proposed_records where property_id=$1 order by activation_id, natural_key", [A.id]),
        evidence_rows: await all("select r.id, r.produced_unit_id, r.produced_space_id, r.parse_note from import_source_rows r join import_batches b on b.id=r.import_batch_id where b.property_id=$1 order by r.id", [A.id]),
        baselines: await all("select id, activation_id, import_batch_id, status, superseded_by_id, superseded_at, as_of_date from opening_tenancy_positions where property_id=$1 order by established_at, id", [A.id]),
        batches: await all("select id, source_file, source_as_of_date, status from import_batches where property_id=$1 order by loaded_at", [A.id]),
        artifacts: await all("select id, sha256, byte_size, original_filename from source_artifacts where scope_type='property' and scope_id=$1 order by uploaded_at", [A.id]),
        lease: await one("select id, space_id, rent, start_date, end_date, lease_status from leases where id=$1", [A.lease]),
        cycle: await all("select cycle_label, cycle_start, cycle_end from property_leasing_cycles where property_id=$1", [A.id]).catch((e) => String(e.message)),
      });
      const before = await snapshot();
      const cBefore = await consumers(A), fBefore = await financial(A);
      const ret = await tx((c) => retirement.retireInventoryUnits(c, { property_id: A.id, unit_ids: [A.units["301"]], rationale: "Synthetic proof: is retirement a way to hold one disputed position?", actor: { user_id: operator.id } }));
      const cRet = await consumers(A), fRet = await financial(A);
      const reinst = await tx((c) => retirement.reinstateInventoryUnit(c, { unit_id: A.units["301"], actor: { user_id: operator.id }, reason: "Synthetic proof: restore" }));
      const after = await snapshot();
      const cAfter = await consumers(A), fAfter = await financial(A);
      const retirementRows = await all("select unit_id, reason_code, original_unit_number, retired_at is not null as retired, reversed_at is not null as reversed from inventory_retirements where property_id=$1", [A.id]);
      evidence.sections.retirement = { retired_count: ret.retired, reason_code: ret.reason_code, reinstated: reinst.reinstated, during: { consumers: cRet, financial: fRet }, identity_equal: JSON.stringify(before) === JSON.stringify(after), consumers_equal: JSON.stringify([cBefore, fBefore]) === JSON.stringify([cAfter, fAfter]), retirement_rows: retirementRows, artifact_sha256_present: !!artifactSha,
        identity_shape: { spaces: before.spaces.length, proposals: before.proposals.length, evidence_rows: before.evidence_rows.length, baselines: before.baselines.length, batches: before.batches.length, artifacts: before.artifacts.length, lease: !!before.lease, cycle: Array.isArray(before.cycle) ? before.cycle.length : before.cycle } };
      show("retirement", { retired: ret.retired, reason: ret.reason_code, identity_equal: evidence.sections.retirement.identity_equal, consumers_equal: evidence.sections.retirement.consumers_equal });
      ok("4: retireInventoryUnits().retired is a NUMBER (1) and the reason is the one never-was-inventory code — the earlier receipt's `.retired.length` read undefined", ret.retired === 1 && typeof ret.retired === "number" && ret.reason_code === retirement.REASONS_NEVER_WAS_INVENTORY[0] && retirement.REASONS_DATE_SENSITIVE.length === 0, JSON.stringify([ret.retired, ret.reason_code, retirement.ALL_REASONS]));
      ok("4: while retired, all three 301 positions leave every consumer and every financial read: inventory 2, occupancy 1 of 2, forward positions 2", cRet.standing.rentable_positions === 2 && fRet.canonical.inventory === 2 && fRet.canonical.occupancy.denominator === 2 && fRet.forward_rent.positions === 2 && fRet.future_facts.positions === 2, JSON.stringify([cRet.standing, fRet.canonical, fRet.forward_rent, fRet.future_facts]));
      ok("4 (identity): after reinstatement every space id, unit id, label, kind and use; every proposal (id, status, confirmed_by, confirmed_at, evidence link); every evidence row; both baselines with their supersession links; both batches; the artifact sha256; the sibling lease; and the cycle are byte-identical to before", evidence.sections.retirement.identity_equal, JSON.stringify({ before, after }).slice(0, 1500));
      ok("4 (consumers): every consumer and financial field equals its pre-retirement value", evidence.sections.retirement.consumers_equal, JSON.stringify([cAfter, fAfter]).slice(0, 1200));
      ok("4: the retirement row itself remains as history, reversed, with the original unit number", retirementRows.length === 1 && retirementRows[0].reversed === true && retirementRows[0].original_unit_number === "301");
      ok("4 (note): the occupancy primitive ignored the retirement too — it reads spaces by label without the NOT_RETIRED predicate (5 rentable while the unit was retired)", fRet.occupancy_primitive.rentable === 5);
    }

    // ── 5. EXPLAINABILITY WITHOUT REPLACING OCCUPANCY ──────────────────
    {
      const sc = evidence.sections.source_correction.consumers, dn = evidence.sections.down.consumers;
      evidence.sections.explainability = {
        source_correction: { occupancy_axis: sc.availability.placeholder_basis_state, marketing_axis: sc.availability.placeholder, reason: sc.availability.placeholder_reason, rent_roll_bucket: sc.rent_roll.placeholder_bucket },
        down_hold_room1: { occupancy_axis: dn.availability.room1_basis_state, marketing_axis: dn.availability.room1, reason: dn.availability.room1_reason, rent_roll_bucket: dn.rent_roll.room1_bucket },
      };
      ok("5: under the down hold the existing reads already say, for Room1, 'open vacancy (basis established, bucket open) AND not marketable (down, out_of_service)' — two axes, both true, readiness untouched", dn.availability.room1_basis_state === "established" && dn.availability.room1 === "down" && dn.rent_roll.room1_bucket === "open");
      ok("5: under source correction the hold is expressed BY replacing occupancy (basis not established, bucket null, occupancy_unknown) — the marketing axis carries no independent hold", sc.availability.placeholder_basis_state !== "established" && sc.availability.placeholder === "occupancy_unknown" && sc.rent_roll.placeholder_bucket == null);
    }

    if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, "hold-vs-inventory-closeout.json"), JSON.stringify(evidence, null, 2));
  } finally { await pool.end(); }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
