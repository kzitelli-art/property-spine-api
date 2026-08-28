/*  ════════════════════════════════════════════════════════════════════
    skyline_pricing_drive.e2e.js — DRIVE THE REAL PRICING PATH ON A
    SKYLINE-SHAPED REPLICA, AND BELIEVE THE FIRST RED.

    Not a fixture shortcut. The replica reproduces production's CANONICAL
    Skyline shape — leasing_basis 'bed', 72 current units, 160 rentable
    bed positions, zero governed unit types, zero published pricing — and
    then walks the governed mechanisms in order, reporting the first thing
    that genuinely stops.

    The point is NOT to reach a published price. It is to find out exactly
    where the real path stops, so the morning question is a specific one.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const buildStaffBridge = require(path.join(ROOT, "src/identity/staff_bridge.js"));
const { resolveAuthority } = require(path.join(ROOT, "src/identity/authority_resolution.js"));
const { pricingAuthority } = require(path.join(ROOT, "src/money/pricing_authority.js"));
const { resolveSpaceEconomics } = require(path.join(ROOT, "src/money/effective_pricing.js"));
const { datedPropertyPositions } = require(path.join(ROOT, "src/tenancy/dated_positions.js"));
const { establishAuthorizedReviewer } = require(path.join(
  ROOT, "tests/support/authority_reviewer_fixture.js"));

const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
const svc = buildStaffBridge({ pool })._service;
const L = (s="") => console.log(s);
let step = 0, firstRed = null;
const good = (l, d="") => { L(`  ✓ ${++step}. ${l}${d ? "  — " + d : ""}`); };
const red  = (l, d="") => { L(`  ✗ ${++step}. ${l}${d ? "  — " + d : ""}`); if (!firstRed) firstRed = { l, d }; };
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

(async () => {
  const tag = "SKY" + Math.floor(Math.random() * 1e6);
  L("\n── building a replica of production's canonical Skyline shape ──");
  const prop = (await pool.query(
    `insert into properties (name, address, city, state, leasing_basis)
     values ($1,'1417 N 15th','Philadelphia','PA','bed') returning id`, [tag + " Skyline"])).rows[0].id;

  //  72 units; 160 bed positions distributed across them (16 units × 3 beds,
  //  56 units × 2 beds = 48 + 112 = 160). The distribution is arbitrary; the
  //  TOTALS are what production actually carries.
  const unitIds = [];
  for (let i = 1; i <= 72; i++) {
    const u = (await pool.query(
      `insert into units (property_id, unit_number, bedrooms, bathrooms)
       values ($1,$2,$3,1) returning id`, [prop, `S-${100 + i}`, i <= 16 ? 3 : 2])).rows[0].id;
    unitIds.push(u);
  }
  for (let i = 0; i < unitIds.length; i++) {
    const beds = i < 16 ? 3 : 2;
    for (let b = 0; b < beds; b++) {
      await pool.query(`insert into spaces (unit_id, space_label) values ($1,$2)`,
        [unitIds[i], `Bed ${String.fromCharCode(65 + b)}`]);
    }
  }
  //  ── THE TRIGGER'S PROVISIONAL PLACEHOLDER ───────────────────────
  //  trg_unit_space inserts a '(whole unit)' space for every new unit, so
  //  a naive replica lands at 72 + 160 = 232 and does NOT reproduce
  //  production. Real Skyline carries exactly 160: re-graining to beds
  //  removed the whole-unit placeholders. Discovered by the replica
  //  failing its own shape assertion, which is why that assertion exists
  //  before anything downstream is believed.
  await pool.query(
    `delete from spaces s using units u
      where s.unit_id = u.id and u.property_id = $1 and s.space_label = '(whole unit)'`, [prop]);

  const shape = (await pool.query(`
    select (select count(*)::int from units where property_id=$1) u,
           (select count(*)::int from spaces s join units x on x.id=s.unit_id where x.property_id=$1) s,
           (select count(*)::int from units where property_id=$1 and unit_type_id is not null) t`, [prop])).rows[0];
  shape.u === 72 && shape.s === 160 && shape.t === 0
    ? good("replica matches production", `${shape.u} units / ${shape.s} beds / ${shape.t} governed unit types`)
    : red("replica does not match", JSON.stringify(shape));

  const pos = await datedPropertyPositions(pool, { property_id: prop });
  pos.count === 160 ? good("canonical loader agrees", `${pos.count} rentable positions`)
                    : red("canonical loader disagrees", `count=${pos.count}`);

  L("\n── establish authority through the governed rail (now proven) ──");
  const admin = (await pool.query(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'asset_manager',true,'active','human_staff') returning id`,
    [tag + " Admin", tag + "a@example.com"])).rows[0].id;
  const person = (await pool.query(
    "insert into persons (name,email,source) values ($1,$2,'staff_bridge') returning id",
    [tag + " KZ", tag + "kz@example.com"])).rows[0].id;
  const user = (await pool.query(
    `insert into users (name,email,role,is_active,status,account_kind,person_id)
     values ($1,$2,'asset_manager',true,'active','human_staff',$3) returning id`,
    [tag + " KZ Login", tag + "kz@example.com", person])).rows[0].id;
  const reviewer = await establishAuthorizedReviewer(pool, {
    userId: admin, propertyId: prop, label: tag + " Authority Reviewer",
  });
  await pool.query(
    `insert into person_contexts (person_id, context_type, property_id, created_by_user_id)
     values ($1,'staff',$2,$3)`, [person, prop, admin]);
  await resolveAuthority(pool, { spec: {
    user_id: user, person_id: person, property_id: prop,
    requested_role: "asset_manager", reviewer_user_id: admin,
    reason: "skyline pricing drive: authorized asset manager" }, apply: true });
  const auth = await pricingAuthority(pool, { property_id: prop, user_id: user });
  auth.may_publish_pricing ? good("pricing authority established", auth.basis.may_publish_pricing)
                           : red("authority did not resolve", JSON.stringify(auth).slice(0, 140));

  L("\n── now DRIVE the governed pricing path ──");

  //  1 · the worksheet a real operator would be handed
  let ws = null;
  try {
    const { effectivePropertyPricing } = require(path.join(ROOT, "src/money/effective_pricing.js"));
    ws = await effectivePropertyPricing(pool, { property_id: prop });
    const types = (ws && ws.types) || [];
    types.length === 0
      ? red("the pricing worksheet has NO unit types to price", "effectivePropertyPricing returned zero types")
      : good("worksheet lists types", `${types.length}`);
  } catch (e) { red("effectivePropertyPricing threw", e.message.slice(0, 140)); }

  //  2 · what the publication contract says
  try {
    const { previewPublication } = require(path.join(ROOT, "src/money/pricing_publication_preview.js"));
    const pv = await previewPublication(pool, { property_id: prop, proposal: {} });
    pv.would_publish
      ? red("publication would proceed with no governed types — unexpected", "")
      : good("publication refuses, as it should",
             "blockers: " + ((pv.blockers || []).map((b) => b.code).join(", ") || "(none reported)"));
    L(`        completeness: ${JSON.stringify((pv.current && pv.current.completeness) || {}).slice(0, 160)}`);
  } catch (e) { red("previewPublication threw", e.message.slice(0, 160)); }

  //  3 · the resolver a prospect's price actually comes from
  const space = (await pool.query(`
    select s.id from spaces s join units u on u.id=s.unit_id where u.property_id=$1 limit 1`, [prop])).rows[0];
  const econ = await resolveSpaceEconomics(pool, { property_id: prop, space_id: space.id });
  econ.resolved
    ? red("a price resolved with no published pricing — unexpected", JSON.stringify(econ).slice(0, 140))
    : good("space economics refuses", `${econ.reason} — ${String(econ.detail || "").slice(0, 90)}`);

  //  4 · what the canonical unit-type mechanism would need
  L("\n── the existing unit-type mechanism, and what it wants ──");
  const srcRows = (await pool.query(`
    select count(*)::int n from import_source_rows isr
     join import_batches b on b.id = isr.import_batch_id
    where b.property_id = $1`, [prop])).rows[0].n;
  L(`     import_source_rows for this property: ${srcRows}`);
  L("     tools/apply_unit_type_mapping.js maps SOURCE CODE → governed type");
  L("     via import_source_rows.produced_space_id — never a unit_number match.");
  srcRows === 0
    ? red("no import source rows", "the mapping tool has nothing to map from on a synthetic replica")
    : good("source rows present", String(srcRows));

  L("\n══════════════════════════════════════════════════════════════");
  L(`  FIRST OBSERVED RED: ${firstRed ? firstRed.l : "(none — the path did not stop)"}`);
  if (firstRed && firstRed.d) L(`  ${firstRed.d}`);
  L("══════════════════════════════════════════════════════════════");

  await pool.query("delete from assignments where property_id=$1", [prop]);
  await pool.query("delete from person_contexts where property_id=$1", [prop]);
  await pool.query("delete from spaces where unit_id in (select id from units where property_id=$1)", [prop]);
  await pool.query("delete from units where property_id=$1", [prop]);
  await pool.query("delete from users where id = any($1)", [[user, admin]]);
  await pool.query("delete from persons where id=any($1)", [[person, reviewer.personId]]);
  await pool.query("delete from properties where id=$1", [prop]);
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
