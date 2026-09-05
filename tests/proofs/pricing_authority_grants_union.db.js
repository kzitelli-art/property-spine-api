/* ════════════════════════════════════════════════════════════════════
   pricing_authority_grants_union.db.js — THE SECOND GRANT RESOLVER AGREES
   WITH THE FIRST. REAL POSTGRES.

   pricingAuthority (src/money/pricing_authority.js) has two branches.
   Given a session user it delegates to resolveActorContext, which since
   CURRENT_STATE row 50 grants a verb when ANY live concession-authority
   grant grants it. Given a person_id directly — the branch library
   callers and the pricing governance proof use — it selected ONE grant
   by `order by effective_from desc limit 1`, so a person holding two
   live grants lost every verb on the older one, and the two resolvers
   disagreed about the same human on the same property.

   ── WHAT IS PROVEN ──────────────────────────────────────────────────
   · a person with a live review grant (older) and a live publish grant
     (newer) is granted BOTH verbs, each on the basis of its own grant;
   · verbs no live grant grants stay denied; an expired grant grants
     nothing;
   · the person_id branch and the user_id branch (resolveActorContext)
     return the same capabilities and bases for the same person.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/spine_proof \
       node tests/proofs/pricing_authority_grants_union.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: CONN });
const { pricingAuthority } = require(path.join(__dirname, "..", "..", "src/money/pricing_authority.js"));

let pass = 0, fail = 0; const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
};
const J = (v) => JSON.stringify(v);

(async () => {
  const q = (s, p) => pool.query(s, p);
  const tag = "PGU" + Math.floor(Math.random() * 1e6);
  const prop = (await q("insert into properties (name) values ($1) returning id", [tag + " Grants Union"])).rows[0].id;
  const person = (await q("insert into persons (name) values ($1) returning id", [tag + " Agent"])).rows[0].id;
  const user = (await q(
    `insert into users (name,email,role,is_active,status,account_kind,person_id)
     values ($1,$2,'leasing_agent',true,'active','human_staff',$3) returning id`, [tag + " Login", `${tag}@example.com`, person])).rows[0].id;
  const assignment = (await q(
    `insert into assignments (person_id, property_id, role, is_active) values ($1,$2,'leasing',true) returning id`, [person, prop])).rows[0].id;
  const grant = async (column, daysAgo, until = null) => (await q(
    `insert into concession_authority_grants (property_id, person_id, assignment_id, ${column}, effective_from, effective_until)
     values ($1,$2,$3,true, now() - ($4 || ' days')::interval, $5) returning id`, [prop, person, assignment, String(daysAgo), until])).rows[0].id;
  const reviewGrant  = await grant("may_review_pricing", 3);
  const publishGrant = await grant("may_publish_public_offers", 2);
  const expiredGrant = await grant("may_manage_concession_authority", 30, new Date(Date.now() - 86400000).toISOString());

  console.log("\n── person_id branch: two live grants, one expired ──");
  const byPerson = await pricingAuthority(pool, { property_id: prop, person_id: person });
  ok("may_review_pricing granted on the basis of the (older) review grant",
     byPerson.may_review_pricing === true && byPerson.basis.may_review_pricing === `grant:${reviewGrant}`,
     J({ granted: byPerson.may_review_pricing, basis: byPerson.basis.may_review_pricing, expected: `grant:${reviewGrant}` }));
  ok("may_publish_pricing granted on the basis of the (newer) publish grant",
     byPerson.may_publish_pricing === true && byPerson.basis.may_publish_pricing === `grant:${publishGrant}`,
     J({ granted: byPerson.may_publish_pricing, basis: byPerson.basis.may_publish_pricing, expected: `grant:${publishGrant}` }));
  ok("may_prepare_pricing denied — no live grant grants it",
     byPerson.may_prepare_pricing === false && byPerson.basis.may_prepare_pricing === null, J(byPerson.basis));
  ok("may_manage_concession_authority denied — only the EXPIRED grant granted it",
     byPerson.may_manage_concession_authority === false && byPerson.basis.may_manage_concession_authority === null,
     J({ basis: byPerson.basis.may_manage_concession_authority, expired: expiredGrant }));

  console.log("\n── the two resolvers agree about the same human ──");
  const byUser = await pricingAuthority(pool, { property_id: prop, user_id: user });
  const verbs = ["may_prepare_pricing", "may_review_pricing", "may_publish_pricing", "may_manage_concession_authority"];
  ok("capabilities identical through person_id and through the session user",
     verbs.every((v) => byUser[v] === byPerson[v]), J({ byUser: verbs.map((v) => byUser[v]), byPerson: verbs.map((v) => byPerson[v]) }));
  ok("bases identical through person_id and through the session user",
     verbs.every((v) => byUser.basis[v] === byPerson.basis[v]), J({ byUser: byUser.basis, byPerson: byPerson.basis }));

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail) failures.forEach((f) => console.log("   ✗ " + f));
  console.log("════════════════════════════════════════════════════════════════");
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("DIED:", e && e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
