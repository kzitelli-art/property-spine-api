#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  inspect-artifacts.js — the CLI face of baseline_scan.js
//
//  Called by export-baseline.sh so the shell never has to reimplement
//  scanning or hashing in grep and sed. Also runnable on its own by anybody
//  who has been sent two artifacts and wants to look at them before trusting
//  a manifest that came in the same email.
//
//    node inspect-artifacts.js --schema <file> --ledger <file> [--format sh|json]
//
//  Exit code is 0 whether or not there are warnings. A warning is for a human
//  to read, not a gate — the export script prints them and lets the owner
//  decide, which is the whole point of the design.
//  Exit 2 means the tool could not do its job: a missing file, a bad argument.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const { scanSchemaDump, scanLedgerDump, ledgerFacts, sha256 } = require("./baseline_scan");

function die(msg) { process.stderr.write(`inspect-artifacts: ${msg}\n`); process.exit(2); }

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--schema" || a === "--ledger" || a === "--format") {
    if (i + 1 >= args.length) die(`${a} needs a value`);
    opt[a.slice(2)] = args[++i];
  } else die(`unknown argument: ${a}`);
}
if (!opt.schema) die("--schema <file> is required");
if (!opt.ledger) die("--ledger <file> is required");
const format = opt.format || "json";
if (format !== "json" && format !== "sh") die("--format must be json or sh");

for (const p of [opt.schema, opt.ledger]) {
  if (!fs.existsSync(p)) die(`file not found: ${p}`);
}

const schemaText = fs.readFileSync(opt.schema, "utf8");
const ledgerText = fs.readFileSync(opt.ledger, "utf8");

const schemaScan = scanSchemaDump(schemaText);
const ledgerScan = scanLedgerDump(ledgerText);
const facts = ledgerFacts(ledgerText);

const report = {
  schema: {
    path: opt.schema,
    bytes: Buffer.byteLength(schemaText, "utf8"),
    sha256: sha256(schemaText),
    warnings: schemaScan.warnings,
  },
  ledger: {
    path: opt.ledger,
    bytes: Buffer.byteLength(ledgerText, "utf8"),
    sha256: sha256(ledgerText),
    warnings: ledgerScan.warnings,
    tables: ledgerScan.tables,
    rows: facts.rows,
    highest_version: facts.highest,
    duplicate_versions: facts.duplicates,
  },
  warning_count: schemaScan.warnings.length + ledgerScan.warnings.length,
  //  Said on every report, in the report, so it travels with the output
  //  rather than living only in a doc somebody may not have read.
  disclaimer:
    "BASIC INSPECTION AID. A clean result means none of a small set of known " +
    "shapes were found. It does not prove the artifact is free of sensitive information.",
};

if (format === "json") {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  //  Shell-assignable. Values are hashes, integers and a version string —
  //  nothing here can contain a connection string.
  const out = [
    `SCHEMA_SHA256=${report.schema.sha256}`,
    `SCHEMA_BYTES=${report.schema.bytes}`,
    `LEDGER_SHA256=${report.ledger.sha256}`,
    `LEDGER_BYTES=${report.ledger.bytes}`,
    `LEDGER_ROWS=${report.ledger.rows}`,
    `LEDGER_HIGHEST=${report.ledger.highest_version || "none"}`,
    `LEDGER_DUPLICATES=${report.ledger.duplicate_versions.length}`,
    `WARNING_COUNT=${report.warning_count}`,
  ];
  process.stdout.write(out.join("\n") + "\n");
  for (const w of report.schema.warnings) process.stderr.write(`  ! [schema] ${w.code}: ${w.detail}\n`);
  for (const w of report.ledger.warnings) process.stderr.write(`  ! [ledger] ${w.code}: ${w.detail}\n`);
}
