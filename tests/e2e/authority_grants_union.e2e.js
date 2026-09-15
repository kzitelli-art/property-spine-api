/*  ════════════════════════════════════════════════════════════════════
    authority_grants_union.e2e.js — TWO LIVE GRANTS ARE TWO AUTHORIZATIONS,
    NOT A COIN FLIP.

    resolveActorContext (src/identity/actor_context.js) read a person's live
    concession-authority grants for the property and then took grants[0]
    from an unordered result. A person holding two live grants — one that
    lets them review pricing, one that lets them publish offers — was
    granted whichever verb sat on the row Postgres happened to return
    first, and denied the other. Proven here through GET
    /operator/authority-view: both verbs are granted, each basis names the
    grant that granted it, verbs no live grant grants stay denied, and an
    expired grant grants nothing.

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
  const tag = "AGU" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'12 Grant Ave') returning id", [tag + " Grants"])).id;
  const person = (await one("insert into persons (name) values ($1) returning id", [tag + " Agent"])).id;
  const user = (await one(
    `insert into users (name,email,role,is_active,status,account_kind,person_id)
     values ($1,$2,'leasing_agent',true,'active','human_staff',$3) returning id`, [tag + " Agent", `${tag}@example.com`, person])).id;
  await pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Leasing','property','{leasing}','{leasing}',false,true)`, [prop, user]);
  const assignment = (await one(
    `insert into assignments (person_id, property_id, role, is_active) values ($1,$2,'leasing',true) returning id`, [person, prop])).id;
  const grant = (fields, from, until = null) => one(
    `insert into concession_authority_grants (property_id, person_id, assignment_id, ${Object.keys(fields).join(", ")}, effective_from, effective_until)
     values ($1,$2,$3, ${Object.keys(fields).map(() => "true").join(", ")}, now() - ($4 || ' days')::interval, $5) returning id`,
    [prop, person, assignment, String(from), until]);
  const reviewGrant  = (await grant({ may_review_pricing: true }, 3)).id;
  const publishGrant = (await grant({ may_publish_public_offers: true }, 2)).id;
  const expiredGrant = (await grant({ may_manage_concession_authority: true }, 30, new Date(Date.now() - 86400000).toISOString())).id;
  const c = await pool.connect();
  let session;
  try { await c.query("begin"); session = (await staffSessions.issueStaffSession(c, { userId: user, propertyId: prop, purpose: "sms_otp" })).session_token; await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  console.log("\n── the authority view for a person holding two live grants and one expired ──");
  const r = await fetch(`${API}/operator/authority-view`, { headers: { "x-staff-session": session } });
  const body = await r.json().catch(() => null);
  const caps = (body && body.pricing_capabilities) || {};
  const basis = (body && body.authority_source) || {};
  check("GET /operator/authority-view → 200 for the linked staff person", r.status === 200 && body && body.link_status === "linked", `${r.status} ${J(body).slice(0, 200)}`);
  check("may_review_pricing is granted, on the basis of the review grant", caps.may_review_pricing === true && basis.may_review_pricing === `grant:${reviewGrant}`, J({ cap: caps.may_review_pricing, basis: basis.may_review_pricing, expected: `grant:${reviewGrant}` }));
  check("may_publish_pricing is granted, on the basis of the publish grant", caps.may_publish_pricing === true && basis.may_publish_pricing === `grant:${publishGrant}`, J({ cap: caps.may_publish_pricing, basis: basis.may_publish_pricing, expected: `grant:${publishGrant}` }));
  check("may_prepare_pricing stays denied — no live grant grants it", caps.may_prepare_pricing === false && basis.may_prepare_pricing === null, J({ cap: caps.may_prepare_pricing, basis: basis.may_prepare_pricing }));
  check("may_manage_concession_authority stays denied — only the EXPIRED grant granted it", caps.may_manage_concession_authority === false && basis.may_manage_concession_authority === null, J({ cap: caps.may_manage_concession_authority, basis: basis.may_manage_concession_authority, expired: expiredGrant }));
  const shown = ((body && body.temporary_grants) || []).map((g) => g.grant_id).sort();
  check("the view lists exactly the two live grants", shown.length === 2 && shown.includes(reviewGrant) && shown.includes(publishGrant) && !shown.includes(expiredGrant), J(shown));

  await pool.end();
  console.log(`\n══ authority grants union: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
