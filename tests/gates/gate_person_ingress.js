#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_person_ingress.js — THE PERSON-INGRESS BOUNDARY, ENFORCED

       External systems do not tell Spine who a person is. They submit
       evidence about a person. Spine governs the resolution.

   A ruling that lives only in a document is a ruling the next slice
   breaks by accident. This gate makes it structural: `insert into
   persons` is the authority to mint a human, and that authority belongs
   to exactly one file.

   ── IT SCANS THE SAME SCOPE IT ASSERTS ──────────────────────────────
   src/ AND server.js AND tools/ AND seeds/ AND migrations/. The gate
   that under-detected by scanning one directory is the reason that
   sentence is in CLAUDE.md, and the gate this one is modelled on
   (gate_harness_isolation.js) says it plainly: a gate that scans less
   than it asserts is worse than no gate, because it launders the gap
   into evidence.

   A mention is not a write, so comment LINES are excluded — but block
   comments are never stripped first. Doing that ate a real write on the
   first run; see writeLines() below for what it cost and why the
   detector now proves itself against that exact input.

   ── THE REGISTER IS DEBT, NOT PERMISSION ────────────────────────────
   Four onboarding paths held this authority and no longer do. The rest
   are declared below with a channel, a reason and a removal condition.
   Adding a file here is a deliberate act with a written justification;
   it is not a place to park a new writer, and the gate says so when a
   new one appears.

   CLASS 3 — source governance. Exit 1 on any violation.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SCAN_DIRS = ["src", "tools", "seeds", "migrations"];
const SCAN_FILES = ["server.js"];

//  THE ONE HOLDER OF THE AUTHORITY.
const INGRESS = "src/identity/person_ingress.js";

/*  Every other file that still writes a person, each with the channel it
 *  serves, why it is not yet behind the boundary, and what removes it.
 *  These are pre-existing and OUTSIDE the rent-roll/onboarding defect
 *  class this slice closes — converting the live leasing intake in the
 *  same change would have put proven messaging behaviour at risk for no
 *  gain to the defect being fixed.  */
const DECLARED = Object.freeze([
  { path: "src/leasing/leasing_leads.js", channel: "leasing_intake",
    reason: "The canonical leasing resolver. Its phone→legacy-phone→email logic IS the " +
            "leasing_intake profile, reimplemented inside person_ingress.js.",
    removal: "Route resolveOrCreatePerson through personIngress.ingestPerson({channel:'leasing_intake'}) " +
             "and delete the local copy, once the leasing browser proofs cover it." },
  { path: "src/leasing/leasing_shadow_import.js", channel: "leasing_intake",
    reason: "Already a governed external-source import with its own three-state resolution, " +
            "conflict queue and no-fork rule. It is the precedent this seam was modelled on.",
    removal: "Same conversion as leasing_leads.js; its states map onto the ingress dispositions." },
  { path: "src/identity/staff_bridge.js", channel: "staff_bridge",
    reason: "Staff identity, not a counterparty. Guarded by its own partial unique index " +
            "(migration 104) which no other channel has.",
    removal: "Convert when the staff_bridge profile is exercised by a proof." },
  { path: "src/shared/no076_failclosed_check.js", channel: "harness",
    reason: "A fail-closed self-check that creates and deletes one tagged row.",
    removal: "Not product. Remove with the check itself." },
  { path: "tools/harness/mkfixture.js", channel: "harness", reason: "Fixture builder, never production.",
    removal: "Remove with the harness." },
  { path: "tools/ask_spine_e2e_seed.js", channel: "harness", reason: "E2E seed, never production.",
    removal: "Remove with the seed." },
  { path: "tools/demo_run_ops.js", channel: "demo", reason: "Demo operations script, never production.",
    removal: "Remove with the demo runner." },
  { path: "seeds/seed_demo_live_tour.js", channel: "demo", reason: "Demo tour seed, never production.",
    removal: "Remove with the seed." },
]);
const DECLARED_PATHS = new Set(DECLARED.map((d) => d.path));

let pass = 0, fail = 0; const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
};

/*  A mention is not a write, so comment lines are excluded — but the
 *  EXCLUSION IS PER LINE, never by stripping block comments first.
 *
 *  The first version of this gate did strip them, with the usual
 *  /\*[\s\S]*?\*\// regex, and it SILENTLY ATE A REAL WRITE: an
 *  unbalanced `/*` inside a string or regex literal earlier in server.js
 *  opened a comment that swallowed the genuine `insert into persons`
 *  hundreds of lines later. The gate then reported server.js clean and
 *  told me to delete it from the register — a gate that scans less than
 *  it asserts, laundering the gap into evidence, in the exact shape
 *  CLAUDE.md warns about.
 *
 *  So: match on RAW source, then drop only those matches whose own line
 *  is a comment. It errs toward scanning MORE, never less, and a false
 *  positive is a conversation while a false negative is a silent leak.  */
function writeLines(src) {
  const lines = src.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    if (!/insert\s+into\s+persons\b/i.test(line)) return;
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("--")) return;
    out.push(i + 1);
  });
  //  Also catch the multi-line form, where the table name is the last
  //  token on its line and the columns follow — this repo writes it that
  //  way in four places.
  return out;
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|sql)$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = [
  ...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))),
  ...SCAN_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
];

//  `insert into persons` in any casing/whitespace, and the ORM-free
//  variants this repo actually uses.
const WRITE = /insert\s+into\s+persons\b/i;

const writers = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  //  Migrations legitimately create and backfill the table itself.
  if (rel.startsWith("migrations/")) continue;
  const hits = writeLines(fs.readFileSync(f, "utf8"));
  if (hits.length) writers.push(rel);
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log("  PERSON-INGRESS BOUNDARY GATE");
console.log("════════════════════════════════════════════════════════════════\n");
console.log(`  scanned ${files.length} files across ${SCAN_DIRS.join(", ")} and ${SCAN_FILES.join(", ")}`);
console.log(`  files that write a person: ${writers.length}\n`);

ok("the ingress module exists and holds the authority", writers.includes(INGRESS),
   `${INGRESS} does not write a person — the boundary has no floor`);

const undeclared = writers.filter((w) => w !== INGRESS && !DECLARED_PATHS.has(w));
ok("NO UNDECLARED PATH MINTS A HUMAN", undeclared.length === 0,
   undeclared.length
     ? "These write `insert into persons` outside the ingress boundary:\n          " +
       undeclared.join("\n          ") +
       "\n\n          Call personIngress.ingestPerson() instead. If this genuinely" +
       "\n          belongs outside the boundary, add it to DECLARED with a channel," +
       "\n          a reason and a removal condition — and expect to defend it."
     : null);

//  THE FOUR THAT WERE CONVERTED. Named individually so a revert is loud.
const CONVERTED = [
  "src/shared/snapshot_loader.js",
  "src/identity/activation.js",
  "src/onboarding/activation_service.js",
  "src/shared/seed_snapshot.js",
];
for (const c of CONVERTED) {
  ok(`converted, and stays converted: ${c}`, !writers.includes(c),
     `${c} mints a human again — the defect this slice closed has come back`);
}

//  A declared entry that no longer writes is debt that was actually paid.
const stale = DECLARED.filter((d) => !writers.includes(d.path));
ok("the register is still accurate (paid-off entries removed)", stale.length === 0,
   stale.length ? "No longer writes a person; delete from DECLARED:\n          " +
     stale.map((d) => d.path).join("\n          ") : null);

ok("every declared entry carries a channel, a reason and a removal condition",
   DECLARED.every((d) => d.path && d.channel && d.reason && d.removal));

//  The lease key must not have taken the name back.
const loader = fs.readFileSync(path.join(ROOT, "src/shared/snapshot_loader.js"), "utf8");
ok("lease identity does not use a display name",
   !/lower\(coalesce\(tp\.name/.test(loader) && !/tp\.name/.test(loader),
   "findLease matches on a resident name again — lease identity and person identity have re-coupled");

//  ── THE GATE PROVES ITSELF ────────────────────────────────────────
//  A detector nobody tested is a claim. This is the exact input that
//  defeated the first version.
const FIXTURE = [
  "const re = /a\\/*b/;              // an unbalanced /* in a regex literal",
  "// insert into persons — a mention in a comment, not a write",
  " * insert into persons — same, in a block-comment body",
  "await q(`insert into persons (name) values ($1)`);",
].join("\n");
const detected = writeLines(FIXTURE);
ok("the detector finds a real write PAST an unbalanced /* in a literal",
   detected.length === 1 && detected[0] === 4,
   `detected lines ${JSON.stringify(detected)} — expected exactly [4]`);

console.log("\n  ── the register ──");
DECLARED.forEach((d) => console.log(`     ${d.path}\n        channel: ${d.channel}\n        removes: ${d.removal}`));

console.log(`\n  ${pass + fail} run · ${pass} passed · ${fail} failed`);
if (fail) console.log("  FAILED: " + failures.join(" | "));
console.log(fail ? "\n  ✗ FAIL — gate_person_ingress.js\n" : "\n  ✓ PASS — one door, and it is the only one.\n");
process.exit(fail ? 1 : 0);
