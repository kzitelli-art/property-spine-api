"use strict";
// Class 1: writer/reader for existing migration 096. Asking and answering
// only; original words remain in comm_events. Caller owns the transaction.
const unsettled = "('completed','no_show','cancelled','rescheduled')";
const stale = () => Object.assign(new Error('That tour outcome request was already handled or is no longer assigned to you.'), {code:'TOUR_PROMPT_STALE',httpStatus:409});

async function recordPrompt(db,{tourId,propertyId,userId,threadId,promptEventId}) {
  const tour=(await db.query(
    'select id from leasing_tours where id=$1 and property_id=$2 and leasing_agent_id=$3 and status not in '+unsettled+' for update',
    [tourId,propertyId,userId])).rows[0];
  if(!tour)throw stale();
  const message=(await db.query(
    `select o.id from comm_events o join staff_threads st on st.id=o.staff_thread_id
      where o.id=$1 and o.staff_thread_id=$2 and st.user_id=$3
       and o.to_user_id=$3 and o.direction='outbound' and o.channel='sms'
       and o.reply_reason='clarification'`,[promptEventId,threadId,userId])).rows[0];
  if(!message)throw stale();
  const existing=(await db.query('select id from tour_outcome_prompts where tour_id=$1 and prompt_comm_event_id=$2',[tourId,promptEventId])).rows[0];
  if(existing)return existing;
  // Tour lock serializes attempt allocation. Keep the prior ask in history.
  await db.query(`update tour_outcome_prompts set closed_without_response_reason='superseded'
    where tour_id=$1 and asked_user_id=$2 and responded_at is null and closed_without_response_reason is null`,[tourId,userId]);
  return (await db.query(`insert into tour_outcome_prompts
    (tour_id,asked_user_id,channel,attempt_no,prompt_comm_event_id)
    select $1,$2,'sms',coalesce(max(attempt_no),0)+1,$3 from tour_outcome_prompts where tour_id=$1 returning id`,
    [tourId,userId,promptEventId])).rows[0];
}

async function pendingPrompts(db,{propertyId,userId,threadId,promptId=null,lock=false}) {
  return (await db.query(
    `select p.id as prompt_id,p.tour_id,t.unit_id,l.person_id,n.name as prospect_name,u.unit_number,
       original.id as original_event_id,original.body as original_body
     from tour_outcome_prompts p
     join leasing_tours t on t.id=p.tour_id
     join leasing_leads l on l.id=t.lead_id and l.property_id=t.property_id
     join persons n on n.id=l.person_id
     left join units u on u.id=t.unit_id and u.property_id=t.property_id
     join comm_events outgoing on outgoing.id=p.prompt_comm_event_id
     join comm_events original on original.id=outgoing.in_reply_to_comm_event_id
     join staff_threads st on st.id=outgoing.staff_thread_id
     where t.property_id=$1 and t.leasing_agent_id=$2 and p.asked_user_id=$2
       and outgoing.staff_thread_id=$3 and st.user_id=$2
       and original.staff_thread_id=$3 and original.actor_user_id=$2
       and original.channel='sms' and original.direction='inbound'
       and outgoing.channel='sms' and outgoing.direction='outbound'
       and p.responded_at is null and p.closed_without_response_reason is null
       and t.status not in `+unsettled+`
       and ($4::uuid is null or p.id=$4::uuid)
     order by p.asked_at,p.id limit 13`+(lock?' for update of p,t':''),
    [propertyId,userId,threadId,promptId])).rows;
}

async function lockPrompt(db,scope) {
  const rows=await pendingPrompts(db,{...scope,lock:true});
  if(rows.length!==1)throw stale();
  return rows[0];
}

async function answerPrompt(db,{promptId,propertyId,tourId,userId,threadId,responseEventId}) {
  const row=(await db.query(`update tour_outcome_prompts p
    set responded_at=now(),response_source='sms_reply',response_comm_event_id=$4
    where p.id=$1 and p.asked_user_id=$2 and p.responded_at is null
      and p.closed_without_response_reason is null
      and p.tour_id=$6 and exists(select 1 from leasing_tours t where t.id=p.tour_id and t.property_id=$5 and t.leasing_agent_id=$2)
      and exists(select 1 from comm_events c join staff_threads st on st.id=c.staff_thread_id
        where c.id=$4 and c.staff_thread_id=$3 and st.user_id=$2 and c.actor_user_id=$2
          and c.direction='inbound' and c.channel='sms') returning id`,
    [promptId,userId,threadId,responseEventId,propertyId,tourId])).rows[0];
  if(!row)throw stale();
  return row;
}
module.exports={recordPrompt,pendingPrompts,lockPrompt,answerPrompt};
