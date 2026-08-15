"use strict";

const assert = require("assert");
const sourceArtifacts = require("../src/onboarding/source_artifact_service.js");

let passed = 0;
function ok(label, check) {
  check();
  passed += 1;
  console.log(`  ok    ${label}`);
}

function refusal(input) {
  try { sourceArtifacts.validateUpload(input); } catch (error) { return error; }
  throw new Error("upload unexpectedly accepted");
}

console.log("\nCONTRACTED SERVICES SOURCE EVIDENCE\n");

ok("an issued agreement is accepted as PDF evidence", () => {
  const result = sourceArtifacts.validateUpload({
    filename: "elevator agreement.pdf", mimetype: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF"),
    artifact_kind: "contracted_service_agreement",
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, "pdf");
});

ok("an accounting workbook remains accounting evidence, not contract truth", () => {
  const result = sourceArtifacts.validateUpload({
    filename: "contract expense detail.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
    artifact_kind: "contracted_service_accounting_report",
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, "xlsx");
});

ok("a renamed text file is refused with Contracted Services language", () => {
  const error = refusal({
    filename: "service agreement.txt", mimetype: "text/plain",
    buffer: Buffer.from("not an issued agreement"),
    artifact_kind: "contracted_service_agreement",
  });
  assert.strictEqual(error.reason, "unsupported_file_type");
  assert(/Contracted Services document as a PDF/.test(error.message));
  assert(!/rent roll/i.test(error.message));
});

ok("a PDF filename with non-PDF bytes is refused before retention", () => {
  const error = refusal({
    filename: "service proposal.pdf", mimetype: "application/pdf",
    buffer: Buffer.from("plain text"),
    artifact_kind: "contracted_service_proposal",
  });
  assert.strictEqual(error.reason, "content_does_not_match_extension");
});

console.log(`\n${passed} assertions passed\n`);
