/*
 * Occupancy and inventory-retirement boundary proof.
 *
 * The current occupancy owner counts live rentable inventory, but its
 * retirement predicate is the first red: retired units still participate in
 * occupancy and the leasing desk's available-unit list. The default successor
 * mode asserts the intended exclusion. PROOF_EXPECT_DEFECT=1 records the
 * unchanged parent behavior on the same synthetic fixture.
 *
 * This is a caller-owned disposable database proof. The retirement service is
 * called with a client whose transaction this proof owns. HTTP reads use the
 * existing session-scoped condition route and the existing operator-key
 * leasing dashboard. No provider, production, or real-user action occurs.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const api = String(process.env.E2E_API_BASE || "").replace(/\/+$/, "");
const operatorKey = process.env.PROOF_OPERATOR_KEY || process.env.E2E_OPERATOR_KEY || "e2e-key";
if (!api) throw new Error("E2E_API_BASE is required; this proof has no service fallback");

const { occupancyByBasis } = require(path.join(root, "src/leasing/leasing_occupancy_facts.js"));
const { leasingConditionFacts } = require(path.join(root, "src/leasing/leasing_condition_facts.js"));
const retirement = require(path.join(root, "src/tenancy/inventory_retirement.js"));

let passed = 0;
let failed = 0;
let proofStage = "startup";
const ok = (label, condition) => {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
};

function safeFailure(error) {
  const code = String((error && (error.code || error.name)) || "UNKNOWN")
    .replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const message = String((error && error.message) || "")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ").trim().slice(0, 180);
  return { code, message };
}

function writeFailureDiagnostic(error) {
  const outputDir = process.env.PROOF_OUTPUT_DIR;
  if (!outputDir) return;
  const safe = safeFailure(error);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "leasing-occupancy-retirement.failure.private.json"),
    JSON.stringify({ proof: "occupancy_retirement", version: 1, stage: proofStage, ...safe }, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 });
}

function dashboardRatioIs(read, expected) {
  const occupancy = read.dashboardOccupancy;
  return read.dashboardHttp.status === 200 && occupancy && occupancy.status === "ok"
    && Number.isFinite(Number(occupancy.value))
    && Math.abs(Number(occupancy.value) - (expected.occupied / expected.rentable)) < 1e-9;
}

function conditionOccupancyIs(payload, expected) {
  const occupancy = payload && payload.current_occupancy;
  return occupancy && !Object.prototype.hasOwnProperty.call(occupancy, "status")
    && occupancy.basis === expected.basis
    && occupancy.occupied === expected.occupied
    && occupancy.rentable === expected.rentable
    && occupancy.excluded === expected.excluded
    && Math.abs(Number(occupancy.ratio) - (expected.occupied / expected.rentable)) < 1e-9;
}

async function main() {
  proofStage = "boundary";
  await boundary.assertDatabase();
  const manifest = boundary.manifest();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  console.log(`LEASING_OCCUPANCY_RETIREMENT_MODE=${parent ? "positive_parent_defect" : "successor"}; BUSINESS_SHA=${sha}; BRANCH=${branch}`);

  const pool = new Pool({ connectionString: manifest.url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  const request = async (pathname, token = null, key = null) => {
    const headers = {};
    if (token) headers["x-staff-session"] = token;
    if (key) headers["x-operator-key"] = key;
    const response = await fetch(api + pathname, {
      headers, signal: AbortSignal.timeout(30000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let body = null;
    if ((response.headers.get("content-type") || "").includes("json") && bytes.length) {
      try { body = JSON.parse(bytes.toString("utf8")); } catch (_) { body = null; }
    }
    return { status: response.status, body };
  };

  try {
    proofStage = "fixture_org_operator";
    const tag = `occupancy-retirement-${Date.now()}`;
    const org = (await one("insert into organizations(name,slug) values($1,$1) returning id", [tag])).id;
    const person = (await one("insert into persons(name) values($1) returning id", [`${tag}-person`])).id;
    const operator = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`,
      [`${tag}-operator`, `${tag}@example.test`, org, person]);

    async function session(propertyId, modules = ["leasing"]) {
      await pool.query(`insert into property_team_assignments
          (property_id,user_id,role_title,allowed_modules,active)
        values($1,$2,'occupancy proof seat',$3,true)
        on conflict (property_id,user_id) do update
          set allowed_modules=excluded.allowed_modules, active=true`,
        [propertyId, operator.id, modules]);
      return tx(async (client) => {
        const { issueStaffSession } = require(path.join(root, "src/identity/staff_session_service.js"));
        return issueStaffSession(client, { userId: operator.id, propertyId, purpose: "sms_otp" });
      }).then((issued) => issued.session_token);
    }

    async function fixture(name, basis) {
      proofStage = `fixture_${name}`;
      const property = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
        values($1,$1,$2,$3) returning id`, [`${tag}-${name}`, org, basis]);
      const units = {};
      const spaces = {};
      async function makeUnit(number, labels) {
        const unit = await one("insert into units(property_id,unit_number) values($1,$2) returning id", [property.id, number]);
        units[number] = unit.id;
        const placeholder = await one("select id from spaces where unit_id=$1", [unit.id]);
        for (let index = 0; index < labels.length; index++) {
          const label = labels[index];
          const space = index === 0
            ? await one("update spaces set space_label=$2,position_kind='bed' where id=$1 returning id", [placeholder.id, label])
            : await one("insert into spaces(unit_id,space_label,position_kind) values($1,$2,'bed') returning id", [unit.id, label]);
          spaces[`${number}|${label}`] = space.id;
        }
      }
      // Target unit has no lease and can be retired. The sibling has one
      // active 850 lease plus three established non-revenue labels.
      await makeUnit("301", ["Room1", "Room2"]);
      await makeUnit("302", ["Room1", "down", "offline", "model"]);
      await pool.query("update spaces set use_type='residential' where unit_id in (select id from units where property_id=$1)", [property.id]);
      await pool.query(`insert into leases
          (property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status)
        values($1,$2,'{}',850,'2026-01-01','2027-12-31','active')`,
        [property.id, spaces["302|Room1"]]);
      return {
        id: property.id,
        basis,
        units,
        spaces,
        token: await session(property.id),
      };
    }

    const bed = await fixture("bed", "bed");
    const unit = await fixture("unit", "unit");
    // The schema intentionally permits only unit/bed/unknown. Use the legal
    // sentinel so the proof exercises the real unsupported-basis contract
    // without bypassing the database constraint.
    const unknown = await fixture("unknown", "unknown");
    const bedExpectedPre = { occupied: 1, rentable: 3, excluded: 3 };
    const unitExpectedPre = { occupied: 1, rentable: 2, excluded: 0 };

    async function reads(fixture, phase) {
      proofStage = `read_${fixture.basis || "missing"}_${phase}`;
      const direct = await occupancyByBasis(pool, fixture.id);
      const condition = await leasingConditionFacts(pool, fixture.id);
      const conditionHttp = await request("/operator/leasing/condition", fixture.token);
      const dashboardHttp = await request(`/properties/${fixture.id}/leasing-dashboard`, null, operatorKey);
      const dashboard = dashboardHttp.body || {};
      const headline = dashboard.headline || {};
      return {
        phase,
        direct,
        condition,
        conditionHttp,
        dashboardHttp,
        dashboardOccupancy: headline.occupancy || null,
        dashboardAvailable: headline.availability && headline.availability.available_units,
      };
    }

    for (const [fixture, expected] of [[bed, bedExpectedPre], [unit, unitExpectedPre]]) {
      proofStage = `pre_${fixture.basis}`;
      const before = await reads(fixture, "before");
      ok(`${fixture.basis} pre-retirement direct occupancy is the intended grain`,
        before.direct.status === "ok" && before.direct.occupied_count === expected.occupied
          && before.direct.rentable_count === expected.rentable && before.direct.excluded_count === expected.excluded);
      ok(`${fixture.basis} pre-retirement condition HTTP exposes the same occupancy`,
        before.conditionHttp.status === 200
          && conditionOccupancyIs(before.conditionHttp.body, { ...expected, basis: fixture.basis }));
      ok(`${fixture.basis} pre-retirement condition service carries the sibling 850 rent`,
        before.condition.in_place_rent.amount === 850);
      ok(`${fixture.basis} pre-retirement leasing dashboard is reachable with available units`,
        before.dashboardHttp.status === 200 && before.dashboardAvailable === 1);
      ok(`${fixture.basis} pre-retirement leasing dashboard occupancy matches canonical ratio`,
        dashboardRatioIs(before, expected));

      let refusal = null;
      try {
        await tx((client) => retirement.retireInventoryUnits(client, {
          property_id: fixture.id,
          unit_ids: [fixture.units["302"]],
          rationale: "Synthetic leased-unit retirement refusal control",
          actor: { user_id: operator.id },
        }));
      } catch (error) { refusal = error; }
      ok(`${fixture.basis} leased sibling retirement is refused by the retirement owner`,
        refusal && refusal.code === "RETIREMENT_UNIT_CARRIES_LEASES");
      ok(`${fixture.basis} leased sibling remains unretired after refusal`,
        Number((await one("select count(*)::int as n from inventory_retirements where unit_id=$1 and reversed_at is null", [fixture.units["302"]])).n) === 0);

      proofStage = `retire_${fixture.basis}`;
      await tx((client) => retirement.retireInventoryUnits(client, {
        property_id: fixture.id,
        unit_ids: [fixture.units["301"]],
        rationale: "Synthetic corrected inventory grain retirement",
        actor: { user_id: operator.id },
      }));
      const retiredExclusion = await retirement.retiredExclusion(pool, fixture.id);
      ok(`${fixture.basis} retirement owner reports one current retired unit and no hidden lease`,
        retiredExclusion.units === 1 && retiredExclusion.leases_on_retired_inventory === 0 && retiredExclusion.conflict === false);

      const lateSpace = fixture.spaces["301|Room1"];
      let lateLeaseCode = null;
      let lateLeaseMessage = "";
      try {
        await pool.query(`insert into leases
            (property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status)
          values($1,$2,'{}',700,'2026-08-01','2027-07-31','active')`, [fixture.id, lateSpace]);
      } catch (error) { lateLeaseCode = error.code; lateLeaseMessage = String(error.message || ""); }
      ok(`${fixture.basis} late lease on retired inventory is explicitly refused`,
        lateLeaseCode === "23514" && /retired/i.test(lateLeaseMessage) && /reinstate/i.test(lateLeaseMessage));
      const retiredRead = await reads(fixture, "retired");
      const expectedRetired = parent ? expected : { occupied: 1, rentable: 1, excluded: fixture.basis === "bed" ? 3 : 0 };
      ok(`${fixture.basis} retired direct occupancy ${parent ? "records current inclusion" : "excludes retired unit"}`,
        retiredRead.direct.status === "ok" && retiredRead.direct.occupied_count === expectedRetired.occupied
          && retiredRead.direct.rentable_count === expectedRetired.rentable
          && retiredRead.direct.excluded_count === expectedRetired.excluded);
      ok(`${fixture.basis} retired condition HTTP ${parent ? "records current inclusion" : "matches retired exclusion"}`,
        retiredRead.conditionHttp.status === 200
          && conditionOccupancyIs(retiredRead.conditionHttp.body, { ...expectedRetired, basis: fixture.basis }));
      ok(`${fixture.basis} retired condition retains sibling 850 rent`, retiredRead.condition.in_place_rent.amount === 850);
      ok(`${fixture.basis} leasing dashboard available units ${parent ? "still exposes current bug" : "excludes retired unit"}`,
        retiredRead.dashboardHttp.status === 200 && retiredRead.dashboardAvailable === (parent ? 1 : 0));
      ok(`${fixture.basis} leasing dashboard occupancy ${parent ? "records current inclusion" : "excludes retired unit"}`,
        dashboardRatioIs(retiredRead, expectedRetired));
      if (fixture.basis === "bed") {
        ok("bed non-revenue label exclusions remain governed and unchanged after retirement",
          retiredRead.direct.excluded_count === 3 && retiredRead.direct.exclusions_source === "space_label");
      }

      const provenance = await retirement.retirementProvenance(pool, { property_id: fixture.id });
      ok(`${fixture.basis} retired lease conflict read is not healthy-silent`, provenance.has_conflict === false);

      await tx((client) => retirement.reinstateInventoryUnit(client, {
        unit_id: fixture.units["301"], actor: { user_id: operator.id }, reason: "Synthetic restore control",
      }));
      const restored = await reads(fixture, "restored");
      ok(`${fixture.basis} post-reinstatement direct occupancy returns to pre-retirement counts`,
        restored.direct.status === "ok" && restored.direct.occupied_count === expected.occupied
          && restored.direct.rentable_count === expected.rentable && restored.direct.excluded_count === expected.excluded);
      ok(`${fixture.basis} post-reinstatement condition and dashboard return to pre-retirement counts`,
        restored.conditionHttp.status === 200
          && conditionOccupancyIs(restored.conditionHttp.body, { ...expected, basis: fixture.basis })
          && restored.dashboardHttp.status === 200 && restored.dashboardAvailable === 1);
      ok(`${fixture.basis} post-reinstatement leasing dashboard occupancy returns to pre-retirement ratio`,
        dashboardRatioIs(restored, expected));
      ok(`${fixture.basis} post-reinstatement condition still carries sibling 850 rent`, restored.condition.in_place_rent.amount === 850);
    }

    proofStage = "unsupported_basis";
    const unknownDirect = await occupancyByBasis(pool, unknown.id);
    const unknownCondition = await leasingConditionFacts(pool, unknown.id);
    const unknownHttp = await request("/operator/leasing/condition", unknown.token);
    ok("unsupported leasing basis is unavailable in the direct occupancy owner",
      unknownDirect.status === "unavailable" && unknownDirect.reason === "leasing_basis_unsupported"
        && unknownDirect.occupied_count === null && unknownDirect.rentable_count === null);
    ok("unsupported leasing basis remains unavailable through condition service and HTTP",
      unknownCondition.current_occupancy.status === "unavailable"
        && unknownCondition.current_occupancy.reason === "leasing_basis_unsupported"
        && unknownHttp.status === 200 && unknownHttp.body
        && unknownHttp.body.current_occupancy.status === "unavailable");

    console.log(`LEASING_OCCUPANCY_RETIREMENT_PASSED=${passed}; FAILED=${failed}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const safe = safeFailure(error);
  writeFailureDiagnostic(error);
  console.error(`LEASING_OCCUPANCY_RETIREMENT_FAILED; STAGE=${proofStage}; CODE=${safe.code}`);
  process.exitCode = 1;
});
