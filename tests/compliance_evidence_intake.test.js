#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const artifacts = require("../src/onboarding/source_artifact_service.js");
const intake = require("../src/asset/compliance_evidence_intake.js");

const EXPECTED_ASSERTIONS = 26;
let pass = 0, fail = 0;
function ok(label, condition, detail) {
  if (condition) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

class MemoryDb {
  constructor() { this.rows = []; this.next = 1; this.sql = []; }
  async query(sql, params) {
    this.sql.push(sql);
    if (/^\s*select id, original_filename/i.test(sql)) {
      const row = this.rows.find((candidate) =>
        candidate.scope_type === params[0] && candidate.scope_id === params[1] && candidate.sha256 === params[2]);
      return { rows: row ? [row] : [] };
    }
    if (/^\s*insert into source_artifacts/i.test(sql)) {
      const row = {
        id: `artifact-${this.next++}`,
        scope_type: params[0], scope_id: params[1], original_filename: params[2],
        mime_type: params[3], artifact_kind: params[4], byte_size: params[5],
        sha256: params[6], uploaded_at: "2026-08-13T12:00:00Z",
        source_as_of_date: params[8],
      };
      this.rows.push(row);
      return { rows: [row] };
    }
    throw new Error("Unexpected SQL in memory proof: " + sql);
  }
}

const pdf = Buffer.from("%PDF-1.7\nreal specimen bytes for retention proof\n%%EOF");
const fixture = fs.readFileSync(
  path.join(__dirname, "fixtures", "compliance", "solo_4233_rental_license.txt"), "utf8");

console.log("COMPLIANCE EVIDENCE INTAKE - retain first, recognize second");

const existingOther = [
  ["source.csv", Buffer.from("a,b\n1,2"), "csv"],
  ["source.tsv", Buffer.from("a\tb\n1\t2"), "tsv"],
  ["source.txt", Buffer.from("plain text"), "txt"],
  ["source.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), "xlsx"],
  ["source.xlsm", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), "xlsx"],
  ["source.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "xls"],
];
for (const [filename, buffer, expectedKind] of existingOther) {
  const result = artifacts.validateUpload({ filename, buffer, artifact_kind: "other" });
  ok(`pre-existing other format still works: ${filename}`, result.kind === expectedKind);
}
const validatedPdf = artifacts.validateUpload({ filename: "source.pdf", buffer: pdf, artifact_kind: "other" });
ok("generic other additionally accepts PDF bytes", validatedPdf.kind === "pdf");

let rentRollRefused = false;
try { artifacts.validateUpload({ filename: "source.pdf", buffer: pdf, artifact_kind: "rent_roll" }); }
catch (error) { rentRollRefused = error.reason === "unsupported_file_type"; }
ok("rent roll still refuses PDF", rentRollRefused);

let renamedRefused = false;
try { artifacts.validateUpload({ filename: "source.pdf", buffer: Buffer.from("not a pdf"), artifact_kind: "other" }); }
catch (error) { renamedRefused = error.reason === "content_does_not_match_extension"; }
ok("generic PDF still requires PDF bytes", renamedRefused);

(async () => {
  const db = new MemoryDb();
  const input = {
    authorized_property_id: "property-solo",
    authenticated_user_id: "operator-1",
    authority_basis: "operator_session_property_scope",
    filename: "misleading-payment-receipt.pdf",
    mimetype: "application/pdf",
    buffer: pdf,
    extractText: async () => fixture,
  };
  const first = await intake.retainAndRecognize(db, input);
  ok("source is retained before proposal", db.rows.length === 1 && first.artifact.id === "artifact-1");
  ok("retained source remains generically classified", first.artifact.artifact_kind === "other");
  ok("filename does not prevent content recognition", first.proposal.recognition_state === "recognized");
  ok("adapter proposes the explicit license number", first.proposal.proposed.external_credential_number === "922616");
  ok("intake returns a proposal fingerprint", /^[0-9a-f]{64}$/.test(first.proposal_basis.fingerprint));
  ok("successful intake has no failure", first.failure === null);

  const second = await intake.retainAndRecognize(db, input);
  ok("duplicate bytes return the existing artifact", second.artifact.id === first.artifact.id);
  ok("duplicate bytes report existing dedupe semantics", second.artifact.deduplicated === true);
  ok("duplicate bytes do not add a row", db.rows.length === 1);
  ok("deduplicated proposal basis is stable", second.proposal_basis.fingerprint === first.proposal_basis.fingerprint);

  const failedPdf = Buffer.from("%PDF-1.7\nparser-failure specimen\n%%EOF");
  const failed = await intake.retainAndRecognize(db, {
    ...input, filename: "unreadable.pdf", buffer: failedPdf,
    extractText: async () => { throw new Error("parser exploded"); },
  });
  ok("parser failure still retains a second source", db.rows.length === 2 && failed.artifact.id === "artifact-2");
  ok("parser failure reports recognition_failed", failed.failure.code === "recognition_failed");
  ok("failure receipt says the artifact is retained", failed.failure.artifact.retained === true);
  ok("parser failure does not fabricate a proposal", failed.proposal === null && failed.proposal_basis === null);

  ok("only source_artifacts receives an insert", db.sql.filter((sql) => /^\s*insert/i.test(sql)).every((sql) => /insert into source_artifacts/i.test(sql)));
  const storageSource = fs.readFileSync(path.join(__dirname, "..", "src", "onboarding", "source_artifact_service.js"), "utf8");
  ok("shared storage has no Compliance imports", !/require\([^)]*compliance/i.test(storageSource));
  ok("shared storage has no rental-license classification", !/rental[_ -]?license/i.test(storageSource));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_ASSERTIONS) {
    console.error(`Assertion census drift: expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}`);
    process.exit(2);
  }
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
