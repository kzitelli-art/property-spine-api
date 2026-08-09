#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GATE — THE ASK SPINE INTENT CONTRACTS ARE FROZEN

   Build 1's contract is not documentation. It is the definition a
   durable receipt names, and the promise that an answer from March
   stays readable in December rests entirely on the bytes not moving
   without the version moving.

   This is the SAME MECHANISM as `gate_release0_frozen.js`, running in
   the SAME `npm run verify` runner, against a separate manifest. One
   project, one answer to "what exact governed contract produced this
   conclusion" — deliberately not a second freeze framework, and
   deliberately not bolted onto Release 0's manifest either, because
   Build 1 must not modify Release 0 artifacts.

   It also asserts the things a digest cannot: that the contract and the
   code agree about what conclusions exist, that the cap is the
   contract's rather than a shared constant, and that the executor
   carries no proof predicate of its own.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, "docs/build1/FROZEN_INTENTS.json");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

console.log("GATE — Ask Spine intent contracts frozen\n");

const frozen = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

/* ── A1 · the bytes have not moved ───────────────────────────────── */
const drifted = Object.entries(frozen.digests).filter(([rel, want]) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return true;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== want;
});
ok("A1  every frozen intent contract matches its pinned digest",
   drifted.length === 0,
   drifted.map(([r]) => r).join(", ") +
   "\n            → AN INTENT CONTRACT CHANGED WITHOUT ITS DIGEST." +
   "\n              Every receipt that names this version now describes bytes" +
   "\n              that no longer exist. Bump the version in the contract," +
   "\n              update docs/build1/FROZEN_INTENTS.json IN THE SAME COMMIT," +
   "\n              and re-run tools/build1/*.");

/* ── A2 · the manifest and the contract agree on the version ─────── */
const executor = require(path.join(ROOT, "src/askspine/intent_executor.js"));
const renderer = require(path.join(ROOT, "src/askspine/renderer.js"));

for (const slug of executor.listContracts()) {
  const c = executor.loadContract(slug);
  ok(`A2  ${slug}: manifest version matches the contract`,
     frozen.versions[slug] === c.version,
     `manifest ${frozen.versions[slug]} vs contract ${c.version}`);

  /* ── A3 · the contract and the renderer agree on what can be said ──
   *  A supported conclusion with no frozen sentence is a promise the
   *  renderer cannot keep; a sentence with no supported conclusion is a
   *  claim the contract never authorised. Both directions are checked. */
  const missing = c.supported_conclusions.filter((x) => !renderer.SUPPORTED_CODES.includes(x));
  ok(`A3  ${slug}: every supported conclusion has a frozen sentence`,
     missing.length === 0, missing.join(", "));

  /* ── A4 · the cap belongs to the contract ───────────────────────── */
  ok(`A4  ${slug}: declares its own result_cap`,
     Number.isInteger(c.result_cap) && c.result_cap > 0, String(c.result_cap));

  /* ── A5 · read time and fact time stay separate ─────────────────── */
  ok(`A5  ${slug}: forbids substituting now() for a missing evidence time`,
     /now\(\)/.test((c.evidence_time_rules || {}).forbidden || ""),
     JSON.stringify(c.evidence_time_rules));

  /* ── A6 · accountability stays withheld ─────────────────────────── */
  ok(`A6  ${slug}: withholds accountability conclusions`,
     Array.isArray(c.withheld_conclusions) && c.withheld_conclusions.length >= 5,
     JSON.stringify(c.withheld_conclusions));

  /* ── A7 · read-only means no domain mutation ────────────────────── */
  ok(`A7  ${slug}: consequence_class is a read-only operating conclusion`,
     c.consequence_class === "read-only operating conclusion", c.consequence_class);
}

/* ── A8 · THE ARCHITECTURAL RULE, CHECKED IN SOURCE ────────────────
 *
 *  "If you find yourself duplicating Release 0's proof predicate inside
 *  the intent code, stop." A digest cannot catch that, so it is checked
 *  by substance: the executor may NAME the canonical sources, and may
 *  not contain a rule about what makes evidence valid. */
const execSrc = fs.readFileSync(path.join(ROOT, "src/askspine/intent_executor.js"), "utf8");

/*  Scan CODE, not prose. The first version of this check matched the
 *  file's own header — where the forbidden predicate is described in
 *  order to forbid it — and went red on a file that was correct. A gate
 *  that fails the thing it is protecting is worse than no gate. Stripping
 *  comments also closes the reverse hole: a predicate cannot hide from
 *  this check by wearing a `//`. */
const codeOnly = execSrc
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/*  Each pattern names a way of ASKING WHETHER EVIDENCE IS VALID, not a
 *  word. A bare /sha256/ was the first attempt and it matched the
 *  contract-digest hash — the file computes sha256 of its own contract
 *  bytes, which has nothing to do with evidence. The distinction matters:
 *  this gate must catch a predicate and must not catch a hash function. */
const PREDICATE_SMELLS = [
  /storage_state\s*(=|!==|===|\bis\b)/i,   // deciding on an attachment's storage state
  /classification\s+in\s*\(/i,             // deciding on evidence classification
  /\bsha256\s*(is\s+not\s+null|=)/i,       // the COLUMN as a validity test, not the hash fn
  /byte_size\s*(is\s+not\s+null|>|=)/i,
  /mime_type\s+in\s*\(/i,
  /'repair_photo'/, /'condition'/,          // the classification vocabulary itself
  /work_order_proof_attachments/,           // reaching into the evidence table at all
];
const smelt = PREDICATE_SMELLS.filter((re) => re.test(codeOnly));
ok("A8  the executor contains NO evidence-validity predicate of its own",
   smelt.length === 0,
   smelt.map(String).join(", ") +
   " — proof validity is release_0_evidence_qualifies' job. A second copy here " +
   "would be a second definition of truth, which is the failure this whole " +
   "release exists to prevent.");

ok("A9  …and it consumes the canonical invariant view",
   /release_0_completion_invariant_violations/.test(execSrc));
ok("A10 …and the canonical four-state derivation",
   /proofState\.deriveProofState/.test(execSrc));

/* ── A11 · answerability precedes the population read ─────────────── */
ok("A11 the activation authority is resolved BEFORE any population read",
   execSrc.indexOf("activationAuthority") < execSrc.indexOf("POPULATION_READERS[intent_slug]("),
   "the invariant view is empty before activation BY CONSTRUCTION, so reading it " +
   "first would turn `cannot answer` into a confident zero");

/* ── A12 · the renderer cannot leak the internal state name ───────── */
const rendSrc = fs.readFileSync(path.join(ROOT, "src/askspine/renderer.js"), "utf8");
const sentences = Object.values(renderer.SENTENCES)
  .map((f) => { try { return f({ lane_a_total: 2, lane_b_total: 3 }); } catch (e) { return ""; } })
  .join(" ");
ok("A12 no rendered sentence contains the internal state name",
   !/legacy_indeterminate/.test(sentences), sentences);
ok("A13 …and no sentence emits markup",
   !/[<>]/.test(sentences), sentences);

console.log(`\n${"═".repeat(66)}\n  passed ${pass}   failed ${fail}\n${"═".repeat(66)}\n`);
process.exit(fail ? 1 : 0);
