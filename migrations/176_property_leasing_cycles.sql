-- ════════════════════════════════════════════════════════════════════
--  176_property_leasing_cycles.sql
--
--  A NAMED LEASING CYCLE IS PROPERTY CONFIGURATION OVER DATES. Nothing
--  more, and this table is deliberately the smallest thing that can be
--  true.
--
--  ── WHY A NEW TABLE, AND WHY NOT property_leasing_calendar ──────────
--  073 created `property_leasing_calendar` — the lease-END rhythm config
--  that drives lease-end recommendations. It is `unique (property_id)`:
--  one row per property, no history. A cycle table must hold 2026–27 and
--  2027–28 side by side, so the calendar cannot represent this without
--  dropping the constraint that gives it its meaning. Traced in
--  docs/LEASING_CYCLE_AND_PACE_TRACE.md §2. Do not force it.
--
--  ── WHAT THIS IS NOT ────────────────────────────────────────────────
--  NOT a cycle-scoped lease store. NOT a `semester` state. NOT a place
--  to keep a preleased percentage, a committed count, or any derived
--  figure — every one of those is computed from `leases` on read, and
--  storing one would create a second answer that can go stale.
--
--  PHASE_1_NORTH_STAR forbidding-clause 2 stands: no season, cycle or
--  academic year in the CORE. The durable computational primitive is
--  still a pair of dates, and `src/tenancy` never learns the word cycle.
--  A caller resolves label → (start, end) ABOVE the read and passes two
--  dates, exactly as before.
--
--  ── SUPERSESSION, NOT MUTATION ──────────────────────────────────────
--  A cycle's dates are a decision with an author and a date. Editing
--  them in place would silently restate every figure ever derived from
--  them, so a correction supersedes rather than overwrites — the same
--  primitive executed_lease_records and the turn-readiness expectations
--  use, for the same reason.
--
--  ── NO is_current FLAG ──────────────────────────────────────────────
--  Which cycle is current is `cycle_start <= today <= cycle_end` over
--  the live rows. A flag would be a second answer that can rot. Where
--  that expression matches more than one live cycle the resolver
--  REFUSES — ambiguity is answered by a person, never by picking the
--  newest row.
-- ════════════════════════════════════════════════════════════════════

create table if not exists property_leasing_cycles (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,

  --  What a human calls it. Free text on purpose: "2026–27", "FY27",
  --  "Spring 2027" are all legitimate and none of them is a Spine concept.
  cycle_label           text not null,

  --  THE DURABLE PART. Everything downstream consumes these two dates.
  cycle_start           date not null,
  cycle_end             date not null,

  --  Lifecycle. `archived` retires a cycle without deleting the history
  --  of what was derived from it.
  state                 text not null default 'active',

  --  Supersession chain. A superseded row is retained and never read as
  --  configuration.
  supersedes_cycle_id   uuid references property_leasing_cycles(id),
  superseded_by_id      uuid references property_leasing_cycles(id),

  --  Provenance. A configuration row that cannot say who established it
  --  is an assertion, not a governed statement.
  established_by_user_id uuid references users(id) on delete set null,
  established_at        timestamptz not null default now(),
  event_id              uuid references events(id) on delete set null,
  note                  text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint ck_leasing_cycle_state
    check (state in ('active', 'archived', 'superseded')),
  constraint ck_leasing_cycle_span
    check (cycle_end > cycle_start),
  --  A label is how a person names this span. Two live rows with the
  --  same label on one property would make "2026–27" ambiguous in the
  --  one place ambiguity is least acceptable.
  constraint ck_leasing_cycle_label_present
    check (length(trim(cycle_label)) > 0)
);

create unique index if not exists uq_leasing_cycle_live_label
  on property_leasing_cycles (property_id, lower(trim(cycle_label)))
  where state = 'active';

create index if not exists idx_leasing_cycle_property_span
  on property_leasing_cycles (property_id, cycle_start, cycle_end)
  where state = 'active';

comment on table property_leasing_cycles is
  'Property configuration: a named leasing cycle declared OVER a dated span. '
  'The durable computational primitive is the date pair; the label is what a '
  'human calls it. Holds no derived figure — committed counts and preleased '
  'percentages are computed from leases on read. See '
  'docs/LEASING_CYCLE_AND_PACE_TRACE.md §2.';
