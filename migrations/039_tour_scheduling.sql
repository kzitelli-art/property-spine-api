-- ════════════════════════════════════════════════════════════════════
--  TOUR SCHEDULING — migration 039  (the show-rate instrument)
--
--  Floor is 039 (035/036/037/038 applied). The runner skips by NUMBER,
--  so confirm with:
--    select version,name from schema_migrations order by version desc limit 6;
--
--  DOCTRINE (Kameron, locked):
--    A scheduled tour is a CLAIM. A completed tour is PROOF. A no_show is
--    EXPOSURE. This is NOT a calendar — it is the proof instrument between
--    marketing demand and a human physically showing up.
--
--  GRAIN (the load-bearing decision):
--    • lead_events   = the OPPORTUNITY's funnel log (038, source of truth for
--                      leasing_leads.status). UNCHANGED here. It records that an
--                      opportunity REACHED the tour-scheduled milestone, not the
--                      blow-by-blow of one tour.
--    • tour_events   = NEW. The finer-grain lifecycle of ONE tour object. A
--                      reschedule-as-new-tour, a no_show then rebook, a returning
--                      prospect — each tour carries its own honest history here.
--    The two logs SYNC ONLY AT THE SEAMS (the module enforces this, not the DB):
--      scheduled  → also writes lead_events 'tour_scheduled' (funnel advances)
--      completed / no_show → the funnel proceeds toward application OR the
--                      opportunity's exposure is recorded.
--    Inside those seams the tour's lifecycle is its own log. Show rate is a
--    property of the TOUR, computed tour-by-tour from tour_events — never a
--    filtered scan of the funnel log.
--
--  STATUS IS A PROJECTION. leasing_tours.status is a cache of the latest
--  tour_event. The module writes it through ONE DOOR (recordTourEvent):
--  event row first, projection second, same transaction. No code path writes
--  status alone. (Same discipline 038's recordLeadEvent already uses.)
--
--  TWO TRUTH POINTS. 'confirmed_by_prospect' and 'checked_in' are the only
--  honest inputs to show rate, because they require an OUTSIDE party to do an
--  OUTSIDE thing (the prospect replies; on-site taps arrived). Their event rows
--  carry actor_type/actor_id so a real arrival is distinguishable from a hopeful
--  one. The module reserves 'checked_in' to the on-site queue writer; the system
--  may assert the others (scheduled, reminder_sent, completed-by-timeout,
--  cancelled).
--
--  AGENT ATTRIBUTION. leasing_tours.leasing_agent_id is added now, NULLABLE,
--  FK users(id) — a leasing agent is STAFF (users + property_team_assignments),
--  NOT a persons row (persons = prospects/tenants). The column is cheap now and
--  impossible to backfill later: property owns the opportunity, agent owns
--  execution. Existing confirmed_by (FK persons) is left AS-IS to avoid breaking
--  the live confirm handler; agent ownership rides on the new column.
--  No enums anywhere: CHECK against a text list.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. EVOLVE leasing_tours ──────────────────────────────────────────
--  038 shipped status CHECK = requested|confirmed|completed|no_show|cancelled.
--  The instrument needs the finer lifecycle. Widen the CHECK and add the
--  columns the show-rate system pins to. Additive + idempotent.

alter table leasing_tours add column if not exists leasing_agent_id uuid references users(id);
alter table leasing_tours add column if not exists slot_id          uuid;  -- FK added after tour_availability exists (below)
alter table leasing_tours add column if not exists confirmed_at     timestamptz;  -- prospect-confirmation seam
alter table leasing_tours add column if not exists reminded_at      timestamptz;
alter table leasing_tours add column if not exists checked_in_at    timestamptz;  -- TRUTH POINT
alter table leasing_tours add column if not exists completed_at     timestamptz;
alter table leasing_tours add column if not exists no_show_at       timestamptz;
alter table leasing_tours add column if not exists cancelled_at     timestamptz;
alter table leasing_tours add column if not exists rescheduled_from uuid references leasing_tours(id); -- the prior tour, if this is a rebook

-- DROP the old 038 CHECK FIRST. The cleanup below sets rows to NEW status words
-- ('confirmed_by_prospect') that the OLD check forbids — so the old constraint
-- must be gone before we rewrite the data, or the UPDATE is rejected by the old
-- rule. Order is: drop old → migrate data → add new.
alter table leasing_tours drop constraint if exists leasing_tours_status_check;

-- Now migrate any EXISTING rows off the old 038 status words. 038 allowed
-- 'confirmed'; the instrument renames that to 'confirmed_by_prospect' (same
-- meaning — a confirmed tour).
update leasing_tours set status = 'confirmed_by_prospect' where status = 'confirmed';
-- safety net: park any other unexpected legacy status as 'requested' (the
-- neutral carryover state) so the migration can never be blocked by a stray
-- value. Idempotent — only touches rows outside the new vocabulary.
update leasing_tours set status = 'requested'
  where status not in ('requested','scheduled','confirmed_by_prospect','checked_in',
                       'completed','no_show','cancelled','rescheduled');

-- Finally add the widened CHECK with the full instrument vocabulary.
alter table leasing_tours
  add constraint leasing_tours_status_check
  check (status in (
    'requested',            -- asked for a tour, no real slot yet (038 carryover)
    'scheduled',            -- booked onto a real availability slot (CLAIM)
    'confirmed_by_prospect',-- prospect affirmed they're coming (TRUTH INPUT)
    'checked_in',           -- on-site marked them arrived (TRUTH POINT)
    'completed',            -- tour actually happened (PROOF)
    'no_show',              -- booked, never showed (EXPOSURE)
    'cancelled',            -- called off before the slot
    'rescheduled'           -- this tour was moved; a successor tour carries on
  ));

-- ── 2. tour_events — the tour-lifecycle log (SOURCE OF TRUTH per tour) ─
--  One row per transition. leasing_tours.status projects the latest of these.
--  actor_type/actor_id make the two truth points honest: who asserted arrival.
create table if not exists tour_events (
  id          uuid primary key default gen_random_uuid(),
  tour_id     uuid not null references leasing_tours(id) on delete cascade,
  lead_id     uuid not null references leasing_leads(id) on delete cascade, -- denormalized for fast funnel joins
  event_type  text not null
                check (event_type in (
                  'scheduled','confirmed_by_prospect','reminder_sent',
                  'checked_in','completed','no_show','cancelled','rescheduled'
                )),
  event_at    timestamptz not null default now(),
  actor_type  text not null
                check (actor_type in ('ai','human','system','prospect')),
  actor_id    uuid,                 -- users.id for staff, persons.id for prospect; nullable for system
  slot_id     uuid,                 -- the availability slot in play, when relevant
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists tour_events_tour_idx on tour_events(tour_id);
create index if not exists tour_events_lead_idx on tour_events(lead_id);
create index if not exists tour_events_type_idx on tour_events(event_type);
create index if not exists tour_events_at_idx   on tour_events(event_at);

-- ── 3. tour_availability — Spine-owned slots (the truth, not Google) ──
--  Slots are OPENED inside Spine by property (and optionally a specific agent).
--  The AI offers ONLY rows that are 'open'. A booking flips a slot to 'booked'
--  and is walled against double-booking by a partial unique index below.
create table if not exists tour_availability (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references properties(id) on delete cascade,
  unit_id          uuid references units(id),                 -- optional: slot can be unit-specific
  leasing_agent_id uuid references users(id),                 -- optional: NULL = any agent / property-level
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  capacity         integer not null default 1 check (capacity >= 1),
  status           text not null default 'open'
                     check (status in ('open','booked','blocked','cancelled')),
  booked_tour_id   uuid references leasing_tours(id) on delete set null,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists tour_availability_property_idx on tour_availability(property_id);
create index if not exists tour_availability_agent_idx    on tour_availability(leasing_agent_id);
create index if not exists tour_availability_starts_idx   on tour_availability(starts_at);
-- the AI's "open slots for this property" read, kept tight:
create index if not exists tour_availability_open_idx
  on tour_availability(property_id, starts_at) where status = 'open';

-- ── 4. THE DOUBLE-BOOKING WALL ───────────────────────────────────────
--  Structural, not behavioral — same discipline as 038's one-open-opportunity
--  partial unique index. A given availability slot can back AT MOST ONE live
--  tour. Enforced at the slot layer: at most one 'booked' row may point a tour
--  at a slot via booked_tour_id, AND a tour may hold at most one slot.
--  (Capacity>1 group tours are a later rung; v1 capacity defaults to 1 and the
--  wall assumes single-occupancy slots.)
create unique index if not exists tour_availability_one_booking_per_slot
  on tour_availability(id) where status = 'booked';
-- a slot, once booked, names exactly one tour; a tour names at most one slot:
create unique index if not exists leasing_tours_one_slot
  on leasing_tours(slot_id) where slot_id is not null;

-- Now that tour_availability exists, point the tour's slot_id at it.
alter table leasing_tours
  drop constraint if exists leasing_tours_slot_id_fkey;
alter table leasing_tours
  add constraint leasing_tours_slot_id_fkey
  foreign key (slot_id) references tour_availability(id) on delete set null;

-- ════════════════════════════════════════════════════════════════════
--  WHAT v1 DELIBERATELY DOES NOT DO (later rungs, not scope creep here):
--    • No Google/Outlook sync — Spine-owned slots are the source of truth.
--    • No show-rate DASHBOARD — that's a later query against tour_events, which
--      will already be true. Build the instrument; reports come later.
--    • No capacity>1 group tours — capacity column exists for forward-compat;
--      the wall assumes single-occupancy in v1.
--    • Reminder SENDING reuses sms.js (env-gated like 038 intake); the schema
--      only records reminder_sent. Wiring the actual outbound is operational.
-- ════════════════════════════════════════════════════════════════════
