-- ════════════════════════════════════════════════════════════════════
--  180_inventory_retirement.sql
--
--  ONE FACT: a previously promoted inventory record is RETAINED AS HISTORY
--  but no longer participates in current rentable inventory.
--
--  ── WHY THIS EXISTS ────────────────────────────────────────────────
--  Skyline holds two inventory representations of the same building. A
--  2020 rent roll modelled each bed as a UNIT — `101 - A`, `101 - B` —
--  and 159 of those candidates were promoted to units on 2026-06-12,
--  before Spine had a by-bed model. The 2026 import then established the
--  real structure: 72 physical units, 160 beds.
--
--  The 159 are WRONG as current inventory and REAL as promotion history.
--  Every canonical tenancy read counts them today, so the property reads
--  391 rentable positions against 160 beds.
--
--  ── WHY NOT DELETE THEM ────────────────────────────────────────────
--  `ingest_candidates.promoted_unit_id` is ON DELETE SET NULL. Deleting
--  the units would succeed and would quietly null 159 pointers, leaving
--  the system asserting that a promotion happened while destroying the
--  identity of what it produced. Preserving a claim and deleting its
--  subject is the failure this table exists to avoid.
--
--  ── WHY NOT A COLUMN ON units ──────────────────────────────────────
--  `units.operating_use` already means 'standard' | 'model'. It is a
--  description of how a real position is used, not a lifecycle, and
--  overloading it would spend a live operating word on a correction.
--  Retirement is also an EVENT with an actor, a time and a rationale —
--  none of which a boolean on the physical row can carry.
--
--  ── WHAT A ROW HERE PROMISES ───────────────────────────────────────
--    · the unit still exists, and cannot be deleted while retired
--      (ON DELETE RESTRICT, deliberately)
--    · WHO retired it and WHEN
--    · WHY — a governed reason code plus the rationale in words
--    · WHAT SUPERSEDES IT — the import batch that established the
--      correct representation
--    · the promotion lineage CAPTURED AT RETIREMENT TIME, so it survives
--      even if the ON DELETE SET NULL pointer is ever nulled
--    · reversibility, because a correction that cannot be undone is not
--      a correction
--
--  Nothing here is Skyline-specific. This is the general statement that
--  an old inventory interpretation has been superseded.
--
--  CLASS 1 — permanent product primitive.
-- ════════════════════════════════════════════════════════════════════

create table if not exists inventory_retirements (
  id                             uuid primary key default gen_random_uuid(),

  --  RESTRICT, not CASCADE and not SET NULL. While a unit is retired it
  --  may not be deleted: the whole point is that the identity survives.
  unit_id                        uuid not null references units(id) on delete restrict,
  property_id                    uuid not null references properties(id) on delete cascade,

  --  WHO AND WHEN. One of the two actor columns is required below; a
  --  correction with no actor is not a correction.
  retired_at                     timestamptz not null default now(),
  retired_by_user_id             uuid references users(id) on delete restrict,
  retired_by_system              text,

  --  WHY, in governed vocabulary rather than free prose alone.
  reason_code                    text not null,
  superseded_rationale           text not null,

  --  WHAT SUPERSEDES IT. The batch that established the correct
  --  representation. Recorded as the citation for the decision — it is
  --  never a predicate any reader filters on.
  superseded_by_import_batch_id  uuid references import_batches(id) on delete set null,

  --  LINEAGE, COPIED HERE ON PURPOSE. ingest_candidates.promoted_unit_id
  --  is ON DELETE SET NULL, so the pointer is not durable. These columns
  --  are, and they are plain uuid/text rather than FKs precisely so that
  --  the record of what was promoted cannot be nulled out from under it.
  promoted_from_candidate_id     uuid,
  promoted_from_ingest_run_id    uuid,
  original_unit_number           text not null,

  --  REVERSAL. A retirement that cannot be undone would make this table
  --  more dangerous than the defect it corrects.
  reversed_at                    timestamptz,
  reversed_by_user_id            uuid references users(id) on delete restrict,
  reversal_reason                text,

  created_at                     timestamptz not null default now()
);

--  An actor is mandatory. A system actor is allowed and must NAME itself.
alter table inventory_retirements drop constraint if exists ck_inv_retire_actor;
alter table inventory_retirements add constraint ck_inv_retire_actor
  check (retired_by_user_id is not null or (retired_by_system is not null and length(btrim(retired_by_system)) > 0));

--  The reason vocabulary is governed, and starts at exactly one value.
--  A second value is a deliberate migration, not a string somebody types.
alter table inventory_retirements drop constraint if exists ck_inv_retire_reason;
alter table inventory_retirements add constraint ck_inv_retire_reason
  check (reason_code in ('superseded_by_corrected_inventory_grain'));

--  A rationale that is blank explains nothing.
alter table inventory_retirements drop constraint if exists ck_inv_retire_rationale;
alter table inventory_retirements add constraint ck_inv_retire_rationale
  check (length(btrim(superseded_rationale)) >= 20);

--  A reversal also has an actor and a reason.
alter table inventory_retirements drop constraint if exists ck_inv_retire_reversal;
alter table inventory_retirements add constraint ck_inv_retire_reversal
  check (
    (reversed_at is null and reversed_by_user_id is null and reversal_reason is null)
    or
    (reversed_at is not null and reversed_by_user_id is not null
     and length(btrim(coalesce(reversal_reason, ''))) > 0)
  );

--  AT MOST ONE LIVE RETIREMENT PER UNIT. Reversed rows stay as history, so
--  a unit may be retired, reinstated and retired again — but it can never
--  be retired twice at once, which is what would make "is it retired?"
--  ambiguous for the loader.
create unique index if not exists uq_inventory_retirement_live
  on inventory_retirements (unit_id) where reversed_at is null;

--  The loader asks "is this unit retired?" on every property position read.
create index if not exists idx_inventory_retirement_live_unit
  on inventory_retirements (unit_id) where reversed_at is null;
create index if not exists idx_inventory_retirement_property
  on inventory_retirements (property_id, retired_at desc);

--  Provenance stays queryable by where it came from.
create index if not exists idx_inventory_retirement_run
  on inventory_retirements (promoted_from_ingest_run_id);

--  ════════════════════════════════════════════════════════════════════
--   A LEASE MAY NOT ATTACH TO RETIRED INVENTORY.
--
--   Found by probing this table's own first version adversarially. The
--   loader hides retired units, so a lease attached to one is INVISIBLE in
--   every canonical read — datedPropertyPositions returned count=0 with a
--   real active lease sitting there, and no error anywhere. A later rent
--   roll naming a retired unit number would have done exactly that: a
--   write that succeeds and produces nothing anyone can see.
--
--   Reporting it is not enough. Many paths write leases — snapshot_loader,
--   seed_snapshot, Deal Setup, repair tooling — and a rule enforced in one
--   writer is a rule the other writers do not have. The database is the
--   only place that covers all of them, so the invisible state is made
--   IMPOSSIBLE rather than merely visible.
--
--   The escape hatch is reinstatement, which is the honest one: if this is
--   real current inventory, say so and put it back in the reads.
--
--   `inventory_retirements` also refuses to retire a unit that already
--   carries leases (in the canonical writer), so the two guards close the
--   window from both sides.
--  ════════════════════════════════════════════════════════════════════

create or replace function refuse_lease_on_retired_inventory() returns trigger as $$
declare
  v_unit_number text;
begin
  select u.unit_number into v_unit_number
    from spaces s
    join units u on u.id = s.unit_id
    join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
   where s.id = new.space_id
   limit 1;

  if v_unit_number is not null then
    raise exception
      'Unit % is retired from current inventory; a lease attached here would be '
      'invisible in every canonical read. Reinstate the unit first if this is real '
      'current inventory.', v_unit_number
      using errcode = 'check_violation';
  end if;
  return new;
end; $$ language plpgsql;

drop trigger if exists trg_refuse_lease_on_retired_inventory on leases;
create trigger trg_refuse_lease_on_retired_inventory
  before insert or update of space_id on leases
  for each row execute function refuse_lease_on_retired_inventory();

comment on table inventory_retirements is
  'A previously established inventory record retained as history but no longer '
  'participating in current rentable inventory. The unit is never deleted; '
  'ON DELETE RESTRICT enforces that. Read by the canonical tenancy loader.';
