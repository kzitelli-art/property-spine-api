-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 050 — IDENTITY ALIASES + SHADOW IMPORT (ride-along, backend)
--
--  Makes phone-as-verified-identity EXPLICIT and adds the alias, conflict,
--  intent-task, and preview-mode structures the Skyline ride-along needs —
--  WITHOUT forking a Person Card on a name/email variant and WITHOUT inventing
--  a new lead when a known phone books a tour.
--
--  Governing rule (locked with Kameron, Jun 21 2026):
--    "Phone identifies the human. The intake task identifies what that human
--     wants now."
--
--  THE THREE STATES OF AN INCOMING PHONE (the resolver branches on these):
--    1. no / invalid phone, or insufficient identity  -> person_identity_conflicts
--    2. known phone (same person)                      -> intent task, NEVER a fork,
--                                                         NEVER an automatic new lead
--    3. (email/name mismatch on a known phone)         -> a NON-BLOCKING contact-data
--                                                         discrepancy, NOT a conflict
--
--  Email disagreement is explicitly NOT an identity conflict. Phone is primary.
--  A different email is context (people reuse, share, or book for others); it is
--  visible to the leasing owner but never forks identity or blocks the workflow.
--
--  TRANSACTIONS: migrate.js wraps every file in begin/commit/rollback. This file
--  contains NO begin/commit/rollback of its own (that is the double-wrap bug).
--
--  DEFERRED (NOT in this migration, by decision):
--    • leasing_opportunities object  — built when the first intent task resolves
--    • lease-role / co-tenant / guarantor link graph — built with the lease object
--    • persons <-> users bridge      — the two ownership spaces stay as-is
--
--  IDENTITY SPACES (existing convention, preserved — not reconciled here):
--    • leasing_leads.assignee_id        -> persons(id)   (the lead owner = a person)
--    • leasing_tours.leasing_agent_id   -> users(id)     (staff host = a user)
--    • scheduled_tours.scheduled_host_user_id -> users(id) (stays NULL until known)
--  The ride-along assigns ownership ONLY in persons-space (the lead). The tour's
--  users-space host is left null — scheduled host is context, not yet truth.
-- ════════════════════════════════════════════════════════════════════


-- ── 1. PERSONS: the explicit identity key + name-alias history ──────────
-- primary_phone_e164 is the new canonical match key. The legacy `phone` column
-- is kept for back-compat; primary_phone_e164 is what future matching reads.
-- phone_verified_at is added but deliberately LEFT NULL on backfill (below):
-- a number that PARSES is "source-provided", not "verified". It is stamped only
-- by a real verification event (OTP, confirmed tenant-link session, inbound
-- response), which is NOT this import.
alter table persons add column if not exists primary_phone_e164 text;
alter table persons add column if not exists phone_verified_at   timestamptz;
alter table persons add column if not exists names_seen          jsonb not null default '[]'::jsonb;

-- Fast match on the canonical key (not unique: a true collision is handled as a
-- conflict by the resolver, not by a DB constraint that would hard-fail intake).
create index if not exists persons_primary_phone_e164_idx
  on persons(primary_phone_e164) where primary_phone_e164 is not null;


-- ── 2. ONE-TIME BACKFILL ───────────────────────────────────────────────
-- (a) primary_phone_e164 from the existing phone column, normalized to E.164.
--     Mirrors normalizePhone() in leasingscheduling.js: strip non-digits;
--     10 digits -> +1XXXXXXXXXX ; 11 digits starting 1 -> +1XXXXXXXXXX.
--     Anything else is left NULL (it was never a usable phone).
--     phone_verified_at is intentionally NOT set here.
update persons
   set primary_phone_e164 =
       case
         when phone is null then null
         when length(regexp_replace(phone, '\D', '', 'g')) = 10
           then '+1' || regexp_replace(phone, '\D', '', 'g')
         when length(regexp_replace(phone, '\D', '', 'g')) = 11
              and left(regexp_replace(phone, '\D', '', 'g'), 1) = '1'
           then '+'  || regexp_replace(phone, '\D', '', 'g')
         when phone like '+%' then trim(phone)
         else null
       end
 where primary_phone_e164 is null;

-- (b) Seed names_seen with the existing display name as the first alias, so the
--     lifetime-of-variants array starts from current truth. source='backfill'.
update persons
   set names_seen = jsonb_build_array(
         jsonb_build_object(
           'name', name,
           'source', 'backfill',
           'first_seen_at', to_char(coalesce(created_at, now()), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
           'last_seen_at',  to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')
         ))
 where name is not null
   and (names_seen is null or jsonb_array_length(names_seen) = 0);


-- ── 3. PERSON_IDENTITY_CONFLICTS ───────────────────────────────────────
-- The EXCEPTION queue. Raised ONLY when identity cannot be safely resolved:
-- no phone, invalid/unusable phone, or insufficient identity (e.g. the source
-- explicitly says the booking is for a different actual person whose own
-- contact we don't have). An email/name mismatch is NOT in this list.
create table if not exists person_identity_conflicts (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid references persons(id) on delete set null,   -- null when no card could be formed
  incoming_payload jsonb not null,                                   -- the raw occurrence we couldn't resolve
  conflict_type    text  not null
                     check (conflict_type in
                       ('no_phone','invalid_phone','insufficient_identity')),
  status           text  not null default 'open'
                     check (status in ('open','resolved','dismissed')),
  property_id      uuid references properties(id) on delete set null,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references users(id) on delete set null
);
create index if not exists person_identity_conflicts_open_idx
  on person_identity_conflicts(status) where status = 'open';


-- ── 4. PERSON_INTENT_TASKS ─────────────────────────────────────────────
-- A KNOWN phone whose INTENT is unresolved. This is the common case and the one
-- the naive design got wrong: a known phone is the SAME person, but we do NOT
-- know what they want (transfer / another property / returning / booking for
-- someone else / new prospect). NOT a conflict, NOT an automatic new lead.
-- The task is the future workflow rendered in ride-along mode.
--
-- resolved_intent is set ONLY when a human answers the plain question
-- "what does this person want to do?" — the system, not the operator, then maps
-- that answer to the structural outcome.
create table if not exists person_intent_tasks (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null references persons(id) on delete cascade,  -- the matched card (permanent identity)
  property_id      uuid references properties(id) on delete set null,       -- where the booking landed
  scheduled_tour_id uuid references scheduled_tours(id) on delete set null, -- the tour that triggered it
  task_type        text not null default 'existing_person_tour_intent',
  status           text not null default 'needs_confirmation'
                     check (status in ('needs_confirmation','resolved','dismissed')),
  resolved_intent  text
                     check (resolved_intent is null or resolved_intent in
                       ('transfer','other_property','returning','booking_for_other','new_prospect')),
  -- ownership in PERSONS-space (the lead-owner convention), resolved via the
  -- active leasing-agent assignment. May be null = no active agent (a coverage
  -- exception is raised separately).
  owner_role       text,
  owner_person_id  uuid references persons(id) on delete set null,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references users(id) on delete set null
);
create index if not exists person_intent_tasks_open_idx
  on person_intent_tasks(status) where status = 'needs_confirmation';
create index if not exists person_intent_tasks_person_idx
  on person_intent_tasks(person_id);


-- ── 5. PREVIEW IMPORT GUARDRAILS (the data-enforced "no outreach" gate) ──
-- import_mode='preview' marks a row as imported in ride-along: VISIBLE but
-- NON-AUTHORITATIVE and OUTREACH-BARRED. The resolver checks this at the
-- outbound transport seam so smsForEvent() is NEVER reached for a preview row.
-- This is the structural guarantee that "no message sent / Yardi remains system
-- of record" holds even if a UI label is missed.
alter table leasing_leads   add column if not exists import_mode   text not null default 'live';
alter table leasing_leads   add column if not exists import_source text;
alter table scheduled_tours add column if not exists import_mode   text not null default 'live';
alter table scheduled_tours add column if not exists import_source text;

-- Constrain the values. Done as ADD CONSTRAINT guarded by a catalog check so the
-- migration is idempotent (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leasing_leads_import_mode_chk') then
    alter table leasing_leads
      add constraint leasing_leads_import_mode_chk check (import_mode in ('live','preview'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scheduled_tours_import_mode_chk') then
    alter table scheduled_tours
      add constraint scheduled_tours_import_mode_chk check (import_mode in ('live','preview'));
  end if;
end $$;

create index if not exists leasing_leads_preview_idx
  on leasing_leads(import_mode) where import_mode = 'preview';


-- ── 6. CONTACT-DATA DISCREPANCY (non-blocking, visible to leasing owner) ─
-- Q1 revision: an email (or name) that disagrees with a phone-matched card is a
-- contact-data DISCREPANCY, not an identity conflict. It must be SEEN by the
-- leasing owner but must NOT fork a Person Card or block the known-phone
-- workflow. Recorded here, on the matched card, as a soft note. (Name variants
-- are retained in persons.names_seen; this table is for the *flag* the operator
-- reviews — chiefly differing emails / contact fields.)
create table if not exists person_contact_discrepancies (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null references persons(id) on delete cascade,
  field            text not null,            -- 'email' | 'name' | ...
  existing_value   text,
  incoming_value   text,
  source           text,                     -- e.g. 'outlook_acuity_ride_along'
  status           text not null default 'open'
                     check (status in ('open','reviewed','dismissed')),
  created_at       timestamptz not null default now(),
  reviewed_at      timestamptz,
  reviewed_by      uuid references users(id) on delete set null
);
create index if not exists person_contact_discrepancies_open_idx
  on person_contact_discrepancies(person_id) where status = 'open';


-- ── 7. LEASING_COVERAGE_EXCEPTIONS (escalation != coverage) ─────────────
-- Raised when a property has NO active Leasing Agent assignment to take an
-- incoming shadow lead. The lead is left UNASSIGNED; this row makes the gap
-- visible to the manager and records the escalation.
--
-- CRITICAL (locked Jun 21): escalation is NOT coverage. We do NOT silently make
-- the manager the leasing agent. escalates_to_assignment_id answers "who is
-- accountable if this isn't handled," which is a DIFFERENT route from "who does
-- the leasing work when the agent is out." Automatic coverage routing is added
-- only when an explicit coverage/availability model exists — never inferred from
-- escalation.
create table if not exists leasing_coverage_exceptions (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references properties(id) on delete cascade,
  required_role    text not null default 'leasing_agent',
  -- what triggered the exception (a shadow lead and/or a tour with no owner)
  lead_id          uuid references leasing_leads(id) on delete set null,
  scheduled_tour_id uuid references scheduled_tours(id) on delete set null,
  reason           text not null default 'no_active_leasing_agent',
  -- the manager the gap escalates TO (accountability route), resolved from the
  -- property's org structure. NOT an assignment of leasing work.
  escalated_to_person_id uuid references persons(id) on delete set null,
  status           text not null default 'open'
                     check (status in ('open','resolved','dismissed')),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references users(id) on delete set null
);
create index if not exists leasing_coverage_exceptions_open_idx
  on leasing_coverage_exceptions(property_id) where status = 'open';
