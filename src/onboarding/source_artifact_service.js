// ════════════════════════════════════════════════════════════════════
//  source_artifact_service.js — THE RETAINED SOURCE FILE
//
//  Spine can always show the exact source that established a position.
//
//  ── IT IS NOT A DOCUMENT PLATFORM ───────────────────────────────────
//  No OCR, no extraction, no classification, no folders, no versions, no
//  search, no delete. Three operations exist because the activation flow
//  needs exactly three:
//
//      validateUpload   is this file acceptable, before anything is written
//      store            write the bytes, bound to one deal or property
//      read             hand the exact bytes back
//
//  ── THE SEAM AND THE ADAPTER ────────────────────────────────────────
//  Same ruling as work_proof_attachment_service (migrations 118/134), and
//  deliberately the same shape so this repo has ONE binary-storage
//  pattern rather than two. The CONTRACT is Class 1: an opaque id naming
//  one file, what it is about, and who put it there. The STORAGE is a
//  Class 2 adapter — `content bytea` in Postgres.
//
//  REPLACEMENT CONDITION — move behind object storage when volume makes
//  database storage burdensome. Ids, authority and API are unaffected;
//  only `store`/`read` change. Nothing outside this file reads `content`.
//
//  ── A FILENAME IS A CLAIM, NOT A FACT ───────────────────────────────
//  `report.xlsx` containing a PDF is refused by looking at the leading
//  bytes, exactly as the photo service does. What we accept here is
//  narrow on purpose: a spreadsheet or a delimited text file. That is
//  what a rent roll is. Loan PDFs, tax notices and contracts are the
//  harder Money sources and they are NOT solved by widening this list.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");

const MAX_BYTES = 25 * 1024 * 1024;          // matches the CHECK in migration 153

//  Accepted shapes, by what the bytes actually START with.
//    xlsx  — a zip container ("PK\x03\x04")
//    xls   — the OLE2 compound-document header
//    csv/tsv/txt — no signature exists; validated as decodable text instead
const SIGNATURES = Object.freeze([
  { kind: "xlsx", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: "xlsx", bytes: [0x50, 0x4b, 0x05, 0x06] },   // empty archive
  { kind: "xlsx", bytes: [0x50, 0x4b, 0x07, 0x08] },   // spanned archive
  { kind: "xls",  bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { kind: "pdf",  bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },   // "%PDF-"
]);

const TEXTUAL_EXT = new Set(["csv", "tsv", "txt"]);
const BINARY_EXT  = new Set(["xlsx", "xlsm", "xls", "pdf"]);

/*  ── WHAT SHAPE IS LEGITIMATE DEPENDS ON WHAT THE ARTIFACT IS ───────
 *  This file's header warns that loan PDFs and contracts "are NOT solved
 *  by widening this list", and that is right: one flat list serving every
 *  artifact kind would mean a rent roll silently starts accepting PDFs —
 *  a real regression, because a PDF rent roll is exactly the mistake the
 *  rent-roll refusal exists to catch and name.
 *
 *  So the list is not widened. It becomes a function of the KIND, which
 *  is the fact that actually determines what shapes are legitimate. A
 *  rent roll is a spreadsheet. An insurance binder is a PDF. Both
 *  statements are narrow, and neither one loosens the other.
 *
 *  DEFAULT IS TODAY'S RENT-ROLL LIST, so every existing caller — all of
 *  Deal Setup — is byte-identical without passing anything new.
 */
const RENT_ROLL_SHAPES = Object.freeze(["csv", "tsv", "txt", "xlsx", "xlsm", "xls"]);
//  `other` is deliberately generic. It preserves every shape the historical
//  fallback accepted and additionally permits opaque PDF retention. A domain
//  adapter may later propose what the bytes appear to be; storage does not.
const OTHER_SHAPES = Object.freeze([...RENT_ROLL_SHAPES, "pdf"]);

const KIND_SHAPES = Object.freeze({
  rent_roll:                     RENT_ROLL_SHAPES,
  other:                         OTHER_SHAPES,
  //  A policy and a binder are issued as PDFs. Narrow on purpose: adding
  //  a kind here is a deliberate act, not a side effect of some other
  //  workflow needing a file.
  insurance_policy:              Object.freeze(["pdf"]),
  insurance_binder:              Object.freeze(["pdf"]),
  //  Funding evidence. A finance agreement is issued as a PDF; an escrow
  //  statement arrives as a PDF from the servicer or, often enough, as a
  //  spreadsheet export — so that one accepts both rather than forcing
  //  someone to print an export back into a PDF to satisfy us.
  insurance_finance_agreement:   Object.freeze(["pdf"]),
  insurance_escrow_statement:    Object.freeze(["pdf", "xlsx", "xls", "csv"]),
  //  ── TAX EVIDENCE ─────────────────────────────────────────────────
  //  The City issues bills, returns, receipts and certificates as PDFs.
  //  Its account and balance views EXPORT as spreadsheets, and so do
  //  servicer escrow statements — refusing those would send someone to
  //  print a CSV back into a PDF to satisfy our list, which is our
  //  machinery leaking into their day.
  tax_bill:                      Object.freeze(["pdf"]),
  tax_return:                    Object.freeze(["pdf"]),
  tax_payment_receipt:           Object.freeze(["pdf"]),
  tax_clearance_certificate:     Object.freeze(["pdf"]),
  tax_appeal_document:           Object.freeze(["pdf"]),
  tax_balance_statement:         Object.freeze(["pdf", "xlsx", "xls", "csv"]),
  tax_account_statement:         Object.freeze(["pdf", "xlsx", "xls", "csv"]),
  tax_escrow_statement:          Object.freeze(["pdf", "xlsx", "xls", "csv"]),
  tax_escrow_analysis:           Object.freeze(["pdf", "xlsx", "xls", "csv"]),
  //  Utility evidence stays on the shared retained-source rail. Provider
  //  statements and agreements are issued as PDFs; meter schedules and
  //  account confirmations are also commonly exported as spreadsheets.
  utility_statement:             Object.freeze(["pdf"]),
  utility_service_agreement:     Object.freeze(["pdf"]),
  utility_addendum:              Object.freeze(["pdf"]),
  utility_meter_schedule:        Object.freeze(["pdf", "xlsx", "xls", "csv"]),
  utility_account_confirmation:  Object.freeze(["pdf", "xlsx", "xls", "csv"]),
});

//  Per-kind refusal copy. §5 and the repo's rule that a refusal a user
//  can see is PRODUCT COPY — it must be sayable, and must name the next
//  step. Telling someone holding an insurance binder to "export the rent
//  roll sheet" is our machinery leaking into their day.
const KIND_REFUSAL = Object.freeze({
  rent_roll: (filename) =>
    `Spine reads rent rolls as .xlsx, .xls, .csv or .tsv. "${filename}" is none of those. ` +
    `If it is a PDF, export or save it as a spreadsheet first.`,
  other: (filename) =>
    `Spine retains a generic source as a PDF, spreadsheet or text file. ` +
    `"${filename}" is none of those. Upload the source in its original format.`,
  insurance_policy: (filename) =>
    `Spine reads an insurance policy as a PDF. "${filename}" is not one. ` +
    `Upload the policy document your broker or carrier issued.`,
  insurance_binder: (filename) =>
    `Spine reads an insurance binder as a PDF. "${filename}" is not one. ` +
    `Upload the binder your broker issued.`,
  insurance_finance_agreement: (filename) =>
    `Spine reads a premium finance agreement as a PDF. "${filename}" is not one. ` +
    `Upload the agreement the finance company issued.`,
  insurance_escrow_statement: (filename) =>
    `Spine reads an escrow statement as a PDF or a spreadsheet. "${filename}" is neither. ` +
    `Upload the statement from the lender or servicer.`,
  tax_bill: (filename) =>
    `Spine reads a tax bill as a PDF. "${filename}" is not one. ` +
    `Upload the bill or notice the City issued.`,
  tax_return: (filename) =>
    `Spine reads a filed return as a PDF. "${filename}" is not one. ` +
    `Upload the return as filed, or its confirmation.`,
  tax_payment_receipt: (filename) =>
    `Spine reads a payment receipt as a PDF. "${filename}" is not one. ` +
    `Upload the City's receipt or payment confirmation.`,
  tax_clearance_certificate: (filename) =>
    `Spine reads a tax clearance certificate as a PDF. "${filename}" is not one. ` +
    `Upload the certificate the City issued.`,
  tax_appeal_document: (filename) =>
    `Spine reads an appeal document as a PDF. "${filename}" is not one. ` +
    `Upload the filing or the board's decision.`,
  tax_balance_statement: (filename) =>
    `Spine reads a balance statement as a PDF or a spreadsheet. "${filename}" is neither. ` +
    `Upload the statement or the export from the City's account view.`,
  tax_account_statement: (filename) =>
    `Spine reads an account statement as a PDF or a spreadsheet. "${filename}" is neither. ` +
    `Upload the statement or the export from the City's account view.`,
  tax_escrow_statement: (filename) =>
    `Spine reads an escrow statement as a PDF or a spreadsheet. "${filename}" is neither. ` +
    `Upload the statement from the lender or servicer.`,
  tax_escrow_analysis: (filename) =>
    `Spine reads an escrow analysis as a PDF or a spreadsheet. "${filename}" is neither. ` +
    `Upload the analysis the servicer sent.`,
  utility_statement: (filename) =>
    `Spine reads a Utility statement as a PDF. "${filename}" is not one. ` +
    `Upload the statement the provider issued.`,
  utility_service_agreement: (filename) =>
    `Spine reads a Utility service agreement as a PDF. "${filename}" is not one. ` +
    `Upload the agreement the provider issued.`,
  utility_addendum: (filename) =>
    `Spine reads a Utility addendum as a PDF. "${filename}" is not one. ` +
    `Upload the signed addendum.`,
  utility_meter_schedule: (filename) =>
    `Spine reads a Utility meter schedule as a PDF or a spreadsheet. "${filename}" is neither. ` +
    `Upload the schedule or export that identifies the meters.`,
  utility_account_confirmation: (filename) =>
    `Spine reads a Utility account confirmation as a PDF or a spreadsheet. "${filename}" is neither. ` +
    `Upload the provider confirmation or account export.`,
});

function shapesFor(artifact_kind) {
  return KIND_SHAPES[artifact_kind] || RENT_ROLL_SHAPES;
}

function refusal(reason, receipt, extra = {}) {
  const e = new Error(receipt);
  e.artifactRefusal = true;
  e.reason = reason;
  e.receipt = receipt;
  Object.assign(e, extra);
  return e;
}

function extensionOf(filename) {
  const m = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

/*  Is this decodable as text, and does it look like delimited data?
 *  Deliberately permissive about CONTENT and strict about ENCODING: a rent
 *  roll exported from anything is still text with separators, but a binary
 *  blob renamed .csv is not. A NUL byte in the first block is the reliable
 *  tell — real delimited text never contains one. */
function looksTextual(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0x00)) return false;
  const s = head.toString("utf8");
  return !s.includes("�");
}

/*  ── validateUpload ────────────────────────────────────────────────
 *  Everything that can be judged from the bytes alone, judged BEFORE any
 *  row is written. Returns {ok:true, kind, sha256, byte_size} or throws a
 *  refusal whose receipt is sayable to the person who chose the file. */
function validateUpload({ filename, mimetype, buffer, artifact_kind = "rent_roll" } = {}) {
  const shapes = shapesFor(artifact_kind);
  const isRentRoll = shapes === RENT_ROLL_SHAPES;

  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw refusal("empty_file", isRentRoll
      ? "That file is empty. Choose the rent roll you exported."
      : "That file is empty. Choose the document you meant to upload.");
  }
  if (buffer.length > MAX_BYTES) {
    throw refusal("file_too_large",
      `That file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB — ` +
      (isRentRoll
        ? `export just the rent roll sheet rather than the whole workbook.`
        : `upload the document on its own rather than a combined file.`));
  }

  const ext = extensionOf(filename);
  if (!shapes.includes(ext)) {
    const say = KIND_REFUSAL[artifact_kind] || KIND_REFUSAL.rent_roll;
    throw refusal("unsupported_file_type", say(filename));
  }

  const sig = SIGNATURES.find((s) => startsWith(buffer, s.bytes));

  if (BINARY_EXT.has(ext)) {
    if (!sig) {
      throw refusal("content_does_not_match_extension", ext === "pdf"
        ? `"${filename}" is named like a PDF but its contents are not one. ` +
          `Re-export it from the program that produced it.`
        : `"${filename}" is named like a spreadsheet but its contents are not one. ` +
          `Re-export it from the program that produced it.`);
    }
    //  A .pdf holding a workbook, or a .xlsx holding a PDF.
    //
    //  ⚠ SCOPED TO PDF DELIBERATELY. Within the spreadsheet family the
    //  original leniency is PRESERVED: a .xls carrying xlsx bytes has
    //  always passed here and is an ordinary, legitimate file — Excel
    //  produces them. Tightening that would be a rent-roll regression
    //  smuggled in by an insurance change, and rent-roll behaviour is
    //  supposed to be untouched by this.
    const pdfInvolved = ext === "pdf" || sig.kind === "pdf";
    if (pdfInvolved && sig.kind !== ext) {
      throw refusal("content_does_not_match_extension",
        `"${filename}" is named .${ext} but its contents are a ${sig.kind} file. ` +
        `Renaming a file does not convert it.`);
    }
  } else {
    //  A .csv that is really a workbook is the common real mistake: the
    //  file was renamed rather than re-exported. Name it precisely.
    if (sig) {
      throw refusal("content_does_not_match_extension",
        `"${filename}" is named .${ext} but its contents are a ${sig.kind}` +
        `${sig.kind === "pdf" ? "" : " spreadsheet"}. ` +
        `Renaming a file does not convert it — export it as ${ext.toUpperCase()} instead.`);
    }
    if (!looksTextual(buffer)) {
      throw refusal("content_does_not_match_extension",
        `"${filename}" is named .${ext} but does not contain readable text.`);
    }
  }

  return {
    ok: true,
    kind: sig ? sig.kind : ext,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    byte_size: buffer.length,
    mime_type: mimetype || null,
  };
}

/*  ── store ─────────────────────────────────────────────────────────
 *  Writes the artifact. Takes a `db` that may be a pool OR the caller's
 *  client: an artifact and whatever cites it should be able to commit
 *  together when the caller wants that, which is the same reason the photo
 *  service takes a client.
 *
 *  RE-UPLOAD IS NOT AN ERROR. The same bytes into the same scope return
 *  the artifact that already exists rather than storing a second copy.
 *  That is what stops a retry — or an impatient double-click — from
 *  silently doubling the evidence under a position. */
async function store(db, {
  scope_type, scope_id, filename, mimetype, buffer,
  uploaded_by_user_id, authority_basis, source_as_of_date = null,
  artifact_kind = "rent_roll",
} = {}) {
  if (!["deal", "property"].includes(scope_type)) {
    throw refusal("invalid_scope", "An artifact must be about a deal or a property.");
  }
  if (!scope_id) throw refusal("invalid_scope", "An artifact must name what it is about.");
  if (!uploaded_by_user_id) {
    throw refusal("no_authenticated_uploader",
      "Storing a source file requires a signed-in operator. A shared key is not an uploader.");
  }

  //  The kind decides which shapes are legitimate, so it must reach the
  //  validator. Defaults to rent_roll inside validateUpload, so callers
  //  that never passed it behave exactly as before.
  const v = validateUpload({ filename, mimetype, buffer, artifact_kind });

  //  ⚠ THE STORED KIND COMES BACK, AND CALLERS MUST REPORT IT.
  //  Dedup is by (scope, sha256) and says nothing about kind, so the same
  //  bytes offered a second time under a different kind resolve to the
  //  EXISTING row with its ORIGINAL kind. A caller echoing the requested
  //  kind would then tell someone their escrow statement is on file as an
  //  escrow statement when Spine holds it as a tax bill — a small lie, in
  //  the one place the product is supposed to be exact about provenance.
  const existing = (await db.query(
    `select id, original_filename, artifact_kind, byte_size, sha256, uploaded_at
       from source_artifacts
      where scope_type = $1 and scope_id = $2 and sha256 = $3
      limit 1`,
    [scope_type, scope_id, v.sha256])).rows[0];
  if (existing) {
    const mismatched = existing.artifact_kind !== artifact_kind;
    return { ...existing, deduplicated: true, requested_artifact_kind: artifact_kind,
      kind_differs: mismatched,
      receipt: mismatched
        ? `That is the same file already on record (${existing.original_filename}), held as ` +
          `${existing.artifact_kind.replace(/_/g, " ")}. It stays on file as that — upload ` +
          `the other document if this was meant to be a different one.`
        : `That is the same file already on record (${existing.original_filename}).` };
  }

  const row = (await db.query(
    `insert into source_artifacts
       (scope_type, scope_id, original_filename, mime_type, artifact_kind,
        byte_size, sha256, content, stored_at,
        source_as_of_date, uploaded_by_user_id, uploaded_by_basis)
     values ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11)
     returning id, original_filename, artifact_kind, byte_size, sha256,
               uploaded_at, source_as_of_date`,
    [scope_type, scope_id, String(filename), v.mime_type, artifact_kind,
     v.byte_size, v.sha256, buffer, source_as_of_date,
     uploaded_by_user_id, authority_basis || "unstated"])).rows[0];

  return { ...row, deduplicated: false };
}

/*  ── read ──────────────────────────────────────────────────────────
 *  The bytes back, exactly as they arrived. The ONLY reader of `content`.
 *  Scope is checked by the caller, not here: this service knows what a
 *  file is, not who may see it. */
async function read(db, artifactId) {
  const row = (await db.query(
    `select id, scope_type, scope_id, original_filename, mime_type,
            byte_size, sha256, content, uploaded_at, source_as_of_date
       from source_artifacts where id = $1`, [artifactId])).rows[0];
  return row || null;
}

/*  Metadata only — every read that is not literally serving the file. */
async function describe(db, artifactId) {
  const row = (await db.query(
    `select id, scope_type, scope_id, original_filename, mime_type, artifact_kind,
            byte_size, sha256, uploaded_at, source_as_of_date, uploaded_by_user_id
       from source_artifacts where id = $1`, [artifactId])).rows[0];
  return row || null;
}

module.exports = { validateUpload, store, read, describe, MAX_BYTES, refusal };
