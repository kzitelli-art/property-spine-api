"use strict";

// PROPERTY SPINE — CONVERSATION OPERATING BUCKET CONTRACT v1
// One open conversation, one server-authored operating bucket.
// The browser renders this decision; it never reproduces the precedence.

const ACTIVE_BUCKETS = Object.freeze(["needs_attention", "ai_handling", "no_response"]);
const EMPTY_COUNTS = Object.freeze({ needs_attention: 0, ai_handling: 0, no_response: 0 });

function delivered(row) {
  return row && row.delivery_state === "delivered" && !!row.last_delivered_outbound_at;
}
function hasInbound(row) { return !!(row && row.last_inbound_at); }

function classifyConversation(row) {
  row = row || {};
  if (row.control_mode === "human_takeover" || row.control_mode === "awaiting_review") {
    return "needs_attention";
  }
  if (row.waiting_on === "manager") return "needs_attention";
  if (!hasInbound(row) && !delivered(row)) return "needs_attention";
  if (!hasInbound(row) && delivered(row)) return "no_response";
  return "ai_handling";
}

function reasonForConversation(row) {
  row = row || {};
  if (row.control_mode === "human_takeover") return "human_owned";
  if (row.control_mode === "awaiting_review") return "draft_requires_review";
  if (row.waiting_on === "manager" && row.rule_code === "cadence_exhausted_pending_human") {
    return "cadence_exhausted_pending_human";
  }
  if (row.waiting_on === "manager") return "human_attention_required";
  if (!hasInbound(row) && !row.last_any_outbound_at) return "outreach_not_started";
  if (!hasInbound(row) && !delivered(row)) return "delivery_failed_or_unconfirmed";
  if (!hasInbound(row) && delivered(row)) return "delivered_no_inbound_reply";
  if (row.waiting_on === "ai") return "ai_preparing_reply";
  if (row.waiting_on === "prospect") return "ai_waiting_on_prospect";
  return "ai_active";
}

function priorityForConversation(row) {
  row = row || {};
  if (row.control_mode === "human_takeover") return 10;
  if (row.control_mode === "awaiting_review") return 20;
  if (row.waiting_on === "manager") return 30;
  if (!hasInbound(row) && !delivered(row)) return 40;
  if (!hasInbound(row) && delivered(row)) return 100;
  return 200;
}

// SQL expressions used by operator.js. They intentionally refer only to columns
// already authored by the canonical projection CTE.
const OPERATING_BUCKET_SQL = `case
  when control_mode in ('human_takeover','awaiting_review') then 'needs_attention'
  when waiting_on = 'manager' then 'needs_attention'
  when last_inbound_at is null
       and not (delivery_state = 'delivered' and last_delivered_outbound_at is not null)
    then 'needs_attention'
  when last_inbound_at is null
       and delivery_state = 'delivered' and last_delivered_outbound_at is not null
    then 'no_response'
  else 'ai_handling'
end`;

const OPERATING_REASON_SQL = `case
  when control_mode = 'human_takeover' then 'human_owned'
  when control_mode = 'awaiting_review' then 'draft_requires_review'
  when waiting_on = 'manager' and (derivation->>'rule_code') = 'cadence_exhausted_pending_human'
    then 'cadence_exhausted_pending_human'
  when waiting_on = 'manager' then 'human_attention_required'
  when last_inbound_at is null and last_any_outbound_at is null then 'outreach_not_started'
  when last_inbound_at is null
       and not (delivery_state = 'delivered' and last_delivered_outbound_at is not null)
    then 'delivery_failed_or_unconfirmed'
  when last_inbound_at is null
       and delivery_state = 'delivered' and last_delivered_outbound_at is not null
    then 'delivered_no_inbound_reply'
  when waiting_on = 'ai' then 'ai_preparing_reply'
  when waiting_on = 'prospect' then 'ai_waiting_on_prospect'
  else 'ai_active'
end`;

const OPERATING_PRIORITY_SQL = `case
  when control_mode = 'human_takeover' then 10
  when control_mode = 'awaiting_review' then 20
  when waiting_on = 'manager' then 30
  when last_inbound_at is null
       and not (delivery_state = 'delivered' and last_delivered_outbound_at is not null)
    then 40
  when last_inbound_at is null
       and delivery_state = 'delivered' and last_delivered_outbound_at is not null
    then 100
  else 200
end`;

module.exports = {
  ACTIVE_BUCKETS,
  EMPTY_COUNTS,
  classifyConversation,
  reasonForConversation,
  priorityForConversation,
  OPERATING_BUCKET_SQL,
  OPERATING_REASON_SQL,
  OPERATING_PRIORITY_SQL,
};
