/* ════════════════════════════════════════════════════════════════════
   inventory_retirement.db.js — 391 → 319 → 160, THROUGH THE CANONICAL
   READ, WITHOUT DELETING WHAT SPINE ONCE PROMOTED.

   ── WHAT PRODUCTION ACTUALLY CONTAINS ───────────────────────────────
   One real Skyline property holding two inventory representations:

     ingest_run 468a06d1 · deal_intake · source as-of 2020-03-30
       159 candidates, all promoted 2026-06-12, each modelling a BED
       ('101 - A', '101 - B') as a UNIT, before Spine had a by-bed model

     the 2026 import
       72 physical units · 160 beds — the correct representation

   The 159 are WRONG as current inventory and REAL as promotion history.
   `ingest_candidates.promoted_unit_id` returns 159 against them, and it is
   ON DELETE SET NULL — so deleting the units succeeds and silently nulls
   every pointer, leaving Spine asserting that a promotion happened while
   destroying the identity of what it produced. That is why this is a
   retirement and not a delete.

   ── THE THREE NUMBERS, AND WHOSE READ PRODUCES THEM ─────────────────
       391   before anything
       319   after the surplus-placeholder grain correction (72)
       160   after retiring the superseded 2020 representation (159)

   All three come from `intervalPropertyPositions` UNMODIFIED. The loader
   beneath it learned one general rule — retired inventory is not current
   inventory — and every reader above inherits it. No Skyline-specific
   read, no batch filter, no reader taught about a property.

   ── WHAT THIS ALSO REFUSES TO DO ────────────────────────────────────
   Retirement is not available as a way around tenancy: a unit still
   carrying a lease at any grain is refused, because retiring it would take
   a real lease position out of every current read. Proven, not promised.

   CLASS 3 — proof infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const {
  retireInventoryUnits, reinstateInventoryUnit, retirementProvenance,
  REASON_SUPERSEDED_GRAIN,
} = require("../src/tenancy/inventory_retirement.js");
const { intervalPropertyPositions, datedPropertyPositions } = require("../src/tenancy/dated_positions.js");

const HARNESS = "inventory_retirement.db.js";
const EXPECTED = 33;

const REAL_UNITS = 72, BEDS_TOTAL = 160, LEGACY_UNITS = 159;
const RATIONALE =
  "The 2020-03-30 rent roll modelled each bed as a unit; the 2026 import established " +
  "the actual 72-unit / 160-bed structure, which supersedes it.";

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log("  ok    " + label); passed++; }
  else { console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); failed++; }
};
const ivlCount = async (pool, propertyId) => (await intervalPropertyPositions(pool, {
  property_id: propertyId, requested_start: "2026-08-01", requested_end: "2027-07-31" })).count;

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  let propertyId = null, userId = null, batchId = null, runId = null;
  const legacyUnitIds = [];

  try {
    // ══ 1. BUILD PRODUCTION'S TWO REPRESENTATIONS ════════════════════
    {
      const c = await pool.connect();
      try {
        await c.query("begin");
        propertyId = (await c.query(
          `insert into properties (name, address, leasing_basis)
           values ('retirement harness', '1417 harness', 'bed') returning id`)).rows[0].id;
        userId = (await c.query(
          `insert into users (email, name) values ($1, 'harness operator') returning id`,
          [`retire-${Date.now()}@harness.local`])).rows[0].id;
        batchId = (await c.query(
          `insert into import_batches (property_id, source_type, source_file, status)
           values ($1, 'rent_roll_ledger', 'RentRoll07_1417.xlsx', 'committed') returning id`,
          [propertyId])).rows[0].id;

        //  THE CORRECT REPRESENTATION — 72 units, 160 beds, and (because
        //  the grain correction is a separate proof) the trigger's surplus
        //  placeholder still beside them, exactly as production has it.
        const beds = [];
        let remaining = BEDS_TOTAL;
        for (let i = 0; i < REAL_UNITS; i++) {
          const left = REAL_UNITS - i;
          const n = Math.min(3, Math.max(2, remaining - (left - 1) * 2));
          beds.push(n); remaining -= n;
        }
        for (let i = 0; i < REAL_UNITS; i++) {
          const u = (await c.query(
            `insert into units (property_id, unit_number, occupancy_status, import_batch_id)
             values ($1,$2,'unknown',$3) returning id`,
            [propertyId, String(101 + i), batchId])).rows[0].id;
          for (let b = 1; b <= beds[i]; b++) {
            await c.query(
              `insert into spaces (unit_id, space_label, position_kind, import_batch_id)
               values ($1,$2,'bed',$3)`, [u, "Room" + b, batchId]);
          }
        }

        //  THE 2020 REPRESENTATION — promoted through ingest_candidates, so
        //  the provenance this proof is about actually exists.
        runId = (await c.query(
          `insert into ingest_runs (property_id, kind, source_text, candidate_count)
           values ($1, 'deal_intake', $2, $3) returning id`,
          [propertyId, "Skyline rent roll, source as-of 2020-03-30", LEGACY_UNITS])).rows[0].id;
        for (let i = 0; i < LEGACY_UNITS; i++) {
          const label = `${100 + Math.floor(i / 3)} - ${"ABC"[i % 3]}`;
          const u = (await c.query(
            `insert into units (property_id, unit_number, occupancy_status)
             values ($1,$2,'unknown') returning id`, [propertyId, label])).rows[0].id;
          legacyUnitIds.push(u);
          await c.query(
            `insert into ingest_candidates
               (run_id, property_id, unit_number, decision_status, promoted_unit_id, promoted_at)
             values ($1,$2,$3,'promoted',$4,'2026-06-12')`, [runId, propertyId, label, u]);
        }
        await c.query("commit");
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

      ok(`the 2020 run promoted ${LEGACY_UNITS} bed-shaped records as units`,
        (await pool.query(
          `select count(*)::int n from ingest_candidates where run_id = $1 and decision_status = 'promoted'`,
          [runId])).rows[0].n === LEGACY_UNITS);
      ok("the property reads 391 positions — production's shape",
        await ivlCount(pool, propertyId) === BEDS_TOTAL + REAL_UNITS + LEGACY_UNITS,
        String(await ivlCount(pool, propertyId)));
    }

    // ══ 2. THE GRAIN CORRECTION GETS 391 → 319 ═══════════════════════
    //  Same predicate the repair tool uses; this proof is about the second
    //  step, so it does not re-prove the first one's refusals.
    {
      await pool.query(
        `delete from spaces where id in (
           select p.id from spaces p join units u on u.id = p.unit_id
            where u.property_id = $1 and p.space_label = '(whole unit)'
              and exists (select 1 from spaces s
                           where s.unit_id = u.id and s.space_label <> '(whole unit)'))`,
        [propertyId]);
      ok(`after the grain correction the canonical read returns ${BEDS_TOTAL + LEGACY_UNITS}`,
        await ivlCount(pool, propertyId) === BEDS_TOTAL + LEGACY_UNITS,
        String(await ivlCount(pool, propertyId)));
    }

    // ══ 3. THE WRITER REFUSES WHAT IT SHOULD ═════════════════════════
    {
      const attempt = async (args) => {
        const c = await pool.connect();
        try { await c.query("begin"); await retireInventoryUnits(c, args); await c.query("commit"); return null; }
        catch (e) { await c.query("rollback"); return e; } finally { c.release(); }
      };
      const base = { property_id: propertyId, unit_ids: legacyUnitIds.slice(0, 2),
                     rationale: RATIONALE, superseded_by_import_batch_id: batchId };

      ok("no actor → refused",
        (await attempt({ ...base }))?.code === "RETIREMENT_ACTOR_REQUIRED");
      ok("a rationale too short to be one → refused",
        (await attempt({ ...base, actor: { user_id: userId }, rationale: "old" }))?.code
          === "RETIREMENT_RATIONALE_REQUIRED");

      //  §21 — scope is derived, not accepted. Another property's unit is
      //  refused even though the caller asked nicely.
      const other = (await pool.query(
        `insert into properties (name, address) values ('other', 'elsewhere') returning id`)).rows[0].id;
      const otherUnit = (await pool.query(
        `insert into units (property_id, unit_number, occupancy_status)
         values ($1,'900','unknown') returning id`, [other])).rows[0].id;
      const foreign = await attempt({ ...base, unit_ids: [otherUnit], actor: { user_id: userId } });
      ok("a unit on another property → refused", foreign?.code === "UNIT_NOT_ON_PROPERTY", String(foreign?.code));
      ok("…and the refusal names the unit, not just the rule",
        /900/.test(String(foreign?.message)), String(foreign?.message).slice(0, 120));

      //  RETIREMENT IS NOT A BACK DOOR AROUND TENANCY.
      const leasedUnit = legacyUnitIds[0];
      const sp = (await pool.query(
        `insert into spaces (unit_id, space_label) values ($1,'(whole unit)') returning id`,
        [leasedUnit])).rows[0].id;
      await pool.query(
        `insert into leases (property_id, space_id, lease_status, start_date, end_date)
         values ($1,$2,'active','2026-08-01','2027-07-31')`, [propertyId, sp]);
      const leasedErr = await attempt({ ...base, unit_ids: [leasedUnit], actor: { user_id: userId } });
      ok("a unit still carrying a lease → refused", leasedErr?.code === "RETIREMENT_UNIT_CARRIES_LEASES",
        String(leasedErr?.code));
      ok("…and it says resolve the tenancy first",
        /Resolve the tenancy first/i.test(String(leasedErr?.message)));
      await pool.query("delete from leases where space_id = $1", [sp]);
      await pool.query("delete from spaces where id = $1", [sp]);
      await pool.query("delete from units where id = $1", [otherUnit]);
      await pool.query("delete from properties where id = $1", [other]);
    }

    // ══ 4. RETIRE, AND 319 → 160 THROUGH THE UNMODIFIED READ ═════════
    {
      const c = await pool.connect();
      let res;
      try {
        await c.query("begin");
        res = await retireInventoryUnits(c, {
          property_id: propertyId, unit_ids: legacyUnitIds,
          rationale: RATIONALE, superseded_by_import_batch_id: batchId,
          actor: { user_id: userId } });
        await c.query("commit");
      } finally { c.release(); }

      ok(`all ${LEGACY_UNITS} superseded units retired in one transaction`,
        res.retired === LEGACY_UNITS, String(res.retired));
      ok("the reason code is the governed one", res.reason_code === REASON_SUPERSEDED_GRAIN);
      ok("EXACTLY 160 through intervalPropertyPositions, unmodified",
        await ivlCount(pool, propertyId) === BEDS_TOTAL, String(await ivlCount(pool, propertyId)));
      ok("…and datedPropertyPositions agrees — the rule is in the loader, not in one reader",
        (await datedPropertyPositions(pool, { property_id: propertyId, as_of: "2026-09-01" })).count
          === BEDS_TOTAL);
    }

    // ══ 5. NOTHING WAS DELETED, AND THE LINEAGE STILL POINTS ═════════
    {
      const units = (await pool.query(
        `select count(*)::int n from units where property_id = $1`, [propertyId])).rows[0].n;
      ok(`all ${REAL_UNITS + LEGACY_UNITS} units still exist — retirement is not deletion`,
        units === REAL_UNITS + LEGACY_UNITS, String(units));

      const pointers = (await pool.query(
        `select count(*)::int n from ingest_candidates
          where run_id = $1 and promoted_unit_id is not null`, [runId])).rows[0].n;
      ok(`all ${LEGACY_UNITS} promotion receipts still point at what they created`,
        pointers === LEGACY_UNITS, String(pointers));

      const prov = await retirementProvenance(pool, { property_id: propertyId });
      ok("provenance is queryable, not just retained", prov.retired_now === LEGACY_UNITS,
        String(prov.retired_now));
      ok("…every retired unit's identity is preserved", prov.identity_preserved === true);
      ok("…every retirement still resolves to its original candidate", prov.lineage_intact === true);
      ok("…and it is attributable to the 2020 ingest run",
        prov.by_ingest_run.length === 1 && String(prov.by_ingest_run[0].run_id) === String(runId),
        JSON.stringify(prov.by_ingest_run));
      const one = prov.rows[0];
      ok("a retirement records WHO", String(one.retired_by_user_id) === String(userId));
      ok("…WHEN", !!one.retired_at);
      ok("…WHY, in words and not only a code",
        one.reason_code === REASON_SUPERSEDED_GRAIN && /supersedes/i.test(one.superseded_rationale));
      ok("…WHAT SUPERSEDES IT", String(one.superseded_by_import_batch_id) === String(batchId));
      ok("…and the original unit number, so the old representation is still readable",
        /^\d+ - [ABC]$/.test(one.original_unit_number), one.original_unit_number);
    }

    // ══ 6. THE UNIT CANNOT BE DELETED WHILE RETIRED ══════════════════
    //  ON DELETE RESTRICT, provoked. This is the guarantee that a claim
    //  cannot outlive its subject.
    {
      let code = null;
      try {
        await pool.query(`delete from spaces where unit_id = $1`, [legacyUnitIds[0]]);
        await pool.query(`delete from units where id = $1`, [legacyUnitIds[0]]);
      } catch (e) { code = e.code; }
      ok("deleting a retired unit is REFUSED BY THE DATABASE (23503)", code === "23503", String(code));
      const still = (await pool.query(
        `select count(*)::int n from units where id = $1`, [legacyUnitIds[0]])).rows[0].n;
      ok("…and the unit is still there", still === 1, String(still));
    }

    // ══ 7. REPLAY AND REVERSAL ═══════════════════════════════════════
    {
      const c = await pool.connect();
      let replay = null;
      try {
        await c.query("begin");
        await retireInventoryUnits(c, { property_id: propertyId, unit_ids: [legacyUnitIds[1]],
          rationale: RATIONALE, actor: { user_id: userId } });
        await c.query("commit");
      } catch (e) { await c.query("rollback"); replay = e; } finally { c.release(); }
      ok("retiring an already-retired unit is NAMED, not silently duplicated",
        replay?.code === "ALREADY_RETIRED", String(replay?.code));

      const c2 = await pool.connect();
      try {
        await c2.query("begin");
        await reinstateInventoryUnit(c2, { unit_id: legacyUnitIds[1], actor: { user_id: userId },
          reason: "reinstated by the proof to show the correction is reversible" });
        await c2.query("commit");
      } finally { c2.release(); }
      ok("a reinstated unit returns to the canonical read",
        await ivlCount(pool, propertyId) === BEDS_TOTAL + 1,
        String(await ivlCount(pool, propertyId)));
      const prov = await retirementProvenance(pool, { property_id: propertyId });
      ok("…and the reversal is kept as history rather than erasing the retirement",
        prov.reversed === 1 && prov.retired_now === LEGACY_UNITS - 1,
        `reversed=${prov.reversed} live=${prov.retired_now}`);

      //  Put it back so the closing number is the real one.
      const c3 = await pool.connect();
      try {
        await c3.query("begin");
        await retireInventoryUnits(c3, { property_id: propertyId, unit_ids: [legacyUnitIds[1]],
          rationale: RATIONALE, actor: { user_id: userId } });
        await c3.query("commit");
      } finally { c3.release(); }
      ok("re-retiring after a reversal is allowed, and lands back on 160",
        await ivlCount(pool, propertyId) === BEDS_TOTAL, String(await ivlCount(pool, propertyId)));
    }

    // ══ 8. THE RULE IS GENERAL ═══════════════════════════════════════
    {
      const fs = require("fs");
      const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      const loader = strip(fs.readFileSync("src/tenancy/space_position.js", "utf8"));
      const mod = strip(fs.readFileSync("src/tenancy/inventory_retirement.js", "utf8"));
      ok("the loader IMPORTS the predicate rather than restating it",
        /NOT_RETIRED_SQL/.test(loader) && !/inventory_retirements/.test(loader));
      ok("no property, address or import batch is hardcoded in the rule",
        !/14e41b7c|skyline|1417|468a06d1/i.test(mod + loader));
      ok("operating_use was not overloaded to mean retirement",
        !/operating_use/.test(mod));
    }
  } catch (e) {
    console.log("  FAIL  harness threw  →  " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)));
    failed++;
  } finally {
    if (propertyId) {
      const q = (s, p) => pool.query(s, p).catch(() => {});
      await q("delete from inventory_retirements where property_id = $1", [propertyId]);
      await q("delete from ingest_candidates where property_id = $1", [propertyId]);
      await q("delete from ingest_runs where property_id = $1", [propertyId]);
      await q("delete from leases where property_id = $1", [propertyId]);
      await q(`delete from spaces where unit_id in (select id from units where property_id = $1)`, [propertyId]);
      await q("delete from units where property_id = $1", [propertyId]);
      await q("delete from import_batches where property_id = $1", [propertyId]);
      await q("delete from properties where id = $1", [propertyId]);
      if (userId) await q("delete from users where id = $1", [userId]);
    }
    await pool.end();
  }

  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})();
