#!/usr/bin/env node
/*  ═══════════════════════════════════════════════════════════════════
 *  gate_db_proof_manifest.js — EVERY DATABASE PROOF IS CLASSIFIED
 *
 *  CURRENT_STATE #17: 69 real-Postgres proofs backed most of the HTTP_PROVEN
 *  rungs in this repo and nothing ran them. tests/e2e/db_proofs.sh now runs
 *  the manifest in CI. This gate keeps the manifest honest:
 *
 *    · every tests/proofs/*.db.js is listed exactly once — a proof that
 *      lands without a line here goes red the day it lands
 *    · every listed file exists — a deleted proof cannot keep a `run` line
 *    · every `backlog` line carries a real reason (the condition that moves
 *      it to `run`), not a shrug
 *    · the runner reads the same manifest this gate reads
 *
 *  It does NOT claim the `run` set is complete or safe; the runner's own
 *  exit code says whether they pass. A gate must scan the scope it
 *  asserts, no more and no less.
 *  ═══════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST = path.join(ROOT, "tests", "proofs", "db_proofs.manifest");
const RUNNER = path.join(ROOT, "tests", "e2e", "db_proofs.sh");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
};

console.log("\n════════════════════════════════════════════════════════════════");
console.log("  DATABASE PROOF MANIFEST — every *.db.js proof is classified");
console.log("════════════════════════════════════════════════════════════════\n");

const onDisk = fs.readdirSync(path.join(ROOT, "tests", "proofs")).filter((f) => f.endsWith(".db.js")).sort();
const lines = fs.readFileSync(MANIFEST, "utf8").split("\n")
  .map((l, i) => ({ n: i + 1, raw: l }))
  .filter(({ raw }) => raw.trim() && !raw.trim().startsWith("#"));

const entries = lines.map(({ n, raw }) => {
  const [mode, file, ...rest] = raw.split("\t");
  return { n, mode, file, reason: rest.join("\t").trim(), raw };
});

ok("every manifest line is `run` or `backlog`",
   entries.every((e) => e.mode === "run" || e.mode === "backlog"),
   entries.filter((e) => e.mode !== "run" && e.mode !== "backlog").map((e) => `line ${e.n}: ${e.raw}`).join("; "));

const listed = entries.map((e) => e.file);
const dupes = listed.filter((f, i) => listed.indexOf(f) !== i);
ok("no proof is listed twice", dupes.length === 0, dupes.join(", "));

const unlisted = onDisk.filter((f) => !listed.includes(f));
ok(`every *.db.js on disk is classified (${onDisk.length} on disk, ${listed.length} listed)`,
   unlisted.length === 0,
   `unclassified: ${unlisted.join(", ")} — add a \`run\` line, or a \`backlog\` line with the condition that clears it`);

const ghosts = listed.filter((f) => !onDisk.includes(f));
ok("every listed proof exists on disk", ghosts.length === 0, `not on disk: ${ghosts.join(", ")}`);

const thinReasons = entries.filter((e) => e.mode === "backlog" && e.reason.length < 25);
ok("every backlog line names the condition that clears it (≥ 25 chars)",
   thinReasons.length === 0, thinReasons.map((e) => `line ${e.n}: ${e.file}`).join("; "));

const runner = fs.existsSync(RUNNER) ? fs.readFileSync(RUNNER, "utf8") : "";
ok("the runner exists and reads this manifest",
   /tests\/proofs\/db_proofs\.manifest/.test(runner) && /HARNESS_DATABASE_URL/.test(runner));
ok("the runner unsets DATABASE_URL before running proofs (same-target guard satisfied honestly)",
   /unset DATABASE_URL/.test(runner));
const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "verify.yml"), "utf8");
ok("CI invokes the runner", /tests\/e2e\/db_proofs\.sh/.test(ci));

/*  ── THE SECOND MANIFEST: every unguarded proof and scenario is classified too ── */
const MANIFEST2 = path.join(ROOT, "tests", "proofs", "unguarded_proofs.manifest");
const onDisk2 = [
  ...fs.readdirSync(path.join(ROOT, "tests", "proofs")).filter((f) => f.endsWith(".js") && !f.endsWith(".db.js")).map((f) => "proofs/" + f),
  ...fs.readdirSync(path.join(ROOT, "tests", "scenarios")).filter((f) => f.endsWith(".js")).map((f) => "scenarios/" + f),
].sort();
const entries2 = fs.readFileSync(MANIFEST2, "utf8").split("\n").map((l, i) => ({ n: i + 1, raw: l }))
  .filter(({ raw }) => raw.trim() && !raw.trim().startsWith("#"))
  .map(({ n, raw }) => { const [mode, file, ...rest] = raw.split("\t"); return { n, mode, file, reason: rest.join("\t").trim(), raw }; });
ok("unguarded manifest: every line is `run` or `backlog`", entries2.every((e) => e.mode === "run" || e.mode === "backlog"));
const listed2 = entries2.map((e) => e.file);
const unlisted2 = onDisk2.filter((f) => !listed2.includes(f));
ok(`unguarded manifest: every proof and scenario on disk is classified (${onDisk2.length} on disk, ${listed2.length} listed)`,
   unlisted2.length === 0, `unclassified: ${unlisted2.join(", ")}`);
const ghosts2 = listed2.filter((f) => !onDisk2.includes(f));
ok("unguarded manifest: every listed file exists", ghosts2.length === 0, `not on disk: ${ghosts2.join(", ")}`);
ok("unguarded manifest: every backlog line names the condition that clears it",
   entries2.filter((e) => e.mode === "backlog" && e.reason.length < 25).length === 0);
ok("the runner runs the unguarded section against a SECOND database", /unguarded_proofs\.manifest/.test(runner) && /_unguarded/.test(runner));

const runCount = entries.filter((e) => e.mode === "run").length + entries2.filter((e) => e.mode === "run").length;
const backlogCount = entries.filter((e) => e.mode === "backlog").length + entries2.filter((e) => e.mode === "backlog").length;
console.log(`\n  SCOPE — run: ${runCount}   backlog: ${backlogCount}   (a green job proves the \`run\` set, not the backlog)`);
console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
console.log(`  ${fail ? "✗ FAIL" : "✓ PASS"} — gate_db_proof_manifest.js`);
console.log(`  EXIT      ${fail ? 1 : 0}`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
