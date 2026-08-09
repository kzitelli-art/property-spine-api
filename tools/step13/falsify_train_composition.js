#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   FALSIFYING THE COMPOSITION CHECK ITSELF

   `rehearse_release_train.js` runs `oneTruth()` after every boundary and
   `Z1/Z2` at the end. Those are the checks that answer the question that
   matters more than any individual service being green:

       do we ever create TWO MEANINGS OF TRUTH?

   Fifty-three green assertions do not establish that those checks are
   capable of going red. A check that cannot fail is decoration, and this
   release has already been bitten once by exactly that — the Step 7
   concurrency proof measured a simulation and passed after a lock was
   added that it never looked at.

   So: manufacture the divergence on purpose, run the SHIPPED train
   unmodified, and require it to notice.

   ── THE FOUR VARIANTS ───────────────────────────────────────────────

     honest-control   no fault. The train must stay green (exit 0).
     guard-dropped    a real hollow completion, both witnesses honest.
                      They AGREE that it is wrong → oneTruth's agreement
                      assertion is SILENT and Z1 must catch it. This is
                      what proves the two checks are complementary rather
                      than redundant.
     reader-blind     the same hollow row; the READER is patched to call
                      it satisfied. The database says violation, the
                      surface says fine → oneTruth must go red.
     audit-blind      the same hollow row; the AUDIT VIEW is emptied. The
                      surface says violation, the database says fine →
                      oneTruth must go red from the other direction.

   The train binary is byte-identical in all four runs. The fault is
   injected into its dependencies by `_train_fault.js`, loaded with
   `--require` — see that file for why it is not a flag inside the train.

   ⚠ ISOLATED POSTGRES ONLY. Clone a fresh ledger-137 baseline per run;
     the activation is append-only and every variant activates.

   usage:
     for V in honest-control guard-dropped reader-blind audit-blind; do
       FALSIFYTRAIN_DATABASE_URL='...' \
         node tools/step13/falsify_train_composition.js --variant $V
     done
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const TRAIN = path.join(ROOT, "tools/step13/rehearse_release_train.js");
const SHIM = path.join(ROOT, "tools/step13/_train_fault.js");
const URL = process.env.FALSIFYTRAIN_DATABASE_URL;

const argIdx = process.argv.indexOf("--variant");
const VARIANT = argIdx > -1 ? process.argv[argIdx + 1] : null;

/*  Each variant states, BEFORE it runs, which assertion must go red and
 *  which must stay silent. A variant that fails for the wrong reason is
 *  not evidence about the thing it claims to test. */
const VARIANTS = {
  "honest-control": {
    what: "no fault injected",
    expect: "the train stays GREEN — exit 0, no FAIL lines",
    exitZero: true,
  },
  "guard-dropped": {
    what: "a hollow completion, both witnesses honest",
    expect: "Z1 red (violations exist); the AGREEMENT assertion silent — they agree",
    exitZero: false,
    mustFail: [/Z1\s+the completed train leaves ZERO invariant violations/],
    mustNotFail: [/name the same rows/],
  },
  "reader-blind": {
    what: "a hollow completion the READER calls satisfied",
    expect: "the agreement assertion red — the database and the surface disagree",
    exitZero: false,
    mustFail: [/name the same rows/],
  },
  "audit-blind": {
    what: "a hollow completion the AUDIT VIEW no longer reports",
    expect: "the agreement assertion red — from the other direction",
    exitZero: false,
    mustFail: [/name the same rows/],
  },
};

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

if (!URL) { console.error("REFUSED: FALSIFYTRAIN_DATABASE_URL is not set."); process.exit(1); }
if (!VARIANT || !VARIANTS[VARIANT]) {
  console.error("REFUSED: --variant is required. One of:");
  for (const [k, v] of Object.entries(VARIANTS)) console.error(`  ${k.padEnd(16)} ${v.what}`);
  process.exit(2);
}

const V = VARIANTS[VARIANT];
console.log(`TRAIN COMPOSITION FALSIFICATION — variant "${VARIANT}"\n`);
console.log("  injects:  " + V.what);
console.log("  predicts: " + V.expect + "\n");

const env = { ...process.env, TRAIN_DATABASE_URL: URL };
if (VARIANT === "honest-control") {
  delete env.TRAIN_FAULT;
} else {
  env.TRAIN_FAULT = VARIANT;
  env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --require ${SHIM}`.trim();
}

const r = spawnSync(process.execPath, [TRAIN], { env, encoding: "utf8", timeout: 600000 });
const out = (r.stdout || "") + (r.stderr || "");
const failLines = out.split("\n").filter((l) => /^\s*FAIL\s/.test(l));

/*  Exit 4 is the train's own refusal (Step 6 absent). A falsification run
 *  that never got past the front door proves nothing about the check. */
if (r.status === 4) {
  console.error("REFUSED: the train refused to run (Step 6 not in this tree).");
  console.error("         Run this on a branch that composes #57.");
  process.exit(3);
}

if (V.exitZero) {
  ok("C1  the unfaulted train exits 0", r.status === 0, `exit ${r.status}`);
  ok("C2  …with no red assertions", failLines.length === 0, failLines.slice(0, 3).join(" | "));
  console.log("        → the baseline this file compares against is a real green run,");
  console.log("          not an assumption that green was ever available.");
} else {
  ok("F1  the faulted train exits NON-ZERO", r.status !== 0, `exit ${r.status}`);
  ok("F2  …and says so with at least one red assertion",
     failLines.length > 0, "no FAIL line — the check did not fire");
  for (const re of V.mustFail || []) {
    ok(`F3  the RIGHT assertion caught it: ${re.source.slice(0, 46)}`,
       failLines.some((l) => re.test(l)),
       "red lines were: " + (failLines.join(" | ").slice(0, 300) || "(none)") +
       " — a variant that fails for the wrong reason is not evidence");
  }
  for (const re of V.mustNotFail || []) {
    ok(`F4  and NOT the wrong one: ${re.source.slice(0, 46)} stayed silent`,
       !failLines.some((l) => re.test(l)),
       "it fired, so this variant does not isolate what it claims to");
  }
}

console.log(`\n${"═".repeat(68)}\n  passed ${pass}   failed ${fail}\n${"═".repeat(68)}\n`);
process.exit(fail ? 1 : 0);
