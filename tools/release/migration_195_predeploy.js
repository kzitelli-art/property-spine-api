#!/usr/bin/env node
/*
  The one-time, bounded operation for migration 195.

  This is deliberately not an npm prestart hook and it is not the fixture
  rehearsal.  It accepts only the reviewed 194 state or an already-applied,
  physically compatible 195 state.  --apply is the only writing mode and
  delegates to the real migrations/migrate.js runner.
*/
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { Client } = require("pg");
const { databaseSsl } = require("../../src/shared/database_ssl");
const { classifyLedger, normalizeName } = require("../../migrations/ledger_verdict");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const FILE_195 = "195_two_step_leasing_authored_offer_basis.sql";
// SHA-256 of the reviewed migration source at 7cb245e.  A changed file needs
// a new review; this command must never silently bless a look-alike 195.
const REVIEWED_195_SHA256 = "e5c8f9bdb382b3a36e56e9b514db25734639500be9579171762d37c7e28b02bb";
const APPLY = process.argv.slice(2).join(" ") === "--apply";

function die(message, detail) {
  console.error(`\nMIGRATION 195 PREDEPLOY REFUSED: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function exactBuildPin() {
  const expected = (process.env.EXPECTED_SHA || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    die("EXPECTED_SHA must be one full 40-hex commit SHA.", "A short prefix is not an exact release artifact.");
  }
  const render = (process.env.RENDER_GIT_COMMIT || "").trim().toLowerCase();
  let actual;
  try { actual = render || git(["rev-parse", "HEAD"]).toLowerCase(); }
  catch { die("the executing build identity could not be resolved."); }
  if (actual !== expected) die("EXPECTED_SHA does not equal the executing build.", `expected ${expected}\nrunning  ${actual}`);
  if (!render) {
    let dirty;
    try { dirty = git(["status", "--porcelain", "--untracked-files=no"]); }
    catch { die("the executing checkout could not be inspected for tracked changes."); }
    if (dirty) die("the executing checkout has tracked changes.", dirty);
  }
  return expected;
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_"))
    .sort();
}

function reviewedFile() {
  const file = path.join(MIGRATIONS, FILE_195);
  if (!fs.existsSync(file)) die(`migrations/${FILE_195} is absent.`);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== REVIEWED_195_SHA256) {
    die("the on-disk migration 195 does not match the reviewed source.", `expected ${REVIEWED_195_SHA256}\nactual   ${actual}`);
  }
}

function stripped(definition) {
  return String(definition).toLowerCase().replace(/[\s\"]/g, "");
}

function literals(definition) {
  return [...String(definition).matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
}

function same(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

function required(defs, name, table, values, fragments) {
  const row = defs.get(name);
  if (!row) return `${name} is absent`;
  if (row.table_name !== table || row.contype !== "c" || !row.convalidated) {
    return `${name} is not a validated CHECK on ${table}`;
  }
  if (!same(literals(row.definition), [...values].sort())) {
    return `${name} has unexpected vocabulary: ${row.definition}`;
  }
  const value = stripped(row.definition);
  if (!fragments.every((part) => value.includes(stripped(part)))) {
    return `${name} has an unexpected definition: ${row.definition}`;
  }
  return null;
}

const PRE_CONTRACT = [
  ["aptc_source_ck", "application_proposed_terms_confirmations", ["operator_proposed_terms"], ["source=", "operator_proposed_terms"]],
  ["aptc_authority_ck", "application_proposed_terms_confirmations", ["owner", "role_authority", "managed_role_override"], ["authority_basis=", "any(array["]],
  ["la_term_source_ck", "lease_applications", ["application_capture", "confirm_term_repair", "operator_proposed_terms"], ["term_sourceisnullor", "any(array["]],
];
const POST_CONTRACT = [
  ["aptc_source_ck", "application_proposed_terms_confirmations", ["operator_proposed_terms", "authored_offer_acknowledged"], ["source=", "any(array["]],
  ["aptc_authority_ck", "application_proposed_terms_confirmations", ["owner", "role_authority", "managed_role_override", "authored_offer"], ["authority_basis=", "any(array["]],
  ["aptc_derived_names_offer_ck", "application_proposed_terms_confirmations", ["authored_offer_acknowledged"], ["source<>", "application_offer_idisnotnull", "application_terms_hashisnotnull"]],
  ["la_term_source_ck", "lease_applications", ["application_capture", "confirm_term_repair", "operator_proposed_terms", "authored_offer_acknowledged"], ["term_sourceisnullor", "any(array["]],
];

async function physicalContract(client, contract) {
  const { rows } = await client.query(`
    select c.conname, cl.relname as table_name, c.contype, c.convalidated,
           pg_get_constraintdef(c.oid, true) as definition
      from pg_constraint c
      join pg_class cl on cl.oid=c.conrelid
     where c.conname = any($1::text[])
  `, [contract.map(([name]) => name)]);
  const defs = new Map(rows.map((row) => [row.conname, row]));
  const failures = contract.map(([name, table, values, fragments]) =>
    required(defs, name, table, values, fragments)).filter(Boolean);
  const columns = await client.query(`
    select table_name, column_name from information_schema.columns
     where table_schema='public'
       and ((table_name='application_proposed_terms_confirmations' and column_name in ('application_offer_id','application_terms_hash'))
         or table_name='lease_applications' and column_name='term_source')
  `);
  const got = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
  for (const column of [
    "application_proposed_terms_confirmations.application_offer_id",
    "application_proposed_terms_confirmations.application_terms_hash",
    "lease_applications.term_source",
  ]) if (!got.has(column)) failures.push(`required lineage column ${column} is absent`);
  return failures;
}

function expectedRows(files) {
  return files.map((file) => ({ version: file.slice(0, 3), name: file.slice(4, -4) }));
}

function exactVersions(rows, expected) {
  const got = new Map(rows.filter((row) => row.version !== "000").map((row) => [String(row.version), row.name]));
  if (got.size !== expected.length) return false;
  return expected.every((want) => got.has(want.version) &&
    (normalizeName(got.get(want.version)) === normalizeName(want.name) || want.version === "012"));
}

async function inspect(client) {
  const { rows } = await client.query("select version, name from schema_migrations order by version");
  const files = migrationFiles();
  const verdict = classifyLedger({ files, ledgerRows: rows });
  if (!verdict.structurallySound) die("the migration ledger is malformed or disagrees with this build.", JSON.stringify(verdict, null, 2));
  const pre = expectedRows(files.filter((file) => Number(file.slice(0, 3)) <= 194));
  const post = expectedRows(files);
  const state = exactVersions(rows, pre) ? "pre" : exactVersions(rows, post) ? "post" : null;
  if (!state) die("ledger is neither the exact reviewed 194 pre-state nor the exact 195 post-state.", `ceiling ${verdict.ceiling}; expected ${pre.length} pre rows or ${post.length} post rows (excluding 000).`);
  const physical = await physicalContract(client, state === "pre" ? PRE_CONTRACT : POST_CONTRACT);
  if (physical.length) die(`ledger ${state === "pre" ? "194" : "195"} does not carry its required physical schema.`, physical.map((line) => `- ${line}`).join("\n"));
  return { state, entries: rows.filter((row) => row.version !== "000").length, ceiling: verdict.ceiling };
}

function runMigration(pin) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "migrations", "migrate.js"), "--apply"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "194", EXPECTED_SHA: pin },
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) die("migrations/migrate.js refused or failed; no API start is authorised.", `exit ${result.status}`);
}

(async () => {
  if (process.env.MIGRATION_RELEASE) die("MIGRATION_RELEASE must not be set for this operation.", "Only the child one-time apply process receives it when --apply is explicitly chosen.");
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) die("DATABASE_URL is required.");
  const pin = exactBuildPin();
  reviewedFile();
  const client = new Client({ connectionString: url, ssl: databaseSsl(url) });
  await client.connect();
  let before;
  try { before = await inspect(client); }
  finally { await client.end(); }
  console.log(`MIGRATION 195 PREDEPLOY: exact ${before.state}-state accepted (${before.entries} ledger rows, ceiling ${before.ceiling}); reviewed SHA and source hash match.`);
  if (!APPLY) {
    console.log("VERIFY-ONLY: no migration was applied. Use --apply only in the reviewed release window.");
    return;
  }
  if (before.state !== "pre") die("--apply is permitted only from the exact 194 pre-state.", "An already-applied 195 must be handled by the matching API build in verify-only mode.");
  runMigration(pin);
  const afterClient = new Client({ connectionString: url, ssl: databaseSsl(url) });
  await afterClient.connect();
  let after;
  try { after = await inspect(afterClient); }
  finally { await afterClient.end(); }
  if (after.state !== "post" || after.ceiling !== "195") die("migration runner returned but the exact 195 post-state was not observed.");
  console.log(`MIGRATION 195 RELEASE VERIFIED: ${after.entries} ledger rows, ceiling ${after.ceiling}, all reviewed physical constraints present.`);
})().catch((error) => die("the operation threw.", error && error.stack ? error.stack : String(error)));
