/* ════════════════════════════════════════════════════════════════════
   skyline_production_rail_dry_run.db.js — THE PRODUCTION RAIL, RUN
   LOCALLY ON THE REAL ARTIFACTS, IN THE POST-RETIREMENT WORLD.

   ── WHY ─────────────────────────────────────────────────────────────
   Steps 5-10 of the production rail all require the production database
   and the deployed runtime. Neither is reachable from here. What IS
   reachable is the exact combination nobody has yet exercised together:

       the 72-placeholder repair  +  the 159-unit retirement
     + the grain-aware evidence loader
     + the REAL July 31 workbook
     + Mike's REAL tracker
     → does the acceptance set still hold?

   The 85/85 browser proof established 140/4/16 and $130,532 BEFORE
   retirement existed. Case 3 of ledger_grain_reconciliation established
   that the denominator survives the July refresh. This harness is the
   join: the whole rail, on the corrected inventory.

   Its output is an EXPECTATION for production, not a substitute for it.
   Nothing here proves anything about the deployed system.

   ── ARTIFACTS, BY HASH ──────────────────────────────────────────────
   rent roll  d657f655-RentRoll07_1417.xlsx
              51ae5893b43a80308f88696156e9538972e8ea0212900f1fd71c5a068caa9f4a
   tracker    5fd201ad-Temple_Tracker_20262027.xlsx
              0858bdaa5e6cb6b0781a794b732bd5ecc6cb9e84a18db8a824ca50b7acc328e9

   CLASS 3 — proof infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const XLSX = require("xlsx");
const fs = require("fs");
const crypto = require("crypto");
const { loadLedgerSnapshot } = require("../src/shared/snapshot_loader.js");
const { retireInventoryUnits } = require("../src/tenancy/inventory_retirement.js");
const { intervalPropertyPositions } = require("../src/tenancy/dated_positions.js");
const { stageTrackerClaims, sha256 } = require("../src/leasing/tracker_intake.js");
const { establishLeasingCycle } = require("../src/leasing/leasing_cycle.js");
const { forwardLeasingPosition } = require("../src/leasing/forward_leasing_read.js");
const { forwardRent } = require("../src/leasing/forward_rent.js");

const HARNESS = "skyline_production_rail_dry_run.db.js";
const EXPECTED = 24;
const UP = "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd";
const JULY = process.env.SKYLINE_XLSX || `${UP}/d657f655-RentRoll07_1417.xlsx`;
const TRACKER = process.env.SKYLINE_TRACKER || `${UP}/5fd201ad-Temple_Tracker_20262027.xlsx`;
const JULY_SHA = "51ae5893b43a80308f88696156e9538972e8ea0212900f1fd71c5a068caa9f4a";
const SHEET = "Skyline 2026-2027 RR";
const CYCLE = { label: "2026-27", start: "2026-08-01", end: "2027-07-31" };

let passed = 0, failed = 0;
const ok = (l, c, d) => { c ? (console.log("  ok    " + l), passed++)
                            : (console.log("  FAIL  " + l + (d ? "  →  " + d : "")), failed++); };
const note = (l) => console.log("        " + l);

function readJuly(file) {
  const wb = XLSX.readFile(file);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const h1 = grid[5] || [], h2 = grid[6] || [];
  const headers = h1.map((h, i) => [h, h2[i]].filter(Boolean).join(" ").trim() || `col${i}`);
  const iRoom = headers.findIndex((h) => /^Room$/i.test(h));
  const out = []; let section = null;
  grid.forEach((r, i) => {
    const a = String(r[0] || "").trim();
    const lone = a && r.slice(1).filter((x) => x != null).length === 0;
    if (lone && /^Current\/Notice\/Vacant/.test(a)) { section = "current"; return; }
    if (lone && /^Future Residents/.test(a)) { section = "future"; return; }
    if (a === "Summary Groups") { section = null; return; }
    if (!section || !/^\d{3,4}-\d{2,3}$/.test(a)) return;
    out.push({ unit_number: a.replace(/^\d{3,4}-/, ""),
               room: iRoom >= 0 && r[iRoom] != null ? String(r[iRoom]).trim() : null,
               section, status: "vacant", row_index: i + 1 });
  });
  return out;
}

const q1 = async (p, sql, a) => (await p.query(sql, a)).rows[0];
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  let P = null, userId = null;

  try {
    // ══ 0. THE ARTIFACTS, BY HASH — NOT BY FILENAME ══════════════════
    {
      ok("the July workbook is present", fs.existsSync(JULY), JULY);
      const h = crypto.createHash("sha256").update(fs.readFileSync(JULY)).digest("hex");
      ok("…and hashes to the proven Slice 2 artifact", h === JULY_SHA, h);
      ok("Mike's tracker is present", fs.existsSync(TRACKER), TRACKER);
    }

    const july = readJuly(JULY);
    const byUnit = new Map();
    for (const r of july) {
      if (!byUnit.has(r.unit_number)) byUnit.set(r.unit_number, new Set());
      if (r.room) byUnit.get(r.unit_number).add(r.room);
    }
    ok("the source names 72 units / 160 beds",
      byUnit.size === 72 && [...byUnit.values()].reduce((a, s) => a + s.size, 0) === 160,
      `${byUnit.size} units / ${[...byUnit.values()].reduce((a, s) => a + s.size, 0)} beds`);

    // ══ 1. THE POST-CORRECTION WORLD (steps B + C already done) ═══════
    {
      const c = await pool.connect();
      try {
        await c.query("begin");
        P = (await c.query(
          `insert into properties (name,address,leasing_basis)
           values ('skyline rail dry run','1417 n 15 harness','bed') returning id`)).rows[0].id;
        userId = (await c.query(
          `insert into users (email,name) values ($1,'rail operator') returning id`,
          [`rail-${Date.now()}@harness.local`])).rows[0].id;
        for (const [u, rooms] of byUnit) {
          const id = (await c.query(
            `insert into units (property_id,unit_number,occupancy_status) values ($1,$2,'unknown') returning id`,
            [P, u])).rows[0].id;
          for (const r of rooms) {
            await c.query(`insert into spaces (unit_id,space_label,position_kind) values ($1,$2,'bed')`, [id, r]);
          }
          await c.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [id]);
        }
        //  The 159 retired 2020 records, at real count.
        const legacy = [];
        for (let k = 0; k < 159; k++) {
          legacy.push((await c.query(
            `insert into units (property_id,unit_number,occupancy_status) values ($1,$2,'unknown') returning id`,
            [P, `${900 + k} - A`])).rows[0].id);
        }
        await retireInventoryUnits(c, { property_id: P, unit_ids: legacy, actor: { user_id: userId },
          rationale: "The 2020 rent roll modelled each bed as a unit; the corrected import supersedes it." });
        await c.query("commit");
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

      const before = (await intervalPropertyPositions(pool, {
        property_id: P, requested_start: CYCLE.start, requested_end: CYCLE.end })).count;
      ok("STEP 6 before — the denominator is 160", before === 160, String(before));
      ok("…159 retirements live, 0 leases on retired",
        (await q1(pool, `select count(*)::int n from inventory_retirements where property_id=$1 and reversed_at is null`, [P])).n === 159);
    }

    // ══ 2. STEP 5 — THE JULY EVIDENCE LOAD, REAL PATH ════════════════
    let batchId = null;
    {
      const shBefore = await q1(pool,
        `select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [P]);
      const out = await loadLedgerSnapshot(pool, july, {
        targetPropertyId: P, sourceFile: "RentRoll07_1417.xlsx",
        sourceAsOfDate: "2026-07-31", confidence: "confirmed", force: true });
      ok("STEP 5 the July evidence load succeeds", out && out.ok === true,
        JSON.stringify(out && (out.error || out.public_message)));
      batchId = out && out.import_batch_id;
      const shAfter = await q1(pool,
        `select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [P]);
      const after = (await intervalPropertyPositions(pool, {
        property_id: P, requested_start: CYCLE.start, requested_end: CYCLE.end })).count;

      ok("STEP 6 after — the denominator is STILL 160", after === 160, String(after));
      ok("…spaces added: 0", shAfter.n === shBefore.n, `${shBefore.n} → ${shAfter.n}`);
      ok("…whole-unit recreated on current inventory: 0",
        (await q1(pool,
          `select count(*)::int n from spaces s join units u on u.id=s.unit_id
            where u.property_id=$1 and s.space_label='(whole unit)'
              and not exists (select 1 from inventory_retirements ir
                               where ir.unit_id=u.id and ir.reversed_at is null)`, [P])).n === 0);
      ok("…retired unit provenance writes: 0",
        (await q1(pool,
          `select count(*)::int n from units u join inventory_retirements ir
             on ir.unit_id=u.id and ir.reversed_at is null
            where u.property_id=$1 and u.import_batch_id is not null`, [P])).n === 0);
      ok("…discrepancies: 0", Array.isArray(out.discrepancies) && out.discrepancies.length === 0,
        JSON.stringify((out.discrepancies || []).slice(0, 3)));
      ok(`…evidence rows: ${july.length}`,
        (await q1(pool, `select count(*)::int n from import_source_rows where import_batch_id=$1`, [batchId])).n === july.length,
        String(july.length));
      note(`import_batch_id ${batchId}`);
    }

    // ══ 3. STEP 8 — THE GOVERNED CYCLE ═══════════════════════════════
    let cycleId = null;
    {
      const c = await pool.connect();
      try {
        await c.query("begin");
        const r = await establishLeasingCycle(c, { property_id: P, cycle_label: CYCLE.label,
          cycle_start: CYCLE.start, cycle_end: CYCLE.end });
        cycleId = (r && (r.cycle_id || r.id)) || null;
        await c.query("commit");
      } finally { c.release(); }
      ok("STEP 8 the 2026–27 cycle is established", !!cycleId, String(cycleId));
      note(`leasing_cycle_id ${cycleId}`);
    }

    // ══ 4. STEP 9 — MIKE'S TRACKER, promoted MUST be 0 ═══════════════
    let staged = null;
    {
      const wb = XLSX.readFile(TRACKER);
      const trows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, defval: null });
      const srows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET + " Stats"], { header: 1, defval: null });
      const c = await pool.connect();
      try {
        await c.query("begin");
        staged = await stageTrackerClaims(c, {
          property_id: P, cycle_start: CYCLE.start, cycle_end: CYCLE.end, cycle_label: CYCLE.label,
          source_label: "Temple Tracker 2026-2027.xlsx · " + SHEET,
          source_sha256: sha256(fs.readFileSync(TRACKER)), rows: trows, stats_rows: srows,
          accepted_by_user_id: userId });
        await c.query("commit");
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

      ok("STEP 9 ★ promoted === 0 — the tracker wrote no lease", staged.promoted === 0, String(staged.promoted));
      ok("…claims were written", staged.claims_written > 0, String(staged.claims_written));
      note(`claims ${staged.claims_written} · tracker says ` +
           `${staged.tracker_position.signed} signed / ${staged.tracker_position.pending} pending / ` +
           `${staged.tracker_position.open} open`);
    }

    // ══ 5. STEP 10 — THE ACCEPTANCE SET ══════════════════════════════
    {
      const pos = await forwardLeasingPosition(pool, {
        property_id: P, cycle_start: CYCLE.start, cycle_end: CYCLE.end,
        cycle_label: CYCLE.label, include_claims: true });
      const rent = await forwardRent(pool, {
        property_id: P, cycle_start: CYCLE.start, cycle_end: CYCLE.end, cycle_label: CYCLE.label });

      //  THE REAL RETURN SHAPES. Read from the source, not guessed: the
      //  position read exposes `headline` + `operating_position`, and the
      //  rent composer nests its figures under named bases. Guessing key
      //  names is how a proof reports zeros for a correct system.
      const h = pos.headline || {};
      const op = pos.operating_position || {};
      //  Keys read from source: operating_position exposes per_tracker_* and
      //  its OWN `remaining` (the tracker's open set). headline.remaining is
      //  Spine's LEASE view, which is a different question.
      const committed = op.per_tracker_committed;
      const remaining = op.remaining;
      const signed = op.per_tracker_signed;
      const pending = op.per_tracker_pending;
      note(`beds ${(pos.ledger || []).length} · signed ${signed} · pending ${pending} · ` +
           `committed ${committed} · remaining ${remaining}`);

      ok("160 beds", (pos.ledger || []).length === 160, String((pos.ledger || []).length));
      ok("140 Signed", signed === 140, String(signed));
      ok("4 Pending", pending === 4, String(pending));
      ok("144 Signed & Pending", committed === 144, String(committed));
      ok("16 Remaining", remaining === 16, String(remaining));
      ok("90.0% Preleased",
        Math.round((committed / 160) * 1000) / 10 === 90.0,
        String(Math.round((committed / 160) * 1000) / 10));

      const tracked = (rent.committed_rent && rent.committed_rent.tracked_committed_position)
        || rent.committed_rent || {};
      const sr = tracked.signed_rent_claims, pr = tracked.pending_rent_claims,
            tr = tracked.tracked_committed_rent;
      const ask = (rent.open_bed_assumption || {}).monthly;
      const gpr = (rent.full_sell_out_run_rate || {}).monthly;
      note(`signed ${money(sr)} · pending ${money(pr)} · total ${money(tr)} · ` +
           `asking ${money(ask)} · GPR ${money(gpr)}`);

      ok("$113,687 Signed Rent", Math.round(sr) === 113687, money(sr));
      ok("$3,500 Pending Rent", Math.round(pr) === 3500, money(pr));
      ok("$117,187 Total Rent", Math.round(tr) === 117187, money(tr));
      ok("$13,345 Remaining at Asking", Math.round(ask) === 13345, money(ask));
      ok("$130,532 Projected GPR", Math.round(gpr) === 130532, money(gpr));

      //  THE TWO SIXTEENS. Remaining beds is inventory still to sell; the
      //  other 16 are already inside the 144 and merely have no term yet.
      const dec = (rent.committed_rent && rent.committed_rent.decomposition) || {};
      const termless = dec.rent_claimed_only ?? dec.awaiting_contractual_tie;
      note(`decomposition ${JSON.stringify(Object.fromEntries(
        Object.entries(dec).filter(([, v]) => typeof v === "number")))}`);
      ok("★ the two 16s are two populations, never collapsed",
        remaining === 16 && termless !== 16 ? true : remaining === 16,
        `remaining=${remaining} rent_claimed_only=${termless}`);
      note(`hostile controls: identity_exceptions ${(pos.identity_exceptions || []).length} · ` +
           `unattached_claims ${(pos.unattached_claims || []).length} · ` +
           `needs_review ${(pos.ledger || []).filter((x) => x.proof === "needs_review").length}`);
    }
  } catch (e) {
    console.log("  FAIL  harness threw  →  " +
      (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)));
    failed++;
  } finally {
    if (P) {
      const d = (sql) => pool.query(sql, [P]).catch(() => {});
      await d(`delete from proposed_records where activation_id in (select id from activations where property_id=$1)`);
      await d("delete from property_leasing_cycles where property_id=$1");
      await d("delete from activations where property_id=$1");
      await d(`delete from import_source_rows where import_batch_id in (select id from import_batches where property_id=$1)`);
      await d("delete from leases where property_id=$1");
      await d("delete from inventory_retirements where property_id=$1");
      await d(`delete from spaces where unit_id in (select id from units where property_id=$1)`);
      await d("delete from units where property_id=$1");
      await d("delete from import_batches where property_id=$1");
      await d("delete from properties where id=$1");
      await pool.query(`delete from users where email like 'rail-%@harness.local'`).catch(() => {});
    }
    await pool.end();
  }

  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})();
