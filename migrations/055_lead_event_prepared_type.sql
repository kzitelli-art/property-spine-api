-- ════════════════════════════════════════════════════════════════════
--  055_lead_event_prepared_type.sql
--
--  WHY: the demo public intake door (/demo/intake, leasingleads.js) records
--  the honest event 'ai_response_prepared' — the AI opening response was
--  PREPARED, never claimed sent (attempt_sms=false, constraint 5). But the
--  lead_events.event_type CHECK from 038 predates that event type, so
--  Postgres rejects the write, the demo door 500s ("Could not capture the
--  inquiry"), and the prospect sees a failure even though the lead, person,
--  conversation, and lead_received event all committed one step earlier.
--
--  FIX: widen the CHECK by exactly one value. Nothing else changes —
--  the authenticated intake path never writes this type and is untouched.
--
--  The DO block finds the constraint by inspecting which CHECK on
--  lead_events mentions event_type, rather than trusting the auto-generated
--  name — inline column checks get named by Postgres, and guessing the name
--  is how a migration fails in one environment and passes in another.
-- ════════════════════════════════════════════════════════════════════

do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'lead_events'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%event_type%';

  if cname is not null then
    execute format('alter table lead_events drop constraint %I', cname);
  end if;
end $$;

alter table lead_events
  add constraint lead_events_event_type_check
  check (event_type in (
    'lead_received',
    'ai_text_sent',
    'ai_response_prepared',   -- the demo door's honest "prepared, not sent"
    'prospect_replied',
    'tour_requested',
    'tour_scheduled',
    'human_takeover',
    'application_started',
    'lease_signed',
    'lost'
  ));
