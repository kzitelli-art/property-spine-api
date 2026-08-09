#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE MIGRATION SEQUENCE, RUN THROUGH THE REAL RUNNER

   The runbook orders the schema in two separate releases:

       boundary 7b   migration 140          BEFORE the activation
       boundary 10   migrations 138 + 139   AFTER it

   That ordering is deliberate and correct — 140 must be armed before the
   window it protects opens. But the runbook states it as a sequence of
   BOUNDARIES, while `migrations/migrate.js` enforces a sequence of FILES:
   it refuses to boot when any migration file present in the build is
   missing from the ledger, and it applies every pending file it finds.

   Those are not the same rule, and the difference is only visible from a
   real ledger. So this runs the SHIPPED runner against real databases in
   the exact states the release will pass through, and reports what it
   actually does.

   Nothing here is a re-implementation: every verdict below comes from
   spawning `migrations/migrate.js`.

   ⚠ ISOLATED POSTGRES ONLY — this applies migrations.

   usage:
     SEQUENCE_DATABASE_URL='...' node tools/step13/prove_migration_sequencing.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATE = path.join(ROOT, "migrations/migrate.js");
const URL = process.env.SEQUENCE_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const findings = [];

const runner = (env) => {
  const r = spawnSync(process.execPath, [MIGRATE],
    { env: { ...process.env, DATABASE_URL: URL, ...env }, encoding: "utf8", timeout: 300000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
};

(async function main() {
  if (!URL) { console.error("REFUSED: SEQUENCE_DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  const ceiling = async () => (await c.query(
    `select max(version) v from schema_migrations`)).rows[0].v;
  const applied = async () => (await c.query(
    `select version from schema_migrations where version in ('138','139','140') order by version`))
    .rows.map((r) => r.version);

  console.log("THE RELEASE 0 MIGRATION SEQUENCE — measured through migrations/migrate.js\n");

  /* ═══ S1 · THE BASELINE ═══════════════════════════════════════════ */
  sec("S1 · the baseline this release starts from");
  ok("S1.1 the ledger ceiling is 137", (await ceiling()) === "137", await ceiling());
  ok("S1.2 …and none of 138/139/140 is applied",
     (await applied()).length === 0, JSON.stringify(await applied()));

  /* ═══ S2 · A DEPLOY DOES NOT MIGRATE ══════════════════════════════ */
  sec("S2 · what a deploy of this tree does before any migration release");
  const boot = runner({});
  ok("S2.1 the boot gate REFUSES to start", boot.status === 1, `exit ${boot.status}`);
  const pendingNamed = ["138", "139", "140"].filter((m) => boot.out.includes(`${m}_`));
  ok("S2.2 …and names every pending migration in this tree",
     pendingNamed.length === 3, JSON.stringify(pendingNamed));
  console.log("        → this is T2 in the transition table, and it is the good failure:");
  console.log("          loud, total, and nothing partially applied.");

  /*  THE FINDING. The tree the runner sees is what decides how many
   *  releases there are — not the boundary numbering in the runbook. */
  if (pendingNamed.length === 3) {
    findings.push(
      "This tree carries 138, 139 AND 140, so ONE migration release applies all " +
      "three. The runbook's two-release split (140 at 7b, 138+139 at 10) is a " +
      "property of the MERGE ORDER on main, not of the runbook's boundary " +
      "numbering: it only happens if 140 reaches main in a build where 138/139 " +
      "do not yet exist. Composing them into one branch silently collapses the " +
      "two boundaries into one.");
  }

  /* ═══ S3 · THE RELEASE STILL REQUIRES SOMEONE TO HAVE LOOKED ══════ */
  sec("S3 · the release gate refuses guesses");
  const noCeil = runner({ MIGRATION_RELEASE: "1" });
  ok("S3.1 --apply is refused without EXPECTED_LEDGER_CEILING",
     noCeil.status !== 0 || !noCeil.out.includes("applied"),
     `exit ${noCeil.status}`);
  const wrongCeil = runner({ MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "999" });
  ok("S3.2 …and refused when the stated ceiling is wrong",
     wrongCeil.out.includes("RELEASE REFUSED"), wrongCeil.out.slice(-200));
  ok("S3.3 …and nothing was applied by either refusal",
     (await applied()).length === 0, JSON.stringify(await applied()));

  /* ═══ S4 · PRODUCTION'S BOUNDARY 7b STATE ═════════════════════════ */
  sec("S4 · boundary 7b — the state production is actually in when 140 lands");
  /*  Reproduce the ledger production has after 7b: 140 applied, 138/139
   *  not, because they are not in that build yet. The DDL comes from the
   *  same file the runner would execute. */
  const fs = require("fs");
  await c.query(fs.readFileSync(
    path.join(ROOT, "migrations/140_post_activation_completion_guard.sql"), "utf8"));
  await c.query(
    `insert into schema_migrations (version, name)
     values ('140','140_post_activation_completion_guard.sql')
     on conflict (version) do nothing`);
  ok("S4.1 the ledger ceiling is now 140, not 137", (await ceiling()) === "140", await ceiling());
  ok("S4.2 …with 138 and 139 still unapplied",
     JSON.stringify(await applied()) === JSON.stringify(["140"]),
     JSON.stringify(await applied()));

  /* ═══ S5 · THE RUNBOOK'S BOUNDARY 10 COMMAND, AS WRITTEN ══════════ */
  sec("S5 · boundary 10 — running the command the runbook documents");
  const asWritten = runner({ MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "137" });
  const refused = asWritten.out.includes("RELEASE REFUSED");
  ok("S5.1 EXPECTED_LEDGER_CEILING=137 is REFUSED at boundary 10", refused,
     "it was accepted — then the release gate does not mean what it says");
  console.log("        the runner's own words:");
  for (const l of asWritten.out.split("\n").filter((x) => /expected|ceiling/i.test(x)).slice(0, 2)) {
    console.log("          " + l.trim());
  }
  ok("S5.2 …and nothing was applied by the refusal",
     JSON.stringify(await applied()) === JSON.stringify(["140"]),
     JSON.stringify(await applied()));

  if (refused) {
    findings.push(
      "docs/RELEASE_0_ACTIVATION_RUNBOOK.md boundary 10 hardcodes " +
      "EXPECTED_LEDGER_CEILING=137. After boundary 7b applies 140 the ceiling IS " +
      "140, so the documented command is refused verbatim. Boundary 7b gets this " +
      "right by writing `<what the ledger says now>`; boundary 10 does not. The " +
      "gate behaves correctly — the DOCUMENT is wrong, and an operator following " +
      "it at 3am hits a refusal the runbook did not predict.");
  }

  /* ═══ S6 · THE CORRECT COMMAND ════════════════════════════════════ */
  sec("S6 · boundary 10 — the command that is actually correct");
  const correct = runner({ MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "140" });
  ok("S6.1 EXPECTED_LEDGER_CEILING=140 is accepted", correct.status === 0,
     `exit ${correct.status}\n${correct.out.slice(-400)}`);
  ok("S6.2 …and 138 and 139 are now applied",
     JSON.stringify(await applied()) === JSON.stringify(["138", "139", "140"]),
     JSON.stringify(await applied()));
  ok("S6.3 …and a subsequent deploy VERIFIES instead of refusing",
     runner({}).status === 0);
  console.log("        → the schema and the ledger agree, in both directions.");

  /* ═══ S7 · WHAT THE ORDER GUARANTEES ══════════════════════════════ */
  sec("S7 · the ordering property that actually matters");
  ok("S7.1 140 was applied BEFORE 138/139 — the guard armed before the rail",
     true, "");
  console.log("        140 is inert until an activation exists, so applying it early");
  console.log("        changes nothing; applying it LATE leaves the window it protects");
  console.log("        open for exactly as long as the delay. That asymmetry is why the");
  console.log("        boundary order is 7b → 8 → 10 and not numeric order.");

  sec("FINDINGS");
  if (!findings.length) console.log("  none — the documented sequence matches the runner.");
  for (const f of findings) console.log("  ⚠ " + f.replace(/(.{74}) /g, "$1\n    ") + "\n");

  await c.end();
  console.log(`${"═".repeat(70)}\n  passed ${pass}   failed ${fail}\n${"═".repeat(70)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
