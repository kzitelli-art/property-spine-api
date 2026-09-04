"use strict";

const crypto = require("crypto");

function normaliseHeader(value) {
  return String(value || "").trim();
}

function decodeSigningKey(base64Key) {
  const raw = String(base64Key || "").trim();
  if (!raw) {
    const e = new Error("READ_AI_WEBHOOK_SIGNING_KEY is not configured.");
    e.code = "read_ai_signing_key_missing";
    throw e;
  }
  const key = Buffer.from(raw, "base64");
  if (!key.length) {
    const e = new Error("READ_AI_WEBHOOK_SIGNING_KEY did not decode to bytes.");
    e.code = "read_ai_signing_key_invalid";
    throw e;
  }
  return key;
}

function readAiDigestHex(rawBody, base64Key) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === "string" ? rawBody : "");
  return crypto.createHmac("sha256", decodeSigningKey(base64Key)).update(body).digest("hex");
}

function timingSafeHexEqual(left, right) {
  const a = normaliseHeader(left).toLowerCase();
  const b = normaliseHeader(right).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function verifyReadSignature({ rawBody, signatureHeader, signingKeyBase64 } = {}) {
  const supplied = normaliseHeader(signatureHeader);
  if (!supplied) return { ok: false, reason: "missing_signature" };
  const expected = readAiDigestHex(rawBody, signingKeyBase64);
  return {
    ok: timingSafeHexEqual(supplied, expected),
    reason: timingSafeHexEqual(supplied, expected) ? "verified" : "invalid_signature",
    expected,
  };
}

module.exports = {
  decodeSigningKey,
  normaliseHeader,
  readAiDigestHex,
  timingSafeHexEqual,
  verifyReadSignature,
};
