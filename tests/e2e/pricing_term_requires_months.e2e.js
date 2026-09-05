/*  ════════════════════════════════════════════════════════════════════
    pricing_term_requires_months.e2e.js — A PRICING TERM NAMES ITS LEASE
    TERM; 12 IS NOT ASSUMED.

    saveDraft (src/money/pricing_lifecycle.js) inserted each proposed term
    with `lease_term_months || 12`. A term that named no lease term — the
    publication contract's own blocker `invalid_lease_term` — was stored
    as a 12-month decision nobody made, and a stored term publishes like
    one. Proven here through POST /operator/pricing/draft: a term with no
    months is refused 400 with a sayable receipt and nothing is saved; a
    fractional month is refused; a term that names its months is saved as
    named.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

(async () => {
  const tag = "PTM" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address,city,state) values ($1,'13 Term St','Philadelphia','PA') returning id", [tag + " Terms"])).id;
  const type = (await one("insert into property_unit_types (property_id, code, label, sort_order) values ($1,'ONEBR','1 Bedroom',1) returning id", [prop])).id;
  const person = (await one("insert into persons (name) values ($1) returning id", [tag + " Asset Manager"])).id;
  const user = (await one(
    `insert into users (name,email,role,is_active,status,account_kind,person_id)
     values ($1,$2,'asset_manager',true,'active','human_staff',$3) returning id`, [tag + " AM Login", `${tag}@example.com`, person])).id;
  await pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Asset Manager','property','{management,capital}','{management}',true,true)`, [prop, user]);
  await pool.query(`insert into assignments (person_id, property_id, role, is_active) values ($1,$2,'asset_manager',true)`, [person, prop]);
  const c = await pool.connect();
  let session;
  try { await c.query("begin"); session = (await staffSessions.issueStaffSession(c, { userId: user, propertyId: prop, purpose: "sms_otp" })).session_token; await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  const draft = async (term) => {
    const r = await fetch(`${API}/operator/pricing/draft`, { method: "POST",
      headers: { "content-type": "application/json", "x-staff-session": session },
      body: J({ proposal: { effective_from: "2026-10-01", terms: [{ unit_type_id: type, base_rent: 1500, renewal_rent: 1550, offer_state: "offered", ...term }] } }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const versions = () => one("select count(*)::int as n from property_pricing_versions where property_id=$1", [prop]);
  const storedMonths = async (versionId) => (await one("select lease_term_months from pricing_terms where pricing_version_id=$1", [versionId]) || {}).lease_term_months;

  console.log("\n── 1 · a term that names no lease term ──");
  const none = await draft({});
  check("POST /operator/pricing/draft with no lease_term_months → 400 term_without_lease_term", none.status === 400 && none.body && none.body.code === "term_without_lease_term", `${none.status} ${J(none.body).slice(0, 220)}`);
  check("…the refusal says 12 is not assumed and nothing was saved", !!(none.body && /12 is not assumed/.test(none.body.error || "") && /Nothing was saved/.test(none.body.error || "")), J(none.body && none.body.error));
  check("…and no draft version exists for the property (was: a draft carrying a 12-month term)", (await versions()).n === 0, `versions=${(await versions()).n}`);

  console.log("\n── 2 · a fractional month is not a lease term ──");
  const frac = await draft({ lease_term_months: 12.5 });
  check("lease_term_months 12.5 → 400", frac.status === 400 && frac.body && frac.body.code === "term_without_lease_term" && (await versions()).n === 0, `${frac.status} ${J(frac.body).slice(0, 160)}`);

  console.log("\n── 3 · a term that names its months is saved as named ──");
  const six = await draft({ lease_term_months: 6 });
  check("lease_term_months 6 → 200 with a draft_version_id", six.status === 200 && six.body && six.body.draft_version_id, `${six.status} ${J(six.body).slice(0, 200)}`);
  check("…stored as 6 months", six.body && (await storedMonths(six.body.draft_version_id)) === 6, `stored=${six.body && await storedMonths(six.body.draft_version_id)}`);

  await pool.end();
  console.log(`\n══ pricing term names its months: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
