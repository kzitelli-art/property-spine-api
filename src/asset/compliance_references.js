"use strict";

const crypto = require("crypto");

class ComplianceReferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ComplianceReferenceError";
    this.code = code;
  }
}

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function keyBytes(secret) {
  if (Buffer.isBuffer(secret)) {
    if (secret.length !== 32) throw new TypeError("Compliance reference key must be 32 bytes");
    return Buffer.from(secret);
  }
  if (typeof secret === "string" && secret.length > 0) {
    return crypto.createHash("sha256").update(secret, "utf8").digest();
  }
  return crypto.randomBytes(32);
}

function createComplianceReferenceService({ secret, ttlSeconds = 300, now = Date.now } = {}) {
  const key = keyBytes(secret);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("Compliance reference ttlSeconds must be a positive integer");
  }
  if (typeof now !== "function") throw new TypeError("Compliance reference now must be a function");

  async function mintReference(subject = {}) {
    const role = required(subject.role, "reference role");
    if (role !== "canonical_record" && role !== "source_artifact") {
      throw new TypeError("Compliance reference role is not supported");
    }
    const claims = {
      version: 1,
      role,
      property_id: required(subject.property_id, "reference property_id"),
      resource_id: required(
        role === "canonical_record" ? subject.item_id : subject.artifact_id,
        "reference resource id"
      ),
      expires_at: Math.floor(now() / 1000) + ttlSeconds,
    };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(claims), "utf8"), cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"),
      tag.toString("base64url")].join(".");
  }

  function openReference(token) {
    try {
      const parts = required(token, "reference token").split(".");
      if (parts.length !== 4 || parts[0] !== "v1") throw new Error("bad token shape");
      const iv = Buffer.from(parts[1], "base64url");
      const ciphertext = Buffer.from(parts[2], "base64url");
      const tag = Buffer.from(parts[3], "base64url");
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
        throw new Error("bad token bytes");
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const claims = JSON.parse(Buffer.concat([
        decipher.update(ciphertext), decipher.final(),
      ]).toString("utf8"));
      const expectedKeys = ["expires_at", "property_id", "resource_id", "role", "version"];
      if (Object.keys(claims).sort().join(",") !== expectedKeys.join(",") ||
          claims.version !== 1 ||
          !["canonical_record", "source_artifact"].includes(claims.role) ||
          typeof claims.property_id !== "string" || typeof claims.resource_id !== "string" ||
          !Number.isInteger(claims.expires_at) || claims.expires_at <= Math.floor(now() / 1000)) {
        throw new Error("invalid or expired claims");
      }
      return claims;
    } catch (_) {
      throw new ComplianceReferenceError(
        "REFERENCE_UNAVAILABLE", "This Compliance reference is invalid or no longer available."
      );
    }
  }

  return Object.freeze({ mintReference, openReference });
}

module.exports = { createComplianceReferenceService, ComplianceReferenceError };
