/* ════════════════════════════════════════════════════════════════════
   mixed_grain_writer_challenge.db.js — CAN THE CURRENT ONBOARDING WRITER
   CREATE A '(whole unit)' POSITION BESIDE A REAL BED?

   Observation proof. Every assertion states what the tree it runs on
   does today. Nothing here is a policy.

   1. WRITER. A fresh by-bed property; the retained-source activation
      ingest reads current rows that name '(whole unit)' and Room1 on the
      same unit, in both orders. Through real HTTP when E2E_API_BASE is
      set (upload → activation → read-source → confirm → establish),
      otherwise through the same services. Observes produced links,
      labels, governed and derived kinds, parse notes, confirmation,
      opening basis, Rent Roll, availability, application targeting.
   2. MATERIALIZATION. materializeRentableSpaces directly with both
      labels and kind 'bed'. Does it accept and stamp both as bed?
   3. CONTROLS. A valid single whole-unit property; a sole bed with a
      ledger-style label; the e2e fixture's pre-existing '(whole unit)'
      + 'Bed B' shape re-read; a valid multi-bed unit; a property with
      DIFFERENT whole-unit and bed units; retained whole-unit history
      that blocks conversion; future-only room names.
   4. CORRECTION. What the existing writers do when asked to resolve
      the shape from section 1, and where the first stop is.

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
const artifacts = require(path.join(root, "src/onboarding/source_artifact_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
const sessions = require(path.join(root, "src/identity/staff_session_service.js"));
const { materializeRentableSpaces } = require(path.join(root, "src/tenancy/inventory_materialization.js"));
const { datedPropertyPositions } = require(path.join(root, "src/tenancy/dated_positions.js"));
const { unitRentRoll } = require(path.join(root, "src/surfaces/rent_roll_unit_view.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const { resolveApplicationTarget } = require(path.join(root, "src/applications/application_target_authority.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const AS_OF = "2026-07-31";
const HEADER = "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n";
const api = process.env.E2E_API_BASE || null;
const evidence = { rung: api ? "real HTTP through the owned server for the writer path" : "services only (no E2E_API_BASE)", sections: {} };

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const all = async (sql, args = []) => (await pool.query(sql, args)).rows;
  const errOf = (e) => ({ status: e.httpStatus || e.status || null, code: e.code || e.error || null, message: String(e.publicMessage || e.receipt || e.message || e) });
  try {
    const tag = `mixed-grain-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const person = await one("insert into persons(name) values('Synthetic Grain Operator') returning id");
    const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values('Synthetic Grain Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`, [`${tag}@example.test`, org.id, person.id]);

    const http = async (token, url, { method = "GET", body = null, form = null } = {}) => {
      const headers = { "x-staff-session": token };
      let payload;
      if (form) payload = form; else if (method === "POST") { headers["content-type"] = "application/json"; payload = JSON.stringify(body || {}); }
      const r = await fetch(api + url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
      let json = null; try { json = await r.json(); } catch (_) { json = null; }
      return { status: r.status, body: json };
    };

    //  A property on a deal, with a seat and a session. Pre-existing
    //  inventory only where a control needs it (built the way the e2e
    //  fixture builds it — direct rows, no writer).
    async function property(name, basis, preexisting = {}) {
      const deal = await deals.createDeal(pool, { user_id: user.id, deal_name: `${tag}-${name}`, creation_source: "deal_setup_console" });
      const p = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,$3) returning id", [`${tag}-${name}`, org.id, basis]);
      await deals.addProperty(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: p.id });
      await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof Manager','{management,leasing}',true)", [p.id, user.id]);
      const c = await pool.connect(); let token;
      try { await c.query("begin"); token = (await sessions.issueStaffSession(c, { userId: user.id, propertyId: p.id, purpose: "sms_otp" })).session_token; await c.query("commit"); } finally { c.release(); }
      const unitIds = {}, spaceIds = {};
      for (const [number, labels] of Object.entries(preexisting)) {
        const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [p.id, number]);
        unitIds[number] = u.id;
        const placeholder = await one("select id from spaces where unit_id=$1", [u.id]);
        for (const label of labels) {
          const s = label === "(whole unit)" ? placeholder
            : await one("insert into spaces(unit_id,space_label) values($1,$2) returning id", [u.id, label]);
          spaceIds[`${number}|${label}`] = s.id;
        }
      }
      return { id: p.id, deal: deal.id, token, name, unitIds, spaceIds };
    }

    //  The retained-source activation path. HTTP when the owned server is
    //  there; the same services otherwise. Returns what happened, never
    //  throws — a refusal is an observation.
    async function ingest(p, csv, filename = `${p.name}.csv`) {
      const out = { ok: false, act: null, proposals: [], error: null, upload_status: null };
      try {
        if (api) {
          const form = new FormData();
          form.append("file", new Blob([csv], { type: "text/csv" }), filename);
          form.append("source_as_of_date", AS_OF);
          const up = await http(p.token, `/deal-setup/deals/${p.deal}/properties/${p.id}/source`, { method: "POST", form });
          out.upload_status = up.status;
          if (!up.body || !up.body.artifact) throw Object.assign(new Error(JSON.stringify(up.body)), { httpStatus: up.status, code: up.body && up.body.error });
          const opened = await http(p.token, `/deal-setup/deals/${p.deal}/properties/${p.id}/activation`, { method: "POST" });
          out.act = opened.body.activation.id;
          const read = await http(p.token, `/deal-setup/activations/${out.act}/read-source`, { method: "POST", body: { source_artifact_id: up.body.artifact.id, source_as_of_date: AS_OF } });
          if (read.status !== 201) throw Object.assign(new Error(read.body && read.body.receipt), { httpStatus: read.status, code: read.body && read.body.error });
          out.proposals = (await http(p.token, `/deal-setup/activations/${out.act}`)).body.proposals;
        } else {
          const act = (await activation.openActivation(pool, { user_id: user.id, deal_intake_id: p.deal, property_id: p.id })).activation;
          out.act = act.id;
          const artifact = await artifacts.store(pool, { scope_type: "property", scope_id: p.id, filename, mimetype: "text/csv",
            buffer: Buffer.from(csv), uploaded_by_user_id: user.id, source_as_of_date: AS_OF });
          await activation.ingestRentRoll(pool, { user_id: user.id, deal_intake_id: p.deal, property_id: p.id, activation_id: act.id, source_artifact_id: artifact.id, source_as_of_date: AS_OF });
          out.proposals = (await activation.readActivation(pool, { user_id: user.id, activation_id: act.id })).proposals;
        }
        out.ok = true;
      } catch (e) { out.error = errOf(e); }
      return out;
    }
    async function confirmAll(p, proposals) {
      const results = [];
      for (const q of proposals) {
        if (api) { const r = await http(p.token, `/deal-setup/proposals/${q.id}/confirm`, { method: "POST" }); results.push({ key: q.natural_key, status: r.status, code: r.body && r.body.error || null }); }
        else { try { await activation.confirmProposal(pool, { user_id: user.id, proposed_id: q.id }); results.push({ key: q.natural_key, status: 200, code: null }); } catch (e) { const x = errOf(e); results.push({ key: q.natural_key, status: x.status, code: x.code }); } }
      }
      return results;
    }
    async function establish(p, act) {
      if (api) return (await http(p.token, `/deal-setup/activations/${act}/establish`, { method: "POST" })).status;
      await activation.establishOpeningPosition(pool, { user_id: user.id, activation_id: act }); return 201;
    }
    const spacesOf = (p) => all(`select u.unit_number, s.space_label, s.position_kind from spaces s join units u on u.id=s.unit_id where u.property_id=$1 order by 1,2`, [p.id]);
    const lineageOf = (p) => all(`select r.row_index, r.raw->>'unit_number' as unit_number, coalesce(r.raw->>'space_label', r.raw->>'room') as label,
        r.produced_unit_id is not null as unit_linked, (select space_label from spaces where id=r.produced_space_id) as produced_space, r.parse_note
       from import_source_rows r join import_batches b on b.id=r.import_batch_id where b.property_id=$1 order by r.row_index`, [p.id]);
    async function reads(p, unit) {
      //  SETUP, not the writer: availability refuses any position with no
      //  governed use (use_not_configured). The ingest writes none. An
      //  operator configures use; here it is set directly so the reads
      //  answer the inventory question rather than the use question.
      await pool.query("update spaces set use_type='residential' where use_type is null and unit_id in (select id from units where property_id=$1)", [p.id]);
      const dp = await datedPropertyPositions(pool, { property_id: p.id, as_of: AS_OF });
      const positions = dp.positions.filter((x) => x.unit_number === unit).map((x) => ({ label: x.space_label, derived_kind: x.position_kind, basis_state: x.basis_state, basis_type: x.basis_type }));
      const rr = await unitRentRoll(pool, { property_id: p.id, as_of: AS_OF });
      const rrUnit = (rr.units || []).find((u) => u.unit_number === unit) || null;
      const standing = await readTenancyStanding(pool, { property_id: p.id, as_of: AS_OF });
      const av = await availabilityRead(pool, { property_id: p.id, as_of: AS_OF });
      const avRows = av.rows.filter((r) => r.unit_number === unit).map((r) => ({ label: r.space_label, marketing_state: r.marketing_state, kind: r.position_kind }));
      const targets = [];
      for (const r of av.rows.filter((r) => r.unit_number === unit)) {
        const v = await resolveApplicationTarget(pool, { property_id: p.id, unit_id: r.unit_id, space_id: r.space_id });
        targets.push({ label: r.space_label, offerable: v.offerable === true, refusal: v.refusal_code || null });
      }
      let httpReads = null;
      if (api) {
        const canonical = await http(p.token, `/operator/leasing/availability-canonical?as_of=${AS_OF}`);
        const leaseable = await http(p.token, `/operator/leasing/leaseable-units`);
        const rrHttp = await http(p.token, `/operator/rent-roll/units?as_of=${AS_OF}`);
        httpReads = {
          availability_rows_for_unit: (canonical.body && canonical.body.rows || []).filter((r) => r.unit_number === unit).map((r) => [r.space_label, r.marketing_state]),
          eligible_targets_for_unit: (leaseable.body && leaseable.body.eligible_targets || []).filter((t) => t.unit_number === unit).map((t) => t.space_label),
          rent_roll_status: rrHttp.status,
          rent_roll_positions_for_unit: ((rrHttp.body && rrHttp.body.units) || []).filter((u) => u.unit_number === unit).map((u) => u.rentable_positions)[0] ?? null,
        };
      }
      return { positions, rent_roll_positions: rrUnit ? rrUnit.rentable_positions : null, standing_rentable_positions: standing.position && standing.position.rentable_positions, availability: avRows, targets, http: httpReads };
    }

    // ── 1. THE WRITER, BOTH ORDERS ─────────────────────────────────────
    const S1 = evidence.sections.writer = {};
    for (const [order, rows] of [["whole_then_room", ["401,(whole unit),VACANT,900,,,", "401,Room1,VACANT,900,,,"]], ["room_then_whole", ["402,Room1,VACANT,900,,,", "402,(whole unit),VACANT,900,,,"]]]) {
      const unit = rows[0].split(",")[0];
      const p = await property(order, "bed");
      const ing = await ingest(p, HEADER + rows.join("\n") + "\n");
      const after = { ingest: ing.error, spaces: await spacesOf(p), lineage: await lineageOf(p), proposals: ing.proposals.map((q) => [q.natural_key, q.status]) };
      after.confirm = ing.ok ? await confirmAll(p, ing.proposals) : null;
      after.establish = ing.ok ? await establish(p, ing.act) : null;
      after.lineage_after_confirm = await lineageOf(p);
      after.reads = await reads(p, unit);
      S1[order] = after;
      console.log(`  ${order}: spaces=${JSON.stringify(after.spaces)} lineage=${JSON.stringify(after.lineage.map((l) => [l.label, l.produced_space]))} confirm=${JSON.stringify(after.confirm)} establish=${after.establish}`);
      console.log(`  ${order}: reads=${JSON.stringify(after.reads)}`);
      const labels = after.spaces.map((s) => s.space_label).sort();
      ok(`1 ${order}: ingest accepted with no refusal and no discrepancy note`, ing.ok && after.lineage.every((l) => !/discrepancy/.test(l.parse_note || "")), JSON.stringify(ing.error));
      ok(`1 ${order}: the unit now carries BOTH '(whole unit)' and 'Room1' as positions`, labels.join("|") === "(whole unit)|Room1", labels.join("|"));
      ok(`1 ${order}: governed position_kind is 'bed' on both — including the whole-unit label`, after.spaces.every((s) => s.position_kind === "bed"), JSON.stringify(after.spaces));
      ok(`1 ${order}: ingest linked each row to its own position (produced_space_id set on both)`, after.lineage.length === 2 && after.lineage.every((l) => l.unit_linked && l.produced_space === l.label), JSON.stringify(after.lineage));
      ok(`1 ${order}: both rows confirm 200 through the current writer (named label found)`, after.confirm && after.confirm.every((c) => c.status === 200), JSON.stringify(after.confirm));
      ok(`1 ${order}: the opening position establishes (201)`, after.establish === 201, String(after.establish));
      ok(`1 ${order}: canonical read shows two established positions on one unit, both derived kind 'bed'`, after.reads.positions.length === 2 && after.reads.positions.every((x) => x.basis_state === "established" && x.derived_kind === "bed"), JSON.stringify(after.reads.positions));
      ok(`1 ${order}: Rent Roll and standing count two rentable positions for the unit`, after.reads.rent_roll_positions === 2 && after.reads.standing_rentable_positions === 2, JSON.stringify([after.reads.rent_roll_positions, after.reads.standing_rentable_positions]));
      ok(`1 ${order}: availability offers both as marketable_now`, after.reads.availability.length === 2 && after.reads.availability.every((r) => r.marketing_state === "marketable_now"), JSON.stringify(after.reads.availability));
      ok(`1 ${order}: the application authority offers both — the whole-unit position included`, after.reads.targets.length === 2 && after.reads.targets.every((t) => t.offerable), JSON.stringify(after.reads.targets));
      if (api) ok(`1 ${order} (HTTP): availability-canonical, leaseable-units and rent-roll/units agree over the wire`,
        after.reads.http.availability_rows_for_unit.length === 2 && after.reads.http.eligible_targets_for_unit.length === 2 && after.reads.http.rent_roll_positions_for_unit === 2, JSON.stringify(after.reads.http));
    }
    //  The mixed-KIND condition proposed on 904c768: does it fire here?
    const kinds = (S) => new Set(S.spaces.map((s) => s.position_kind));
    ok("1: a hold keyed on mixed position_kind within the unit would NOT fire — both positions are governed 'bed' (QB's objection stands)",
      kinds(S1.whole_then_room).size === 1 && kinds(S1.room_then_whole).size === 1);

    // ── 2. MATERIALIZATION DIRECTLY ────────────────────────────────────
    const S2 = evidence.sections.materialization = {};
    const pm = await property("materialize", "bed", { "411": ["(whole unit)"], "412": ["(whole unit)"], "413": ["(whole unit)"] });
    const tx = async (fn) => { const c = await pool.connect(); try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
    const mat = async (unit, labels) => { try { return { receipt: await tx((c) => materializeRentableSpaces(c, { unit_id: pm.unitIds[unit], labels, kind: "bed", use_type: "residential" })) }; } catch (e) { return { error: errOf(e) }; } };
    S2.both_orders = { a: await mat("411", ["(whole unit)", "Room1"]), b: await mat("412", ["Room1", "(whole unit)"]) };
    S2.spaces = await spacesOf(pm);
    const of = (u) => S2.spaces.filter((s) => s.unit_number === u);
    ok("2: materializeRentableSpaces accepts ['(whole unit)','Room1'] with kind 'bed' — no refusal", S2.both_orders.a.receipt && !S2.both_orders.a.error, JSON.stringify(S2.both_orders.a));
    ok("2: …and ['Room1','(whole unit)'] — order does not matter", S2.both_orders.b.receipt && !S2.both_orders.b.error, JSON.stringify(S2.both_orders.b));
    ok("2: the placeholder is KEPT (not consumed) because wanted includes it, and Room1 is created beside it",
      S2.both_orders.a.receipt.kept.includes("(whole unit)") && S2.both_orders.a.receipt.created.includes("Room1") && S2.both_orders.a.receipt.consumed_placeholder === null, JSON.stringify(S2.both_orders.a.receipt));
    ok("2: both positions are stamped position_kind 'bed' on both units", of("411").length === 2 && of("412").length === 2 && [...of("411"), ...of("412")].every((s) => s.position_kind === "bed"), JSON.stringify(S2.spaces));
    ok("2: INVENTORY_COUNT_MISMATCH does not fire — the count equals the wanted length, so the invariant 'as many as the source says' is satisfied by construction",
      S2.both_orders.a.receipt.total === 2);
    S2.control_consume = await mat("413", ["Room1"]);
    ok("2 (control): ['Room1'] alone CONSUMES the pristine placeholder — one position, no phantom",
      S2.control_consume.receipt && S2.control_consume.receipt.consumed_placeholder && of("413").length === 1 || (await spacesOf(pm)).filter((s) => s.unit_number === "413").length === 1, JSON.stringify(S2.control_consume));

    // ── 3. CONTROLS THROUGH THE SAME WRITER ────────────────────────────
    const S3 = evidence.sections.controls = {};
    const run = async (name, basis, csv, preexisting = {}, { confirm = true } = {}) => {
      const p = await property(name, basis, preexisting);
      const ing = await ingest(p, csv);
      const r = { ingest_error: ing.error, proposals: ing.proposals.map((q) => [q.natural_key, q.status]), spaces: await spacesOf(p), lineage: (await lineageOf(p)).map((l) => ({ label: l.label, unit: l.unit_number, produced: l.produced_space, note: l.parse_note })) };
      if (ing.ok && confirm) { r.confirm = await confirmAll(p, ing.proposals.filter((q) => q.status !== "blocked")); r.establish = await establish(p, ing.act); }
      r.property = p; return r;
    };
    //  C1 valid single whole-unit property (by-unit basis)
    S3.single_whole_unit = await run("c1-whole-unit", "unit", HEADER + "501,,VACANT,900,,,\n");
    ok("3 C1: a by-unit property keeps exactly one '(whole unit)' position and reads it established",
      S3.single_whole_unit.spaces.length === 1 && S3.single_whole_unit.spaces[0].space_label === "(whole unit)" && S3.single_whole_unit.confirm.every((c) => c.status === 200), JSON.stringify(S3.single_whole_unit.spaces));
    //  C2 sole bed with a ledger-style label
    S3.sole_bed_ledger_label = await run("c2-sole-bed", "bed", HEADER + "3B,Bed B,VACANT,900,,,\n");
    ok("3 C2: a sole bed named 'Bed B' consumes the placeholder — one position, kind bed, confirmable",
      S3.sole_bed_ledger_label.spaces.length === 1 && S3.sole_bed_ledger_label.spaces[0].space_label === "Bed B" && S3.sole_bed_ledger_label.spaces[0].position_kind === "bed" && S3.sole_bed_ledger_label.confirm[0].status === 200, JSON.stringify(S3.sole_bed_ledger_label.spaces));
    //  C2b the e2e fixture's shape: '(whole unit)' + 'Bed B' PRE-EXISTING, then the bed row is read
    S3.fixture_shape_reread = await run("c2b-fixture-shape", "bed", HEADER + "3B,Bed B,VACANT,900,,,\n", { "3B": ["(whole unit)", "Bed B"] });
    {
      const rd = await reads(S3.fixture_shape_reread.property, "3B"); S3.fixture_shape_reread.reads = rd; delete S3.fixture_shape_reread.property;
      const ph = rd.availability.find((r) => /whole/.test(r.label)), bed = rd.availability.find((r) => r.label === "Bed B");
      ok("3 C2b: re-reading the fixture shape reconciles to Bed B, creates nothing, and leaves the unclaimed placeholder occupancy_unknown (readers already hold an UNCLAIMED phantom)",
        S3.fixture_shape_reread.spaces.length === 2 && bed && bed.marketing_state === "marketable_now" && ph && ph.marketing_state === "occupancy_unknown", JSON.stringify(rd.availability));
    }
    //  C3 valid multi-bed unit
    S3.multi_bed = await run("c3-multi-bed", "bed", HEADER + ["701,Room1,VACANT,900,,,", "701,Room2,VACANT,900,,,", "701,Room3,VACANT,900,,,"].join("\n") + "\n");
    ok("3 C3: three named beds — placeholder consumed as Room1, three positions, all bed, all confirmable",
      S3.multi_bed.spaces.map((s) => s.space_label).join("|") === "Room1|Room2|Room3" && S3.multi_bed.spaces.every((s) => s.position_kind === "bed") && S3.multi_bed.confirm.every((c) => c.status === 200), JSON.stringify(S3.multi_bed.spaces));
    //  C4 a property with DIFFERENT whole-unit and bed units (valid mixed inventory)
    S3.mixed_property = await run("c4-mixed-property", "bed", HEADER + ["801,(whole unit),VACANT,900,,,", "802,Room1,VACANT,900,,,", "802,Room2,VACANT,900,,,"].join("\n") + "\n");
    {
      const u801 = S3.mixed_property.spaces.filter((s) => s.unit_number === "801"), u802 = S3.mixed_property.spaces.filter((s) => s.unit_number === "802");
      ok("3 C4: a whole-unit unit beside bed units is accepted — 801 has one position, 802 has two, all confirmable (valid mixed inventory; any assertion must not reject this)",
        u801.length === 1 && u802.length === 2 && S3.mixed_property.confirm.every((c) => c.status === 200), JSON.stringify(S3.mixed_property.spaces));
      ok("3 C4 (observed): the whole-unit position on 801 never passed through materialization (its label already existed), so its governed kind is NULL and the readers derive 'unit' from the label",
        u801[0].position_kind === null, JSON.stringify(u801));
    }
    //  C5 retained whole-unit history blocks conversion
    //  Placeholder with history first, then the source says beds.
    const c5 = await property("c5-history-real", "bed", { "901": ["(whole unit)"] });
    await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,850,'2026-01-01','2027-12-31','active')", [c5.id, c5.spaceIds["901|(whole unit)"], [person.id]]);
    const c5ing = await ingest(c5, HEADER + "901,Room1,VACANT,900,,,\n");
    S3.history_blocks_conversion = { ingest_error: c5ing.error, spaces: await spacesOf(c5) };
    ok("3 C5: a unit with a lease on its whole-unit position REFUSES to become beds — PLACEHOLDER_NOT_PRISTINE names the holder, nothing written",
      !c5ing.ok && /PLACEHOLDER_NOT_PRISTINE|whole-unit grain/i.test(JSON.stringify(c5ing.error)) && S3.history_blocks_conversion.spaces.length === 1, JSON.stringify(c5ing.error));
    //  C6 future-only room names must not create inventory
    S3.future_only_rooms = await run("c6-future-rooms", "bed", HEADER + "1001,Room1,VACANT,900,,,\nFuture Residents/Applicants,,,,,,\n1001,Room9,Future Person,900,900,2026-09-01,2027-08-31\n1002,Room1,Future Person Two,900,900,2026-09-01,2027-08-31\n", {}, { confirm: false });
    {
      const s = S3.future_only_rooms.spaces, l = S3.future_only_rooms.lineage;
      ok("3 C6: a future row naming Room9 creates no position and a future-only unit 1002 creates no unit — evidence retained with a discrepancy note",
        s.length === 1 && s[0].space_label === "Room1" && l.filter((x) => /discrepancy/.test(x.note || "")).length === 2, JSON.stringify({ s, l, error: S3.future_only_rooms.ingest_error }));
    }
    for (const k of Object.keys(S3)) if (S3[k].property) delete S3[k].property;

    // ── 4. THE CORRECTION PATH, THROUGH EXISTING WRITERS ───────────────
    const S4 = evidence.sections.correction = {};
    const mixed = await property("correction", "bed");
    const mixedIng = await ingest(mixed, HEADER + "421,(whole unit),VACANT,900,,,\n421,Room1,VACANT,900,,,\n");
    await confirmAll(mixed, mixedIng.proposals); await establish(mixed, mixedIng.act);
    const unitId = (await one("select id from units where property_id=$1 and unit_number='421'", [mixed.id])).id;
    //  4a. Ask materialization to make the unit what the source should have said.
    try { await tx((c) => materializeRentableSpaces(c, { unit_id: unitId, labels: ["Room1"], kind: "bed" })); S4.materialize_room1_only = { accepted: true }; }
    catch (e) { S4.materialize_room1_only = errOf(e); }
    ok("4a: materialization refuses to convert the claimed placeholder — first stop is PLACEHOLDER_NOT_PRISTINE, held by import_source_rows.produced_space_id (the ingest's own lineage)",
      S4.materialize_room1_only.code === "PLACEHOLDER_NOT_PRISTINE" && /import_source_rows/.test(S4.materialize_room1_only.message), JSON.stringify(S4.materialize_room1_only));
    //  4b. The authorized path the activation writer names: correct the file, start a NEW setup.
    //  Same name, same as-of, different bytes (901): refused as already read.
    const sameName = await ingest(mixed, HEADER + "421,Room1,VACANT,901,,,\n");
    S4.corrected_file_same_name = sameName.error;
    ok("4b (observed): a corrected file under the SAME name and as-of date is refused as already read — the idempotency key is (property, file name, as-of), not content",
      !sameName.ok && sameName.error && sameName.error.code === "already_established_from_this_file", JSON.stringify(sameName.error));
    const second = await ingest(mixed, HEADER + "421,Room1,VACANT,900,,,\n", "correction-v2.csv");
    S4.corrected_file_new_setup = { upload_status: second.upload_status, ingest_error: second.error, proposals: second.proposals.map((q) => [q.natural_key, q.status]) };
    if (second.ok) { S4.corrected_file_new_setup.confirm = await confirmAll(mixed, second.proposals); S4.corrected_file_new_setup.establish = await establish(mixed, second.act); }
    S4.corrected_file_new_setup.spaces = await spacesOf(mixed);
    S4.corrected_file_new_setup.reads = await reads(mixed, "421");
    {
      const rd = S4.corrected_file_new_setup.reads;
      const ph = rd.availability.find((r) => /whole/.test(r.label)), bed = rd.availability.find((r) => r.label === "Room1");
      ok("4b: a corrected rent roll in a NEW setup reads and establishes (the second activation supersedes the first)", second.ok && S4.corrected_file_new_setup.establish === 201, JSON.stringify(S4.corrected_file_new_setup));
      ok("4b: the phantom is NOT removed — still two positions on the unit", S4.corrected_file_new_setup.spaces.length === 2, JSON.stringify(S4.corrected_file_new_setup.spaces));
      ok("4b: under the corrected baseline the phantom drops to occupancy_unknown / not offerable while Room1 stays marketable — the readers hold it, they do not delete it",
        ph && ph.marketing_state === "occupancy_unknown" && bed && bed.marketing_state === "marketable_now" && rd.targets.find((t) => /whole/.test(t.label)) && !rd.targets.find((t) => /whole/.test(t.label)).offerable, JSON.stringify(rd));
      ok("4b: the earlier confirmed claim on the placeholder is preserved as history (superseded baseline, promoted row intact)",
        (await one(`select count(*)::int as n from proposed_records pr where pr.property_id=$1 and pr.natural_key='421|(whole unit)' and pr.status='promoted'`, [mixed.id])).n === 1
        && (await one(`select count(*)::int as n from opening_tenancy_positions where property_id=$1 and superseded_at is not null`, [mixed.id])).n === 1);
    }

    if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, "mixed-grain-writer-challenge.json"), JSON.stringify(evidence, null, 2));
  } finally { await pool.end(); }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
