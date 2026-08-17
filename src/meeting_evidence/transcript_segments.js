"use strict";

const crypto = require("crypto");

function normalizeText(s) {
  return String(s || "")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceDigest(raw) {
  return crypto.createHash("sha256").update(Buffer.from(String(raw || ""), "utf8")).digest("hex");
}

function parseProviderTranscript(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const header = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(.+?)\s*$/;
  const segments = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(header);
    if (match) {
      if (current) segments.push(current);
      current = {
        ordinal: segments.length + 1,
        provider_timestamp: match[1],
        speaker_label: match[2],
        text: "",
      };
    } else if (current && line.trim()) {
      current.text += (current.text ? " " : "") + line.trim();
    }
  }
  if (current) segments.push(current);

  return segments.map((segment, index) => ({
    ...segment,
    ordinal: index + 1,
    normalized_text: normalizeText(segment.text),
  }));
}

function buildTranscriptVersionPayload(raw, { sourceKind = "provider_transcript" } = {}) {
  const source = String(raw || "");
  return {
    source_digest: sourceDigest(source),
    source_kind: sourceKind,
    segments: parseProviderTranscript(source),
  };
}

module.exports = {
  buildTranscriptVersionPayload,
  normalizeText,
  parseProviderTranscript,
  sourceDigest,
};
