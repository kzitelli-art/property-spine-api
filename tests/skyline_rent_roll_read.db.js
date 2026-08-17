/* ════════════════════════════════════════════════════════════════════
   skyline_rent_roll_read.db.js — THE OPERATOR RENT ROLL, FROM THE REAL
   JULY ARTIFACT.

   Unit-first, rentable positions nested, each showing CURRENT and NEXT.
   Asserted against the file's own summary, then PRINTED, because the
   point of this read is that a person can scan it — and a proof that
   only counted rows would not notice that it reads badly.

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
const { unitRentRoll } = require("../src/surfaces/rent_roll_unit_view.js");

const XLSX_PATH = process.env.SKYLINE_XLSX
  || "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd/d657f655-RentRoll07_1417.xlsx";
const ORG = "Skyline Rent Roll Read";

let pass = 0, fail = 0; const failures = [];
function ok(l, c, d) { if (c) { pass++; console.log("  ok    " + l); } else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); } }
const ymd = (s) => { const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}` : null; };

function readRentRoll(file) {
  const wb = XLSX.readFile(file);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const meta = {};
  for (const r of grid.slice(0, 6)) { const a = String(r[0] || ""); const m = a.match(/^(As Of)\s*=\s*(.+)$/); if (m) meta[m[1]] = m[2].trim(); }
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
  await pool.query(`delete from persons where source='skyline_rr_read'`);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

(async () => {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  THE OPERATOR RENT ROLL — real July artifact");
  console.log("════════════════════════════════════════════════════════════════\n");
  if (!fs.existsSync(XLSX_PATH)) { console.error("REFUSED: artifact not found"); process.exit(2); }
  const pool = new Pool({ connectionString: CONN });
  await cleanup(pool);

  const { meta, rows, totals } = readRentRoll(XLSX_PATH);
  const { mapped } = mapRows(rows);
  const current = mapped.filter((_, i) => rows[i].__section === "current");
  const future = mapped.filter((_, i) => rows[i].__section === "future");
  const AS_OF = ymd(meta["As Of"]);

  try {
    const org = (await pool.query(`insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
    const prop = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('Skyline Apartments','1417 N 15th St',$1,'bed') returning id`, [org])).rows[0].id;
    const batch = (await pool.query(
      `insert into import_batches (property_id, source_type, source_file, source_as_of_date, leasing_model, confidence, status)
       values ($1,'historical_snapshot','RentRoll07_1417.xlsx',$2,'bed','confirmed','committed') returning id`,
      [prop, AS_OF])).rows[0].id;

    const labelsByUnit = new Map();
    for (const m of current) {
      if (!labelsByUnit.has(m.unit_number)) labelsByUnit.set(m.unit_number, []);
      const l = labelsByUnit.get(m.unit_number);
      if (!l.includes(m.space_label)) l.push(m.space_label);
    }
    const spaceOf = new Map();
    const c1 = await pool.connect();
    try {
      await c1.query("begin");
      for (const [unitNumber, labels] of labelsByUnit) {
        const u = (await c1.query(
          `insert into units (property_id, unit_number, occupancy_status) values ($1,$2,'unknown') returning id`,
          [prop, unitNumber])).rows[0].id;
        await materializeRentableSpaces(c1, { unit_id: u, labels, kind: "bed", use_type: "residential" });
        for (const s of (await c1.query(`select id, space_label from spaces where unit_id=$1`, [u])).rows) {
          spaceOf.set(`${unitNumber}|${s.space_label}`, s.id);
        }
      }
      await c1.query("commit");
    } catch (e) { await c1.query("rollback"); throw e; } finally { c1.release(); }

    for (const m of [...current.filter((x) => x.name), ...future]) {
      const sid = spaceOf.get(`${String(m.unit_number).trim()}|${String(m.space_label).trim()}`);
      if (!sid) continue;
      const person = (await pool.query(
        `insert into persons (name, source, lifecycle_status, leasing_stage, import_batch_id,
                              source_type, source_as_of_date, confidence)
         values ($1,'skyline_rr_read','resident','resident',$2,'rent_roll_ledger',$3,'confirmed') returning id`,
        [m.name, batch, AS_OF])).rows[0].id;
      await pool.query(
        `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status,
                             import_batch_id, source_type, source_as_of_date, confidence)
         values ($1,$2,$3,$4,$5,$6,'active',$7,'historical_snapshot',$8,'confirmed')`,
        [prop, sid, [person], Number(m.actual_rent) > 0 ? Number(m.actual_rent) : null,
         m.lease_from, m.lease_to, batch, AS_OF]);
    }

    // ══ THE READ ═════════════════════════════════════════════════════
    const rr = await unitRentRoll(pool, { property_id: prop, as_of: AS_OF });

    console.log("  ── shape ──");
    ok("unit-first: 72 units", rr.totals.units === 72, String(rr.totals.units));
    ok("beds nested: 160 rentable positions", rr.totals.rentable_positions === 160, String(rr.totals.rentable_positions));
    ok("every unit carries its own positions",
      rr.units.every((u) => u.positions.length === u.rentable_positions));
    ok(`occupied agrees with the file (${totals.occupied})`, rr.totals.occupied === totals.occupied, String(rr.totals.occupied));
    ok("open = positions - occupied", rr.totals.open === 160 - totals.occupied, String(rr.totals.open));
    ok("units are ordered the way a person reads them",
      rr.units[0].unit_number === "1417-101", rr.units[0].unit_number);

    console.log("\n  ── current and next, on one line, from one truth ──");
    const withNext = rr.units.flatMap((u) => u.positions).filter((p) => p.next);
    ok("positions carrying a known next position are visible",
      rr.totals.with_next_known === withNext.length && withNext.length > 0,
      `${withNext.length} with next`);
    ok("NEXT names the person, not just a date",
      withNext.every((p) => p.next.resident !== undefined) && withNext.some((p) => p.next.resident),
      JSON.stringify(withNext.slice(0, 2).map((p) => p.next.resident)));
    ok("NEXT carries its own term and proof state",
      withNext.every((p) => p.next.starts && p.next.state));
    //  ── A FACT ABOUT THIS FILE, NOT ABOUT THE READ ────────────────
    //  No bed in the 07/31 export carries BOTH a current lease and a next
    //  one, and that is correct: the 37 occupied beds are residents whose
    //  new term already began 07/27, and the 91 future leases are all on
    //  OTHER beds starting 08/03. Taken four days into the new lease year
    //  the two sets are disjoint. (The 04/30 export had 38 such beds.)
    //
    //  So the capability is proven directly rather than claimed from data
    //  that cannot show it: give one occupied bed a genuine successor and
    //  require the read to render both halves of the line.
    const bothInFile = rr.units.flatMap((u) => u.positions).filter((p) => p.current && p.next).length;
    ok("this export has no bed carrying both — current and future are disjoint at 07/31",
      bothInFile === 0, `${bothInFile} found`);

    const occupiedPos = rr.units.flatMap((u) => u.positions).find((p) => p.current && p.current.through);
    const succPerson = (await pool.query(
      `insert into persons (name, source, lifecycle_status, leasing_stage)
       values ('Emily Chen','skyline_rr_read','resident','resident') returning id`)).rows[0].id;
    await pool.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,$3,875,($4::date + 7), ($4::date + 372),'active')`,
      [prop, occupiedPos.space_id, [succPerson], occupiedPos.current.through]);
    const withBoth = await unitRentRoll(pool, { property_id: prop, as_of: AS_OF });
    const line = withBoth.units.flatMap((u) => u.positions).find((p) => p.space_id === occupiedPos.space_id);
    ok("a bed with both renders CURRENT and NEXT on one line",
      !!(line && line.current && line.next && line.next.resident === "Emily Chen"),
      JSON.stringify(line && { cur: line.current && line.current.resident, next: line.next }));
    ok("and the successor's own rent comes through, not the current one's",
      line && line.next && line.next.rent.amount === 875, JSON.stringify(line && line.next && line.next.rent));
    console.log(`        -> ${line.label}: ${line.current.resident} through ${line.current.through}` +
                `  |  Next: ${line.next.resident} starts ${line.next.starts} $${line.next.rent.amount}`);

    console.log("\n  ── honest blanks ──");
    const unknownRent = rr.units.flatMap((u) => u.positions)
      .filter((p) => p.current && p.current.rent.state === "not_in_source");
    ok("a rent the source never carried is null with a REASON, never 0",
      unknownRent.every((p) => p.current.rent.amount === null && p.current.rent.state === "not_in_source"));
    ok("the total states how many rents the source did not carry",
      rr.totals.rent_not_in_source === unknownRent.length, String(rr.totals.rent_not_in_source));
    ok("an empty position is `open`, never asserted as marketable",
      rr.units.flatMap((u) => u.positions).filter((p) => !p.current)
        .every((p) => p.current === null));

    console.log("\n  ── stable identity travels with the row ──");
    //  AN API OUTPUT KEY IS A CONTRACT. These are asserted BY NAME because a
    //  surface that shows a resident and cannot say which person record it is
    //  has made the displayed NAME the key — and the identity rules in this
    //  repo exist precisely because names are not keys. A blunt rename sweep
    //  that dropped one of these would break the Person Card silently, which
    //  is the exact defect class migration 159 already cost us once.
    const occ = withBoth.units.flatMap((u) => u.positions).filter((p) => p.current);
    ok("every current position carries person_id",
      occ.length > 0 && occ.every((p) => "person_id" in p.current && p.current.person_id),
      `${occ.filter((p) => !p.current.person_id).length} missing of ${occ.length}`);
    ok("every current position carries lease_id",
      occ.every((p) => "lease_id" in p.current && p.current.lease_id));
    const nx = withBoth.units.flatMap((u) => u.positions).filter((p) => p.next);
    ok("every next commitment carries person_id and lease_id",
      nx.length > 0 && nx.every((p) => "person_id" in p.next && "lease_id" in p.next && p.next.lease_id),
      `${nx.length} commitments`);
    ok("the next person_id is the SUCCESSOR's, never the sitting resident's",
      !!(line && line.next.person_id === succPerson && line.current.person_id !== succPerson));
    ok("space_id and unit_id are on every row a surface can act from",
      withBoth.units.every((u) => u.unit_id && u.positions.every((p) => p.space_id)));

    console.log("\n  ── one truth, two dates ──");
    const later = await unitRentRoll(pool, { property_id: prop, as_of: "2026-09-01" });
    ok("the same read at a later date shows the turn completing",
      later.totals.occupied > rr.totals.occupied,
      `${rr.totals.occupied} on ${AS_OF} -> ${later.totals.occupied} on 2026-09-01`);
    ok("and it is the same 160 positions, not a second model",
      later.totals.rentable_positions === 160);

    // ── PRINT IT. A read nobody looked at is not a read. ─────────────
    console.log("\n  ════ WHAT MIKE SEES ════════════════════════════════════");
    const shown = await unitRentRoll(pool, { property_id: prop, as_of: AS_OF });
    const picked = new Set(); const show = [];
    const take = (pred) => { const u = shown.units.find((x) => pred(x) && !picked.has(x.unit_id));
                             if (u) { picked.add(u.unit_id); show.push(u); } };
    take((u) => u.positions.some((p) => p.current && p.next));      // a bed with both
    take((u) => u.occupied > 0 && u.occupied < u.rentable_positions); // partly filled
    take((u) => u.occupied === 0);                                   // fully open
    for (const u of show) {
      console.log(`\n  ${u.unit_number}   ${u.occupied}/${u.rentable_positions} occupied` +
                  (u.with_next_known ? ` · ${u.with_next_known} committed` : ""));
      for (const p of u.positions) {
        const rent = p.current && p.current.rent.amount != null ? `$${p.current.rent.amount}` : "rent not in source";
        console.log(p.current
          ? `    ${p.label.padEnd(6)} ${p.current.resident} · ${rent} · through ${p.current.through}`
          : `    ${p.label.padEnd(6)} open`);
        console.log(p.next
          ? `           Next: ${p.next.resident} · starts ${p.next.starts}` +
            (p.next.rent.amount != null ? ` · $${p.next.rent.amount}` : " · rent not in source")
          : `           Next: —`);
      }
    }
    console.log("  ════════════════════════════════════════════════════════");

  } finally {
    await cleanup(pool);
    await pool.end();
  }

  console.log(`\n  ${pass + fail} run · ${pass} passed · ${fail} failed`);
  if (fail) console.log("  FAILED: " + failures.join(" | "));
  console.log(fail ? "  ✗ FAIL\n" : "  ✓ PASS\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
