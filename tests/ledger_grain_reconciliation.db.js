/* ════════════════════════════════════════════════════════════════════
   ledger_grain_reconciliation.db.js — A RENT ROLL REFRESH IS EVIDENCE,
   NOT AUTHORITY TO REDEFINE THE BUILDING.

   ── THE DEFECT ──────────────────────────────────────────────────────
   `loadLedgerSnapshot` already establishes the unit/space substrate under
   its evidence. It did so at an ASSUMED whole-unit grain for every row of
   every property: `const label="(whole unit)"`. `leasing_model` was
   stamped onto the import_batches row and ignored by the spaces.

   On an already-bed-grained Skyline, a July refresh would therefore have
   put all 72 surplus placeholders straight back — undoing the repair — and
   then jammed confirmation on SURPLUS_PLACEHOLDER for all 72 units.

   ── THE RULE, AND THE ASYMMETRY IS THE POINT ────────────────────────
       a unit that has NEVER been materialized may be materialized FROM
       the source;
       a unit that ALREADY carries established positions may only be
       RECONCILED to them.

   ── THE ACCEPTANCE TEST ─────────────────────────────────────────────
   Not "the materializer passed". It is case 3: the real July 31 refresh
   enters an already-bed-grained Skyline without changing what Skyline
   physically contains.

       160 before  →  160 after  →  0 spaces added  →  0 placeholders

   CLASS 3 — proof infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const XLSX = require("xlsx");
const fs = require("fs");
const { loadLedgerSnapshot } = require("../src/shared/snapshot_loader.js");
const { retireInventoryUnits } = require("../src/tenancy/inventory_retirement.js");
const { intervalPropertyPositions } = require("../src/tenancy/dated_positions.js");

const HARNESS = "ledger_grain_reconciliation.db.js";
const EXPECTED = 28;
const JULY = process.env.SKYLINE_XLSX
  || "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd/d657f655-RentRoll07_1417.xlsx";

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log("  ok    " + label); passed++; }
  else { console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); failed++; }
};

//  The REAL workbook, read the way the browser proof reads it, so case 3 is
//  the actual July 31 refresh and not a hand-built imitation of one.
function readJuly(file) {
  const wb = XLSX.readFile(file);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const h1 = grid[5] || [], h2 = grid[6] || [];
  const headers = h1.map((h, i) => [h, h2[i]].filter(Boolean).join(" ").trim() || `col${i}`);
  const iUnit = 0, iRoom = headers.findIndex((h) => /^Room$/i.test(h));
  const out = []; let section = null;
  grid.forEach((r, i) => {
    const a = String(r[0] || "").trim();
    const lone = a && r.slice(1).filter((x) => x != null).length === 0;
    if (lone && /^Current\/Notice\/Vacant/.test(a)) { section = "current"; return; }
    if (lone && /^Future Residents/.test(a)) { section = "future"; return; }
    if (a === "Summary Groups") { section = null; return; }
    if (!section || !/^\d{3,4}-\d{2,3}$/.test(a)) return;
    out.push({
      //  1417-101 → 101. Not a Yardi habit worth keeping in the unit number.
      unit_number: a.replace(/^\d{3,4}-/, ""),
      room: iRoom >= 0 && r[iRoom] != null ? String(r[iRoom]).trim() : null,
      section, status: "vacant", row_index: i + 1,
    });
  });
  return out;
}

const q1 = async (pool, sql, p) => (await pool.query(sql, p)).rows[0];
const positions = async (pool, id) => (await intervalPropertyPositions(pool, {
  property_id: id, requested_start: "2026-08-01", requested_end: "2027-07-31" })).count;
//  Scoped to CURRENT inventory. A retired unit keeps the trigger's
//  placeholder — nothing removes it and nothing should, because the unit is
//  retained as history. Counting it would make a correct world look wrong.
const spaceShape = (pool, id) => q1(pool,
  `select count(*)::int total,
          count(*) filter (where s.space_label = '(whole unit)')::int placeholders,
          count(*) filter (where s.space_label like 'Room%')::int beds
     from spaces s join units u on u.id = s.unit_id
    where u.property_id = $1
      and not exists (select 1 from inventory_retirements ir
                       where ir.unit_id = u.id and ir.reversed_at is null)`, [id]);

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  const made = [];
  const newProperty = async (basis, name) => {
    const id = (await q1(pool,
      `insert into properties (name, address, leasing_basis) values ($1,'1417 harness',$2) returning id`,
      [name, basis])).id;
    made.push(id); return id;
  };
  const load = async (propertyId, rows, opts = {}) => {
    try {
      const out = await loadLedgerSnapshot(pool, rows, {
        targetPropertyId: propertyId, sourceFile: opts.file || "RentRoll07_1417.xlsx",
        sourceAsOfDate: opts.asOf || "2026-07-31", confidence: "confirmed",
        leasingModel: opts.leasingModel, force: true,
      });
      return out;
    } catch (e) { return { thrown: e }; }
  };

  try {
    // ══ CASE 1 — BY-UNIT FRESH PROPERTY, UNCHANGED BEHAVIOUR ═════════
    {
      const P = await newProperty("unit", "grain case 1 by-unit");
      const out = await load(P, [
        { unit_number: "101", room: null, section: "current", status: "vacant", row_index: 1 },
        { unit_number: "102", room: null, section: "current", status: "vacant", row_index: 2 }]);
      ok("1 by-unit fresh property loads", out && out.ok === true, JSON.stringify(out && (out.error || out.thrown)));
      ok("1 …grain is read as 'unit' from the property", out.grain === "unit", String(out.grain));
      const sh = await spaceShape(pool, P);
      ok("1 …exactly one whole-unit position per unit — unchanged behaviour",
        sh.total === 2 && sh.placeholders === 2 && sh.beds === 0, JSON.stringify(sh));
      ok("1 …and the canonical read agrees", await positions(pool, P) === 2);
      ok("1 …no discrepancies", Array.isArray(out.discrepancies) && out.discrepancies.length === 0,
        JSON.stringify(out.discrepancies));
    }

    // ══ CASE 2 — BY-BED FRESH PROPERTY WITH NAMED ROOMS ══════════════
    {
      const P = await newProperty("bed", "grain case 2 by-bed fresh");
      const rows = [];
      let i = 0;
      for (const u of ["101", "102"]) for (const r of ["Room1", "Room2", "Room3"]) {
        rows.push({ unit_number: u, room: r, section: "current", status: "vacant", row_index: ++i });
      }
      const out = await load(P, rows);
      ok("2 by-bed fresh property loads", out && out.ok === true, JSON.stringify(out && (out.error || out.thrown)));
      ok("2 …grain is read as 'bed' from the property", out.grain === "bed", String(out.grain));
      const sh = await spaceShape(pool, P);
      ok("2 …the provisional placeholder was CONSUMED — zero remain",
        sh.placeholders === 0, JSON.stringify(sh));
      ok("2 …exactly the named positions: 6, not 8 (no N+1)",
        sh.total === 6 && sh.beds === 6, JSON.stringify(sh));
      ok("2 …and the canonical read returns 6", await positions(pool, P) === 6);
    }

    // ══ CASE 3 — THE ACCEPTANCE TEST ═════════════════════════════════
    //  Already-bed-grained Skyline, repaired and retired, then the REAL
    //  July 31 workbook refreshes it. The denominator must not move.
    {
      ok("3 the real July 31 workbook is present", fs.existsSync(JULY), JULY);
      const july = readJuly(JULY);
      const units = [...new Set(july.map((r) => r.unit_number))];
      const beds = new Set(july.map((r) => `${r.unit_number}|${r.room}`));
      ok("3 …and it names 72 units and 160 beds",
        units.length === 72 && beds.size === 160, `${units.length} units / ${beds.size} beds`);

      const P = await newProperty("bed", "grain case 3 skyline refresh");
      //  Establish the CORRECTED world the production rail will have after
      //  steps B and C: 160 beds, no surplus placeholders, 159 retired.
      const c = await pool.connect();
      let userId = null;
      try {
        await c.query("begin");
        userId = (await c.query(
          `insert into users (email,name) values ($1,'grain harness') returning id`,
          [`grain-${Date.now()}@harness.local`])).rows[0].id;
        const byUnit = new Map();
        for (const r of july) {
          if (!byUnit.has(r.unit_number)) byUnit.set(r.unit_number, new Set());
          byUnit.get(r.unit_number).add(r.room);
        }
        for (const [u, rooms] of byUnit) {
          const id = (await c.query(
            `insert into units (property_id,unit_number,occupancy_status) values ($1,$2,'unknown') returning id`,
            [P, u])).rows[0].id;
          for (const r of rooms) {
            await c.query(
              `insert into spaces (unit_id,space_label,position_kind) values ($1,$2,'bed')`, [id, r]);
          }
          //  step B already removed the trigger's surplus placeholder
          await c.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [id]);
        }
        //  step C: the 2020 bed-as-unit representation, retired
        const legacy = [];
        for (let k = 0; k < 5; k++) {
          legacy.push((await c.query(
            `insert into units (property_id,unit_number,occupancy_status) values ($1,$2,'unknown') returning id`,
            [P, `${100 + k} - A`])).rows[0].id);
        }
        await retireInventoryUnits(c, { property_id: P, unit_ids: legacy, actor: { user_id: userId },
          rationale: "The 2020 rent roll modelled each bed as a unit; the corrected import supersedes it." });
        await c.query("commit");
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
      if (userId) made.push(null);

      const before = await positions(pool, P);
      const shBefore = await spaceShape(pool, P);
      ok("3 BEFORE the refresh the denominator is 160", before === 160, String(before));
      ok("3 …with zero placeholders", shBefore.placeholders === 0, JSON.stringify(shBefore));

      const out = await load(P, july, { file: "RentRoll07_1417.xlsx" });
      ok("3 the REAL July 31 refresh loads", out && out.ok === true,
        JSON.stringify(out && (out.error || (out.thrown && out.thrown.message))));

      const after = await positions(pool, P);
      const shAfter = await spaceShape(pool, P);
      ok("3 ★ AFTER the refresh the denominator is STILL 160", after === 160, String(after));
      ok("3 ★ zero spaces were added", shAfter.total === shBefore.total,
        `${shBefore.total} → ${shAfter.total}`);
      ok("3 ★ zero whole-unit placeholders were recreated", shAfter.placeholders === 0,
        String(shAfter.placeholders));
      ok("3 …every row attached to an established bed",
        Array.isArray(out.discrepancies) && out.discrepancies.length === 0,
        JSON.stringify((out.discrepancies || []).slice(0, 3)));
      ok("3 …and the evidence rows point at real positions",
        (await q1(pool,
          `select count(*)::int n from import_source_rows
            where import_batch_id = $1 and produced_space_id is not null`,
          [out.import_batch_id])).n === july.length,
        String(july.length));
      ok("3 …and no retired unit received provenance",
        (await q1(pool,
          `select count(*)::int n from units u
             join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
            where u.property_id = $1 and u.import_batch_id is not null`, [P])).n === 0);
    }

    // ══ CASE 4 — A LATER SOURCE NAMES AN UNKNOWN POSITION ════════════
    {
      const P = await newProperty("bed", "grain case 4 unknown room");
      await load(P, [
        { unit_number: "101", room: "Room1", section: "current", status: "vacant", row_index: 1 },
        { unit_number: "101", room: "Room2", section: "current", status: "vacant", row_index: 2 }]);
      const shBefore = await spaceShape(pool, P);
      ok("4 the unit is established with 2 beds", shBefore.beds === 2, JSON.stringify(shBefore));

      const out = await load(P, [
        { unit_number: "101", room: "Room1", section: "current", status: "vacant", row_index: 1 },
        { unit_number: "101", room: "Room9", section: "current", status: "vacant", row_index: 2 }],
        { file: "later.xlsx", asOf: "2026-08-31" });
      const shAfter = await spaceShape(pool, P);
      ok("4 ★ NO new inventory was created for the unknown position",
        shAfter.total === shBefore.total, `${shBefore.total} → ${shAfter.total}`);
      ok("4 …the discrepancy is VISIBLE, not swallowed",
        Array.isArray(out.discrepancies) && out.discrepancies.length === 1,
        JSON.stringify(out.discrepancies));
      ok("4 …and it names the position and the unit",
        /Room9/.test(JSON.stringify(out.discrepancies)) && /101/.test(JSON.stringify(out.discrepancies)));
      ok("4 …the row is still on record as evidence with no produced position",
        (await q1(pool,
          `select count(*)::int n from import_source_rows
            where import_batch_id=$1 and produced_space_id is null and parse_note like 'discrepancy%'`,
          [out.import_batch_id])).n === 1);

      //  A bed row that named no bed must not become a synthetic "(bed)".
      const out2 = await load(P, [
        { unit_number: "101", room: null, section: "current", status: "vacant", row_index: 1 }],
        { file: "unnamed.xlsx", asOf: "2026-09-30" });
      ok("4 …a by-bed row with NO named bed creates no synthetic '(bed)' position",
        (await q1(pool,
          `select count(*)::int n from spaces s join units u on u.id=s.unit_id
            where u.property_id=$1 and s.space_label='(bed)'`, [P])).n === 0);
      ok("4 …and it is recorded as a discrepancy rather than placed",
        Array.isArray(out2.discrepancies) && out2.discrepancies.length === 1 &&
        /named no room/i.test(JSON.stringify(out2.discrepancies)),
        JSON.stringify(out2.discrepancies));
    }

    // ══ CASE 5 — RETIRED / CURRENT COLLISION ═════════════════════════
    //
    //  ⚠ MEASURED, AND THE ANSWER CHANGED THE CASE. The collision this was
    //  meant to exercise CANNOT EXIST: `uq_unit_per_property` is
    //  UNIQUE (property_id, unit_number), present since 001_baseline and
    //  named as it exists in production. A current and a retired unit can
    //  never share a unit number on one property.
    //
    //  So the confirm-side resolver change is defence in depth, not the
    //  closing of a live hole, and saying otherwise would overclaim. What
    //  IS proven here: the constraint refuses the collision, and both
    //  stages nonetheless go through the one resolver, so relaxing that
    //  constraint later cannot silently reintroduce the hazard.
    {
      const P = await newProperty("bed", "grain case 5 collision");
      const c = await pool.connect();
      let uid = null, dupCode = null;
      try {
        await c.query("begin");
        uid = (await c.query(`insert into users (email,name) values ($1,'g5') returning id`,
          [`g5-${Date.now()}@harness.local`])).rows[0].id;
        const cur = (await c.query(
          `insert into units (property_id,unit_number,occupancy_status) values ($1,'101','unknown') returning id`,
          [P])).rows[0].id;
        for (const r of ["Room1", "Room2"]) {
          await c.query(`insert into spaces (unit_id,space_label,position_kind) values ($1,$2,'bed')`, [cur, r]);
        }
        await c.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [cur]);
        await c.query("commit");
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

      //  PROVOKE the collision rather than assume it is prevented.
      try {
        await pool.query(
          `insert into units (property_id,unit_number,occupancy_status) values ($1,'101','unknown')`, [P]);
      } catch (e) { dupCode = e.code; }
      ok("5 ★ a second unit with the same number is REFUSED by uq_unit_per_property",
        dupCode === "23505", String(dupCode));
      ok("5 …so a retired/current unit-number collision cannot exist at all",
        (await q1(pool, `select count(*)::int n from units where property_id=$1 and unit_number='101'`,
          [P])).n === 1);

      //  A refresh still lands on the current unit, and the retired
      //  representation of a DIFFERENT number receives nothing.
      const out = await load(P, [
        { unit_number: "101", room: "Room1", section: "current", status: "vacant", row_index: 1 }],
        { file: "collision.xlsx", asOf: "2026-07-31" });
      ok("5 the refresh loads onto current inventory", out && out.ok === true,
        JSON.stringify(out && (out.error || (out.thrown && out.thrown.message))));
      ok("5 …no retired unit received provenance",
        (await q1(pool,
          `select count(*)::int n from units u
             join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
            where u.property_id = $1 and u.import_batch_id is not null`, [P])).n === 0);

      //  BOTH STAGES, ONE RESOLVER. Asserted on the source: driving a full
      //  proposal lifecycle here would prove the harness, not the rule.
      const src = fs.readFileSync("src/onboarding/activation_service.js", "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      ok("5 ★ confirmProposal resolves through resolveCurrentUnitId",
        /resolveCurrentUnitId\(/.test(src));
      ok("5 …and no longer selects a unit by unit_number without the predicate",
        !/select \* from units\s+where property_id=\$1 and unit_number=\$2/.test(src));
      ok("5 …and did not grow a second copy of the predicate",
        !/inventory_retirements/.test(src));
    }
  } catch (e) {
    console.log("  FAIL  harness threw  →  " +
      (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)));
    failed++;
  } finally {
    for (const id of made.filter(Boolean)) {
      const d = (sql) => pool.query(sql, [id]).catch(() => {});
      await d("delete from import_source_rows where import_batch_id in (select id from import_batches where property_id=$1)");
      await d("delete from leases where property_id=$1");
      await d("delete from inventory_retirements where property_id=$1");
      await d("delete from spaces where unit_id in (select id from units where property_id=$1)");
      await d("delete from units where property_id=$1");
      await d("delete from import_batches where property_id=$1");
      await d("delete from properties where id=$1");
    }
    await pool.query(`delete from users where email like '%@harness.local'`).catch(() => {});
    await pool.end();
  }

  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})();
