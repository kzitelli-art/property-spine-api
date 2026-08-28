// ════════════════════════════════════════════════════════════════════
//  slice9_leaseable_units_proof.js
//
//  The send-application selector reads canonical availability through the ONE
//  authority and returns exact leaseable targets.
//
//  A sole-space unit remains a simple unit choice. A multi-space unit returns
//  one row per available space so a Skyline bed can be deliberately chosen and
//  preserved by the durable application-to-lease chain.
//
//  Run: DATABASE_URL=... node tests/proofs/slice9_leaseable_units_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const { seedInventory } = require("../fixtures/slice9_inventory_fixture");
const { availabilityRead } = require(path.join(REPO, "src/surfaces/availability_read"));
const authority = require(path.join(REPO, "src/applications/application_target_authority"));

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

// The route body, evaluated directly against the seeded transaction. The HTTP
// wrapper adds session auth, which the operator HTTP proof covers; this proves
// the READ.
async function leaseableUnits(q, property_id) {
  const shapes = (await q.query(
    `select u.id as unit_id, u.unit_number,
            s.id as space_id, coalesce(s.space_label, '(whole unit)') as space_label,
            count(s.id) over (partition by u.id)::int as space_count
       from units u join spaces s on s.unit_id = u.id
      where u.property_id = $1
      order by u.unit_number asc, s.space_label asc nulls first, s.id asc`,
    [property_id])).rows;
  const avail = await availabilityRead(q, { property_id });
  const bySpace = new Map(avail.rows.map((r) => [String(r.space_id), r]));
  const eligible_targets = [], eligible_units = [];
  for (const target of shapes) {
    const row = bySpace.get(String(target.space_id));
    if (!row) continue;
    const v = authority.evaluateOfferability(row);
    if (!v.offerable) continue;
    const item = {
      unit_id: row.unit_id, unit_number: row.unit_number,
      space_id: row.space_id, resolved_space_id: row.space_id,
      rentable_space_count: target.space_count, position_kind: row.position_kind,
      space_label: row.space_label, marketing_state: row.marketing_state,
      available_from: row.available_from,
      availability_confidence: row.availability_confidence,
      resolution_basis: target.space_count === 1 ? "sole_space_unit" : "chosen_space",
    };
    eligible_targets.push(item);
    if (target.space_count === 1) eligible_units.push(item);
  }
  return { property_id, eligible_target_count: eligible_targets.length,
           eligible_count: eligible_units.length, eligible_targets,
           eligible_units, unsupported_count: 0, unsupported_multi_space_units: [] };
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const s = await seedInventory(c);
    const P = s.property_id, U = s.units;

    const out = await leaseableUnits(c, P);

    console.log("\n── EXACT TARGETS WITH ROLLING-DEPLOY COMPATIBILITY ──────");
    ok(Array.isArray(out.eligible_targets), "eligible_targets is returned");
    ok(Array.isArray(out.eligible_units), "eligible_units is returned");
    ok(Array.isArray(out.unsupported_multi_space_units), "unsupported_multi_space_units is returned");
    ok(out.eligible_count === out.eligible_units.length, "legacy eligible_count keeps its sole-space meaning");
    ok(out.eligible_target_count === out.eligible_targets.length, "eligible_target_count matches its list");
    ok(out.unsupported_count === out.unsupported_multi_space_units.length, "unsupported_count matches its list");

    console.log("\n── THE MULTI-SPACE UNIT OFFERS EACH EXACT SPACE ─────────");
    const beds = out.eligible_targets.filter(
      (u) => String(u.unit_id) === String(U["S-two-space"].unit_id));
    ok(beds.length === 2, "the two-space unit returns two selectable targets");
    ok(beds.every((u) => u.rentable_space_count === 2), "each target carries the real sibling count");
    ok(beds.every((u) => u.resolution_basis === "chosen_space"), "each target requires a deliberate space choice");
    ok(new Set(beds.map((u) => String(u.space_id))).size === 2, "the targets carry two distinct space ids");
    ok(beds.every((u) => String(u.space_id) === String(u.resolved_space_id)),
      "the selected identity and server validation receipt agree");
    ok(!out.eligible_units.some((u) => String(u.unit_id) === String(U["S-two-space"].unit_id)),
      "the compatibility unit list still fails closed for old apps");
    ok(out.unsupported_multi_space_units.length === 0,
      "the current contract no longer labels by-bed inventory unsupported");

    console.log("\n── ONE ROW PER EXACT TARGET ──────────────────────────────");
    const targetKeys = out.eligible_targets.map((u) => `${u.unit_id}:${u.space_id}`);
    ok(new Set(targetKeys).size === targetKeys.length, "no unit-space target appears twice");

    console.log("\n── ELIGIBLE ROWS CARRY THE FULL CONTRACT ────────────────");
    const good = out.eligible_targets.find((u) => String(u.unit_id) === String(U["A-marketable"].unit_id));
    ok(!!good, "the marketable sole-space unit is eligible");
    for (const f of ["unit_id","unit_number","space_id","resolved_space_id","rentable_space_count","position_kind","space_label",
                     "marketing_state","available_from","availability_confidence","resolution_basis"]) {
      ok(good && f in good, `eligible row carries ${f}`);
    }
    ok(good && good.resolution_basis === "sole_space_unit", "resolution_basis is sole_space_unit");
    ok(good && String(good.resolved_space_id) === String(U["A-marketable"].space_id),
      "resolved_space_id is the unit's one space");

    console.log("\n── NON-OFFERABLE UNITS ARE ABSENT, NOT UNSUPPORTED ──────");
    const notEligible = (name) => !out.eligible_targets.some(
      (u) => String(u.unit_id) === String(U[name].unit_id));
    const notUnsupported = (name) => !out.unsupported_multi_space_units.some(
      (u) => String(u.unit_id) === String(U[name].unit_id));
    for (const n of ["G-occupied","J-future-locked","E-down","D-model","O-conflict","P-readiness-unknown"]) {
      ok(notEligible(n) && notUnsupported(n),
        `${n} is neither selectable nor mislabelled as a grain refusal`);
    }
    ok(notEligible("R-zero-space") && notUnsupported("R-zero-space"),
      "a zero-space unit is not offered and is not a grain refusal either");

    console.log("\n── FUTURE-DATED UNITS ARE NEVER SELECTABLE (owner ruling) ─");
    //  The selector previously surfaced upcoming and turnover_required units
    //  once an intended_move_in was supplied. That promise is withdrawn: the
    //  date reached no durable row, so submission could not reproduce it.
    ok(notEligible("B-upcoming"), "an on-notice unit is not selectable");
    ok(notEligible("C-turnover"), "a unit in turnover is not selectable");
    ok(notUnsupported("B-upcoming") && notUnsupported("C-turnover"),
      "and neither is mislabelled as a GRAIN refusal — the limitation is capability, not shape");

    const farOut = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const fwd = await leaseableUnits(c, P);
    ok(!fwd.eligible_targets.some((u) => String(u.unit_id) === String(U["B-upcoming"].unit_id)),
      "supplying a far-future intended move-in does NOT make it selectable");
    ok(fwd.eligible_count === out.eligible_count && fwd.unsupported_count === out.unsupported_count,
      "the selector returns an identical answer regardless of any date the caller had in mind");
    const routeSrc = require("fs").readFileSync(path.join(REPO, "src/identity/operator.js"), "utf8")
      .split('router.get("/operator/leasing/leaseable-units"')[1].slice(0, 4000)
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(!/intended_move_in/.test(routeSrc),
      "and the route reads no intended_move_in at all — no vestigial query parameter");

    console.log("\n── EVERY ELIGIBLE ROW IS marketable_now ─────────────────");
    ok(out.eligible_targets.every((u) => u.marketing_state === "marketable_now"),
      `every selectable target is marketable_now (${[...new Set(out.eligible_targets.map(u => u.marketing_state))].join(", ") || "none"})`);
    ok(out.eligible_targets.every((u) => u.availability_confidence === "confirmed"),
      "and each carries confirmed availability confidence, never incomplete");

    console.log("\n── NO LEGACY AVAILABILITY IN THE ROUTE ──────────────────");
    const opsrc = require("fs").readFileSync(path.join(REPO, "src/identity/operator.js"), "utf8");
    const routeBody = opsrc.split('router.get("/operator/leasing/leaseable-units"')[1].slice(0, 4000);
    ok(!/tenancy\/availability/.test(routeBody), "the route no longer reads the legacy module");
    ok(/availabilityRead\(/.test(routeBody), "it reads canonical availability");
    ok(!/LEASEABLE_STATES/.test(opsrc), "the legacy allowlist constant is gone from operator.js entirely");
    const legacyLeft = (opsrc.match(/require\(["']\.\.\/tenancy\/availability["']\)/g) || []).length;
    ok(legacyLeft === 0,
      `ZERO legacy availability consumers remain in operator.js — Commit E is unblocked (found ${legacyLeft})`);

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   leaseable units: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
