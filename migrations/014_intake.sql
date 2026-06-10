-- 014_intake.sql
-- DOOR 2: TEXT/EMAIL/WEB INTAKE — field-event capture with proof attached.
--
-- THE MODEL (same doctrine as everything else):
--   A captured event is a CLAIM. AI structures it; it enters status 'captured'.
--   The one-question reply may upgrade it to 'answered'. Nothing here is
--   institutional truth. Truth happens only when a human, from the review
--   queue, creates the REAL record through the REAL module endpoint
--   (/work-orders, /money-events) — and the tie back is recorded here as
--   routed_kind + routed_id. Intake itself NEVER writes a work order, a money
--   event, or anything that reports.
--
-- THE WALL (structural, not policy):
--   property_id is the ONLY foreign reference, and it is nullable + advisory —
--   set by the registry resolver to help the reviewer, never load-bearing.
--   No column here references units, work_orders, money_events, candidates,
--   or obligations as a constraint. The routed_id is a recorded tie, not an FK,
--   so intake cannot block, cascade into, or mutate the institutional tables.
--
-- migrate.js applies this after 013. No begin/commit, no ledger insert
-- (the runner records the migration itself).

-- ── 1. MEDIA — photo/receipt proof, stored at capture time ──
create table if not exists intake_media (
  id uuid primary key default gen_random_uuid(),
  mime text,
  byte_size integer,
  bytes bytea,                         -- the proof itself (capped in app code)
  source_url text,                     -- e.g. a Twilio media URL not yet fetched
  created_at timestamptz not null default now()
);

-- ── 2. EVENTS — one row per captured field event (the claim) ──
create table if not exists intake_events (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'web',          -- web | sms | email
  sender text,                                  -- phone / email / typed name
  raw_text text,                                -- exactly what they sent
  media_id uuid references intake_media(id),    -- the attached proof, if any

  extracted jsonb,                              -- AI's full structured read
  event_kind text,                              -- maintenance | purchase | move_out | leasing | note
  property_guess text,                          -- the literal property string AI saw
  property_id uuid,                             -- advisory: registry-resolved (nullable, no FK)
  property_resolution text,                     -- resolved | ambiguous | unknown | skipped
  unit_label text,
  amount numeric,
  vendor text,
  title text,
  summary text,

  question text,                                -- THE one question sent back
  answer text,                                  -- the field reply (Yes / No / Not sure / free text)

  status text not null default 'captured',      -- captured → answered → routed | recorded | dismissed
  routed_kind text,                             -- work_order | money_event | none
  routed_id uuid,                               -- recorded tie to the real record (NOT an FK)
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ix_intake_events_status
  on intake_events(status, created_at desc);
create index if not exists ix_intake_events_property
  on intake_events(property_id) where property_id is not null;
