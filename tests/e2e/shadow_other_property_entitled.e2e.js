/*  ════════════════════════════════════════════════════════════════════
    shadow_other_property_entitled.e2e.js — ECONOMICS USES THE ACTIVE
    PROPERTY SESSION; THE OPTIONAL CROSS-PROPERTY COMPARISON IS REMOVED.

    GET /operator/economics/shadow (src/identity/operator.js) ran the
    25-scenario shadow report with `other_property_id` fixed in source to
    one real production property (the Solo id in deal_registry.js). Every
    operator, on every property, was compared against it — a Solo-special
    branch in a route (§22) and a read of another property's governed
    state without entitlement. PROOF_EXPECT_DEFECT=1 positively records the
    buggy successor's false unpublished answer despite published pricing.
    Normal mode requires an explicit unsupported-option refusal, unchanged
    single-property summary, and a successful read using the target session.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const boundary = require("./proof_boundary");
boundary.manifest();
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
const EXPECT_DEFECT = process.env.PROOF_EXPECT_DEFECT === "1";

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

(async () => {
  await boundary.assertDatabase();
  const tag = "SOP" + Math.floor(Math.random() * 1e6);
  const propA = (await one("insert into properties (name,address) values ($1,'14 Shadow Ln') returning id", [tag + " A"])).id;
  const propB = (await one("insert into properties (name,address) values ($1,'16 Shadow Ln') returning id", [tag + " B"])).id;
  const user = (await one(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'property_manager',true,'active','human_staff') returning id`, [tag + " Operator", `${tag}@example.com`])).id;
  const seat = (prop) => pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Manager','property','{management}','{management}',false,true)`, [prop, user]);
  await seat(propA);
  const c = await pool.connect();
  let session;
  try { await c.query("begin"); session = (await staffSessions.issueStaffSession(c, { userId: user, propertyId: propA, purpose: "sms_otp" })).session_token; await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  const shadow = async (qs = "") => {
    const r = await fetch(`${API}/operator/economics/shadow${qs}`, { headers: { "x-staff-session": session } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const hasOther = (b) => !!(b && Array.isArray(b.comparisons) && b.comparisons.some((x) => x.scenario === "another_property"));
  const refused = r => r.status === 400 && r.body && r.body.code === "cross_property_comparison_not_supported"
    && r.body.acting_on === propA && !r.body.comparisons;

  console.log("\n── 1 · no comparison property named ──");
  const plain = await shadow();
  check("GET /operator/economics/shadow → 200 for the operator's own property", plain.status === 200 && plain.body && plain.body.property_id === propA, `${plain.status} ${J(plain.body).slice(0, 160)}`);
  check("…and no 'another_property' scenario — nothing fixed in source was compared", plain.status === 200 && !hasOther(plain.body), J(plain.body && plain.body.comparisons && plain.body.comparisons.filter((x) => x.scenario === "another_property")));

  console.log("\n── 2 · a comparison property the operator is not seated on ──");
  const foreign = await shadow(`?other_property_id=${propB}`);
  check("unseated target produces only the applicable refusal", EXPECT_DEFECT
    ? foreign.status === 403 && !foreign.body.comparisons : refused(foreign), `${foreign.status} ${J(foreign.body).slice(0, 200)}`);

  console.log("\n── 3 · once seated on it, the comparison is produced ──");
  await seat(propB);
  const version = await one(`insert into property_pricing_versions (property_id,status,effective_from,published_at,note)
    values ($1,'published','2026-01-01',now(),'isolated comparison read fixture') returning id`, [propB]);
  const canonical = await require(path.join(ROOT, "src/money/economic_picture.js")).effectiveEconomicPicture(pool, { property_id: propB });
  check("fixture has canonical published pricing, not an unavailable read", canonical.base_rent.published_version
    && canonical.base_rent.published_version.version_id === version.id && canonical.base_rent.unresolved_reason === null,
    J({ published_version: canonical.base_rent.published_version, unresolved_reason: canonical.base_rent.unresolved_reason }));
  const own = await shadow(`?other_property_id=${propB}`);
  if (EXPECT_DEFECT) {
    const row = own.body && own.body.comparisons && own.body.comparisons.find(x => x.scenario === "another_property");
    check("EXPECTED_DEFECT_OBSERVED published target falsely reported unpublished", own.status === 200 && row
      && row.governed_state === "no_published_pricing_version" && row.governed_disposition === "refused");
  } else {
    check("seated target is also explicitly unsupported", refused(own), `${own.status} ${J(own.body).slice(0, 160)}`);
    check("empty comparison parameter is refused rather than silently ignored", refused(await shadow("?other_property_id=")));
    const after = await shadow();
    check("single-property report and its summary are unchanged by the refusals", after.status === 200
      && after.body.property_id === propA && !hasOther(after.body)
      && J(after.body.summary) === J(plain.body.summary));
    const c2 = await pool.connect();
    let sessionB;
    try { await c2.query("begin"); sessionB = (await staffSessions.issueStaffSession(c2, { userId: user, propertyId: propB, purpose: "sms_otp" })).session_token; await c2.query("commit"); }
    catch (e) { await c2.query("rollback"); throw e; } finally { c2.release(); }
    const rB = await fetch(`${API}/operator/economics/picture`, { headers: { "x-staff-session": sessionB } });
    const bB = await rB.json();
    check("target property's own session still reads its published economics", rB.status === 200
      && bB.base_rent.published_version && bB.base_rent.published_version.version_id === version.id);
  }

  await pool.end();
  console.log(`\n══ shadow other property entitled: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
