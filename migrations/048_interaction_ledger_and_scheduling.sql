-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 048 — INTERACTION LEDGER + SCHEDULING INTAKE
--
--  Two schema concerns that resolve together (per the comms contract):
--
--   PART A — extend comm_events into the canonical UNIFIED interaction
--     ledger (texts + calls + email + voicemail + portal in ONE thread).
--     We do NOT create twilio_messages or a separate calls table. Sparse
--     call-only columns on text rows are accepted by design.
--
--   PART B — a durable SCHEDULING-INTAKE layer so Acuity/Squarespace tours
--     enter as canonical source events, never hand-re-entered. Outlook is
--     the current ingestion ADAPTER, not the architecture: a future direct
--     Acuity API/webhook feeds the SAME canonical model. Raw source events
--     (append-only) project into canonical scheduled_tours.
--
--   THE BOUNDARY THIS ENFORCES: Acuity says a tour is SCHEDULED. It does
--   NOT say the tour happened. Intake creates/updates scheduled_tours ONLY.
--   It never creates a conversion case, owner, or post-tour obligation —
--   only completed-tour feedback with a confirmed actual host does that
--   (migration 047). leasing_conversions.origin_tour_id repoints here.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════
--  PART A — comm_events extension (the Twilio interaction ledger)
-- ════════════════════════════════════════════════════════════════════
-- comm_events already carries: property_id, person_id, unit_id, channel
-- (call|text|email|voicemail|chat|portal), direction, body, transcript,
-- ai_summary, conversation_id, sender_role, conversion_id (from 047).
-- Add the query-critical facts as EXPLICIT columns (not generic JSON), so
-- status, provider id, the real human actor, AI/human approval, call
-- metadata, and obligation linkage are all directly queryable.
alter table comm_events
  -- provider + idempotency (Twilio SID is the dedup key for webhooks)
  add column if not exists provider                  text,           -- 'twilio' | ...
  add column if not exists provider_event_id         text,           -- Twilio Message/Call SID (or equivalent)
  add column if not exists provider_status           text,           -- queued|sent|delivered|failed|undelivered|completed|no_answer|busy|...
  add column if not exists provider_status_updated_at timestamptz,
  -- WHO acted — the actual authenticated human (distinct from coarse sender_role)
  add column if not exists actor_user_id             uuid references users(id) on delete set null,
  -- AI-draft vs HUMAN-approval provenance (the contract's "human sends the outward move")
  add column if not exists ai_drafted_at             timestamptz,    -- non-null = AI produced a draft
  add column if not exists human_approved_by_user_id uuid references users(id) on delete set null,
  add column if not exists human_approved_at         timestamptz,
  add column if not exists sent_by_user_id           uuid references users(id) on delete set null, -- where distinct from approver
  -- media (v1: references only, no recording/transcription rollout)
  add column if not exists media_refs                jsonb,
  -- call-specific (nullable on text rows — accepted by design)
  add column if not exists call_duration_seconds     integer,
  add column if not exists call_disposition          text,           -- e.g. connected|left_voicemail|no_answer|callback_requested
  -- consent/opt-out KNOWN AT THIS EVENT (not the canonical current truth — see contact prefs below)
  add column if not exists consent_state_at_event    text,           -- opted_in|opted_out|unknown
  -- canonical linkage
  add column if not exists conversion_case_id        uuid references leasing_conversions(id) on delete set null,
  add column if not exists obligation_id             uuid references obligations(id) on delete set null;

-- Idempotency: at most one comm_events row per (provider, provider_event_id).
-- Partial unique so the many rows WITHOUT a provider id (chat, legacy) don't collide.
create unique index if not exists comm_events_provider_event_unique
  on comm_events(provider, provider_event_id)
  where provider_event_id is not null;
create index if not exists comm_events_conversion_case_idx
  on comm_events(conversion_case_id) where conversion_case_id is not null;
create index if not exists comm_events_obligation_idx
  on comm_events(obligation_id) where obligation_id is not null;
create index if not exists comm_events_actor_idx
  on comm_events(actor_user_id) where actor_user_id is not null;

-- Append-only callback/audit ledger for provider status updates. A later
-- delivery callback UPDATES the comm_events row's current status AND appends
-- a row here, rather than creating a parallel Twilio ledger.
create table if not exists comm_event_status_log (
  id                  uuid primary key default gen_random_uuid(),
  comm_event_id       uuid not null references comm_events(id) on delete cascade,
  provider            text,
  provider_event_id   text,
  provider_status     text,
  raw                 jsonb,
  received_at         timestamptz not null default now()
);
create index if not exists cesl_comm_event_idx on comm_event_status_log(comm_event_id, received_at);

-- Canonical CURRENT contact preference per person (consent truth lives HERE,
-- not on a single comm_events row). One row per (person, channel).
create table if not exists contact_preferences (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references persons(id) on delete cascade,
  channel         text not null default 'text',     -- text|call|email
  consent_state   text not null default 'unknown',  -- opted_in|opted_out|unknown
  updated_at      timestamptz not null default now(),
  source          text                              -- how we learned it (inbound_stop, web_optin, ...)
);
create unique index if not exists contact_prefs_person_channel
  on contact_preferences(person_id, channel);

-- ════════════════════════════════════════════════════════════════════
--  PART B — SCHEDULING INTAKE (Acuity/Squarespace → canonical scheduled tours)
-- ════════════════════════════════════════════════════════════════════

-- B1. CONFIGURABLE SOURCE MAPPINGS — resolve an incoming notice to a property.
-- NO property names, senders, or templates hard-coded in parser logic; they
-- live here and are editable without a code change.
create table if not exists scheduling_source_mappings (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  source_system       text not null default 'acuity_squarespace',
  -- any of these may match an inbound notice (all nullable; matcher uses what's set)
  calendar_label      text,            -- Acuity/Squarespace calendar name
  sender_pattern      text,            -- sender domain or address pattern
  appointment_name    text,            -- appointment type/template name
  template_shape      text,            -- coarse email-template identifier
  recipient_mailbox   text,            -- optional: which mailbox received it
  -- routing policy
  default_host_user_id uuid references users(id) on delete set null, -- expected host, where a default applies
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
create index if not exists ssm_property_idx on scheduling_source_mappings(property_id) where active;

-- B2. RAW SOURCE EVENTS — append-only ENVELOPE. One row per inbound notice
-- (one individual appointment email, OR one weekly agenda digest). This is the
-- raw evidence; per-appointment detail lives in the link table below, because
-- ONE digest envelope can carry MANY appointments. Idempotent by the envelope's
-- own identity (source_event_id, e.g. the Outlook message id), so re-delivery of
-- the same email never re-processes.
create table if not exists scheduled_tour_sources (
  id                  uuid primary key default gen_random_uuid(),
  source_system       text not null default 'acuity_squarespace',
  ingestion_channel   text not null default 'outlook_email',  -- adapter, not architecture
  -- identity of the ENVELOPE (the raw email/notice itself)
  source_event_id     text,            -- Outlook message id / provider event id (the envelope key)
  event_type          text not null    -- created|rescheduled|cancelled|agenda_digest
                        check (event_type in ('created','rescheduled','cancelled','agenda_digest')),
  -- envelope-level idempotency: the SAME inbound notice never processes twice
  idempotency_key     text not null,   -- source_event_id when present, else an envelope fingerprint
  specificity         text not null default 'individual'   -- individual notice vs. digest
                        check (specificity in ('individual','digest')),
  -- envelope routing (a digest may resolve property per-occurrence instead)
  property_id         uuid references properties(id) on delete set null,
  recipient_mailbox   text,
  sender              text,
  -- the immutable raw artifact
  raw_payload         jsonb,           -- or a secure reference to the stored email
  source_received_at  timestamptz,     -- when the notice arrived
  processed_at        timestamptz not null default now(),
  -- PARSE / MAPPING RESULT (so unresolved notices are visible, not silently lost)
  parse_status        text not null default 'parsed'   -- parsed | partial | failed
                        check (parse_status in ('parsed','partial','failed')),
  parse_error         text,            -- human-readable failure detail, when applicable
  unresolved_property boolean not null default false,  -- true = no mapping matched
  occurrence_count    integer not null default 0,      -- how many appointments this envelope yielded
  parser_result       jsonb            -- structured parser output / mapping trace
);
-- Idempotency guard: the SAME inbound notice never processes twice.
create unique index if not exists sts_idempotency_unique
  on scheduled_tour_sources(source_system, idempotency_key);
create index if not exists sts_unresolved_idx
  on scheduled_tour_sources(processed_at) where unresolved_property or parse_status <> 'parsed';

-- B3. CANONICAL SCHEDULED TOURS — one durable record per appointment.
-- Reschedules update THIS row and retain prior schedule history (in the
-- source events above + the inline previous_* snapshot). Cancellations update
-- status; they never delete evidence or fork a new lead.
create table if not exists scheduled_tours (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid references properties(id) on delete set null,
  -- prospect linkage (person may be resolved later; raw contact kept regardless)
  person_id             uuid references persons(id) on delete set null,
  prospect_name         text,
  prospect_phone        text,
  prospect_email        text,
  -- the strongest dedup key across source events
  external_appt_id      text,
  source_system         text not null default 'acuity_squarespace',
  -- current scheduled facts
  appointment_type      text,            -- in_person|facetime|other
  scheduled_start       timestamptz,
  scheduled_end         timestamptz,
  scheduled_host_user_id uuid references users(id) on delete set null,
  -- canonical status of the SCHEDULE (not the tour outcome)
  status                text not null default 'scheduled'
                          check (status in ('scheduled','rescheduled','cancelled')),
  -- how specific the most-authoritative source was (a digest can't overwrite individual)
  authority             text not null default 'individual'
                          check (authority in ('individual','digest')),
  -- last reschedule snapshot (full history is in scheduled_tour_sources)
  previous_start        timestamptz,
  previous_end          timestamptz,
  reschedule_count      integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- Dedup canonical tours by external appointment id where present.
create unique index if not exists scheduled_tours_extappt_unique
  on scheduled_tours(source_system, external_appt_id)
  where external_appt_id is not null;
create index if not exists scheduled_tours_property_idx on scheduled_tours(property_id);
create index if not exists scheduled_tours_upcoming_idx
  on scheduled_tours(scheduled_start) where status <> 'cancelled';

-- B2b. SOURCE→TOUR LINKS — one row per PARSED APPOINTMENT OCCURRENCE within a
-- source envelope. This is what lets ONE weekly digest reference MANY canonical
-- tours without duplicating the raw email or forcing a false 1:1. Each link
-- carries the per-occurrence parsed facts and resolves to one scheduled_tour.
create table if not exists scheduled_tour_source_links (
  id                  uuid primary key default gen_random_uuid(),
  source_id           uuid not null references scheduled_tour_sources(id) on delete cascade,
  scheduled_tour_id   uuid references scheduled_tours(id) on delete set null, -- set once projected
  -- per-occurrence parsed facts (a digest row describes one appointment in the digest)
  external_appt_id    text,            -- Acuity appt id for THIS occurrence, when available
  property_id         uuid references properties(id) on delete set null,
  prospect_name       text,
  prospect_phone      text,
  prospect_email      text,
  appointment_type    text,            -- in_person|facetime|other
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  scheduled_host_user_id uuid references users(id) on delete set null,
  source_status       text,            -- scheduled|rescheduled|cancelled (as this notice states)
  -- per-occurrence idempotency: the same occurrence (in a re-sent digest) maps to
  -- the same tour without creating a duplicate link.
  occurrence_key      text not null,   -- appt id, else fingerprint(property+prospect+start+type)
  action              text,            -- what projection did: created|rescheduled|cancelled|backfilled|affirmed|ignored_digest_lower
  created_at          timestamptz not null default now()
);
create index if not exists stsl_source_idx on scheduled_tour_source_links(source_id);
create index if not exists stsl_tour_idx on scheduled_tour_source_links(scheduled_tour_id) where scheduled_tour_id is not null;
-- A given occurrence appears once per source envelope.
create unique index if not exists stsl_occurrence_unique
  on scheduled_tour_source_links(source_id, occurrence_key);


-- B3b. SCHEDULE REVISION HISTORY — append-only. The canonical scheduled_tours
-- row reflects CURRENT truth; every reschedule/cancellation also writes a
-- revision here so the change history stays readable (the inline previous_*
-- snapshot on the tour is only the most-recent change). Never updated/deleted.
create table if not exists scheduled_tour_revisions (
  id                  uuid primary key default gen_random_uuid(),
  scheduled_tour_id   uuid not null references scheduled_tours(id) on delete cascade,
  source_link_id      uuid references scheduled_tour_source_links(id) on delete set null, -- which notice caused it
  change_type         text not null,   -- created|rescheduled|cancelled|affirmed
  -- the schedule/status BEFORE this change (null for the initial 'created')
  prev_scheduled_start timestamptz,
  prev_scheduled_end   timestamptz,
  prev_status          text,
  -- the schedule/status AFTER this change
  new_scheduled_start  timestamptz,
  new_scheduled_end    timestamptz,
  new_status           text,
  created_at          timestamptz not null default now()
);
create index if not exists str_tour_idx on scheduled_tour_revisions(scheduled_tour_id, created_at);

-- B4. CONVERSION → SCHEDULED-TOUR LINKAGE (additive; semantically explicit).
-- The legacy leasing_conversions.origin_tour_id (047, → legacy leasing_tours)
-- is LEFT UNCHANGED for backward compatibility — old rows keep their meaning.
-- New conversion cases use this NEW, explicitly-named column pointing at the
-- canonical scheduled_tours. Backfill legacy rows only where a defensible
-- mapping exists; deprecate origin_tour_id later, after live cutover is proven.
-- (Do NOT overload origin_tour_id to mean two different tables.)
alter table leasing_conversions
  add column if not exists scheduled_tour_id uuid references scheduled_tours(id);
create index if not exists leasing_conversions_sched_tour_idx
  on leasing_conversions(scheduled_tour_id) where scheduled_tour_id is not null;
