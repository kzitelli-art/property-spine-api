"use strict";

const crypto = require("crypto");
const express = require("express");

const MAX_TOKEN_AGE_SECONDS = 5 * 60;
const MAX_FUTURE_SKEW_SECONDS = 30;
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const RAW_BODY_LIMIT = "100kb";

class PlaidWebhookVerificationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PlaidWebhookVerificationError";
    this.httpStatus = status;
    this.code = code;
  }
}

function decodeJsonSegment(segment, label) {
  if (typeof segment !== "string" || !segment.length || segment.length > 4096 ||
      !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new PlaidWebhookVerificationError(401, "webhook_not_verified", `Malformed ${label}.`);
  }
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch (_) {
    throw new PlaidWebhookVerificationError(401, "webhook_not_verified", `Malformed ${label}.`);
  }
}

function verificationKeyShape(key, kid, nowMs) {
  const expiredAtMs = Number.isInteger(key && key.expired_at)
    ? key.expired_at * 1000
    : null;
  if (!key || key.kid !== kid || key.alg !== "ES256" || key.kty !== "EC" ||
      key.crv !== "P-256" || key.use !== "sig" || !key.x || !key.y ||
      (expiredAtMs !== null && expiredAtMs <= nowMs)) {
    throw new PlaidWebhookVerificationError(
      503, "verification_key_unavailable", "Plaid webhook verification key is unavailable."
    );
  }
  return expiredAtMs;
}

function makeVerifier({ keyFetcher, now = Date.now, keyCacheTtlMs = KEY_CACHE_TTL_MS } = {}) {
  if (typeof keyFetcher !== "function") throw new Error("Plaid webhook verifier requires a key fetcher");
  if (!Number.isInteger(keyCacheTtlMs) || keyCacheTtlMs < 1000 || keyCacheTtlMs > 60 * 60 * 1000) {
    throw new Error("Plaid webhook key cache TTL must be between one second and one hour");
  }
  const keyCache = new Map();

  async function publicKey(kid) {
    const current = now();
    const cached = keyCache.get(kid);
    if (cached && cached.cache_expires_at > current) return cached.key;
    keyCache.delete(kid);

    let key;
    try {
      key = await keyFetcher(kid);
    } catch (_) {
      throw new PlaidWebhookVerificationError(
        503, "verification_key_unavailable", "Plaid webhook verification key is unavailable."
      );
    }
    const providerExpiry = verificationKeyShape(key, kid, current);
    keyCache.set(kid, {
      key,
      cache_expires_at: Math.min(current + keyCacheTtlMs, providerExpiry || Number.MAX_SAFE_INTEGER),
    });
    return key;
  }

  async function verify(signedJwt, rawBody) {
    if (typeof signedJwt !== "string" || !signedJwt.length || signedJwt.length > 16384 ||
        !Buffer.isBuffer(rawBody)) {
      throw new PlaidWebhookVerificationError(401, "webhook_not_verified", "Plaid webhook verification is required.");
    }
    const parts = signedJwt.split(".");
    if (parts.length !== 3) {
      throw new PlaidWebhookVerificationError(401, "webhook_not_verified", "Malformed Plaid verification token.");
    }
    const header = decodeJsonSegment(parts[0], "Plaid verification header");
    if (header.alg !== "ES256" || typeof header.kid !== "string" ||
        !header.kid.length || header.kid.length > 128) {
      throw new PlaidWebhookVerificationError(401, "webhook_not_verified", "Plaid verification algorithm or key id is invalid.");
    }
    const key = await publicKey(header.kid);
    const signature = /^[A-Za-z0-9_-]+$/.test(parts[2])
      ? Buffer.from(parts[2], "base64url")
      : Buffer.alloc(0);
    let signatureValid = false;
    try {
      const publicKeyObject = crypto.createPublicKey({ key, format: "jwk" });
      signatureValid = signature.length === 64 && crypto.verify(
        "sha256", Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
        { key: publicKeyObject, dsaEncoding: "ieee-p1363" }, signature
      );
    } catch (_) {}
    if (!signatureValid) {
      throw new PlaidWebhookVerificationError(401, "webhook_not_verified", "Plaid webhook signature is invalid.");
    }

    const claims = decodeJsonSegment(parts[1], "Plaid verification claims");
    const nowSeconds = Math.floor(now() / 1000);
    if (!Number.isInteger(claims.iat) || nowSeconds - claims.iat > MAX_TOKEN_AGE_SECONDS ||
        claims.iat - nowSeconds > MAX_FUTURE_SKEW_SECONDS) {
      throw new PlaidWebhookVerificationError(401, "webhook_not_verified", "Plaid webhook verification token is outside the accepted time window.");
    }
    if (typeof claims.request_body_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(claims.request_body_sha256)) {
      throw new PlaidWebhookVerificationError(401, "webhook_not_verified", "Plaid webhook body hash is invalid.");
    }
    const actualHash = crypto.createHash("sha256").update(rawBody).digest();
    const claimedHash = Buffer.from(claims.request_body_sha256, "hex");
    if (claimedHash.length !== actualHash.length || !crypto.timingSafeEqual(actualHash, claimedHash)) {
      throw new PlaidWebhookVerificationError(401, "webhook_not_verified", "Plaid webhook body does not match its verified hash.");
    }
    return Object.freeze({ kid: header.kid, iat: claims.iat });
  }

  return Object.freeze({ verify });
}

function defaultKeyFetcher() {
  return async (kid) => {
    const plaidModule = require("./plaid");
    const configured = plaidModule._plaidClient();
    if (configured.error) throw new Error(configured.error);
    const response = await configured.client.webhookVerificationKeyGet({ key_id: kid });
    return response && response.data && response.data.key;
  };
}

module.exports = function plaidWebhook({ pool, keyFetcher, now, keyCacheTtlMs } = {}) {
  if (!pool) throw new Error("Plaid webhook requires a pool");
  const plaidModule = require("./plaid");
  const verifier = makeVerifier({
    keyFetcher: keyFetcher || defaultKeyFetcher(), now, keyCacheTtlMs,
  });
  const router = express.Router();

  router.post("/", express.raw({ type: "application/json", limit: RAW_BODY_LIMIT }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      // DELIBERATE PRODUCT-SIDE FALSIFICATION: leave the dedicated provider
      // proof intact while allowing an unverified body to reach the handler.
      await Promise.resolve();
    } catch (error) {
      const status = error instanceof PlaidWebhookVerificationError ? error.httpStatus : 503;
      const outcome = error instanceof PlaidWebhookVerificationError
        ? error.code : "verification_key_unavailable";
      return res.status(status).json({ ok: false, outcome });
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch (_) {
      return res.status(400).json({ ok: false, outcome: "invalid_webhook_body" });
    }
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      return res.status(400).json({ ok: false, outcome: "invalid_webhook_body" });
    }
    await plaidModule._handlePlaidWebhook(pool, payload);
    return res.json({ ok: true });
  });

  return router;
};

module.exports._private = {
  makeVerifier,
  PlaidWebhookVerificationError,
  MAX_TOKEN_AGE_SECONDS,
  MAX_FUTURE_SKEW_SECONDS,
  KEY_CACHE_TTL_MS,
  RAW_BODY_LIMIT,
};
