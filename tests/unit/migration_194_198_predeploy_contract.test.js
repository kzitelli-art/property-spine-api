#!/usr/bin/env node
"use strict";

const {
  RELEASE_FILES, normalizeDefinition, positiveInterval, ledgerNameMatches,
  decideState, parseCommand, constraintKey, requiredConstraint,
} = require("../../tools/release/migration_194_198_contract");

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}`); }
}

const historicalFiles = ["001_baseline.sql", "012_bank_intake.sql", "194_required_work_target.sql"];
const files = [...historicalFiles, ...RELEASE_FILES];
const names = {
  "001": "baseline", "012": "property_noi_goals", "194": "required_work_target",
  "195": "two_step_leasing_authored_offer_basis", "196": "source_home_identity_review",
  "197": "inventory_correction_hardening", "198": "proposed_source_claim_identity",
};
function rows(ceiling) {
  return Object.entries(names).filter(([version]) => Number(version) <= ceiling)
    .map(([version, name]) => ({ version, name }));
}
function verdict(ceiling, list = files) {
  return {
    structurallySound: true,
    ceiling: String(ceiling),
    fileMissingFromLedger: list.filter((file) => Number(file.slice(0, 3)) > ceiling),
  };
}
function state(ceiling, list = files, ledger = rows(ceiling), result = verdict(ceiling, list)) {
  return decideState({ files: list, rows: ledger, verdict: result });
}

console.log("\nCOMBINED MIGRATION 194-198 CONTRACT\n");
check("positive lock/statement intervals are accepted",
  positiveInterval("500ms") === "500ms" && positiveInterval(" 2MIN ") === "2min");
check("zero and malformed intervals are refused",
  positiveInterval("0") === null && positiveInterval("-1s") === null && positiveInterval("1 hour") === null);
check("quoted literal bytes survive definition normalization",
  normalizeDefinition("CHECK (x = 'A B')") !== normalizeDefinition("check(x='a b')"));
check("the exact documented 012 legacy ledger name is accepted",
  ledgerNameMatches("012", "property_noi_goals", "bank_intake"));
check("the 012 exception is not a broad version exemption",
  !ledgerNameMatches("012", "unreviewed_other_name", "bank_intake"));

for (const ceiling of [194, 195, 196, 197, 198]) {
  const decision = state(ceiling);
  check(`exact ${ceiling} ledger accepts its exact suffix`, decision.ok && decision.ceiling === ceiling &&
    decision.pending.length === 198 - ceiling);
}
check("an extra future migration is refused", !state(198, [...files, "199_future.sql"]).ok);
check("a missing reviewed migration is refused", !state(194, files.filter((file) => !file.startsWith("197_"))).ok);
check("a malformed ledger is refused", !state(194, files, rows(194), { ...verdict(194), structurallySound: false }).ok);
check("an extra ledger row is refused", !state(194, files, [...rows(194), { version: "111", name: "drift" }]).ok);
check("wrong reviewed ledger name is refused", !state(196, files,
  rows(196).map((row) => row.version === "196" ? { ...row, name: "wrong" } : row)).ok);
check("wrong pending order is refused", !state(195, files, rows(195), {
  ...verdict(195), fileMissingFromLedger: [...verdict(195).fileMissingFromLedger].reverse(),
}).ok);

check("no arguments is exact-198 verify-only", parseCommand([]).kind === "verify" && parseCommand([]).ceiling === 198);
check("ordinary apply is exact-194 only", parseCommand(["--apply"]).kind === "apply" && parseCommand(["--apply"]).ceiling === 194);
check("explicit partial resume flags are accepted",
  [195, 196, 197].every((ceiling) => parseCommand([`--resume${ceiling}`]).ceiling === ceiling));
check("spaced, wrong, and extra resume arguments are refused",
  !parseCommand(["--resume", "195"]) && !parseCommand(["--resume194"]) && !parseCommand(["--resume198"]));

const row = {
  schema_name: "public", table_name: "proposed_records", conname: "sample_ck",
  contype: "c", convalidated: true,
  definition: "CHECK (target_type = 'inventory_identity'::text)",
};
const definitions = new Map([[constraintKey("public", "proposed_records", "sample_ck"), row]]);
check("a constraint is keyed by its actual relation and exact definition",
  !requiredConstraint(definitions, "sample_ck", "proposed_records", row.definition));
check("the same name on another relation cannot satisfy the contract",
  !!requiredConstraint(definitions, "sample_ck", "other_records", row.definition));
check("changed literal content is refused",
  !!requiredConstraint(definitions, "sample_ck", "proposed_records",
    row.definition.replace("inventory_identity", "INVENTORY_IDENTITY")));

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
