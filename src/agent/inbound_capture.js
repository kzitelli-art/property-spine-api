"use strict";

// Canonical conversation capture shared by SMS and authenticated website intake.
// The caller owns the transaction and has resolved the person/property. Capture
// advances the existing thread; it never interprets an offer or sends a reply.
async function loadThreadState(client, conversationId, forUpdate) {
  const lock = forUpdate ? " for update" : "";
  let state = (await client.query(
    `select * from agent_thread_state where conversation_id=$1${lock}`, [conversationId])).rows[0];
  if (!state) {
    await client.query("insert into agent_thread_state (conversation_id) values ($1) on conflict (conversation_id) do nothing", [conversationId]);
    state = (await client.query(
      `select * from agent_thread_state where conversation_id=$1${lock}`, [conversationId])).rows[0];
  }
  return state;
}

async function recordInboundCapture(client, { conversation, body, channel, smsSid = null,
  provider = null, providerEventId = null, leasingLifecycle = null }) {
  if (!conversation?.id || !conversation.property_id || !conversation.person_id
      || !["text", "website"].includes(channel)) throw new Error("Resolved inbound conversation and channel required");
  const state = await loadThreadState(client, conversation.id, true);
  const inbound = (await client.query(
    `insert into comm_events
       (property_id, person_id, unit_id, conversation_id, channel, direction, body,
        classification, sender_role, sms_sid, provider, provider_event_id)
     values ($1,$2,$3,$4,$5,'inbound',$6,'leasing','prospect',$7,$8,$9) returning id`,
    [conversation.property_id, conversation.person_id, conversation.unit_id || null,
      conversation.id, channel, body, smsSid, provider, providerEventId])).rows[0];
  await client.query("update conversations set last_message_at=now() where id=$1", [conversation.id]);
  if (leasingLifecycle && body && String(body).trim()) {
    // The lifecycle owner decides whether a specific opportunity can reopen.
    // A lifetime conversation alone does not select a closed conversion.
    await leasingLifecycle.maybeReopenOnQualifyingInbound(client, {
      conversationId: conversation.id, sourceCommEventId: inbound.id,
    });
  }
  const newVersion = Number(state.thread_version) + 1;
  await client.query(
    `update agent_drafts d set status='superseded', superseded_at=now(), updated_at=now()
       from agent_runs r where d.agent_run_id=r.id and r.conversation_id=$1 and d.status='ready'`,
    [conversation.id]);
  await client.query(
    `update agent_thread_state set thread_version=$2, latest_inbound_comm_event_id=$3,
       updated_at=now() where conversation_id=$1`, [conversation.id, newVersion, inbound.id]);
  // Mode and accountable review work remain owned by the existing action path.
  return { state, inbound, newVersion };
}

module.exports = { loadThreadState, recordInboundCapture };
