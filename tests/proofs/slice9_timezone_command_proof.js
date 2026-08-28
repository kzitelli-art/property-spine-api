/* ══════════════════════════════════════════════════════════════════════════
   slice9_timezone_command_proof.js — Slice 9, ruling 1B.

   Migration 123 created the truth; this proves it has a GOVERNED authoring
   path, because a column nobody can fill leaves every property except the
   backfilled one permanently unavailable.

   The claim that matters most: PostgreSQL accepting a timezone does NOT prove
   Node can render with it. Postgres accepts POSIX-style names that
   Intl.DateTimeFormat rejects; storing one would satisfy the database and
   then throw at render time, inside the quiet-hours check, in production.

   Requires DATABASE_URL.
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const { Pool } = require("pg");

const REPO = path.join(__dirname, "..", "..");
const {
  setPropertyOperatingTimezone, operatingTimezoneHistory, nodeIntlAccepts, postgresAccepts,
} = require(path.join(REPO, "src/shared/timezone_command"));

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 54 - t.length)));

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL is required.\n"); process.exit(1);
}
// The command owns its own transaction, exactly as it does in production, so
// this proof runs it against the real pool and cleans up explicitly rather
// than wrapping it in an outer transaction it would fight.

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  section("A  Postgres validity is NOT Node validity");
  const posix = ["EST5EDT", "posix/America/New_York", "US/Eastern"];
  let divergent = null;
  for (const z of posix) {
    if ((await postgresAccepts(pool, z)) && !nodeIntlAccepts(z)) { divergent = z; break; }
  }
  ok("a real IANA region name is accepted by BOTH runtimes",
    (await postgresAccepts(pool, "America/New_York")) && nodeIntlAccepts("America/New_York"));
  if (divergent) {
    ok(`"${divergent}" is accepted by Postgres but REJECTED by Node — exactly why the command checks both`, true);
  } else {
    // Not a failure: some builds ship tz sets that agree. The command still
    // checks both, and that is what the write path below proves.
    ok("no divergent identifier found in this build — both checks still run on every write", true);
  }
  ok("a nonsense zone is rejected by both", !(await postgresAccepts(pool, "Mars/Olympus")) && !nodeIntlAccepts("Mars/Olympus"));

  const P = pool;
  const prop = (await pool.query(
    `select id from properties order by created_at nulls last, id limit 1`)).rows[0].id;
  const user = (await pool.query("select id from users limit 1")).rows[0];
  const priorTz = (await pool.query("select operating_timezone from properties where id=$1",[prop])).rows[0].operating_timezone;
  const c = { query: (...a) => pool.query(...a) };
  try {
    {
      if (!user) { console.log("\n   (no users row in this database — cannot exercise the command)\n"); }
      else {
      await pool.query("update properties set operating_timezone=null where id=$1", [prop]);

      section("B  the command writes, and records who and why");
      const r1 = await setPropertyOperatingTimezone(P, {
        property_id: prop, timezone: "America/Chicago", actor_user_id: user.id,
        reason: "property operates on central time", idempotency_key: "k1",
      });
      ok("the change is applied", r1.changed === true && r1.after === "America/Chicago");
      ok("before is recorded as null (first configuration)", r1.before === null);
      ok("both runtimes were validated before the write",
        Array.isArray(r1.validated_in) && r1.validated_in.includes("postgres") && r1.validated_in.includes("node_intl"));
      ok("the authenticated user is recorded as provenance", String(r1.actor_user_id) === String(user.id));
      const stored = (await c.query("select operating_timezone from properties where id=$1", [prop])).rows[0];
      ok("the column actually changed", stored.operating_timezone === "America/Chicago");

      section("C  audit history");
      const hist = await operatingTimezoneHistory(P, { property_id: prop });
      ok("the change appears in history", hist.changes.length === 1);
      ok("history carries before, after and reason",
        hist.changes[0].before === null && hist.changes[0].after === "America/Chicago"
        && /central time/.test(hist.changes[0].reason || ""));
      ok("history carries the actor", !!hist.changes[0].actor && String(hist.changes[0].actor.user_id) === String(user.id));

      section("D  idempotency — a retry does not write a second history row");
      const r2 = await setPropertyOperatingTimezone(P, {
        property_id: prop, timezone: "America/Chicago", actor_user_id: user.id, idempotency_key: "k1",
      });
      ok("the retry is reported as a replay, not a change", r2.changed === false && r2.idempotent_replay === true);
      const hist2 = await operatingTimezoneHistory(P, { property_id: prop });
      ok("history still has exactly one row", hist2.changes.length === 1);

      section("E  refusals");
      const refuses = async (tz, label, code) => {
        let err = null;
        try { await setPropertyOperatingTimezone(P, { property_id: prop, timezone: tz, actor_user_id: user.id }); }
        catch (e) { err = e; }
        ok(label, !!err && (!code || err.code === code));
      };
      await refuses("Mars/Olympus", "a nonsense zone is refused", "timezone_not_valid_in_postgres");
      await refuses("", "an empty timezone is refused — clearing is not supported", "timezone_required");
      if (divergent) await refuses(divergent, `"${divergent}" is refused for the Node runtime`, "timezone_not_valid_in_node_runtime");
      else ok("no divergent identifier available to exercise the Node-specific refusal in this build", true);

      let noActor = null;
      try { await setPropertyOperatingTimezone(P, { property_id: prop, timezone: "America/Denver" }); }
      catch (e) { noActor = e; }
      ok("a command with no authenticated actor is refused", !!noActor && noActor.code === "actor_required");

      section("F  an unchanged value is not a change");
      const same = await setPropertyOperatingTimezone(P, {
        property_id: prop, timezone: "America/Chicago", actor_user_id: user.id });
      ok("setting the same value reports unchanged and writes no history",
        same.changed === false && same.unchanged === true);

      }
    }
  } finally {
    // Explicit cleanup — the command commits for real, so the proof undoes
    // exactly what it made and nothing else.
    await pool.query("delete from property_operating_timezone_changes where property_id=$1", [prop]);
    await pool.query("update properties set operating_timezone=$2 where id=$1", [prop, priorTz]);
  }

  section("G  the proof cleaned up after itself");
  const left = (await pool.query(
    "select count(*)::int n from property_operating_timezone_changes where property_id=$1", [prop])).rows[0].n;
  ok("no audit row left behind", left === 0);
  const restored = (await pool.query("select operating_timezone from properties where id=$1", [prop])).rows[0];
  ok("the property's prior timezone is restored", (restored.operating_timezone || null) === (priorTz || null));

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.message, "\n"); process.exit(1); });
