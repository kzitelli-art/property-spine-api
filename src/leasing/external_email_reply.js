"use strict";

// One retained staff claim on the existing communications/status ledger.
// This predicate qualifies a recorded reply, never provider delivery.
function evidenceSql(alias = "ce") {
  return `(select sl.raw || jsonb_build_object('captured_at',sl.received_at) from comm_event_status_log sl
    where sl.comm_event_id=${alias}.id and sl.provider='manual'
      and sl.provider_status='recorded_external'
      and sl.raw->>'kind'='external_email_reply'
      and sl.raw->>'already_sent'='true' and sl.raw->>'provider_delivery'='not_verified'
    order by sl.received_at asc, sl.id asc limit 1)`;
}
function predicateSql(alias = "ce") {
  return `${alias}.channel='email' and ${alias}.direction='outbound'
    and ${alias}.provider='manual' and ${alias}.provider_status='recorded_external'
    and ${alias}.actor_user_id is not null and ${alias}.sent_by_user_id=${alias}.actor_user_id
    and ${alias}.body is not null and btrim(${alias}.body)<>''
    and ${evidenceSql(alias)} is not null`;
}
module.exports = { evidenceSql, predicateSql };
