-- ════════════════════════════════════════════════════════════════════
--  LEASING LEAD INTAKE — migration NNN  (re-rooted onto persons)
--
--  RENUMBER BEFORE DEPLOY: rename NNN_ to the next free 3-digit number.
--  FLOOR IS 038 — 032/033/034 are the lease pipeline and 036/037 are the
--  income rung (037 written even if not yet applied; the runner skips by
--  NUMBER, so reusing 037 is a silent no-op). Confirm with:
--    select version,name from schema_migrations order by version desc limit 5;
--
--  THE IDENTITY DOCTRINE (Kameron, locked):
--    ONE HUMAN, MANY PROPERTY-SPECIFIC OPPORTUNITIES.
--      • persons              = one real human across the whole portfolio.
--                               Already exists (001 baseline) with
--                               lifecycle_status / leasing_stage / source /
--                               interested_unit_id. We do NOT create a second
--                               identity universe — leads re-root here.
--      • leasing_leads        = ONE property/unit interest (an opportunity).
--                               person_id is NOT NULL: every opportunity has a
--                               human. No name/phone/email here — those live on
--                               persons. Sarah hitting Zillow for Solo AND the
--                               website for Felix = one person, TWO opportunity
--                               rows, separate funnels.
--      • lead_source_touches  = every external touch. Attribution lives HERE,
--                               never on persons.source (which is first-touch
--                               acquisition credit only).
--      • lead_events          = what happened in THIS opportunity's funnel
--                               (source of truth; leasing_leads.status is a
--                               projection of it).
--      • leasing_tours        = a real tour object for this opportunity.
--      • lead_takeover_queue  = the on-site team's work item for this opportunity.
--
--  Dedup is GLOBAL at the human layer (persons), PROPERTY-SCOPED at the
--  opportunity layer (leasing_leads). Person is created at intake — a dead
--  lead is still truth (ghosts = wasted spend + wasted attention, and must
--  be countable). Messaging reuses comm_events / conversations + sms.js.
--  No enums: CHECK against a text list everywhere.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. LEAD SOURCES ──────────────────────────────────────────────────
create table if not exists lead_sources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  source_type   text not null
                  check (source_type in ('ils','website','paid_ad','organic','manual')),
  monthly_cost  numeric(12,2) not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (name)
);

insert into lead_sources (name, source_type, monthly_cost) values
  ('Zillow',          'ils',     0),
  ('Apartments.com',  'ils',     0),
  ('Website',         'website', 0),
  ('Facebook',        'paid_ad', 0),
  ('Google',          'paid_ad', 0),
  ('Walk-in',         'manual',  0),
  ('Referral',        'organic', 0)
on conflict (name) do nothing;

-- ── 2. LEASING LEADS — a property-scoped OPPORTUNITY tied to a person ──
--  No name/phone/email: identity lives on persons. person_id NOT NULL.
create table if not exists leasing_leads (
  id                  uuid primary key default gen_random_uuid(),
  person_id           uuid not null references persons(id),
  property_id         uuid not null references properties(id),
  unit_id             uuid references units(id),
  -- the source/listing that FIRST opened THIS opportunity. Later arrivals are
  -- rows in lead_source_touches, not new opportunities.
  source_id           uuid references lead_sources(id),
  source_lead_id      text,
  source_listing_id   text,
  message             text,
  -- PROJECTION of lead_events for THIS opportunity. Module recomputes it; not
  -- hand-edited. Held for fast list/board reads.
  status              text not null default 'new'
                        check (status in (
                          'new','ai_responded','tour_requested','tour_scheduled',
                          'human_takeover','applied','leased','lost')),
  received_at         timestamptz not null default now(),
  first_response_at   timestamptz,
  tour_scheduled_at   timestamptz,
  human_takeover_at   timestamptz,
  raw_payload         jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists leasing_leads_person_idx   on leasing_leads(person_id);
create index if not exists leasing_leads_property_idx on leasing_leads(property_id);
create index if not exists leasing_leads_status_idx   on leasing_leads(status);
-- One open opportunity per (person, property): a repeat touch for the same
-- building reuses the opportunity instead of spawning a duplicate. Closed
-- opportunities (leased/lost) are exempt so a returning prospect can start
-- fresh. Partial unique on the active set.
create unique index if not exists leasing_leads_one_open_per_person_property
  on leasing_leads(person_id, property_id)
  where status not in ('leased','lost');

-- ── 3. SOURCE TOUCHES (attribution lives here) ───────────────────────
create table if not exists lead_source_touches (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references leasing_leads(id) on delete cascade,
  person_id          uuid not null references persons(id),
  source_id          uuid not null references lead_sources(id),
  source_lead_id     text,
  source_listing_id  text,
  arrived_at         timestamptz not null default now(),
  raw_payload        jsonb
);
create index if not exists lead_source_touches_lead_idx   on lead_source_touches(lead_id);
create index if not exists lead_source_touches_person_idx on lead_source_touches(person_id);
create index if not exists lead_source_touches_source_idx on lead_source_touches(source_id);

-- ── 4. LEAD EVENTS (the funnel log — SOURCE OF TRUTH) ────────────────
create table if not exists lead_events (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leasing_leads(id) on delete cascade,
  event_type  text not null
                check (event_type in (
                  'lead_received','ai_text_sent','prospect_replied',
                  'tour_requested','tour_scheduled','human_takeover',
                  'application_started','lease_signed','lost')),
  event_at    timestamptz not null default now(),
  actor_type  text not null
                check (actor_type in ('ai','human','system','prospect')),
  actor_id    uuid,
  comm_event_id uuid,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists lead_events_lead_idx on lead_events(lead_id);
create index if not exists lead_events_type_idx on lead_events(event_type);
create index if not exists lead_events_at_idx   on lead_events(event_at);

-- ── 5. TOURS (a real object) ─────────────────────────────────────────
create table if not exists leasing_tours (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references leasing_leads(id) on delete cascade,
  property_id     uuid not null references properties(id),
  unit_id         uuid references units(id),
  requested_for   timestamptz,
  scheduled_for   timestamptz,
  status          text not null default 'requested'
                    check (status in ('requested','confirmed','completed','no_show','cancelled')),
  confirmed_by    uuid references persons(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists leasing_tours_lead_idx     on leasing_tours(lead_id);
create index if not exists leasing_tours_property_idx on leasing_tours(property_id);
create index if not exists leasing_tours_status_idx   on leasing_tours(status);

-- ── 6. HUMAN TAKEOVER QUEUE (a real queue) ───────────────────────────
create table if not exists lead_takeover_queue (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references leasing_leads(id) on delete cascade,
  property_id   uuid not null references properties(id),
  reason        text,
  status        text not null default 'open'
                  check (status in ('open','claimed','resolved')),
  assignee_id   uuid references persons(id),
  claimed_at    timestamptz,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists lead_takeover_open_idx
  on lead_takeover_queue(property_id) where status <> 'resolved';
