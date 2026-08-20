-- ============================================================================
--  182 - APPLICATION SPACE GRAIN
--
--  ONE FACT: the exact rentable space an application is aimed at, durable
--  from the moment it is aimed rather than first appearing at the lease.
--
--  ── THE GAP THIS CLOSES ────────────────────────────────────────────
--  The application segment was durably UNIT-GRAINED:
--
--      application_invitations   property_id, unit_id   NO space_id
--      lease_applications        property_id, unit_id   NO space_id
--      leases                    space_id NOT NULL
--      executed_lease_records    space_id REQUIRED
--
--  So the bed a lease attaches to first entered the record at the LAST
--  step, asserted at execution time, with no lineage back to what was
--  applied for. One fact derived twice, with nothing joining the two.
--
--  application_target_authority.js already stated the rule and its own
--  removal condition:
--
--      "A space choice cannot be offered unless the complete durable
--       chain can preserve it."
--
--  and therefore refused every unit holding more than one space. That
--  refusal was correct for the grain it had. This migration gives the
--  chain the ability to preserve it, which is the condition that lifts
--  the refusal. Nothing else lifts it: the same file already rejects
--  "pick the marketable one" as "select the first marketable space
--  wearing a different hat."
--
--  ── WHY NULLABLE, AND WHY THAT IS NOT A HALF-MEASURE ───────────────
--  Application access is deliberately permissive, and a prospect may
--  legitimately apply before a bed is settled. A NOT NULL column would
--  force every application to name a bed, which for an undecided
--  prospect means inventing one. Honest blank beats confident wrong
--  (PHILOSOPHY §5): null here means "not yet aimed at a bed", which is a
--  true statement about the application, and it is distinguishable from
--  "aimed at bed 3B-B", which is also true.
--
--  The requirement lands where the bed becomes consequential — a
--  governing lease cannot be generated without one. That precondition
--  belongs to the lease-execution rail, not to this column.
--
--  ── WHY NO BACKFILL ────────────────────────────────────────────────
--  For a unit holding exactly one space the mapping is a total function
--  and the server already derives it. It would therefore be tempting to
--  backfill historical rows from it. We do not, for one reason: a unit
--  may have GAINED a space since the application was written. Backfilling
--  would assert today's sole space as the bed a historical application
--  meant, which nobody ever stated. Historical rows keep null and read as
--  "not recorded", which is what they are.
--
--  ── WHY A TRIGGER AND NOT A CHECK ──────────────────────────────────
--  The constraint is cross-table — the space must belong to the row's own
--  unit and property — and a CHECK cannot look at another table. It lives
--  in Postgres rather than in one writer because more than one path
--  writes these tables, and a rule held in one writer is a rule the
--  others do not have. Same reasoning as
--  trg_refuse_lease_on_retired_inventory (180).
--
--  ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────
--  It does not change whole-unit behavior. A single-space unit resolves
--  exactly as before, by the same server-side derivation; the only
--  difference is that the derived value is now written down instead of
--  discarded. It creates no domain, no status, no lifecycle and no
--  second application record.
-- ============================================================================

do $$
begin
  if (select count(*) from schema_migrations where version in ('033','051')) <> 2 then
    raise exception 'migration 182 requires migrations 033 (lease_applications) and 051 (application_invitations)'
      using errcode = 'object_not_in_prerequisite_state',
            detail = 'Application space grain widens both application tables; both must exist first.';
  end if;
end $$;

-- ── THE COLUMN, ON BOTH HALVES OF THE CHAIN ────────────────────────────────
--  ON DELETE RESTRICT, deliberately. A space that an application was aimed at
--  may not be deleted out from under it: the whole point is that the aim
--  survives. SET NULL would preserve the application while destroying what it
--  was for, which is the same shape of loss 180 refused.
alter table application_invitations
  add column if not exists space_id uuid references spaces(id) on delete restrict;

alter table lease_applications
  add column if not exists space_id uuid references spaces(id) on delete restrict;

comment on column application_invitations.space_id is
  'The exact rentable space this invitation is aimed at. NULL = not aimed at a '
  'specific space (permitted). Server-derived or server-validated; never taken '
  'from the browser without validation against the unit and property.';

comment on column lease_applications.space_id is
  'The exact rentable space this application is aimed at, carried from the '
  'invitation. NULL = not recorded (all rows written before migration 182, and '
  'any application not aimed at a specific space). A governing lease requires '
  'one; this column does not.';

create index if not exists ix_application_invitations_space
  on application_invitations (space_id) where space_id is not null;
create index if not exists ix_lease_applications_space
  on lease_applications (space_id) where space_id is not null;

-- ── THE WALL: A SPACE MUST BELONG TO ITS OWN ROW'S UNIT AND PROPERTY ───────
--  Three separate lies this refuses, each with its own message so the writer
--  learns which one it told:
--    · a space at another property        — a cross-property leak
--    · a space in another unit            — an aim nobody can honour
--    · a unit that disagrees with the space's own unit
--
--  It does NOT require unit_id to be present. An application aimed at a space
--  with no unit stated is legitimate; the space knows its unit, and the
--  services derive it. What is refused is a unit_id that CONTRADICTS the space.
create or replace function assert_application_space_grain()
returns trigger
language plpgsql
as $$
declare
  s_unit_id     uuid;
  s_property_id uuid;
begin
  if new.space_id is null then
    return new;
  end if;

  select s.unit_id, u.property_id
    into s_unit_id, s_property_id
    from spaces s
    join units u on u.id = s.unit_id
   where s.id = new.space_id;

  if s_unit_id is null then
    raise exception 'application space % does not resolve to a unit', new.space_id
      using errcode = 'check_violation',
            hint = 'The space must exist and belong to a unit before an application can be aimed at it.';
  end if;

  if new.property_id is not null and s_property_id <> new.property_id then
    raise exception 'application space % belongs to property %, not %',
      new.space_id, s_property_id, new.property_id
      using errcode = 'check_violation',
            hint = 'An application may not be aimed at a space outside its own property.';
  end if;

  if new.unit_id is not null and s_unit_id <> new.unit_id then
    raise exception 'application space % belongs to unit %, not %',
      new.space_id, s_unit_id, new.unit_id
      using errcode = 'check_violation',
            hint = 'unit_id must agree with the space it is aimed at, or be left null and derived.';
  end if;

  return new;
end $$;

drop trigger if exists trg_application_invitation_space_grain on application_invitations;
create trigger trg_application_invitation_space_grain
  before insert or update of space_id, unit_id, property_id on application_invitations
  for each row execute function assert_application_space_grain();

drop trigger if exists trg_lease_application_space_grain on lease_applications;
create trigger trg_lease_application_space_grain
  before insert or update of space_id, unit_id, property_id on lease_applications
  for each row execute function assert_application_space_grain();

-- NOTE: this file deliberately does NOT insert its own schema_migrations row.
-- migrate.js records every file it applies. Five historical migrations (076,
-- 077, 079, 083, 084) also record themselves, and on a fresh build the two
-- inserts collide on schema_migrations_pkey — the runner then reports
-- "FAILED — rolled back. Nothing from this file was applied." for a file whose
-- objects were in fact created. Do not copy that pattern forward.
