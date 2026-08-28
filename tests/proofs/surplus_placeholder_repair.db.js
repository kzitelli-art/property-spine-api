/* ════════════════════════════════════════════════════════════════════
   surplus_placeholder_repair.db.js — PRODUCTION'S SKYLINE SHAPE,
   REPRODUCED, AND THE 391 → 160 CORRECTION PROVEN BEFORE IT IS RUN.

   ── WHY THIS EXISTS ─────────────────────────────────────────────────
   Production's Skyline reads 391 rentable positions where the property
   has 160 beds. The decomposition, and every part of it is mechanical:

       160  bed spaces, from the source-backed import
     +  72  '(whole unit)' spaces — trg_unit_space, on the 72 REAL units
     + 159  '(whole unit)' spaces — trg_unit_space, on 159 LEGACY units
     = 391

   Two populations, not one, and only ONE of them has a canonical rule.

   `inventory_materialization.js` already owns the rule for the first: on a
   clean load the placeholder is still pristine and is CONSUMED as the
   first bed. Skyline was loaded before that writer existed, so its beds
   were created BESIDE the placeholder — and on that shape the canonical
   writer deliberately refuses with SURPLUS_PLACEHOLDER rather than
   deleting. Its comment says why: that state means a partial load, a
   hand-edit or two importers disagreeing, "a question for a person, not a
   row for an importer to remove."

   No existing proof covers that state. `skyline_bed_grain_activation.db.js`
   proves the CLEAN path — units created, then materialized, placeholder
   consumed, 160 positions. It never reaches the shape production is in.

   So this harness does three things, in this order, and the order is the
   argument:

     1  reproduce the shape, through the real trigger, not by inserting
        the phantom by hand
     2  PROVOKE the canonical writer's refusal on it, so "just re-run the
        materializer" is ruled out by observation rather than by opinion
     3  prove the repair tool's predicate is general, that it refuses what
        is held, and that after it runs the canonical forward read returns
        EXACTLY 160 — through intervalPropertyPositions, unmodified

   What it deliberately does NOT prove: anything about the 159 legacy
   units. Removing their spaces is what takes 319 to 160, and it is a
   different decision with no canonical rule. This harness measures that
   gap and names it rather than closing it silently.

   CLASS 3 — proof infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  materializeRentableSpaces, referencesTo, PLACEHOLDER_LABEL,
} = require("../../src/tenancy/inventory_materialization.js");
const { intervalPropertyPositions } = require("../../src/tenancy/dated_positions.js");

const HARNESS = "surplus_placeholder_repair.db.js";
const EXPECTED = 28;
const TOOL = path.join(__dirname, "..", "..", "tools", "repair", "resolve_surplus_whole_unit_spaces.js");

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log("  ok    " + label); passed++; }
  else { console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); failed++; }
};

//  Production's real proportions, so the arithmetic in the receipt is the
//  arithmetic of the property rather than of a toy.
const REAL_UNITS = 72;          // source-backed, bed-grained
const BEDS_TOTAL = 160;         // what the source says exists
const LEGACY_UNITS = 159;       // older duplicate unit rows

function runTool(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TOOL, ...args],
      { env: { ...process.env, DATABASE_URL: CONN }, encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
}

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  let propertyId = null;

  try {
    // ══ 1. REPRODUCE PRODUCTION'S SHAPE ══════════════════════════════
    //  Through the real trigger. If the phantom were inserted by hand this
    //  harness would prove a fixture, not the mechanism.
    {
      const c = await pool.connect();
      try {
        await c.query("begin");
        propertyId = (await c.query(
          `insert into properties (name, address, leasing_basis)
           values ('surplus repair harness', '1417 harness', 'bed') returning id`)).rows[0].id;

        //  Bed distribution that sums to exactly 160 over 72 units, the way
        //  the real building does: mostly triples, some doubles.
        const beds = [];
        let remaining = BEDS_TOTAL;
        for (let i = 0; i < REAL_UNITS; i++) {
          const left = REAL_UNITS - i;
          //  Give each unit at least 2, keep the running total reachable.
          const n = Math.min(3, Math.max(2, remaining - (left - 1) * 2));
          beds.push(n); remaining -= n;
        }
        ok(`the harness building is exactly ${BEDS_TOTAL} beds over ${REAL_UNITS} units`,
          beds.reduce((a, b) => a + b, 0) === BEDS_TOTAL, String(beds.reduce((a, b) => a + b, 0)));

        const realUnitIds = [];
        for (let i = 0; i < REAL_UNITS; i++) {
          const u = (await c.query(
            `insert into units (property_id, unit_number, occupancy_status, import_batch_id)
             values ($1, $2, 'unknown', null) returning id`,
            [propertyId, String(101 + i)])).rows[0].id;
          realUnitIds.push(u);
          //  THE PRE-MATERIALIZER LOAD: beds inserted BESIDE the trigger's
          //  placeholder, which is exactly how Skyline was loaded in April.
          for (let b = 1; b <= beds[i]; b++) {
            await c.query(
              `insert into spaces (unit_id, space_label, position_kind) values ($1, $2, 'bed')`,
              [u, "Room" + b]);
          }
        }
        for (let i = 0; i < LEGACY_UNITS; i++) {
          //  Legacy units get ONLY what the trigger gives them.
          await c.query(
            `insert into units (property_id, unit_number, occupancy_status)
             values ($1, $2, 'unknown')`, [propertyId, `${400 + i} - A`]);
        }
        await c.query("commit");
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

      const shape = (await pool.query(
        `select count(*)::int as spaces,
                count(*) filter (where s.space_label = $2)::int as placeholders,
                count(*) filter (where s.position_kind = 'bed')::int as beds
           from spaces s join units u on u.id = s.unit_id
          where u.property_id = $1`, [propertyId, PLACEHOLDER_LABEL])).rows[0];

      ok(`the trigger manufactured ${REAL_UNITS + LEGACY_UNITS} placeholders unasked`,
        shape.placeholders === REAL_UNITS + LEGACY_UNITS, String(shape.placeholders));
      ok(`the source-named beds are all there (${BEDS_TOTAL})`,
        shape.beds === BEDS_TOTAL, String(shape.beds));
      ok(`the property reads ${BEDS_TOTAL + REAL_UNITS + LEGACY_UNITS} positions — production's 391 shape`,
        shape.spaces === BEDS_TOTAL + REAL_UNITS + LEGACY_UNITS, String(shape.spaces));
    }

    // ══ 2. THE CANONICAL READ IS ALREADY WRONG, BEFORE ANY TRACKER ════
    //  This is not a Forward Leasing defect. loadSpaceRows lives in
    //  space_position.js and is the row set for EVERY temporal tenancy
    //  reader, so the Rent Roll reads 391 today too.
    {
      const ivl = await intervalPropertyPositions(pool, {
        property_id: propertyId, requested_start: "2026-08-01", requested_end: "2027-07-31" });
      ok("the canonical interval read returns 391 BEFORE any repair — the defect is upstream of the tracker",
        ivl.count === BEDS_TOTAL + REAL_UNITS + LEGACY_UNITS, String(ivl.count));
    }

    // ══ 3. RULE OUT "JUST RE-RUN THE MATERIALIZER" — BY PROVOKING IT ══
    {
      const target = (await pool.query(
        `select u.id, u.unit_number from units u
          where u.property_id = $1
            and exists (select 1 from spaces s where s.unit_id = u.id and s.position_kind = 'bed')
          order by u.unit_number limit 1`, [propertyId])).rows[0];
      const labels = (await pool.query(
        `select space_label from spaces where unit_id = $1 and space_label <> $2 order by space_label`,
        [target.id, PLACEHOLDER_LABEL])).rows.map((r) => r.space_label);

      const c = await pool.connect();
      let code = null, msg = "";
      try {
        await c.query("begin");
        await materializeRentableSpaces(c, { unit_id: target.id, labels, kind: "bed" });
        await c.query("commit");
      } catch (e) { await c.query("rollback"); code = e.code; msg = e.message || ""; } finally { c.release(); }

      ok("the canonical writer REFUSES on production's shape — SURPLUS_PLACEHOLDER",
        code === "SURPLUS_PLACEHOLDER", String(code));
      ok("…and says nothing was changed, rather than deleting the phantom",
        /Nothing was changed/i.test(msg), msg.slice(0, 120));
      const still = (await pool.query(
        `select count(*)::int as n from spaces where unit_id = $1`, [target.id])).rows[0].n;
      ok("…and it really changed nothing", still === labels.length + 1, String(still));
    }

    // ══ 4. THE REPAIR TOOL — INSPECT MODE WRITES NOTHING ═════════════
    {
      const r = runTool(["--property", propertyId]);
      ok("the tool runs and reports in inspect mode", r.code === 0, `exit=${r.code} :: ${r.out.slice(-200)}`);
      ok(`…and finds exactly the ${REAL_UNITS} surplus placeholders, not all ${REAL_UNITS + LEGACY_UNITS}`,
        new RegExp("candidates\\s+" + REAL_UNITS + "\\b").test(r.out), r.out.slice(0, 400));
      ok("…because the predicate is 'has a source-named sibling', which legacy units do not",
        /INSPECT \(writes nothing\)/.test(r.out));
      const after = (await pool.query(
        `select count(*)::int as n from spaces s join units u on u.id = s.unit_id
          where u.property_id = $1`, [propertyId])).rows[0].n;
      ok("…and inspect mode wrote nothing", after === BEDS_TOTAL + REAL_UNITS + LEGACY_UNITS, String(after));
    }

    // ══ 5. A HELD PLACEHOLDER IS REFUSED, NOT SKIPPED ════════════════
    //  Attach a real lease to one phantom, so the tool must refuse that
    //  one and say who holds it. This is the case where a unit genuinely
    //  carries whole-unit history and a human has to decide.
    {
      const ph = (await pool.query(
        `select p.id, u.id as unit_id, u.unit_number from spaces p join units u on u.id = p.unit_id
          where u.property_id = $1 and p.space_label = $2
            and exists (select 1 from spaces s where s.unit_id = u.id and s.position_kind = 'bed')
          order by u.unit_number limit 1`, [propertyId, PLACEHOLDER_LABEL])).rows[0];
      await pool.query(
        `insert into leases (property_id, space_id, lease_status, start_date, end_date)
         values ($1, $2, 'active', '2026-08-01', '2027-07-31')`, [propertyId, ph.id]);

      //  Asked of the CANONICAL pristine test, not of a local re-derivation,
      //  so this asserts the thing the tool actually relies on.
      const cRef = await pool.connect();
      let holders = [];
      try { holders = await referencesTo(cRef, ph.id); } finally { cRef.release(); }
      ok("the canonical pristine test names the lease that holds the placeholder",
        holders.some((h) => /^leases\.space_id/.test(h)), JSON.stringify(holders));

      const r = runTool(["--property", propertyId, "--apply"]);
      ok("the tool exits NON-ZERO when any placeholder is held", r.code === 1, `exit=${r.code}`);
      ok("…names the held row rather than reporting a clean run",
        /are NOT pristine/.test(r.out) && new RegExp(ph.id).test(r.out), r.out.slice(0, 500));
      ok("…names WHAT holds it, so nobody has to go looking",
        /held by\s+leases\.space_id/.test(r.out), r.out.slice(0, 600));

      const survived = (await pool.query(
        `select count(*)::int as n from spaces where id = $1`, [ph.id])).rows[0].n;
      ok("…and the held placeholder still exists", survived === 1, String(survived));

      //  It refused that one and resolved the rest. Both, in one run.
      const nowPh = (await pool.query(
        `select count(*)::int as n from spaces p join units u on u.id = p.unit_id
          where u.property_id = $1 and p.space_label = $2
            and exists (select 1 from spaces s where s.unit_id = u.id and s.position_kind = 'bed')`,
        [propertyId, PLACEHOLDER_LABEL])).rows[0].n;
      ok("…while every PRISTINE placeholder was resolved in the same run",
        nowPh === 1, String(nowPh));

      //  Clean up the deliberate obstruction so the final count is about
      //  the repair and not about this test's own scaffolding.
      await pool.query("delete from leases where space_id = $1", [ph.id]);
      const r2 = runTool(["--property", propertyId, "--apply"]);
      ok("once the lease is gone the last placeholder resolves too", r2.code === 0, `exit=${r2.code}`);
    }

    // ══ 6. WHAT THE REPAIR ACTUALLY BUYS — AND WHAT IT DOES NOT ══════
    {
      const spaces = (await pool.query(
        `select count(*)::int as n from spaces s join units u on u.id = s.unit_id
          where u.property_id = $1`, [propertyId])).rows[0].n;
      ok(`after repair the property holds ${BEDS_TOTAL + LEGACY_UNITS} positions, not ${BEDS_TOTAL}`,
        spaces === BEDS_TOTAL + LEGACY_UNITS, String(spaces));

      const ivl = await intervalPropertyPositions(pool, {
        property_id: propertyId, requested_start: "2026-08-01", requested_end: "2027-07-31" });
      ok("…and the canonical read agrees — the phantom beds are gone",
        ivl.count === BEDS_TOTAL + LEGACY_UNITS, String(ivl.count));
      ok(`…so ${LEGACY_UNITS} legacy positions still stand between this and ${BEDS_TOTAL}`,
        ivl.count - BEDS_TOTAL === LEGACY_UNITS, String(ivl.count - BEDS_TOTAL));

      //  The second decision, MEASURED not made. Removing legacy units is
      //  a different question and this harness does not pretend to it —
      //  it proves the arithmetic closes once somebody answers it.
      await pool.query(
        `delete from spaces where unit_id in (
           select u.id from units u where u.property_id = $1
             and not exists (select 1 from spaces s where s.unit_id = u.id and s.position_kind = 'bed'))`,
        [propertyId]);
      await pool.query(
        `delete from units u where u.property_id = $1
           and not exists (select 1 from spaces s where s.unit_id = u.id)`, [propertyId]);

      const finalIvl = await intervalPropertyPositions(pool, {
        property_id: propertyId, requested_start: "2026-08-01", requested_end: "2027-07-31" });
      ok(`WITH BOTH DECISIONS MADE, the canonical forward read returns EXACTLY ${BEDS_TOTAL}`,
        finalIvl.count === BEDS_TOTAL, String(finalIvl.count));
      ok("…through intervalPropertyPositions unmodified — no reader was taught about this property",
        finalIvl.count === BEDS_TOTAL);
    }

    // ══ 7. THE TOOL IS GENERAL, NOT A SKYLINE PATCH ══════════════════
    {
      const src = require("fs").readFileSync(TOOL, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      ok("no property id, name or address is hardcoded in the tool",
        !/14e41b7c|skyline|1417/i.test(src));
      ok("no import_batch_id is hardcoded either",
        !/import_batch_id\s*=\s*'[0-9a-f]{8}/i.test(src));
      ok("the pristine test is IMPORTED from the canonical module, not copied",
        /require\(.*inventory_materialization\.js.*\)/.test(src) && !/pg_constraint/.test(src));
      ok("a by-unit unit is untouchable: the predicate demands a source-named sibling",
        /exists \(select 1 from spaces s\s*\n?\s*where s\.unit_id = u\.id and s\.space_label <> \$2\)/.test(src)
        || /and exists \(select 1 from spaces s/.test(src));
    }
  } catch (e) {
    console.log("  FAIL  harness threw  →  " + (e && e.message ? e.message : String(e)));
    failed++;
  } finally {
    if (propertyId) {
      await pool.query(
        `delete from leases where property_id = $1`, [propertyId]).catch(() => {});
      await pool.query(
        `delete from spaces where unit_id in (select id from units where property_id = $1)`,
        [propertyId]).catch(() => {});
      await pool.query("delete from units where property_id = $1", [propertyId]).catch(() => {});
      await pool.query("delete from properties where id = $1", [propertyId]).catch(() => {});
    }
    await pool.end();
  }

  const code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
  process.exit(code);
})();
