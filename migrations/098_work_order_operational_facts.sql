-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 098 — WORK ORDER: OPERATIONAL FACTS ONLY
--
--  A work order stores the facts it actually knows at the moment of work.
--  It does not author money meaning, it does not copy facts another object
--  owns, and it does not flatten several different humans into one column.
--
--  WHY EACH COLUMN LEAVES
--  ---------------------
--  gl_category        A work order must not author money meaning. Money is a
--                     layer THROUGH capture surfaces; reporting READS confirmed
--                     truth and never authors it. migrations/019 already ruled
--                     this in its own header: "Resolution order, applied at
--                     read time, NEVER STORED" and "the vocabulary stays DATA".
--                     GL resolution is a mapping owned by the reporting layer
--                     where category_report_map lives. (Already unwritten as of
--                     the previous commit; the column goes here so one design
--                     change costs one migration, not two.)
--
--  operating_category It was a single enum forced to hold THREE orthogonal
--                     axes: tenant_billback (who bears the cost), capital
--                     (nature of the spend), turn (unit context), and
--                     resident_repair (none of the above). One field can only
--                     hold one, which is exactly why precedence rules had to
--                     exist and why tenant damage in a renovating unit could
--                     not be recorded truthfully. Decomposed below.
--
--  is_capex           A capitalization threshold is cost-based, and final cost
--                     does not exist at capture. A boolean written by a tech in
--                     the field is a determination they are not in a position
--                     to make. Replaced by the OBSERVATION they can make
--                     (work_nature, extends_useful_life); the threshold test
--                     happens downstream where actual cost is known.
--                     Two fields, two moments.
--
--  billback           Whether the property bills a cost back to a resident is a
--                     DECISION: it has an owner, an attribution, and a dispute
--                     path. Doctrine routes money decisions through the
--                     obligation engine, and every obligation has one
--                     accountable human or is explicitly UNASSIGNED. A boolean
--                     silently derived from `cause` had none of those. Replaced
--                     by the observation (tenant_caused); the decision becomes
--                     an obligation. See the NOT-YET note at the bottom.
--
--  unit_state         The unit owns its own state, and state is point-in-time.
--                     A copy taken at capture and a read at report time will
--                     eventually disagree — and when they do, nothing tells us
--                     which was right. Reference the unit; never duplicate the
--                     fact. (§29 keeps physical state and tenancy state
--                     distinct for the same reason.)
--
--  person_id          One column cannot mean "the resident who reported this"
--                     and "the resident whose home is affected" at once. They
--                     are frequently the same human and sometimes are not — a
--                     neighbour reports a leak coming through a shared wall.
--                     Split, and backfilled below before the drop.
--
--  WHAT THE TECH IS ACTUALLY ASKED
--  -------------------------------
--  DOCTRINE.md §5 sets the capture standard: "One question per event, maximum
--  — the single highest-value missing proof ('Was this tenant-caused?').
--  Everything else AI is unsure about goes silently to the review queue."
--  It names this exact question. So tenant_caused is the one field the capture
--  surface asks a human. Every other column added here is NULLABLE and may be
--  filled later by review, by an operator, or never — because an honest unknown
--  is worth more than a confident default, and a field tech should not meet six
--  dropdowns to report a leak.
--
--  Idempotent. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. the observations a work order legitimately knows ──
alter table work_orders add column if not exists tenant_caused        boolean;
alter table work_orders add column if not exists work_nature          text;
alter table work_orders add column if not exists extends_useful_life  boolean;

comment on column work_orders.tenant_caused is
  'OBSERVATION, not a decision: did a human observe that the resident caused this? NULL = not observed. Whether the property BILLS IT BACK is a separate decision that runs through the obligation engine and is never derived from this field.';
comment on column work_orders.work_nature is
  'OBSERVATION a tech can make at capture: repair or replacement. Half of the capital question. The cost threshold test happens downstream where actual cost is known.';
comment on column work_orders.extends_useful_life is
  'OBSERVATION a tech can make at capture: does this extend the useful life of the asset? NULL = not assessed. Never a capitalization determination on its own.';

-- ── 2. the person split — two roles, never one flattened column ──
alter table work_orders add column if not exists reported_by_person_id uuid references persons(id);
alter table work_orders add column if not exists affected_person_id    uuid references persons(id);

comment on column work_orders.reported_by_person_id is
  'The person who REPORTED the issue. NULL when staff-originated. May differ from affected_person_id — a neighbour can report a leak in someone else''s unit.';
comment on column work_orders.affected_person_id is
  'The person whose home or tenancy is AFFECTED. NULL when unknown or when the work is on common area.';

-- ── 3. backfill the split from the flattened column, BEFORE dropping it ──
--  For every existing row the reporter and the affected resident are the same
--  human (the tenant path set person_id from the reporting resident's session),
--  so both sides receive it. This preserves history rather than discarding it.
update work_orders
   set reported_by_person_id = coalesce(reported_by_person_id, person_id),
       affected_person_id    = coalesce(affected_person_id,    person_id)
 where person_id is not null;

-- ── 4. fixed vocabularies: DATA, validated, unknown values REJECTED ──
--  Same discipline as EMERGENCY_TYPES and NOT_DONE_REASONS in the service: a
--  closed list that refuses what it does not recognise. `cause` is an
--  operational observation ONLY — nothing derives money meaning from it, and a
--  typo can no longer silently change how a cost is treated.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_wo_work_nature') then
    alter table work_orders add constraint ck_wo_work_nature
      check (work_nature is null or work_nature in ('repair','replacement'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_wo_cause') then
    alter table work_orders add constraint ck_wo_cause
      check (cause is null or cause in (
        'normal_wear',        -- ordinary aging and use
        'equipment_failure',  -- a component failed
        'accident',           -- unintentional damage
        'improper_use',       -- used in a way it was not meant to be
        'weather',            -- storm, freeze, water from outside
        'end_of_life',        -- reached the end of its service life
        'unknown'             -- honestly not established
      ));
  end if;
end $$;

-- ── 5. drop what the work order must not own ──
--  Done last so the backfill above is never at risk. `select *` callers are
--  unaffected; every explicit reference was located and updated in the same
--  commit as this migration.
alter table work_orders drop column if exists gl_category;
alter table work_orders drop column if exists operating_category;
alter table work_orders drop column if exists is_capex;
alter table work_orders drop column if exists billback;
alter table work_orders drop column if exists unit_state;
alter table work_orders drop column if exists person_id;

-- supply_requests carried the same unwritten gl_category for the same reason.
-- Its operating_category is left alone deliberately: decomposing the supply
-- request is separate work and is not in this slice.
alter table supply_requests drop column if exists gl_category;

-- ════════════════════════════════════════════════════════════════════
--  NOT BUILT BY THIS MIGRATION — named so it cannot be mistaken for done:
--
--  tenant_caused now records the OBSERVATION, but the BILLBACK DECISION it
--  should trigger does not exist yet. Until it does, a work order can say "the
--  resident caused this" and no obligation asks a human to decide whether to
--  bill it back, to whom, or on what evidence. That is an honest gap, not a
--  silent one: no column claims the decision was made. The next piece is an
--  obligation spawned from the observation, with one accountable human or an
--  explicit UNASSIGNED, and a dispute path.
-- ════════════════════════════════════════════════════════════════════
