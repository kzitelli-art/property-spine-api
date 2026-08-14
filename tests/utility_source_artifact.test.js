"use strict";

const assert = require("assert");
const artifacts = require("../src/onboarding/source_artifact_service.js");

let pass = 0;
function ok(label, fn) {
  fn(); pass += 1;
  console.log(`  ok    ${label}`);
}

function refusal(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

const pdf = Buffer.from("%PDF-1.7\nutility evidence");
const csv = Buffer.from("meter_id,service_point\nM-1,Common Areas\n");

console.log("\nUTILITY SOURCE ARTIFACT - SHARED RAIL PROOFS\n");

ok("a provider statement accepts a real PDF shape", () => {
  const result = artifacts.validateUpload({
    filename: "peco-july.pdf", mimetype: "application/pdf", buffer: pdf,
    artifact_kind: "utility_statement",
  });
  assert.strictEqual(result.kind, "pdf");
});

ok("a meter schedule accepts a spreadsheet export", () => {
  const result = artifacts.validateUpload({
    filename: "meters.csv", mimetype: "text/csv", buffer: csv,
    artifact_kind: "utility_meter_schedule",
  });
  assert.strictEqual(result.kind, "csv");
});

ok("a renamed statement CSV is refused with Utility-specific next action", () => {
  const error = refusal(() => artifacts.validateUpload({
    filename: "statement.csv", mimetype: "text/csv", buffer: csv,
    artifact_kind: "utility_statement",
  }));
  assert(error && error.reason === "unsupported_file_type");
  assert(/provider issued/i.test(error.receipt));
});

ok("Utility additions do not make rent rolls accept PDFs", () => {
  const error = refusal(() => artifacts.validateUpload({
    filename: "rent-roll.pdf", mimetype: "application/pdf", buffer: pdf,
    artifact_kind: "rent_roll",
  }));
  assert(error && error.reason === "unsupported_file_type");
  assert(/spreadsheet/i.test(error.receipt));
});

ok("a filename cannot disguise non-PDF bytes", () => {
  const error = refusal(() => artifacts.validateUpload({
    filename: "utility.pdf", mimetype: "application/pdf", buffer: csv,
    artifact_kind: "utility_statement",
  }));
  assert(error && error.reason === "content_does_not_match_extension");
});

console.log(`\n${pass} assertions passed\n`);
