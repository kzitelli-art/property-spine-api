"use strict";

function presentString(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function timestampMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value) {
  const millis = timestampMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function elapsedLabel(blockMillis, baseMillis) {
  const seconds = Math.max(0, Math.floor((blockMillis - baseMillis) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function readReadTranscript(payload) {
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const transcript = root.transcript && typeof root.transcript === "object" && !Array.isArray(root.transcript)
    ? root.transcript
    : null;
  const blocks = transcript && Array.isArray(transcript.speaker_blocks)
    ? transcript.speaker_blocks
    : null;
  if (!blocks || !blocks.length) {
    return { ok: false, code: "read_transcript_missing", message: "Read AI payload has no transcript speaker_blocks" };
  }

  const parsed = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] && typeof blocks[index] === "object" ? blocks[index] : {};
    const speaker = presentString(block.speaker && block.speaker.name);
    const words = presentString(block.words);
    const startMillis = timestampMillis(block.start_time);
    if (!speaker || !words || startMillis === null) {
      return {
        ok: false,
        code: "read_transcript_block_invalid",
        message: "Every Read AI transcript block requires speaker.name, words, and start_time",
        block_ordinal: index + 1,
      };
    }
    parsed.push({ speaker, words, startMillis });
  }

  const providerStartMillis = timestampMillis(root.start_time);
  const baseMillis = providerStartMillis === null ? parsed[0].startMillis : providerStartMillis;
  const transcriptText = parsed.map((block) =>
    `${elapsedLabel(block.startMillis, baseMillis)} - ${block.speaker}\n${block.words}`
  ).join("\n\n");

  return {
    ok: true,
    transcript_text: transcriptText,
    meeting_occurred_at: isoTimestamp(root.start_time) || new Date(parsed[0].startMillis).toISOString(),
    occurred_at_source: "provider_recorded",
    source_kind: "read_ai_webhook_transcript",
    segment_count: parsed.length,
  };
}

module.exports = {
  elapsedLabel,
  readReadTranscript,
  timestampMillis,
};
