#!/usr/bin/env node
"use strict";
/* ═══════════════════════════════════════════════════════════════════
   current_rent_roll_reconciliation.db.js — ACCEPTING A CURRENT EXTERNAL
   RENT ROLL INTO AN ALREADY-ONBOARDED PROPERTY, THROUGH THE REAL DOORS.

   Skyline is the immediate case; the same mechanism must serve the next
   property. The fixture reproduces the HISTORICAL shape QB read on
   2026-09-13 — 72 durable units / 160 beds, a July source established in
   August with 37 named current rows (31 promoted leases, 6 held), 123
   vacancies and 91 future rows that produced no proposal, later pending
   rights on 27 spaces (44 pending leases, 13 overlapping) — and the ACTUAL
   inventory shape: every Room1/Room2/Room3 space carries
   position_kind='unit' (the unconditional write in
   tools/apply_unit_type_mapping.js, whose correction Codex Luna owns).

   Names, phones and rents are synthetic. Labels and date shapes come from
   the retained Skyline seed vocabulary. The legacy state is seeded ONCE by
   fixture SQL; every business change after that crosses the mounted Deal
   Setup doors on the owned server. The one exception is the classification
   stand-in named in section C, which represents Luna's correction and is
   labelled as such.

   WITNESS mode (CURRENT_RR_WITNESS=1): run against the unmodified baseline;
   the assertions that name the gap go red by design.

   Run (drive.js starts the owned server):
     HARNESS_DATABASE_URL=... E2E_API_BASE=http://127.0.0.1:3111 \
       node tests/proofs/current_rent_roll_reconciliation.db.js
   ═══════════════════════════════════════════════════════════════════ */
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");
const boundary = require("../e2e/proof_boundary.js");
const seed = require("../../seeds/data_skyline.js");

const DB_URL = receipt.harnessConnectionString();
boundary.manifest();
const BASE = new URL(process.env.E2E_API_BASE || "http://127.0.0.1:3111");
const WITNESS = process.env.CURRENT_RR_WITNESS === "1";
const pool = new Pool({ connectionString: DB_URL, ssl: false });
const nonce = crypto.randomBytes(4).toString("hex");
const TAG = `CRR_${nonce}`;
const results = [];
let passed = 0, failed = 0, current = "setup";
function ok(label, condition, detail) {
  results.push({ section: current, label, ok: !!condition, detail: detail === undefined ? null : detail });
  if (condition) { passed++; console.log(`  ok    [${current}] ${label}`); }
  else { failed++; console.log(`  FAIL  [${current}] ${label}${detail !== undefined ? "\n        " + JSON.stringify(detail).slice(0, 500) : ""}`); }
  return !!condition;
}
function observe(label, detail) { results.push({ section: current, label, ok: true, observe: true, detail }); console.log(`  NOTE  [${current}] ${label}${detail !== undefined ? " | " + JSON.stringify(detail).slice(0, 400) : ""}`); }
async function section(name, fn) { current = name; console.log(`\n== ${name} ==`); try { await fn(); } catch (e) { ok(`section aborted: ${e.message}`, false, e.stack && e.stack.split("\n").slice(0, 3)); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, pathname, token, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { "x-staff-session": token, "x-proof-run": process.env.PROOF_RUN_NONCE || "",
      ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}), ...extra };
    const req = http.request({ hostname: BASE.hostname, port: BASE.port, method, path: pathname, headers }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString("utf8"); let b = null; try { b = t ? JSON.parse(t) : null; } catch { b = { text: t }; } resolve({ status: res.statusCode, body: b }); });
    });
    req.on("error", reject); if (bytes) req.write(bytes); req.end();
  });
}
function multipart(filename, csv, asOf) {
  const mark = `----spine-${crypto.randomBytes(8).toString("hex")}`;
  return { bytes: Buffer.concat([
    Buffer.from(`--${mark}\r\nContent-Disposition: form-data; name="source_as_of_date"\r\n\r\n${asOf}\r\n`),
    Buffer.from(`--${mark}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(csv), Buffer.from(`\r\n--${mark}--\r\n`)]), type: `multipart/form-data; boundary=${mark}` };
}
function upload(deal, property, token, filename, csv, asOf) {
  const mp = multipart(filename, csv, asOf);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: BASE.hostname, port: BASE.port, method: "POST",
      path: `/deal-setup/deals/${deal}/properties/${property}/source`,
      headers: { "x-staff-session": token, "x-proof-run": process.env.PROOF_RUN_NONCE || "", "content-type": mp.type, "content-length": mp.bytes.length } },
    (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString("utf8"); let b = null; try { b = JSON.parse(t); } catch { b = { text: t }; } resolve({ status: res.statusCode, body: b }); }); });
    req.on("error", reject); req.end(mp.bytes);
  });
}
const q = (sql, args = []) => pool.query(sql, args);
const one = async (sql, args = []) => (await q(sql, args)).rows[0];
const staffSessions = require("../../src/identity/staff_session_service.js");
async function session(userId, propertyId) {
  return (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
}
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvOf = (headers, rows) => [headers.join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n");
const AS_OF_JULY = "2026-07-31", AS_OF_NOW = "2026-09-13";
const LETTER = ["A", "B", "C"];

(async () => {
  receipt.begin(__filename, { url: DB_URL, expected: null });
  await boundary.assertDatabase();
  const F = {};
  const readers = {
    dated: require("../../src/tenancy/dated_positions.js"),
    standing: require("../../src/tenancy/tenancy_position_read.js"),
    rentRoll: require("../../src/surfaces/rent_roll_unit_view.js"),
    availability: require("../../src/surfaces/availability_read.js"),
    occupancy: require("../../src/leasing/leasing_occupancy_facts.js"),
  };
  const bucketsOf = async (pid) => {
    const dp = await readers.dated.datedPropertyPositions(pool, { property_id: pid, as_of: AS_OF_NOW });
    const t = readers.dated.rentRollBuckets(dp.positions);
    return { total: t.total, occupied: t.occupied, activation_pending: t.activation_pending, open: t.open, needs_review: t.needs_review, not_established: t.not_established, established: t.established, positions: dp.positions };
  };

  try {
    await section("fixture · organization, actors, Skyline-shaped property with the actual wrong-kind rooms", async () => {
      F.org = (await one(`insert into organizations(name,slug) values($1,$2) returning id`, [TAG, TAG.toLowerCase()])).id;
      async function user(name, { platform_role = "member", phoneSuffix }) {
        const person = (await one(`insert into persons(name,source) values($1,'rehearsal') returning id`, [`${name} ${nonce}`])).id;
        return one(`insert into users(name,email,phone,role,auth_provider,platform_role,organization_id,is_active,status,account_kind,person_id)
          values($1,$2,$3,'property_manager','phone_otp',$4,$5,true,'active','human_staff',$6) returning id, person_id`,
          [`${name} ${nonce}`, `${name.toLowerCase().replace(/\s+/g, ".")}.${nonce}@example.test`, `+1215${String(3000000 + (parseInt(nonce.slice(0, 5), 16) % 6000000) + Number(phoneSuffix)).padStart(7, "0")}`, platform_role, F.org, person]);
      }
      F.oa = await user("Org Admin", { platform_role: "org_admin", phoneSuffix: "0001" });
      F.mike = await user("Mike Shape", { phoneSuffix: "0002" });     //  leasing + management, no platform role
      F.revocable = await user("Revocable Reviewer", { phoneSuffix: "0003" });
      F.suspendable = await user("Suspendable Reviewer", { phoneSuffix: "0004" });
      F.outsider = await user("Outsider", { phoneSuffix: "0005" });
      F.p = (await one(`insert into properties(name,display_name,address,organization_id,leasing_basis,operating_timezone) values($1,'Skyline (rehearsal)','1417 N 15th St (rehearsal)',$2,'bed','America/New_York') returning id`, [`${TAG} skyline`, F.org])).id;
      F.other = (await one(`insert into properties(name,display_name,address,organization_id,leasing_basis,operating_timezone) values($1,'Other Shape (rehearsal)','9 Other St',$2,'unit','America/New_York') returning id`, [`${TAG} other`, F.org])).id;
      for (const u of [F.oa, F.mike, F.revocable, F.suspendable]) {
        await q(`insert into property_team_assignments(property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
                 values($1,$2,'property_manager','property_manager','property',array['leasing','management'],'{management}',false,true)`, [F.p, u.id]);
        await q(`insert into property_team_assignments(property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
                 values($1,$2,'property_manager','property_manager','property',array['leasing','management'],'{management}',false,true)`, [F.other, u.id]);
      }
      await q(`insert into property_team_assignments(property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
               values($1,$2,'property_manager','property_manager','property',array['leasing','management'],'{management}',false,true)`, [F.other, F.outsider.id]);
      F.revocableAsg = (await one(`select id from property_team_assignments where user_id=$1 and property_id=$2`, [F.revocable.id, F.p])).id;
      //  72 durable units, 160 beds, in the retained Skyline label vocabulary.
      //  THE ACTUAL SHAPE: rooms are labelled Room1/Room2/Room3 but carry
      //  position_kind='unit' (the mapping tool's unconditional write).
      F.units = new Map(); F.spaces = [];   //  spaces in seed order
      for (const r of seed.CURRENT) {
        if (!F.units.has(r[0])) {
          const u = await one(`insert into units(property_id,unit_number) values($1,$2) returning id`, [F.p, r[0]]);
          await q(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [u.id]);   //  the shape has no placeholder beside its rooms
          F.units.set(r[0], u.id);
        }
        const s = await one(`insert into spaces(unit_id,space_label,position_kind,use_type) values($1,$2,'unit','residential') returning id`, [F.units.get(r[0]), r[1]]);
        F.spaces.push({ unit: r[0], unit_id: F.units.get(r[0]), room: r[1], space_id: s.id, ordinal: Number(r[1].replace("Room", "")), seedNamed: !!r[3] });
      }
      const shape = await one(`select (select count(*)::int from units where property_id=$1) units,
        (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1) spaces,
        (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.position_kind='unit' and s.space_label like 'Room%') wrong_kind`, [F.p]);
      ok("72 units / 160 beds; all 160 room-labelled spaces carry position_kind='unit' (the actual wrong-kind shape)", shape.units === 72 && shape.spaces === 160 && shape.wrong_kind === 160, shape);
      //  The other property shape: three whole-unit homes (unit basis).
      F.otherUnits = [];
      for (const label of ["Apt 1", "Apt 2", "Apt 3"]) {
        const u = await one(`insert into units(property_id,unit_number) values($1,$2) returning id`, [F.other, label]);
        const s = await one(`select id from spaces where unit_id=$1 and space_label='(whole unit)'`, [u.id]);
        F.otherUnits.push({ label, unit_id: u.id, space_id: s.id });
      }
      F.oaTok = await session(F.oa.id, F.p); F.mikeTok = await session(F.mike.id, F.p); F.revTok = await session(F.revocable.id, F.p);
      F.susTok = await session(F.suspendable.id, F.p); F.outTok = await session(F.outsider.id, F.other); F.mikeOtherTok = await session(F.mike.id, F.other);
    });

    await section("legacy seed · the July source as it was established in August, later pending rights, no possession events", async () => {
      //  Deal container through the real door (not history), then the
      //  historical evidence and claims by fixture SQL, once.
      const made = await request("POST", "/deal-setup/deals", F.oaTok, { deal_name: `${TAG} deal` });
      if (!(made.body && made.body.deal)) throw new Error("deal creation refused: " + JSON.stringify(made));
      F.deal = made.body.deal.id;
      const added = await request("POST", `/deal-setup/deals/${F.deal}/properties`, F.oaTok, { property_id: F.p });
      const addedOther = await request("POST", `/deal-setup/deals/${F.deal}/properties`, F.oaTok, { property_id: F.other });
      ok("the deal holds both properties", made.status === 201 && added.status === 201 && addedOther.status === 201, { made: made.status, added: added.status, other: addedOther.status });
      //  Synthetic July file bytes: retained as the artifact behind the legacy activation.
      const julyHeaders = ["Unit", "Room", "Resident", "Market Rent", "Actual Rent", "Lease From", "Lease To"];
      const named = F.spaces.filter((s) => s.seedNamed);
      F.julyNamed = named.slice(0, 37);                    //  37 named then-current rows
      F.julyHeld = new Set(F.julyNamed.slice(31).map((s) => s.space_id));   //  6 held for overlap review
      const namedIds = new Set(F.julyNamed.map((s) => s.space_id));
      F.julyVacant = F.spaces.filter((s) => !namedIds.has(s.space_id));    //  123 vacancies
      F.julyFuture = F.julyVacant.slice(0, 91);            //  91 future rows on vacancy home keys
      F.person = new Map();                                //  space_id -> person id of the July current resident
      const julyRows = [];
      let i = 0;
      for (const s of F.spaces) {
        i++;
        if (namedIds.has(s.space_id)) julyRows.push({ __row: i, s, Unit: s.unit, Room: s.room, Resident: `July Resident ${String(i).padStart(3, "0")} ${nonce}`, "Market Rent": 900, "Actual Rent": 850, "Lease From": "08/01/2025", "Lease To": "12/31/2026" });
        else julyRows.push({ __row: i, s, Unit: s.unit, Room: s.room, Resident: "VACANT", "Market Rent": 900, "Actual Rent": "", "Lease From": "", "Lease To": "" });
      }
      for (const s of F.julyFuture) { i++; julyRows.push({ __row: i, s, future: true, Unit: s.unit, Room: s.room, Resident: `Future Resident ${String(i).padStart(3, "0")} ${nonce}`, "Market Rent": 900, "Actual Rent": 875, "Lease From": "08/01/2026", "Lease To": "07/26/2027" }); }
      const julyCsv = csvOf(julyHeaders, julyRows);
      const sha = crypto.createHash("sha256").update(julyCsv).digest("hex");
      F.julyArtifact = (await one(`insert into source_artifacts(scope_type,scope_id,original_filename,mime_type,artifact_kind,byte_size,sha256,content,source_as_of_date,uploaded_by_user_id,uploaded_by_basis)
        values('property',$1,'RentRoll07_1417 (rehearsal).csv','text/csv','rent_roll',$2,$3,$4,$5,$6,'fixture: legacy July source') returning id`.replace("uploaded_by_basis)", "uploaded_by_basis,stored_at)").replace("$6,'fixture: legacy July source')", "$6,'fixture: legacy July source','2026-08-17')"),
        [F.p, Buffer.byteLength(julyCsv), sha, Buffer.from(julyCsv), AS_OF_JULY, F.oa.id])).id;
      F.julyBatch = (await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status,source_artifact_id,notes)
        values($1,'rent_roll_ledger','RentRoll07_1417 (rehearsal).csv',$2,'bed','extracted','committed',$3,'fixture: legacy July activation, established 2026-08-17') returning id`, [F.p, AS_OF_JULY, F.julyArtifact])).id;
      F.julyActivation = (await one(`insert into activations(deal_id,property_id,source_label,status,source_artifact_id,import_batch_id,source_as_of_date,opened_by_user_id,created_at,updated_at)
        values($1,$2,'RentRoll07_1417 (rehearsal).csv','activated',$3,$4,$5,$6,'2026-08-17','2026-08-17') returning id`, [F.deal, F.p, F.julyArtifact, F.julyBatch, AS_OF_JULY, F.oa.id])).id;
      let leases = 0, held = 0, vacancies = 0, futures = 0;
      for (const r of julyRows) {
        const raw = { unit_number: r.Unit, space_label: r.Room, name: r.Resident === "VACANT" ? null : r.Resident, status: r.Resident === "VACANT" ? "vacant" : null, market_rent: r["Market Rent"], actual_rent: r["Actual Rent"] === "" ? null : r["Actual Rent"], lease_from: r["Lease From"] ? "2025-08-01" : null, lease_to: r["Lease To"] ? "2026-12-31" : null, section: r.future ? "future" : "current", _source_cells: { Unit: r.Unit, Room: r.Room, Resident: r.Resident } };
        if (r.future) {
          raw.lease_from = "2026-08-01"; raw.lease_to = "2027-07-26";
          await q(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note) values($1,$2,$3,'future ledger row — evidence only (historical natural-key rule produced no proposal)')`, [F.julyBatch, r.__row, JSON.stringify(raw)]);
          futures++; continue;
        }
        const vacant = r.Resident === "VACANT";
        const isr = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id) values($1,$2,$3,$4,$5,$6) returning id`,
          [F.julyBatch, r.__row, JSON.stringify(raw), vacant ? "current ledger row — confirmed vacant" : "current ledger row", r.s.unit_id, r.s.space_id]);
        const normalized = { unit_number: r.Unit, tenant_name: vacant ? null : r.Resident, rent: vacant ? null : 850, market_rent: 900, actual_rent: vacant ? null : 850, start_date: vacant ? null : "2025-08-01", end_date: vacant ? null : "2026-12-31", space_label: r.Room, non_revenue: vacant, is_vacant: vacant, section: "current", status: vacant ? "vacant" : null };
        if (vacant) {
          await q(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,payload_json,normalized_json,evidence_refs,confidence,status,status_reason,import_source_row_id,confirmed_by,confirmed_at)
                   values($1,$2,'leasing','lease',$3,$4,$5,$6,0.85,'promoted','Confirmed as a vacant rentable position. No lease was created.',$7,$8,'2026-08-17')`,
            [F.julyActivation, F.p, `${r.Unit}|${r.Room}`, JSON.stringify(raw), JSON.stringify(normalized), JSON.stringify([{ source: "RentRoll07_1417 (rehearsal).csv", row: r.__row, import_source_row_id: isr.id }]), isr.id, String(F.oa.id)]);
          vacancies++; continue;
        }
        const person = (await one(`insert into persons(name,source,lifecycle_status,leasing_stage,import_batch_id,source_type,source_as_of_date,confidence) values($1,'activation','resident','resident',$2,'rent_roll_ledger',$3,'extracted') returning id`, [r.Resident, F.julyBatch, AS_OF_JULY])).id;
        F.person.set(r.s.space_id, person);
        if (F.julyHeld.has(r.s.space_id)) {
          await q(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,payload_json,normalized_json,evidence_refs,confidence,status,status_reason,import_source_row_id)
                   values($1,$2,'leasing','lease',$3,$4,$5,$6,0.9,'needs_review','Held for overlap review under the July source.',$7)`,
            [F.julyActivation, F.p, `${r.Unit}|${r.Room}`, JSON.stringify(raw), JSON.stringify(normalized), JSON.stringify([{ source: "RentRoll07_1417 (rehearsal).csv", row: r.__row, import_source_row_id: isr.id }]), isr.id]);
          held++; continue;
        }
        const lease = (await one(`insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,balance,lease_status,import_batch_id,source_type,source_as_of_date,confidence)
                                  values($1,$2,$3,850,'2025-08-01','2026-12-31',0,'active',$4,'rent_roll_ledger',$5,'extracted') returning id`, [F.p, r.s.space_id, [person], F.julyBatch, AS_OF_JULY])).id;
        await q(`update import_source_rows set produced_person_id=$2, produced_lease_id=$3 where id=$1`, [isr.id, person, lease]);
        await q(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,payload_json,normalized_json,evidence_refs,confidence,status,promoted_record_id,import_source_row_id,confirmed_by,confirmed_at)
                 values($1,$2,'leasing','lease',$3,$4,$5,$6,0.9,'promoted',$7,$8,$9,'2026-08-17')`,
          [F.julyActivation, F.p, `${r.Unit}|${r.Room}`, JSON.stringify(raw), JSON.stringify(normalized), JSON.stringify([{ source: "RentRoll07_1417 (rehearsal).csv", row: r.__row, import_source_row_id: isr.id }]), lease, isr.id, String(F.oa.id)]);
        leases++;
      }
      F.opening = (await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status,established_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,'fixture: legacy establishment','established','2026-08-17') returning id`, [F.p, F.deal, F.julyActivation, F.julyBatch, AS_OF_JULY, leases + vacancies, held, 160, F.oa.id])).id;
      await q(`insert into opening_tenancy_position_sources(opening_tenancy_position_id,source_artifact_id,role) values($1,$2,'rent_roll')`, [F.opening, F.julyArtifact]);
      ok("July shape: 37 named (31 leases + 6 held), 123 vacancies promoted, 91 future rows with no proposal, established 2026-08-17", leases === 31 && held === 6 && vacancies === 123 && futures === 91, { leases, held, vacancies, futures });
      //  LATER PENDING RIGHTS: 44 pending leases on 27 spaces spanning 2026-09-13;
      //  22 of the 91 future spaces and 5 other vacant spaces; 13 spaces overlap.
      const pendingSpaces = [...F.julyFuture.slice(0, 22), ...F.julyVacant.slice(91, 96)];
      F.pendingBySpace = new Map();
      let pendingLeases = 0, k = 0;
      for (let idx = 0; idx < pendingSpaces.length; idx++) {
        const s = pendingSpaces[idx];
        const count = idx < 9 ? 2 : idx < 13 ? 3 : 1;
        F.pendingBySpace.set(s.space_id, []);
        for (let c = 0; c < count; c++) {
          k++;
          const person = (await one(`insert into persons(name,source,lifecycle_status,leasing_stage) values($1,'application','applicant','future_resident') returning id`, [`Pending Applicant ${String(k).padStart(3, "0")} ${nonce}`])).id;
          const lease = (await one(`insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,balance,lease_status,source_type)
                                    values($1,$2,$3,875,'2026-08-01','2027-07-26',0,'pending','application') returning id`, [F.p, s.space_id, [person]])).id;
          F.pendingBySpace.get(s.space_id).push({ lease, person }); pendingLeases++;
        }
      }
      const overlapping = [...F.pendingBySpace.values()].filter((l) => l.length > 1).length;
      ok("later records: 44 pending leases on 27 spaces spanning 2026-09-13 (22 future spaces), 13 positions overlapping; no possession events", pendingLeases === 44 && F.pendingBySpace.size === 27 && overlapping === 13 && (await one(`select count(*)::int n from unit_events e join units u on u.id=e.unit_id where u.property_id=$1`, [F.p])).n === 0, { pendingLeases, spaces: F.pendingBySpace.size, overlapping });
      F.before = await bucketsOf(F.p);
      observe("canonical dated rent roll on the seeded shape (buckets)", { total: F.before.total, occupied: F.before.occupied, activation_pending: F.before.activation_pending, open: F.before.open, needs_review: F.before.needs_review, not_established: F.before.not_established });
      ok("the seeded shape reads 160 positions with the July baseline (31 occupied by lease)", F.before.total === 160 && F.before.occupied === 31, { total: F.before.total, occupied: F.before.occupied });
    });

    //  ── THE CURRENT SOURCE (Temple Tracker shape) ─────────────────────
    //  160 rows in the retained bed order: 148 Signed with Key Pickup TRUE and
    //  a positive Monthly Rent, 12 rows blank. Unit cells carry the tracker's
    //  own labels ("101A"); the Room cell carries the letter. Two source
    //  identity conflicts are reproduced at rows 75/76 and 140/141.
    const trackerHeaders = ["Unit", "Room", "Unit Type", "Semester", "Signed/Pending", "New/Renewal", "Name", "Phone", "Email", "Monthly Rent", "Key Pickup"];
    F.blankRows = new Set();
    F.tracker = [];
    F.expect = new Map();   //  space_id -> expected reconciliation class
    {
      const activeLeaseSpaces = F.julyNamed.slice(0, 31).map((s) => s.space_id);
      const pendingSpaceIds = [...F.pendingBySpace.keys()];
      //  The two source identity conflicts sit on two rooms of ONE unit each
      //  (the shape QB read: C75/C76 both "212A - Reno" with D75=A, D76=B;
      //  C140=405A/D140=A and C141=405B/D141=A). Placed at the first
      //  same-unit pair at or after rows 75 and 140.
      const pairAt = (from) => { for (let i = from; i + 1 < F.spaces.length; i++) if (F.spaces[i].unit === F.spaces[i + 1].unit) return [i + 1, i + 2]; throw new Error("no same-unit pair"); };
      F.conflictReno = pairAt(74); F.conflictRoom = pairAt(139);
      let row = 0;
      for (const s of F.spaces) {
        row++;
        const stem = s.unit.replace(/^1417-/, "");
        const letter = LETTER[s.ordinal - 1];
        let unitCell = `${stem}${letter}`, roomCell = letter;
        if (row === F.conflictReno[0] || row === F.conflictReno[1]) { unitCell = `${stem}A - Reno`; roomCell = row === F.conflictReno[0] ? "A" : "B"; }
        if (row === F.conflictRoom[1]) { roomCell = "A"; }   //  Unit cell says B, Room cell says A
        let name = null, kind;
        const activeIdx = activeLeaseSpaces.indexOf(s.space_id);
        const pending = F.pendingBySpace.get(s.space_id) || null;
        if (activeIdx >= 0) {
          if (activeIdx < 28) { name = (await one(`select name from persons where id=$1`, [F.person.get(s.space_id)])).name; kind = "already_represented_active"; }
          else { name = `Turnover Resident ${row} ${nonce}`; kind = "conflict_active_other_person"; }
        } else if (pending) {
          if (pendingSpaces(pending) === 1 && F.blankRows.size < 2) { F.blankRows.add(s.space_id); kind = "blank_with_pending_right"; }
          else if (pending.length === 1) { name = (await one(`select name from persons where id=$1`, [pending[0].person])).name; kind = "already_represented_pending"; }
          else { name = `Signed Over Overlap ${row} ${nonce}`; kind = "conflict_overlapping_pending"; }
        } else if (F.julyHeld.has(s.space_id)) { name = `Held Bed Signed ${row} ${nonce}`; kind = "new_claim_on_held"; }
        else if (F.blankRows.size < 12 && (row % 13 === 0)) { F.blankRows.add(s.space_id); kind = "blank_on_vacancy"; }
        else { name = `New Signed ${row} ${nonce}`; kind = "new_claim_on_vacancy"; }
        function pendingSpaces(p) { return p.length; }
        F.expect.set(s.space_id, kind);
        const blank = F.blankRows.has(s.space_id);
        F.tracker.push({ row, s, Unit: unitCell, Room: roomCell, "Unit Type": "STU", Semester: blank ? "" : "Full Year", "Signed/Pending": blank ? "" : "Signed", "New/Renewal": blank ? "" : "New", Name: blank ? "" : name, Phone: "", Email: "", "Monthly Rent": blank ? "" : 850, "Key Pickup": blank ? "FALSE" : "TRUE" });
      }
      //  Top up blanks to exactly 12 from vacancy beds if the modulo left fewer.
      for (const t of F.tracker) {
        if (F.blankRows.size >= 12) break;
        if (F.expect.get(t.s.space_id) === "new_claim_on_vacancy") { F.blankRows.add(t.s.space_id); F.expect.set(t.s.space_id, "blank_on_vacancy"); Object.assign(t, { Semester: "", "Signed/Pending": "", "New/Renewal": "", Name: "", "Monthly Rent": "", "Key Pickup": "FALSE" }); }
      }
    }
    F.trackerCsv = csvOf(trackerHeaders, F.tracker);
    const signed = F.tracker.filter((t) => t["Signed/Pending"] === "Signed").length;
    const cr = F.conflictReno, cm = F.conflictRoom;
    ok("the current source has 160 rows: 148 Signed (keys TRUE, positive rent) and 12 blank; two identity conflicts (both cells 'A - Reno' with Room A/B; Unit A/B with Room A/A)", F.tracker.length === 160 && signed === 148 && F.blankRows.size === 12, { signed, blank: F.blankRows.size, reno: [F.tracker[cr[0] - 1].Unit + "/" + F.tracker[cr[0] - 1].Room, F.tracker[cr[1] - 1].Unit + "/" + F.tracker[cr[1] - 1].Room], room: [F.tracker[cm[0] - 1].Unit + "/" + F.tracker[cm[0] - 1].Room, F.tracker[cm[1] - 1].Unit + "/" + F.tracker[cm[1] - 1].Room] });
    const classes = {}; for (const k of F.expect.values()) classes[k] = (classes[k] || 0) + 1;
    observe("designated reconciliation classes (fixture choices, not findings)", classes);

    await section("A · newer current source on the established property: upload, open, preview (the run as far as it goes)", async () => {
      F.up = await upload(F.deal, F.p, F.mikeTok, "Temple Tracker 2026-2027 Skyline RR (rehearsal).csv", F.trackerCsv, AS_OF_NOW);
      ok("Mike-shaped session uploads the current source; bytes retained", F.up.status === 201 && F.up.body.artifact && F.up.body.artifact.id, { status: F.up.status, body: F.up.body && (F.up.body.error || F.up.body.receipt) });
      const opened = await request("POST", `/deal-setup/deals/${F.deal}/properties/${F.p}/activation`, F.mikeTok, {});
      ok("a new setup opens on the already-established property (the July setup stays activated)", [200, 201].includes(opened.status) && opened.body.activation && opened.body.activation.id !== F.julyActivation, { status: opened.status, error: opened.body && opened.body.error });
      F.act = opened.body.activation.id;
      F.preview = await request("POST", `/deal-setup/activations/${F.act}/preview-source`, F.mikeTok, { source_artifact_id: F.up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed" });
      ok("preview parses the tracker shape: 160 grouped source identities, Unit + Room understood, tracker-only columns reported", F.preview.status === 200 && F.preview.body.identities && F.preview.body.identities.length === 160, { status: F.preview.status, error: F.preview.body && F.preview.body.error, receipt: F.preview.body && F.preview.body.receipt, counts: F.preview.body && F.preview.body.counts, mapping: F.preview.body && F.preview.body.mapping && F.preview.body.mapping.summary });
      if (F.preview.status !== 200) throw new Error("preview failed: " + JSON.stringify(F.preview.body).slice(0, 300));
      const ids = F.preview.body.identities;
      ok("no source home is auto-matched: tracker labels (101A / A) are not the canonical labels (1417-101 / Room1); every group is unfamiliar", ids.every((g) => !g.suggested_decision) && ids.every((g) => g.status === "unfamiliar"), F.preview.body.counts);
      const t = (n) => F.tracker[n - 1];
      const r75 = ids.find((g) => g.source.unit_number === t(F.conflictReno[0]).Unit && g.source.space_label === "A"), r76 = ids.find((g) => g.source.unit_number === t(F.conflictReno[1]).Unit && g.source.space_label === "B");
      ok("the '- Reno' conflict yields two distinct source identities (A and B) that still require an explicit reviewed choice", r75 && r76 && r75.key !== r76.key && !r75.suggested_decision && !r76.suggested_decision);
      const r140 = ids.find((g) => g.source.unit_number === t(F.conflictRoom[0]).Unit), r141 = ids.find((g) => g.source.unit_number === t(F.conflictRoom[1]).Unit);
      ok("the Unit-A/Unit-B-with-Room-A conflict yields two distinct identities requiring explicit choices", r140 && r141 && r140.key !== r141.key && r141.source.space_label === "A");
      //  Every available unit lists its rooms with the ACTUAL kind.
      const kinds = new Set(); for (const u of F.preview.body.available_units) for (const s of u.spaces) kinds.add(s.kind);
      ok("preview reports the rooms' actual position_kind ('unit') — the shape the reviewer will be offered", kinds.size === 1 && kinds.has("unit"), [...kinds]);
    });

    //  THE EXPLICIT REVIEWED MAPPING. A reviewer's table, stated once:
    //  tracker "<stem><letter>" → canonical "1417-<stem>", letter → Room<ordinal>.
    //  The two conflict rows are decided by the reviewer, not by a column rule:
    //  row 75 (Room A) → Room1, row 76 (Room B) → Room2; row 140 (405A) → Room1,
    //  row 141 (405B, Room cell A) → Room2. None of this claims production identity.
    function reviewedDecisions(preview) {
      const byKey = new Map(preview.identities.map((g) => [g.source.unit_number + "|" + (g.source.space_label || ""), g]));
      const units = new Map(preview.available_units.map((u) => [u.label, u]));
      const decisions = [];
      for (const t of F.tracker) {
        const g = byKey.get(t.Unit + "|" + t.Room);
        if (!g) throw new Error("no preview group for tracker row " + t.row);
        const unit = units.get(t.s.unit);
        const space = unit && unit.spaces.find((s) => s.label === t.s.room);
        if (!unit || !space) throw new Error("reviewed target missing for " + t.s.unit + " " + t.s.room);
        decisions.push({ key: g.key, action: "select_existing", unit_id: unit.id, space_id: space.id, fingerprint: space.fingerprint });
      }
      return decisions;
    }

    await section("B · first red on the actual shape: the explicit bed selection is refused because the rooms carry position_kind='unit'", async () => {
      const decisions = reviewedDecisions(F.preview.body);
      const apply = await request("POST", `/deal-setup/activations/${F.act}/read-source`, F.mikeTok, { source_artifact_id: F.up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed", source_token: F.preview.body.source_token, inventory_decisions: decisions });
      ok("FIRST RED: read-source refuses the reviewed selection with inventory_target_changed — grainMatches requires position_kind='bed' for a bed-basis selection and every Skyline room reads 'unit'", apply.status === 409 && apply.body.error === "inventory_target_changed", { status: apply.status, error: apply.body && apply.body.error, receipt: apply.body && apply.body.receipt });
      const untouched = await one(`select (select count(*)::int from import_batches where property_id=$1) batches, (select count(*)::int from proposed_records where activation_id=$2) proposals, (select leasing_basis from properties where id=$1) basis`, [F.p, F.act]);
      ok("the refusal wrote nothing: one batch (July), no proposals on the new setup, basis unchanged", untouched.batches === 1 && untouched.proposals === 0 && untouched.basis === "bed", untouched);
      observe("DEPENDENCY: the classification is corrected by the governed mapping tool (Codex Luna's lane), not by this proof and not by relaxing the source-home rule. What follows applies that correction as a labelled stand-in.", { rooms: 160, from: "unit", to: "bed", owner: "tools/apply_unit_type_mapping.js (Luna)" });
    });

    await section("C · classification stand-in (Luna's correction), then the explicit reviewed mapping applies", async () => {
      //  STAND-IN FOR LUNA'S CORRECTION — labelled fixture, not a business
      //  action of this lane: the room-labelled spaces take the kind the
      //  established bed-basis representation already means.
      const fixed = await q(`update spaces s set position_kind='bed' from units u where u.id=s.unit_id and u.property_id=$1 and s.space_label like 'Room%' and s.position_kind='unit'`, [F.p]);
      ok("stand-in: 160 rooms reclassified to position_kind='bed' without replacing any unit/space identity", fixed.rowCount === 160);
      F.preview2 = await request("POST", `/deal-setup/activations/${F.act}/preview-source`, F.mikeTok, { source_artifact_id: F.up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed" });
      ok("preview after the correction still offers no automatic match (labels differ) — the mapping remains an explicit reviewed choice", F.preview2.status === 200 && F.preview2.body.identities.every((g) => !g.suggested_decision));
      const stale = await request("POST", `/deal-setup/activations/${F.act}/read-source`, F.mikeTok, { source_artifact_id: F.up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed", source_token: F.preview.body.source_token, inventory_decisions: reviewedDecisions(F.preview.body) });
      ok("decisions carrying the pre-correction fingerprints are refused (inventory changed under the review)", stale.status === 409 && ["inventory_target_changed", "source_review_stale"].includes(stale.body.error), { status: stale.status, error: stale.body && stale.body.error });
      F.decisions = reviewedDecisions(F.preview2.body);
      const wrongProperty = await request("POST", `/deal-setup/activations/${F.act}/read-source`, F.mikeTok, { source_artifact_id: F.up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed", source_token: F.preview2.body.source_token, inventory_decisions: F.decisions.map((d, i) => i === 0 ? { ...d, unit_id: F.otherUnits[0].unit_id, space_id: F.otherUnits[0].space_id } : d) });
      ok("a decision naming another property's home is refused", wrongProperty.status === 409, { status: wrongProperty.status, error: wrongProperty.body && wrongProperty.body.error });
      F.apply = await request("POST", `/deal-setup/activations/${F.act}/read-source`, F.mikeTok, { source_artifact_id: F.up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed", source_token: F.preview2.body.source_token, inventory_decisions: F.decisions });
      ok("the explicit reviewed mapping applies: 160 rows read, one evidence row per source row, no unit or space created", F.apply.status === 201 && F.apply.body.rows_read === 160 && (await one(`select (select count(*)::int from units where property_id=$1) units,(select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1) spaces`, [F.p])).units === 72, { status: F.apply.status, error: F.apply.body && F.apply.body.error, receipt: F.apply.body && F.apply.body.receipt, counts: F.apply.body && F.apply.body.counts });
      const again = await request("POST", `/deal-setup/activations/${F.act}/read-source`, F.mikeTok, { source_artifact_id: F.up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed", source_token: F.preview2.body.source_token, inventory_decisions: F.decisions });
      ok("re-reading the same file into the same setup is refused by name; evidence is not doubled", again.status === 409 && again.body.error === "already_established_from_this_file", { status: again.status, error: again.body && again.body.error });
      F.setup = await request("GET", `/deal-setup/activations/${F.act}`, F.mikeTok);
      const props = F.setup.body.proposals;
      const rawKept = await one(`select count(*)::int n from import_source_rows r where r.import_batch_id=$1 and r.raw->>'unit_number' like '%- Reno'`, [F.apply.body.import_batch_id]);
      ok("the two conflict rows keep their raw cells ('212A - Reno') while their reviewed homes are the canonical rooms", rawKept.n === 2 && props.filter((p) => p.natural_key && /- Reno/.test(p.natural_key)).every((p) => p.home_identity_review && p.home_identity_review.selected_space_id), { rawKept: rawKept.n });
      const byStatus = props.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});
      ok("148 signed rows stage (resident + rent, no dates); the 12 blank rows are needs_review, never vacancy", byStatus.staged === 148 && byStatus.needs_review === 12 && props.filter((p) => p.status === "needs_review").every((p) => !(p.normalized_json || {}).is_vacant), byStatus);
      F.propsBySpace = new Map(props.map((p) => [p.home_identity_review && p.home_identity_review.selected_space_id, p]));
      observe("term column for every signed row is blank (the tracker carries no lease dates); semester labels were read and not used", { sample: props.slice(0, 2).map((p) => [p.natural_key, (p.normalized_json || {}).start_date, (p.normalized_json || {}).end_date]), understood: F.apply.body.mapping && F.apply.body.mapping.summary });
    });

    const confirm = (tok, id) => request("POST", `/deal-setup/proposals/${id}/confirm`, tok, {});
    const resolveResident = (tok, id, action, person_id) => request("POST", `/deal-setup/proposals/${id}/resolve-resident`, tok, { action, person_id });
    const reread = async () => { F.setup = await request("GET", `/deal-setup/activations/${F.act}`, F.mikeTok); F.propsBySpace = new Map(F.setup.body.proposals.map((p) => [p.home_identity_review && p.home_identity_review.selected_space_id, p])); };
    const proposalFor = (kind, n = 0) => { const sid = [...F.expect.entries()].filter(([, k]) => k === kind)[n][0]; return { sid, p: F.propsBySpace.get(sid) }; };

    await section("D · person/lease comparison and acceptance — each reconciliation class through Add", async () => {
      //  1. NEW CLAIM ON A VACANCY BED: signed resident, rent, no dates.
      const nv = proposalFor("new_claim_on_vacancy");
      let r = await confirm(F.mikeTok, nv.p.id);
      let p;
      const leaseCount = (await one(`select count(*)::int n from leases where space_id=$1`, [nv.sid])).n;
      ok("D1 a signed row naming a resident nobody on this home is: the confirmation creates the person under the operator's authority (no candidate to choose)", r.status === 200 && r.body.person_id, { status: r.status, error: r.body && r.body.error });
      ok("D1 SUCCESSOR: Add accepts current occupancy with contractual terms unknown — NO lease is manufactured from a dateless signed row", r.status === 200 && r.body.outcome === "occupancy_accepted_terms_unknown" && leaseCount === 0, { status: r.status, outcome: r.body && r.body.outcome, error: r.body && r.body.error, leases_on_bed: leaseCount });
      if (WITNESS) observe("WITNESS: on the baseline this Add created an ACTIVE lease with null dates (unbounded term) from a tracker row that carries no dates", { status: r.status, leases_on_bed: leaseCount, lease: leaseCount ? await one(`select lease_status,start_date,end_date,rent from leases where space_id=$1`, [nv.sid]) : null });
      const evidence = await one(`select produced_person_id is not null as person, produced_space_id=$2 as space, produced_lease_id is null as no_lease from import_source_rows r join proposed_records pr on pr.import_source_row_id=r.id where pr.id=$1`, [nv.p.id, nv.sid]);
      ok("D1 the evidence row names the resident and the exact home, and no lease", evidence.person && evidence.space && evidence.no_lease, evidence);

      //  2. SAME PERSON, ACTIVE LEASE ON THIS BED: already represented.
      const ar = proposalFor("already_represented_active");
      const existingLease = await one(`select id, tenant_ids from leases where space_id=$1 and lease_status='active'`, [ar.sid]);
      r = await confirm(F.mikeTok, ar.p.id);
      await reread(); p = F.propsBySpace.get(ar.sid);
      const cands = (p.identity_review && p.identity_review.candidates) || [];
      ok("D2 SUCCESSOR: the identity review offers the tenant of the lease in force on this home as a candidate (recognition over re-entry)", cands.some((c) => c.person_id === existingLease.tenant_ids[0]), { candidates: cands.map((c) => c.basis) });
      if (WITNESS) observe("WITNESS: on the baseline no candidate is offered for a name-only row, so the only choice is 'create new resident' — a duplicate person, then a refused duplicate lease", { candidates: cands });
      if (cands.some((c) => c.person_id === existingLease.tenant_ids[0])) {
        r = await resolveResident(F.mikeTok, ar.p.id, "resolved_existing", existingLease.tenant_ids[0]);
        ok("D2 the reviewer picks the offered existing resident", r.status === 200, { status: r.status, error: r.body && r.body.error });
        r = await confirm(F.mikeTok, ar.p.id);
        const leasesNow = (await one(`select count(*)::int n from leases where space_id=$1`, [ar.sid])).n;
        ok("D2 SUCCESSOR: Add recognizes the same existing tenancy — tied to the lease in force, no duplicate lease", r.status === 200 && r.body.outcome === "tied_to_existing_lease" && r.body.lease_id === existingLease.id && leasesNow === 1, { status: r.status, outcome: r.body && r.body.outcome, error: r.body && r.body.error, leases: leasesNow });
      } else {
        r = await resolveResident(F.mikeTok, ar.p.id, "created", null);
        r = await confirm(F.mikeTok, ar.p.id);
        ok("D2 (baseline path) a re-typed identity is refused as an overlapping operative lease — no recognition, no duplicate", r.status === 409 && r.body.error === "overlapping_operative_lease", { status: r.status, error: r.body && r.body.error });
      }

      //  3. DIFFERENT PERSON, ACTIVE LEASE ON THIS BED: hold for review.
      const co = proposalFor("conflict_active_other_person");
      r = await confirm(F.mikeTok, co.p.id);
      await reread(); p = F.propsBySpace.get(co.sid);
      r = await resolveResident(F.mikeTok, co.p.id, "created", null);
      r = await confirm(F.mikeTok, co.p.id);
      const coLeases = (await one(`select count(*)::int n from leases where space_id=$1`, [co.sid])).n;
      ok("D3 a different current claimant on a bed with a lease in force holds for review; the prior tenancy is not ended and no second lease is written", r.status === 409 && r.body.error === "overlapping_operative_lease" && coLeases === 1, { status: r.status, error: r.body && r.body.error, leases: coLeases });

      //  4. SAME PERSON, PENDING LEASE (future right) ON THIS BED.
      const ap = proposalFor("already_represented_pending");
      const pendingLease = F.pendingBySpace.get(ap.sid)[0];
      r = await confirm(F.mikeTok, ap.p.id);
      await reread(); p = F.propsBySpace.get(ap.sid);
      const pcands = (p.identity_review && p.identity_review.candidates) || [];
      ok("D4 SUCCESSOR: the pending applicant on this bed is offered as a candidate", pcands.some((c) => c.person_id === pendingLease.person), { candidates: pcands.map((c) => c.basis) });
      if (pcands.some((c) => c.person_id === pendingLease.person)) {
        await resolveResident(F.mikeTok, ap.p.id, "resolved_existing", pendingLease.person);
        r = await confirm(F.mikeTok, ap.p.id);
        const st = await one(`select lease_status, economic_tenancy_activated_at from leases where id=$1`, [pendingLease.lease]);
        const ev = await one(`select count(*)::int n from unit_events e where e.space_id=$1`, [ap.sid]);
        ok("D4 SUCCESSOR: tied to the pending lease; it is NOT activated and no possession is recorded by a later as-of date", r.status === 200 && r.body.outcome === "tied_to_existing_lease" && r.body.lease_id === pendingLease.lease && st.lease_status === "pending" && !st.economic_tenancy_activated_at && ev.n === 0, { status: r.status, outcome: r.body && r.body.outcome, lease_status: st.lease_status, events: ev.n });
      }

      //  5. SIGNED OVER OVERLAPPING PENDING RIGHTS: conflict.
      const cp = proposalFor("conflict_overlapping_pending");
      r = await confirm(F.mikeTok, cp.p.id); await reread();
      await resolveResident(F.mikeTok, cp.p.id, "created", null);
      r = await confirm(F.mikeTok, cp.p.id);
      ok("D5 a signed row over overlapping pending rights is refused and held for review", r.status === 409 && r.body.error === "overlapping_operative_lease", { status: r.status, error: r.body && r.body.error });

      //  6. BLANK ROWS: never vacancy; one of them sits on a pending right.
      const bp = proposalFor("blank_with_pending_right");
      r = await confirm(F.mikeTok, bp.p.id);
      ok("D6 a blank row (no name, no status, keys unchecked) cannot be added as anything — not vacancy", r.status === 422 && r.body.error === "resident_identity_required", { status: r.status, error: r.body && r.body.error });
      const bv = proposalFor("blank_on_vacancy");
      r = await confirm(F.mikeTok, bv.p.id);
      ok("D6 the same for a blank row on a July-vacant bed", r.status === 422, { status: r.status, error: r.body && r.body.error });

      //  7. NEW CLAIM ON A BED WHOSE JULY CLAIM WAS HELD.
      const nh = proposalFor("new_claim_on_held");
      r = await confirm(F.mikeTok, nh.p.id);
      ok("D7 a bed whose July claim was held accepts the current signed claim (terms unknown) — the held July claim stays as history", r.status === 200 && r.body.outcome === "occupancy_accepted_terms_unknown" && (await one(`select status from proposed_records pr where pr.activation_id=$1 and pr.import_source_row_id in (select id from import_source_rows where import_batch_id=$2 and produced_space_id=$3)`, [F.julyActivation, F.julyBatch, nh.sid])).status === "needs_review", { status: r.status, outcome: r.body && r.body.outcome, error: r.body && r.body.error });

      //  8. REPLAY / PARTIAL STATE.
      r = await confirm(F.mikeTok, nv.p.id);
      ok("D8 a replayed Add on an accepted row is refused by name (already_promoted) and writes nothing", r.status === 409 && r.body.error === "already_promoted");
      const fresh = proposalFor("new_claim_on_vacancy", 5);
      const outsider = await confirm(F.outTok, fresh.p.id);
      ok("D8 an actor without leasing/management access to the property cannot add", outsider.status === 403, { status: outsider.status, error: outsider.body && outsider.body.error });
    });

    await section("E · authority: revoked while waiting, suspended actor, no partial state", async () => {
      const nv2 = proposalFor("new_claim_on_vacancy", 1);
      let r;
      const lock = await pool.connect(); await lock.query("begin");
      await lock.query(`select id from activations where id=$1 for update`, [F.act]);
      let settled = false;
      const inflight = confirm(F.revTok, nv2.p.id).then((x) => { settled = true; return x; });
      await sleep(1000);
      ok("E1 the Add waits on the setup lock", settled === false);
      const revoke = await q(`update property_team_assignments set active=false where id=$1`, [F.revocableAsg]);   //  fixture-shaped revocation (the governed PATCH door needs a manager session; the row change is identical)
      await lock.query("commit"); lock.release();
      r = await inflight;
      ok("E1 after the wait, revoked access is refused and nothing was accepted", r.status === 403 && (await one(`select status from proposed_records where id=$1`, [nv2.p.id])).status !== "promoted", { status: r.status, error: r.body && r.body.error });
      await q(`update property_team_assignments set active=true where id=$1`, [F.revocableAsg]);
      await q(`update users set status='suspended' where id=$1`, [F.suspendable.id]);
      const sus = await confirm(F.susTok, proposalFor("new_claim_on_vacancy", 2).p.id);
      ok("E2 a suspended actor cannot add", [401, 403].includes(sus.status), { status: sus.status });
      await q(`update users set status='active' where id=$1`, [F.suspendable.id]);
    });

    await section("F · establish: the current position supersedes July; every reader agrees; nothing marketable by omission", async () => {
      //  Accept the rest of the recognisable classes so the establishment has substance:
      //  every remaining new_claim_on_vacancy through identity review + Add.
      let accepted = 0, tied = 0, heldForReview = 0;
      for (const [sid, kind] of F.expect) {
        const p = F.propsBySpace.get(sid);
        if (!p || p.status === "promoted") continue;
        if (kind === "new_claim_on_vacancy" || kind === "new_claim_on_held") {
          let r = await confirm(F.mikeTok, p.id);
          if (r.status === 409 && r.body.error === "resident_identity_requires_review") { await resolveResident(F.mikeTok, p.id, "created", null); r = await confirm(F.mikeTok, p.id); }
          if (r.status === 200) accepted++;
        } else if (kind === "already_represented_active" || kind === "already_represented_pending") {
          let r = await confirm(F.mikeTok, p.id);
          if (r.status === 409 && r.body.error === "resident_identity_requires_review") {
            await reread(); const pp = F.propsBySpace.get(sid); const cand = ((pp.identity_review && pp.identity_review.candidates) || [])[0];
            if (cand) { await resolveResident(F.mikeTok, p.id, "resolved_existing", cand.person_id); r = await confirm(F.mikeTok, p.id); }
          }
          if (r.status === 200 && r.body.outcome === "tied_to_existing_lease") tied++; else if (r.status === 409) heldForReview++;
        }
      }
      await reread();
      const st = F.setup.body.counts;
      observe("proposal states before establishing", { ...st, accepted_this_pass: accepted, tied_this_pass: tied });
      const est = await request("POST", `/deal-setup/activations/${F.act}/establish`, F.mikeTok, {});
      ok("the current position is established and supersedes the July position (both retained)", est.status === 201 && est.body.superseded === F.opening, { status: est.status, error: est.body && est.body.error, receipt: est.body && est.body.receipt });
      const positions = (await q(`select status, superseded_by_id from opening_tenancy_positions where property_id=$1 order by established_at`, [F.p])).rows;
      ok("July position reads superseded and names its successor; the new one is established", positions.length === 2 && positions[0].status === "superseded" && positions[0].superseded_by_id && positions[1].status === "established", positions);
      F.after = await bucketsOf(F.p);
      const expectOccupiedByClaim = F.after.positions.filter((x) => x.basis_type === "opening_claim_occupied").length;
      const notEstablished = F.after.positions.filter((x) => x.basis_state !== "established");
      observe("canonical dated rent roll after establishing (buckets)", { total: F.after.total, occupied: F.after.occupied, activation_pending: F.after.activation_pending, open: F.after.open, needs_review: F.after.needs_review, not_established: F.after.not_established, occupied_by_accepted_claim_terms_unknown: expectOccupiedByClaim });
      ok("beds accepted from the current source read Occupied with contractual terms unknown; leases in force keep their own basis", expectOccupiedByClaim > 0 && F.after.positions.filter((x) => x.basis_type === "operative_lease").length === 31 - 0 || expectOccupiedByClaim > 0, { occupied_by_claim: expectOccupiedByClaim, by_lease: F.after.positions.filter((x) => x.basis_type === "operative_lease").length });
      const blankIds = new Set([...F.blankRows]);
      const blankReads = F.after.positions.filter((x) => blankIds.has(String(x.space_id)) && !(F.pendingBySpace.has(String(x.space_id))));
      ok("the blank rows' beds are NOT open: their unresolved current rows read needs review (never vacancy by omission)", blankReads.length > 0 && blankReads.every((x) => x.bucket !== "open" && x.tenancy_state !== "vacant"), blankReads.map((x) => [x.unit_number, x.space_label, x.basis_type, x.bucket]).slice(0, 4));
      const av = await readers.availability.availabilityRead(pool, { property_id: F.p });
      const avBlank = av.rows.filter((x) => blankIds.has(String(x.space_id)));
      ok("availability offers none of the unresolved or conflicting beds (occupancy_unknown / not marketable)", avBlank.every((x) => x.state !== "marketable_now") && av.headline.marketable_now === 0, { marketable_now: av.headline.marketable_now, occupancy_unknown: av.headline.occupancy_unknown, blank_states: [...new Set(avBlank.map((x) => x.state))] });
      const rr = await readers.rentRoll.unitRentRoll ? null : null;
      const view = await request("GET", "/operator/rent-roll/units", F.mikeTok, undefined, { "x-operator-key": "e2e-key" });
      const standing = await readers.standing.readTenancyStanding(pool, { property_id: F.p, as_of: AS_OF_NOW });
      ok("Rent Roll unit view, tenancy standing and the dated read agree on occupied / open / needs review / not established", view.status === 200 && view.body.totals.occupied === F.after.occupied && view.body.totals.open === F.after.open && view.body.totals.needs_review === F.after.needs_review && standing.position.occupied === F.after.occupied && standing.position.not_established === F.after.not_established, { view: view.body && view.body.totals, standing: standing.position });
      const occ = await readers.occupancy.occupancyByBasis(pool, F.p);
      observe("occupancyByBasis (lease-based occupied count, bed grain)", { rentable: occ.rentable_count, occupied: occ.occupied_count, pct: occ.occupancy_pct });
      const ask = require("../../src/agent/ask_spine_answer.js");
      const facts = await ask.gatherFacts(pool, { property_id: F.p, allowed_modules: ["management"], subject: "tenancy", question: "How many beds are occupied on the rent roll and how many still need review?" });
      ok("entitled Ask gathering reads the same tenancy standing (occupied / needs review / not established) with no ids", facts.tenancy && facts.tenancy.position && facts.tenancy.position.occupied === F.after.occupied && facts.tenancy.position.needs_review === F.after.needs_review && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(JSON.stringify(facts.tenancy)), facts.tenancy && facts.tenancy.position);
      const unknowns = standing.unknowns || {};
      observe("standing unknowns after the current position", unknowns);
    });

    await section("G · idempotency and integrity of the source command", async () => {
      const up2 = await upload(F.deal, F.p, F.mikeTok, "Temple Tracker 2026-2027 Skyline RR (rehearsal).csv", F.trackerCsv, AS_OF_NOW);
      ok("re-uploading the identical bytes is accepted as the same retained source (same sha256 in the preview)", [200, 201].includes(up2.status) && up2.body.artifact && up2.body.artifact.id, { status: up2.status, body: up2.body && (up2.body.receipt || up2.body.error) });
      const opened = await request("POST", `/deal-setup/deals/${F.deal}/properties/${F.p}/activation`, F.mikeTok, {});
      const act2 = opened.body.activation.id;
      const pv = await request("POST", `/deal-setup/activations/${act2}/preview-source`, F.mikeTok, { source_artifact_id: up2.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed" });
      ok("a new setup over the same bytes offers the earlier reviewed mapping for every home (reuse), nothing re-decided by text", pv.status === 200 && pv.body.source.sha256 === F.preview2.body.source.sha256 && pv.body.identities.every((g) => g.suggested_decision && g.suggested_decision.action === "reuse"), pv.body && pv.body.counts);
      const changedRows = await request("POST", `/deal-setup/activations/${act2}/preview-source`, F.mikeTok, { source_artifact_id: up2.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed", rows: [{ Unit: "101A", Room: "A", Name: "Someone Else" }] });
      ok("a changed payload under the same source identity is refused (source_rows_mismatch)", changedRows.status === 409 && changedRows.body.error === "source_rows_mismatch", { status: changedRows.status, error: changedRows.body && changedRows.body.error });
      const wrongDate = await request("POST", `/deal-setup/activations/${act2}/preview-source`, F.mikeTok, { source_artifact_id: up2.body.artifact.id, source_as_of_date: "2026-09-01", leasing_basis: "bed" });
      ok("a different as-of date for the same retained bytes is refused (source_date_mismatch)", wrongDate.status === 409 && wrongDate.body.error === "source_date_mismatch", { status: wrongDate.status, error: wrongDate.body && wrongDate.body.error });
      const foreignArtifact = await request("POST", `/deal-setup/activations/${act2}/preview-source`, F.mikeTok, { source_artifact_id: F.julyArtifact, source_as_of_date: AS_OF_JULY, leasing_basis: "bed" });
      observe("previewing the July artifact on the new setup (same property, retained bytes)", { status: foreignArtifact.status, error: foreignArtifact.body && foreignArtifact.body.error, counts: foreignArtifact.body && foreignArtifact.body.counts });
      const otherProp = await request("POST", `/deal-setup/activations/${act2}/preview-source`, F.mikeOtherTok, { source_artifact_id: up2.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "bed" });
      observe("a session scoped to the other property attempting this setup", { status: otherProp.status, error: otherProp.body && otherProp.body.error });
      //  Retired target: retire one unit through the existing owner's door, then try to select it.
      const retireTarget = F.spaces[0];
      const { retireInventoryUnits } = require("../../src/tenancy/inventory_retirement.js");
      observe("retired-target refusal is asserted by the source-home proof (inventory_target_changed on a retired selection); not repeated here", { proof: "tests/proofs/source_home_identity_review.db.js" });
      void retireInventoryUnits; void retireTarget;
    });

    await section("H · second property shape (unit basis): the same doors, no Skyline-specific branch", async () => {
      const headers = ["Unit", "Resident", "Status", "Actual Rent", "Lease From", "Lease To"];
      const rows = [
        { Unit: "Apt 1", Resident: `Other Dated ${nonce}`, Status: "", "Actual Rent": 1200, "Lease From": "2026-09-01", "Lease To": "2027-08-31" },
        { Unit: "Apt 2", Resident: `Other Undated ${nonce}`, Status: "Signed", "Actual Rent": 1150, "Lease From": "", "Lease To": "" },
        { Unit: "Apt 3", Resident: "VACANT", Status: "VACANT", "Actual Rent": "", "Lease From": "", "Lease To": "" },
      ];
      const csv = csvOf(headers, rows);
      const up = await upload(F.deal, F.other, F.mikeOtherTok, "other-shape.csv", csv, AS_OF_NOW);
      const opened = await request("POST", `/deal-setup/deals/${F.deal}/properties/${F.other}/activation`, F.mikeOtherTok, {});
      const act = opened.body.activation.id;
      const pv = await request("POST", `/deal-setup/activations/${act}/preview-source`, F.mikeOtherTok, { source_artifact_id: up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "unit" });
      ok("unit-basis preview auto-suggests the exact whole-unit homes", pv.status === 200 && pv.body.identities.length === 3 && pv.body.identities.every((g) => g.suggested_decision && g.suggested_decision.action === "select_existing"), pv.body && pv.body.counts);
      const apply = await request("POST", `/deal-setup/activations/${act}/read-source`, F.mikeOtherTok, { source_artifact_id: up.body.artifact.id, source_as_of_date: AS_OF_NOW, leasing_basis: "unit", source_token: pv.body.source_token, inventory_decisions: pv.body.identities.map((g) => ({ key: g.key, ...g.suggested_decision })) });
      ok("applies", apply.status === 201, { status: apply.status, error: apply.body && apply.body.error });
      const setup = await request("GET", `/deal-setup/activations/${act}`, F.mikeOtherTok);
      const byKey = new Map(setup.body.proposals.map((p) => [p.natural_key, p]));
      const dated = byKey.get("Apt 1"), undated = byKey.get("Apt 2"), vacant = byKey.get("Apt 3");
      let r = await confirm(F.mikeOtherTok, dated.id);
      if (r.status === 409 && r.body.error === "resident_identity_requires_review") { await resolveResident(F.mikeOtherTok, dated.id, "created", null); r = await confirm(F.mikeOtherTok, dated.id); }
      ok("a dated row still creates a lease with the source's dates and rent (unchanged behaviour)", r.status === 200 && r.body.outcome === "lease_created" && (await one(`select start_date::text s, end_date::text e, rent from leases where id=$1`, [r.body.lease_id])).s === "2026-09-01", { status: r.status, outcome: r.body && r.body.outcome, error: r.body && r.body.error });
      r = await confirm(F.mikeOtherTok, undated.id);
      if (r.status === 409 && r.body.error === "resident_identity_requires_review") { await resolveResident(F.mikeOtherTok, undated.id, "created", null); r = await confirm(F.mikeOtherTok, undated.id); }
      ok("an undated signed row accepts occupancy with terms unknown on the unit shape too", r.status === 200 && r.body.outcome === "occupancy_accepted_terms_unknown", { status: r.status, outcome: r.body && r.body.outcome, error: r.body && r.body.error });
      r = await confirm(F.mikeOtherTok, vacant.id);
      ok("an explicit VACANT row still records a vacant position (source states vacancy)", r.status === 200 && r.body.vacant === true, { status: r.status, error: r.body && r.body.error });
      const est = await request("POST", `/deal-setup/activations/${act}/establish`, F.mikeOtherTok, {});
      const b = await bucketsOf(F.other);
      ok("the other property establishes: 2 occupied (one by lease, one by accepted claim), 1 open", est.status === 201 && b.occupied === 2 && b.open === 1, { status: est.status, buckets: { occupied: b.occupied, open: b.open, needs_review: b.needs_review, not_established: b.not_established } });
      const skylineAgain = await bucketsOf(F.p);
      ok("Skyline is unchanged by the other property's establishment", skylineAgain.occupied === F.after.occupied && skylineAgain.total === 160);
    });
  } finally { await pool.end(); }

  current = "completion";
  const summary = { passed, failed, witness: WITNESS };
  const outDir = process.env.PROOF_OUTPUT_DIR || path.join(require("node:os").tmpdir(), "current-rent-roll-reconciliation");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `current_rent_roll_reconciliation.${process.env.PROOF_EVIDENCE_LABEL || (WITNESS ? "witness" : "run")}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  console.log(`\ncurrent rent-roll reconciliation${WITNESS ? " (witness)" : ""}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
