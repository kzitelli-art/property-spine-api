"use strict";

const SOURCE_CLASSES = Object.freeze([
  "provider_transcript",
  "provider_metadata",
  "human_review",
  "manual_entry",
  "governed_domain_read",
]);

const EPISTEMIC_STATUSES = Object.freeze([
  "stated",
  "reported",
  "inferred",
  "unconfirmed",
  "disputed",
]);

const READ_STATUSES = Object.freeze([
  "ok",
  "partial",
  "degraded",
  "failed",
  "unavailable",
]);

const RESOLUTION_STATUSES = Object.freeze([
  "confirmed",
  "probable",
  "unresolved",
]);

function includes(list, value) {
  return list.includes(String(value || ""));
}

function assertKnown(kind, list, value) {
  if (!includes(list, value)) {
    const err = new Error(`unknown ${kind}: ${value}`);
    err.code = `unknown_${kind}`;
    throw err;
  }
  return value;
}

module.exports = {
  SOURCE_CLASSES,
  EPISTEMIC_STATUSES,
  READ_STATUSES,
  RESOLUTION_STATUSES,
  assertSourceClass(value) {
    return assertKnown("source_class", SOURCE_CLASSES, value);
  },
  assertEpistemicStatus(value) {
    return assertKnown("epistemic_status", EPISTEMIC_STATUSES, value);
  },
  assertReadStatus(value) {
    return assertKnown("read_status", READ_STATUSES, value);
  },
  assertResolutionStatus(value) {
    return assertKnown("resolution_status", RESOLUTION_STATUSES, value);
  },
};
