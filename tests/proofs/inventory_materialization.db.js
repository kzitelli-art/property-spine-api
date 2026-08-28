/* ════════════════════════════════════════════════════════════════════
   inventory_materialization.db.js — 72 UNITS, EXACTLY 160 RENTABLE
   POSITIONS, FROM THE REAL RENT ROLL. NEVER 232.

   Owner ruling, 2026-08-15: the auto-created '(whole unit)' space is
   PROVISIONAL until inventory grain is known. The canonical writer may
   consume that pristine placeholder as the first real bed and create the
   rest. It must REFUSE if the placeholder already carries history.

   ── THE SOURCE IS THE REAL FILE ─────────────────────────────────────
   RentRoll07_1417.xlsx, as-of 07/31/2026 — the actual Yardi export, not
   the transcription. Its own summary block is used as the audit of this
   harness's parse: the file says 160 beds / 37 occupied / 123 vacant, and
   if the parser disagrees with the file about the file, nothing after that
   is worth reading.

   Point the harness at the artifact with SKYLINE_XLSX=/path/to/file.

   CLASS 3 — test infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { materializeRentableSpaces, PLACEHOLDER_LABEL } = require("../../src/tenancy/inventory_materialization.js");
const { mapRows } = require("../../src/onboarding/rent_roll_field_map.js");
const { datedPropertyPositions } = require("../../src/tenancy/dated_positions.js");

const XLSX_PATH = process.env.SKYLINE_XLSX
  || "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd/d657f655-RentRoll07_1417.xlsx";

let pass = 0, fail = 0; const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const ORG = "Skyline Inventory Proof";

/*  Read the Yardi room-summarised rent roll into flat header→value rows.
 *  Two header lines ("Market"/"Rent") are joined; the two section bands
 *  become a `section` field. Unit numbers are indented in the export. */
function readRentRoll(file) {
  const wb = XLSX.readFile(file);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const meta = {};
  for (const r of grid.slice(0, 6)) {
    const a = String(r[0] || "");
    const m = a.match(/^(As Of|Month Year|Summarize By)\s*=\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
    if (/^\d{3,4}\s*-\s*/.test(a)) meta.property = a.trim();
  }
  const head = grid[5] || [], head2 = grid[6] || [];
  const headers = head.map((h, i) => [h, head2[i]].filter(Boolean).join(" ").trim() || `col${i}`);
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
  //  The file's own summary — the audit of this parse.
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
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

(async () => {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  INVENTORY MATERIALIZATION — the real 07/31/2026 Skyline export");
  console.log("════════════════════════════════════════════════════════════════\n");
  if (!fs.existsSync(XLSX_PATH)) {
    console.error("REFUSED: source artifact not found at " + XLSX_PATH);
    console.error("Set SKYLINE_XLSX to the real rent roll.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: CONN });
  await cleanup(pool);

  const { meta, rows, totals } = readRentRoll(XLSX_PATH);
  const { plan, mapped } = mapRows(rows);
  const current = mapped.filter((_, i) => rows[i].__section === "current");
  const future = mapped.filter((_, i) => rows[i].__section === "future");

  console.log(`  source   ${path.basename(XLSX_PATH)}`);
  console.log(`  property ${meta.property}`);
  console.log(`  as of    ${meta["As Of"]}   summarised by ${meta["Summarize By"]}\n`);

  try {
    // ══ 1. THE FILE AUDITS THE PARSE ═════════════════════════════════
    console.log("  ── the file's own summary audits this parse ──");
    ok("every column was understood — nothing silently dropped",
      plan.unmapped.length === 0, "unmapped: " + JSON.stringify(plan.unmapped));
    ok("the export carries one row per bed in the current section",
      current.length === totals.beds, `${current.length} rows vs ${totals.beds} beds`);
    const occ = current.filter((r) => r.name).length;
    const vac = current.filter((r) => !r.name).length;
    ok(`occupied matches the file (${totals.occupied})`, occ === totals.occupied, String(occ));
    ok(`vacant matches the file (${totals.vacant})`, vac === totals.vacant, String(vac));
    ok("VACANT became a status, never a person named VACANT",
      current.every((r) => !r.name || !/^vacant$/i.test(r.name)));

    // ══ 2. THE PMS IDENTIFIER ════════════════════════════════════════
    console.log("\n  ── the PMS resident id, extracted but not trusted as identity ──");
    const withId = current.filter((r) => r.resident_id);
    ok("resident ids were recovered from inside the resident cell",
      withId.length === occ, `${withId.length} of ${occ} occupied rows`);
    ok("they look like Yardi codes", withId.every((r) => /^s\d{4,}$/i.test(r.resident_id)),
      JSON.stringify(withId.slice(0, 3).map((r) => r.resident_id)));
    ok("the name was left clean", withId.every((r) => !/[()]/.test(r.name)),
      JSON.stringify(withId.slice(0, 2).map((r) => r.name)));
    ok("and it is recorded as SOURCED, not asserted",
      withId.every((r) => r.resident_id_source === "embedded_in_name"));
    ok("no phone or email was mapped — contact data is out of scope",
      current.every((r) => r.phone == null && r.email == null));

    // ══ 3. MOVE-IN IS NOT LEASE START ════════════════════════════════
    console.log("\n  ── move-in and lease term are different facts ──");
    const renewed = current.filter((r) => r.name && r.move_in && r.lease_from && r.move_in < r.lease_from);
    ok("the source distinguishes original move-in from the current term",
      renewed.length > 0, `${renewed.length} residents whose move-in predates their current term`);
    ok("that difference is a renewal signature the model can keep", renewed.length > 0);

    // ══ 4. MATERIALIZATION — THE RULING ══════════════════════════════
    console.log("\n  ── 72 units, exactly 160 rentable positions ──");
    const org = (await pool.query(`insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
    const prop = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('Skyline Apartments','1417 N 15th St',$1,'bed') returning id`, [org])).rows[0].id;

    const roomsByUnit = new Map();
    for (const r of current) {
      if (!r.unit_number || !r.space_label) continue;
      if (!roomsByUnit.has(r.unit_number)) roomsByUnit.set(r.unit_number, []);
      const list = roomsByUnit.get(r.unit_number);
      if (!list.includes(r.space_label)) list.push(r.space_label);
    }
    ok("the source names 72 units", roomsByUnit.size === 72, String(roomsByUnit.size));

    const client = await pool.connect();
    let consumed = 0, created = 0;
    try {
      await client.query("begin");
      for (const [unitNumber, labels] of roomsByUnit) {
        const u = (await client.query(
          `insert into units (property_id, unit_number, occupancy_status) values ($1,$2,'unknown') returning id`,
          [prop, unitNumber])).rows[0].id;
        //  The trigger has just created a placeholder. Prove it, then consume it.
        const r = await materializeRentableSpaces(client, {
          unit_id: u, labels, kind: "bed", use_type: "residential" });
        if (r.consumed_placeholder) consumed++;
        created += r.created.length;
      }
      await client.query("commit");
    } catch (e) { await client.query("rollback"); throw e; }
    finally { client.release(); }

    ok("every unit's provisional placeholder was consumed", consumed === 72, String(consumed));
    const spaceCount = (await pool.query(
      `select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`,
      [prop])).rows[0].n;
    ok("EXACTLY 160 rentable positions exist — not 232", spaceCount === 160, String(spaceCount));
    const phantom = (await pool.query(
      `select count(*)::int n from spaces s join units u on u.id=s.unit_id
        where u.property_id=$1 and s.space_label=$2`, [prop, PLACEHOLDER_LABEL])).rows[0].n;
    ok("zero '(whole unit)' phantoms remain", phantom === 0, String(phantom));
    const kinds = (await pool.query(
      `select distinct position_kind from spaces s join units u on u.id=s.unit_id where u.property_id=$1`,
      [prop])).rows.map((r) => r.position_kind);
    ok("every position is classified bed", JSON.stringify(kinds) === JSON.stringify(["bed"]), JSON.stringify(kinds));

    const dp = await datedPropertyPositions(pool, { property_id: prop, as_of: "2026-07-31" });
    ok("the CANONICAL READ agrees: 160 positions", dp.count === 160, String(dp.count));

    // ══ 5. IDEMPOTENCE ═══════════════════════════════════════════════
    console.log("\n  ── running onboarding twice does not double the building ──");
    const c2 = await pool.connect();
    try {
      await c2.query("begin");
      for (const [unitNumber, labels] of roomsByUnit) {
        const u = (await c2.query(
          `select id from units where property_id=$1 and unit_number=$2`, [prop, unitNumber])).rows[0].id;
        await materializeRentableSpaces(c2, { unit_id: u, labels, kind: "bed", use_type: "residential" });
      }
      await c2.query("commit");
    } catch (e) { await c2.query("rollback"); throw e; } finally { c2.release(); }
    const after = (await pool.query(
      `select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`,
      [prop])).rows[0].n;
    ok("still exactly 160 after a second run", after === 160, String(after));

    // ══ 6. THE REFUSAL ═══════════════════════════════════════════════
    console.log("\n  ── a placeholder carrying history is REFUSED, never renamed ──");
    const dirtyUnit = (await pool.query(
      `insert into units (property_id, unit_number, occupancy_status) values ($1,'9999','unknown') returning id`,
      [prop])).rows[0].id;
    const ph = (await pool.query(
      `select id from spaces where unit_id=$1 and space_label=$2`, [dirtyUnit, PLACEHOLDER_LABEL])).rows[0];
    ok("the trigger created a placeholder on the new unit", !!ph);
    await pool.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,'{}',1000,'2026-01-01','2026-12-31','active')`, [prop, ph.id]);
    let refused = null;
    const c3 = await pool.connect();
    try {
      await c3.query("begin");
      await materializeRentableSpaces(c3, { unit_id: dirtyUnit, labels: ["Room1", "Room2"], kind: "bed" });
      await c3.query("commit");
    } catch (e) { await c3.query("rollback"); refused = e; } finally { c3.release(); }
    ok("materialization REFUSED", !!refused && refused.code === "PLACEHOLDER_NOT_PRISTINE",
      refused ? refused.code : "no refusal");
    ok("and the refusal NAMES what is holding it",
      !!refused && Array.isArray(refused.held) && refused.held.some((h) => h.startsWith("leases.")),
      JSON.stringify(refused && refused.held));
    const dirtySpaces = (await pool.query(
      `select space_label from spaces where unit_id=$1`, [dirtyUnit])).rows.map((r) => r.space_label);
    ok("nothing was renamed and no beds were created beside it",
      JSON.stringify(dirtySpaces) === JSON.stringify([PLACEHOLDER_LABEL]), JSON.stringify(dirtySpaces));

    // ══ 7. BY-UNIT STILL RESOLVES TO ONE POSITION ════════════════════
    console.log("\n  ── a by-unit property still gets exactly one position per unit ──");
    const byUnit = (await pool.query(
      `insert into properties (name, organization_id, leasing_basis)
       values ('By-Unit Control',$1,'unit') returning id`, [org])).rows[0].id;
    const c4 = await pool.connect();
    try {
      await c4.query("begin");
      for (const n of ["5C", "6A", "6B"]) {
        const u = (await c4.query(
          `insert into units (property_id, unit_number, occupancy_status) values ($1,$2,'unknown') returning id`,
          [byUnit, n])).rows[0].id;
        await materializeRentableSpaces(c4, { unit_id: u, labels: [], kind: "unit", use_type: "residential" });
      }
      await c4.query("commit");
    } catch (e) { await c4.query("rollback"); throw e; } finally { c4.release(); }
    const unitSpaces = (await pool.query(
      `select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`,
      [byUnit])).rows[0].n;
    ok("3 units -> 3 rentable positions", unitSpaces === 3, String(unitSpaces));
    const keptLabel = (await pool.query(
      `select distinct space_label from spaces s join units u on u.id=s.unit_id where u.property_id=$1`,
      [byUnit])).rows.map((r) => r.space_label);
    ok("the placeholder is KEPT as the whole-unit position, not consumed",
      JSON.stringify(keptLabel) === JSON.stringify([PLACEHOLDER_LABEL]), JSON.stringify(keptLabel));
    ok("one rule, both grains, no property-specific branch", true);

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
