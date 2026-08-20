#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    predeploy_release_gate.js — THE 182→187 RELEASE, AS A DEPLOY GATE.

    Configured as the Render PRE-DEPLOY COMMAND for exactly one release,
    then removed. It runs after the new build exists and BEFORE that build
    starts serving, on a separate instance from the one currently serving.

    WHY IT IS SHAPED THIS WAY, AND NOT AS "schema first, deploy later".

    Migrations 182-187 are runtime-compatible with the old build but
    RESTART-INCOMPATIBLE with it. Measured, not assumed: the old build's
    own prestart verifier checks the ledger in BOTH directions and refuses
    on entries whose files it does not carry —

        185  the ledger says: spine_execution_basis
             -> migrations/185_*.sql does not exist in this build.

    So the instant 182-187 land, the currently-deployed code keeps serving
    but can never start again, and reverting the code is blocked by the
    same guard. A schema-first release with a gap therefore leaves
    production alive on borrowed time, with no restart recovery and no
    rollback. This gate exists to make that gap ZERO: the schema moves and
    the build that understands it starts, inside one deploy.

    A non-zero exit here aborts the deploy. The new build does not start,
    and the old one keeps serving — which is the correct outcome, because
    a failure here means the schema was NOT changed.

    IT IS SAFE TO RUN TWICE. Render runs a pre-deploy command on every
    deploy while it is configured. Finding the release already applied is
    a success, not a failure: it re-verifies the shape and exits 0.
    Finding any ceiling other than the expected start or the expected end
    is a stop, because this gate refuses to guess.

    NO psql. Deployed instances are not guaranteed a Postgres client, so
    every check here is Node against the app's own `pg`.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const START_CEILING  = Number(process.env.EXPECTED_START_CEILING  || 181);
const START_ENTRIES  = Number(process.env.EXPECTED_START_ENTRIES  || 169);
const RELEASE        = ["182", "183", "184", "185", "186", "187"];
const END_CEILING    = 187;
const END_ENTRIES    = START_ENTRIES + RELEASE.length;

function loadPg() {
  for (const c of [path.join(ROOT, "node_modules", "pg"), "pg",
                   "/opt/render/project/src/node_modules/pg",
                   path.join(process.cwd(), "node_modules", "pg")]) {
    try { return require(c); } catch (_) { /* next */ }
  }
  die("cannot load the `pg` driver — this gate cannot verify anything without it.");
}

const line = (s = "") => console.log(s);
const rule = () => line("════════════════════════════════════════════════════════════════");
function die(msg, detail) {
  line(); rule();
  line("  ✗ RELEASE GATE REFUSED — the deploy is aborted, the schema is unchanged.");
  line();
  line("    " + msg);
  if (detail) String(detail).split("\n").forEach((l) => line("    " + l));
  rule();
  process.exit(1);
}

//  THE SIX PREFLIGHTS. Each asks a question about REAL ROWS that a
//  migration in this set could be refused by. Every one must return 0.
//  183 replaces a unique index, so duplicates would refuse it; 184 and 185
//  narrow CHECKs, and 185's lineage constraint is validated against rows
//  that already exist. These are the only failures a rehearsal on an empty
//  database cannot find, which is exactly why they run here.
const PREFLIGHTS = [
  ["dup default pricing terms", `
     select count(*)::int as n from (
       select 1 from pricing_terms
        where unit_type_id is not null and override_scope is null
        group by pricing_version_id, unit_type_id, lease_term_months
       having count(*) > 1) x`],
  ["dup override pricing terms", `
     select count(*)::int as n from (
       select 1 from pricing_terms
        where unit_type_id is not null and override_scope is not null
        group by pricing_version_id, unit_type_id, lease_term_months, override_scope, override_ref
       having count(*) > 1) x`],
  ["signer_role outside the new set", `
     select count(*)::int as n from lease_packet_fields
      where signer_role not in ('tenant','guarantor','company')`],
  ["packet status outside the new set", `
     select count(*)::int as n from lease_packets
      where status not in ('draft','sent','tenant_in_progress','submitted',
                           'resident_executed','executed','voided')`],
  ["execution_channel outside the new set", `
     select count(*)::int as n from executed_lease_records
      where execution_channel not in ('paper','external_esign','spine_esign','other')`],
  ["pre-existing spine_esign records", `
     select count(*)::int as n from executed_lease_records
      where execution_channel = 'spine_esign'`],
];

function runNode(label, args, env) {
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, env || {}),
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status };
  }
}

(async () => {
  const { Pool } = loadPg();
  const url = process.env.DATABASE_URL;
  if (!url) die("DATABASE_URL is not set. This gate cannot read the ledger.");

  //  Match the app's own SSL posture rather than inventing one.
  let ssl = { rejectUnauthorized: false };
  try {
    const h = new URL(url).hostname;
    if (["127.0.0.1", "localhost", "::1", ""].includes(h)) ssl = false;
  } catch (_) { /* keep the safe default */ }
  const pool = new Pool({ connectionString: url, ssl });

  rule();
  line("  PROPERTY SPINE — PRE-DEPLOY RELEASE GATE  ·  182 → 187");
  line("  " + url.replace(/\/\/[^@]*@/, "//****@"));
  rule();

  //  ── 1 · READ THE LEDGER. Never typed from memory or from a document.
  let ceiling, entries;
  try {
    const r = await pool.query(
      "select max(version::int)::int as ceiling, count(*)::int as entries from schema_migrations");
    ceiling = r.rows[0].ceiling; entries = r.rows[0].entries;
  } catch (e) { await pool.end(); die("could not read schema_migrations.", e.message); }
  line(`  ledger: ceiling ${ceiling} · ${entries} entries`);

  //  ── 2 · ALREADY RELEASED? Verify the shape and let the deploy proceed.
  if (ceiling === END_CEILING) {
    line("  the release is already applied — re-verifying its shape, not re-applying.");
    await pool.end();
    const v = runNode("after", [path.join(ROOT, "tests/e2e/verify_release_182_187.js"),
                                "--db", url, "--after"],
                      { EXPECTED_START_ENTRIES: String(START_ENTRIES) });
    line(v.out.trimEnd());
    if (!v.ok) die("the schema is at 187 but does NOT have the expected shape.");
    line(); rule();
    line("  ✓ ALREADY RELEASED AND VERIFIED — the deploy may proceed.");
    rule();
    process.exit(0);
  }

  //  ── 3 · ANYTHING ELSE IS A STOP. This gate refuses to guess.
  if (ceiling !== START_CEILING) {
    await pool.end();
    die(`expected the ledger at ${START_CEILING} (or already at ${END_CEILING}); found ${ceiling}.`,
        "Production is not in the state this release was rehearsed against.\n" +
        "Re-read the ledger and re-plan. Nothing was changed.");
  }
  if (entries !== START_ENTRIES) {
    await pool.end();
    die(`ceiling ${START_CEILING} is right but the entry count is ${entries}, expected ${START_ENTRIES}.`,
        "The ledger has changed since the rehearsal. Stop and reconcile it.");
  }
  for (const v of RELEASE) {
    const r = await pool.query("select 1 from schema_migrations where version=$1", [v]);
    if (r.rowCount) { await pool.end(); die(`migration ${v} is already in the ledger at ceiling ${ceiling}.`); }
  }
  line(`  start state confirmed: ceiling ${START_CEILING}, ${START_ENTRIES} entries, none of 182-187 present`);

  //  ── 4 · THE SIX PREFLIGHTS, AGAINST REAL ROWS.
  line();
  line("  ── preflight ──");
  let dirty = 0;
  for (const [label, sql] of PREFLIGHTS) {
    let n;
    try { n = (await pool.query(sql)).rows[0].n; }
    catch (e) { await pool.end(); die(`preflight "${label}" could not run.`, e.message); }
    line(`     ${n === 0 ? "✓" : "✗"} ${label.padEnd(38)} ${n}`);
    if (n !== 0) dirty++;
  }
  await pool.end();
  if (dirty) die(`${dirty} preflight check(s) are non-zero.`,
                 "Real rows would refuse one of these migrations. Nothing was applied.");

  //  ── 5 · APPLY, through the real release command and its own refusals.
  //  EXPECTED_SHA is the commit Render actually built. migrate.js requires
  //  it on a deployed build, and that is what ties this schema change to a
  //  named, reviewed artifact rather than to "whatever was current".
  const sha = process.env.RENDER_GIT_COMMIT || process.env.EXPECTED_SHA || "";
  if (!sha) die("neither RENDER_GIT_COMMIT nor EXPECTED_SHA is set.",
                "A schema release must name the build it belongs to.");
  line();
  line(`  ── applying 182-187 · pinned to ${sha.slice(0, 12)} ──`);
  const ap = runNode("apply", [path.join(ROOT, "migrations/migrate.js"), "--apply"], {
    MIGRATION_RELEASE: "1",
    EXPECTED_LEDGER_CEILING: String(START_CEILING),
    EXPECTED_SHA: sha,
  });
  ap.out.split("\n").filter((l) => /→|✓|✗|REFUS|applied|Done/.test(l))
        .forEach((l) => line("  " + l.trimEnd()));
  if (!ap.ok) die("the release command refused or failed.", "See its output above.");

  //  ── 6 · THE DATABASE-DERIVED VERDICT. The runner's prose is not proof.
  line();
  line("  ── verifying the released shape ──");
  const af = runNode("after", [path.join(ROOT, "tests/e2e/verify_release_182_187.js"),
                               "--db", url, "--after"],
                     { EXPECTED_START_ENTRIES: String(START_ENTRIES) });
  line(af.out.trimEnd());
  if (!af.ok) die("the schema changed but does NOT verify.",
                  "Do NOT let this build start. Investigate before anything else deploys.");

  line(); rule();
  line(`  ✓ RELEASE VERIFIED — ceiling ${END_CEILING}, ${END_ENTRIES} entries expected.`);
  line("    The new build may start. It carries 182-187, so its own startup");
  line("    verifier will now agree with the ledger it just moved.");
  rule();
  process.exit(0);
})().catch((e) => die("the gate itself threw.", e && e.stack ? e.stack : String(e)));
