"use strict";

const { normalizeName, LEGACY_LEDGER_NAMES } = require("../../migrations/ledger_verdict");

const RELEASE_FILES = Object.freeze([
  "195_two_step_leasing_authored_offer_basis.sql",
  "196_source_home_identity_review.sql",
  "197_inventory_correction_hardening.sql",
  "198_proposed_source_claim_identity.sql",
]);
const ACCEPTED_CEILINGS = Object.freeze([194, 195, 196, 197, 198]);

// PostgreSQL changes whitespace and keyword case when it prints catalog
// definitions. Normalize only SQL syntax outside quoted regions. Literal and
// quoted-identifier bytes remain exact because either can change a predicate.
function normalizeDefinition(definition) {
  const input = String(definition);
  let output = "";
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (quote) {
      output += character;
      if (character === quote && input[i + 1] === quote) output += input[++i];
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
    } else if (!/\s/.test(character)) output += character.toLowerCase();
  }
  return output;
}

function positiveInterval(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^\d+(ms|s|min)?$/.test(normalized)) return null;
  const amount = Number(normalized.match(/^\d+/)[0]);
  return Number.isSafeInteger(amount) && amount > 0 ? normalized : null;
}

function versionOf(file) { return file.slice(0, 3); }
function labelOf(file) { return file.slice(4, -4); }

function exactLegacyName(version, ledgerName, fileName) {
  return LEGACY_LEDGER_NAMES.some((entry) =>
    entry.version === version &&
    normalizeName(entry.ledgerName) === normalizeName(ledgerName) &&
    normalizeName(entry.fileName) === normalizeName(fileName));
}

function ledgerNameMatches(version, ledgerName, fileName) {
  return normalizeName(ledgerName) === normalizeName(fileName) ||
    exactLegacyName(version, ledgerName, fileName);
}

function expectedRows(files) {
  return files.map((file) => ({ version: versionOf(file), name: labelOf(file) }));
}

function exactLedgerRows(rows, expected) {
  const material = rows.filter((row) => String(row.version) !== "000");
  if (material.length !== expected.length) return false;
  const got = new Map(material.map((row) => [String(row.version), row.name]));
  if (got.size !== expected.length) return false;
  return expected.every((wanted) => got.has(wanted.version) &&
    ledgerNameMatches(wanted.version, got.get(wanted.version), wanted.name));
}

function decideState({ files, rows, verdict }) {
  const releaseCounts = new Map(RELEASE_FILES.map((file) => [file, 0]));
  for (const file of files) {
    if (releaseCounts.has(file)) releaseCounts.set(file, releaseCounts.get(file) + 1);
  }
  const missingOrDuplicate = [...releaseCounts].filter(([, count]) => count !== 1);
  const later = files.filter((file) => Number(versionOf(file)) > 198);
  if (missingOrDuplicate.length || later.length) {
    return { ok: false, reason: "build does not contain exactly one reviewed migration 195-198 file and no later migration" };
  }
  if (!verdict || !verdict.structurallySound) {
    return { ok: false, reason: "ledger/build structure is malformed" };
  }

  for (const ceiling of ACCEPTED_CEILINGS) {
    const throughCeiling = files.filter((file) => Number(versionOf(file)) <= ceiling);
    const expected = expectedRows(throughCeiling);
    const pending = RELEASE_FILES.filter((file) => Number(versionOf(file)) > ceiling);
    if (!exactLedgerRows(rows, expected)) continue;
    if (String(verdict.ceiling) !== String(ceiling)) continue;
    if (verdict.fileMissingFromLedger.length !== pending.length) continue;
    if (!pending.every((file, index) => verdict.fileMissingFromLedger[index] === file)) continue;
    return {
      ok: true,
      ceiling,
      entries: rows.filter((row) => String(row.version) !== "000").length,
      pending,
    };
  }
  return { ok: false, reason: "ledger is not an exact reviewed 194, 195, 196, 197, or 198 state" };
}

function parseCommand(args) {
  if (args.length === 0) return { kind: "verify", ceiling: 198 };
  if (args.length === 1 && args[0] === "--apply") return { kind: "apply", ceiling: 194 };
  const match = args.length === 1 && /^--resume(195|196|197)$/.exec(args[0]);
  return match ? { kind: "resume", ceiling: Number(match[1]) } : null;
}

function constraintKey(schema, table, name) { return `${schema}.${table}.${name}`; }

function requiredConstraint(definitions, name, table, definition, type = "c") {
  const row = definitions.get(constraintKey("public", table, name));
  if (!row) return `${name} is absent from public.${table}`;
  if (row.contype !== type || !row.convalidated) {
    return `${name} is not a validated ${type === "f" ? "foreign key" : "CHECK"} on public.${table}`;
  }
  if (normalizeDefinition(row.definition) !== normalizeDefinition(definition)) {
    return `${name} differs from the reviewed definition: ${row.definition}`;
  }
  return null;
}

module.exports = {
  RELEASE_FILES,
  ACCEPTED_CEILINGS,
  normalizeDefinition,
  positiveInterval,
  ledgerNameMatches,
  exactLedgerRows,
  decideState,
  parseCommand,
  constraintKey,
  requiredConstraint,
};
