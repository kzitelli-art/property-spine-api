#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   HARNESS — THE CANONICAL PROPERTY-CREATION PATH (Build 1A-1)

   Real Postgres. Real constraints. Real transactions. No mocks: the
   service under test is the shipped src/identity/property_creation_service.js,
   reached through its exported functions, and every assertion reads the
   database back rather than trusting a return value.

   ── WHAT IT PROVES ──────────────────────────────────────────────────
   A  AUTHORITY CONTAINMENT — the collapse narrows and never widens
      A1  no actor at all is refused (a bearer key is not an actor)
      A2  an inactive login is refused
      A3  a 'member' may not create a property
      A4  a super_admin must NAME an organization
      A5  an org_admin creating in a SIBLING org is refused — the
          escape-sideways case, refused rather than redirected
      A6  an org_admin's own organization is taken from the LOGIN, not
          the request body

   B  HIERARCHY — the orphan is no longer reachable
      B1  every property the service creates carries an organization
      B2  the organization is the server's answer, not the caller's

   C  IDENTITY — the best behaviour of each door, kept
      C1  a canonical key is derived from the address
      C2  an absent key is EXPLAINED, never silently NULL
      C3  the database refuses a key and a reason together
      C4  duplicate identity is refused, not duplicated
      C5  bank intake's idempotency survives: same key = same property
      C6  idempotency does not reach across organizations
      C7  owner.js's alias-hijack refusal now protects every door
      C8  deal_intake's teach-on-creation now serves every door

   D  HISTORY — creation is attributable and immutable
      D1  one creation event per created property, with both identities
      D2  the authority exercised is recorded, not merely "signed in"
      D3  the event cannot be updated
      D4  the event cannot be deleted
      D5  an idempotent no-op writes NO second creation event

   ── WHAT IT DOES NOT PROVE ──────────────────────────────────────────
   HTTP. The routes are proven separately by
   tests/proofs/property_creation_http.db.js, which runs the real Express stack.

   run:  HARNESS_DATABASE_URL="postgres://..." node tests/proofs/property_creation_canonical.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");
const svc = require("../../src/identity/property_creation_service.js");

const URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
  return cond;
};

//  Every refusal is asserted by its STABLE KEY, never by message text.
//  A proof that matches on prose passes when the prose is right and the
//  behaviour is wrong.
async function refused(label, expectedReason, fn) {
  try {
    await fn();
    return ok(label, false, "it was ALLOWED. Expected refusal: " + expectedReason);
  } catch (e) {
    return ok(label + "  → " + (e.refusalReason || "(no reason key)"),
      e.refusalReason === expectedReason,
      "expected reason '" + expectedReason + "', got '" + (e.refusalReason || e.message) + "'");
  }
}

const TAG = "B1A1_" + process.pid;
//  canonical_key is globally UNIQUE, so fixtures with FIXED street numbers
//  collide the second time this harness meets the same database. DB
//  harnesses commit and never clean up (docs/DB_HARNESS_ISOLATION.md) —
//  but "disposable" should not mean "single-use". N makes every derived
//  key unique per run while leaving the derivation itself real.
const N = 100000 + (process.pid % 800000);

(async () => {
  receipt.begin(__filename, { url: URL, expected: 25 });

  // ── fixtures. Two organizations, so "sideways" is a real direction. ──
  const orgA = (await pool.query(
    `insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " Org A", TAG.toLowerCase() + "-a"])).rows[0].id;
  const orgB = (await pool.query(
    `insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " Org B", TAG.toLowerCase() + "-b"])).rows[0].id;

  const person = (await pool.query(
    `insert into persons (name) values ($1) returning id`, [TAG + " Human"])).rows[0].id;

  const mkUser = async (role, org, opts = {}) => (await pool.query(
    `insert into users (name, email, platform_role, organization_id, is_active, status, person_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [TAG + " " + role, `${TAG}.${role}.${Math.random().toString(36).slice(2)}@example.test`,
     role, org, opts.is_active !== false, opts.status || "active",
     opts.person === false ? null : person])).rows[0].id;

  const superAdmin = await mkUser("super_admin", null);           // spans all orgs
  const adminA     = await mkUser("org_admin", orgA);
  const adminB     = await mkUser("org_admin", orgB);
  const member     = await mkUser("member", orgA);
  const inactive   = await mkUser("org_admin", orgA, { is_active: false });

  console.log("  fixtures: 2 orgs, 5 logins, 1 person\n");

  // ══════════════════════════════════════════════════════════════════
  console.log("  ── A · AUTHORITY CONTAINMENT ──");
  // ══════════════════════════════════════════════════════════════════
  await refused("A1  no actor is refused", "no_authenticated_actor",
    () => svc.createProperty(pool, { name: TAG + " ghost", source: "bank_intake" }));

  await refused("A2  an inactive login is refused", "actor_inactive",
    () => svc.createProperty(pool, { actor: { user_id: inactive }, name: TAG + " x", source: "bank_intake" }));

  await refused("A3  a 'member' may not create a property", "insufficient_platform_role",
    () => svc.createProperty(pool, { actor: { user_id: member }, name: TAG + " x", source: "bank_intake" }));

  await refused("A4  a super_admin must NAME an organization", "organization_required",
    () => svc.createProperty(pool, { actor: { user_id: superAdmin }, name: TAG + " x", source: "bank_intake" }));

  await refused("A5  an org_admin may not create in a SIBLING organization", "organization_scope_violation",
    () => svc.createProperty(pool, { actor: { user_id: adminA }, organization_id: orgB,
                                     name: TAG + " sideways", source: "bank_intake" }));

  //  A6 — the body is ignored, not obeyed. adminA names nothing; the
  //  server supplies orgA from the login.
  const a6 = await svc.createProperty(pool, {
    actor: { user_id: adminA }, name: TAG + " A6", address: `${N + 1} Walnut Street`, source: "owner_upload" });
  ok("A6  an org_admin's organization comes from the LOGIN, not the request",
    String(a6.property.organization_id) === String(orgA),
    `got ${a6.property.organization_id}, expected ${orgA}`);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── B · HIERARCHY ──");
  // ══════════════════════════════════════════════════════════════════
  const b1 = await svc.createProperty(pool, {
    actor: { user_id: superAdmin }, organization_id: orgB,
    name: TAG + " B1", address: `${N + 2} Chestnut Street`, source: "super_admin_wizard" });

  //  Read the ROW back. A returned object can be right while the write was wrong.
  const b1row = (await pool.query(
    `select organization_id from properties where id = $1`, [b1.property.id])).rows[0];
  ok("B1  the created property carries an organization in the database",
    b1row.organization_id !== null, "organization_id is NULL — the orphan is back");
  ok("B2  a super_admin's named organization is honoured",
    String(b1row.organization_id) === String(orgB));

  //  The load-bearing claim of the whole slice: no path through the
  //  service produces an orphan. Measured across everything it created.
  const orphans = (await pool.query(
    `select count(*)::int n from properties p
      join property_creation_events e on e.property_id = p.id
     where p.organization_id is null`)).rows[0].n;
  ok("B3  NO property created through the service has a null organization",
    orphans === 0, orphans + " orphaned propert(ies) carry a creation event");

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── C · IDENTITY ──");
  // ══════════════════════════════════════════════════════════════════
  ok(`C1  a canonical key is derived from the address  (${N + 2} Chestnut Street → ${N + 2}-CHESTNUT)`,
    b1.property.canonical_key === `${N + 2}-CHESTNUT`,
    "got " + JSON.stringify(b1.property.canonical_key));

  //  The live wizard permits an address-less property. It must still be
  //  creatable — and the gap must be explained rather than silent.
  const c2 = await svc.createProperty(pool, {
    actor: { user_id: superAdmin }, organization_id: orgB,
    name: TAG + " C2 no address", source: "super_admin_wizard" });
  ok("C2  an address-less property is created, and its absent identity is EXPLAINED",
    c2.property.canonical_key === null
      && c2.property.canonical_key_absent_reason === "no_address_supplied_at_creation",
    JSON.stringify({ key: c2.property.canonical_key, reason: c2.property.canonical_key_absent_reason }));

  //  C3 — the honest-blank rule is the DATABASE's, not the service's
  //  politeness. Proven by attacking the row directly, around the service.
  let c3refused = false;
  try {
    await pool.query(
      `update properties set canonical_key_absent_reason = 'invented' where id = $1`, [b1.property.id]);
  } catch (e) { c3refused = e.code === "23514"; }
  ok("C3  the database refuses a canonical key and an absent-reason together",
    c3refused, "a keyed row accepted an absent-reason — the CHECK is not binding");

  await refused("C4  duplicate identity is refused, not duplicated", "property_identity_exists",
    () => svc.createProperty(pool, { actor: { user_id: superAdmin }, organization_id: orgB,
      name: TAG + " C4 dup", address: `${N + 2} Chestnut Street`, source: "super_admin_wizard" }));

  //  C5 — bank intake's contribution. Same key twice is the SAME property.
  const c5a = await svc.createProperty(pool, {
    actor: { user_id: adminA }, name: TAG + " C5", canonical_key: `${N + 4}-BUTTONWOOD`,
    source: "bank_intake", idempotent: true });
  const c5b = await svc.createProperty(pool, {
    actor: { user_id: adminA }, name: TAG + " C5 again", canonical_key: `${N + 4}-BUTTONWOOD`,
    source: "bank_intake", idempotent: true });
  ok("C5  idempotency survives: the same canonical key returns the same property",
    c5a.created === true && c5b.created === false
      && String(c5a.property.id) === String(c5b.property.id),
    JSON.stringify({ first: c5a.created, second: c5b.created }));

  //  C6 — and it does NOT hand another organization's building back just
  //  because the address matched. This refusal is NEW; the original
  //  upsert would have returned orgA's property id to orgB.
  await refused("C6  idempotency does not reach across organizations",
    "identity_belongs_to_another_organization",
    () => svc.createProperty(pool, { actor: { user_id: adminB }, name: TAG + " C6 steal",
      canonical_key: `${N + 4}-BUTTONWOOD`, source: "bank_intake", idempotent: true }));

  //  C7 — owner.js's alias-hijack refusal, now protecting a door that
  //  never had it (deal_intake).
  const c7 = await svc.createProperty(pool, {
    actor: { user_id: adminA }, name: TAG + " C7 owner", address: `${N + 5} Spring Garden Street`,
    aliases: [TAG + " Spring Garden roll"], alias_source_system: "rent_roll",
    source: "owner_upload" });
  ok("C7a the alias was taught as resolved", c7.aliases_taught === 1);
  await refused("C7b a taught string cannot be re-pointed at a different property", "alias_conflict",
    () => svc.createProperty(pool, { actor: { user_id: adminA }, name: TAG + " C7 thief",
      address: `${N + 6} Fairmount Avenue`, aliases: [TAG + " Spring Garden roll"], source: "deal_intake" }));

  //  And the refusal must leave NOTHING behind. A half-applied create is
  //  worse than a refused one.
  const thief = (await pool.query(
    `select count(*)::int n from properties where name = $1`, [TAG + " C7 thief"])).rows[0].n;
  ok("C7c the refused create left no property behind (the transaction rolled back)",
    thief === 0, thief + " row(s) survived a refused create");

  //  C8 — teach-on-creation resolves through the REGISTRY's own query
  //  shape, not a shape invented here.
  const resolved = (await pool.query(
    `select pa.property_id from property_aliases pa
      where lower(btrim(pa.alias_value)) = lower(btrim($1))
        and pa.confidence = 'resolved'`, [TAG + " Spring Garden roll"])).rows;
  ok("C8  the taught alias resolves to the new property by the registry's own lookup",
    resolved.length === 1 && String(resolved[0].property_id) === String(c7.property.id));

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── D · HISTORY ──");
  // ══════════════════════════════════════════════════════════════════
  const ev = (await pool.query(
    `select * from property_creation_events where property_id = $1`, [b1.property.id])).rows;
  ok("D1a exactly one creation event exists for the created property", ev.length === 1);
  ok("D1b it records BOTH identities — the credential and the human",
    ev.length === 1 && String(ev[0].actor_user_id) === String(superAdmin)
      && String(ev[0].actor_person_id) === String(person),
    ev.length ? JSON.stringify({ user: ev[0].actor_user_id, person: ev[0].actor_person_id }) : "no event");
  ok("D2  it records the authority EXERCISED, not merely that someone was signed in",
    ev.length === 1 && ev[0].authority_basis === "platform_role:super_admin"
      && ev[0].creation_source === "super_admin_wizard",
    ev.length ? JSON.stringify({ basis: ev[0].authority_basis, source: ev[0].creation_source }) : "no event");

  let d3 = false;
  try { await pool.query(`update property_creation_events set authority_basis='forged' where property_id=$1`, [b1.property.id]); }
  catch (e) { d3 = /immutable/i.test(e.message); }
  ok("D3  a creation event cannot be UPDATED", d3, "the history is editable");

  let d4 = false;
  try { await pool.query(`delete from property_creation_events where property_id=$1`, [b1.property.id]); }
  catch (e) { d4 = /immutable/i.test(e.message); }
  ok("D4  a creation event cannot be DELETED", d4, "the history is erasable");

  //  D5 — an idempotent no-op is not a creation. Writing a second event
  //  would claim the property was created twice.
  const c5events = (await pool.query(
    `select count(*)::int n from property_creation_events where property_id = $1`,
    [c5a.property.id])).rows[0].n;
  ok("D5  an idempotent no-op writes NO second creation event", c5events === 1,
    c5events + " events for one property");

  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 25 });
  await pool.end();
  process.exit(code);
})().catch(async (e) => {
  console.error("\n  " + (e && e.stack || e));
  const code = receipt.died(__filename, e, pass + fail);
  try { await pool.end(); } catch (_) {}
  process.exit(code);
});
