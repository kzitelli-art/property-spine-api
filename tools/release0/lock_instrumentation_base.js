#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE BASE LOCK — RUN THIS IMMEDIATELY BEFORE MERGING

   The instrumentation candidate is valid because of one equation:

       b4e3104 product tree  +  docs and tools only

   Both halves can rot between preparing it and shipping it. If main
   advanced while this sat in review, merging anyway would deploy a
   product tree nobody classified while a stamp inside the container
   still claims the base is b4e3104 — the tools would then confidently
   understate what is running, which is the precise error the stamp
   exists to prevent.

       node tools/release0/lock_instrumentation_base.js

   ── WHAT IT CHECKS ──────────────────────────────────────────────────

   L1  the stamp's product_base_sha still resolves to a real commit
   L2  origin/main is STILL that commit — fetched fresh, not from a
       stale remote ref
   L3  the branch's merge-base with main IS that commit, so this really
       is main plus the instrumentation and nothing rebased underneath
   L4  the fence: zero src/, migrations/, package*, server.js, tests/, CI
   L5  every changed path is under tools/ or docs/
   L6  the stamp does not claim the product source is deployed

   exit 0  locked — deploy the exact candidate
   exit 1  something moved. DO NOT MERGE. Re-establish the base and the
           fence against whatever main is now.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const STAMP = path.join(ROOT, "docs/release0/INSTRUMENTATION_BASE.json");
const FENCED = ["src/", "migrations/", "package.json", "package-lock.json",
                "server.js", "tests/", ".github/"];

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

const bar = "═".repeat(66);
console.log("\n" + bar);
console.log("  INSTRUMENTATION BASE LOCK");
console.log(bar + "\n");

let stamp = null;
try { stamp = JSON.parse(fs.readFileSync(STAMP, "utf8")); } catch (e) {
  console.error("  REFUSED: cannot read the stamp — " + e.message);
  console.error("  Run this on the instrumentation branch.\n");
  process.exit(1);
}
const claimed = String(stamp.product_base_sha || "");

// ── L1 ────────────────────────────────────────────────────────────
let claimedFull = null;
try { claimedFull = git("rev-parse", claimed + "^{commit}"); } catch (_) {}
ok(`L1  the stamped base ${claimed} resolves to a commit`, !!claimedFull,
   "the stamp names a commit this repository does not have");

// ── L2 · fetched fresh. A stale remote ref is the whole hazard. ────
let mainSha = null;
try {
  git("fetch", "origin", "main", "--quiet");
  mainSha = git("rev-parse", "origin/main");
} catch (e) { /* reported by L2 */ }
/*  GENERALISED ON SECOND USE. The first version asserted
 *  origin/main === product_base_sha, which is true only for the FIRST
 *  tooling deploy. After it merges, main is base + tools and every later
 *  tooling candidate would red on a lock that is working correctly —
 *  a gate that fails the fix.
 *
 *  The invariant that actually holds for ANY tooling deploy: main may
 *  have moved, but only in tools/ and docs/. The moment product source
 *  lands, the stamp is stale and must be re-cut before anything else is
 *  layered on top of it. */
let productDrift = [];
try {
  productDrift = git("diff", "--name-only", claimed, "origin/main")
    .split("\n").filter(Boolean)
    .filter((f) => !f.startsWith("tools/") && !f.startsWith("docs/"));
} catch (_) { productDrift = ["<could not diff>"]; }

ok("L2  origin/main still differs from the stamped base ONLY in tools/ and docs/",
   !!mainSha && !!claimedFull && productDrift.length === 0,
   "PRODUCT SOURCE HAS LANDED since the stamp was written:\n        " +
   productDrift.join(", ") +
   "\n        The stamp still says product_base_sha=" + claimed + " and " +
   "release_0_product_source_deployed=false. Both are now wrong. Re-stamp " +
   "against the real base before layering anything else on top.");
if (mainSha === claimedFull) {
  console.log("        (main is exactly the base — first tooling deploy)");
} else {
  console.log(`        (main is ${mainSha.slice(0,12)}: base + tooling only)`);
}

// ── L3 · and nothing was rebased underneath it ────────────────────
let mb = null;
try { mb = git("merge-base", "HEAD", "origin/main"); } catch (_) {}
ok("L3  this branch descends from CURRENT main, nothing rebased underneath",
   !!mb && mb === mainSha,
   `merge-base ${mb ? mb.slice(0, 12) : "?"} ≠ origin/main ${mainSha ? mainSha.slice(0, 12) : "?"} — ` +
   "the branch is not simply main plus instrumentation");

// ── L4/L5 · the fence, in both directions ─────────────────────────
let changed = [];
try { changed = git("diff", "--name-only", "origin/main", "HEAD").split("\n").filter(Boolean); } catch (_) {}
const breaches = changed.filter((f) => FENCED.some((p) => f.startsWith(p)));
ok("L4  zero src, migrations, package, server.js, tests or CI", breaches.length === 0,
   "FENCE BREACH: " + breaches.join(", "));

const stray = changed.filter((f) => !f.startsWith("tools/") && !f.startsWith("docs/"));
ok("L5  every changed path is under tools/ or docs/", changed.length > 0 && stray.length === 0,
   changed.length === 0 ? "nothing changed at all — this is not an instrumentation candidate"
                        : "outside the fence: " + stray.join(", "));

// ── L6 · the stamp must not overclaim ─────────────────────────────
ok("L6  the stamp does not claim Release 0 product source is deployed",
   stamp.release_0_product_source_deployed === false,
   "this deploy carries no src/ — a stamp saying otherwise would make the tools " +
   "overstate what is running");

console.log(`\n  files changed  ${changed.length}   (tools/ + docs/ only)`);
console.log(`  product base   ${claimed}`);
console.log(`  container      the merge commit this produces\n`);

console.log(bar);
if (fail === 0) {
  console.log("  ✓ LOCKED. Deploy the exact candidate.");
  console.log("    Then run: node tools/release0/preflight_production.js");
} else {
  console.log(`  ⛔ ${fail} CHECK(S) FAILED. DO NOT MERGE.`);
}
console.log(bar + "\n");
process.exit(fail === 0 ? 0 : 1);
