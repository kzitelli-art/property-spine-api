-- ═══════════════════════════════════════════════════════════════════════════
--  EFFECTIVE POSSESSION EVENTS + SPACE GRAIN
--  Canonical dated space position, step-2/R2/idempotency-backstop.
--
--  Adds:
--   1. unit_events.space_id            — promote possession to space grain (R2)
--   2. effective move_in / move_out    — enabled by new event_type values used
--                                        by the app; no enum change needed
--                                        (event_type is text — verified in source)
--   3. DB invariant backstop           — one effective move_in per (lease,space)
--                                        one effective move_out per (lease,space)
--
--  The migrate.js runner wraps this whole file in one begin/commit and records
--  it in schema_migrations. DO NOT add transaction control here.
--
--  BACKFILL FAILS VISIBLY, NEVER GUESSES (Fable's caution):
--   - payload space_id where present
--   - else the unit's sole space for a whole-unit (single-space) unit
--   - a unit with >1 space and no payload space_id => genuine ambiguity =>
--     this migration ABORTS and reports those unit_event ids. It does not
--     pick a bed. Resolve or quarantine, then re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. The column (nullable first; backfilled below; not forced NOT NULL because
--    scheduled/notice events legitimately may be unit-level intents).
alter table unit_events add column if not exists space_id uuid references spaces(id);

-- 2. Backfill existing rows — unambiguous only.
--    (a) payload-provided space_id, validated to belong to the unit.
update unit_events ue
   set space_id = (ue.payload->>'space_id')::uuid
 where ue.space_id is null
   and ue.payload ? 'space_id'
   and (ue.payload->>'space_id') <> ''
   and exists (
     select 1 from spaces s
      where s.id = (ue.payload->>'space_id')::uuid
        and s.unit_id = ue.unit_id
   );

--    (b) whole-unit fallback: the unit has exactly one space.
update unit_events ue
   set space_id = s.id
  from spaces s
 where ue.space_id is null
   and s.unit_id = ue.unit_id
   and (select count(*) from spaces s2 where s2.unit_id = ue.unit_id) = 1;

-- 3. FAIL VISIBLY on genuine ambiguity: any remaining null space_id on a
--    multi-space unit is an unresolved bed-level row. Abort the whole migration.
do $$
declare
  ambiguous_count int;
  sample text;
begin
  select count(*),
         coalesce(string_agg(id::text, ', ' order by id), '')
    into ambiguous_count, sample
    from (
      select ue.id
        from unit_events ue
       where ue.space_id is null
         and (select count(*) from spaces s2 where s2.unit_id = ue.unit_id) > 1
       limit 25
    ) q;

  if ambiguous_count > 0 then
    raise exception
      'BACKFILL ABORTED: % unit_events on multi-space units have no resolvable space_id. Sample ids: %. Resolve payload.space_id or quarantine these rows, then re-run. Nothing was committed.',
      ambiguous_count, sample;
  end if;
end $$;

-- 4. DB INVARIANT BACKSTOP — one effective possession event per (lease, space).
--    Effective events are the new event_type values written by the app on
--    approve / move-out. Scheduled intents (move_in_scheduled, notice_given)
--    are NOT effective and are excluded. Corrections supersede (status change),
--    so only the live (non-superseded/non-cancelled) effective event counts.
create unique index if not exists uniq_effective_move_in_per_lease_space
  on unit_events (lease_id, space_id)
  where event_type = 'move_in'
    and lease_id is not null
    and space_id is not null
    and status not in ('superseded','cancelled');

create unique index if not exists uniq_effective_move_out_per_lease_space
  on unit_events (lease_id, space_id)
  where event_type = 'move_out'
    and lease_id is not null
    and space_id is not null
    and status not in ('superseded','cancelled');
