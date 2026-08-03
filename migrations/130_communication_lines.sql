-- ════════════════════════════════════════════════════════════════════
--  130_communication_lines.sql — SLICE A
--  The canonical communication-line model.
--
--  Design: docs/COMMUNICATION_LINE_MODEL_DESIGN.md (approved 2026-08-03)
--  Doctrine: docs/COMMUNICATION_LINE_ARCHITECTURE.md
--
--  WHAT THIS ESTABLISHES, STRUCTURALLY:
--    · a property-facing line belongs to ONE property and can never carry
--      operational staff authority;
--    · an operations line belongs to ONE organization and establishes
--      organization context only — never a property;
--    · a property with no organization cannot receive an operations line;
--    · one organization may hold exactly ONE active operations line;
--    · retired lines stay auditable but never resolve inbound traffic;
--    · outbound is disabled by default and unused in this slice.
--
--  WHAT IT DOES NOT DO:
--    · it does NOT drop properties.sms_number (that is Slice B);
--    · it does NOT create any operations line — activation is a separate,
--      governed configuration act;
--    · it does NOT move staff OTP, send outbound, or touch technician work.
--
--  ON THE CEILING BEING A CONSTRAINT RATHER THAN A CONVENTION. Today
--  "staff texting a property line gain no staff authority" holds only
--  because no staff sender tier exists — an accident, not a rule. After
--  this migration a property_facing line carrying operational authority is
--  not a configuration anyone can express.
--
--  Class (§18): permanent, except the compatibility projection and its
--  guard, which are TEMPORARY and are removed in Slice B when
--  properties.sms_number is dropped.
-- ════════════════════════════════════════════════════════════════════

-- ── THE MODEL ───────────────────────────────────────────────────────
create table if not exists communication_lines (
  id                 uuid primary key default gen_random_uuid(),
  e164               text        not null,
  line_type          text        not null,
  property_id        uuid        references properties(id)    on delete restrict,
  organization_id    uuid        references organizations(id) on delete restrict,
  authority_ceiling  text        not null,
  permitted_audience text        not null,
  inbound_enabled    boolean     not null default true,
  --  DEFAULT FALSE, deliberately. Slice A is inbound-only; a default that
  --  granted sending would make that a matter of remembering to set a flag.
  outbound_enabled   boolean     not null default false,
  status             text        not null default 'active',
  provider_config    jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  superseded_at      timestamptz,
  notes              text
);

--  on delete restrict, not cascade: a line is history. Deleting a property
--  must not silently erase the record of which number served it (069 sets
--  the same precedent — history is not cascade-deletable, and that is a
--  feature).

-- ── VOCABULARIES ────────────────────────────────────────────────────
alter table communication_lines
  drop constraint if exists ck_cl_line_type;
alter table communication_lines
  add constraint ck_cl_line_type
  check (line_type in ('property_facing','operations'));

alter table communication_lines
  drop constraint if exists ck_cl_status;
alter table communication_lines
  add constraint ck_cl_status
  check (status in ('active','suspended','retired'));

alter table communication_lines
  drop constraint if exists ck_cl_authority_ceiling;
alter table communication_lines
  add constraint ck_cl_authority_ceiling
  check (authority_ceiling in ('external','operational'));

alter table communication_lines
  drop constraint if exists ck_cl_permitted_audience;
alter table communication_lines
  add constraint ck_cl_permitted_audience
  check (permitted_audience in ('residents_and_prospects','staff'));

-- ── CANONICAL FORM ──────────────────────────────────────────────────
--  Identical to normalizePropertyLine() and to migration 129's CHECK. The
--  database enforces the INVARIANT; it never re-implements the algorithm.
alter table communication_lines
  drop constraint if exists ck_cl_e164_canonical;
alter table communication_lines
  add constraint ck_cl_e164_canonical
  check (e164 ~ '^\+1[0-9]{10}$');

-- ── EXACTLY ONE OWNER ───────────────────────────────────────────────
--  This is what makes an organization-owned operations line representable
--  WITHOUT a sentinel property, and a property-facing line representable
--  without a sentinel organization. Both sentinels are forbidden by ruling.
alter table communication_lines
  drop constraint if exists ck_cl_exactly_one_owner;
alter table communication_lines
  add constraint ck_cl_exactly_one_owner
  check ((property_id is not null) <> (organization_id is not null));

-- ── THE AUTHORITY CEILING, MADE UNEXPRESSABLE-IF-WRONG ──────────────
--  line type, owner, ceiling and audience move together or not at all.
--  A property_facing line with 'operational' authority cannot be inserted.
--  A property with no organization has no organization to own an
--  operations line, so it cannot receive one — enforced here, not by a
--  lookup someone might forget to write.
alter table communication_lines
  drop constraint if exists ck_cl_posture_coherent;
alter table communication_lines
  add constraint ck_cl_posture_coherent
  check (
    (line_type = 'property_facing'
       and property_id     is not null
       and organization_id is null
       and authority_ceiling  = 'external'
       and permitted_audience = 'residents_and_prospects')
    or
    (line_type = 'operations'
       and organization_id is not null
       and property_id     is null
       and authority_ceiling  = 'operational'
       and permitted_audience = 'staff')
  );

-- ── SLICE A IS INBOUND-ONLY ─────────────────────────────────────────
--  Removed when the technician loop introduces governed outbound, at which
--  point each outbound message is tied to authenticated staff authority and
--  canonical work state. Until then this is not a policy to remember.
alter table communication_lines
  drop constraint if exists ck_cl_outbound_disabled_slice_a;
alter table communication_lines
  add constraint ck_cl_outbound_disabled_slice_a
  check (outbound_enabled = false);

-- ── UNIQUENESS ──────────────────────────────────────────────────────
--  One ACTIVE line per number, globally. Retired rows may share a number
--  with an active one, deliberately: a number reassigned between properties
--  must stay auditable. That makes "the resolver returned a retired row" a
--  test case rather than an oversight.
drop index if exists uq_communication_lines_active_e164;
create unique index uq_communication_lines_active_e164
  on communication_lines (e164) where status = 'active';

--  ONE ACTIVE OPERATIONS LINE PER ORGANIZATION. Structural, not
--  conventional. Several simultaneously active operations lines stay
--  impossible until routing, regional scope, priority and operator
--  expectations are deliberately designed.
drop index if exists uq_cl_one_active_ops_line_per_org;
create unique index uq_cl_one_active_ops_line_per_org
  on communication_lines (organization_id)
  where line_type = 'operations' and status = 'active';

--  One active property-facing line per property. The same guarantee
--  migration 129 put on properties.sms_number, now expressed where the
--  truth lives.
drop index if exists uq_cl_one_active_property_line;
create unique index uq_cl_one_active_property_line
  on communication_lines (property_id)
  where line_type = 'property_facing' and status = 'active';

create index if not exists idx_cl_property on communication_lines (property_id);
create index if not exists idx_cl_organization on communication_lines (organization_id);

comment on table communication_lines is
  'Canonical communication-line configuration. The receiving line is the property wall: inbound resolves the LINE before the SENDER, and the line establishes the authority ceiling. An operations line establishes ORGANIZATION context only — never property context.';

-- ── BACKFILL — REFUSE, NEVER CHOOSE ─────────────────────────────────
do $$
declare
  bad_rows text;
  dup_rows text;
begin
  --  After 129 every stored line is canonical and unique, so this should
  --  find nothing. It still checks: a backfill that assumes its
  --  precondition is a backfill that silently invents data when the
  --  precondition is false.
  select string_agg(format('%s (%L)', id, sms_number), E'\n      ' order by id)
    into bad_rows
    from properties
   where sms_number is not null
     and sms_number !~ '^\+1[0-9]{10}$';

  if bad_rows is not null then
    raise exception
      'MIGRATION 130 REFUSED — non-canonical property line(s).%s',
      E'\n\n    These properties hold an sms_number that is not canonical:\n      '
      || bad_rows
      || E'\n\n    Migration 129 should have made this impossible. Nothing was changed.\n'
         '    Investigate before proceeding — do not correct it here.\n';
  end if;

  select string_agg(entry, E'\n      ')
    into dup_rows
    from (
      select format('%s  <- properties %s', sms_number,
                    string_agg(id::text, ', ' order by id)) as entry
        from properties
       where sms_number is not null
       group by sms_number
      having count(*) > 1
    ) d;

  if dup_rows is not null then
    raise exception
      'MIGRATION 130 REFUSED — one line held by several properties.%s',
      E'\n\n    '
      || dup_rows
      || E'\n\n    Nothing was changed. This migration will not choose which property\n'
         '    owns a number. Resolve the collision, then re-run.\n';
  end if;
end $$;

--  One active property_facing line per property that holds a number. Every
--  posture column is fixed by the line type; none is inferred.
insert into communication_lines
  (e164, line_type, property_id, authority_ceiling, permitted_audience,
   inbound_enabled, outbound_enabled, status, notes)
select p.sms_number, 'property_facing', p.id, 'external', 'residents_and_prospects',
       true, false, 'active',
       'backfilled from properties.sms_number by migration 130'
  from properties p
 where p.sms_number is not null
   and not exists (
     select 1 from communication_lines cl
      where cl.property_id = p.id
        and cl.line_type = 'property_facing'
        and cl.status = 'active');

-- ── COMPATIBILITY PROJECTION (TEMPORARY — removed in Slice B) ───────
--  ONE writable truth, one read-only projection. Not a dual-read.
--
--  communication_lines is the only writable source of line configuration.
--  properties.sms_number continues to exist for the ~16 display consumers
--  that still read it, and is maintained FROM the canonical model, one way.
--
--  The legacy column must never be independently writable or go stale while
--  screens still display it. A column nobody writes and everybody reads,
--  drifting silently from the truth, is precisely the failure this ordering
--  exists to prevent.
create or replace function project_property_line_from_canonical()
returns trigger language plpgsql as $$
declare
  target uuid;
begin
  target := coalesce(new.property_id, old.property_id);
  if target is null then
    return null;   -- operations lines have no property to project onto
  end if;

  update properties p
     set sms_number = (
           select cl.e164
             from communication_lines cl
            where cl.property_id = target
              and cl.line_type = 'property_facing'
              and cl.status = 'active'
            limit 1),
         updated_at = now()
   where p.id = target;

  return null;
end $$;

drop trigger if exists trg_cl_project_property_line on communication_lines;
create trigger trg_cl_project_property_line
  after insert or update or delete on communication_lines
  for each row execute function project_property_line_from_canonical();

-- ── THE LEGACY COLUMN IS NO LONGER INDEPENDENTLY WRITABLE ──────────
--  Refuses any write to properties.sms_number that disagrees with the
--  canonical model. The projection trigger above always agrees (it runs
--  AFTER the canonical row is written), so it passes by construction; every
--  other write path fails loudly.
--
--  Deliberately NOT a session-variable escape hatch. An escape hatch is a
--  second write path wearing a disguise, and this constraint exists to
--  guarantee there is exactly one.
create or replace function guard_legacy_property_line_write()
returns trigger language plpgsql as $$
declare
  canonical text;
begin
  --  Untouched column on an unrelated update: nothing to check.
  if tg_op = 'UPDATE' and new.sms_number is not distinct from old.sms_number then
    return new;
  end if;

  select cl.e164 into canonical
    from communication_lines cl
   where cl.property_id = new.id
     and cl.line_type = 'property_facing'
     and cl.status = 'active'
   limit 1;

  if new.sms_number is distinct from canonical then
    raise exception
      'properties.sms_number is a READ-ONLY PROJECTION — write refused.%s',
      E'\n\n    Attempted to set it to '
      || coalesce(quote_literal(new.sms_number), 'NULL')
      || E' on property ' || new.id
      || E', but the canonical model says '
      || coalesce(quote_literal(canonical), 'no active line')
      || E'.\n\n    Line configuration is written to communication_lines, which projects\n'
         '    onto this column. Writing here directly would create a second truth.\n'
         '    See docs/COMMUNICATION_LINE_MODEL_DESIGN.md §6.\n';
  end if;

  return new;
end $$;

drop trigger if exists trg_properties_guard_legacy_line on properties;
create trigger trg_properties_guard_legacy_line
  before insert or update on properties
  for each row execute function guard_legacy_property_line_write();

comment on function guard_legacy_property_line_write() is
  'TEMPORARY (Slice B removal). Keeps properties.sms_number a read-only projection of communication_lines so there is exactly one writable truth for line configuration.';
