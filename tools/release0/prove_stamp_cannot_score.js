#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   PROOF — THE STAMP CANNOT DECIDE ANYTHING

   docs/release0/INSTRUMENTATION_BASE.json records what we EXPECT
   production to look like at b4e3104. The hazard in shipping an expected
   list alongside the tool that observes reality is obvious and it is the
   reason this file exists:

       a preflight that knows what it intended can score what it
       intended, and then production can never tell us anything.

   Owner requirement, before deployment: prove mechanically that changing
   any expected value in the stamp cannot change what the preflight
   OBSERVES, or its pass/fail result.

   ── HOW IT IS PROVEN ────────────────────────────────────────────────

   Against ONE fixed database, the real tool is run as a child process
   many times, mutating the stamp between runs. Every run's output is
   reduced to (a) its observation lines and (b) its exit code, with the
   two identity DISPLAY lines removed. All of them must be byte-identical
   to the run with no stamp at all.

   The mutations are chosen to be the ones that would matter most if the
   stamp were consulted:

     · every expected finding inverted — 138/139/140 "applied", the
       activation "present", the guard "ARMED", Step 6 "closed"
     · the entire expectations block deleted
     · release_0_product_source_deployed flipped to true — a stamp that
       CLAIMS the product source is live must not make one check green
     · product_base_sha rewritten to a different commit
     · the stamp made unparseable

   ── AND THE CONVERSE, WHICH IS THE REAL TEST ────────────────────────

   D1/D2 put migration 140 and an activation into the DATABASE while the
   stamp still says "not applied" and "absent". The preflight must report
   what the database holds, loudly, against a stamp that says otherwise.
   If the stamp could soften that, this is where it would show.

       tools/build1/run_isolated.sh STAMP_DATABASE_URL \
         node tools/release0/prove_stamp_cannot_score.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

const URL = process.env.STAMP_DATABASE_URL;
const ROOT = path.join(__dirname, "..", "..");
const TOOL = path.join(__dirname, "preflight_production.js");
const STAMP = path.join(ROOT, "docs/release0/INSTRUMENTATION_BASE.json");

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

/*  The two lines the stamp is ALLOWED to affect. They are display: they
 *  are emitted with say(), which cannot move the red count. Everything
 *  else in the sheet must be invariant under any mutation. */
const IDENTITY_LINES = /^\s*(?:ok|⛔|⚠|)\s*(?:running SHA|product base SHA|Release 0 product source)\b/;

function run() {
  let out, code = 0;
  try {
    out = execFileSync(process.execPath, [TOOL], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: URL,
             RENDER_GIT_COMMIT: "cafebabecafebabecafe" },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) { out = String(e.stdout || "") + String(e.stderr || ""); code = e.status; }
  //  The observation surface: every line except the identity display,
  //  with the contradiction tally kept — that IS the pass/fail result.
  const observations = out.split("\n")
    .filter((l) => !IDENTITY_LINES.test(l))
    .join("\n");
  return { observations, code, raw: out };
}

const write = (obj) => fs.writeFileSync(STAMP, JSON.stringify(obj, null, 2));

(async function main() {
  if (!URL) { console.error("REFUSED: STAMP_DATABASE_URL is not set."); process.exit(2); }
  if (!fs.existsSync(STAMP)) {
    console.error("REFUSED: no stamp at " + STAMP + " — run this on the instrumentation branch.");
    process.exit(2);
  }

  console.log("════════════════════════════════════════════════════════════════");
  console.log("  PROOF  the instrumentation stamp cannot decide anything");
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  ASSERTIONS STARTED\n");

  const original = fs.readFileSync(STAMP, "utf8");
  const base = JSON.parse(original);

  try {
    // ── the reference: no stamp at all ────────────────────────────
    fs.unlinkSync(STAMP);
    const NOSTAMP = run();
    ok("R1  the reference run produced a sheet at all",
       NOSTAMP.observations.includes("ledger ceiling") && NOSTAMP.observations.length > 400,
       "nothing to compare against — every assertion below would pass vacuously");
    console.log(`        reference exit ${NOSTAMP.code}, ` +
                `${NOSTAMP.observations.split("\n").length} observation lines\n`);

    const same = (label, mutated) => {
      const r = run();
      return ok(label,
        r.observations === NOSTAMP.observations && r.code === NOSTAMP.code,
        r.code !== NOSTAMP.code
          ? `EXIT CHANGED: ${NOSTAMP.code} → ${r.code} — the stamp moved the pass/fail result`
          : "OBSERVATIONS CHANGED — first differing line:\n        " +
            (r.observations.split("\n").find((l, i) => l !== NOSTAMP.observations.split("\n")[i]) || "?"));
    };

    // ── M1 · every expectation inverted ───────────────────────────
    write(Object.assign({}, base, {
      expected_first_preflight_findings: {
        "frozen artifacts": "0 DRIFTED — all match",
        "migrations 138/139/140": "APPLIED",
        "activation": "PRESENT",
        "activation epoch": "PRESENT",
        "guard triggers": "8/8 present",
        "guard predicates": "0 faults — all installed",
        "invariant audit": "empty",
        "terminal population": "0",
        "Step 6 · legacy done-path": "CLOSED",
      },
    }));
    same("M1  every expected finding INVERTED changes nothing observed or scored");

    // ── M2 · the expectations block deleted entirely ──────────────
    const noExpect = Object.assign({}, base); delete noExpect.expected_first_preflight_findings;
    write(noExpect);
    same("M2  deleting the expectations block changes nothing");

    // ── M3 · the stamp CLAIMS the product source is deployed ──────
    //  The sharpest one. A stamp asserting the guard's source is live
    //  must not make a single check about the guard go green.
    write(Object.assign({}, base, { release_0_product_source_deployed: true }));
    same("M3  a stamp CLAIMING Release 0 product source is deployed changes no check");

    // ── M4 · a different product base ─────────────────────────────
    write(Object.assign({}, base, { product_base_sha: "0000000deadbeef" }));
    same("M4  rewriting product_base_sha changes nothing observed");

    // ── M5 · unparseable ──────────────────────────────────────────
    fs.writeFileSync(STAMP, "{ this is not json");
    same("M5  an unparseable stamp changes nothing (and does not crash the tool)");

    // ── M6 · the stamp is only ever read, never written ───────────
    fs.writeFileSync(STAMP, original);
    const before = fs.readFileSync(STAMP, "utf8");
    run();
    ok("M6  the preflight does not write the stamp", fs.readFileSync(STAMP, "utf8") === before);

    // ── THE CONVERSE · production contradicts the stamp ───────────
    //  The stamp still says 140 not applied and activation absent. Put
    //  both into the database and require the sheet to say so.
    const db = new Client({ connectionString: URL });
    await db.connect();
    //  `name` is NOT NULL — the ledger records which FILE was applied, not
    //  just a number, which is the whole point of its two-directional
    //  check. Naming them here is what makes the row a real ledger claim.
    await db.query(
      `insert into schema_migrations (version, name) values
         (138,'138_proof_evaluation_defect_obligation.sql'),
         (139,'139_no_longer_applicable_resolution.sql'),
         (140,'140_post_activation_completion_guard.sql')
       on conflict do nothing`);
    await db.end();

    const contra = run();
    const stampSays = JSON.parse(fs.readFileSync(STAMP, "utf8"))
      .expected_first_preflight_findings["migrations 138/139/140"];
    ok("D1  with 138/139/140 in the ledger, the sheet reports them APPLIED",
       /migration 140\s+APPLIED/.test(contra.raw),
       `the stamp says "${stampSays}" and the database says otherwise. The sheet must ` +
       "follow the database.\n        " +
       (contra.raw.split("\n").filter((l) => /migration 1[34]/.test(l)).join("\n        ") || "(no migration lines)"));

    ok("D2  …and that observation DIFFERS from the reference, so the check is live",
       contra.observations !== NOSTAMP.observations,
       "identical to the reference run — the preflight is not reading the ledger at all, " +
       "and every assertion above would be vacuous");

    //  And the receipt's independent contradiction check is the thing
    //  that catches "ledger says applied, schema says absent" — proving
    //  the release detects the mismatch WITHOUT consulting the stamp.
    ok("D3  the guard is still reported ABSENT — ledger and schema judged separately",
       /guard triggers\s+0\/8 present/.test(contra.raw),
       "the ledger now claims 140 is applied while its DDL was never run. The sheet must " +
       "not infer the guard from the ledger; that inference is exactly how a hand-applied " +
       "or half-applied migration reads as protection.");

  } finally {
    fs.writeFileSync(STAMP, original);
  }

  ok("Z1  the stamp is restored byte-for-byte after the run",
     fs.readFileSync(STAMP, "utf8") === original);

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("  The stamp is DISPLAY ONLY. Production speaks for itself.");
  }
  console.log("════════════════════════════════════════════════════════════════\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
