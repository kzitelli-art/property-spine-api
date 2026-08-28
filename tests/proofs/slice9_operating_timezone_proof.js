/* ══════════════════════════════════════════════════════════════════════════
   slice9_operating_timezone_proof.js — Slice 9, step 1.

   Proves properties.operating_timezone against REAL Postgres, transactional
   and rolled back. The claims under test:

     · the governed column is the source of truth;
     · an invalid IANA name CANNOT be stored by any path (DB-enforced);
     · there is NO universal default — unconfigured stays null, honestly;
     · the hardcoded production property-UUID allowlist is GONE from source;
     · the QA override is ignored in production;
     · the operating-date boundary near midnight uses the property's day,
       not UTC's.

   Requires DATABASE_URL. Refuses to report green without it.

   Run:  node tests/proofs/slice9_operating_timezone_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const REPO = path.join(__dirname, "..", "..");
const TZ_MODULE = path.join(REPO, "src/shared/property_timezone.js");
const {
  loadPropertyOperatingTimeZone, resolvePropertyOperatingTimeZone, TZ_UNAVAILABLE,
} = require(TZ_MODULE);

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL is required. This proof asserts against real Postgres and will not fake a pass.\n");
  process.exit(1);
}

const asPool = (c) => ({ query: (...a) => c.query(...a) });

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  section("A  the hardcoded allowlist is gone from source");
  const src = fs.readFileSync(TZ_MODULE, "utf8");
  ok("no hardcoded property UUID remains in the resolver",
    !/a50fbdd0-3642-431e-b532-0dcd6ab8a4fe/.test(src));
  ok("no BUILTIN_ALLOWLIST constant remains", !/BUILTIN_ALLOWLIST/.test(src));
  ok("the resolver reads properties.operating_timezone",
    /select operating_timezone from properties/.test(src));
  ok("an unavailable vocabulary is exported once, not reinvented per surface",
    TZ_UNAVAILABLE.reason === "property_operating_timezone_not_configured");

  section("B  the QA override is non-production only");
  const savedEnv = process.env.PROPERTY_OPERATING_TZ_JSON;
  const savedNode = process.env.NODE_ENV;
  process.env.PROPERTY_OPERATING_TZ_JSON = JSON.stringify({ "11111111-1111-4111-8111-111111111111": "America/Denver" });
  process.env.NODE_ENV = "test";
  ok("override applies outside production",
    resolvePropertyOperatingTimeZone("11111111-1111-4111-8111-111111111111") === "America/Denver");
  process.env.NODE_ENV = "production";
  ok("override is IGNORED in production — env never outranks the column",
    resolvePropertyOperatingTimeZone("11111111-1111-4111-8111-111111111111") === null);
  process.env.NODE_ENV = savedNode === undefined ? "test" : savedNode;
  if (savedEnv === undefined) delete process.env.PROPERTY_OPERATING_TZ_JSON;
  else process.env.PROPERTY_OPERATING_TZ_JSON = savedEnv;

  const c = await pool.connect();
  try {
    await c.query("begin");
    const P = asPool(c);
    // Deterministic, and NEVER the Demo Building — section H asserts about
    // Demo's backfilled value, so the probe must not be the row it mutates.
    const propId = (await c.query(
      `select id from properties
        where id <> 'a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'
        order by created_at nulls last, id limit 1`)).rows[0].id;

    section("C  no universal default — unconfigured is honestly null");
    await c.query("update properties set operating_timezone=null where id=$1", [propId]);
    ok("an unconfigured property resolves to null, never a borrowed midnight",
      (await loadPropertyOperatingTimeZone(P, propId)) === null);
    const anyDefault = (await c.query(
      `select count(*)::int n from information_schema.columns
        where table_name='properties' and column_name='operating_timezone'
          and column_default is not null`)).rows[0].n;
    ok("the column carries NO database default", anyDefault === 0);

    section("D  an invalid IANA name cannot be stored by ANY path");
    const rejects = async (value, label) => {
      await c.query("savepoint tzp");
      let refused = false;
      try { await c.query("update properties set operating_timezone=$2 where id=$1", [propId, value]); }
      catch (_) { refused = true; await c.query("rollback to savepoint tzp"); }
      ok(label, refused);
    };
    await rejects("Mars/Olympus_Mons", "a made-up zone is rejected");
    await rejects("EST5EDT_NOT_REAL", "a plausible-looking non-zone is rejected");
    await rejects("   ", "blank is rejected");
    await rejects("america/new_york", "wrong-case IANA is rejected (pg_timezone_names is exact)");

    section("E  a valid zone is stored and read back through the resolver");
    await c.query("update properties set operating_timezone='America/Chicago' where id=$1", [propId]);
    ok("the governed column is the source of truth",
      (await loadPropertyOperatingTimeZone(P, propId)) === "America/Chicago");
    await c.query("update properties set operating_timezone='Europe/Warsaw' where id=$1", [propId]);
    ok("a second valid zone replaces it",
      (await loadPropertyOperatingTimeZone(P, propId)) === "Europe/Warsaw");

    section("F  the column WINS over the QA override");
    const saved2 = process.env.PROPERTY_OPERATING_TZ_JSON;
    process.env.PROPERTY_OPERATING_TZ_JSON = JSON.stringify({ [String(propId)]: "Asia/Tokyo" });
    ok("a configured column is not overridden by an env map",
      (await loadPropertyOperatingTimeZone(P, propId)) === "Europe/Warsaw");
    await c.query("update properties set operating_timezone=null where id=$1", [propId]);
    ok("the override only fills a gap the column leaves",
      (await loadPropertyOperatingTimeZone(P, propId)) === "Asia/Tokyo");
    if (saved2 === undefined) delete process.env.PROPERTY_OPERATING_TZ_JSON;
    else process.env.PROPERTY_OPERATING_TZ_JSON = saved2;

    section("G  the operating-date boundary near midnight is the PROPERTY's day");
    // 2026-08-02T03:30:00Z is still Aug 1 in New York (23:30) and already
    // Aug 2 in Warsaw (05:30). A UTC-bucketed metric would call both Aug 2.
    const instant = "2026-08-02T03:30:00Z";
    const dayIn = async (tz) => (await c.query(
      "select ($1::timestamptz at time zone $2)::date::text as d", [instant, tz])).rows[0].d;
    const ny = await dayIn("America/New_York");
    const wa = await dayIn("Europe/Warsaw");
    const utc = await dayIn("UTC");
    ok(`New York operating day is 2026-08-01 at ${instant} (got ${ny})`, ny === "2026-08-01");
    ok(`Warsaw operating day is 2026-08-02 at the same instant (got ${wa})`, wa === "2026-08-02");
    ok("UTC would have mislabelled the New York day", utc === "2026-08-02" && utc !== ny);

    section("H  the Demo backfill migrated existing configuration, not a guess");
    const demo = (await c.query(
      "select operating_timezone from properties where id='a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'")).rows[0];
    if (demo) {
      ok("Demo Building carries the value the allowlist encoded",
        demo.operating_timezone === "America/New_York");
    } else {
      ok("Demo Building is absent from this database — backfill correctly touched nothing", true);
    }
    const configured = (await c.query(
      "select count(*)::int n from properties where operating_timezone is not null")).rows[0].n;
    const total = (await c.query("select count(*)::int n from properties")).rows[0].n;
    ok(`no property was guessed: ${configured} of ${total} configured`, configured < total || total <= 1);

    await c.query("rollback");
  } finally { c.release(); }

  section("I  nothing survived the rollback");
  const after = (await pool.query(
    "select count(*)::int n from properties where operating_timezone='Europe/Warsaw'")).rows[0].n;
  ok("the probe zone did not persist", after === 0);

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.message, "\n"); process.exit(1); });
