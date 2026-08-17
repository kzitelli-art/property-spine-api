"use strict";

function asPresentString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseVerifiedReadPayload(rawBody) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || ""));
    return { ok: true, payload: parsed };
  } catch (err) {
    return { ok: false, error: "malformed_json" };
  }
}

function readReadIdentity(payload) {
  const object = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return {
    request_id: asPresentString(object.request_id),
    session_id: asPresentString(object.session_id),
  };
}

function readProviderMetadata(payload) {
  const object = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const keys = Object.keys(object).sort();
  const metadata = {
    top_level_keys: keys,
    has_transcript: Object.prototype.hasOwnProperty.call(object, "transcript"),
    has_summary: Object.prototype.hasOwnProperty.call(object, "summary"),
    has_action_items: Object.prototype.hasOwnProperty.call(object, "action_items"),
    has_key_questions: Object.prototype.hasOwnProperty.call(object, "key_questions"),
    has_topics: Object.prototype.hasOwnProperty.call(object, "topics"),
    has_chapters: Object.prototype.hasOwnProperty.call(object, "chapters"),
  };

  return {
    provider_title: asPresentString(object.title) || asPresentString(object.meeting_title) || null,
    provider_started_at_text: asPresentString(object.started_at) || asPresentString(object.start_time) || null,
    provider_ended_at_text: asPresentString(object.ended_at) || asPresentString(object.end_time) || null,
    provider_event_trigger: asPresentString(object.trigger),
    metadata,
  };
}

module.exports = {
  parseVerifiedReadPayload,
  readProviderMetadata,
  readReadIdentity,
};
