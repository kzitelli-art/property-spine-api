-- 043_leasing_thread_wiring.sql
-- Rung 1 of the leasing communication slice (Leasing Module Build Memo §1–2):
-- make the person-scoped thread real, on the rails that already exist.
--
-- NO parallel leasing message store. A lead is a person at a property, and
-- conversations are keyed (property_id, person_id) — identical grain. Leasing
-- messaging rides the existing conversations / comm_events tables, exactly like
-- the tenant line. When a prospect later signs, their thread IS the tenant
-- thread (same row), so pre-lease history never disappears.
--
-- Three safe, idempotent things (all re-runnable):
--   1. comm_events.sender_role — explicit "who said this" (prospect | tenant |
--      agent | ai | system). Without it the thread can only guess from
--      direction, so an operator's outbound reply renders as if AI sent it.
--   2. Ensure a conversation row exists for every person who is a leasing lead
--      (and for any person who already has a comm_event but no thread), so there
--      is something to attach to.
--   3. Adopt orphaned comm_events (conversation_id IS NULL but person_id is set)
--      into their (property_id, person_id) conversation. This rescues the leasing
--      replies that were logged WITHOUT a conversation_id and currently make the
--      thread look empty even though the events exist.

-- 1. WHO SAID IT --------------------------------------------------------------
alter table comm_events
  add column if not exists sender_role text;   -- prospect | tenant | agent | ai | system  (null = derive at read)

-- 2. ENSURE A CONVERSATION FOR EVERY LEAD'S PERSON ----------------------------
--    leasing_leads.person_id is NOT NULL; conversations are unique per
--    (property_id, person_id). Upsert one thread per lead.
insert into conversations (property_id, person_id, unit_id, channel_primary, status)
select distinct ll.property_id, ll.person_id, ll.unit_id, 'sms', 'open'
  from leasing_leads ll
 where ll.property_id is not null
   and ll.person_id   is not null
on conflict (property_id, person_id) do nothing;

-- 2b. ...and for any person who already has comm_events but no thread yet,
--     so step 3 can adopt every orphan (heals pre-existing tenant orphans too).
insert into conversations (property_id, person_id, channel_primary, status)
select distinct ce.property_id, ce.person_id, 'sms', 'open'
  from comm_events ce
 where ce.conversation_id is null
   and ce.property_id is not null
   and ce.person_id   is not null
on conflict (property_id, person_id) do nothing;

-- 3. ADOPT ORPHANED MESSAGES INTO THEIR CONVERSATION --------------------------
--    Deterministic: a comm_event with a person_id at a property belongs to
--    exactly one thread (the unique (property_id, person_id) conversation).
update comm_events ce
   set conversation_id = c.id
  from conversations c
 where ce.conversation_id is null
   and ce.person_id   is not null
   and c.property_id = ce.property_id
   and c.person_id   = ce.person_id;

-- 4. HONEST ORDERING ----------------------------------------------------------
--    Threads that just adopted messages should sort by their real latest event.
update conversations c
   set last_message_at = sub.mx
  from (select conversation_id, max(occurred_at) as mx
          from comm_events
         where conversation_id is not null
         group by conversation_id) sub
 where sub.conversation_id = c.id
   and (c.last_message_at is null or c.last_message_at < sub.mx);
