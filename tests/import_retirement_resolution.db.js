/* ════════════════════════════════════════════════════════════════════
   import_retirement_resolution.db.js — A FRESH SOURCE MAY NEVER WRITE
   TENANCY TO RETIRED INVENTORY, AND MAY NEVER DIE ON THE TRIGGER.

   ── THE EXACT CASE ──────────────────────────────────────────────────
       retired 2020 unit '101 - A'   exists, superseded
       correct current unit '101'    exists, with Room1/Room2/Room3
       fresh July-31-shaped source   arrives
   ↓
   Either it resolves to the CURRENT canonical position through the normal
   grain reconciliation, or it REFUSES VISIBLY. It may never write tenancy
   to the retired unit, and it may never reach the database trigger as
   ordinary control flow.

   ── WHY THE TRIGGER IS NOT THE ANSWER ───────────────────────────────
   `trg_refuse_lease_on_retired_inventory` is the last wall and it works,
   but walking into it mid-import turns a reconciliation question into a
   raw 23514 from inside a loop — a 500 where a person needed a sentence.
   Worse, the resolver reached it only AFTER re-stamping the retired unit
   with the fresh import_batch_id, source_type and as-of date, laundering a
   superseded representation into looking source-backed.

   So resolution asks for CURRENT inventory, and the refusal happens in a
   PRE-FLIGHT before any write.

   ── WHAT THIS IS NOT ────────────────────────────────────────────────
   Not a multi-version rent-roll subsystem. A fresh source entering
   existing governance: source artifacts, import attribution, person
   ingress, inventory materialization and the tenancy anchor already exist
   and are untouched. This adds one refusal and one predicate import.

   CLASS 3 — proof infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const { retireInventoryUnits } = require("../src/tenancy/inventory_retirement.js");
const { intervalPropertyPositions } = require("../src/tenancy/dated_positions.js");
const loader = require("../src/shared/snapshot_loader.js");

const HARNESS = "import_retirement_resolution.db.js";
const EXPECTED = 23;

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log("  ok    " + label); passed++; }
  else { console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); failed++; }
};

const RATIONALE =
  "The 2020 rent roll modelled each bed as a unit; the corrected import established " +
  "the real unit/bed structure, which supersedes it.";

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  let propertyId = null, userId = null;

  //  The loader's internals are module-private, so the resolution rule is
  //  exercised through the SAME two exported functions production calls.
  const exported = Object.keys(loader);

  try {
    // ══ 1. THE WORLD, AS PRODUCTION WILL HAVE IT AFTER RETIREMENT ════
    {
      const c = await pool.connect();
      try {
        await c.query("begin");
        propertyId = (await c.query(
          `insert into properties (name, address, leasing_basis)
           values ('import resolution harness', '1417 harness', 'bed') returning id`)).rows[0].id;
        userId = (await c.query(
          `insert into users (email, name) values ($1, 'harness operator') returning id`,
          [`imp-${Date.now()}@harness.local`])).rows[0].id;

        //  CURRENT: unit 101 with three beds, the corrected representation.
        const cur = (await c.query(
          `insert into units (property_id, unit_number, occupancy_status)
           values ($1,'101','unknown') returning id`, [propertyId])).rows[0].id;
        for (const l of ["Room1", "Room2", "Room3"]) {
          await c.query(
            `insert into spaces (unit_id, space_label, position_kind) values ($1,$2,'bed')`,
            [cur, l]);
        }
        //  The trigger also gave 101 a '(whole unit)' placeholder; drop it so
        //  this harness is about resolution, not about the grain repair.
        await c.query(
          `delete from spaces where unit_id = $1 and space_label = '(whole unit)'`, [cur]);

        //  RETIRED: the 2020 bed-as-unit records.
        const legacy = [];
        for (const n of ["101 - A", "101 - B", "101 - C"]) {
          legacy.push((await c.query(
            `insert into units (property_id, unit_number, occupancy_status)
             values ($1,$2,'unknown') returning id`, [propertyId, n])).rows[0].id);
        }
        await retireInventoryUnits(c, {
          property_id: propertyId, unit_ids: legacy, rationale: RATIONALE,
          actor: { user_id: userId } });
        await c.query("commit");
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

      const ivl = await intervalPropertyPositions(pool, {
        property_id: propertyId, requested_start: "2026-08-01", requested_end: "2027-07-31" });
      ok("the corrected world reads 3 positions — the beds, not the retired units",
        ivl.count === 3, String(ivl.count));
      ok("…and the read reports 3 retired units excluded",
        ivl.retired_excluded && ivl.retired_excluded.units === 3,
        JSON.stringify(ivl.retired_excluded));
    }

    // ══ 2. THE REAL EXPORTED LOADER, PROVOKED FOR REAL ═══════════════
    //  loadLedgerSnapshot is what activation_service calls in production.
    //  Driving it — rather than a private helper — is the difference between
    //  proving the rule and proving my own reach into the module.
    {
      const { loadLedgerSnapshot } = loader;
      ok("the real ledger loader is the exported function production calls",
        typeof loadLedgerSnapshot === "function", "exports: " + exported.join(", "));

      //  TWO CALL SHAPES, BOTH REAL. activation_service passes a borrowed
      //  client inside its own transaction; the operator import route hands
      //  the pool over. They used to disagree about what a refusal is.
      const runLoad = async (rows, opts = {}) => {
        try {
          const out = await loadLedgerSnapshot(pool, rows, {
            targetPropertyId: propertyId,
            sourceFile: "RentRoll07_1417.xlsx",
            sourceAsOfDate: "2026-07-31",
            confidence: "confirmed",
            leasingModel: "bed",
            ...opts,
          });
          return { ok: !out || !out.error, out, e: out && out.error ? out : null };
        } catch (e) { return { ok: false, e }; }
      };
      const row = (unit, room) => ({ unit_number: unit, room, section: "current", status: "vacant" });

      //  ── A SOURCE NAMING A RETIRED-ONLY POSITION ──────────────────
      const before = (await pool.query(
        `select count(*)::int n from import_batches where property_id = $1`, [propertyId])).rows[0].n;
      const bad = await runLoad([row("101", "Room1"), row("101 - A", null)]);

      ok("a source naming a RETIRED-ONLY position is REFUSED by the real loader",
        !bad.ok && bad.e && bad.e.refusal_code === "SOURCE_MATCHES_ONLY_RETIRED_INVENTORY",
        JSON.stringify(bad.e && { error: bad.e.error, refusal_code: bad.e.refusal_code }));
      ok("…the machinery key is KEPT for existing consumers",
        bad.e && bad.e.error === "ledger_load_failed");
      //  The RETURNED shape carries public_message; the THROWN one carries
      //  .message. Asserting the wrong one is how a proof reports a missing
      //  sentence that is actually there.
      const said = String((bad.e && (bad.e.public_message || bad.e.detail)) || "");
      ok("…the refusal NAMES the offending position", /101 - A/.test(said));
      ok("…and says nothing was loaded", /Nothing was loaded/i.test(said));
      ok("…and names the next step, not just the rule",
        /Reconcile the source|reinstate/i.test(said), said.slice(0, 150));
      ok("…and it carries a 409 — a question, not a crash and not a bad request",
        bad.e && bad.e.http_status === 409, String(bad.e && bad.e.http_status));
      ok("…and it carries the rows a reconciliation surface would render",
        Array.isArray(bad.e && bad.e.retired_only) && bad.e.retired_only.length === 1,
        JSON.stringify(bad.e && bad.e.retired_only));

      //  THE BORROWED-CLIENT PATH — what activation_service actually does.
      //  It must rethrow the structured refusal, not a flattened shape, so
      //  the transaction owner can decide.
      {
        const bc = await pool.connect();
        let thrown = null;
        try {
          await bc.query("begin");
          await loadLedgerSnapshot(pool, [row("101 - A", null)], {
            client: bc, targetPropertyId: propertyId,
            sourceFile: "RentRoll07_1417.xlsx", sourceAsOfDate: "2026-07-31" });
          await bc.query("commit");
        } catch (e) { await bc.query("rollback").catch(() => {}); thrown = e; }
        finally { bc.release(); }
        ok("the BORROWED-client path (activation) THROWS the structured refusal",
          thrown && thrown.code === "SOURCE_MATCHES_ONLY_RETIRED_INVENTORY",
          String(thrown && thrown.code));
        ok("…with its own 409 intact, so both call shapes agree",
          thrown && thrown.httpStatus === 409, String(thrown && thrown.httpStatus));
      }

      //  NOTHING PARTIAL. The refusal is a pre-flight, so no batch, no unit
      //  and no re-stamp survived it.
      const after = (await pool.query(
        `select count(*)::int n from import_batches where property_id = $1`, [propertyId])).rows[0].n;
      ok("…and NOTHING was written — not even the import batch", after === before,
        `${before} → ${after}`);
      const restamped = (await pool.query(
        `select count(*)::int n from units u
           join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
          where u.property_id = $1 and u.import_batch_id is not null`, [propertyId])).rows[0].n;
      ok("…and no retired unit was re-stamped with the fresh import batch",
        restamped === 0, String(restamped));

      //  ── THE JULY-31-SHAPED SOURCE, WHICH MUST SUCCEED ────────────
      //  The real workbook names 1417-101 + Room1/2/3, so it resolves to the
      //  CURRENT unit through the normal grain reconciliation. This is the
      //  case that has to keep working, and it is the whole point.
      const good = await runLoad([row("101", "Room1"), row("101", "Room2"), row("101", "Room3")]);
      ok("a source naming CURRENT inventory loads normally",
        good.ok === true, String(good.e && good.e.message).slice(0, 160));
      ok("…and it reused the current unit rather than creating a second one",
        (await pool.query(
          `select count(*)::int n from units where property_id = $1 and unit_number = '101'`,
          [propertyId])).rows[0].n === 1);
      //  ⚠ RECORDED, NOT ASSUMED. loadLedgerSnapshot is the EVIDENCE stage:
      //  it hardcodes space_label '(whole unit)' (line ~878) and only stores
      //  `leasing_model` on the import_batches row. Real bed positions are
      //  established later, at CONFIRM, by materializeRentableSpaces.
      //
      //  So this load ADDS a whole-unit position beside the existing beds,
      //  even with leasingModel:'bed'. That is the documented behaviour of
      //  this stage — and it is exactly why loading July 31 into an
      //  already-bed-grained Skyline needs a decision before step E. Pinned
      //  here so the next person meets the fact rather than the surprise.
      const afterLoad = (await intervalPropertyPositions(pool, {
        property_id: propertyId, requested_start: "2026-08-01", requested_end: "2027-07-31" })).count;
      ok("the EVIDENCE-stage ledger load adds a '(whole unit)' position beside the beds",
        afterLoad === 4, String(afterLoad));
      ok("…so this loader is unit-grained by design; bed grain comes from the confirm step",
        (await pool.query(
          `select count(*)::int n from spaces s join units u on u.id = s.unit_id
            where u.property_id = $1 and s.space_label = '(whole unit)'
              and s.import_batch_id is not null`, [propertyId])).rows[0].n >= 1 &&
        (await pool.query(
          `select count(*)::int n from spaces s join units u on u.id = s.unit_id
            where u.property_id = $1 and s.space_label like 'Room%'
              and s.import_batch_id is not null`, [propertyId])).rows[0].n === 0,
        "it wrote whole-unit positions and zero Room positions");

      //  A genuinely NEW unit number is created — the rule is not a
      //  whitelist. `force` is required because the same source_file +
      //  as-of is deduped as already-loaded, which is correct and is not
      //  what this assertion is about.
      const fresh = await runLoad([row("205", "Room1")], { force: true });
      ok("a genuinely NEW unit_number is still created — the rule is not a whitelist",
        (await pool.query(
          `select count(*)::int n from units where property_id = $1 and unit_number = '205'`,
          [propertyId])).rows[0].n === 1,
        JSON.stringify(fresh.e || fresh.out));
    }

    // ══ 3. THE TRIGGER IS STILL THERE, AND IS STILL LAST ═════════════
    //  The pre-flight means production should never reach it. Prove it is
    //  nonetheless armed, so the wall is not quietly load-bearing on the
    //  resolver alone.
    {
      const sp = (await pool.query(
        `select s.id from spaces s join units u on u.id = s.unit_id
          join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
         where u.property_id = $1 limit 1`, [propertyId])).rows[0];
      let code = null;
      if (sp) {
        try {
          await pool.query(
            `insert into leases (property_id, space_id, lease_status, start_date, end_date)
             values ($1,$2,'active','2026-08-01','2027-07-31')`, [propertyId, sp.id]);
        } catch (e) { code = e.code; }
      }
      ok("the database wall is STILL armed behind the resolver",
        !sp || code === "23514", `space=${!!sp} code=${code}`);
    }

    // ══ 4. NOT A NEW SUBSYSTEM ═══════════════════════════════════════
    {
      const fs = require("fs");
      const src = fs.readFileSync("src/shared/snapshot_loader.js", "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      ok("the loader IMPORTS the retirement predicate rather than restating it",
        /NOT_RETIRED_SQL/.test(src) && !/from inventory_retirements ir\b[\s\S]{0,40}reversed_at is null[\s\S]*?reversed_at is null[\s\S]*?reversed_at is null/.test(src));
      //  SCOPED TO THE RULE. The whole file legitimately contains named
      //  property CONFIGS, so scanning all of it would assert something this
      //  change is not responsible for — a gate scanning wider than its claim.
      const ruleOnly = src.slice(
        src.indexOf("async function resolveCurrentUnitId"),
        src.indexOf("async function resolveProperty"));
      ok("no property, address or import batch is hardcoded in the RULE itself",
        ruleOnly.length > 200 && !/14e41b7c|skyline|1417/i.test(ruleOnly),
        String(ruleOnly.length));
      //  Both loaders, not just the one that happened to be read first.
      ok("BOTH loaders run the pre-flight — loadSnapshot and loadLedgerSnapshot",
        (src.match(/refuseIfSourceOnlyMatchesRetiredInventory\(/g) || []).length >= 3,
        String((src.match(/refuseIfSourceOnlyMatchesRetiredInventory\(/g) || []).length));
      ok("BOTH unit lookups go through the one current-only resolver",
        (src.match(/resolveCurrentUnitId\(/g) || []).length >= 3,
        String((src.match(/resolveCurrentUnitId\(/g) || []).length));
    }
  } catch (e) {
    console.log("  FAIL  harness threw  →  " +
      (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)));
    failed++;
  } finally {
    if (propertyId) {
      const q = (s, p) => pool.query(s, p).catch(() => {});
      await q("delete from leases where property_id = $1", [propertyId]);
      await q("delete from inventory_retirements where property_id = $1", [propertyId]);
      await q(`delete from spaces where unit_id in (select id from units where property_id = $1)`, [propertyId]);
      await q("delete from units where property_id = $1", [propertyId]);
      await q("delete from properties where id = $1", [propertyId]);
      if (userId) await q("delete from users where id = $1", [userId]);
    }
    await pool.end();
  }

  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})();
