// ════════════════════════════════════════════════════════════════════
//  read_ai_webhook.js — THE SIGNED MEETING INGRESS
//
//  POST /integrations/read-ai/webhook
//
//  A meeting arrives from Read AI when the report is generated. This
//  endpoint's entire job is to decide whether the bytes are authentic and
//  then keep them, exactly. It interprets nothing.
//
//  ── RAW BYTES, OR THE SIGNATURE IS THEATRE ──────────────────────────
//
//  The HMAC is computed over the EXACT body Read sent. `express.json()`
//  parses and discards that body, and re-serialising to verify changes
//  key order, whitespace and unicode escaping. The signature then fails —
//  or, far worse, someone "fixes" it by verifying against their own
//  re-serialisation, which verifies that we can hash our own output.
//
//  So this router mounts `express.raw()` on its own path, and it is
//  mounted in server.js BEFORE the global JSON parser. If that ordering
//  is ever changed, this endpoint silently stops proving anything.
//
//  ── NOTHING UNVERIFIED IS STORED AS EVIDENCE ────────────────────────
//
//  Missing or bad signature refuses BEFORE any body is written. What
//  survives is a receipt — when, what hash, which connection, why — and
//  never the body itself. An endpoint that keeps whatever arrives is a
//  corpus anyone with the URL can poison.
//
//  ── CAPTURE FAST, INTERPRET LATER ───────────────────────────────────
//
//  Read retries a non-2xx delivery up to 25 times with backoff. A model
//  call inside this request is a processing storm waiting for a slow
//  afternoon. So the request does exactly: verify · dedupe · persist ·
//  200. Reading the transcript and running extraction happen against the
//  persisted delivery, afterwards, out of band.
//
//  ── IT ASSERTS NOTHING ABOUT A PROPERTY ─────────────────────────────
//
//  Read does not know Spine's property authority model. A delivery lands
//  UNBOUND. "Weekly SOLO Meeting" is a string, not authority to write
//  against Solo. Binding is a separate governed act by a signed-in human
//  with server-derived authority over the target property.
//
//  CLASS 1 — permanent.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");

//  Read's documented header. Kept as a constant because it is a contract
//  with a third party, and a typo here fails open-looking rather than loud.
const SIGNATURE_HEADER = "x-read-signature";
const REQUEST_ID_HEADER = "x-read-request-id";

//  A meeting transcript is text. 25 MB matches the retained-source cap and
//  exists so an unauthenticated caller cannot make us buffer arbitrarily.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/*  Timing-safe compare over the hex digests. `timingSafeEqual` throws on
 *  length mismatch, which is itself a leak of one bit, so lengths are
 *  equalised by hashing both sides to a fixed width first. */
function signaturesMatch(expectedHex, providedRaw) {
  const provided = String(providedRaw || "").trim().replace(/^sha256=/i, "");
  const a = crypto.createHash("sha256").update(expectedHex).digest();
  const b = crypto.createHash("sha256").update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = function readAiWebhook(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps || {};
  if (!pool) throw new Error("read_ai_webhook requires a pool");

  /*  The secret is read at call time from the environment, keyed by the
   *  connection's `signing_secret_ref`. The database never holds a
   *  secret; it holds the NAME of one, so rotation is visible in config
   *  rather than silent in a row.  */
  function secretFor(ref) {
    const key = "READ_AI_SIGNING_SECRET_" + String(ref || "").toUpperCase();
    return process.env[key] || null;
  }

  async function activeConnection(db) {
    const r = await db.query(
      `select id, signing_secret_ref, status
         from provider_connections
        where provider = 'read_ai' and status = 'active'
        order by authorized_at desc
        limit 1`);
    return r.rows[0] || null;
  }

  async function recordRefusal(db, { connection_id, reason, body }) {
    try {
      await db.query(
        `insert into provider_delivery_refusals
           (provider, connection_id, reason, body_sha256, byte_size)
         values ('read_ai', $1, $2, $3, $4)`,
        [connection_id || null, reason,
         body && body.length ? sha256Hex(body) : null,
         body ? body.length : null]);
    } catch (e) {
      //  A refusal we could not record is still a refusal. Never let
      //  bookkeeping turn a rejection into an acceptance.
      console.error("read-ai/webhook: refusal not recorded", e && e.message);
    }
  }

  //  ── THE RAW BODY MIDDLEWARE ───────────────────────────────────────
  //  Scoped to this route. `type: () => true` because the signature must
  //  be checked over the bytes whatever content-type is claimed — a
  //  caller does not get to bypass verification by lying about the type.
  const rawBody = express.raw({ type: () => true, limit: MAX_BODY_BYTES });

  router.post("/integrations/read-ai/webhook", rawBody, async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : null;

    if (!body || body.length === 0) {
      await recordRefusal(pool, { reason: "empty_body", body: null });
      return res.status(400).json({ error: "empty_body" });
    }

    let conn;
    try {
      conn = await activeConnection(pool);
    } catch (e) {
      //  A database failure is NOT a refusal — refusing here would tell
      //  Read the delivery was rejected and burn a retry on our outage.
      console.error("read-ai/webhook connection lookup failed", e && e.message);
      return res.status(503).json({ error: "unavailable" });
    }

    if (!conn) {
      await recordRefusal(pool, { reason: "unknown_connection", body });
      return res.status(401).json({ error: "no_active_connection" });
    }

    const secret = secretFor(conn.signing_secret_ref);
    if (!secret) {
      //  Configured connection, missing secret. Our fault, not theirs —
      //  and emphatically not something to accept unverified.
      console.error("read-ai/webhook: no secret for ref", conn.signing_secret_ref);
      return res.status(503).json({ error: "unavailable" });
    }

    const provided = req.headers[SIGNATURE_HEADER];
    if (!provided) {
      await recordRefusal(pool, { connection_id: conn.id, reason: "missing_signature", body });
      return res.status(401).json({ error: "missing_signature" });
    }

    //  THE VERIFICATION. Over `body` — the untouched bytes — and nothing
    //  derived from them.
    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    if (!signaturesMatch(expected, provided)) {
      await recordRefusal(pool, { connection_id: conn.id, reason: "bad_signature", body });
      return res.status(401).json({ error: "bad_signature" });
    }

    //  ── VERIFIED. Only now may the bytes be looked at. ───────────────
    //  Parsed solely to read the two identifiers. The parse result is NOT
    //  what gets stored — `raw_body` is.
    let parsed = null;
    try { parsed = JSON.parse(body.toString("utf8")); } catch (_) { parsed = null; }

    //  Read documents a per-request id and a per-meeting session id. The
    //  header is preferred because it is outside the signed payload's
    //  shape, which we have not yet observed; the body is the fallback.
    const requestId = String(req.headers[REQUEST_ID_HEADER]
      || (parsed && (parsed.request_id || parsed.requestId)) || "").trim();
    const sessionId = String((parsed && (parsed.session_id || parsed.sessionId)) || "").trim() || null;

    if (!requestId) {
      //  Authentic but unidentifiable. Refusing a VERIFIED delivery would
      //  discard real evidence, so it is stored under a deterministic id
      //  derived from its own bytes — a re-delivery of identical bytes
      //  still dedupes, and nothing is invented.
      console.warn("read-ai/webhook: verified delivery with no request id; keying on body hash");
    }
    const deliveryKey = requestId || ("sha256:" + sha256Hex(body));

    try {
      //  IDEMPOTENT BY (connection, request_id). A retry lands on the
      //  same row and returns 200, which is what stops Read's retry
      //  policy from multiplying evidence.
      const ins = await pool.query(
        `insert into provider_deliveries
           (connection_id, request_id, session_id, raw_body, raw_sha256,
            byte_size, signature_header)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (connection_id, request_id) do nothing
         returning id, received_at`,
        [conn.id, deliveryKey, sessionId, body, sha256Hex(body),
         body.length, String(provided).slice(0, 500)]);

      if (ins.rows.length === 0) {
        const existing = await pool.query(
          `select id, received_at from provider_deliveries
            where connection_id = $1 and request_id = $2`, [conn.id, deliveryKey]);
        return res.status(200).json({
          accepted: true, duplicate: true,
          delivery_id: existing.rows[0] && existing.rows[0].id,
        });
      }

      return res.status(202).json({
        accepted: true, duplicate: false,
        delivery_id: ins.rows[0].id,
      });
    } catch (e) {
      //  5xx so Read retries. The delivery is real and we want it.
      console.error("read-ai/webhook persist failed", e && e.message);
      return res.status(503).json({ error: "unavailable" });
    }
  });

  return router;
};

module.exports.SIGNATURE_HEADER = SIGNATURE_HEADER;
module.exports.REQUEST_ID_HEADER = REQUEST_ID_HEADER;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
