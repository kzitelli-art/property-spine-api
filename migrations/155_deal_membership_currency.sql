-- ════════════════════════════════════════════════════════════════════
--  155 — ONE CURRENT DEAL PER PROPERTY, WITHOUT DESTROYING HISTORY
--
--  `deal_intake_properties` (migration 025) is the membership table and it
--  is correct — "the HUMAN picks which properties are in the deal… a
--  mention is never membership." It is reused, not replaced.
--
--  What it cannot say is WHEN a membership stopped being true. Its only
--  constraint is `unique (intake_id, property_id)`, so a property may sit
--  in unlimited deals simultaneously and nothing distinguishes "this
--  building is in this deal" from "this building was, in 2024."
--
--  ── THE TRAP THIS AVOIDS ────────────────────────────────────────────
--  The obvious fix is `unique (property_id)`. It is wrong, permanently:
--  a building really is sold, re-acquired, moved between deals, and
--  refinanced into a new one. A global uniqueness constraint makes the
--  FIRST deal the only deal a property may ever have had, and the day
--  someone needs that history the only way to record it is to delete the
--  row that proves it.
--
--  So currency is a STATE, and uniqueness is scoped to it:
--      unique (property_id) WHERE status = 'current'
--
--  One current membership. Unlimited released ones. History is additive.
--
--  This constrains MEMBERSHIP ONLY. It says nothing about which facts
--  belong to which property — cross-property economic facts are real and
--  are not what this table is for.
--
--  CLASSIFICATION: Class 1. Additive; existing rows become 'current'.
-- ════════════════════════════════════════════════════════════════════

alter table deal_intake_properties
  add column if not exists status text not null default 'current';

alter table deal_intake_properties
  add column if not exists released_at timestamptz;

alter table deal_intake_properties
  add column if not exists released_reason text;

alter table deal_intake_properties
  add column if not exists added_by_user_id uuid references users(id);

alter table deal_intake_properties
  add column if not exists authority_basis text;

do $$ begin
  alter table deal_intake_properties add constraint ck_dip_status
    check (status in ('current','released'));
exception when duplicate_object then null; end $$;

--  RELEASED MEANS RELEASED — a released membership carries when, a current
--  one does not. Without this, `status` drifts from `released_at` and the
--  history becomes unreadable in exactly the way it exists to prevent.
do $$ begin
  alter table deal_intake_properties add constraint ck_dip_released_shape
    check ((status = 'current'  and released_at is null)
        or (status = 'released' and released_at is not null));
exception when duplicate_object then null; end $$;

-- ── THE CURRENCY CONSTRAINT ──────────────────────────────────────────
--  Pre-existing data first: if any property already sits in more than one
--  intake, the index below cannot be created. Rather than fail the
--  migration or silently pick a winner, the OLDEST membership stays
--  current and the rest are released with a reason that says exactly what
--  happened, so the situation is inspectable afterwards.
with ranked as (
  select id, property_id, created_at,
         row_number() over (partition by property_id order by created_at asc, id asc) as rn
    from deal_intake_properties
   where status = 'current'
)
update deal_intake_properties dp
   set status = 'released',
       released_at = now(),
       released_reason = 'superseded_by_currency_constraint_migration_155'
  from ranked r
 where dp.id = r.id and r.rn > 1;

create unique index if not exists uq_dip_one_current_deal_per_property
  on deal_intake_properties (property_id)
  where status = 'current';

create index if not exists ix_dip_intake_status
  on deal_intake_properties (intake_id, status);
