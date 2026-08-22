"use strict";

const assert = require("assert");
const artifacts = require("../src/onboarding/source_artifact_service");

let passed = 0;
function test(label, fn) {
  fn();
  passed += 1;
  console.log("  ok    " + label);
}
function refused(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
const pdf = Buffer.from("%PDF-1.7\nlease source");
const text = Buffer.from("resident,unit\nJane,3B\n");

console.log("\nLEASE SOURCE ARTIFACT PROOFS\n");

test("a Word lease form is admitted on the retained source rail", () => {
  const out = artifacts.validateUpload({
    filename: "skyline-lease.docx",
    mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: zip,
    artifact_kind: "lease_template",
  });
  assert.strictEqual(out.kind, "xlsx");
  assert.strictEqual(out.byte_size, zip.length);
});

test("a PDF lease form is also admitted", () => {
  const out = artifacts.validateUpload({
    filename: "lease.pdf", mimetype: "application/pdf", buffer: pdf,
    artifact_kind: "lease_template",
  });
  assert.strictEqual(out.kind, "pdf");
});

test("renamed text is refused with lease-specific copy", () => {
  const error = refused(() => artifacts.validateUpload({
    filename: "lease.docx", mimetype: "application/octet-stream", buffer: text,
    artifact_kind: "lease_template",
  }));
  assert(error && error.reason === "content_does_not_match_extension");
  assert(/Word document/i.test(error.receipt));
});

test("the lease addition does not make rent rolls accept Word files", () => {
  const error = refused(() => artifacts.validateUpload({
    filename: "rent-roll.docx", mimetype: "application/octet-stream", buffer: zip,
    artifact_kind: "rent_roll",
  }));
  assert(error && error.reason === "unsupported_file_type");
});

console.log(`\n${passed} assertions passed\n`);
