-- ════════════════════════════════════════════════════════════════════
--  188 — three small pieces of schema three fixes were waiting on
--
--  NUMBERING (CURRENT_STATE #49). 188 and 189 sit on four unmerged
--  branches and a different 188 on a fifth. The ruling this branch takes:
--  the first branch to merge keeps its number; every other branch
--  renumbers on rebase. This file is 188 on THIS branch. If another 188
--  lands first, rename this file to the next free number — its contents
--  are additive and order-independent.
--
--  1  bank_transactions.plaid_transaction_id (#57)
--     Plaid amends and retracts lines BY ID. Without the id stored, only
--     `added` could be applied and an amended or retracted line stayed as
--     first seen. Unique where present; statement uploads carry none.
--     amended_from keeps what the line said before the bank changed it.
--     Two new exception flags: source_amended, source_removed.
--
--  2  tour_events.event_type gains 'outcome_corrected' (#38)
--     The correct-outcome route has written this append-only event since
--     the audit; the CHECK refused it (mapped to an honest 409). Widened.
--
--  3  inbound_sms_raw (#58)
--     The carrier is acknowledged BEFORE the message is durably recorded,
--     so a failure after the ack loses the message. This table is written
--     first, in its own transaction, before any ack: the message as
--     received, replayable by hand or by a later job. processed_at and
--     outcome say what became of it.
-- ════════════════════════════════════════════════════════════════════

-- 1 ── Plaid identity on a bank line ─────────────────────────────────
alter table bank_transactions add column if not exists plaid_transaction_id text;
alter table bank_transactions add column if not exists amended_from jsonb;
create unique index if not exists uq_bank_transactions_plaid_id
  on bank_transactions (plaid_transaction_id) where plaid_transaction_id is not null;

alter table bank_transactions
  drop constraint if exists bank_transactions_exception_reason_check;
alter table bank_transactions
  add constraint bank_transactions_exception_reason_check
  check (exception_reason in
    ('possible_non_property_spend','composite_batch','rejected_check',
     'ambiguous_payee','amount_mismatch','affiliate_transfer',
     'payment_return',
     'source_amended',     -- the bank changed a line a human had already identified
     'source_removed'));   -- the bank retracted a line a human had already worked

-- 2 ── a tour outcome may be corrected, on the record ────────────────
alter table tour_events drop constraint if exists tour_events_event_type_check;
alter table tour_events
  add constraint tour_events_event_type_check
  check (event_type in (
    'scheduled','confirmed_by_prospect','reminder_sent',
    'checked_in','completed','no_show','cancelled','rescheduled',
    'outcome_corrected'   -- append-only; the tour's status is never rewritten by it
  ));

-- 3 ── the inbound text, durable before the ack ──────────────────────
create table if not exists inbound_sms_raw (
  provider_message_id text primary key,            -- Twilio MessageSid: the carrier's own idempotency key
  received_at         timestamptz not null default now(),
  from_e164           text not null,
  to_e164             text not null,
  body                text not null default '',
  media               jsonb,                        -- MediaUrlN / MediaContentTypeN as received
  line_id             uuid,                         -- communication_lines.id once resolved (nullable: unknown line is still recorded)
  processed_at        timestamptz,
  outcome             text,                         -- what became of it: operations_turn | lead_agent | resident_reply | dropped_<reason> | failed
  failure             text                          -- the error, when outcome = 'failed' — replay from this row
);
create index if not exists inbound_sms_raw_unprocessed_idx on inbound_sms_raw (received_at) where processed_at is null;
