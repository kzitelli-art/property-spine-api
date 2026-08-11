-- ════════════════════════════════════════════════════════════════════
--  157 — OPENING POSITION: the outcome, not a second rent roll
--
--  Activation is the PROCESS:
--    source → ingest → evidence → proposal → review → canonical records
--
--  Opening Position is the STATEMENT that comes out of it:
--    "As of 30 April, this is the established current lease and occupancy
--     position for this property, from these sources, with these
--     remaining exceptions."
--
--  ── WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────
--  It is NOT a copy of the rent roll. There is no row per lease here, and
--  there must never be one. Duplicating leases into this table would
--  create a second place where occupancy is stated, and within a month the
--  two would disagree — which is precisely the "parallel truth store"
--  failure this build exists to avoid.
--
--  Operating truth remains, unchanged and canonical:
--      units · spaces · persons · leases · the dated position reads
--
--  This table holds the ESTABLISHING ACT: what was established, from
--  what, by whom, when, as of when, and what was left unresolved. Every
--  actual position is read through the canonical services, reachable from
--  here by `import_batch_id`.
--
--  ── WHY THE COUNTS ARE STORED AND NOT DERIVED ───────────────────────
--  `positions_established` and `positions_unresolved` are what was true AT
--  THE MOMENT OF ESTABLISHING. Re-deriving them later answers a different
--  question — what is true now — and quietly rewrites history each time
--  someone confirms one more row. Both questions are worth answering; they
--  are not the same question, so the historical one is stored.
--
--  ── 'Opening Truth' IS NOT THIS ─────────────────────────────────────
--  That term is reserved for the later accounting conversion — opening GL
--  and subledger balances. Nothing in this table is an accounting balance
--  and nothing here should ever be called truth.
--
--  CLASSIFICATION: Class 1.
-- ════════════════════════════════════════════════════════════════════

create table if not exists opening_positions (
  id                    uuid primary key default gen_random_uuid(),

  --  WHAT IT IS ABOUT. Property-scoped, because an occupancy position is
  --  a fact about a building. The deal is recorded because that is how the
  --  human got here and how Asset Management will read it back — not
  --  because the position belongs to the deal.
  property_id           uuid not null references properties(id),
  deal_intake_id        uuid references deal_intakes(id),

  --  HOW IT WAS ESTABLISHED. The activation is the process that produced
  --  it; the batch is the evidence substrate, and through the batch, the
  --  retained file.
  activation_id         uuid not null references activations(id),
  import_batch_id       uuid references import_batches(id),

  --  WHEN THE POSITION IS TRUE. From the document, never from the clock.
  as_of_date            date not null,

  --  WHAT WAS ESTABLISHED, as of the establishing act. See above.
  positions_established integer not null default 0 check (positions_established >= 0),
  positions_unresolved  integer not null default 0 check (positions_unresolved  >= 0),
  source_rows_read      integer not null default 0 check (source_rows_read      >= 0),

  --  WHO. Server-derived, both identities, same as every governed write.
  established_by_user_id uuid references users(id),
  established_by_person_id uuid references persons(id),
  authority_basis       text not null,
  established_at        timestamptz not null default now(),

  --  A position is superseded by a later one, never edited into a
  --  different position. The old statement stays true of the day it was
  --  made.
  status                text not null default 'established'
                          check (status in ('established','superseded')),
  superseded_by_id      uuid references opening_positions(id),
  superseded_at         timestamptz
);

--  ── WHY THE SHAPE RULE IS A DEFERRED TRIGGER AND NOT A CHECK ────────
--  Superseding is necessarily two statements: the old position must stop
--  being current BEFORE the new one can be inserted (the partial unique
--  index below permits exactly one 'established' row per property), and
--  the old row cannot name its successor until that successor exists.
--
--  As an immediate CHECK, those two facts deadlock: mark it superseded and
--  it has no superseded_by_id yet; insert first and the unique index
--  refuses. Written as a CHECK, the only way out is to weaken the rule and
--  allow a superseded position that names nothing — which is exactly the
--  state that makes history unreadable.
--
--  So it is checked at COMMIT instead, when both statements have run. The
--  intermediate state is invisible to every other transaction, and the
--  rule at rest is unchanged. Same technique migration 140 uses for the
--  completion guard, and for the same reason.
create or replace function public.opening_position_shape_at_commit()
returns trigger as $$
declare r record;
begin
  --  ⚠ IT MUST RE-READ THE ROW, NOT TRUST `new`.
  --  A deferred constraint trigger fires once per statement that touched
  --  the row, and each queued firing carries THAT STATEMENT'S image of it.
  --  Superseding takes two statements — mark superseded, then name the
  --  successor — so the first firing's `new` still has a null
  --  superseded_by_id and would fail at commit even though the row is
  --  correct by then. Measured, not feared: this trigger rejected a
  --  perfectly valid supersession until it re-read.
  --
  --  Reading the row at commit asks the question that actually matters —
  --  is this row well-formed NOW — instead of whether an intermediate
  --  step looked well-formed in isolation.
  select status, superseded_by_id, superseded_at into r
    from opening_positions where id = new.id;
  if not found then
    return null;                       -- deleted later in this transaction
  end if;

  if r.status = 'established'
     and (r.superseded_by_id is not null or r.superseded_at is not null) then
    raise exception 'an established opening position cannot also be superseded'
      using errcode = 'check_violation';
  end if;
  if r.status = 'superseded'
     and (r.superseded_by_id is null or r.superseded_at is null) then
    raise exception 'a superseded opening position must name what superseded it, and when'
      using errcode = 'check_violation',
            detail  = 'Otherwise the history says a position stopped being current and '
                   || 'cannot say what replaced it.';
  end if;
  return null;
end;
$$ language plpgsql;
alter function public.opening_position_shape_at_commit() set search_path = public, pg_temp;

drop trigger if exists trg_opening_position_shape on opening_positions;
create constraint trigger trg_opening_position_shape
  after insert or update on opening_positions
  deferrable initially deferred
  for each row execute function public.opening_position_shape_at_commit();

--  ONE CURRENT OPENING POSITION PER PROPERTY. Re-establishing supersedes;
--  it does not accumulate ambiguity.
create unique index if not exists uq_opening_position_current_per_property
  on opening_positions (property_id) where status = 'established';

create index if not exists ix_opening_positions_deal
  on opening_positions (deal_intake_id, established_at desc);
create index if not exists ix_opening_positions_property
  on opening_positions (property_id, established_at desc);

-- ── SOURCES: plural on purpose ───────────────────────────────────────
--  V1 establishes from one rent roll, and one artifact reached through the
--  batch would answer today's question. It is a join table anyway, because
--  "from these sources" is part of the statement being made and a position
--  established from a rent roll plus a correction file is the ordinary
--  next case — not a hypothetical one.
create table if not exists opening_position_sources (
  id                  uuid primary key default gen_random_uuid(),
  opening_position_id uuid not null references opening_positions(id) on delete cascade,
  source_artifact_id  uuid not null references source_artifacts(id),
  role                text not null default 'rent_roll'
                        check (role in ('rent_roll','correction','other')),
  created_at          timestamptz not null default now(),
  unique (opening_position_id, source_artifact_id)
);

-- ── THE STATEMENT IS IMMUTABLE ───────────────────────────────────────
--  Everything about what was established is frozen. Only the supersession
--  columns may move, and only forwards: established → superseded, once.
create or replace function public.opening_positions_are_append_only()
returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'an opening position may not be deleted'
      using errcode = 'restrict_violation',
            detail  = 'It is the record that a position was established on a date, from '
                   || 'named sources. Supersede it instead.';
  end if;

  if new.property_id     is distinct from old.property_id
     or new.activation_id is distinct from old.activation_id
     or new.import_batch_id is distinct from old.import_batch_id
     or new.as_of_date   is distinct from old.as_of_date
     or new.positions_established is distinct from old.positions_established
     or new.positions_unresolved  is distinct from old.positions_unresolved
     or new.source_rows_read      is distinct from old.source_rows_read
     or new.established_by_user_id is distinct from old.established_by_user_id
     or new.authority_basis is distinct from old.authority_basis
     or new.established_at  is distinct from old.established_at then
    raise exception 'what an opening position established may not be rewritten'
      using errcode = 'restrict_violation',
            detail  = 'These counts and sources are what was true when the position was '
                   || 'established. Re-deriving them answers what is true NOW, which is a '
                   || 'different question and has its own read.',
            hint    = 'Establish a new position; this one becomes superseded.';
  end if;

  if old.status = 'superseded' and new.status <> 'superseded' then
    raise exception 'a superseded opening position may not be re-established'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$ language plpgsql;
alter function public.opening_positions_are_append_only() set search_path = public, pg_temp;

drop trigger if exists trg_opening_positions_append_only on opening_positions;
create trigger trg_opening_positions_append_only
  before update or delete on opening_positions
  for each row execute function public.opening_positions_are_append_only();
