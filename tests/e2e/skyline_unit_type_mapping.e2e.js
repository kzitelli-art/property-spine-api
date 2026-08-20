/*  ════════════════════════════════════════════════════════════════════
    skyline_unit_type_mapping.e2e.js — RUN THE CANONICAL MAPPING TOOL ON A
    SKYLINE-SHAPED REPLICA.

    Builds production's canonical shape INCLUDING the durable relationship
    the tool actually reads — import_source_rows.produced_space_id — then
    invokes tools/apply_unit_type_mapping.js as a real process: dry run,
    then apply. No direct inserts into property_unit_types or
    units.unit_type_id: that fact has an owner and the owner does the work.

    Acceptance is production's arithmetic, not the tool's own opinion:
      72 units covered · 160 positions covered · 0 unmapped
      0 unexpected extra mappings · 0 retired inventory reintroduced
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { datedPropertyPositions } = require(path.join(ROOT, "src/tenancy/dated_positions.js"));

const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
let pass = 0, fail = 0;
const ok  = (l, d="") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d="") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };

//  production's real distribution
const PLAN = [
  { code: "STU00016", units: 56, beds: 2, bedrooms: 2, bathrooms: 1 },
  { code: "STU00015", units: 12, beds: 3, bedrooms: 3, bathrooms: 1 },
  { code: "STU00017", units: 4,  beds: 3, bedrooms: 3, bathrooms: 1.5 },
];

function runTool(args) {
  try {
    return { ok: true, out: execFileSync(process.execPath,
      [path.join(ROOT, "tools/apply_unit_type_mapping.js"), ...args],
      { cwd: ROOT, encoding: "utf8",
        env: Object.assign({}, process.env, { DATABASE_URL: process.env.E2E_DATABASE_URL }) }) };
  } catch (e) { return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status }; }
}

(async () => {
  const tag = "UTM" + Math.floor(Math.random() * 1e6);
  console.log("\n── replica: 72 units / 160 bed positions / committed july rent roll ──");
  const prop = (await pool.query(
    `insert into properties (name, address, city, state, leasing_basis)
     values ($1,'1417 N 15th','Philadelphia','PA','bed') returning id`, [tag + " Skyline"])).rows[0].id;
  const batch = (await pool.query(
    `insert into import_batches (property_id, source_type, source_file, source_as_of_date,
                                 leasing_model, status)
     values ($1,'rent_roll_ledger','RentRoll07_1417.xlsx','2026-07-31','bed','committed')
     returning id`, [prop])).rows[0].id;

  let n = 0, rowIx = 0;
  for (const g of PLAN) {
    for (let i = 0; i < g.units; i++) {
      n++;
      const u = (await pool.query(
        `insert into units (property_id, unit_number, bedrooms, bathrooms, square_feet)
         values ($1,$2,$3,$4,$5) returning id`,
        [prop, `S-${1000 + n}`, g.bedrooms, g.bathrooms, 800 + g.beds * 100])).rows[0].id;
      //  trg_unit_space adds a '(whole unit)' placeholder; production carries
      //  none after re-graining, so it goes.
      await pool.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [u]);
      for (let b = 0; b < g.beds; b++) {
        const s = (await pool.query(
          `insert into spaces (unit_id, space_label) values ($1,$2) returning id`,
          [u, `Bed ${String.fromCharCode(65 + b)}`])).rows[0].id;
        //  THE DURABLE RELATIONSHIP the tool reads. Not a unit_number match.
        await pool.query(
          `insert into import_source_rows (import_batch_id, row_index, raw, produced_unit_id, produced_space_id)
           values ($1,$2,$3,$4,$5)`,
          [batch, rowIx++, JSON.stringify({
            unit_type: g.code, unit_number: `S-${1000 + n}`,
            space_label: `Bed ${String.fromCharCode(65 + b)}`,
            sqft: String(800 + g.beds * 100), is_commercial: "false", status: "occupied",
          }), u, s]);
      }
    }
  }
  const shape = (await pool.query(`
    select (select count(*)::int from units where property_id=$1) u,
           (select count(*)::int from spaces s join units x on x.id=s.unit_id where x.property_id=$1) s,
           (select count(*)::int from units where property_id=$1 and unit_type_id is not null) t`, [prop])).rows[0];
  shape.u === 72 && shape.s === 160 && shape.t === 0
    ? ok("replica matches production", `${shape.u} units / ${shape.s} beds / ${shape.t} types`)
    : bad("replica wrong", JSON.stringify(shape));

  console.log("\n── 1 · DRY RUN through the canonical tool ──");
  const dry = runTool(["--property", prop]);
  console.log(dry.out.split("\n").filter((l) => l.trim()).map((l) => "     " + l).join("\n"));
  dry.ok ? ok("dry run completed") : bad("dry run failed", `exit ${dry.code}`);
  /ruling: skyline_owner_statement/.test(dry.out)
    ? ok("selected the Skyline ruling by coverage")
    : bad("wrong or no ruling selected");
  const after0 = (await pool.query(
    "select count(*)::int n from property_unit_types where property_id=$1", [prop])).rows[0].n;
  after0 === 0 ? ok("dry run wrote nothing", "property_unit_types still empty")
               : bad("dry run WROTE", `${after0} rows`);

  console.log("\n── 2 · APPLY ──");
  const app = runTool(["--property", prop, "--apply"]);
  app.ok ? ok("apply completed") : bad("apply failed", (app.out || "").slice(-300));

  console.log("\n── 3 · acceptance, against production's arithmetic ──");
  const cov = (await pool.query(`
    select (select count(*)::int from units where property_id=$1 and unit_type_id is not null) as units_typed,
           (select count(*)::int from units where property_id=$1) as units_total,
           (select count(*)::int from spaces s join units u on u.id=s.unit_id
             where u.property_id=$1 and u.unit_type_id is not null) as positions_typed,
           (select count(*)::int from spaces s join units u on u.id=s.unit_id
             where u.property_id=$1) as positions_total,
           (select count(*)::int from property_unit_types where property_id=$1) as types`, [prop])).rows[0];
  cov.units_typed === 72 && cov.units_total === 72 ? ok("72 units covered") : bad("unit coverage", JSON.stringify(cov));
  cov.positions_typed === 160 && cov.positions_total === 160 ? ok("160 positions covered") : bad("position coverage", JSON.stringify(cov));
  (cov.units_total - cov.units_typed) === 0 ? ok("0 unmapped") : bad("unmapped units", String(cov.units_total - cov.units_typed));
  cov.types === 3 ? ok("exactly 3 governed types", "no extra mappings") : bad("unexpected type count", String(cov.types));

  const byType = (await pool.query(`
    select put.code, put.label, count(distinct u.id)::int units,
           count(distinct s.id)::int positions
      from property_unit_types put
      join units u on u.unit_type_id = put.id
      join spaces s on s.unit_id = u.id
     where put.property_id=$1 group by 1,2 order by units desc`, [prop])).rows;
  console.log("     " + byType.map((r) => `${r.code}=${r.label} ${r.units}u/${r.positions}p`).join("   "));
  //  Keyed by OUR code now, not the vendor's — that separation is the point.
  const expect = { "2BR": [56, 112], "3BR-1BA": [12, 36], "3BR-1.5BA": [4, 12] };
  let distOk = byType.length === 3;
  for (const r of byType) {
    const e = expect[r.code];
    if (!e || r.units !== e[0] || r.positions !== e[1]) distOk = false;
  }
  distOk ? ok("distribution matches production exactly") : bad("distribution differs");

  const pos = await datedPropertyPositions(pool, { property_id: prop });
  pos.count === 160 && (pos.retired_excluded || {}).units === 0
    ? ok("canonical loader still sees 160, no retired inventory reintroduced")
    : bad("canonical loader disagrees", `count=${pos.count} retired=${JSON.stringify(pos.retired_excluded)}`);

  console.log("\n── 4 · idempotence ──");
  const again = runTool(["--property", prop, "--apply"]);
  const cov2 = (await pool.query(
    "select count(*)::int n from property_unit_types where property_id=$1", [prop])).rows[0].n;
  again.ok && cov2 === 3 ? ok("re-apply is a no-op", "still 3 types") : bad("re-apply changed things", `types=${cov2}`);

  //  cleanup
  await pool.query("delete from import_source_rows where import_batch_id=$1", [batch]);
  await pool.query("delete from import_batches where id=$1", [batch]);
  await pool.query("update units set unit_type_id=null where property_id=$1", [prop]);
  await pool.query("delete from property_unit_types where property_id=$1", [prop]);
  await pool.query("delete from spaces where unit_id in (select id from units where property_id=$1)", [prop]);
  await pool.query("delete from units where property_id=$1", [prop]);
  await pool.query("delete from properties where id=$1", [prop]);

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  unit-type mapping: ${pass} passed · ${fail} failed`);
  console.log(`══════════════════════════════════════════════════════════════`);
  await pool.end();
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
