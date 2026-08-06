/* ════════════════════════════════════════════════════════════════════
   technician/evidence_service.js — THE canonical work-order evidence write.

   A photo arrives as a provider URL. That URL is not proof: it expires,
   it lives on someone else's infrastructure, and it can be revoked. So
   the row is created in `referenced` state — "a photo exists and we have
   NOT preserved it" — and only becomes `stored` when the bytes are ours,
   digested and sized.

   A fetch that fails leaves `fetch_failed`, which is a visible, honest
   state. It is never silently treated as stored, and it never counts as
   proof.

   ── WHAT THIS IS NOT ────────────────────────────────────────────────
   Not an attachment platform. Not a media library. It holds evidence for
   one work order and nothing else. Nothing inspects or scores the image.

   ── IT DOES NOT COMPLETE ANYTHING ───────────────────────────────────
   A photo is evidence. Whether it is SUFFICIENT evidence for completion
   is the completion service's decision, made against the work order — not
   something an attachment can assert about itself.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const crypto = require("crypto");

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

//  Content-Type minus parameters, lowercased — `image/jpeg; charset=binary`
//  and `IMAGE/JPEG` are the same media type.
function normalizeMime(v) {
  if (!v) return null;
  const t = String(v).split(";")[0].trim().toLowerCase();
  return t || null;
}
const MAX_BYTES = 5 * 1024 * 1024;
const STORAGE_STATES = ["referenced", "stored", "fetch_failed", "not_preserved"];
const PROOF_CLASSIFICATIONS = ["unclassified", "repair_photo", "access_attempt", "condition", "other"];

function evidenceError(code, message) {
  const e = new Error(message); e.code = code; return e;
}

/*  ingestProviderMedia — record it, then try to preserve it.
 *
 *  `fetchMedia` is injected: this module never opens a socket, so it can
 *  be proven without a network and cannot silently reach one. It returns
 *  { ok, buffer, mime } or { ok: false, reason }.
 *
 *  Idempotent on (provider, provider_media_id): a carrier redelivery of
 *  the same MMS cannot produce a second evidence row. Enforced by
 *  uq_wopa_provider_media as well as by the read below, so it does not
 *  depend on this function having looked first.
 */
async function ingestProviderMedia(client, {
  work_order_id, property_id, uploaded_by_user_id, source_comm_event_id = null,
  provider = null, provider_media_id = null, provider_media_url = null,
  mime_type, proof_classification = "unclassified",
} = {}, { fetchMedia = null } = {}) {
  if (!work_order_id || !property_id || !uploaded_by_user_id) {
    throw evidenceError("BAD_INPUT", "work_order_id, property_id and uploaded_by_user_id are required");
  }
  if (!ALLOWED_MIME.includes(mime_type)) {
    throw evidenceError("UNSUPPORTED_MEDIA", `mime_type ${JSON.stringify(mime_type)} is not accepted evidence`);
  }
  if (!PROOF_CLASSIFICATIONS.includes(proof_classification)) {
    throw evidenceError("BAD_INPUT", `unknown proof_classification ${JSON.stringify(proof_classification)}`);
  }

  if (provider && provider_media_id) {
    const dup = (await client.query(
      `select * from work_order_proof_attachments where provider = $1 and provider_media_id = $2`,
      [provider, provider_media_id])).rows[0];
    if (dup) return { outcome: "replayed", attachment: dup };
  }

  //  REFERENCED FIRST. The row exists before any fetch, so a fetch that
  //  hangs or dies still leaves a record that a photo was sent.
  let row = (await client.query(
    `insert into work_order_proof_attachments
       (work_order_id, property_id, uploaded_by_user_id, source_comm_event_id,
        provider, provider_media_id, provider_media_url, mime_type,
        storage_state, proof_classification)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'referenced',$9) returning *`,
    [work_order_id, property_id, uploaded_by_user_id, source_comm_event_id,
     provider, provider_media_id, provider_media_url, mime_type, proof_classification])).rows[0];

  if (typeof fetchMedia !== "function" || !provider_media_url) {
    //  No way to preserve it. Say so rather than implying we have it.
    return { outcome: "referenced", attachment: row };
  }

  //  THE CAP IS PASSED IN, not duplicated. The transport must refuse
  //  before buffering; MAX_BYTES below stays as defense in depth, but a
  //  second hidden limit inside the transport would drift from the one
  //  this boundary — and the database — actually enforce.
  let got;
  try { got = await fetchMedia({ url: provider_media_url, mime_type, max_bytes: MAX_BYTES }); }
  catch (e) { got = { ok: false, reason: `fetch_threw: ${e.message}` }; }

  if (!got || !got.ok || !Buffer.isBuffer(got.buffer) || got.buffer.length === 0) {
    row = (await client.query(
      `update work_order_proof_attachments set storage_state = 'fetch_failed' where id = $1 returning *`,
      [row.id])).rows[0];
    return { outcome: "fetch_failed", attachment: row, reason: (got && got.reason) || "empty_response" };
  }
  if (got.buffer.length > MAX_BYTES) {
    row = (await client.query(
      `update work_order_proof_attachments set storage_state = 'fetch_failed' where id = $1 returning *`,
      [row.id])).rows[0];
    return { outcome: "fetch_failed", attachment: row, reason: "too_large" };
  }

  //  ── THE MIME THE ORIGIN ACTUALLY SERVED ──────────────────────────
  //  `got.mime` used to be ignored entirely, so the stored mime_type was
  //  the CARRIER'S CLAIM from the webhook and nothing had ever checked
  //  it against the bytes. The transport verifies it too; this is the
  //  boundary re-checking rather than trusting, because these are two
  //  different modules and only one of them writes the row.
  //
  //  Deliberately NOT content inspection. No sniffing, no classification,
  //  no scoring — this compares two declared media types and stops.
  const verifiedMime = normalizeMime(got.mime);
  if (!verifiedMime || !ALLOWED_MIME.includes(verifiedMime)) {
    row = (await client.query(
      `update work_order_proof_attachments set storage_state = 'fetch_failed' where id = $1 returning *`,
      [row.id])).rows[0];
    return { outcome: "fetch_failed", attachment: row, reason: "unsupported_mime" };
  }
  if (verifiedMime !== normalizeMime(mime_type)) {
    row = (await client.query(
      `update work_order_proof_attachments set storage_state = 'fetch_failed' where id = $1 returning *`,
      [row.id])).rows[0];
    return { outcome: "fetch_failed", attachment: row, reason: "mime_mismatch" };
  }

  //  STORED means all four facts arrive together — the constraint refuses
  //  the row otherwise, so a partial store is not a state that can exist.
  //  mime_type is rewritten to the VERIFIED value. Where the two agree
  //  this changes nothing; where they would not, the row above has
  //  already refused. What is stored is what was served.
  row = (await client.query(
    `update work_order_proof_attachments
        set storage_state = 'stored', content = $2, byte_size = $3,
            sha256 = $4, stored_at = now(), mime_type = $5
      where id = $1 returning *`,
    [row.id, got.buffer, got.buffer.length,
     crypto.createHash("sha256").update(got.buffer).digest("hex"),
     verifiedMime])).rows[0];

  return { outcome: "stored", attachment: row };
}

/*  What evidence does this work order actually HAVE? Only `stored` rows
 *  count — a referenced or failed row is a photo we cannot produce. */
async function preservedEvidenceFor(client, { work_order_id, classifications = null }) {
  const { rows } = await client.query(
    `select id, proof_classification, mime_type, byte_size, sha256, received_at, stored_at
       from work_order_proof_attachments
      where work_order_id = $1 and storage_state = 'stored'
        and ($2::text[] is null or proof_classification = any($2::text[]))
      order by received_at asc`,
    [work_order_id, classifications]);
  return rows;
}

/*  Everything attached, in any state — so a receipt can say "you sent a
 *  photo but we could not save it" instead of "you sent no photo". */
async function allEvidenceFor(client, { work_order_id }) {
  const { rows } = await client.query(
    `select id, storage_state, proof_classification, received_at
       from work_order_proof_attachments where work_order_id = $1 order by received_at asc`,
    [work_order_id]);
  return rows;
}

module.exports = {
  ALLOWED_MIME, MAX_BYTES, STORAGE_STATES, PROOF_CLASSIFICATIONS,
  ingestProviderMedia, preservedEvidenceFor, allEvidenceFor, evidenceError,
};
