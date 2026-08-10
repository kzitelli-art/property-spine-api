-- ════════════════════════════════════════════════════════════════════
--  151_authority_mutation_containment.sql — BUILD 1A-2
--
--  1A-1 gave "create a property" one meaning. Creation is not the only
--  way hierarchy and authority change, and the other ways were ungoverned:
--
--    · a property's CLIENT could be changed by an ordinary UPDATE, with
--      no check that it already belonged to someone else and no record
--      that it moved (docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md §3).
--    · access grants recorded a GRANTING ACTOR supplied by the browser.
--
--  This migration lands the durable half. The source half is
--  src/identity/property_hierarchy_service.js and the teamaccess route.
--
--  ── REPARENTING IS REFUSED, NOT MANAGED ──────────────────────────────
--  A property changing client ownership is a real business event with
--  real consequences: every report, projection and access grant scoped to
--  that property changes hands with it. It needs a governed transfer —
--  consent, an effective date, a boundary for historical reporting, and a
--  decision about what the previous client may still see.
--
--  None of that exists yet, and half-built transfer machinery would be
--  worse than none: it would look like the feature while getting the
--  hard parts wrong. So the database REFUSES the mutation outright, and
--  says so in words a human can act on.
--
--  What is still allowed is ADOPTION: null → an organization. That is not
--  a transfer. It is the repair path for the legacy orphans 1A-1's audit
--  found — properties created through the three key-only doors that never
--  carried a client at all. Adoption is recorded; nothing else may happen.
--
--      null  →  org         ADOPTION      allowed, recorded
--      orgA  →  orgB        REPARENTING   refused
--      org   →  null        ORPHANING     refused
--
--  REMOVAL CONDITION for the refusal: a governed property-transfer
--  service. When it exists it will supersede this trigger in its own
--  migration, and that migration is where the transfer's consent,
--  effective date and reporting-boundary rules get written down. Do not
--  weaken this trigger without them.
--
--  ── WHY A TRIGGER AND NOT ONLY A SERVICE CHECK ───────────────────────
--  1A-1's lesson, kept: an authority rule that lives in one route is an
--  authority rule the other routes do not have. The trigger binds every
--  writer — service, harness, tool, and a psql session at 2am.
--
--  CLASSIFICATION: Class 1 permanent primitive (the event log).
--                  Class 2 the refusal trigger, removal condition above.
--  Additive. No data changes.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. the hierarchy event log ──────────────────────────────────────
create table if not exists property_organization_events (
  id                    uuid primary key default gen_random_uuid(),

  --  No cascade, same reason as property_creation_events: the record
  --  that a property was placed with a client must outlive the row.
  property_id           uuid not null references properties(id),

  --  Both sides. `from` is null for an adoption, which is the only
  --  transition this migration permits — but the column exists because a
  --  future governed transfer will need it, and a log that cannot
  --  express the event it will one day record is a log that gets replaced
  --  instead of extended.
  from_organization_id  uuid references organizations(id),
  to_organization_id    uuid references organizations(id),

  --  WHO. Both identities: the credential and the human (§10).
  actor_user_id         uuid references users(id),
  actor_person_id       uuid references persons(id),
  authority_basis       text not null,

  --  What KIND of hierarchy change this was. 'adoption' is the only value
  --  reachable today; the CHECK is the backstop that keeps a future
  --  transfer from arriving without its own migration.
  kind                  text not null,

  reason                text,
  occurred_at           timestamptz not null default now(),

  constraint ck_poe_kind check (kind in ('adoption')),
  --  An adoption comes FROM nowhere and goes somewhere. Stated as a
  --  constraint so the log cannot record an adoption that was really a
  --  transfer wearing the word.
  constraint ck_poe_adoption_shape check
    (kind <> 'adoption' or (from_organization_id is null and to_organization_id is not null))
);

create index if not exists idx_poe_property on property_organization_events(property_id);
create index if not exists idx_poe_org on property_organization_events(to_organization_id);

create or replace function refuse_property_organization_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception
    'property_organization_events is immutable: % refused. A hierarchy record is history, not state.',
    tg_op
    using errcode = 'raise_exception';
end $$;

drop trigger if exists trg_poe_immutable on property_organization_events;
create trigger trg_poe_immutable
  before update or delete on property_organization_events
  for each row execute function refuse_property_organization_event_mutation();

-- ── 2. the refusal ──────────────────────────────────────────────────
create or replace function refuse_property_reparenting()
returns trigger language plpgsql as $$
begin
  --  Only a CHANGE of client is interesting. Every other update to a
  --  property row passes untouched. `is distinct from` so a null on
  --  either side compares correctly.
  if new.organization_id is distinct from old.organization_id then

    if old.organization_id is null then
      --  ADOPTION. Allowed: this property never had a client.
      return new;
    end if;

    if new.organization_id is null then
      raise exception
        'Refused: this property belongs to an organization and cannot be returned to none. '
        'Orphaning a property hides it from every client-scoped report that currently includes it.'
        using errcode = 'raise_exception';
    end if;

    raise exception
      'Refused: a property cannot change organization. Moving % from % to % is a client transfer, '
      'which needs consent, an effective date and a reporting boundary. None of that exists yet, '
      'and a silent UPDATE would give the transfer none of them. See migration 151.',
      old.id, old.organization_id, new.organization_id
      using errcode = 'raise_exception';
  end if;
  return new;
end $$;

drop trigger if exists trg_properties_refuse_reparenting on properties;
create trigger trg_properties_refuse_reparenting
  before update on properties
  for each row execute function refuse_property_reparenting();
