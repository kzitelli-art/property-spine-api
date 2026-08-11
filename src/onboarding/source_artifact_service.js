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
]);

const TEXTUAL_EXT = new Set(["csv", "tsv", "txt"]);
const BINARY_EXT  = new Set(["xlsx", "xlsm", "xls"]);

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
function validateUpload({ filename, mimetype, buffer } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw refusal("empty_file", "That file is empty. Choose the rent roll you exported.");
  }
  if (buffer.length > MAX_BYTES) {
    throw refusal("file_too_large",
      `That file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB — ` +
      `export just the rent roll sheet rather than the whole workbook.`);
  }

  const ext = extensionOf(filename);
  if (!TEXTUAL_EXT.has(ext) && !BINARY_EXT.has(ext)) {
    throw refusal("unsupported_file_type",
      `Spine reads rent rolls as .xlsx, .xls, .csv or .tsv. "${filename}" is none of those. ` +
      `If it is a PDF, export or save it as a spreadsheet first.`);
  }

  const sig = SIGNATURES.find((s) => startsWith(buffer, s.bytes));

  if (BINARY_EXT.has(ext)) {
    if (!sig) {
      throw refusal("content_does_not_match_extension",
        `"${filename}" is named like a spreadsheet but its contents are not one. ` +
        `Re-export it from the program that produced it.`);
    }
  } else {
    //  A .csv that is really a workbook is the common real mistake: the
    //  file was renamed rather than re-exported. Name it precisely.
    if (sig) {
      throw refusal("content_does_not_match_extension",
        `"${filename}" is named .${ext} but its contents are a ${sig.kind} spreadsheet. ` +
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

  const v = validateUpload({ filename, mimetype, buffer });

  const existing = (await db.query(
    `select id, original_filename, byte_size, sha256, uploaded_at
       from source_artifacts
      where scope_type = $1 and scope_id = $2 and sha256 = $3
      limit 1`,
    [scope_type, scope_id, v.sha256])).rows[0];
  if (existing) {
    return { ...existing, deduplicated: true,
      receipt: `That is the same file already on record (${existing.original_filename}).` };
  }

  const row = (await db.query(
    `insert into source_artifacts
       (scope_type, scope_id, original_filename, mime_type, artifact_kind,
        byte_size, sha256, content, stored_at,
        source_as_of_date, uploaded_by_user_id, uploaded_by_basis)
     values ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11)
     returning id, original_filename, byte_size, sha256, uploaded_at, source_as_of_date`,
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
