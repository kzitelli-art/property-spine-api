/* ════════════════════════════════════════════════════════════════════
   tenancy_standing_read.db.js — TENANCY'S COMPACT STANDING PROJECTION,
   AGAINST THE REAL JULY ARTIFACT.

   §40.6 asks each domain for a projection cheap enough to gather
   routinely — current position, important unknowns, next milestone —
   so an entitled person can text Spine from a meeting and get where
   the building stands without knowing it lives in `spaces` and
   `leases`. This proves tenancy's, on 72 real units and 160 real beds
   loaded from RentRoll07_1417.xlsx.

   ── THE CLAIM THAT MATTERS MOST IS PROVED, NOT COMMENTED ────────────
   tenancy_position_read.js says in its header that it calls
   datedPropertyPositions "exactly as the Rent Roll surface does", so
   the sentence and the screen cannot disagree about the same building
   on the same day. A header saying that is worth nothing. So this
   harness runs BOTH reads — unitRentRoll (what the operator sees) and
   readTenancyStanding (what Ask Spine gets) — against the same
   database at the same as_of, and requires every shared count to be
   identical. If a second occupancy derivation ever appears, that
   assertion is where it dies.

   ── AND THE SILENCES SURVIVE COMPRESSION ────────────────────────────
   NOT_ESTABLISHED (the property has recorded no inventory) and
   READ_FAILED (Spine could not look) are proven to be two different
   outcomes, on two different fixtures, because collapsing them is how
   an empty answer becomes a confident wrong one (§40.7). A property
   with no positions returns position === null — never occupied: 0,
   which would read as a building nobody lives in.

   ── as_of IS A PARAMETER, NOT A PROPERTY OF THE MODEL ───────────────
   Read at 07/31 and again at 08/10 the SAME database answers
   differently, because 91 future leases commence 08/03. That is the
   time dial working through one model at two dates, not a second
   future datastore — and it is asserted rather than described.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
   This harness COMMITS its fixtures under its own organization name and
   cleans that organization up on entry, same as its Rent Roll sibling.

   CLASS 3 — test infrastructure.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/spine_full \
       node tests/proofs/tenancy_standing_read.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const fs = require("fs");
const XLSX = require("xlsx");
const { mapRows } = require("../../src/onboarding/rent_roll_field_map.js");
const { materializeRentableSpaces } = require("../../src/tenancy/inventory_materialization.js");
const { unitRentRoll } = require("../../src/surfaces/rent_roll_unit_view.js");
const tenancy = require("../../src/tenancy/tenancy_position_read.js");

const XLSX_PATH = process.env.SKYLINE_XLSX
  || "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd/d657f655-RentRoll07_1417.xlsx";
const ORG = "Tenancy Standing Read";

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
const plusDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/*  Same parser as skyline_rent_roll_read.db.js. Duplicated deliberately
 *  rather than exported: this file must read the ARTIFACT, not another
 *  harness's interpretation of it.  */
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
    if (k === "Vacant Beds") totals.vacant = Number(r[11]);
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
  await pool.query(`delete from persons where source='tenancy_standing_read'`);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

/*  A UUID anywhere in the payload is a §40.8 leak waiting to happen: a
 *  model holding an id can compose a link Spine did not resolve.
 *  References are minted server-side from entitled facts, so the
 *  standing projection carries none at all.  */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function findIdentifiers(value, trail = "") {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findIdentifiers(v, `${trail}[${i}]`)));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/(^|_)id$/.test(k)) hits.push(`${trail}.${k}`);
      hits.push(...findIdentifiers(v, `${trail}.${k}`));
    }
    return hits;
  }
  if (typeof value === "string" && UUID.test(value)) hits.push(`${trail} (uuid value)`);
  return hits;
}

const started = receipt.begin(__filename, { url: CONN, expected: 34 });

(async () => {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`\n  REFUSED: the real artifact is not at ${XLSX_PATH}.`);
    console.error("  This harness proves a read against REAL Skyline truth and will not");
    console.error("  substitute a fixture for it.\n");
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
  //  A SECOND PROPERTY, DELIBERATELY EMPTY. Same organization, no units,
  //  no spaces, no leases — the NOT_ESTABLISHED fixture. It has to be a
  //  real property row, because "a property Spine knows nothing about"
  //  and "a property id that does not exist" are different questions.
  const emptyProp = (await pool.query(
    `insert into properties (name, address, organization_id)
     values ('Not Yet Onboarded','9 Nowhere St',$1) returning id`, [org])).rows[0].id;

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
    await c1.query("commit");
  } catch (e) { await c1.query("rollback"); throw e; } finally { c1.release(); }

  for (const m of [...current.filter((x) => x.name), ...future]) {
    const sid = spaceOf.get(`${String(m.unit_number).trim()}|${String(m.space_label).trim()}`);
    if (!sid) continue;
    const person = (await pool.query(
      `insert into persons (name, source, lifecycle_status, leasing_stage, import_batch_id,
                            source_type, source_as_of_date, confidence)
       values ($1,'tenancy_standing_read','resident','resident',$2,'rent_roll_ledger',$3,'confirmed') returning id`,
      [m.name, batch, AS_OF])).rows[0].id;
    await pool.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status,
                           import_batch_id, source_type, source_as_of_date, confidence)
       values ($1,$2,$3,$4,$5,$6,'active',$7,'historical_snapshot',$8,'confirmed')`,
      [prop, sid, [person], Number(m.actual_rent) > 0 ? Number(m.actual_rent) : null,
       m.lease_from, m.lease_to, batch, AS_OF]);
  }

  // ══ THE TWO READS, SAME DATABASE, SAME DATE ══════════════════════
  const standing = await tenancy.readTenancyStanding(pool, { property_id: prop, as_of: AS_OF });
  const screen = await unitRentRoll(pool, { property_id: prop, as_of: AS_OF });

  console.log("\n  ── the projection, as Ask Spine receives it ──");
  console.log(JSON.stringify(
    { standing: standing.standing, established_from: standing.established_from,
      position: standing.position, unknowns: standing.unknowns,
      next_milestone: standing.next_milestone }, null, 2)
    .split("\n").map((l) => "    " + l).join("\n"));

  console.log("\n  ── it agrees with the artifact ──");
  /*  ⚠ THIS ASSERTED "ESTABLISHED" AND WAS RIGHT ABOUT THE OLD RULE.
   *
   *  This fixture builds inventory and leases straight from the workbook
   *  and establishes NO opening tenancy position. Under the old rule any
   *  property with rows was ESTABLISHED, and every bed without a lease was
   *  counted Open — by subtraction, which is the assertion two lines down.
   *
   *  Occupancy and vacancy are not symmetric. Four kinds of recorded fact
   *  can establish that a bed is occupied; exactly one can establish that
   *  it is empty — an accepted per-space vacancy claim. With no opening
   *  position there is no such claim, so Spine holds NO evidence that
   *  those beds are available. Calling them Open was the double-let risk;
   *  calling them Needs Review would invent a conflict where there is only
   *  silence. They are Not Established.
   *
   *  So the honest standing is PARTIALLY_ESTABLISHED: the leased beds are
   *  established by their leases, and the rest are unknown.  */
  ok("standing is PARTIALLY_ESTABLISHED — leases establish, silence does not",
     standing.standing.truth_state === "PARTIALLY_ESTABLISHED",
     JSON.stringify(standing.standing));
  ok("72 units", standing.position.units === 72, String(standing.position.units));
  ok(`${totals.beds} rentable positions, the file's own bed total`,
     standing.position.rentable_positions === totals.beds, String(standing.position.rentable_positions));
  ok(`occupied agrees with the file's summary (${totals.occupied})`,
     standing.position.occupied === totals.occupied, String(standing.position.occupied));
  /*  THE SUBTRACTION, DELETED. `open = positions - occupied` is the defect
   *  this correction exists to remove, and it was written here as the
   *  intended behaviour. Open now requires a POSITIVE vacancy basis; with
   *  no opening position this fixture has none, so Open is 0 and the
   *  un-leased beds are counted as not_established instead of being
   *  offered to a prospect.  */
  ok("Open is 0 — no positive vacancy evidence exists in this fixture",
     standing.position.open === 0, String(standing.position.open));
  ok("the un-leased beds are not_established, not Open",
     standing.position.not_established === totals.beds - totals.occupied,
     `${standing.position.not_established} vs ${totals.beds - totals.occupied}`);
  ok("occupied + not_established accounts for every rentable position",
     standing.position.occupied + standing.position.not_established
       + standing.position.activation_pending + standing.position.needs_review
       === standing.position.rentable_positions,
     JSON.stringify(standing.position));
  ok("the leasing grain is read from the inventory, not configured",
     standing.position.leasing_grain === "bed", standing.position.leasing_grain);
  ok("as_of is the artifact's own date, echoed back",
     standing.as_of === AS_OF, `${standing.as_of} vs ${AS_OF}`);

  console.log("\n  ── ONE canonical read. The sentence cannot contradict the screen ──");
  ok("units: standing === rent roll surface",
     standing.position.units === screen.totals.units,
     `${standing.position.units} vs ${screen.totals.units}`);
  ok("rentable positions: standing === rent roll surface",
     standing.position.rentable_positions === screen.totals.rentable_positions,
     `${standing.position.rentable_positions} vs ${screen.totals.rentable_positions}`);
  ok("occupied: standing === rent roll surface",
     standing.position.occupied === screen.totals.occupied,
     `${standing.position.occupied} vs ${screen.totals.occupied}`);
  ok("open: standing === rent roll surface",
     standing.position.open === screen.totals.open,
     `${standing.position.open} vs ${screen.totals.open}`);
  ok("positions with a known next: standing === rent roll surface",
     standing.position.positions_with_a_known_next === screen.totals.with_next_known,
     `${standing.position.positions_with_a_known_next} vs ${screen.totals.with_next_known}`);

  console.log("\n  ── the unknowns are carried, not smoothed ──");
  ok("occupied positions with no recorded rent are COUNTED",
     typeof standing.unknowns.occupied_positions_with_no_recorded_rent === "number",
     JSON.stringify(standing.unknowns));
  ok("and that count matches the surface's own not-in-source total",
     standing.unknowns.occupied_positions_with_no_recorded_rent === screen.totals.rent_not_in_source,
     `${standing.unknowns.occupied_positions_with_no_recorded_rent} vs ${screen.totals.rent_not_in_source}`);
  ok("every unknown is a count, never a percentage or a rate",
     Object.entries(standing.unknowns).every(([k, v]) =>
       Number.isInteger(v) && !/percent|pct|rate|ratio/i.test(k)),
     JSON.stringify(standing.unknowns));
  ok("the position block is counts only — no occupancy percentage is offered",
     Object.entries(standing.position).every(([k, v]) =>
       (Number.isInteger(v) || typeof v === "string") && !/percent|pct|rate|ratio/i.test(k)),
     JSON.stringify(standing.position));

  console.log("\n  ── established_from names the source, so the answer can be walked back ──");
  ok("the opening source file is named",
     standing.established_from && /RentRoll07_1417/.test(standing.established_from.source_file),
     JSON.stringify(standing.established_from));
  ok("with its own as-of date and confidence",
     standing.established_from
     && standing.established_from.source_as_of === AS_OF
     && standing.established_from.confidence === "confirmed",
     JSON.stringify(standing.established_from));
  /*  ⚠ THE UPSTREAM KEY, READ BY NAME. This is the assertion that found
   *  the defect: opening_truth.source_as_of_date came back "Fri Jul 31"
   *  — String(a Date).slice(0, 10) — with no year, and index.html renders
   *  it to an operator verbatim ("· as of Fri Jul 31"). Every count
   *  around it was correct, so nothing else noticed.
   *
   *  Pinned here by its exact name because an API output key is a
   *  contract (CLAUDE.md), and this one is consumed by the app, by
   *  rent_roll_unit_view, by future_rent_roll_facts and by
   *  rent_roll_canonical. The next date-handling sweep breaks it
   *  silently unless something reads it by name.  */
  const upstream = screen.opening_truth && screen.opening_truth.latest_confirmed_source;
  ok("opening_truth.source_as_of_date is an ISO date, not a truncated Date.toString()",
     !!upstream && /^\d{4}-\d{2}-\d{2}$/.test(String(upstream.source_as_of_date)),
     JSON.stringify(upstream && upstream.source_as_of_date));
  ok("and it is the artifact's own date, to the day",
     !!upstream && upstream.source_as_of_date === AS_OF,
     `${upstream && upstream.source_as_of_date} vs ${AS_OF}`);

  console.log("\n  ── the next milestone is a RECORDED boundary, not a forecast ──");
  const ms = standing.next_milestone;
  ok("a milestone is returned", !!ms, JSON.stringify(ms));
  if (ms) {
    const real = (await pool.query(
      `select count(*)::int n from leases
        where property_id=$1 and (start_date=$2::date or end_date=$2::date)`, [prop, ms.on])).rows[0].n;
    ok("its date is a real lease boundary in the database", real > 0, `${ms.on} matched ${real} lease(s)`);
    ok("it is dated after the as_of, not on or before it", ms.on > AS_OF, `${ms.on} vs ${AS_OF}`);
    ok("it counts the positions affected rather than listing forty of them",
       Number.isInteger(ms.positions_affected) && ms.positions_affected > 0
       && !Array.isArray(ms.positions),
       JSON.stringify(ms));
    ok("and says whether every affected commitment is natively proven",
       typeof ms.all_proven === "boolean", JSON.stringify(ms));
  }

  console.log("\n  ── as_of is a PARAMETER. One model, two dates ──");
  const later = await tenancy.readTenancyStanding(pool, { property_id: prop, as_of: plusDays(AS_OF, 10) });
  ok("the same database answers differently ten days on",
     later.position.occupied !== standing.position.occupied,
     `${standing.position.occupied} at ${AS_OF} → ${later.position.occupied} at ${plusDays(AS_OF, 10)}`);
  ok("because the future commitments became current, not because a second store was read",
     later.position.occupied > standing.position.occupied
     && later.position.rentable_positions === standing.position.rentable_positions,
     JSON.stringify(later.position));
  console.log(`        ${AS_OF}: ${standing.position.occupied} occupied · ` +
              `${plusDays(AS_OF, 10)}: ${later.position.occupied} occupied ` +
              `(${standing.position.positions_with_a_known_next} were committed)`);

  console.log("\n  ── the four silences do not collapse (§40.7) ──");
  const empty = await tenancy.readTenancyStanding(pool, { property_id: emptyProp, as_of: AS_OF });
  ok("a property with no inventory is NOT_ESTABLISHED",
     empty.standing.truth_state === tenancy.NOT_ESTABLISHED, JSON.stringify(empty.standing));
  //  THE ASSERTION THIS WHOLE BLOCK EXISTS FOR. Returning occupied: 0 here
  //  would let a fluent sentence say "nobody lives there" about a building
  //  Spine has simply never been told about.
  ok("and returns NO position block at all — never occupied: 0",
     empty.position === null && empty.unknowns === null, JSON.stringify(empty.position));
  ok("it says WHY it is not established, in a sentence",
     typeof empty.standing.why === "string" && empty.standing.why.length > 20, empty.standing.why);
  ok("and it still names what it does not establish",
     Array.isArray(empty.does_not_establish) && empty.does_not_establish.length > 0);

  //  READ_FAILED IS A DIFFERENT FACT. A pool that cannot answer must
  //  THROW, so the composer records READ_FAILED — a read that swallowed
  //  the error and returned NOT_ESTABLISHED would report a broken Spine
  //  as an un-onboarded building.
  let threw = null;
  try {
    await tenancy.readTenancyStanding(
      { query: async () => { throw new Error("connection terminated"); },
        connect: async () => { throw new Error("connection terminated"); } },
      { property_id: prop, as_of: AS_OF });
  } catch (e) { threw = e; }
  ok("a failed read THROWS — it never degrades into NOT_ESTABLISHED", !!threw,
     "the read swallowed a database failure and reported a property state instead");
  ok("and a missing property_id is refused outright", await (async () => {
    try { await tenancy.readTenancyStanding(pool, {}); return false; } catch (_) { return true; }
  })());

  console.log("\n  ── the contract itself ──");
  ok("truth walls are declared as data, not prose",
     Array.isArray(standing.truth_walls) && standing.truth_walls.length >= 5,
     String(standing.truth_walls && standing.truth_walls.length));
  ok("the walls include occupied ≠ paying and open ≠ available",
     standing.truth_walls.some((w) => /occupied ≠ paying/.test(w))
     && standing.truth_walls.some((w) => /open ≠ available/.test(w)),
     JSON.stringify(standing.truth_walls));
  ok("retrieval is claimed; comparison and causal explanation are NOT",
     standing.capability_classes.retrieval.claim === "claimed"
     && standing.capability_classes.comparison.claim === "not_claimed"
     && standing.capability_classes.causal_explanation.claim === "not_claimed",
     JSON.stringify(standing.capability_classes));
  ok("cross-domain composition authorization is carried as unsolved, not assumed solved",
     standing.composition_authorization === "unsolved_cross_domain");
  ok("does_not_establish names availability and comparison out loud",
     standing.does_not_establish.some((s) => /availability/i.test(s))
     && standing.does_not_establish.some((s) => /comparison|another property|market/i.test(s)),
     JSON.stringify(standing.does_not_establish));

  console.log("\n  ── compact, and free of identifiers (§40.6, §40.8) ──");
  const leaks = findIdentifiers(standing);
  ok("no record id or uuid reaches the caller", leaks.length === 0, leaks.join(", "));
  const bytes = JSON.stringify(standing).length;
  ok(`the whole domain fits in one small object (${bytes} bytes, 160 positions behind it)`,
     bytes < 4096, `${bytes} bytes — this is meant to be gathered routinely`);
  ok("no array of positions is smuggled through",
     !Object.values(standing).some((v) => Array.isArray(v) && v.length > 12));

  await pool.end();
  console.log("");
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 34 }));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(receipt.died(__filename, e, ran));
});
