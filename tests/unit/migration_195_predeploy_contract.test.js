#!/usr/bin/env node
// Pure decision proof for migration 195. Database witnesses exercise the
// runner; these cases protect the exact definition and state decisions.
"use strict";

const {
  FILE_195, PRE_CONTRACT, POST_CONTRACT, constraintKey, requiredConstraint, decideState, positiveInterval,
} = require("../../tools/release/migration_195_contract");

let pass = 0, fail = 0;
function ok(label, condition) {
  if (condition) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}`); }
}
function row(table, name, definition) {
  return { schema_name: "public", table_name: table, conname: name, contype: "c", convalidated: true, definition };
}
function defs(rows) { return new Map(rows.map((r) => [constraintKey(r.schema_name, r.table_name, r.conname), r])); }
const ledgerNames = {
  "001": "baseline",
  "194": "required_work_target",
  "195": "two_step_leasing_authored_offer_basis",
  "196": "future",
};
function ledger(version) { return { version, name: ledgerNames[version] }; }
function verdict(ceiling, pending) { return { ceiling, fileMissingFromLedger: pending, structurallySound: true }; }

const source = "CHECK (source = 'operator_proposed_terms'::text)";
const authority194 = "CHECK (authority_basis = ANY (ARRAY['owner'::text, 'role_authority'::text, 'managed_role_override'::text]))";
const term194 = "CHECK (term_source IS NULL OR (term_source = ANY (ARRAY['application_capture'::text, 'confirm_term_repair'::text, 'operator_proposed_terms'::text])))";
const authority195 = "CHECK (authority_basis = ANY (ARRAY['owner'::text, 'role_authority'::text, 'managed_role_override'::text, 'authored_offer'::text]))";

console.log("\nMIGRATION 195 PREDEPLOY CONTRACT\n");
ok("positive preflight intervals are accepted", positiveInterval("500ms") === "500ms" && positiveInterval(" 2MIN ") === "2min");
ok("zero preflight intervals are refused", positiveInterval("0") === null && positiveInterval("0ms") === null && positiveInterval("00min") === null);
ok("actual 194 source CHECK is accepted", !requiredConstraint(defs([row("application_proposed_terms_confirmations", "aptc_source_ck", source)]), ...PRE_CONTRACT[0]));
ok("actual 194 authority CHECK is accepted", !requiredConstraint(defs([row("application_proposed_terms_confirmations", "aptc_authority_ck", authority194)]), ...PRE_CONTRACT[1]));
ok("actual 194 term-source CHECK is accepted", !requiredConstraint(defs([row("lease_applications", "la_term_source_ck", term194)]), ...PRE_CONTRACT[2]));
ok("upper-case authored_offer literal is refused", !!requiredConstraint(defs([row("application_proposed_terms_confirmations", "aptc_authority_ck", authority195.replace("'authored_offer'", "'AUTHORED_OFFER'"))]), ...POST_CONTRACT[1]));
ok("whitespace inside authored_offer literal is refused", !!requiredConstraint(defs([row("application_proposed_terms_confirmations", "aptc_authority_ck", authority195.replace("'authored_offer'", "'authored_ offer'"))]), ...POST_CONTRACT[1]));
ok("quoted identifier content is not normalized", !!requiredConstraint(defs([row("application_proposed_terms_confirmations", "aptc_authority_ck", authority195.replace("authority_basis", "\"AUTHORITY_BASIS\""))]), ...POST_CONTRACT[1]));
ok("same conname on another public relation cannot satisfy target", !!requiredConstraint(defs([row("other_table", "aptc_authority_ck", authority195)]), ...POST_CONTRACT[1]));
ok("another public relation cannot overwrite the target constraint", !requiredConstraint(defs([
  row("application_proposed_terms_confirmations", "aptc_authority_ck", authority195),
  row("other_table", "aptc_authority_ck", "CHECK (false)"),
]), ...POST_CONTRACT[1]));

const files195 = ["001_baseline.sql", "194_required_work_target.sql", FILE_195];
const rows194 = [ledger("001"), ledger("194")];
const rows195 = [...rows194, { version: "195", name: "two_step_leasing_authored_offer_basis" }];
ok("exact 194 plus only pending195 is pre-state", decideState({ files: files195, rows: rows194, verdict: verdict("194", [FILE_195]) }).state === "pre");
ok("exact 195 with no pending file is post-state", decideState({ files: files195, rows: rows195, verdict: verdict("195", []) }).state === "post");
const files196 = [...files195, "196_future.sql"];
ok("pending196-shaped build is refused", !decideState({ files: files196, rows: rows194, verdict: verdict("194", [FILE_195, "196_future.sql"]) }).ok);
ok("applied196-shaped build is refused", !decideState({ files: files196, rows: [...rows195, ledger("196")], verdict: verdict("196", []) }).ok);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
