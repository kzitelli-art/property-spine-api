// ════════════════════════════════════════════════════════════════════
//  work_proof_attachment_service.js — ONE COMPLETION PHOTO
//
//  The canonical service for the only attachment this product has: the photo a
//  technician takes when they finish a required-work item.
//
//  ── IT IS NOT AN ATTACHMENT PLATFORM ────────────────────────────────
//  No list, no browse, no delete, no rename, no folder, no caption. Three
//  operations exist because the completion flow needs exactly three:
//
//      validateUpload   is this file acceptable, before anything is written
//      storeForWork     write the bytes, bound to one work item
//      resolveForWork   which of these references actually prove THIS work
//
//  ── THE SEAM AND THE ADAPTER ────────────────────────────────────────
//  The CONTRACT is a Class 1 permanent primitive: an opaque id that names one
//  photo of one work item by one uploader. The STORAGE is a Class 2 adapter —
//  `content bytea` in Postgres for the pilot. Swapping the adapter changes
//  where bytes sit and nothing else: the ids, the authority rules and the
//  completion API are unaffected.
//
//  ── WHY IT WRITES INSIDE THE CALLER'S TRANSACTION ───────────────────
//  `storeForWork` takes the caller's `client`, never a pool. The attachment
//  and the completion claim must commit together or not at all. A photo that
//  survives a failed completion is an orphan nobody will ever look at; a
//  completion that survives a failed photo is a closed job with no evidence.
//  Both are prevented by there being one transaction, not by cleanup.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");

//  ── FILE RULES ────────────────────────────────────────────────────
//  Deliberately narrow. This accepts a photo from a phone, and nothing else.
const ALLOWED_MIME = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

//  A filename is a claim, not a fact. These are the leading bytes each format
//  actually starts with, so `screenshot.jpg` containing a PDF is refused.
const MAGIC = [
  { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  {
    mime: "image/webp",
    test: (b) => b.length > 12 && b.slice(0, 4).toString("ascii") === "RIFF" &&
                 b.slice(8, 12).toString("ascii") === "WEBP",
  },
];

function sniff(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const hit = MAGIC.find((m) => { try { return m.test(buffer); } catch (_) { return false; } });
  return hit ? hit.mime : null;
}

/**
 * validateUpload — PURE. Decide before anything is written.
 * Returns { ok: true, mime_type, byte_size, sha256 } or { ok: false, reason }.
 *
 * The reasons are operator-readable on purpose: a technician standing in a
 * unit needs to know what to do differently, not that validation failed.
 */
function validateUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    return { ok: false, reason: "No photo was received. Add one completion photo to close this work." };
  }
  const size = file.buffer.length;
  if (size === 0) {
    return { ok: false, reason: "That photo is empty. Take or choose the photo again." };
  }
  if (size > MAX_BYTES) {
    return {
      ok: false,
      reason: `That photo is ${(size / (1024 * 1024)).toFixed(1)} MB. Keep it under 5 MB.`,
    };
  }

  //  THE BYTES DECIDE, NOT THE NAME OR THE HEADER. A browser-supplied
  //  Content-Type and a `.jpg` suffix are both attacker-controlled and both
  //  routinely wrong even without an attacker.
  const actual = sniff(file.buffer);
  if (!actual) {
    return { ok: false, reason: "That file is not a JPEG, PNG or WebP photo." };
  }
  if (!ALLOWED_MIME.includes(actual)) {
    return { ok: false, reason: "That file is not a JPEG, PNG or WebP photo." };
  }

  return {
    ok: true,
    mime_type: actual,
    byte_size: size,
    sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
    //  Reported so a caller can see the claim was ignored rather than trusted.
    declared_mime: file.mimetype || null,
    declared_mime_trusted: false,
  };
}

function makeWorkProofAttachmentService() {
  const bad = (m, extra) => Object.assign(new Error(m), { httpStatus: 400, ...(extra || {}) });

  /**
   * storeForWork — writes ONE attachment inside the caller's transaction.
   *
   * `property_id` and `unit_id` come from the WORK ROW the caller already
   * loaded and authorised, never from a request. A client cannot name the
   * property an attachment belongs to.
   */
  async function storeForWork(client, spec) {
    const { work_id, property_id, unit_id, uploaded_by_user_id, file } = spec || {};
    if (!work_id || !property_id || !unit_id) throw bad("work, property and unit are all required");
    if (!uploaded_by_user_id) throw bad("an attachment needs an uploader — proof is attributed");

    const v = validateUpload(file);
    if (!v.ok) throw bad(v.reason);

    const row = (await client.query(
      `insert into work_proof_attachments
         (property_id, unit_id, work_id, uploaded_by_user_id,
          original_filename, mime_type, byte_size, sha256, content)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id, property_id, unit_id, work_id, uploaded_by_user_id,
                 original_filename, mime_type, byte_size, sha256, created_at`,
      [property_id, unit_id, work_id, uploaded_by_user_id,
       (file && file.originalname) || null, v.mime_type, v.byte_size, v.sha256, file.buffer])).rows[0];

    //  `content` is deliberately NOT in the returning list. Bytes leave this
    //  module through the governed read route and nowhere else.
    return row;
  }

  /**
   * resolveForWork — WHICH OF THESE REFERENCES ACTUALLY PROVE *THIS* WORK?
   *
   *  A reference counts only when it exists AND belongs to the same property
   *  AND the same unit AND the same work item. All four in one query, so a
   *  photo taken for one job can never close another — the earlier
   *  property-only contract left that ambiguity open.
   *
   *  Returns opaque ids. Anything unrecognised is simply absent from the
   *  result; it is never reported as verified.
   */
  async function resolveForWork(client, { property_id, unit_id, work_id, references }) {
    const refs = (Array.isArray(references) ? references : [])
      .filter(Boolean).map(String);
    if (!refs.length || !property_id || !unit_id || !work_id) return [];

    //  A malformed reference must not abort the query with a uuid cast error —
    //  a technician's bad input is a refusal, not a 500.
    const uuidish = refs.filter((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r));
    if (!uuidish.length) return [];

    const rows = (await client.query(
      `select id from work_proof_attachments
        where id = any($1::uuid[])
          and property_id = $2 and unit_id = $3 and work_id = $4`,
      [uuidish, property_id, unit_id, work_id])).rows;
    return rows.map((r) => String(r.id));
  }

  /**
   * readForWork — the governed read behind GET .../proof/:attachmentId.
   *
   *  Every scope is re-checked here. The route's authority check and this
   *  query are two independent refusals of the same wrong thing.
   */
  async function readForWork(db, { property_id, work_id, attachment_id }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(attachment_id || ""))) {
      return null;
    }
    const row = (await db.query(
      `select id, property_id, unit_id, work_id, mime_type, byte_size, content
         from work_proof_attachments
        where id=$1 and property_id=$2 and work_id=$3`,
      [attachment_id, property_id, work_id])).rows[0];
    return row || null;
  }

  /**
   * metadataForWork — safe metadata for the Unit Turn read.
   * NO BYTES. The page shows a preview by calling the governed route.
   */
  async function metadataForWork(db, { work_id }) {
    if (!work_id) return [];
    const rows = (await db.query(
      `select a.id, a.mime_type, a.byte_size, a.created_at,
              a.uploaded_by_user_id, u.name as uploaded_by_name
         from work_proof_attachments a
         left join users u on u.id = a.uploaded_by_user_id
        where a.work_id=$1
        order by a.created_at asc`, [work_id])).rows;
    return rows.map((r) => ({
      attachment_id: r.id,
      mime_type: r.mime_type,
      byte_size: r.byte_size,
      uploaded_at: r.created_at,
      uploaded_by: r.uploaded_by_name || null,
      //  A path, not a URL. No host, no signature, no credential.
      view_path: `/operator/turn-work/${work_id}/proof/${r.id}`,
    }));
  }

  return {
    storeForWork, resolveForWork, readForWork, metadataForWork, validateUpload,
    ALLOWED_MIME, MAX_BYTES,
  };
}

module.exports = {
  makeWorkProofAttachmentService, validateUpload, sniff,
  ALLOWED_MIME, MAX_BYTES,
};
