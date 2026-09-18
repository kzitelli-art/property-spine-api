"use strict";

/*
 * Owned proof seam for the overnight staff-SMS case.
 *
 * This file deliberately does not start a server, create a database, call a
 * provider, or own fixtures. The disposable HTTP runner supplies the already
 * authenticated fixture and the same sendStaffSms/waitForStaffReply helpers
 * used by tour_application_lease.e2e.js. That keeps this regression focused
 * on the partial-state handoff instead of creating a second journey runner.
 *
 * Expected successor contract:
 *   1. the exact staff wording is durably retained as partial tour feedback;
 *   2. the clarification asks only for the missing standing;
 *   3. the standing reply completes the same canonical tour and carries the
 *      earlier preferences into the existing person-facts projection;
 *   4. application dispatch remains behind the existing explicit confirmation
 *      and exact-target gates.
 *
 * On the current candidate this is intentionally red at step 3: the first
 * turn is stored only as a comm_events body and the second turn has no
 * structured preference context to carry forward.
 */

function check(condition, label, detail = "") {
  if (!condition) throw new Error(`${label}${detail ? ` — ${detail}` : ""}`);
}

async function runStaffSmsPartialCapture({
  q,
  readPersonCard,
  sendStaffSms,
  waitForStaffReply,
  propertyId,
  tourId,
  personId,
  mikePhone,
  operationsLine,
  suffix = "PARTIAL",
}) {
  if (typeof q !== "function" || typeof sendStaffSms !== "function"
      || typeof waitForStaffReply !== "function") {
    throw new Error("partial staff SMS proof needs q, sendStaffSms, and waitForStaffReply adapters");
  }

  const wording = "tour went great , they want a one bedroom high floor with a move in start of next month, send app";
  const firstSid = `SM_PARTIAL_FEEDBACK_${suffix}`;
  const baselineFacts = (await q(
    `select id from person_attributes where person_id=$1 and property_id=$2`,
    [personId, propertyId]
  )).rows.map((row) => String(row.id));
  const baselineStanding = (await q(
    `select count(*)::int as n from tour_events
      where tour_id=$1 and event_type='completed'
        and coalesce(metadata->>'standing','')='ready_to_apply'`, [tourId]
  )).rows[0].n;
  const baselineInvites = (await q(
    `select count(*)::int as n from application_invitations where conversion_id in
       (select id from leasing_conversions where origin_tour_id=$1 and property_id=$2)`,
    [tourId, propertyId]
  )).rows[0].n;
  // This helper is invoked only by the fenced disposable runner. Exercise
  // the real persistence failure and restore the owned table even on failure.
  await q('alter table person_attributes rename to proof_sms_person_attributes');
  try {
    const failureSid = 'SM_PARTIAL_FAILURE_' + suffix;
    await sendStaffSms({from:mikePhone,to:operationsLine,sid:failureSid,body:wording});
    const failedReply = await waitForStaffReply(failureSid);
    check(/couldn't save its preferences/.test(failedReply.body), 'a failed canonical preference write gets an honest SMS receipt', failedReply.body);
  } finally {
    await q('alter table proof_sms_person_attributes rename to person_attributes');
  }

  await sendStaffSms({ from: mikePhone, to: operationsLine, sid: firstSid, body: wording });
  const firstReply = await waitForStaffReply(firstSid);
  check(firstReply.reply_reason === "clarification",
    "partial feedback asks a clarification instead of sending an application");
  check(/Ready to Apply, Hot Lead, Possible, or Not Moving Forward/.test(firstReply.body),
    "clarification names the canonical standing choices", firstReply.body);

  // Attendance may already be recorded by the canonical tour service. The
  // red line is semantic: before the standing reply, no event may invent
  // Ready to Apply (and no application may be born from the partial turn).
  const firstStanding = (await q(
    `select count(*)::int as n from tour_events
      where tour_id=$1 and event_type='completed'
        and coalesce(metadata->>'standing','')='ready_to_apply'`, [tourId]
  )).rows[0];
  check(firstStanding && firstStanding.n === baselineStanding,
    "partial feedback does not invent a Ready to Apply standing", JSON.stringify(firstStanding));

  const firstEvent = (await q(
    `select id, body, needs_human, classification,actor_user_id,staff_thread_id from comm_events where sms_sid=$1`, [firstSid]
  )).rows[0];
  check(firstEvent && firstEvent.body === wording,
    "raw partial wording remains on the durable staff thread", JSON.stringify(firstEvent));

  const partialFacts = (await q(
    `select attr_key,attr_value,source_ref,actor_type,actor_user_id,claim_strength,occurred_at
       from person_attributes where person_id=$1 and property_id=$2 and status='active'
        and source_record_type='comm_event' and source_ref=$3`,
    [personId,propertyId,firstEvent.id])).rows;
  check(partialFacts.some(f=>f.attr_key==='unit_type' && f.attr_value==='one bedroom high floor')
    && partialFacts.some(f=>f.attr_key==='move_month' && f.attr_value==='start of next month'),
    'preferences are captured before the standing reply', JSON.stringify(partialFacts));
  check(partialFacts.every(f=>f.actor_type==='operator' && f.actor_user_id && f.claim_strength==='asserted' && f.occurred_at),
    'partial facts retain staff actor, assertion strength and source time');

  const prompt = (await q(
    `select p.id,p.asked_user_id,p.prompt_comm_event_id from tour_outcome_prompts p
       join comm_events outbound on outbound.id=p.prompt_comm_event_id
       where p.tour_id=$1 and outbound.in_reply_to_comm_event_id=$2
         and p.responded_at is null and p.closed_without_response_reason is null`,
    [tourId,firstEvent.id])).rows;
  check(prompt.length===1,'clarification durably links this exact tour to the original request');

  const promptOwner = require('../../src/leasing/tour_outcome_prompts');
  const scope={propertyId,userId:firstEvent.actor_user_id,threadId:firstEvent.staff_thread_id};
  const foreign=require('crypto').randomUUID();
  for(const override of [{propertyId:foreign},{userId:foreign},{threadId:foreign}]) {
    check((await promptOwner.pendingPrompts({query:q},{...scope,...override})).length===0,
      'pending tour request refuses a different property, actor or thread');
  }
  await sendStaffSms({from:mikePhone,to:operationsLine,sid:firstSid,body:wording});
  await waitForStaffReply(firstSid);
  const replayedAsk=(await q(`select count(*)::int as n from tour_outcome_prompts where tour_id=$1`,[tourId])).rows[0];
  check(replayedAsk.n===1,'replayed inbound creates no second prompt or attempt');

  const secondSid = `SM_PARTIAL_STANDING_${suffix}`;
  await sendStaffSms({ from: mikePhone, to: operationsLine, sid: secondSid, body: "Ready to Apply" });
  const secondReply = await waitForStaffReply(secondSid);
  check(secondReply.reply_reason === "execution_receipt"
      && /Recorded .* tour as Ready to Apply/.test(secondReply.body),
    "the standing reply completes the same canonical tour", secondReply.body);

  const capturedNotes = (await q(
    `select tour_notes from leasing_conversions where origin_tour_id=$1 and property_id=$2`,
    [tourId, propertyId])).rows;
  check(capturedNotes.length === 1 && capturedNotes[0].tour_notes === wording,
    "completed outcome retains the original feedback, not just the standing reply");
  const capturedEvent = (await q(
    `select actor_id, metadata from tour_events where tour_id=$1 and event_type='completed'`,
    [tourId])).rows;
  check(capturedEvent.length === 1 && capturedEvent[0].metadata.notes === wording
      && capturedEvent[0].metadata.standing === 'ready_to_apply'
      && capturedEvent[0].actor_id === firstEvent.actor_user_id,
    "immutable tour event retains original notes with explicit standing and staff actor");
  const card = await readPersonCard();
  check(card.status === 200, 'the authorized staff session can read the Person Card');
  const cardOutcomes = (card.body.history || []).filter(e => e.source === 'outcome'
    && e.detail?.tour_id === tourId && e.detail?.standing === 'ready_to_apply');
  check(cardOutcomes.length === 1 && cardOutcomes[0].detail.notes === wording
    && cardOutcomes[0].actor.id === firstEvent.actor_user_id,
    'Person Card shows the same recorded standing, notes and staff actor');
  const standingRead = await require('../../src/leasing/leasing_standing_read').readLeasingStanding(
    {query:q}, {person_id:personId, property_id:propertyId});
  check(standingRead.tour_history?.events.some(e => e.tour_id === tourId
    && e.standing === 'ready_to_apply' && e.notes === wording
    && e.recorded_by_user_id === firstEvent.actor_user_id),
    'Ask canonical Leasing standing retains the same attributed historical tour outcome');
  const readStanding = require('../../src/leasing/leasing_standing_read').readLeasingStanding;
  const foreignStanding = await readStanding({query:q}, {person_id:personId,property_id:foreign});
  check(foreignStanding.tour_history.read_state === 'OK' && foreignStanding.tour_history.events.length === 0,
    'historical tour read cannot cross the property boundary');
  for (const code of ['READ_TIMED_OUT','TEST_READ_FAILED']) {
    const failingDb = {query:(sql,params)=>{
      if (/from tour_events te/.test(sql)) throw Object.assign(new Error('controlled tour reader failure'),{code});
      return q(sql,params);
    }};
    const unavailable = await readStanding(failingDb,{person_id:personId,property_id:propertyId});
    check(unavailable.tour_history.events === null && unavailable.tour_history.read_state ===
      (code === 'READ_TIMED_OUT' ? 'READ_TIMED_OUT' : 'READ_FAILED'),
      'tour reader failure and timeout remain distinct from empty history');
  }

  const answeredPrompt = (await q(
    `select p.response_source,c.sms_sid from tour_outcome_prompts p
       join comm_events c on c.id=p.response_comm_event_id where p.id=$1 and p.responded_at is not null`,
    [prompt[0].id])).rows[0];
  check(answeredPrompt && answeredPrompt.response_source==='sms_reply' && answeredPrompt.sms_sid===secondSid,
    'the explicit outcome answers the exact prior prompt');
  check(/application/i.test(secondReply.body), 'original send-app request resumes without staff repeating it',secondReply.body);
  check(!/Confirm sca1\./.test(secondReply.body) && /terms|offer/i.test(secondReply.body),
    'without established terms the reply requests terms instead of offering a send confirmation',secondReply.body);

  const openAfter=await promptOwner.pendingPrompts({query:q},scope);
  check(openAfter.length===0,'answered prompt cannot select another tour on a later reply');

  const facts = (await q(
    `select id, property_id, attr_key, attr_value, source, source_record_type, source_ref
       from person_attributes
      where person_id=$1 and property_id=$2 and status='active'
        and attr_key in ('unit_type','move_month')
      order by attr_key`, [personId, propertyId]
  )).rows;
  const newFacts = facts.filter((f) => !baselineFacts.includes(String(f.id)));
  check(newFacts.some((f) => /one\s*bed(room)?/i.test(f.attr_value)
      && /high\s*floor/i.test(f.attr_value)),
    "standing reply carries the one-bedroom high-floor preference into canonical person facts", JSON.stringify(newFacts));
  check(newFacts.some((f) => /next\s+month/i.test(f.attr_value)),
    "standing reply carries the relative move timing into canonical person facts", JSON.stringify(newFacts));
  check(newFacts.some((f) => f.source_record_type === "comm_event"
      && String(f.source_ref) === String(firstEvent.id)),
    "carried preferences point to the exact partial-feedback inbound event", JSON.stringify(newFacts));

  const invites = (await q(
    `select count(*)::int as n from application_invitations where conversion_id in
       (select id from leasing_conversions where origin_tour_id=$1 and property_id=$2)`,
    [tourId, propertyId]
  )).rows[0];
  check(invites && invites.n === baselineInvites,
    "partial feedback and a standing reply create no new application invitation", JSON.stringify(invites));

  return { firstSid, secondSid, facts, invites: invites.n };
}

module.exports = { runStaffSmsPartialCapture };
