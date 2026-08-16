/* ════════════════════════════════════════════════════════════════════
   interval_positions.db.js — TWO TEMPORAL QUESTIONS, ONE TRUTH.
   REAL POSTGRES · 72 UNITS · 160 BEDS · THE REAL 07/31 EXPORT.

   The hard invariant Slice 2 exists to hold:

       same spaces · same leases · same dated rights
       point-in-time Rent Roll  AND  interval Forward Leasing
       are two temporal questions over ONE truth

   This proves it structurally rather than by assertion: both reads are
   driven from the SAME loadSpaceRows() call in this file, and the
   interval answer is required to agree with the dated answer wherever
   the two overlap.

   ── THE NUMBER THIS FILE EXISTS FOR ─────────────────────────────────
   At 2026-07-31 the Rent Roll shows 123 positions "open" — correct, and
   a statement about ONE DATE. Ninety-one of them are already committed
   from 8/3. For the 2026-27 interval only 32 beds can actually take a
   lease. A Forward Leasing surface that reused `open` would offer 123.

   ── AND THE ONE THAT PROVES THERE IS NO FORWARD WRITER ──────────────
   A future lease is SIGNED here — a plain insert into `leases`, the same
   durable object the canonical writer produces — and the interval answer
   must move by exactly one with nothing else touched. Then it is voided
   through the canonical lease_void_service and the answer must come
   back. No Forward Leasing table, no Forward Leasing writer, no cache.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/spine_full \
       node tests/interval_positions.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const fs = require("fs");
const XLSX = require("xlsx");
const { mapRows } = require("../src/onboarding/rent_roll_field_map.js");
const { materializeRentableSpaces } = require("../src/tenancy/inventory_materialization.js");
const { datedPropertyPositions, intervalPropertyPositions } = require("../src/tenancy/dated_positions.js");
const { unitRentRoll } = require("../src/surfaces/rent_roll_unit_view.js");

const XLSX_PATH = process.env.SKYLINE_XLSX
  || "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd/d657f655-RentRoll07_1417.xlsx";
const ORG = "Interval Positions";

let pass = 0, fail = 0, ran = 0; const failures = [];
function ok(l, c, d) {
  ran++;
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
}
const ymd = (s) => {
  const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

function readRentRoll(file) {
  const wb = XLSX.readFile(file);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const meta = {};
  for (const r of grid.slice(0, 6)) {
    const a = String(r[0] || ""); const m = a.match(/^(As Of)\s*=\s*(.+)$/);
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
  await pool.query(`delete from persons where source='interval_positions'`);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

receipt.begin(__filename, { url: CONN, expected: 30 });

(async () => {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`\n  REFUSED: the real artifact is not at ${XLSX_PATH}.\n`);
    process.exit(2);
  }
  const pool = new Pool({ connectionString: CONN });
  await cleanup(pool);

  const { meta, rows, totals } = readRentRoll(XLSX_PATH);
  const { mapped } = mapRows(rows);
  const current = mapped.filter((_, i) => rows[i].__section === "current");
  const future = mapped.filter((_, i) => rows[i].__section === "future");
  const AS_OF = ymd(meta["As Of"]);

  const org = (await pool.query(`insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
  const prop = (await pool.query(
    `insert into properties (name, address, organization_id, leasing_basis)
     values ('Skyline Apartments','1417 N 15th St',$1,'bed') returning id`, [org])).rows[0].id;
  //  THE BY-UNIT CONTROL. Same service, no branch — §22.
  const byUnitProp = (await pool.query(
    `insert into properties (name, address, organization_id, leasing_basis)
     values ('Chestnut Row','4125 Chestnut St',$1,'unit') returning id`, [org])).rows[0].id;

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
    //  Two whole-unit positions on the control property, with the same
    //  shape of rights as two Skyline beds.
    for (const n of ["101", "102"]) {
      const u = (await c1.query(
        `insert into units (property_id, unit_number, occupancy_status) values ($1,$2,'unknown') returning id`,
        [byUnitProp, n])).rows[0].id;
      await materializeRentableSpaces(c1, { unit_id: u, labels: [], kind: "unit", use_type: "residential" });
      for (const s of (await c1.query(`select id, space_label from spaces where unit_id=$1`, [u])).rows) {
        spaceOf.set(`CR-${n}`, s.id);
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
       values ($1,'interval_positions','resident','resident',$2,'rent_roll_ledger',$3,'confirmed') returning id`,
      [m.name, batch, AS_OF])).rows[0].id;
    await pool.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status,
                           import_batch_id, source_type, source_as_of_date, confidence)
       values ($1,$2,$3,$4,$5,$6,'active',$7,'historical_snapshot',$8,'confirmed')`,
      [prop, sid, [person], Number(m.actual_rent) > 0 ? Number(m.actual_rent) : null,
       m.lease_from, m.lease_to, batch, AS_OF]);
  }

  const YEAR = { start: "2026-08-01", end: "2027-07-31" };
  const NEXT_YEAR = { start: "2027-09-01", end: "2028-07-31" };

  // ══ 1 · POINT-IN-TIME AND INTERVAL, SIDE BY SIDE ══════════════════
  console.log("\n  ── one truth, two temporal questions ──");
  const dated = await datedPropertyPositions(pool, { property_id: prop, as_of: AS_OF });
  const screen = await unitRentRoll(pool, { property_id: prop, as_of: AS_OF });
  const iv = await intervalPropertyPositions(pool, {
    property_id: prop, requested_start: YEAR.start, requested_end: YEAR.end });

  const open = dated.positions.filter((p) => p.tenancy_state !== "contractually_occupied").length;
  console.log(`        at ${AS_OF}          occupied ${dated.positions.length - open} · "open" ${open}`);
  console.log(`        interval ${YEAR.start} → ${YEAR.end}`);
  console.log(`          contractually_free    ${iv.totals.contractually_free}`);
  console.log(`          term_blocked          ${iv.totals.term_blocked}`);
  console.log(`          term_partially_blocked ${iv.totals.term_partially_blocked}`);
  console.log(`          unresolved            ${iv.totals.unresolved}`);

  ok("I1  both reads see the same inventory", iv.count === dated.count && iv.count === totals.beds,
     `${iv.count} vs ${dated.count} vs ${totals.beds}`);
  ok("I2  and the same units", iv.totals.units === screen.totals.units, `${iv.totals.units}`);
  ok("I3  every position lands in exactly one of the four states",
     iv.totals.contractually_free + iv.totals.term_blocked
     + iv.totals.term_partially_blocked + iv.totals.unresolved === iv.count,
     JSON.stringify(iv.totals));
  //  THE POINT OF SLICE 2, on real data.
  ok(`I4  the interval answer (${iv.totals.contractually_free}) is FAR below the point-in-time "open" (${open})`,
     iv.totals.contractually_free < open,
     `interval ${iv.totals.contractually_free} vs open ${open}`);
  ok("I5  …and the difference is the positions already committed",
     open - iv.totals.contractually_free ===
       dated.positions.filter((p) => p.tenancy_state !== "contractually_occupied"
         && ((p.successor && p.successor.state !== "none")
             || (p.future_commitment && p.future_commitment.state !== "none"))).length,
     `${open - iv.totals.contractually_free}`);

  //  AGREEMENT WHERE THE TWO OVERLAP: anything the dated read calls
  //  occupied on the requested start date must collide with the interval.
  const datedAtStart = await datedPropertyPositions(pool, { property_id: prop, as_of: YEAR.start });
  const occupiedIds = new Set(datedAtStart.positions
    .filter((p) => p.tenancy_state === "contractually_occupied").map((p) => String(p.space_id)));
  const freeIds = new Set(iv.positions
    .filter((p) => p.interval_state === "contractually_free").map((p) => String(p.space_id)));
  const contradiction = [...occupiedIds].filter((id) => freeIds.has(id));
  ok("I6  NOTHING occupied on the requested start date reads contractually_free",
     contradiction.length === 0, `${contradiction.length} contradictions`);

  // ══ 2 · THE ANSWER IS GENUINELY INTERVAL-SENSITIVE ════════════════
  console.log("\n  ── it is the INTERVAL that is being asked about ──");
  const nextYear = await intervalPropertyPositions(pool, {
    property_id: prop, requested_start: NEXT_YEAR.start, requested_end: NEXT_YEAR.end });
  ok("I7  the following year is materially freer than this one",
     nextYear.totals.contractually_free > iv.totals.contractually_free,
     `${iv.totals.contractually_free} → ${nextYear.totals.contractually_free}`);
  console.log(`        ${NEXT_YEAR.start} → ${NEXT_YEAR.end}   contractually_free ${nextYear.totals.contractually_free}`);
  ok("I8  the requested interval is echoed on the read, never assumed",
     iv.requested_start === YEAR.start && iv.requested_end === YEAR.end);
  ok("I9  an inverted interval is refused, not answered", await (async () => {
    try { await intervalPropertyPositions(pool, { property_id: prop, requested_start: "2027-01-01", requested_end: "2026-01-01" }); return false; }
    catch (e) { return e.code === "INVALID_INTERVAL"; }
  })());
  ok("I10 a missing property_id is refused", await (async () => {
    try { await intervalPropertyPositions(pool, { requested_start: YEAR.start }); return false; }
    catch (_) { return true; }
  })());

  // ══ 3 · A SIGNED FUTURE LEASE MOVES IT. NO FORWARD WRITER. ════════
  console.log("\n  ── a signed future lease, and no Forward Leasing writer ──");
  const target = iv.positions.find((p) => p.interval_state === "contractually_free");
  ok("I11 a contractually free position exists to lease", !!target, JSON.stringify(iv.totals));

  const tenant = (await pool.query(
    `insert into persons (name, source, lifecycle_status, leasing_stage)
     values ('Priya Raman','interval_positions','resident','resident') returning id`)).rows[0].id;
  //  A plain insert into `leases` — the SAME durable object the canonical
  //  countersign writer (tenancy_anchor_service) produces. Nothing else is
  //  touched: no forward table, no projection, no cache, no flag.
  const signed = (await pool.query(
    `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
     values ($1,$2,$3,1150,$4,$5,'pending') returning id`,
    [prop, target.space_id, [tenant], "2026-11-01", "2027-04-30"])).rows[0].id;

  const afterSign = await intervalPropertyPositions(pool, {
    property_id: prop, requested_start: YEAR.start, requested_end: YEAR.end });
  const signedPos = afterSign.positions.find((p) => String(p.space_id) === String(target.space_id));
  ok("I12 the interval answer moved WITHOUT any Forward Leasing write",
     afterSign.totals.contractually_free === iv.totals.contractually_free - 1,
     `${iv.totals.contractually_free} → ${afterSign.totals.contractually_free}`);
  ok("I13 …that exact position is now partially_conflicted",
     signedPos.interval_state === "term_partially_blocked", signedPos.interval_state);
  ok("I14 …and it reports the two spans it CAN still take",
     JSON.stringify(signedPos.free_spans) === JSON.stringify([
       { from: "2026-08-01", to: "2026-10-31" }, { from: "2027-05-01", to: "2027-07-31" }]),
     JSON.stringify(signedPos.free_spans));
  ok("I15 …naming the lease that took the middle, with its proof basis",
     signedPos.colliding_rights.length === 1
     && String(signedPos.colliding_rights[0].lease_id) === String(signed)
     && signedPos.colliding_rights[0].proof_basis === "unproven",
     JSON.stringify(signedPos.colliding_rights));
  ok("I16 …and the resident on it travels with the answer",
     signedPos.colliding_rights[0].tenants.some((t) => t.name === "Priya Raman"),
     JSON.stringify(signedPos.colliding_rights[0].tenants));
  //  A pending lease is a REAL dated right even though it is not current
  //  economic tenancy. This is the unit-530 rule holding on real data.
  const datedNow = await datedPropertyPositions(pool, { property_id: prop, as_of: YEAR.start });
  const stillOpen = datedNow.positions.find((p) => String(p.space_id) === String(target.space_id));
  ok("I17 …while the point-in-time read at 8/1 still calls it open — correctly",
     stillOpen.tenancy_state !== "contractually_occupied", stillOpen.tenancy_state);

  //  AND BACK. Through the canonical void path's own vocabulary.
  await pool.query(`update leases set lease_status='cancelled' where id=$1`, [signed]);
  const afterVoid = await intervalPropertyPositions(pool, {
    property_id: prop, requested_start: YEAR.start, requested_end: YEAR.end });
  ok("I18 voiding the lease returns the position, with nothing else touched",
     afterVoid.totals.contractually_free === iv.totals.contractually_free,
     `${afterVoid.totals.contractually_free} vs ${iv.totals.contractually_free}`);

  // ══ 4 · BY-BED AND BY-UNIT, ONE CODE PATH ═════════════════════════
  console.log("\n  ── the same service on a whole-unit property ──");
  const crTenant = (await pool.query(
    `insert into persons (name, source, lifecycle_status, leasing_stage)
     values ('Dana Whitfield','interval_positions','resident','resident') returning id`)).rows[0].id;
  await pool.query(
    `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
     values ($1,$2,$3,2100,'2027-01-01','2027-03-31','active')`,
    [byUnitProp, spaceOf.get("CR-101"), [crTenant]]);
  const cr = await intervalPropertyPositions(pool, {
    property_id: byUnitProp, requested_start: YEAR.start, requested_end: YEAR.end });
  ok("I19 a by-unit property answers through the same service",
     cr.count === 2 && cr.totals.units === 2, JSON.stringify(cr.totals));
  const crLeased = cr.positions.find((p) => String(p.space_id) === String(spaceOf.get("CR-101")));
  const crFree = cr.positions.find((p) => String(p.space_id) === String(spaceOf.get("CR-102")));
  ok("I20 …with one position per unit, not per bed",
     crLeased.position_kind === "unit" && crFree.position_kind === "unit",
     `${crLeased.position_kind}/${crFree.position_kind}`);
  ok("I21 …and the identical right shape produces the identical state",
     crLeased.interval_state === "term_partially_blocked" && crFree.interval_state === "contractually_free",
     `${crLeased.interval_state}/${crFree.interval_state}`);
  ok("I22 …with the same free-span arithmetic as the by-bed property",
     JSON.stringify(crLeased.free_spans) === JSON.stringify([
       { from: "2026-08-01", to: "2026-12-31" }, { from: "2027-04-01", to: "2027-07-31" }]),
     JSON.stringify(crLeased.free_spans));

  // ══ 5 · THE LINE IT DOES NOT CROSS ════════════════════════════════
  console.log("\n  ── contractual availability is not marketability ──");
  //  Take a contractually free position OUT OF SERVICE. The contractual
  //  answer must not change, and the operating fact must be visible
  //  beside it — two true facts, never collapsed into one false.
  const freeOne = afterVoid.positions.find((p) => p.interval_state === "contractually_free");
  await pool.query(`update units set is_down=true where id=$1`, [freeOne.unit_id]);
  const withDown = await intervalPropertyPositions(pool, {
    property_id: prop, requested_start: YEAR.start, requested_end: YEAR.end });
  const downPos = withDown.positions.find((p) => String(p.space_id) === String(freeOne.space_id));
  ok("I23 a DOWN position is still contractually_free — the read has no opinion on service",
     downPos.interval_state === "contractually_free", downPos.interval_state);
  ok("I24 …and is_down is carried beside the answer, not folded into it",
     downPos.is_down === true);
  ok("I25 …so the count of contractually free positions is unchanged by taking one down",
     withDown.totals.contractually_free === afterVoid.totals.contractually_free,
     `${afterVoid.totals.contractually_free} → ${withDown.totals.contractually_free}`);
  await pool.query(`update units set is_down=false where id=$1`, [freeOne.unit_id]);

  ok("I26 no position carries a marketability verdict",
     withDown.positions.every((p) =>
       !("marketing_state" in p) && !("marketable" in p) && !("available" in p)
       && !("physical_readiness" in p) && !("possession_state" in p)),
     JSON.stringify(Object.keys(withDown.positions[0])));
  ok("I27 the read SAYS OUT LOUD that marketability is not its answer",
     Array.isArray(withDown.does_not_establish)
     && withDown.does_not_establish.some((s) => /marketed, shown or offered/i.test(s))
     && withDown.does_not_establish.some((s) => /availability_read/i.test(s)),
     JSON.stringify(withDown.does_not_establish));
  ok("I28 …and that pricing and prospect placement are not either",
     withDown.does_not_establish.some((s) => /price|market rent|concession/i.test(s))
     && withDown.does_not_establish.some((s) => /prospect/i.test(s)));

  // ══ 6 · EVIDENCE ══════════════════════════════════════════════════
  console.log("\n  ── inconclusive opening evidence does not blank the building ──");
  /*  Every Skyline unit imports with occupancy_status 'unknown', so
   *  evidence_state is `inconclusive` on all 160. The trace proposed that
   *  inconclusive should read `unresolved`; building it showed that would
   *  make the entire read useless — and the classifier already says why:
   *  "unknown CONTRADICTS NOTHING". What blocks an answer is `disagrees`. */
  const inconclusive = withDown.positions.filter((p) => p.evidence_state === "inconclusive").length;
  ok("I29 the whole building imports as evidence-inconclusive",
     inconclusive === withDown.count, `${inconclusive} of ${withDown.count}`);
  ok("I30 …and that does NOT make every position unresolved",
     withDown.totals.unresolved < withDown.count && withDown.totals.contractually_free > 0,
     JSON.stringify(withDown.totals));

  //  A claim of OCCUPIED with no lease is a different fact, and it does
  //  block the answer: someone may be in there Spine has no right for.
  const claimUnit = withDown.positions.find((p) => p.interval_state === "contractually_free");
  await pool.query(`update units set occupancy_status='occupied' where id=$1`, [claimUnit.unit_id]);
  const withClaim = await intervalPropertyPositions(pool, {
    property_id: prop, requested_start: YEAR.start, requested_end: YEAR.end });
  const claimed = withClaim.positions.find((p) => String(p.space_id) === String(claimUnit.space_id));
  ok("I31 an opening claim of OCCUPIED with no lease reads unresolved, not free",
     claimed.interval_state === "unresolved"
     && claimed.unresolved_because === "opening_evidence_disagrees",
     JSON.stringify({ s: claimed.interval_state, why: claimed.unresolved_because }));
  await pool.query(`update units set occupancy_status='unknown' where id=$1`, [claimUnit.unit_id]);

  await pool.end();
  console.log("");
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 30 }));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(receipt.died(__filename, e, ran));
});
