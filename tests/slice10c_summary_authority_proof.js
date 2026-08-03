#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  slice10c_summary_authority_proof.js — COMPLETE-PROPERTY SUMMARIES.
//  Synthetic disposable Postgres only. Every geometry is built to test a
//  withholding rule, not to make a total look good.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const { Pool } = require("pg");
const { forwardRentRollSummary } = require(path.join(__dirname, "..", "src/tenancy/forward_rent_roll_summary"));
const { datedPositionRows } = require(path.join(__dirname, "..", "src/tenancy/dated_position_rows"));

const CONN = process.env.HARNESS_DATABASE_URL;
if (!CONN) { console.error("need HARNESS_DATABASE_URL"); process.exit(1); }
if (CONN === process.env.DATABASE_URL) { console.error("HARNESS_DATABASE_URL must differ"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));
const TARGET = "2026-12-01";

(async () => {
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const c = await pool.connect();
  const one = async (q, a = []) => (await c.query(q, a)).rows[0];
  const P = {};
  try {
    await c.query("begin");
    const person = (await one(`insert into persons (name, lifecycle_status) values ('10C Synthetic','tenant') returning id`)).id;
    const user = (await one(`insert into users (name,email,phone,role,is_active,status)
      values ('10C User',$1,$2,'property_manager',true,'active') returning id`,
      [`c10-${Date.now()}@s.test`, "+1726" + String(Date.now()).slice(-7)])).id;

    const mkProp = async (name, tz) => (await one(
      `insert into properties (name, operating_timezone) values ($1,$2) returning id`, [name, tz === undefined ? "America/New_York" : tz])).id;
    const mkSpace = async (prop, num, use) => {
      const u = (await one(`insert into units (property_id, unit_number) values ($1,$2) returning id`, [prop, num])).id;
      const sp = (await c.query(`select id from spaces where unit_id=$1`, [u])).rows[0].id;
      if (use !== undefined) await c.query(
        `update spaces set use_type=$2, classified_by_user_id=$3, classified_at=now(), classification_source='proof' where id=$1`,
        [sp, use, user]);
      return sp;
    };
    const mkLease = (prop, sp, start, end, status, rent) => c.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,$3,$4,$5,$6,$7)`, [prop, sp, [person], rent, start, end, status]);
    const offerFor = async (prop) => (await one(
      `insert into lease_offers (property_id, person_id, status, source, scope, offered_terms_snapshot,
         authority_basis_snapshot, granted_by_person_id)
       values ($1,$2,'draft','discretionary','property','{}'::jsonb,'{}'::jsonb,$3) returning id`, [prop, person, person])).id;
    const mkSched = async (prop, sp, off, lines) => {
      const a = (await one(`insert into lease_applications (property_id, person_id, status) values ($1,$2,'approved') returning id`, [prop, person])).id;
      const s = (await one(`insert into lease_economic_schedules (property_id, application_id, space_id, status,
        source_offer_id, locked_by_person_id) values ($1,$2,$3,'locked',$4,$5) returning id`, [prop, a, sp, off, person])).id;
      for (const [ym, type, amt] of lines) await c.query(
        `insert into lease_economic_lines (schedule_id, effective_month, line_type, amount) values ($1,$2::date,$3,$4)`,
        [s, ym + "-01", type, amt]);
      return s;
    };

    // ── CLEAN: every position governed on both dates ──
    P.clean = await mkProp("10C Clean");
    { const off = await offerFor(P.clean);
      for (const n of ["1", "2", "3"]) {
        const sp = await mkSpace(P.clean, "R" + n, "residential");
        await mkLease(P.clean, sp, "2026-01-01", "2027-12-31", "active", 1000);
        await mkSched(P.clean, sp, off, [["2026-08", "base_rent", 1000], ["2026-12", "base_rent", 1200]]);
      }
      const cm = await mkSpace(P.clean, "C1", "commercial");
      await mkLease(P.clean, cm, "2026-01-01", "2027-12-31", "active", 5000);
      await mkSched(P.clean, cm, off, [["2026-08", "base_rent", 5000], ["2026-12", "base_rent", 5000]]);
      const nr = await mkSpace(P.clean, "N1", "non_revenue");   // excluded from denominator
      await mkLease(P.clean, nr, "2026-01-01", "2027-12-31", "active", 1);
    }

    // ── UNKNOWN use_type withholds the RATE but not the counts ──
    P.unknownUse = await mkProp("10C Unknown Use");
    { const off = await offerFor(P.unknownUse);
      const a = await mkSpace(P.unknownUse, "R1", "residential");
      await mkLease(P.unknownUse, a, "2026-01-01", "2027-12-31", "active", 1000);
      await mkSched(P.unknownUse, a, off, [["2026-12", "base_rent", 1000]]);
      const b = await mkSpace(P.unknownUse, "U1", null);        // unclassified
      await mkLease(P.unknownUse, b, "2026-01-01", "2027-12-31", "active", 1000);
      await mkSched(P.unknownUse, b, off, [["2026-12", "base_rent", 1000]]);
    }

    // ── OVERLAP withholds the rate via the numerator ──
    P.overlap = await mkProp("10C Overlap");
    { const off = await offerFor(P.overlap);
      const a = await mkSpace(P.overlap, "R1", "residential");
      await mkLease(P.overlap, a, "2026-01-01", "2027-12-31", "active", 1000);
      await mkLease(P.overlap, a, "2026-06-01", "2027-05-31", "active", 2000);   // overlaps
      await mkSched(P.overlap, a, off, [["2026-12", "base_rent", 1000]]);
    }

    // ── MISSING economics withholds the rent total only ──
    P.missingEcon = await mkProp("10C Missing Econ");
    { const off = await offerFor(P.missingEcon);
      const a = await mkSpace(P.missingEcon, "R1", "residential");
      await mkLease(P.missingEcon, a, "2026-01-01", "2027-12-31", "active", 1000);
      await mkSched(P.missingEcon, a, off, [["2026-12", "base_rent", 1000]]);
      const b = await mkSpace(P.missingEcon, "R2", "residential");
      await mkLease(P.missingEcon, b, "2026-01-01", "2027-12-31", "active", null);  // no rent at all
    }

    // ── QUALIFIED LEGACY, disclosed ──
    P.legacy = await mkProp("10C Legacy");
    { const a = await mkSpace(P.legacy, "R1", "residential");
      await mkLease(P.legacy, a, TARGET, "2027-12-31", "active", 1400);   // starts in target month
    }

    // ── ZERO positions, and NO timezone ──
    P.empty = await mkProp("10C Empty");
    P.noTz = await mkProp("10C No TZ", null);

    // ── NEIGHBOUR noise ──
    P.neighbour = await mkProp("10C Neighbour");
    { const n = await mkSpace(P.neighbour, "X1", "residential");
      await mkLease(P.neighbour, n, "2026-01-01", "2027-12-31", "active", 9999); }
    await c.query("commit");
  } catch (e) { await c.query("rollback"); c.release(); await pool.end(); throw e; }
  c.release();

  const S = async (pid) => forwardRentRollSummary(pool, { property_id: pid, as_of: TARGET });
  console.log("\n════ SLICE 10C — SUMMARY AUTHORITY (synthetic only) ════");

  section("A  position counts and reconciliation");
  const clean = await S(P.clean);
  const pc = clean.summary.positions;
  ok("total counts every canonical position", pc.total_canonical_positions === 5);
  ok("revenue excludes non_revenue", pc.revenue === 4 && pc.non_revenue === 1);
  ok("residential and commercial are broken out", pc.residential_revenue === 3 && pc.commercial_revenue === 1);
  ok("revenue + non_revenue + unknown = total", pc.reconciles === true);

  section("B  occupancy — published only when nothing is withheld");
  const occT = clean.summary.occupancy.target;
  ok("a fully governed property publishes a rate", occT.state === "published" && occT.rate !== null);
  ok("the denominator is the revenue set, not all positions", occT.revenue_denominator === 4);
  ok("occupied + unoccupied = revenue denominator", occT.reconciles === true);
  ok("non_revenue never enters the denominator", occT.revenue_denominator === pc.revenue);

  const unk = await S(P.unknownUse);
  ok("one unknown use_type WITHHOLDS the rate", unk.summary.occupancy.target.state === "withheld"
    && unk.summary.occupancy.target.rate === null);
  ok("and names the denominator axis",
    unk.summary.occupancy.target.blockers.some((b) => b.code === "unknown_denominator" && b.affects.includes("denominator")));
  ok("but the position counts remain published",
    unk.summary.positions.total_canonical_positions === 2 && unk.summary.positions.unknown_denominator === 1);
  ok("no denominator is published while withheld", unk.summary.occupancy.target.revenue_denominator === null);

  const ov = await S(P.overlap);
  ok("an admitted-lease overlap WITHHOLDS the rate", ov.summary.occupancy.target.state === "withheld");
  ok("and names the NUMERATOR axis",
    ov.summary.occupancy.target.blockers.some((b) => b.code === "occupancy_conflict" && b.affects.includes("numerator")));
  ok("the conflicted position is counted as conflict, not as occupied",
    ov.summary.occupancy.target.occupancy_conflict_positions === 1
    && ov.summary.occupancy.target.contracted_occupied_positions === 0);

  section("C  contractual rent — subtotals, totals, disclosure");
  const rentT = clean.summary.contractual_rent.target;
  ok("a fully dated property publishes a combined total", rentT.state === "published");
  ok("dated subtotal is the December step (3x1200 + 5000)", rentT.dated_authority_subtotal === 8600);
  ok("dated + legacy = combined, no residual", rentT.reconciles === true && rentT.combined_total === 8600);
  ok("and discloses that no legacy is included", rentT.includes_qualified_legacy === false);

  const leg = await S(P.legacy);
  const lr = leg.summary.contractual_rent.target;
  ok("a qualified legacy amount lands in its OWN subtotal",
    lr.qualified_legacy_subtotal === 1400 && lr.dated_authority_subtotal === 0);
  ok("and the combined total DISCLOSES that it includes legacy",
    lr.state === "published" && lr.includes_qualified_legacy === true);

  const me = await S(P.missingEcon);
  ok("missing economics WITHHOLDS the combined total",
    me.summary.contractual_rent.target.state === "withheld" && me.summary.contractual_rent.target.combined_total === null);
  ok("but the supported subtotal remains visible because it is independently true",
    me.summary.contractual_rent.target.dated_authority_subtotal === 1000);
  ok("and the blocker names the rent axis",
    me.summary.contractual_rent.target.blockers.some((b) => b.code === "missing_economics" && b.affects.includes("rent")));
  ok("a withheld rent total does not withhold occupancy",
    me.summary.occupancy.target.state === "published");

  section("D  current-to-target changes, from two governed reads");
  ok("a dated step is a rent increase with both authorities named",
    clean.summary.changes.rent_increases.count === 3
    && clean.summary.changes.rent_increases.sample.every((x) => x.from_authority && x.to_authority));
  //  TWO unchanged, not one: the commercial position (5000 on both dates) and
  //  the non_revenue position, which carries a legacy amount and still appears
  //  in changes because changes span every canonical position, not only the
  //  revenue denominator.
  ok("unchanged amounts are counted across ALL canonical positions, not just revenue",
    clean.summary.changes.unchanged_contractual_rent === 2);
  ok("no renewal or move-in is inferred from a rent difference",
    clean.summary.changes.contractual_starts.count === 0 && clean.summary.changes.newly_occupied.count === 0);
  ok("a conflicted side is unresolved rather than given a direction",
    ov.summary.changes.unresolved.count >= 1 && ov.summary.changes.rent_increases.count === 0);

  section("E  zero-result behaviour is not collapsed");
  const empty = await S(P.empty);
  ok("an empty property is no_qualifying_result, NOT unavailable",
    empty.state === "ok" && empty.result_state === "no_qualifying_result");
  ok("and its occupancy side is empty, not withheld",
    empty.summary.occupancy.target.state === "empty" && empty.summary.occupancy.target.rate === null);
  const noTz = await S(P.noTz);
  ok("a property with no operating day is authority_missing",
    noTz.result_state === "authority_missing" && noTz.summary === null);
  ok("authority_missing is distinct from no_qualifying_result",
    noTz.result_state !== empty.result_state);

  section("F  scope, cost, writes");
  ok("no neighbouring-property position appears",
    !clean.rows.some((r) => r.unit_number === "X1"));
  let n = 0;
  const counting = { query: (...a) => { n++; return pool.query(...a); }, connect: (...a) => pool.connect(...a), totalCount: pool.totalCount };
  await forwardRentRollSummary(counting, { property_id: P.clean, as_of: TARGET });
  const rowOnly = { n: 0 };
  await datedPositionRows({ query: (...a) => { rowOnly.n++; return pool.query(...a); }, connect: (...a) => pool.connect(...a), totalCount: pool.totalCount },
    { property_id: P.clean, as_of: TARGET });
  console.log(`   OBSERVED  row engine ${rowOnly.n} queries; summary ${n} queries (two dated sides)`);
  ok("the summary adds NO per-row query — it is two dated reads and nothing else",
    n === rowOnly.n * 2);
  const before = await pool.query("select (select count(*) from leases) l, (select count(*) from obligations) o");
  await S(P.clean);
  const after = await pool.query("select (select count(*) from leases) l, (select count(*) from obligations) o");
  ok("the summary writes nothing",
    before.rows[0].l === after.rows[0].l && before.rows[0].o === after.rows[0].o);

  console.log(`\n════ summary authority: ${pass} passed, ${fail} failed ════\n`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("PROOF CRASHED: " + e.message); console.error(e.stack.split("\n").slice(1, 4).join("\n")); process.exit(1); });
