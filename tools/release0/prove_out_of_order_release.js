#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   BOUNDARY 7b — WHAT A SCHEMA RELEASE ACTUALLY DOES

   Release 0 needs migration 140. Main's ledger will be at 152. Two
   assumptions were about to be made on the way to sequencing that, and
   both are the kind that are only ever discovered afterwards:

     1. "applying an older-numbered migration after a higher ceiling is
        fine" — assumed, never exercised.
     2. "run 140" — as if migrate.js took a file argument. It does not.
        `pending` is EVERY file missing from the ledger, and the apply
        loop walks all of them.

   Owner ruling: exercise it with the real migrator, do not assume it.

   ── HOW "REAL" IS MADE A PROVEN CLAIM ───────────────────────────────

   migrate.js hardcodes MIGRATIONS_DIR to its own directory, so it cannot
   be pointed at a fixture set. It is therefore COPIED into a temp dir
   beside synthetic .sql files — and the copies are sha256-compared to the
   originals before anything runs. A test that quietly edited the migrator
   to make it testable would prove nothing about the deploy.

   The migrations are synthetic on purpose. The question is the migrator's
   selection and ordering behaviour, not what any particular DDL does, and
   replaying 152 real migrations would test Postgres rather than the
   scheduler.

       PROOF_DATABASE_URL="postgres://…/isolated" \
         node tools/release0/prove_out_of_order_release.js

   REFUSES against anything that looks like production.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

const URL = process.env.PROOF_DATABASE_URL;
const ROOT = path.join(__dirname, "..", "..");
const REAL_MIGRATE = path.join(ROOT, "migrations", "migrate.js");
const REAL_VERDICT = path.join(ROOT, "migrations", "ledger_verdict.js");

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

//  A synthetic migration is a no-op that still has to parse and commit.
const sql = (v) => `-- synthetic ${v}\ncreate table if not exists syn_${v} (x int);\n`;

function stage(versions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migproof-"));
  fs.copyFileSync(REAL_MIGRATE, path.join(dir, "migrate.js"));
  fs.copyFileSync(REAL_VERDICT, path.join(dir, "ledger_verdict.js"));
  //  migrate.js requires 'pg'. Node resolves that by walking up from the
  //  file, and a temp dir has nothing above it — so the copy is linked to
  //  the repo's own node_modules rather than edited to find them. The
  //  migrator's bytes stay identical, which is the point of R0.
  try { fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir"); }
  catch (_) { /* already linked */ }
  versions.forEach((v) => fs.writeFileSync(path.join(dir, `${v}_synthetic.sql`), sql(v)));
  return dir;
}

function run(dir, env) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, "migrate.js")], {
      env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME,
                           DATABASE_URL: URL }, env || {}),
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e) { return { out: String(e.stdout || "") + String(e.stderr || ""), code: e.status }; }
}

(async function main() {
  if (!URL) { console.error("\nREFUSED: PROOF_DATABASE_URL is not set.\n"); process.exit(2); }
  //  This proof WRITES. It must never be pointed at the real database.
  if (/neon\.tech|render\.com/i.test(URL)) {
    console.error("\nREFUSED: PROOF_DATABASE_URL looks like a hosted production database.");
    console.error("This proof applies migrations. Point it at an isolated instance.\n");
    process.exit(2);
  }

  console.log("\n" + "═".repeat(68));
  console.log("  BOUNDARY 7b · WHAT A SCHEMA RELEASE ACTUALLY DOES");
  console.log("═".repeat(68));
  console.log("  ASSERTIONS STARTED\n");

  const db = new Client({ connectionString: URL });
  await db.connect();
  const reset = async () => {
    await db.query("drop schema public cascade; create schema public;");
  };

  // ── R0 · the migrator under test is the deployed one ──────────────
  const d0 = stage(["001"]);
  ok("R0a the copied migrate.js is byte-identical to migrations/migrate.js",
     sha(path.join(d0, "migrate.js")) === sha(REAL_MIGRATE),
     "the proof is running a modified migrator and proves nothing about the deploy");
  ok("R0b the copied ledger_verdict.js is byte-identical too",
     sha(path.join(d0, "ledger_verdict.js")) === sha(REAL_VERDICT));

  // ── A · THE ORDERING QUESTION ─────────────────────────────────────
  //  Ledger at 152. A 140 arrives. Does the real migrator run it, refuse
  //  it, or run it in the wrong place?
  await reset();
  const dA1 = stage(["150", "151", "152"]);
  const seedA = run(dA1, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "000" });
  ok("A0  a database at ceiling 152 was established",
     seedA.code === 0 && /152_synthetic\.sql/.test(seedA.out), seedA.out.slice(-400));

  const dA2 = stage(["140", "150", "151", "152"]);
  const verifyA = run(dA2);
  ok("A1  with 140 pending, VERIFY-ONLY refuses to start",
     verifyA.code === 1 && /REFUSING TO START/.test(verifyA.out) && /140_synthetic\.sql/.test(verifyA.out),
     "a deploy carrying an unapplied 140 would boot against a schema without it:\n        " +
     verifyA.out.split("\n").slice(-14).join("\n        "));

  //  The ceiling the release must state is the LEDGER max — 152, not 140.
  ok("A2  …and it names 152 as the ceiling to state, not 140",
     /EXPECTED_LEDGER_CEILING=152/.test(verifyA.out),
     "the refusal quotes the wrong ceiling; an operator copying it would be refused");

  const releaseA = run(dA2, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "152" });
  ok("A3  a release of 140 against a ledger at 152 is ACCEPTED — not refused",
     releaseA.code === 0 && /140_synthetic\.sql\s+— applying/.test(releaseA.out),
     "THE ASSUMPTION WAS WRONG. Out-of-order application is refused, and 7b needs a " +
     "different plan entirely:\n        " + releaseA.out.split("\n").slice(-14).join("\n        "));
  ok("A4  …and 150/151/152 are skipped as already applied, not re-run",
     /150_synthetic\.sql\s+— already applied/.test(releaseA.out) &&
     /152_synthetic\.sql\s+— already applied/.test(releaseA.out),
     releaseA.out.slice(-600));

  const afterA = (await db.query(
    "select version from schema_migrations order by version")).rows.map((r) => r.version);
  ok("A5  the ledger now holds 140 alongside 150/151/152",
     ["140", "150", "151", "152"].every((v) => afterA.includes(v)),
     "ledger: " + afterA.join(", "));

  //  NON-OBVIOUS, AND IT WILL BITE THE NEXT RELEASE. `ceiling` is the max
  //  ledger key, so applying 140 does NOT move it. The next release must
  //  still state 152. An operator who reasons "I just released 140, so the
  //  ceiling is 140" gets refused and will assume the database drifted.
  const nextCeiling = run(stage(["140", "150", "151", "152", "153"]));
  ok("A6  applying 140 does NOT move the ceiling — it is still 152",
     /EXPECTED_LEDGER_CEILING=152/.test(nextCeiling.out),
     "the ceiling moved to something else; the sequencing note below is wrong:\n        " +
     nextCeiling.out.split("\n").slice(-8).join("\n        "));

  // ── B · THE BATCHING HAZARD ───────────────────────────────────────
  //  "Run 140" is not a thing migrate.js can do. This measures what the
  //  command actually releases.
  await reset();
  const dB1 = stage(["137"]);
  run(dB1, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "000" });
  const dB2 = stage(["137", "138", "139", "140", "150", "151", "152"]);

  const verifyB = run(dB2);
  const pendingNamed = (verifyB.out.match(/·\s+(\d{3})_synthetic\.sql/g) || [])
    .map((s) => s.match(/(\d{3})/)[1]);
  ok("B1  verify names ALL six pending files, not just the one we want",
     ["138", "139", "140", "150", "151", "152"].every((v) => pendingNamed.includes(v)),
     "named pending: " + pendingNamed.join(", "));

  const releaseB = run(dB2, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "137" });
  const appliedB = (await db.query(
    "select version from schema_migrations order by version")).rows.map((r) => r.version);
  ok("B2  a single release applied ALL SIX — there is no per-file selection",
     releaseB.code === 0 && ["138", "139", "140", "150", "151", "152"].every((v) => appliedB.includes(v)),
     "ledger after: " + appliedB.join(", "));
  ok("B3  …and it applied them in numeric order, 138 before 150",
     releaseB.out.indexOf("138_synthetic") < releaseB.out.indexOf("150_synthetic"),
     "ordering is not numeric — a dependency between them could not be relied on");

  //  This is the finding, stated as an assertion so it cannot be lost:
  //  releasing 140 from a ledger below 150 also releases the property
  //  creation schema. Release 0 would become its release vehicle.
  ok("B4  THE HAZARD: from a ledger at 137, releasing 140 also releases 150/151/152",
     ["150", "151", "152"].every((v) => appliedB.includes(v)),
     "if this is now false the batching hazard has been fixed and the sequencing " +
     "constraint below can be relaxed");

  // ── C · THE OTHER DIRECTION ───────────────────────────────────────
  //  A ledger holding a version this build has no file for. That is the
  //  138/139/140-already-applied case — the one nobody has measured.
  await reset();
  const dC1 = stage(["138", "139", "140", "150"]);
  run(dC1, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "000" });
  const dC2 = stage(["150"]);                       // a build WITHOUT 138/139/140
  const verifyC = run(dC2);
  ok("C1  a build missing files the ledger has REFUSES TO START",
     verifyC.code === 1 && /LEDGER VERSION MISSING FROM THIS REPOSITORY/.test(verifyC.out),
     "main could run against a database holding Release 0 migrations it has no files " +
     "for, and nobody would be told:\n        " + verifyC.out.split("\n").slice(-12).join("\n        "));
  ok("C2  …and it names every version it cannot account for",
     ["138", "139", "140"].every((v) => new RegExp("\\b" + v + "\\b").test(verifyC.out)),
     verifyC.out.slice(-500));

  // ── D · THE RELEASE CANNOT BE RUN BLIND ───────────────────────────
  await reset();
  run(stage(["150"]), { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "000" });
  const dD = stage(["150", "151"]);
  const noCeiling = run(dD, { MIGRATION_RELEASE: "1" });
  ok("D1  a release with no EXPECTED_LEDGER_CEILING is refused",
     noCeiling.code === 1 && /EXPECTED_LEDGER_CEILING is required/.test(noCeiling.out));
  const wrongCeiling = run(dD, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "137" });
  ok("D2  a release stating the WRONG ceiling is refused",
     wrongCeiling.code === 1 && /the ledger is not in the expected state/i.test(wrongCeiling.out));
  const wrongSha = run(dD, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "150",
                             RENDER_GIT_COMMIT: "aaaaaaaaaaaa", EXPECTED_SHA: "bbbbbbbbbbbb" });
  ok("D3  a release on a deployed build whose SHA was not authorised is refused",
     wrongSha.code === 1 && /not the build you authorised/i.test(wrongSha.out));

  // ── E · VERIFY NEVER WRITES ───────────────────────────────────────
  await reset();
  run(stage(["150"]), { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "000" });
  const before = (await db.query("select count(*)::int n from schema_migrations")).rows[0].n;
  run(stage(["150", "151", "152"]));                 // verify-only, 2 pending
  const after = (await db.query("select count(*)::int n from schema_migrations")).rows[0].n;
  ok("E1  a verify-only run with pending migrations wrote nothing",
     before === after, `ledger rows went ${before} → ${after}`);

  await db.end();

  console.log("\n" + "═".repeat(68));
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("");
    console.log("  Out-of-order IS permitted: 140 applies cleanly over a ledger at 152,");
    console.log("  and the ceiling stays 152 afterwards.");
    console.log("  But a release applies EVERY pending file. Releasing 140 from a ledger");
    console.log("  below 150 releases the property-creation schema with it.");
    console.log("  => 150/151/152 must be in the ledger BEFORE 140 is released.");
  }
  console.log("═".repeat(68) + "\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
