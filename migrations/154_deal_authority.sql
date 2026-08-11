-- ════════════════════════════════════════════════════════════════════
--  154 — A DEAL GETS AN OWNER
--
--  Build 1A governed property creation and stopped there. Everything ABOVE
--  the property stayed as it was: `deal_intakes` has no organization, and
--  eleven of the twelve deal routes authenticate with a shared bearer key
--  and no actor at all. A deal today is an ownerless object anyone holding
--  that key can create.
--
--  This is 1A's work, one layer up, deliberately the same shape so there is
--  ONE doctrine and not two:
--
--    organization_id                  — who owns it, derived from the session
--    organization_absent_reason       — stated when it could not be derived
--    ck_deal_org_or_reason            — one or the other, never neither
--    deal_creation_events             — immutable, both actor identities
--    refuse_deal_reparenting()        — org → org is refused in the database
--    deals_explain_absent_owner()     — a bare INSERT is repaired, not trusted
--
--  ── THE BACKFILL, AND WHY IT IS DERIVABLE ───────────────────────────
--  A deal that already holds a property can inherit that property's owner:
--  `deal_intake_properties → properties.organization_id`. That is not a
--  guess — it is the same fact read through a join that already exists.
--
--  Where it is NOT derivable (a deal with no properties, or whose
--  properties have no organization), NOTHING IS INVENTED. The row gets a
--  stated reason, exactly as migration 150 did for canonical keys. An
--  honest blank beats a confident wrong owner, and an owner is the single
--  worst field in this schema to be confidently wrong about.
--
--  A deal whose properties disagree — two members owned by two different
--  organizations — is NOT resolved by picking one. It is named.
--
--  CLASSIFICATION: Class 1. Additive plus one derived backfill.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. the columns ───────────────────────────────────────────────────
alter table deal_intakes
  add column if not exists organization_id uuid references organizations(id);

alter table deal_intakes
  add column if not exists organization_absent_reason text;

comment on column deal_intakes.organization_absent_reason is
  'Why this deal has no owning organization. Never null at the same time as '
  'organization_id, and never set at the same time as one either.';

-- ── 2. the backfill, in three named populations ──────────────────────
--  Order matters: the derivable case first, then each reason for the rest.

--  2a. DERIVABLE — every member property agrees on one organization.
update deal_intakes d
   set organization_id = agreed.org_id
  from (
    --  `having count(distinct …) = 1` has already established that there is
    --  exactly one distinct organization in this group, so taking the first
    --  element of the aggregate is picking the only candidate, not choosing
    --  between candidates. (uuid has no min(); array_agg does the same job.)
    select dp.intake_id, (array_agg(distinct p.organization_id))[1] as org_id
      from deal_intake_properties dp
      join properties p on p.id = dp.property_id
     where p.organization_id is not null
     group by dp.intake_id
    having count(distinct p.organization_id) = 1
  ) agreed
 where d.id = agreed.intake_id
   and d.organization_id is null;

--  2b. CONTESTED — members owned by more than one organization. This is a
--      real situation (a deal spanning two clients) and picking one would
--      be a silent, unrecoverable authority error. It is named and left
--      for a human.
update deal_intakes d
   set organization_absent_reason = 'member_properties_disagree_on_owner'
  from (
    select dp.intake_id
      from deal_intake_properties dp
      join properties p on p.id = dp.property_id
     where p.organization_id is not null
     group by dp.intake_id
    having count(distinct p.organization_id) > 1
  ) contested
 where d.id = contested.intake_id
   and d.organization_id is null
   and d.organization_absent_reason is null;

--  2c. MEMBERS, BUT NONE OWNED — the deal holds properties and not one of
--      them has an organization. The gap is upstream, in the property.
update deal_intakes d
   set organization_absent_reason = 'member_properties_have_no_owner'
 where d.organization_id is null
   and d.organization_absent_reason is null
   and exists (select 1 from deal_intake_properties dp where dp.intake_id = d.id);

--  2d. NO MEMBERS AT ALL — nothing to derive from. The commonest case for
--      an abandoned intake, and the most honest reason available.
update deal_intakes d
   set organization_absent_reason = 'no_member_property_to_derive_owner_from'
 where d.organization_id is null
   and d.organization_absent_reason is null;

-- ── 3. the constraint, added AFTER the backfill ──────────────────────
do $$ begin
  alter table deal_intakes add constraint ck_deal_org_or_reason check
    ((organization_id is not null and organization_absent_reason is null)
      or (organization_id is null and organization_absent_reason is not null));
exception when duplicate_object then null; end $$;

-- ── 4. the immutable creation record ─────────────────────────────────
create table if not exists deal_creation_events (
  id                  uuid primary key default gen_random_uuid(),

  --  No cascade, same reason as property_creation_events: the record that
  --  a deal was opened, and by whom, must outlive the deal.
  deal_intake_id      uuid not null references deal_intakes(id),
  organization_id     uuid references organizations(id),

  --  WHO. Both identities — the credential and the human (§10).
  actor_user_id       uuid references users(id),
  actor_person_id     uuid references persons(id),
  authority_basis     text not null,

  creation_source     text not null,
  deal_name           text,
  onboarding_type     text,
  organization_absent_reason text,
  occurred_at         timestamptz not null default now(),

  constraint ck_dce_source check (creation_source in
    ('asset_management_console','deal_intake_api','legacy_backfill'))
);
create index if not exists ix_dce_deal on deal_creation_events (deal_intake_id, occurred_at);
create index if not exists ix_dce_org  on deal_creation_events (organization_id, occurred_at desc);

create or replace function public.deal_creation_events_are_immutable()
returns trigger as $$
begin
  raise exception 'deal_creation_events is an immutable record of what happened'
    using errcode = 'restrict_violation',
          detail  = 'A creation event describes a past act. Correct the deal, not the record of its opening.';
end;
$$ language plpgsql;
alter function public.deal_creation_events_are_immutable() set search_path = public, pg_temp;

drop trigger if exists trg_dce_immutable on deal_creation_events;
create trigger trg_dce_immutable
  before update or delete on deal_creation_events
  for each row execute function public.deal_creation_events_are_immutable();

-- ── 5. reparenting is refused in the database ────────────────────────
--  Identical ruling to 151 for properties: adoption (null → org) is the
--  only ownership transition that exists. org → org is a governed transfer
--  nobody has designed, and org → null is a deal quietly losing its owner.
--  Both are refused HERE, so an ordinary UPDATE anywhere cannot do it.
create or replace function public.refuse_deal_reparenting()
returns trigger as $$
begin
  if old.organization_id is not distinct from new.organization_id then
    return new;
  end if;

  if old.organization_id is null and new.organization_id is not null then
    return new;                                  -- adoption: the one legal move
  end if;

  if new.organization_id is null then
    raise exception 'a deal may not be un-owned once it has an owner'
      using errcode = 'restrict_violation',
            detail  = 'Clearing organization_id would leave every fact under this deal '
                   || 'with no authority answer, silently.',
            hint    = 'Close the deal instead of orphaning it.';
  end if;

  raise exception 'a deal may not change client ownership through an ordinary update'
    using errcode = 'restrict_violation',
          detail  = 'Moving a deal from one organization to another re-parents every '
                 || 'property, position and document beneath it at once.',
          hint    = 'A governed transfer does not exist yet. Refusing is deliberate: '
                 || 'half-built transfer machinery is worse than none.';
end;
$$ language plpgsql;
alter function public.refuse_deal_reparenting() set search_path = public, pg_temp;

drop trigger if exists trg_deals_refuse_reparenting on deal_intakes;
create trigger trg_deals_refuse_reparenting
  before update of organization_id on deal_intakes
  for each row execute function public.refuse_deal_reparenting();

-- ── 6. a bare INSERT is repaired, never trusted ──────────────────────
--  The canonical service always states one or the other. Anything that
--  reaches this table another way gets the reason that is actually true of
--  it — that ownership was never stated — rather than passing the CHECK by
--  accident or failing with a constraint name no operator can read.
create or replace function public.deals_explain_absent_owner()
returns trigger as $$
begin
  if new.organization_id is null and new.organization_absent_reason is null then
    new.organization_absent_reason := 'ownership_not_stated_at_insert';
  end if;
  if new.organization_id is not null then
    new.organization_absent_reason := null;
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.deals_explain_absent_owner() set search_path = public, pg_temp;

drop trigger if exists trg_deals_explain_absent_owner on deal_intakes;
create trigger trg_deals_explain_absent_owner
  before insert on deal_intakes
  for each row execute function public.deals_explain_absent_owner();
