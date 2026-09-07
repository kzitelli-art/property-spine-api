/*
 * canonical_occupancy_holds.db.js — occupancy over canonical positions under
 * unit holds.
 *
 * A small native bed-grain property makes the membership question visible:
 * 301|Room1 and 302|Room1 are two ordinary active leases; 303|Room1 has two
 * overlapping active leases; the other five beds have no lease. Down is a
 * physical exclusion from the occupancy set, while the tenancy summary and
 * trusted rent continue to describe the recorded lease facts.
 *
 * The default is the successor contract. PROOF_EXPECT_DEFECT=1 records the
 * current candidate arithmetic (the parent observation) so the old numerator
 * and overlapping exclusion are visible before the implementation changes.
 *
 * Run through the owned proof wrapper with E2E_PROOF_MANIFEST and
 * E2E_API_BASE pointing at the already booted service. The fixture is written
 * to the disposable database and the HTTP reads use the issued session.
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const sessions = require(path.join(root, "src/identity/staff_session_service.js"));
const { currentRentRoll } = require(path.join(root, "src/surfaces/rent_roll_canonical.js"));
const { institutionalRentRoll } = require(path.join(root, "src/surfaces/rent_roll_institutional.js"));
const AS_OF = "2026-07-31";
const api = String(process.env.E2E_API_BASE || "").replace(/\/+$/, "");
const parent = process.env.PROOF_EXPECT_DEFECT === "1";

let passed = 0;
let failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};

function holdExpectation(label) {
  if (label === "baseline" || label === "restore") return { occupied: 2, denominator: 7, pct: 28.57 };
  if (label === "down301") return parent
    ? { occupied: 2, denominator: 5, pct: 40 }
    : { occupied: 1, denominator: 5, pct: 20 };
  if (label === "down301-303") return parent
    ? { occupied: 2, denominator: 1, pct: 200 }
    : { occupied: 0, denominator: 2, pct: 0 };
  if (label === "downAll") return parent
    ? { occupied: 2, denominator: -1, pct: -200 }
    : { occupied: 0, denominator: 0, pct: null };
  throw new Error("unknown hold expectation " + label);
}

(async () => {
  await boundary.assertDatabase();
  if (!api) throw new Error("E2E_API_BASE is required; this proof exercises HTTP doors");
  const manifest = boundary.manifest();
  const pool = new Pool({ connectionString: manifest.url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const all = async (sql, args = []) => (await pool.query(sql, args)).rows;

  async function http(pathname, token = null, { wrongKey = false, key = null, method = 'GET', body: requestBody = null } = {}) {
    const headers = {};
    if (token) headers["x-staff-session"] = token;
    if (wrongKey) headers["x-operator-key"] = "wrong-proof-key";
    else if (key) headers["x-operator-key"] = key;
    if (requestBody) headers['content-type'] = 'application/json';
    const r = await fetch(api + pathname, { headers, method,
      body: requestBody ? JSON.stringify(requestBody) : undefined,
      signal: AbortSignal.timeout(30000) });
    const bytes = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get("content-type") || "";
    let body = null;
    if (type.includes("json") && bytes.length) body = JSON.parse(bytes.toString("utf8"));
    return { status: r.status, body, text: bytes.toString("utf8"), type };
  }

  try {
    const tag = `canonical-holds-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const person = async (name) => (await one("insert into persons(name) values($1) returning id", [name])).id;
    const operatorPerson = await person(`${tag}-operator`);
    const operator = await one(`insert into users
      (name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`,
      [`${tag} operator`, `${tag}@example.test`, org.id, operatorPerson]);
    const residentIds = {
      A: await person(`${tag}-resident-a`),
      B: await person(`${tag}-resident-b`),
      C1: await person(`${tag}-resident-c1`),
      C2: await person(`${tag}-resident-c2`),
    };
    const property = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'bed') returning id`, [`${tag} property`, org.id]);
    await pool.query(`insert into property_team_assignments
      (property_id,user_id,role_title,allowed_modules,active)
      values($1,$2,'Proof Seat','{management,leasing}',true)`, [property.id, operator.id]);

    const units = {};
    const spaces = {};
    for (const unitNumber of ["301", "302", "303", "304"]) {
      const unit = await one("insert into units(property_id,unit_number) values($1,$2) returning id",
        [property.id, unitNumber]);
      units[unitNumber] = unit.id;
      const first = await one("select id from spaces where unit_id=$1", [unit.id]);
      spaces[`${unitNumber}|Room1`] = (await one(`update spaces
        set space_label='Room1', position_kind='bed', use_type='residential'
        where id=$1 returning id`, [first.id])).id;
      spaces[`${unitNumber}|Room2`] = (await one(`insert into spaces
        (unit_id,space_label,position_kind,use_type)
        values($1,'Room2','bed','residential') returning id`, [unit.id])).id;
    }

    const lease = async (key, resident, rent, from = "2026-01-01", to = "2027-12-31") =>
      (await one(`insert into leases
        (property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status)
        values($1,$2,$3,$4,$5,$6,'active') returning id`,
      [property.id, spaces[key], [residentIds[resident]], rent, from, to])).id;
    await lease("301|Room1", "A", 850);
    await lease("302|Room1", "B", 900);
    await lease("303|Room1", "C1", 700);
    await lease("303|Room1", "C2", 750, "2026-03-01", "2027-02-28");

    const leaseSnapshot = await all(`select id,space_id,tenant_ids,rent,start_date,end_date,lease_status
      from leases where property_id=$1 order by id`, [property.id]);
    ok("fixture has 8 canonical bed positions", (await one(`select count(*)::int as n from spaces s
      join units u on u.id=s.unit_id where u.property_id=$1`, [property.id])).n === 8);
    ok("fixture has two ordinary leases and two contested claims", leaseSnapshot.length === 4);

    const client = await pool.connect();
    let token;
    try {
      await client.query("begin");
      token = (await sessions.issueStaffSession(client, {
        userId: operator.id, propertyId: property.id, purpose: "bootstrap_invite",
      })).session_token;
      await client.query("commit");
    } finally { client.release(); }

    const unauthorized = await http("/operator/rent-roll/canonical", null, { wrongKey: true });
    ok("a wrong operator key cannot substitute for a session", unauthorized.status === 401, String(unauthorized.status));
    const spoof = await http(`/operator/rent-roll/canonical?as_of=${AS_OF}&property_id=00000000-0000-0000-0000-000000000000`, token);
    ok("canonical scope is session-owned", spoof.status === 200 && spoof.body.property_id === property.id,
      JSON.stringify(spoof.body && spoof.body.property_id));

    const read = async (label) => {
      const service = await currentRentRoll(pool, { property_id: property.id, as_of: AS_OF });
      const institutional = await institutionalRentRoll(pool, { property_id: property.id, as_of: AS_OF });
      const canonicalHttp = await http(`/operator/rent-roll/canonical?as_of=${AS_OF}`, token);
      const institutionalHttp = await http(`/operator/rent-roll/institutional?as_of=${AS_OF}`, token);
      const csvHttp = await http(`/operator/rent-roll/institutional?as_of=${AS_OF}&format=csv`, token);
      ok(`${label}: canonical JSON is available`, canonicalHttp.status === 200 && canonicalHttp.body.property_id === property.id);
      ok(`${label}: institutional JSON is available`, institutionalHttp.status === 200 && institutionalHttp.body.report.property_id === property.id);
      ok(`${label}: institutional CSV is available`, csvHttp.status === 200 && /text\/csv/i.test(csvHttp.type));
      const occ = canonicalHttp.body.totals.confirmed_contractual_occupancy;
      const expected = holdExpectation(label);
      ok(`${label}: canonical occupancy is ${expected.occupied}/${expected.denominator}`, occ.occupied === expected.occupied
        && occ.of_leasable_resolved === expected.denominator && occ.pct === expected.pct,
      JSON.stringify({ actual: occ, expected }));
      const instTotals = institutionalHttp.body.totals;
      ok(`${label}: institutional JSON carries the same occupancy`, instTotals.confirmed_contractual_occupancy === expected.occupied
        && instTotals.occupancy_denominator === expected.denominator);
      ok(`${label}: CSV carries the same occupancy`, csvHttp.text.includes(
        `Confirmed contractual occupancy,${expected.occupied} of ${expected.denominator}`));
      ok(`${label}: canonical service carries the expected occupancy`, service.totals.confirmed_contractual_occupancy.occupied === expected.occupied
        && service.totals.confirmed_contractual_occupancy.of_leasable_resolved === expected.denominator
        && service.totals.confirmed_contractual_occupancy.pct === expected.pct);
      ok(`${label}: institutional service carries the same occupancy`, institutional.totals.confirmed_contractual_occupancy === expected.occupied
        && institutional.totals.occupancy_denominator === expected.denominator);
      ok(`${label}: canonical service and HTTP rows agree`, service.rows.length === canonicalHttp.body.rows.length);
      ok(`${label}: tenancy summary retains two occupied positions`, canonicalHttp.body.tenancy_summary.contractually_occupied === 2);
      ok(`${label}: trusted rent remains 1750`, canonicalHttp.body.totals.contractual_rent_trusted === 1750
        && institutionalHttp.body.totals.trusted_monthly_contractual_rent === 1750);
      ok(`${label}: contested and evidence counts remain stable`, canonicalHttp.body.exceptions.contested === 1
        && canonicalHttp.body.contested_claims.lease_claims === 2
        && canonicalHttp.body.evidence_summary.inconclusive === 8);
      ok(`${label}: contested claims retain both lease facts`, canonicalHttp.body.contested_claims.claims.length === 2
        && canonicalHttp.body.contested_claims.claims.every((claim) => claim.space_id === spaces["303|Room1"]));
      return { canonical: canonicalHttp.body, service, institutional: institutionalHttp.body, csv: csvHttp.text };
    };

    const baseline = await read("baseline");
    const hold = async (number, resolve = false) => {
      const r = await http(`/units/${units[number]}/down${resolve ? '/resolve' : ''}`, null, {
        key: process.env.PROOF_OPERATOR_KEY || 'e2e-key',
        method: resolve ? 'PATCH' : 'POST',
        body: resolve ? { resolution_note: 'Synthetic hold restoration' }
          : { down_reason: 'hvac', down_blocker: 'Synthetic physical hold' },
      });
      ok(`${resolve ? 'resolve' : 'hold'} ${number}: existing HTTP owner succeeds`, r.status === (resolve ? 200 : 201));
    };
    await hold('301');
    const down301 = await read("down301");
    await hold('302');
    await hold('303');
    const down301to303 = await read("down301-303");
    await hold('304');
    const downAll = await read("downAll");
    const excluded = downAll.canonical.totals.confirmed_contractual_occupancy.excluded_from_denominator;
    ok(parent ? "parent exposes the contested/down overlap" : "all-down exclusion buckets are disjoint",
      parent ? (excluded.down === 8 && excluded.contested === 1) : (excluded.down === 8 && excluded.contested === 0));
    for (const number of ['301', '302', '303', '304']) await hold(number, true);
    const restored = await read("restore");
    ok("restoring holds returns the baseline occupancy", restored.canonical.totals.confirmed_contractual_occupancy.occupied === baseline.canonical.totals.confirmed_contractual_occupancy.occupied
      && restored.canonical.totals.confirmed_contractual_occupancy.of_leasable_resolved === baseline.canonical.totals.confirmed_contractual_occupancy.of_leasable_resolved
      && restored.canonical.totals.confirmed_contractual_occupancy.pct === baseline.canonical.totals.confirmed_contractual_occupancy.pct);
    const leaseAfter = await all(`select id,space_id,tenant_ids,rent,start_date,end_date,lease_status
      from leases where property_id=$1 order by id`, [property.id]);
    ok("holds preserve native lease bytes", JSON.stringify(leaseAfter) === JSON.stringify(leaseSnapshot));
    ok("restored trusted rent matches baseline", restored.canonical.totals.contractual_rent_trusted === 1750);
    if (!parent && failed === 0 && process.env.PROOF_HOLDS_BROWSER === '1') {
      if (!process.env.PROOF_OUTPUT_DIR) throw new Error('Owned private output is required for browser fixtures');
      for (const number of ['301', '302', '303', '304']) await hold(number);
      const final = await currentRentRoll(pool, { property_id: property.id });
      const finalOccupancy = final.totals.confirmed_contractual_occupancy;
      ok('browser fixture has an empty eligible population, with null percentage',
        finalOccupancy.occupied === 0 && finalOccupancy.of_leasable_resolved === 0 && finalOccupancy.pct === null);
      if (failed === 0) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, 'holds-state.private.json'),
        JSON.stringify({ proof: 'canonical_occupancy_holds', version: 1, token,
          property_id: property.id, occupied: 0, denominator: 0 }), { mode: 0o600 });
    }
  } finally {
    await pool.end();
  }
  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; });
