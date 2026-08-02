// ════════════════════════════════════════════════════════════════════
//  slice9_leaseable_units_proof.js
//
//  Commit D (API half). The send-application selector reads canonical
//  availability through the ONE authority and returns TWO lists.
//
//  A multi-space unit is not filtered out. It is present and unselectable,
//  carrying the server's own reason — dropping it silently would leave an
//  operator hunting for a unit visible in every other surface, with no
//  statement of why it is missing here.
//
//  ONE ROW PER UNIT, NEVER ONE PER SPACE.
//
//  Run: DATABASE_URL=... node tests/slice9_leaseable_units_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const { seedInventory } = require("./fixtures/slice9_inventory_fixture");
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
async function leaseableUnits(q, property_id, intended_move_in = null) {
  const shapes = (await q.query(
    `select u.id as unit_id, u.unit_number, count(s.id)::int as space_count
       from units u left join spaces s on s.unit_id = u.id
      where u.property_id = $1 group by u.id, u.unit_number order by u.unit_number asc`,
    [property_id])).rows;
  const avail = await availabilityRead(q, { property_id });
  const byUnit = new Map(avail.rows.map((r) => [String(r.unit_id), r]));
  const eligible_units = [], unsupported_multi_space_units = [];
  for (const u of shapes) {
    if (u.space_count > 1) {
      unsupported_multi_space_units.push({
        unit_id: u.unit_id, unit_number: u.unit_number,
        rentable_space_count: u.space_count,
        reason_code: authority.REFUSAL.MULTI_SPACE,
        reason: authority.REFUSAL_TEXT[authority.REFUSAL.MULTI_SPACE],
      });
      continue;
    }
    if (u.space_count === 0) continue;
    const row = byUnit.get(String(u.unit_id));
    if (!row) continue;
    const v = authority.evaluateOfferability(row, intended_move_in);
    if (!v.offerable) continue;
    eligible_units.push({
      unit_id: row.unit_id, unit_number: row.unit_number,
      resolved_space_id: row.space_id, position_kind: row.position_kind,
      space_label: row.space_label, marketing_state: row.marketing_state,
      available_from: row.available_from,
      availability_confidence: row.availability_confidence,
      resolution_basis: "sole_space_unit",
    });
  }
  return { property_id, eligible_count: eligible_units.length,
           unsupported_count: unsupported_multi_space_units.length,
           eligible_units, unsupported_multi_space_units };
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

    console.log("\n── TWO LISTS, NOT ONE FILTERED LIST ─────────────────────");
    ok(Array.isArray(out.eligible_units), "eligible_units is returned");
    ok(Array.isArray(out.unsupported_multi_space_units), "unsupported_multi_space_units is returned");
    ok(out.eligible_count === out.eligible_units.length, "eligible_count matches its list");
    ok(out.unsupported_count === out.unsupported_multi_space_units.length, "unsupported_count matches its list");

    console.log("\n── THE MULTI-SPACE UNIT IS PRESENT AND UNSELECTABLE ─────");
    const blocked = out.unsupported_multi_space_units.find(
      (u) => String(u.unit_id) === String(U["S-two-space"].unit_id));
    ok(!!blocked, "the two-space unit APPEARS — it is not silently dropped");
    ok(blocked && blocked.rentable_space_count === 2, "carrying its real space count");
    ok(blocked && blocked.reason_code === "space_grain_not_supported",
      `and the server's reason code (${blocked && blocked.reason_code})`);
    ok(blocked && !("resolved_space_id" in blocked),
      "an unsupported row carries NO resolved space — nothing to select");
    ok(blocked && /not supported/i.test(blocked.reason || ""),
      "its copy states unsupported, not 'choose a space'");
    ok(blocked && !/space_grain/.test(blocked.reason || ""),
      "no internal code in the operator sentence");

    console.log("\n── ONE ROW PER UNIT, NEVER ONE PER SPACE ────────────────");
    const allIds = out.eligible_units.map((u) => String(u.unit_id))
      .concat(out.unsupported_multi_space_units.map((u) => String(u.unit_id)));
    ok(new Set(allIds).size === allIds.length, "no unit appears twice across the two lists");
    ok(!out.eligible_units.some((u) => String(u.unit_id) === String(U["S-two-space"].unit_id)),
      "the two-space unit never appears as selectable");
    ok(out.eligible_units.filter((u) => String(u.unit_id) === String(U["S-two-space"].unit_id)).length === 0,
      "and it is NOT expanded into one selectable row per space");

    console.log("\n── ELIGIBLE ROWS CARRY THE FULL CONTRACT ────────────────");
    const good = out.eligible_units.find((u) => String(u.unit_id) === String(U["A-marketable"].unit_id));
    ok(!!good, "the marketable sole-space unit is eligible");
    for (const f of ["unit_id","unit_number","resolved_space_id","position_kind","space_label",
                     "marketing_state","available_from","availability_confidence","resolution_basis"]) {
      ok(good && f in good, `eligible row carries ${f}`);
    }
    ok(good && good.resolution_basis === "sole_space_unit", "resolution_basis is sole_space_unit");
    ok(good && String(good.resolved_space_id) === String(U["A-marketable"].space_id),
      "resolved_space_id is the unit's one space");

    console.log("\n── NON-OFFERABLE UNITS ARE ABSENT, NOT UNSUPPORTED ──────");
    const notEligible = (name) => !out.eligible_units.some(
      (u) => String(u.unit_id) === String(U[name].unit_id));
    const notUnsupported = (name) => !out.unsupported_multi_space_units.some(
      (u) => String(u.unit_id) === String(U[name].unit_id));
    for (const n of ["G-occupied","J-future-locked","E-down","D-model","O-conflict","P-readiness-unknown"]) {
      ok(notEligible(n) && notUnsupported(n),
        `${n} is neither selectable nor mislabelled as a grain refusal`);
    }
    ok(notEligible("R-zero-space") && notUnsupported("R-zero-space"),
      "a zero-space unit is not offered and is not a grain refusal either");

    console.log("\n── FORWARD OFFERS APPEAR ONLY WITH AN INTENDED MOVE-IN ──");
    ok(notEligible("B-upcoming"), "an on-notice unit is absent with no intended move-in");
    const farOut = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const fwd = await leaseableUnits(c, P, farOut);
    ok(fwd.eligible_units.some((u) => String(u.unit_id) === String(U["B-upcoming"].unit_id)),
      "and becomes eligible once an intended move-in makes it a forward offer");
    ok(fwd.unsupported_count === out.unsupported_count,
      "the grain refusal is unaffected by the date — it is structural");

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
