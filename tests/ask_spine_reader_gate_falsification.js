/* ════════════════════════════════════════════════════════════════════
   ask_spine_reader_gate_falsification.js — THE COVERAGE GATE MUST GO
   RED. SIX WAYS. ON DEMAND.

       A green gate that never went red is not proof.

   gate_ask_spine_readers.js is the enforcement of §40.2 — a domain is
   not done until Ask Spine can read it — and it is the ONLY thing
   standing between "we meant to register that" and a domain shipping
   unreadable. A gate in that position is load-bearing, and a
   load-bearing gate nobody has ever seen fail is a claim, not evidence.

   ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────
   The coverage gate ran green for months while scanning ONE directory,
   `src/asset`, under a header claiming every governed domain. Tenancy —
   the oldest governed domain in the repo, the one behind the Rent Roll —
   was not unregistered, it was UNDISCOVERABLE. Seven domains and exit 0
   read exactly like coverage of the governed set. It was coverage of
   Asset Management.

   That is the failure this file makes impossible to repeat quietly:
   every mutation below removes one part of the tenancy registration
   chain and REQUIRES exit 1. If any of them still exits 0, the gate has
   a hole in the same shape as the one it just had.

   ── HOW IT WORKS, AND WHY IT IS SAFE ────────────────────────────────
   Real mutations to real files, then the REAL gate as a subprocess.
   Nothing is stubbed, because a stub would be testing this file's model
   of the gate rather than the gate.

   Every mutation is anchored on exact text and REFUSES to run if the
   anchor has moved — a mutation that silently no-ops would report a
   passing falsification while changing nothing, which is the same class
   of lie the gate itself exists to prevent. Every file is restored from
   an in-memory original in a finally block and verified byte-identical
   before the run is allowed to report anything.

   CLASS 3 — test / governance infrastructure. Removal condition: none,
   for as long as gate_ask_spine_readers.js is the §40.2 enforcement.

   Run:  node tests/ask_spine_reader_gate_falsification.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GATE = path.join(__dirname, "gate_ask_spine_readers.js");
const COMPOSER = path.join(ROOT, "src/agent/ask_spine_answer.js");
const STANDING_READ = path.join(ROOT, "src/tenancy/tenancy_position_read.js");

let pass = 0, fail = 0; const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

/*  The gate, run for real, exit code only. Output is captured rather
 *  than printed — a dozen nested gate runs would bury the result — but the
 *  failing assertion labels are pulled out so a surprise is legible.  */
function runGate() {
  const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const redLines = out.split("\n").filter((l) => l.includes("FAIL  ")).map((l) => l.trim());
  return { code: r.status, redLines, out };
}

/*  ── THE ORIGINALS, HELD IN MEMORY ─────────────────────────────────
 *  Read once, before anything is touched. Restoration compares against
 *  these bytes, not against git, so a dirty working tree is restored to
 *  the state this run found — not to HEAD.                            */
const FILES = [GATE, COMPOSER, STANDING_READ];
const ORIGINAL = new Map();
for (const f of FILES) {
  if (!fs.existsSync(f)) {
    console.error(`\n  ✗ cannot run: ${path.relative(ROOT, f)} is missing.\n`);
    process.exit(1);
  }
  ORIGINAL.set(f, fs.readFileSync(f, "utf8"));
}

/*  An anchored edit that refuses to no-op. If an anchor is not found
 *  EXACTLY once, this throws instead of proceeding — a falsification
 *  that mutated nothing and then observed a red gate would be crediting
 *  itself for someone else's failure.
 *
 *  Takes N edits and applies them together, because one logical mutation
 *  is not always one line. "Stop gathering tenancy" means BOTH facts.tenancy
 *  assignments go; doing one and calling it a removal is how the first
 *  version of this file reported a hole in the gate that was really a
 *  hole in the mutation.  */
function mutate(file, ...edits) {
  let src = ORIGINAL.get(file);
  for (const [find, replace] of edits) {
    const parts = src.split(find);
    if (parts.length !== 2) {
      throw new Error(
        `anchor found ${parts.length - 1} time(s) in ${path.relative(ROOT, file)}, expected exactly 1:\n` +
        `    ${find.slice(0, 90)}…`);
    }
    src = parts.join(replace);
  }
  fs.writeFileSync(file, src);
}

function restoreAll() {
  for (const f of FILES) fs.writeFileSync(f, ORIGINAL.get(f));
}

/*  One falsification: mutate, run, require red, restore, require green
 *  again. The restore-and-reprove half matters as much as the red —
 *  it proves the mutation and nothing else caused the failure.        */
function falsify(name, apply, expectSubstring) {
  let red = null;
  try {
    apply();
    red = runGate();
  } finally {
    restoreAll();
  }
  ok(`RED when ${name}`, red.code === 1,
     `the gate exited ${red.code} with the tenancy registration chain broken. ` +
     `It cannot detect this, and §40.2 is not enforced for it.`);
  if (expectSubstring) {
    ok(`  …and it fails for the RIGHT reason (${expectSubstring})`,
       red.redLines.some((l) => l.toLowerCase().includes(expectSubstring.toLowerCase())),
       `went red, but on: ${red.redLines.join(" | ") || "(no FAIL line captured)"}`);
  }
  const green = runGate();
  ok(`  …and GREEN again once restored`, green.code === 0,
     `restoration left the gate red: ${green.redLines.join(" | ")}`);
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log("  FALSIFYING gate_ask_spine_readers.js — TENANCY");
console.log("════════════════════════════════════════════════════════════════\n");

let exitCode = 0;
try {
  /*  ── 0. THE BASELINE ────────────────────────────────────────────
   *  Green first, and said out loud. Every assertion below is a claim
   *  about a DELTA from this state.                                   */
  const baseline = runGate();
  ok("baseline: the gate is green before anything is mutated", baseline.code === 0,
     `the gate is already red: ${baseline.redLines.join(" | ")}`);
  ok("baseline: the gate discovers tenancy",
     /canonical standing read:.*\btenancy\b/.test(baseline.out),
     "tenancy is not in the discovered set — the scan directories are wrong again");

  if (baseline.code !== 0) {
    console.log("\n  refusing to falsify a gate that is already failing.\n");
    process.exit(1);
  }

  /*  ── 1. REGISTRATION REMOVED ────────────────────────────────────
   *  The domain exists on disk and nobody declared it. This is the
   *  literal §40.11 scenario: "a domain that lands without registering
   *  goes red on its own."                                            */
  falsify("the tenancy registry entry is deleted",
    () => mutate(GATE, ["  tenancy: {\n    state: \"registered\",", "  tenancy_DELETED: {\n    state: \"registered\","]),
    "tenancy is declared in the Ask Spine registry");

  /*  ── 2. THE STANDING PROJECTION REMOVED ─────────────────────────
   *  The registry claims a domain whose canonical read is gone. A
   *  registry describing a repo that is not there any more is how
   *  coverage numbers outlive the code behind them.                   */
  falsify("the tenancy standing projection is removed from disk",
    () => {
      fs.renameSync(STANDING_READ, STANDING_READ + ".falsify_bak");
      //  restoreAll() rewrites the file from memory; the .bak is removed
      //  below so the rename cannot leave litter either way.
    },
    "registry entry tenancy corresponds to a real standing read");
  if (fs.existsSync(STANDING_READ + ".falsify_bak")) fs.unlinkSync(STANDING_READ + ".falsify_bak");

  /*  ── 3. THE GATHER REMOVED ──────────────────────────────────────
   *  Declared `registered`, not actually wired. A declaration is not an
   *  implementation, and a registry that can lie is worse than none.
   *
   *  BOTH HALVES OF THE AND, SEPARATELY. The gate calls a domain
   *  gathered when the composer BOTH requires its reader AND assigns its
   *  fact key; either alone is too weak (a dead import, or a literal).
   *  Falsifying only one half would leave the other untested, and the
   *  first attempt here did worse than that — it renamed ONE of the two
   *  `facts.tenancy =` assignments and the gate stayed green off the
   *  other. That is why the whole block goes, not a line of it.        */
  falsify("the composer's tenancy reader import is removed",
    () => mutate(COMPOSER,
      [`const tenancyStandingRead = require("../tenancy/tenancy_position_read.js");\n`, ""]),
    "tenancy declared registered AND gathered");

  falsify("the composer assigns no tenancy fact key at all",
    () => mutate(COMPOSER,
      [`      facts.tenancy = withoutDatabaseIds({ ...standing, read_state: "OK" });`,
       `      facts.NOTHING = withoutDatabaseIds({ ...standing, read_state: "OK" });`],
      [`      facts.tenancy = { read_state: state, standing: null, position: null, unknowns: null };`,
       `      facts.NOTHING = { read_state: state, standing: null, position: null, unknowns: null };`]),
    "tenancy declared registered AND gathered");

  /*  ── 4. THE SCAN DIRECTORY REMOVED ──────────────────────────────
   *  THE ACTUAL HISTORICAL DEFECT. This is the state the gate shipped
   *  in: tenancy invisible, gate green. It must never be quiet again.  */
  falsify("src/tenancy is dropped from the scanned directories",
    () => mutate(GATE, [`const STANDING_READ_DIRS = ["src/asset", "src/tenancy"];`,
                        `const STANDING_READ_DIRS = ["src/asset"];`]),
    "registry entry tenancy corresponds to a real standing read");

  /*  ── 5. THE EXCLUSION TURNED OFF ────────────────────────────────
   *  The other direction. If src/surfaces were scanned, four
   *  projections would be discovered as domains and demand registry
   *  entries they can never honestly earn. The exclusion is a real
   *  boundary, and this proves removing it is loud rather than free.   */
  falsify("src/surfaces is scanned as though it held domains",
    () => mutate(GATE, [`const STANDING_READ_DIRS = ["src/asset", "src/tenancy"];`,
                        `const STANDING_READ_DIRS = ["src/asset", "src/tenancy", "src/surfaces"];`]),
    "is declared in the Ask Spine registry");

  /*  ── 6. THE TREE IS EXACTLY AS IT WAS FOUND ─────────────────────
   *  Byte-identical, asserted rather than assumed. A harness that
   *  mutates production source owes the next reader this.              */
  for (const f of FILES) {
    ok(`restored byte-identical: ${path.relative(ROOT, f)}`,
       fs.existsSync(f) && fs.readFileSync(f, "utf8") === ORIGINAL.get(f),
       "this harness has left a mutation in the tree — inspect before committing");
  }
  ok("no falsification backup file left behind",
     !fs.existsSync(STANDING_READ + ".falsify_bak"));
} catch (e) {
  restoreAll();
  if (fs.existsSync(STANDING_READ + ".falsify_bak")) {
    try { fs.unlinkSync(STANDING_READ + ".falsify_bak"); } catch (_) { /* already gone */ }
  }
  console.log("\n  FAIL  the harness threw: " + e.message);
  fail++; failures.push("harness threw");
  exitCode = 1;
}

console.log(`\n  ${pass + fail} run · ${pass} passed · ${fail} failed`);
if (fail) {
  console.log("  FAILED: " + failures.join(" | "));
  console.log("\n  ✗ FAIL — the coverage gate cannot detect a broken registration chain.\n");
  process.exit(1);
}
console.log("\n  ✓ PASS — the gate goes red six ways and green again. It is measuring something.\n");
process.exit(exitCode);
