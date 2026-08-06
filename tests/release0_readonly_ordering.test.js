#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   release0_readonly_ordering.test.js

   Proves the ORDER OF OPERATIONS both read-only tools claim in their own
   output. Not the mutation barrier — Postgres's read-only transaction is
   that, and it was never in doubt. This tests the SENTENCE:

     "a write was attempted and refused before any read"
     "Nothing was read."

   Both were narrowly false until 2026-08-06. Each tool ran
   `select current_database(), current_user` BEFORE opening the read-only
   transaction and before the write probe, so a refused run had already
   issued a query, and "before any read" described something that had not
   happened. A safety sentence that is narrowly false is not a safety
   sentence, and a receipt repeating it is a confident-wrong about the audit
   itself.

   Static, source-level, no database. The runtime counterpart is the
   PostgreSQL statement log captured in
   docs/release-0-audit/ISOLATED_PROOF_RECEIPT.md §4.6, which is the
   authority — this test is the regression guard that keeps it true.

   Run:  node tests/release0_readonly_ordering.test.js
   Exit: 0 all assertions passed · 1 one or more failed
   ════════════════════════════════════════════════════════════════════ */

"use strict";

const fs = require("fs");
const path = require("path");

const TOOLS = [
  {
    name: "tools/release0_proof_audit.js",
    file: path.join(__dirname, "..", "tools", "release0_proof_audit.js"),
    probe: "__release0_audit_write_probe",
  },
  {
    name: "tools/ledger_reconcile.js",
    file: path.join(__dirname, "..", "tools", "ledger_reconcile.js"),
    probe: "__reconcile_write_probe",
  },
];

let failures = 0;
let passes = 0;

function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
    if (detail) console.error(`      ${detail}`);
  }
}

/*  Strip comments before locating anything. Every one of these tools
 *  DISCUSSES the ordering in prose directly above the code that implements
 *  it, so a naive indexOf finds the explanation, not the statement. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
            .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

console.log("\n══ Release 0 — read-only ordering ══\n");

for (const tool of TOOLS) {
  console.log(`  ${tool.name}`);
  const raw = fs.readFileSync(tool.file, "utf8");
  const src = stripComments(raw);

  // ── 1. The read-only BEGIN is the first statement sent. ─────────────
  //  Anchor on the whole call, not on the SQL string inside it, so the
  //  comparison is between like things: the index of the client.query()
  //  that opens the transaction, versus the index of every client.query().
  const beginCallIdx = src.search(/client\.query\(\s*["']begin transaction read only["']/);
  const beginIdx = src.indexOf("begin transaction read only");
  const queryIdxs = [];
  const re = /client\.query\(/g;
  let m;
  while ((m = re.exec(src)) !== null) queryIdxs.push(m.index);

  check(
    "    a read-only transaction is opened at all",
    beginCallIdx !== -1,
    "no client.query(\"begin transaction read only\") found");
  check(
    "    NO client.query() precedes `begin transaction read only`",
    beginCallIdx !== -1 && queryIdxs.every((i) => i >= beginCallIdx),
    beginCallIdx === -1
      ? "no read-only transaction found"
      : `first client.query() at ${Math.min(...queryIdxs)}, ` +
        `read-only begin at ${beginCallIdx}`);

  // ── 2. Connection identity is read AFTER the refusal branch. ────────
  const identityIdx = src.indexOf("current_database()");
  const refusalIdx = src.indexOf("REFUSED — this transaction accepted a write");
  check(
    "    connection identity is read AFTER the write-refusal branch",
    identityIdx === -1 || (refusalIdx !== -1 && identityIdx > refusalIdx),
    identityIdx === -1
      ? "no identity query (acceptable)"
      : `identity at ${identityIdx}, refusal branch at ${refusalIdx}`);

  check(
    "    connection identity is read AFTER `begin transaction read only`",
    identityIdx === -1 || (beginIdx !== -1 && identityIdx > beginIdx),
    `identity at ${identityIdx}, begin at ${beginIdx}`);

  // ── 3. The probe is savepoint-wrapped. ──────────────────────────────
  const spIdx = src.indexOf("savepoint write_probe");
  const probeIdx = src.indexOf(tool.probe);
  check(
    "    the write probe is preceded by a savepoint",
    spIdx !== -1 && probeIdx !== -1 && spIdx < probeIdx,
    `savepoint at ${spIdx}, probe at ${probeIdx}`);
  check(
    "    the savepoint is rolled back after the probe",
    src.indexOf("rollback to savepoint write_probe") > probeIdx);

  // ── 4. The refusal exits before any domain read. ────────────────────
  //  Everything between the refusal branch and its process.exit must not
  //  contain a client.query() other than the transaction rollback.
  if (refusalIdx !== -1) {
    const exitIdx = src.indexOf("process.exit(2)", refusalIdx);
    const between = src.slice(refusalIdx, exitIdx);
    const queriesInBetween = (between.match(/client\.query\(/g) || []).length;
    const onlyRollback = (between.match(/client\.query\("rollback"\)/g) || []).length;
    check(
      "    the refusal path issues nothing but `rollback` before exiting",
      queriesInBetween === onlyRollback,
      `${queriesInBetween} queries, ${onlyRollback} of them rollback`);
  }

  // ── 5. client.connect() is guarded. ─────────────────────────────────
  //  An unhandled connection failure is a Node stack trace, and an operator
  //  cannot tell "failed" from "crashed" by reading one.
  const connectIdx = src.indexOf("client.connect()");
  const before = src.slice(Math.max(0, connectIdx - 200), connectIdx);
  check(
    "    client.connect() is inside a try block",
    connectIdx !== -1 && /try\s*\{[^}]*$/.test(before),
    "an unguarded connect surfaces as an unhandled rejection");

  const afterConnect = src.slice(connectIdx, connectIdx + 500);
  check(
    "    a failed connect refuses in the tool's own voice",
    /Could not connect to the database/.test(afterConnect),
    "no operator-facing message on connect failure");

  console.log("");
}

console.log(`  ${passes} passed · ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
