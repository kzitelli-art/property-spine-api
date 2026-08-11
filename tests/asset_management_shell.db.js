/* ════════════════════════════════════════════════════════════════════
   asset_management_shell.db.js — THE ASSET MANAGEMENT DOOR, PROVEN
   against real PostgreSQL and real HTTP.

   Asset Management is the FOURTH operating door. This proves the shell
   tells the truth, and — more importantly — proves the specific ways it
   could lie:

     · that it refuses an unauthenticated caller
     · that it refuses a caller WITHOUT the asset_management module,
       which is the entitlement gate, not a job title
     · that it ADMITS a caller who holds the module but is NOT called an
       asset manager — entitlement and title are different facts, and a
       door that reads the title would silently deny a property manager
       who legitimately holds the module
     · that it refuses a client-supplied property_id rather than ignoring
       it (§21)
     · that it returns FOUR rooms in the canonical order
     · that Revenue reads REAL lease data — not_established with no
       leases, partially_established once a lease carries rent and a term
     · that Capital / Property Obligations / Operating Costs say
       not_established, because no such tables exist
     · THAT NO ROOM EVER RENDERS A CURRENCY-SHAPED TOKEN. This is the
       assertion the slice exists for: the whole point is a shell that
       does not fabricate economics, and "make the screens look complete"
       is exactly how that gets lost later.

   ISOLATION: requires HARNESS_DATABASE_URL and refuses to run against
   anything named like production. Builds its own scoped schema — the
   full chain cannot rebuild from empty (012_bank_intake / yardi_code),
   which predates this work and bounds every proof in this repo.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres \
       node tests/asset_management_shell.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

//  THE SAME-TARGET REFUSAL, not merely a required variable.
//
//  An earlier revision of this file checked HARNESS_DATABASE_URL against a
//  name pattern (/prod|neon|render/) and gate_harness_isolation.js failed
//  it, correctly: requiring the variable is not the same as refusing the
//  wrong VALUE. A disposable branch on the same host would have passed a
//  name check and still been production. harnessConnectionString() resolves
//  host/port/database and exits rather than returning on a match.
const URL_ = receipt.harnessConnectionString();

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

//  A currency-shaped token. Deliberately broad: a bare number is fine
//  (counts are real), but anything wearing a currency symbol or a
//  thousands-separated decimal is a fabricated economic magnitude in a
//  surface that has no economics yet.
const CURRENCYISH = /[$£€]\s?\d|\d{1,3}(,\d{3})+(\.\d{2})?|\b\d+\.\d{2}\b/;

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "am_shell_" + Date.now();
  let server, port;

  try {
    await pool.query(`create schema ${schema}`);
    await pool.query(`set search_path to ${schema}`);

    // ── the scoped schema this door actually touches ──────────────────
    await pool.query(`
      create extension if not exists pgcrypto;
      set search_path to ${schema};
      create table properties (
        id uuid primary key default gen_random_uuid(),
        name text, organization_id uuid);
      create table spaces (
        id uuid primary key default gen_random_uuid(),
        property_id uuid references properties(id));
      create table leases (
        id uuid primary key default gen_random_uuid(),
        property_id uuid not null references properties(id),
        space_id uuid references spaces(id),
        rent numeric(10,2),
        start_date date,
        end_date date,
        lease_status text not null default 'active');
    `);

    const propId = (await pool.query(
      `insert into ${schema}.properties (name) values ('Harness Property') returning id`)).rows[0].id;

    // ── a fake session resolver: the door's ONLY identity input ───────
    //  Swapping the resolver rather than minting real sessions keeps this
    //  test about the DOOR. The session shape is copied from what
    //  staff_session_service actually returns and is the contract under
    //  test here.
    const resolverPath = require.resolve("../src/identity/staff_session_service.js");
    const sessions = new Map();
    require.cache[resolverPath] = {
      id: resolverPath, filename: resolverPath, loaded: true,
      exports: {
        resolveStaffSession: async (_pool, token) => sessions.get(token) || null,
      },
    };

    sessions.set("tok-am", {
      id: "u-am", name: "Holds The Module", role: "property_manager",
      property_id: propId, allowed_modules: ["management", "maintenance", "asset_management"],
    });
    sessions.set("tok-noam", {
      id: "u-noam", name: "No Module", role: "asset_manager",
      property_id: propId, allowed_modules: ["management", "leasing"],
    });

    // ── real HTTP, real router ────────────────────────────────────────
    const express = require("express");
    const app = express();
    app.use(express.json());
    // search_path so the door's queries hit the scoped schema
    const scopedPool = new Pool({ connectionString: URL_ });
    scopedPool.on("connect", (c) => c.query(`set search_path to ${schema}`));
    app.use("/", require("../src/surfaces/asset_management.js")({ pool: scopedPool }));

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;

    const get = (path, token) => new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path, method: "GET",
          headers: token ? { "x-staff-session": token } : {} },
        (res) => {
          let b = ""; res.on("data", (d) => b += d);
          res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: b }); });
        });
      req.on("error", () => resolve({ status: 0, body: null, raw: "" }));
      req.end();
    });

    const PATH = "/operator/asset-management/overview";

    console.log("\n── 1. AUTHORITY ──────────────────────────────────────");

    const anon = await get(PATH, null);
    ok("no session → 401, not an empty result", anon.status === 401,
       `got ${anon.status}`);

    const noMod = await get(PATH, "tok-noam");
    ok("session WITHOUT asset_management module → 403",
       noMod.status === 403, `got ${noMod.status}`);
    ok("the 403 names allowed_modules, so the operator knows what is missing",
       !!(noMod.body && /allowed_modules/.test(noMod.body.error || "")));

    //  THE ENTITLEMENT-NOT-TITLE ASSERTION. tok-noam's role IS
    //  'asset_manager' and it is REFUSED; tok-am's role is
    //  'property_manager' and it is ADMITTED. A door that read the title
    //  would get both of these backwards.
    ok("a caller whose ROLE is asset_manager but lacks the MODULE is refused",
       noMod.status === 403);

    const good = await get(PATH, "tok-am");
    ok("a caller whose role is property_manager but HOLDS the module is admitted",
       good.status === 200, `got ${good.status} ${good.raw.slice(0, 160)}`);

    const spoof = await get(PATH + "?property_id=00000000-0000-0000-0000-000000000123", "tok-am");
    ok("§21 a client-supplied property_id is REFUSED, not ignored",
       spoof.status === 403);
    ok("the refusal states which property it is acting on",
       !!(spoof.body && spoof.body.acting_on === propId));

    console.log("\n── 2. THE FOUR ROOMS ─────────────────────────────────");

    const rooms = (good.body && good.body.rooms) || [];
    ok("exactly four rooms", rooms.length === 4, `got ${rooms.length}`);
    ok("canonical order: revenue · capital · property_obligations · operating_costs",
       rooms.map((r) => r.key).join(",") === "revenue,capital,property_obligations,operating_costs",
       rooms.map((r) => r.key).join(","));
    ok("every room carries an establishment state",
       rooms.every((r) => ["established", "partially_established", "not_established"].includes(r.establishment)));
    ok("every room says WHY in plain language",
       rooms.every((r) => typeof r.why === "string" && r.why.length > 20));
    ok("every room names what would establish it",
       rooms.every((r) => typeof r.what_would_establish_it === "string" && r.what_would_establish_it.length > 10));
    ok("no room invents an owner — UNASSIGNED until one is recorded",
       rooms.every((r) => r.owner === "UNASSIGNED"));
    ok("the response states its own limits (scope_note)",
       typeof (good.body || {}).scope_note === "string");

    console.log("\n── 3. ESTABLISHMENT IS READ FROM REAL DATA ───────────");

    const byKey = (k) => rooms.find((r) => r.key === k);

    ok("with NO leases, Revenue is not_established",
       byKey("revenue").establishment === "not_established",
       byKey("revenue").establishment);
    ok("…and says so as 'no active leases', not as a generic blank",
       /No active leases/i.test(byKey("revenue").why));

    ok("Capital is not_established", byKey("capital").establishment === "not_established");
    ok("Property Obligations is not_established", byKey("property_obligations").establishment === "not_established");
    ok("Operating Costs is not_established", byKey("operating_costs").establishment === "not_established");

    //  A lease that carries NEITHER rent nor a start date is a tenancy
    //  record, not an economic one. It must not move the room.
    await pool.query(
      `insert into ${schema}.leases (property_id, lease_status) values ($1,'active')`, [propId]);
    const hollow = await get(PATH, "tok-am");
    const hollowRev = hollow.body.rooms.find((r) => r.key === "revenue");
    ok("a lease with no rent and no term does NOT establish Revenue",
       hollowRev.establishment === "not_established", hollowRev.establishment);
    ok("…and the sentence distinguishes 'leases exist but carry no economics'",
       /carries both a rent amount and a start date/i.test(hollowRev.why),
       hollowRev.why);

    //  Now a real economic position.
    await pool.query(
      `insert into ${schema}.leases (property_id, rent, start_date, end_date, lease_status)
       values ($1, 1850.00, '2026-01-01', '2026-12-31', 'active')`, [propId]);
    const withLease = await get(PATH, "tok-am");
    const rev2 = withLease.body.rooms.find((r) => r.key === "revenue");
    ok("a lease with rent AND a term makes Revenue partially_established",
       rev2.establishment === "partially_established", rev2.establishment);
    ok("Revenue is NEVER 'established' — escalations and recurring charges do not exist",
       rev2.establishment !== "established");
    ok("…and the sentence says what is still missing",
       /escalation/i.test(rev2.why) && /recurring/i.test(rev2.why));
    ok("the other three rooms are unmoved by a lease",
       withLease.body.rooms.filter((r) => r.key !== "revenue")
         .every((r) => r.establishment === "not_established"));

    console.log("\n── 4. NO FABRICATED ECONOMICS ────────────────────────");
    //  The assertion this slice exists for.
    const whole = JSON.stringify(withLease.body);
    ok("the ENTIRE response contains no currency-shaped token",
       !CURRENCYISH.test(whole),
       CURRENCYISH.test(whole) ? "matched: " + (whole.match(CURRENCYISH) || [])[0] : "");

    //  Even though the database now holds 1850.00, the door must not
    //  surface it. This proves the absence is by construction, not by
    //  there being nothing to leak.
    ok("the lease's real rent (1850.00) is present in the DB but ABSENT from the response",
       !/1850/.test(whole));

    ok("no room exposes an amount field of any kind",
       withLease.body.rooms.every((r) =>
         !("amount" in r) && !("amount_cents" in r) && !("total" in r) && !("currency" in r)));

    console.log("\n── 5. FAILURE IS NOT AN EMPTY RESULT ─────────────────");
    await scopedPool.end();  // break the door's database
    const broken = await get(PATH, "tok-am");
    ok("a failed read returns 503, never 200-with-no-rooms",
       broken.status === 503, `got ${broken.status}`);
    ok("…and does not return a rooms array the surface could render as empty",
       !(broken.body && Array.isArray(broken.body.rooms)));

  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { await pool.query(`drop schema ${schema} cascade`); } catch (_) {}
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${pass + fail} assertions · ${pass} passed · ${fail} failed`);
  console.log("════════════════════════════════════════════════════════");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
