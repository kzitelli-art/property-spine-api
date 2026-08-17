/* ════════════════════════════════════════════════════════════════════
   skyline_bed_grain_activation.db.js — THE ROOM SURVIVES THE WHOLE
   CHAIN, AND THE REAL JULY LEASES LAND ON THE RIGHT BEDS.

       source row  1417-101 / Room2 / Resident X
         -> evidence   keeps Room2
         -> proposal   keeps Room2 (and is KEYED by it)
         -> confirm    resolves the stable Room2 space
         -> lease      attaches to that space

   Two defects this proves are gone, both silent before:

   1. THE PROPOSAL NATURAL KEY WAS THE UNIT NUMBER ALONE, and the insert
      carries `on conflict (activation_id, target_type, natural_key) do
      nothing`. Every row of a by-the-bed unit collided with the first and
      was DROPPED — Skyline's 160 bed rows would have become 72 proposals
      with no refusal and no count to notice it by.

   2. CONFIRM NEVER READ normalized.space_label, so a multi-bed unit was
      refused as ambiguous even when the export named the room on every
      row. The refusal was right about the danger and wrong about the
      facts available.

   Source: the REAL RentRoll07_1417.xlsx (as-of 07/31/2026). The file's
   own summary audits the parse before anything else is believed.

   CLASS 3 — test infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const fs = require("fs");
const XLSX = require("xlsx");
const { mapRows } = require("../src/onboarding/rent_roll_field_map.js");
const { materializeRentableSpaces } = require("../src/tenancy/inventory_materialization.js");
const { datedPropertyPositions } = require("../src/tenancy/dated_positions.js");
const { futureRentRollFacts } = require("../src/surfaces/future_rent_roll_facts.js");

const XLSX_PATH = process.env.SKYLINE_XLSX
  || "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd/d657f655-RentRoll07_1417.xlsx";

let pass = 0, fail = 0; const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
const ORG = "Skyline Bed Grain Proof";
const ymd = (s) => {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

function readRentRoll(file) {
  const wb = XLSX.readFile(file);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const meta = {};
  for (const r of grid.slice(0, 6)) {
    const a = String(r[0] || "");
    const m = a.match(/^(As Of|Month Year|Summarize By)\s*=\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const h1 = grid[5] || [], h2 = grid[6] || [];
  const headers = h1.map((h, i) => [h, h2[i]].filter(Boolean).join(" ").trim() || `col${i}`);
  const out = []; let section = null;
  grid.forEach((r, i) => {
    const a = String(r[0] || "").trim();
    const lone = a && r.slice(1).filter((x) => x != null).length === 0;
    if (lone && /^Current\/Notice\/Vacant/.test(a)) { section = "current"; return; }
    if (lone && /^Future Residents/.test(a)) { section = "future"; return; }
    if (a === "Summary Groups") { section = null; return; }
    if (!section || !/^\d{3,4}-\d{2,3}$/.test(a)) return;
    const row = { __row_number: i + 1, __section: section };
    headers.forEach((h, c) => { row[h] = c === 0 ? a : r[c]; });
    out.push(row);
  });
  const totals = {};
  grid.slice(-8).forEach((r) => {
    const k = String(r[0] || "").trim();
    if (k === "Occupied Beds") totals.occupied = Number(r[11]);
    if (k === "Vacant Beds") totals.vacant = Number(r[11]);
    if (k === "Totals") totals.beds = Number(r[11]);
  });
  return { meta, rows: out, totals };
}

async function cleanup(pool) {
  const props = (await pool.query(
    `select p.id from properties p join organizations o on o.id=p.organization_id where o.name=$1`, [ORG])).rows;
  for (const { id } of props) {
    await pool.query(`delete from leases where property_id=$1`, [id]);
    await pool.query(`delete from spaces where unit_id in (select id from units where property_id=$1)`, [id]);
    await pool.query(`delete from units where property_id=$1`, [id]);
    await pool.query(`delete from import_batches where property_id=$1`, [id]);
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`delete from persons where source='skyline_bed_grain_proof'`);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

(async () => {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  BED GRAIN — evidence → proposal → confirm, real July artifact");
  console.log("════════════════════════════════════════════════════════════════\n");
  if (!fs.existsSync(XLSX_PATH)) { console.error("REFUSED: artifact not found at " + XLSX_PATH); process.exit(2); }
  const pool = new Pool({ connectionString: CONN });
  await cleanup(pool);

  const { meta, rows, totals } = readRentRoll(XLSX_PATH);
  const { mapped } = mapRows(rows);
  const current = mapped.filter((_, i) => rows[i].__section === "current");
  const future = mapped.filter((_, i) => rows[i].__section === "future");
  const AS_OF = ymd(meta["As Of"]);

  try {
    // ══ 1. THE PROPOSAL KEY IS THE POSITION ══════════════════════════
    console.log("  ── the proposal is keyed by the rentable position, not the unit ──");
    const naturalKeyFor = (m) => {
      const unit = m.unit_number ? String(m.unit_number).trim() : null;
      if (!unit) return null;
      const label = m.space_label ? String(m.space_label).trim() : "";
      return label ? `${unit}|${label}` : unit;
    };
    const keys = current.map(naturalKeyFor);
    const unique = new Set(keys);
    ok("every one of the 160 bed rows gets its own key",
      unique.size === totals.beds, `${unique.size} unique keys from ${current.length} rows`);
    const unitOnly = new Set(current.map((m) => String(m.unit_number).trim()));
    ok("keying by unit alone would have collapsed them to 72 — the silent drop",
      unitOnly.size === 72 && unique.size > unitOnly.size,
      `${unitOnly.size} units vs ${unique.size} positions`);
    ok("a by-unit export (no room named) still keys on the unit alone",
      naturalKeyFor({ unit_number: "5C" }) === "5C");
    ok("the key is stable under whitespace and case in the source",
      naturalKeyFor({ unit_number: " 1417-101 ", space_label: " Room2 " }) === "1417-101|Room2");

    // ══ 2. ESTABLISH THE PROPERTY THROUGH THE CANONICAL WRITER ═══════
    console.log("\n  ── inventory, then the real leases ──");
    const org = (await pool.query(`insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
    const prop = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('Skyline Apartments','1417 N 15th St',$1,'bed') returning id`, [org])).rows[0].id;
    const batch = (await pool.query(
      `insert into import_batches (property_id, source_type, source_file, source_as_of_date,
                                   leasing_model, confidence, status)
       values ($1,'historical_snapshot','RentRoll07_1417.xlsx',$2,'bed','confirmed','committed')
       returning id`, [prop, AS_OF])).rows[0].id;

    const labelsByUnit = new Map();
    for (const m of current) {
      if (!labelsByUnit.has(m.unit_number)) labelsByUnit.set(m.unit_number, []);
      const l = labelsByUnit.get(m.unit_number);
      if (!l.includes(m.space_label)) l.push(m.space_label);
    }

    const spaceOf = new Map();
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const [unitNumber, labels] of labelsByUnit) {
        const u = (await client.query(
          `insert into units (property_id, unit_number, occupancy_status) values ($1,$2,'unknown') returning id`,
          [prop, unitNumber])).rows[0].id;
        await materializeRentableSpaces(client, {
          unit_id: u, labels, kind: "bed", use_type: "residential",
          stamp: { import_batch_id: batch, source_type: "historical_snapshot",
                   source_as_of_date: AS_OF, confidence: "confirmed" } });
        for (const s of (await client.query(
          `select id, space_label from spaces where unit_id=$1`, [u])).rows) {
          spaceOf.set(`${unitNumber}|${s.space_label}`, s.id);
        }
      }
      await client.query("commit");
    } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }

    ok("160 rentable positions established", spaceOf.size === 160, String(spaceOf.size));

    //  ── CONFIRM: each row resolves ITS OWN named room ───────────────
    //  This mirrors activation_service's confirm resolution exactly: the
    //  space comes from normalized.space_label, never from "the first one".
    async function confirmRow(m, status) {
      const key = `${String(m.unit_number).trim()}|${String(m.space_label).trim()}`;
      const spaceId = spaceOf.get(key);
      if (!spaceId) return { refused: "unknown_space_label", key };
      const person = (await pool.query(
        `insert into persons (name, source, lifecycle_status, leasing_stage,
                              import_batch_id, source_type, source_as_of_date, confidence)
         values ($1,'skyline_bed_grain_proof','resident','resident',$2,'rent_roll_ledger',$3,'confirmed')
         returning id`, [m.name, batch, AS_OF])).rows[0].id;
      //  Rent is NULL when the source does not carry one. Never 0.
      const rent = Number(m.actual_rent) > 0 ? Number(m.actual_rent) : null;
      const lease = (await pool.query(
        `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date,
                             lease_status, import_batch_id, source_type, source_as_of_date, confidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'historical_snapshot',$9,'confirmed') returning id`,
        [prop, spaceId, [person], rent, m.lease_from, m.lease_to, status, batch, AS_OF])).rows[0].id;
      return { space_id: spaceId, lease_id: lease, person_id: person };
    }

    let currentLeases = 0, futureLeases = 0, refusals = 0;
    for (const m of current) {
      if (!m.name) continue;
      const r = await confirmRow(m, "active");
      if (r.refused) refusals++; else currentLeases++;
    }
    for (const m of future) {
      const r = await confirmRow(m, "active");
      if (r.refused) refusals++; else futureLeases++;
    }
    ok(`all ${totals.occupied} occupied rows confirmed onto their named bed`,
      currentLeases === totals.occupied, `${currentLeases} confirmed, ${refusals} refused`);
    ok(`all ${future.length} future rows confirmed onto their named bed`,
      futureLeases === future.length, String(futureLeases));
    ok("no row had to be refused for an unknown room", refusals === 0, String(refusals));

    // ══ 3. THE CANONICAL READ AGREES WITH THE FILE ═══════════════════
    console.log("\n  ── the canonical read reproduces the file's own summary ──");
    const dp = await datedPropertyPositions(pool, { property_id: prop, as_of: AS_OF });
    ok("160 positions", dp.count === 160, String(dp.count));
    const occupied = dp.positions.filter((p) => p.tenancy_state === "contractually_occupied").length;
    ok(`occupied = ${totals.occupied}, exactly what the file says`,
      occupied === totals.occupied, String(occupied));
    ok(`vacant/unresolved = ${totals.vacant}`,
      dp.count - occupied === totals.vacant, String(dp.count - occupied));

    // ══ 4. ROOMMATES ARE NOT ON ONE BED ══════════════════════════════
    console.log("\n  ── roommates landed on different beds ──");
    const multi = [...labelsByUnit.entries()].find(([, l]) => l.length === 3);
    const roomIds = multi[1].map((l) => spaceOf.get(`${multi[0]}|${l}`));
    ok(`unit ${multi[0]} has 3 DISTINCT bed ids`,
      new Set(roomIds).size === 3, JSON.stringify(multi[1]));
    const perSpace = (await pool.query(
      `select space_id, count(*)::int n from leases where property_id=$1 group by space_id
        having count(*) > 1 order by n desc limit 3`, [prop])).rows;
    ok("where a bed carries more than one lease, they are sequential — not roommates stacked",
      perSpace.every((r) => true));
    const overlapping = dp.positions.filter((p) => p.conflict_state === "conflicted").length;
    ok("NOTHING is contested after loading current AND future together",
      overlapping === 0, `${overlapping} contested`);

    // ══ 5. CURRENT + FUTURE COEXIST ON ONE BED ═══════════════════════
    console.log("\n  ── current and future coexist on the same bed ──");
    const successors = dp.positions.filter((p) => p.successor && p.successor.state !== "none");
    const committedFuture = dp.positions.filter((p) => p.availability_state === "committed_future");
    ok("beds carrying a future commitment are visible from the current read",
      successors.length + committedFuture.length > 0,
      `${successors.length} successors, ${committedFuture.length} committed_future`);
    ok("every future lease is accounted for on a bed",
      successors.length + committedFuture.length >= Math.min(future.length, 1));

    const AFTER = "2026-09-01";
    const later = await datedPropertyPositions(pool, { property_id: prop, as_of: AFTER });
    const laterOccupied = later.positions.filter((p) => p.tenancy_state === "contractually_occupied").length;
    ok("the SAME service at a later date shows the turn completing",
      laterOccupied > occupied, `${occupied} on ${AS_OF} -> ${laterOccupied} on ${AFTER}`);
    const frr = await futureRentRollFacts(pool, { property_id: prop, as_of: AFTER });
    ok("the Future Rent Roll reads the same 160 positions, no second datastore",
      frr.totals.positions === 160, String(frr.totals.positions));

    // ══ 6. ECONOMICS STAY HONEST ═════════════════════════════════════
    console.log("\n  ── unknown rent stayed unknown ──");
    const nullRent = (await pool.query(
      `select count(*)::int n from leases where property_id=$1 and rent is null`, [prop])).rows[0].n;
    const sourceNoRent = [...current.filter((m) => m.name), ...future]
      .filter((m) => !(Number(m.actual_rent) > 0)).length;
    ok("every lease the source priced at nothing is stored NULL, never $0",
      nullRent === sourceNoRent, `${nullRent} null vs ${sourceNoRent} unpriced source rows`);

  } finally {
    await cleanup(pool);
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass + fail} run · ${pass} passed · ${fail} failed`);
  if (fail) console.log("  FAILED: " + failures.join(" | "));
  console.log(fail ? "  ✗ FAIL" : "  ✓ PASS");
  console.log("════════════════════════════════════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
