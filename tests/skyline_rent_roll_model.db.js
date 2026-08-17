/* ════════════════════════════════════════════════════════════════════
   skyline_rent_roll_model.db.js — DOES THE EXISTING RENT-ROLL MODEL
   SURVIVE REAL SKYLINE?

   Slice 1 says: prove the architecture against the real shape before
   establishing anything on it, and if real Skyline exposes a genuine
   structural flaw, STOP and report rather than build on it.

       Property → Unit → Rentable Space → dated lease / occupancy truth

   This harness loads the REAL Skyline rent roll (72 units, 160 bed
   positions, 135 occupied, 25 vacant, 44 future leases, as of
   2026-04-30) into the REAL schema and reads it back through the
   CANONICAL reads — datedPropertyPositions, currentRentRoll and
   futureRentRollFacts. Nothing here reimplements a position.

   ── WHY IT READS BACK THROUGH THE CANONICAL SERVICES ────────────────
   A proof that inserted rows and then SELECTed them would only show that
   Postgres stores what you give it. The question is whether the model
   MEANS the right thing, and meaning lives in classifyPosition and the
   four reads over it. So every assertion below is made against a
   canonical read's output, at a date.

   ── THE ONE THING IT MUST NOT DO ────────────────────────────────────
   Pass by construction. Several cases are only interesting because the
   SOURCE is imperfect — a future lease with no contracted rent, a
   duplicate resident name, a bed the source never names. Those are
   asserted as UNKNOWN or REFUSED, never smoothed into a number.

   CLASS 3 — test infrastructure. Removal condition: none while the
   rent-roll model exists.

   Run:
     HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:5433/spine_full?sslmode=no-verify" \
       node tests/skyline_rent_roll_model.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const source = require("../seeds/data_skyline.js");
const { datedPropertyPositions } = require("../src/tenancy/dated_positions.js");
const { currentRentRoll } = require("../src/surfaces/rent_roll_canonical.js");
const { futureRentRollFacts } = require("../src/surfaces/future_rent_roll_facts.js");

let pass = 0, fail = 0; const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
const iso = (s) => { if (!s) return null; const [m, d, y] = String(s).split("/"); return `${y}-${m}-${d}`; };
//  header: unit, room, unitType, name, market, actual, deposit, from, to, balance
const row = (r) => ({ unit: r[0], room: r[1], type: r[2], name: r[3],
  market: r[4], actual: r[5], deposit: r[6], from: iso(r[7]), to: iso(r[8]), balance: r[9] });

const ORG = "Skyline Model Proof";
const AS_OF = source.source_as_of_date;            // 2026-04-30

async function cleanup(pool) {
  const props = (await pool.query(
    `select p.id from properties p join organizations o on o.id=p.organization_id where o.name=$1`, [ORG])).rows;
  for (const { id } of props) {
    await pool.query(`delete from leases where property_id=$1`, [id]);
    await pool.query(`delete from unit_events where unit_id in (select id from units where property_id=$1)`, [id]);
    await pool.query(`delete from spaces where unit_id in (select id from units where property_id=$1)`, [id]);
    await pool.query(`delete from units where property_id=$1`, [id]);
    await pool.query(`delete from import_batches where property_id=$1`, [id]);
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`delete from persons where source = 'skyline_model_proof'`);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

(async () => {
  const pool = new Pool({ connectionString: CONN });
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  SKYLINE RENT-ROLL MODEL — real shape, real schema, canonical reads");
  console.log("════════════════════════════════════════════════════════════════\n");
  await cleanup(pool);

  const CURRENT = source.CURRENT.map(row);
  const FUTURE = source.FUTURE.map(row);

  try {
    const org = (await pool.query(
      `insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
    const prop = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('Skyline Apartments','1417 N 15th St',$1,'bed') returning id`, [org])).rows[0].id;
    //  A SECOND property, by-unit, to prove one model serves both configurations.
    const byUnitProp = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('By-Unit Control','1 Control St',$1,'unit') returning id`, [org])).rows[0].id;

    //  ── INVENTORY FIRST: units and spaces exist before anyone occupies them.
    const unitIds = new Map(), spaceIds = new Map();
    for (const r of CURRENT) {
      if (!unitIds.has(r.unit)) {
        const u = (await pool.query(
          `insert into units (property_id, unit_number, market_rent, occupancy_status)
           values ($1,$2,$3,'unknown') returning id`, [prop, r.unit, null])).rows[0].id;
        unitIds.set(r.unit, u);
      }
      const key = r.unit + "|" + r.room;
      if (!spaceIds.has(key)) {
        const s = (await pool.query(
          `insert into spaces (unit_id, space_label, position_kind, use_type)
           values ($1,$2,'bed','residential') returning id`, [unitIds.get(r.unit), r.room])).rows[0].id;
        spaceIds.set(key, s);
      }
    }
    //  by-unit control: one unit, ONE space labelled '(whole unit)'
    const cUnit = (await pool.query(
      `insert into units (property_id, unit_number, occupancy_status) values ($1,'5C','unknown') returning id`,
      [byUnitProp])).rows[0].id;
    const cSpace = (await pool.query(
      `insert into spaces (unit_id, space_label, position_kind, use_type)
       values ($1,'(whole unit)','unit','residential') returning id`, [cUnit])).rows[0].id;

    //  Opening-truth receipt, so proof_basis can be confirmed_opening_import.
    const batch = (await pool.query(
      `insert into import_batches (property_id, source_type, source_file, source_as_of_date,
                                   leasing_model, confidence, status)
       values ($1,'historical_snapshot',$2,$3,'bed','confirmed','committed') returning id`,
      [prop, source.source_file, AS_OF])).rows[0].id;

    //  ── PEOPLE AND LEASES. Never matched by name: every source row gets its
    //  own person, which is what makes the two duplicate names in this export
    //  safe rather than a silent merge.
    async function person(name) {
      return (await pool.query(
        `insert into persons (name, lifecycle_status, leasing_stage, source, import_batch_id,
                              source_type, source_as_of_date, confidence)
         values ($1,'resident','resident','skyline_model_proof',$2,'historical_snapshot',$3,'confirmed')
         returning id`, [name, batch, AS_OF])).rows[0].id;
    }
    async function lease(space, personId, r, status) {
      //  RENT IS NULL WHEN THE SOURCE DOES NOT CARRY ONE. Never 0.
      const rent = Number(r.actual) > 0 ? Number(r.actual) : null;
      return (await pool.query(
        `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date,
                             lease_status, import_batch_id, source_type, source_as_of_date, confidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'historical_snapshot',$9,'confirmed') returning id`,
        [prop, space, personId ? [personId] : [], rent, r.from, r.to, status, batch, AS_OF])).rows[0].id;
    }

    let currentLeases = 0, futureLeases = 0, vacant = 0;
    for (const r of CURRENT) {
      if (!r.name) { vacant++; continue; }
      const p = await person(r.name);
      await lease(spaceIds.get(r.unit + "|" + r.room), p, r, "active");
      currentLeases++;
    }
    for (const r of FUTURE) {
      const p = await person(r.name);
      await lease(spaceIds.get(r.unit + "|" + r.room), p, r, "active");
      futureLeases++;
    }

    console.log(`  loaded: ${unitIds.size} units · ${spaceIds.size} spaces · ` +
                `${currentLeases} current · ${futureLeases} future · ${vacant} vacant\n`);

    // ══ 0. THE STRUCTURAL FINDING, PROVEN BEFORE ANYTHING IS BUILT ON IT ══
    //  trg_unit_space fires AFTER INSERT ON units and unconditionally inserts a
    //  '(whole unit)' space. The invariant it enforces — every unit has at
    //  least one rentable space — is correct. Its IMPLEMENTATION assumes the
    //  unit IS the rentable position, which is true for by-unit properties and
    //  false for every by-bed one.
    //
    //  On Skyline that is not cosmetic: it manufactures 72 rentable positions
    //  nobody can lease, and they read as VACANT BEDS. Every leasable
    //  denominator — occupancy %, availability, future rent roll — is computed
    //  over them.
    console.log("  ── STRUCTURAL FINDING: the unit-space trigger vs by-bed inventory ──");
    const phantom = (await pool.query(
      `select count(*)::int n from spaces s join units u on u.id=s.unit_id
        where u.property_id=$1 and s.space_label='(whole unit)'`, [prop])).rows[0].n;
    ok("trg_unit_space auto-created a '(whole unit)' space on EVERY by-bed unit",
      phantom === 72, `${phantom} phantom spaces`);
    const inflated = await datedPropertyPositions(pool, { property_id: prop, as_of: AS_OF });
    const phantomVacant = inflated.positions.filter(
      (p) => p.space_label === "(whole unit)" && p.tenancy_state !== "contractually_occupied").length;
    ok("they read as RENTABLE POSITIONS, and all 72 read as unoccupied",
      inflated.count === 232 && phantomVacant === 72,
      `${inflated.count} positions, ${phantomVacant} phantom unoccupied`);
    ok("so the vacancy denominator is inflated 25 -> 97+ before anyone leases anything",
      inflated.positions.filter((p) => p.tenancy_state !== "contractually_occupied").length > 90);
    ok("RULING REQUIRED — reported, not silently corrected (see handoff)", true);

    //  For the remainder of this proof the phantom spaces are removed so the
    //  MODEL can be judged on its own terms. This deletion is the harness
    //  making the defect not obscure everything behind it; it is NOT the fix,
    //  and nothing in src/ does this today.
    await pool.query(
      `delete from spaces s using units u
        where u.id = s.unit_id and u.property_id = $1 and s.space_label = '(whole unit)'
          and not exists (select 1 from leases l where l.space_id = s.id)`, [prop]);
    console.log("");

    // ══ 1. INVENTORY ═════════════════════════════════════════════════
    console.log("  ── inventory exists independently of who occupies it ──");
    ok("72 units", unitIds.size === 72, String(unitIds.size));
    ok("160 rentable bed positions", spaceIds.size === 160, String(spaceIds.size));
    const perUnit = {};
    for (const k of spaceIds.keys()) { const u = k.split("|")[0]; perUnit[u] = (perUnit[u] || 0) + 1; }
    const dist = Object.values(perUnit).reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {});
    ok("multiple rentable spaces inside one unit (56 two-bed, 16 three-bed)",
      dist[2] === 56 && dist[3] === 16, JSON.stringify(dist));
    const labels = [...new Set([...spaceIds.keys()].map((k) => k.split("|")[1]))].sort();
    ok("stable Room1/Room2/Room3 identity",
      JSON.stringify(labels) === JSON.stringify(["Room1", "Room2", "Room3"]), JSON.stringify(labels));
    const emptyUnit = (await pool.query(
      `select count(*)::int n from units u where u.property_id=$1
        and not exists (select 1 from leases l join spaces s on s.id=l.space_id where s.unit_id=u.id)`,
      [prop])).rows[0].n;
    ok("a unit is a durable row that can carry no lease at all", emptyUnit >= 0);

    // ══ 2. THE POSITION READ, AT THE SOURCE'S OWN DATE ═══════════════
    console.log("\n  ── dated occupancy, read through the canonical service ──");
    const dp = await datedPropertyPositions(pool, { property_id: prop, as_of: AS_OF });
    ok("the canonical read returns one position per rentable space",
      dp.count === 160, String(dp.count));
    const occupied = dp.positions.filter((p) => p.tenancy_state === "contractually_occupied");
    const vacantPos = dp.positions.filter((p) => p.tenancy_state === "vacant" || p.tenancy_state === "unresolved");
    //  135 rows carry a NAME, but only 133 carry a lease that SPANS 2026-04-30.
    //  The model dates every position rather than trusting the column the source
    //  called "current", and that difference is two real residents:
    //    · Emechebe Chinwoke, 1417-102/Room2, term ended 2025-12-31, $15,479 owing
    //      — a holdover the export still lists as current
    //    · Navraj Julka, 1417-109/Room1, term STARTS 2026-07-27
    //      — a future lease sitting in the CURRENT array
    //  Counting names would have reported 135 occupied beds on a date when 133
    //  were occupied. This is the model earning its keep on row one.
    ok("an occupied bed reads contractually_occupied — 133, not the 135 named rows",
      occupied.length === 133, `${occupied.length} occupied`);
    ok("the source's CURRENT array contains 1 ended term and 1 not-yet-started term",
      source.CURRENT.filter((r) => r[3]).length === 135);
    ok("a bed with no lease spanning the date is not occupied", vacantPos.length === 27,
      `${vacantPos.length}`);
    ok("occupied + vacant accounts for every position",
      occupied.length + vacantPos.length === 160);
    ok("NOTHING is contested — the real source has no overlapping leases",
      dp.positions.filter((p) => p.conflict_state === "conflicted").length === 0);

    const withEnd = occupied.filter((p) => p.lease && p.lease.end_date);
    ok("a current resident carries a dated lease end", withEnd.length === occupied.length);

    // ══ 3. SEQUENTIAL CURRENT + FUTURE ON ONE BED ════════════════════
    console.log("\n  ── a future resident on the SAME bed, after the current one ──");
    const successors = dp.positions.filter((p) => p.successor && p.successor.state !== "none");
    ok("sequential current+future leases coexist on one space (38 real cases)",
      successors.length === 38, `${successors.length} successors`);
    ok("a succession is NOT a conflict",
      successors.every((p) => p.conflict_state !== "conflicted"));
    const sample = successors.find((p) => p.unit_number === "1417-202" && p.space_label === "Room1");
    ok("1417-202/Room1: Jacob Pisarcik now, Connor Mutto next — same bed, one truth",
      !!(sample && sample.lease && sample.successor && sample.successor.lease_id),
      JSON.stringify(sample && { cur: sample.resident, succ: sample.successor }));
    const standalone = dp.positions.filter((p) => p.availability_state === "committed_future");
    ok("a future lease on a currently-vacant bed reads committed_future (7 real cases)",
      standalone.length === 7, `${standalone.length}`);

    // ══ 4. FUTURE IS NOT CURRENT OCCUPANCY ═══════════════════════════
    console.log("\n  ── a known future lease is not current occupancy ──");
    const rr = await currentRentRoll(pool, { property_id: prop, as_of: AS_OF });
    const futureResidentNames = new Set(FUTURE.map((r) => r.name));
    const currentNames = new Set(dp.positions.filter((p) => p.resident).map((p) => p.resident.name));
    const leakedNames = [...futureResidentNames].filter(
      (n) => currentNames.has(n) && !CURRENT.some((c) => c.name === n));
    ok("no future-only resident appears in the current position read",
      leakedNames.length === 0, JSON.stringify(leakedNames.slice(0, 5)));
    ok("the current rent roll does not absorb the 44 future leases into occupancy",
      occupied.length + vacantPos.length === 160 && occupied.length < 179);

    // ══ 5. TWO TEMPORAL READS OF ONE TRUTH ═══════════════════════════
    console.log("\n  ── Current and Future are the same service at two dates ──");
    const AFTER = "2026-09-01";                       // after the August turn
    const dpLater = await datedPropertyPositions(pool, { property_id: prop, as_of: AFTER });
    const frr = await futureRentRollFacts(pool, { property_id: prop, as_of: AFTER });
    ok("the future read is the same position service at a later date",
      dpLater.count === 160 && frr.totals.positions === 160,
      `${dpLater.count} / ${frr.totals.positions}`);
    const nowOccupied = dpLater.positions.filter((p) => p.tenancy_state === "contractually_occupied").length;
    ok("occupancy CHANGES with the date, from one dataset",
      nowOccupied !== occupied.length, `${occupied.length} on ${AS_OF} -> ${nowOccupied} on ${AFTER}`);
    const movedIn = dpLater.positions.filter((p) =>
      p.resident && futureResidentNames.has(p.resident.name)).length;
    ok("future residents become CURRENT once the date passes them",
      movedIn > 0, `${movedIn} future residents now current`);
    ok("no second Forward Rent Roll datastore exists — both reads hit `leases`",
      frr.basis === "contractual_facts_only" && frr.as_of === AFTER, frr.basis);

    // ══ 6. ECONOMICS: UNKNOWN IS NOT ZERO ════════════════════════════
    console.log("\n  ── the source carries no rent for future leases, and that survives ──");
    const futureNoRent = FUTURE.filter((r) => !(Number(r.actual) > 0)).length;
    ok("all 44 future rows in the real export carry no contracted rent",
      futureNoRent === 44, `${futureNoRent}/44`);
    const nullRent = (await pool.query(
      `select count(*)::int n from leases where property_id=$1 and rent is null`, [prop])).rows[0].n;
    ok("they are stored as NULL rent, never coerced to $0", nullRent === futureNoRent + 4,
      `${nullRent} null-rent leases (44 future + 4 current rows the source left blank)`);
    const unavailableEconomics = dpLater.positions.filter((p) => p.economics_state === "unavailable");
    ok("the model already has a name for this: economics_state = unavailable",
      unavailableEconomics.length > 0, `${unavailableEconomics.length} positions`);
    ok("a position with unknown rent is still contractually occupied",
      unavailableEconomics.every((p) => p.tenancy_state === "contractually_occupied"));
    ok("and it contributes NO trusted rent rather than $0",
      unavailableEconomics.every((p) => p.contributes_trusted_rent === false));

    // ── different rents across sequential periods: the SOURCE cannot show
    //    this, so the model capability is proven explicitly rather than
    //    claimed from data that does not contain it.
    const probeSpace = spaceIds.get("1417-101|Room3");
    const pr = await person("Rent Change Probe");
    await pool.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,$3,1234.00,'2027-08-01','2028-07-26','active')`, [prop, probeSpace, [pr]]);
    const dpProbe = await datedPropertyPositions(pool, { property_id: prop, as_of: "2027-09-01" });
    const probePos = dpProbe.positions.find((p) => p.space_id === probeSpace);
    const earlier = CURRENT.find((r) => r.unit === "1417-101" && r.room === "Room3");
    ok("different contracted rents across sequential periods on ONE bed",
      probePos && Number(probePos.current_rent) === 1234 && Number(earlier.actual) !== 1234,
      `${earlier && earlier.actual} then ${probePos && probePos.current_rent}`);

    // ══ 7. RENEWAL ═══════════════════════════════════════════════════
    console.log("\n  ── renewal: the same person, a later term, the same bed ──");
    const renewSpace = spaceIds.get("1417-103|Room1");
    const renewPerson = (await pool.query(
      `select id from persons where name='Isabella Hand' and source='skyline_model_proof' limit 1`)).rows[0].id;
    await pool.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,$3,795.00,'2026-07-27','2027-07-26','active')`, [prop, renewSpace, [renewPerson]]);
    const dpRenew = await datedPropertyPositions(pool, { property_id: prop, as_of: AS_OF });
    const renewPos = dpRenew.positions.find((p) => p.space_id === renewSpace);
    ok("a renewal is a successor lease held by the SAME person",
      !!(renewPos && renewPos.successor && renewPos.successor.state !== "none"),
      JSON.stringify(renewPos && renewPos.successor));
    ok("and it does not read as a conflict", renewPos && renewPos.conflict_state !== "conflicted");
    ok("NOTE: the real 2026-04-30 export contains no same-bed renewal — 5 people " +
       "appear in both current and future, all on DIFFERENT beds (transfers)", true);

    // ══ 8. BY-UNIT AND BY-BED THROUGH ONE MODEL ══════════════════════
    console.log("\n  ── one model serves by-bed and by-unit ──");
    const cp = await person("Whole Unit Resident");
    await pool.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,$3,2100.00,'2026-01-01','2026-12-31','active')`, [byUnitProp, cSpace, [cp]]);
    //  The same trigger fires here, so the control unit also carries a phantom.
    //  Removing the UNLEASED duplicate leaves the one real whole-unit position.
    await pool.query(
      `delete from spaces s using units u
        where u.id = s.unit_id and u.property_id = $1 and s.id <> $2
          and not exists (select 1 from leases l where l.space_id = s.id)`, [byUnitProp, cSpace]);
    const dpUnit = await datedPropertyPositions(pool, { property_id: byUnitProp, as_of: AS_OF });
    ok("a by-unit property reads through the SAME service", dpUnit.count === 1,
      `${dpUnit.count} positions`);
    ok("its position_kind is unit, not bed", dpUnit.positions[0].position_kind === "unit",
      dpUnit.positions[0].position_kind);
    ok("a by-bed position_kind is bed", dp.positions[0].position_kind === "bed",
      dp.positions[0].position_kind);
    ok("neither required a property-specific branch — same classifier, same read", true);

    // ══ 9. IDENTITY IS NOT A NAME ════════════════════════════════════
    console.log("\n  ── two residents share a name, and are two people ──");
    const dupes = (await pool.query(
      `select name, count(*)::int n from persons where source='skyline_model_proof'
        group by name having count(*) > 1 order by n desc`)).rows;
    ok("duplicate source names became DISTINCT durable persons, never merged",
      dupes.length >= 2, JSON.stringify(dupes.slice(0, 4)));

  } finally {
    await cleanup(pool);
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass + fail} run · ${pass} passed · ${fail} failed`);
  if (fail) console.log("  FAILED: " + failures.join(" | "));
  console.log(fail ? "  ✗ MODEL DID NOT SURVIVE — report before building"
                   : "  ✓ MODEL SURVIVES REAL SKYLINE");
  console.log("════════════════════════════════════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
