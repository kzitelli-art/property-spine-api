#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_evidence_immutability.js — WHO STILL WRITES TO EVIDENCE?

   Migration 140 revision 4 freezes a proof attachment the moment any
   evaluation cites it:

       PROOF USED TO JUSTIFY A COMPLETION BECOMES HISTORICAL EVIDENCE.

   That is only safe because **every shipped mutation of that table runs
   BEFORE citation** — the ingress pipeline, moving a row from
   `referenced` to `stored` or `fetch_failed` as the bytes arrive. A new
   writer that touches an attachment AFTER a completion cites it would
   start failing with `R0005` in production, and the failure would look
   like a database problem rather than a doctrine it violated.

   So the inventory is re-derived every run instead of trusted. Adding a
   writer is allowed; adding one silently is not.

   ── AND THE DOCTRINE ITSELF ─────────────────────────────────────────

   The migration's comment claims this gate exists and that the inventory
   is what makes the freeze safe. A comment asserting a gate that does not
   check what it says is worse than no comment, so this also verifies the
   trigger is actually declared the way the doctrine requires: BEFORE, on
   both UPDATE and DELETE, with no WHEN clause narrowing it to a column
   list that would go stale the day a column is added.

   DB-free. Source only.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const MIGRATION = path.join(ROOT, "migrations/140_post_activation_completion_guard.sql");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  EVIDENCE THAT JUSTIFIED A COMPLETION IS HISTORICAL");
console.log("══════════════════════════════════════════════════════════════════\n");

/*  ── THE FROZEN WRITER INVENTORY ────────────────────────────────────
 *  Every shipped site that mutates `work_order_proof_attachments`, and
 *  WHY it is safe under the freeze. Every one must run before any
 *  evaluation can cite the row.  */
const ALLOWED = [
  { file: "technician/evidence_service.js",
    why: "the INGRESS pipeline: referenced → stored / fetch_failed as the bytes " +
         "arrive. Runs when the message is received — strictly before any " +
         "evaluation exists, let alone cites it." },
];

const files = (function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
})(SRC);

const writers = new Map();
for (const f of files) {
  const rel = path.relative(SRC, f);
  //  Comments stripped: several files DISCUSS this table on purpose.
  const code = fs.readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const hits = [
    ...code.matchAll(/update\s+(?:public\.)?work_order_proof_attachments\b/gi),
    ...code.matchAll(/delete\s+from\s+(?:public\.)?work_order_proof_attachments\b/gi),
    ...code.matchAll(/update\s+(?:public\.)?work_order_proof_evaluation_attachments\b/gi),
    ...code.matchAll(/delete\s+from\s+(?:public\.)?work_order_proof_evaluation_attachments\b/gi),
  ];
  if (hits.length) writers.set(rel, hits.length);
}

ok("I0  the scan read real source", files.length > 20, files.length + " files under src/");
ok("I0a …and found the ingress writer it knows about, so the scan is not blind",
   writers.has("technician/evidence_service.js"),
   JSON.stringify([...writers.keys()]) +
   " — the one site that certainly mutates this table is not in the results, so the " +
   "pattern no longer matches and every assertion below is vacuous");

const allowedFiles = new Set(ALLOWED.map((a) => a.file));
const unknown = [...writers.keys()].filter((f) => !allowedFiles.has(f));
ok("I1  no shipped writer mutates proof evidence outside the frozen inventory",
   unknown.length === 0,
   unknown.map((f) => `${f} (${writers.get(f)} site(s))`).join(", ") +
   "\n          → migration 140 refuses (R0005) any mutation of an attachment an " +
   "evaluation cites. If this writer can run AFTER a completion, it will fail in " +
   "production. Decide which it is: add it to ALLOWED with the reason it runs " +
   "pre-citation, or make it add new truth instead of rewriting old evidence.");

for (const a of ALLOWED) {
  ok(`I2  ${a.file} is still present and still explained`,
     writers.has(a.file) && !!a.why,
     "an inventory entry for a file that no longer writes is stale — remove it, " +
     "so the list stays a statement about the code rather than about its history");
}

// ── the trigger is declared the way the doctrine requires ─────────────
const sql = fs.readFileSync(MIGRATION, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*--.*$/gm, " ");

ok("D1  the freeze fires BEFORE the write, not after",
   /create\s+trigger\s+freeze_cited_evidence_upd\s+before\s+update/i.test(sql),
   "an AFTER trigger would let the row change and then complain; this is a refusal, " +
   "and the error must name the row the caller just touched");
ok("D2  …on DELETE as well as UPDATE",
   /create\s+trigger\s+freeze_cited_evidence_del\s+before\s+delete/i.test(sql),
   "DELETE would fall through to a bare foreign-key violation an operator has to decode");
ok("D3  …with NO `when` clause narrowing it to a column list",
   !/freeze_cited_evidence_(upd|del)[\s\S]{0,200}?\bwhen\s*\(/i.test(sql),
   "a column list is what goes stale the day a column is added — the same argument " +
   "that kept a WHEN clause off the deferred guard. Once cited, the whole row is frozen");
ok("D4  …and it refuses with its own errcode, not a generic one",
   /R0005/.test(sql),
   "an operator seeing this needs to know it is doctrine, not corruption");
ok("D5  an UNCITED attachment is still mutable — ingress has to work",
   /if\s+v_ev\s+is\s+null\s+then[\s\S]{0,120}?return/i.test(sql),
   "freezing at creation rather than at citation would break every inbound photo " +
   "before it could ever become evidence");

console.log(`\n  writers found: ${JSON.stringify([...writers.entries()])}`);
console.log("\n══════════════════════════════════════════════════════════════════");
console.log(`  passed ${pass}   failed ${fail}`);
console.log("══════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
