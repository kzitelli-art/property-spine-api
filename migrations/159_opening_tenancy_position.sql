-- ════════════════════════════════════════════════════════════════════
--  159 — THE NAME IS NARROWED TO WHAT THE OBJECT ACTUALLY ESTABLISHES
--
--  Migration 157 created `opening_positions` and was explicit in its own
--  header about the scope: "the established current lease and occupancy
--  position." It holds no debt, no taxes, no insurance, no contracts, no
--  bank balances, no GL cutover. It never will — those have different
--  proof, dispute and reconciliation requirements.
--
--  So the name is wrong in the direction that matters. "Opening Position"
--  sounds like the deal's opening state. It is the TENANCY opening state.
--
--    opening_positions          → opening_tenancy_positions
--    opening_position_sources   → opening_tenancy_position_sources
--
--  ── WHY A NEW MIGRATION AND NOT AN EDIT TO 157 ──────────────────────
--  157 is released. It is in the production ledger, and the schema it
--  describes is the schema that ran. Rewriting it would make the ledger
--  describe a history that did not happen — the one thing the ledger
--  exists to prevent. History is corrected by adding to it.
--
--  ── WHY NOW ─────────────────────────────────────────────────────────
--  This object is one day old and production holds almost none. Under the
--  current roadmap, accounting objects point at it within two builds, at
--  which point renaming stops being free and never becomes free again.
--  "Rename it later if it is cheap" is how a name is kept forever.
--
--  ── WHAT THE RESERVED NAMES NOW MEAN ────────────────────────────────
--    Opening Tenancy Position   THIS. Lease and occupancy, from a rent
--                               roll, as of a date. Shown to people as
--                               "Lease & occupancy established".
--    Opening Operating Position LATER. The composed opening state:
--                               tenancy + bank + debt + taxes +
--                               insurance + contracts.
--    Opening Accounting Truth   LATER STILL. Opening GL and subledger
--                               balances. Different proof entirely.
--
--  A hierarchy, so no broad name is spent early on a narrow thing.
--
--  CLASSIFICATION: Class 1. Renames only — no data, no columns, no
--  semantics change. Every dependent object is renamed WITH it, because a
--  rename that leaves its triggers and indexes pointing at the old word
--  is how the next person learns two names for one thing.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. the tables ────────────────────────────────────────────────────
do $$ begin
  if exists (select 1 from information_schema.tables
              where table_name = 'opening_positions')
     and not exists (select 1 from information_schema.tables
                      where table_name = 'opening_tenancy_positions') then
    alter table opening_positions rename to opening_tenancy_positions;
  end if;
end $$;

do $$ begin
  if exists (select 1 from information_schema.tables
              where table_name = 'opening_position_sources')
     and not exists (select 1 from information_schema.tables
                      where table_name = 'opening_tenancy_position_sources') then
    alter table opening_position_sources rename to opening_tenancy_position_sources;
  end if;
end $$;

-- ── 2. the column that names the parent ──────────────────────────────
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_name = 'opening_tenancy_position_sources'
                and column_name = 'opening_position_id') then
    alter table opening_tenancy_position_sources
      rename column opening_position_id to opening_tenancy_position_id;
  end if;
end $$;

-- ── 3. indexes ───────────────────────────────────────────────────────
alter index if exists uq_opening_position_current_per_property
  rename to uq_opening_tenancy_position_current_per_property;
alter index if exists ix_opening_positions_deal
  rename to ix_opening_tenancy_positions_deal;
alter index if exists ix_opening_positions_property
  rename to ix_opening_tenancy_positions_property;

-- ── 4. the functions, rewritten under their new names ────────────────
--  A trigger function carries its own error prose. Renaming the table and
--  leaving the message saying "opening position" would put the old
--  vocabulary in front of an operator at the exact moment they are being
--  refused — which is where product language matters most.
drop trigger if exists trg_opening_positions_append_only on opening_tenancy_positions;
drop trigger if exists trg_opening_position_shape on opening_tenancy_positions;
drop function if exists public.opening_positions_are_append_only();
drop function if exists public.opening_position_shape_at_commit();

create or replace function public.opening_tenancy_positions_are_append_only()
returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'an established lease and occupancy position may not be deleted'
      using errcode = 'restrict_violation',
            detail  = 'It is the record that occupancy was established on a date, from '
                   || 'named sources. Establish a new one instead; this becomes superseded.';
  end if;

  if new.property_id            is distinct from old.property_id
     or new.activation_id       is distinct from old.activation_id
     or new.import_batch_id     is distinct from old.import_batch_id
     or new.as_of_date          is distinct from old.as_of_date
     or new.positions_established is distinct from old.positions_established
     or new.positions_unresolved  is distinct from old.positions_unresolved
     or new.source_rows_read      is distinct from old.source_rows_read
     or new.established_by_user_id is distinct from old.established_by_user_id
     or new.authority_basis     is distinct from old.authority_basis
     or new.established_at      is distinct from old.established_at then
    raise exception 'what was established may not be rewritten'
      using errcode = 'restrict_violation',
            detail  = 'These counts and sources are what was true when occupancy was '
                   || 'established. Re-deriving them answers what is true NOW, which is a '
                   || 'different question and has its own read.',
            hint    = 'Establish again from the newer rent roll; this one becomes superseded.';
  end if;

  if old.status = 'superseded' and new.status <> 'superseded' then
    raise exception 'a superseded position may not be re-established'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$ language plpgsql;
alter function public.opening_tenancy_positions_are_append_only() set search_path = public, pg_temp;

create trigger trg_opening_tenancy_positions_append_only
  before update or delete on opening_tenancy_positions
  for each row execute function public.opening_tenancy_positions_are_append_only();

--  Still deferred, and still re-reads the row rather than trusting `new`.
--  See 157 for why: superseding takes two statements and each queued
--  firing carries that statement's image of the row.
create or replace function public.opening_tenancy_position_shape_at_commit()
returns trigger as $$
declare r record;
begin
  select status, superseded_by_id, superseded_at into r
    from opening_tenancy_positions where id = new.id;
  if not found then return null; end if;

  if r.status = 'established'
     and (r.superseded_by_id is not null or r.superseded_at is not null) then
    raise exception 'an established position cannot also be superseded'
      using errcode = 'check_violation';
  end if;
  if r.status = 'superseded'
     and (r.superseded_by_id is null or r.superseded_at is null) then
    raise exception 'a superseded position must name what superseded it, and when'
      using errcode = 'check_violation',
            detail  = 'Otherwise the history says a position stopped being current and '
                   || 'cannot say what replaced it.';
  end if;
  return null;
end;
$$ language plpgsql;
alter function public.opening_tenancy_position_shape_at_commit() set search_path = public, pg_temp;

create constraint trigger trg_opening_tenancy_position_shape
  after insert or update on opening_tenancy_positions
  deferrable initially deferred
  for each row execute function public.opening_tenancy_position_shape_at_commit();

-- ── 5. the creation-source vocabulary follows the rename ─────────────
--  migration 154 named the surface 'asset_management_console'. That
--  surface is Deal Setup now, and a creation source that names a product
--  we deliberately did NOT build would be the most misleading value in
--  the table. The old value is kept because rows already carry it — they
--  record what was true when they were written.
alter table deal_creation_events
  drop constraint if exists ck_dce_source;

alter table deal_creation_events
  add constraint ck_dce_source check (creation_source in (
    'deal_setup_console',        -- the Deal Setup surface
    'asset_management_console',  -- ⏳ historical: the same surface, before 159 renamed it
    'deal_intake_api',
    'legacy_backfill'));
