#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GATE 1 — WHAT IS ACTUALLY IN PRODUCTION, BEFORE ANY DECISION

   Boundary 7 is code-only. It was rebased onto main, and main now carries
   migrations 150/151/152. Since `prestart` VERIFIES rather than applies,
   a build whose migration files are not all in the target ledger REFUSES
   TO START. So a code-only Release 0 step can fail to boot for reasons
   that have nothing to do with Release 0.

   That cuts both ways, and the second direction is the one that gets
   missed: the migrator also refuses when the LEDGER holds a version this
   build has no file for. Release 0's own 138/139/140 live on an unmerged
   branch. If any earlier branch deploy put them into production's ledger
   — which is exactly how 121 and 126 got there, by this repo's own record
   — then main cannot start either, and nobody has looked.

   This tool looks. It applies nothing and decides nothing.

       DATABASE_URL="<production>" node tools/release0/gate1_production_census.js

   Run it ON the deployed instance, where DATABASE_URL already exists.
   Nothing it prints contains the connection string.

   ── WHAT IT REPORTS ─────────────────────────────────────────────────

     1  the SHA this process is running
     2  the ledger ceiling
     3  150 / 151 / 152 — applied or not, one line each
     4  138 / 139 / 140 — the Release 0 migrations, same treatment
     5  pending files, ledger-only versions, and the verify-only verdict

   ── IT DOES NOT HOLD A SECOND OPINION ───────────────────────────────

   The verdict comes from migrations/ledger_verdict.js — the same module
   `prestart` runs. A census that reimplemented the classification could
   report a clean database that the real migrator then refuses to start
   against, which is worse than not looking: it would be a green light
   issued by something that is not the gate.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly } = require("../activation/_readonly.js");
const { classifyLedger } = require("../../migrations/ledger_verdict.js");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "migrations");

const RELEASE_0 = ["138", "139", "140"];
const MAIN_NEW  = ["150", "151", "152"];

const bar = "═".repeat(68);
const say = (k, v) => console.log("  " + String(k).padEnd(34, " ") + v);

(async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\n  REFUSED: DATABASE_URL is not set.");
    console.error("  Run this ON the deployed instance, where it already exists.");
    console.error("  Do not paste a production connection string anywhere.\n");
    process.exit(2);
  }

  console.log("\n" + bar);
  console.log("  GATE 1 · PRODUCTION MIGRATION CENSUS   (read-only, applies nothing)");
  console.log(bar + "\n");

  //  1 · WHAT IS RUNNING. Before the database, because if this is not the
  //  deployed instance then every number below describes something else.
  const sha = process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || null;
  say("running SHA", sha ? sha.slice(0, 12) : "UNKNOWN");
  if (!sha) {
    console.log("        RENDER_GIT_COMMIT / GIT_SHA is not set in this process.");
    console.log("        A census taken from a local checkout says nothing about what");
    console.log("        production is running. Read the SHA from the platform, or run");
    console.log("        this on the instance.");
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
  } catch (e) {
    //  SANITISED. A pg connection error can carry the host, the user and
    //  occasionally the whole URL, and this output is meant to be pasted
    //  into a conversation.
    console.error("\n  ✗ could not connect: " + (e.code || "connection failed"));
    console.error("    (detail withheld — connection errors can echo the credential)\n");
    process.exit(2);
  }

  //  2 · PROVEN READ-ONLY, BEFORE THE FIRST READ.
  const ro = await beginProvenReadOnly(client, "gate1_census");
  if (!ro.ok) {
    console.error("\n  ✗ REFUSED — read-only could not be proven.");
    console.error("    " + ro.reason);
    console.error("    Nothing was read.\n");
    await client.end();
    process.exit(2);
  }
  say("read-only", "PROVEN — a write was attempted and refused");
  console.log("");

  //  3 · THE LEDGER.
  let ledgerRows = null, ledgerError = null;
  try {
    ledgerRows = (await client.query(
      "select version, name from schema_migrations order by version")).rows;
  } catch (e) {
    ledgerError = e.code === "42P01" ? "NO LEDGER TABLE" : (e.code || "read failed");
  }

  if (ledgerError) {
    say("schema_migrations", ledgerError);
    console.log("\n  ✗ Cannot census a database with no ledger. Nothing else below is");
    console.log("    meaningful. Stop here and resolve it.\n");
    await client.query("rollback").catch(() => {});
    await client.end();
    process.exit(1);
  }

  const files = fs.readdirSync(MIGRATIONS)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_")).sort();
  const verdict = classifyLedger({ files, ledgerRows });
  const inLedger = new Map(ledgerRows.map((r) => [r.version, r.name]));

  say("ledger ceiling", verdict.ceiling);
  say("ledger rows", String(ledgerRows.length));
  say("migration files in this build", String(files.length));
  console.log("");

  //  4 · THE TWO SETS THAT DECIDE THIS.
  console.log("  ── main's new migrations · do they exist in production? ──────────");
  MAIN_NEW.forEach((v) => {
    const hasFile = files.some((f) => f.startsWith(v + "_"));
    const applied = inLedger.has(v);
    console.log(`     ${v}   file:${hasFile ? "yes" : "NO "}   ledger:${applied ? "APPLIED" : "not applied"}` +
      (applied ? `   (${inLedger.get(v)})` : ""));
  });
  const mainNewMissing = MAIN_NEW.filter((v) => !inLedger.has(v));
  console.log("");

  console.log("  ── Release 0's migrations · are they already in the ledger? ──────");
  RELEASE_0.forEach((v) => {
    const hasFile = files.some((f) => f.startsWith(v + "_"));
    const applied = inLedger.has(v);
    console.log(`     ${v}   file:${hasFile ? "yes" : "NO "}   ledger:${applied ? "APPLIED" : "not applied"}` +
      (applied ? `   (${inLedger.get(v)})` : ""));
  });
  const r0Applied = RELEASE_0.filter((v) => inLedger.has(v));
  console.log("");

  //  5 · THE VERDICT THE DEPLOY WOULD REACH.
  console.log("  ── what `prestart` would do with THIS build ──────────────────────");
  const pending = verdict.fileMissingFromLedger;
  const orphans = verdict.ledgerVersionMissingFromRepo;
  const dupes = verdict.duplicateFileNumbers;
  const spent = verdict.versionNameConflicts;

  console.log(`     pending files (in build, not in ledger) : ${pending.length}`);
  pending.forEach((f) => console.log(`         · ${f}`));
  console.log(`     ledger versions with no file here       : ${orphans.length}`);
  orphans.forEach((o) => console.log(`         · ${o.version}  ${o.ledgerName}`));
  console.log(`     duplicate file numbers                  : ${dupes.length}`);
  console.log(`     numbers already spent under another name: ${spent.length}`);
  console.log("");

  const wouldStart = !pending.length && !orphans.length && !dupes.length && !spent.length;
  console.log("  " + bar.slice(2));
  if (wouldStart) {
    console.log("  ✓ VERIFY-ONLY WOULD PASS — this build boots against this database.");
  } else {
    console.log("  ⛔ VERIFY-ONLY WOULD REFUSE TO START.");
    if (pending.length) {
      console.log("     Cause: migration file(s) in this build are not in the ledger.");
      console.log("     A deploy will NOT apply them. It will fail, and Render will keep");
      console.log("     the previous instance live — so the API looks fine while the new");
      console.log("     code never runs.");
    }
    if (orphans.length) {
      console.log("     Cause: the ledger holds version(s) this build has no file for.");
      console.log("     The schema contains changes this code cannot describe.");
    }
  }
  console.log("  " + bar.slice(2));
  console.log("");

  //  6 · THE TWO RELEASE-0-SPECIFIC READINGS, STATED PLAINLY.
  console.log("  ── what this means for Release 0 ─────────────────────────────────");
  if (mainNewMissing.length) {
    console.log(`     STOP. ${mainNewMissing.join("/")} are NOT applied to this database.`);
    console.log("     Boundary 7 is code-only, but it now carries those files, so");
    console.log("     deploying it would refuse to start — and releasing them to fix");
    console.log("     that would make Release 0 the release vehicle for the");
    console.log("     property-creation schema. That is a different campaign's change.");
  } else {
    console.log("     150/151/152 are applied. Boundary 7 carries no schema of its own,");
    console.log("     so it can be re-frozen against the deployed base and proven.");
  }
  //  THE LEDGER DECIDES THIS, NOT THE REPO.
  //
  //  Owner correction: migration numbers do not have to be contiguous, and
  //  the repo jumping 137 -> 150 is not itself a finding. 140 being absent
  //  from main proves only that it has not merged to main — it says
  //  nothing about whether some branch deploy applied a 140 here. So this
  //  section reports what the LEDGER holds and does not infer from the
  //  gap. (Separately proven in source: 140 references nothing created by
  //  138 or 139; its dependencies stop at 137. See
  //  tools/release0/prove_140_dependencies.js.)
  const r0Orphans = r0Applied.filter((v) => !files.some((f) => f.startsWith(v + "_")));
  if (r0Applied.length) {
    console.log(`     ALSO STOP. The ledger contains ${r0Applied.join("/")}.`);
    if (r0Orphans.length) {
      console.log(`     This build has no file for ${r0Orphans.join("/")}, so it cannot start`);
      console.log("     against this database. Something applied them — a branch deploy is");
      console.log("     how 121 and 126 got there. Identify WHICH commit applied them and");
      console.log("     restore those exact definitions before anything else moves.");
      console.log("     Do not add a documented exception merely to turn verify green.");
    } else {
      console.log("     Files for them exist in this build, so verify is satisfied on that");
      console.log("     count. Confirm the applied definitions match the files.");
    }
  } else {
    console.log("     The ledger contains none of 138/139/140, so nothing here has");
    console.log("     applied them. 140 is an unspent number on THIS database.");
  }
  console.log("");

  //  7 · THE PRE-RELEASE INVARIANT.
  //
  //  Owner ruling, and it is stronger than reasoning from migration
  //  numbers: before releasing 140, `fileMissingFromLedger` must contain
  //  exactly the intended file and nothing else. That is checkable, it
  //  does not care what the numbers are, and it is the only formulation
  //  that survives main moving again.
  //
  //      EXPECTED_PENDING=140_post_activation_completion_guard.sql \
  //        node tools/release0/gate1_production_census.js
  const expectPending = (process.env.EXPECTED_PENDING || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  let invariantHeld = null;
  if (expectPending.length) {
    const extra = pending.filter((f) => !expectPending.includes(f));
    const absent = expectPending.filter((f) => !pending.includes(f));
    invariantHeld = !extra.length && !absent.length;
    console.log("  ── pre-release invariant ─────────────────────────────────────────");
    console.log(`     stated intent : ${expectPending.join(", ")}`);
    console.log(`     actually pending: ${pending.length ? pending.join(", ") : "(nothing)"}`);
    if (invariantHeld) {
      console.log("     ✓ HOLDS — a release now applies exactly what you named.");
    } else {
      console.log("     ⛔ DOES NOT HOLD. Do not release.");
      if (extra.length) {
        console.log(`       would ALSO apply: ${extra.join(", ")}`);
        console.log("       migrate.js has no per-file selection. These ship with it.");
      }
      if (absent.length) {
        console.log(`       named but NOT pending: ${absent.join(", ")}`);
        console.log("       either already applied, or the file is not in this build.");
      }
    }
    console.log("");
  }

  //  8 · AND THE THING THE OPERATOR MUST NOT ASSUME.
  if (pending.length > 1) {
    console.log("  ── a warning about --apply ───────────────────────────────────────");
    console.log("     A release applies EVERY pending file, not the one you have in");
    console.log(`     mind. Right now that would be ${pending.length} files:`);
    pending.forEach((f) => console.log(`         · ${f}`));
    console.log("     There is no per-file selection in migrate.js. If that set is not");
    console.log("     exactly what you intend to release, do not run it.");
    console.log("");
  }

  await client.query("rollback").catch(() => {});
  await client.end();
  process.exit(wouldStart ? 0 : 1);
})().catch((e) => {
  console.error("\n  ✗ census failed: " + (e && e.code ? e.code : "error"));
  console.error("    (detail withheld — errors on this path can echo the credential)\n");
  process.exit(2);
});
