"use strict";

const TOOL_NAME = "submit_meeting_receipt_extraction";
const DEFAULT_MODEL = "claude-sonnet-4-6";

function adapterError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = 502;
  error.detail = detail;
  return error;
}

function createAnthropicMeetingReceiptExtractor({
  anthropic,
  model = process.env.MEETING_RECEIPT_MODEL || process.env.INGEST_MODEL || DEFAULT_MODEL,
  maxTokens = 16000,
} = {}) {
  if (!anthropic || !anthropic.messages || typeof anthropic.messages.create !== "function") {
    throw adapterError("meeting_receipt_model_unavailable", "Anthropic meeting receipt extractor is not configured");
  }

  const extractor = async function anthropicMeetingReceiptExtractor({ prompt, schema }) {
    let response;
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        system: "Return the extraction only through the required tool. Do not write prose before or after it.",
        messages: [{ role: "user", content: prompt }],
        tools: [{
          name: TOOL_NAME,
          description: "Submit the complete Meeting Receipt extraction for server validation.",
          input_schema: schema,
        }],
        tool_choice: { type: "tool", name: TOOL_NAME },
      });
    } catch (error) {
      if (error && error.code && String(error.code).startsWith("meeting_receipt_")) throw error;
      throw adapterError("meeting_receipt_model_request_failed", "Meeting receipt model request failed");
    }

    const blocks = Array.isArray(response && response.content) ? response.content : [];
    const prose = blocks.filter((block) => block && block.type === "text" && String(block.text || "").trim());
    const toolUses = blocks.filter((block) => block && block.type === "tool_use" && block.name === TOOL_NAME);
    const otherTools = blocks.filter((block) => block && block.type === "tool_use" && block.name !== TOOL_NAME);
    if (prose.length || otherTools.length || toolUses.length !== 1) {
      throw adapterError(
        "meeting_receipt_model_protocol_rejected",
        "Meeting receipt model output must be exactly one extraction tool call and no prose",
        { prose_blocks: prose.length, expected_tool_calls: toolUses.length, other_tool_calls: otherTools.length }
      );
    }
    if (!toolUses[0].input || typeof toolUses[0].input !== "object" || Array.isArray(toolUses[0].input)) {
      throw adapterError("meeting_receipt_model_output_missing", "Meeting receipt model returned no structured extraction");
    }
    return toolUses[0].input;
  };

  extractor.provider = "anthropic";
  extractor.model = model;
  extractor.maxTokens = maxTokens;
  return extractor;
}

module.exports = {
  DEFAULT_MODEL,
  TOOL_NAME,
  adapterError,
  createAnthropicMeetingReceiptExtractor,
};
