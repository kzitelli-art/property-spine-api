#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE GATE 1 CENSUS MUST DISCRIMINATE

   gate1_production_census.js will be run once, against production, and a
   release decision will be made from its output. It gets exactly one
   chance to be right, and nobody will be in a position to sanity-check it
   — that is the whole reason it exists.

   So it is exercised here against three ledgers built to look like the
   three states production could actually be in, and each must produce a
   different, correct verdict. A census that printed the same reassuring
   sheet regardless would be the most expensive kind of green.

   The ledger rows are inserted directly rather than by applying 152 real
   migrations: the census reads schema_migrations and nothing else, so the
   DDL is irrelevant to what is being tested and replaying it would only
   test Postgres.

       PROOF_DATABASE_URL="postgres://…/isolated" \
         node tools/release0/prove_gate1_census.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

const URL = process.env.PROOF_DATABASE_URL;
const ROOT = path.join(__dirname, "..", "..");
const TOOL = path.join(__dirname, "gate1_production_census.js");

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

const FILES = fs.readdirSync(path.join(ROOT, "migrations"))
  .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_")).sort();

function run(env) {
  try {
    const out = execFileSync(process.execPath, [TOOL], {
      env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME,
                           DATABASE_URL: URL }, env || {}),
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e) { return { out: String(e.stdout || "") + String(e.stderr || ""), code: e.status }; }
}

(async function main() {
  if (!URL) { console.error("\nREFUSED: PROOF_DATABASE_URL is not set.\n"); process.exit(2); }
  if (/neon\.tech|render\.com/i.test(URL)) {
    console.error("\nREFUSED: this proof writes ledger rows. Use an isolated database.\n");
    process.exit(2);
  }

  console.log("\n" + "═".repeat(68));
  console.log("  PROOF · the Gate 1 census tells the three states apart");
  console.log("═".repeat(68));
  console.log("  ASSERTIONS STARTED\n");

  const db = new Client({ connectionString: URL });
  await db.connect();

  //  Build a ledger containing exactly the named files.
  const seed = async (exclude) => {
    await db.query("drop table if exists schema_migrations");
    await db.query(`create table schema_migrations (
      version text primary key, name text not null,
      applied_at timestamptz not null default now())`);
    for (const f of FILES) {
      const v = f.slice(0, 3);
      if (exclude.includes(v)) continue;
      await db.query("insert into schema_migrations (version, name) values ($1,$2)",
        [v, f.slice(4, -4)]);
    }
  };
  const extra = async (versions) => {
    for (const v of versions) {
      await db.query("insert into schema_migrations (version, name) values ($1,$2)",
        [v, "release_0_" + v]);
    }
  };

  // ── STATE 1 · everything in main is applied ───────────────────────
  await seed([]);
  const s1 = run();
  ok("S1a a fully-applied ledger reports VERIFY-ONLY WOULD PASS",
     s1.code === 0 && /VERIFY-ONLY WOULD PASS/.test(s1.out),
     "exit " + s1.code + "\n        " + s1.out.split("\n").slice(-16).join("\n        "));
  ok("S1b …and says Boundary 7 can be re-frozen",
     /150\/151\/152 are applied/.test(s1.out) && /can be re-frozen/.test(s1.out));
  ok("S1c …and reports 138/139/140 absent, 140 still a clean number",
     /138\/139\/140 are absent from the ledger/.test(s1.out) &&
     /140 is still a clean, unspent number/.test(s1.out));
  ok("S1d …and reports the ceiling as 152", /ledger ceiling\s+152/.test(s1.out),
     s1.out.split("\n").filter((l) => /ceiling/.test(l)).join("\n        "));

  // ── STATE 2 · 150/151/152 NOT applied ─────────────────────────────
  //  The state that stops Boundary 7 dead.
  await seed(["150", "151", "152"]);
  const s2 = run();
  ok("S2a a ledger missing 150/151/152 REFUSES", s2.code === 1 &&
     /VERIFY-ONLY WOULD REFUSE TO START/.test(s2.out),
     "exit " + s2.code + " — the census would have green-lit a deploy that cannot boot");
  ok("S2b …and names all three as pending",
     ["150", "151", "152"].every((v) => new RegExp("· " + v + "_").test(s2.out)),
     s2.out.split("\n").filter((l) => /·/.test(l)).join("\n        "));
  ok("S2c …and says STOP, naming the release-vehicle hazard",
     /STOP\. 150\/151\/152 are NOT applied/.test(s2.out) &&
     /release vehicle for the/.test(s2.out));
  ok("S2d …and warns that --apply would take all three, not one",
     /a release applies EVERY pending file/i.test(s2.out) ||
     /applies EVERY pending file/.test(s2.out),
     "the batching warning did not fire on a multi-pending ledger");
  ok("S2e …and the ceiling it reports is the LEDGER's, not the repo's",
     /ledger ceiling\s+137/.test(s2.out),
     "ceiling line: " + (s2.out.split("\n").find((l) => /ledger ceiling/.test(l)) || "?"));

  // ── STATE 3 · a branch deploy already applied 138/139/140 ─────────
  //  The direction nobody had measured. Main has no files for these.
  await seed([]);
  await extra(["138", "139", "140"]);
  const s3 = run();
  ok("S3a a ledger holding 138/139/140 REFUSES", s3.code === 1 &&
     /VERIFY-ONLY WOULD REFUSE TO START/.test(s3.out), "exit " + s3.code);
  ok("S3b …and names them as ledger versions with no file here",
     /ledger versions with no file here\s*:\s*3/.test(s3.out),
     s3.out.split("\n").filter((l) => /no file here/.test(l)).join("\n        "));
  ok("S3c …and says main cannot start until those files are merged",
     /ALSO STOP\./.test(s3.out) && /until those files are merged/.test(s3.out));
  ok("S3d …and the ceiling is still 152, because 140 < 152",
     /ledger ceiling\s+152/.test(s3.out),
     "the ceiling moved when a lower number was added — the sequencing note is wrong");

  // ── SAFETY · the census never writes ──────────────────────────────
  await seed([]);
  const before = (await db.query("select count(*)::int n from schema_migrations")).rows[0].n;
  run();
  const after = (await db.query("select count(*)::int n from schema_migrations")).rows[0].n;
  ok("X1  the census wrote nothing", before === after, `${before} → ${after}`);
  ok("X2  it proves read-only before reading, and says so",
     /read-only\s+PROVEN/.test(run().out),
     "the read-only line is missing — the guard may not have run at all");

  // ── SAFETY · nothing it prints can leak the credential ────────────
  const leak = run().out;
  ok("X3  the output contains no connection string",
     !/postgres:\/\//.test(leak) && !URL.split("@").pop().split("/")[0].split(":")[0]
       .split(".").every((p) => p.length > 2 && leak.includes(p)),
     "the census echoed something from DATABASE_URL — it is meant to be pasteable");

  const noUrl = (() => {
    try {
      execFileSync(process.execPath, [TOOL], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { out: "", code: 0 };
    } catch (e) { return { out: String(e.stdout || "") + String(e.stderr || ""), code: e.status }; }
  })();
  ok("X4  with no DATABASE_URL it refuses and tells you not to paste one",
     noUrl.code === 2 && /Do not paste a production connection string/.test(noUrl.out));

  await db.end();

  console.log("\n" + "═".repeat(68));
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("  Three states, three different verdicts. The census can be trusted");
    console.log("  with the one reading it gets to take.");
  }
  console.log("═".repeat(68) + "\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
