-- ════════════════════════════════════════════════════════════════════
--  150_canonical_property_creation.sql — BUILD 1A-1
--
--  Build 0 measured four routes that create a property, disagreeing on
--  identity, hierarchy and authority (docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md).
--  This migration lands the two durable facts the collapse needs. The
--  collapse itself is source: src/identity/property_creation_service.js.
--
--  ── WHY 150 AND NOT 138 ──────────────────────────────────────────────
--  138/139/140 are Release 0's, unapplied, living on claude/release-0-rc;
--  142 is claim-accept. Taking a number inside either block would produce
--  two files sharing a number the moment the branches meet, which is
--  exactly what migrate.js's duplicate-number guard exists to catch. 150
--  is clear of both reserved blocks.
--
--  ── 1. AN ABSENT CANONICAL KEY BECOMES AN EXPLAINED ABSENCE ──────────
--  `canonical_key` is address-anchored identity (011). Two of the four
--  doors never set it, and uq_properties_canonical_key is a plain UNIQUE
--  — so NULLs never collide and those rows carry NO duplicate protection
--  at all. That was invisible: a NULL says nothing about why.
--
--  This is the migration-105 shape, reused deliberately rather than
--  reinvented: an amount is a number OR an explained absence, never both
--  and never neither. Here: a property has an address-anchored identity
--  OR a recorded reason it does not.
--
--  It does NOT make identity mandatory. The live super-admin wizard
--  (the ONLY browser caller of any creation door, measured in the
--  deployed app) treats address as optional, and breaking that surface to
--  win a constraint would be the wrong trade. What changes is that the
--  gap stops being silent — and Build 1B's activation object reads
--  canonical_key_absent_reason directly as a Missing item.
--
--  ── 2. CREATION BECOMES ATTRIBUTABLE ─────────────────────────────────
--  Nothing recorded who created a property, under what authority, or
--  through which door. Three of the four doors could not have answered:
--  their authority was a shared bearer key. property_creation_events is
--  the immutable answer, written in the same transaction as the row.
--
--  Both actor identities are kept, per §10 and actor_context.js's rule:
--  user_id is the credential, person_id is the human. A receipt naming
--  only one cannot answer "which human did this".
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive. The only data
--  change is the backfill in step 1, which explains existing NULLs rather
--  than altering any identity.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. the explained absence ────────────────────────────────────────
alter table properties add column if not exists canonical_key_absent_reason text;

--  Backfill BEFORE the constraint. Every pre-existing keyless row gets the
--  one reason that is actually true of it: it was created before identity
--  was required. Inventing a more specific reason would be a confident
--  wrong answer about rows nobody looked at.
update properties
   set canonical_key_absent_reason = 'predates_canonical_identity_requirement'
 where canonical_key is null
   and canonical_key_absent_reason is null;

--  A row that HAS a key must not also carry a reason it lacks one.
update properties
   set canonical_key_absent_reason = null
 where canonical_key is not null
   and canonical_key_absent_reason is not null;

--  ── THE INVARIANT REPAIRS ON INSERT, AND REFUSES ON CONTRADICTION ──
--
--  A bare `insert into properties (name) values (...)` states neither a
--  key nor a reason. Roughly twenty harnesses and tools do exactly that,
--  and a CHECK alone would turn every one of them red — a constraint that
--  breaks the proofs is worse than the gap it closes.
--
--  So the two cases are handled differently, on purpose:
--
--    NEITHER stated  → the trigger records the one thing that is actually
--                      true: the writer did not state an identity. That is
--                      an honest answer, not an invented one, and it keeps
--                      every existing writer working.
--    BOTH stated     → refused by the CHECK. A row claiming both an
--                      identity and a reason it has none is a
--                      contradiction, and no default can resolve it.
--
--  The trigger fires on INSERT only. An UPDATE that introduces the
--  contradiction still hits the CHECK, which is what makes the rule
--  provable by attacking the row directly rather than through the service.
create or replace function properties_explain_absent_identity()
returns trigger language plpgsql as $$
begin
  if new.canonical_key is null and new.canonical_key_absent_reason is null then
    new.canonical_key_absent_reason := 'identity_not_stated_at_insert';
  end if;
  return new;
end $$;

drop trigger if exists trg_properties_explain_absent_identity on properties;
create trigger trg_properties_explain_absent_identity
  before insert on properties
  for each row execute function properties_explain_absent_identity();

do $$ begin
  alter table properties add constraint ck_properties_identity_or_reason check
    ((canonical_key is not null and canonical_key_absent_reason is null)
      or (canonical_key is null and canonical_key_absent_reason is not null));
exception when duplicate_object then null; end $$;

-- ── 2. the immutable creation record ────────────────────────────────
create table if not exists property_creation_events (
  id                    uuid primary key default gen_random_uuid(),

  --  No cascade. If a property is ever deleted, the record that it was
  --  created — and by whom — must outlive it. That is the point of an
  --  immutable history (§31 Q5).
  property_id           uuid not null references properties(id),

  --  The organization the property was created into, captured as it was
  --  at creation. properties.organization_id can later be reassigned;
  --  this column is what that reassignment would otherwise erase.
  organization_id       uuid references organizations(id),

  --  WHO. Both identities, always.
  actor_user_id         uuid references users(id),
  actor_person_id       uuid references persons(id),

  --  The authority actually exercised, e.g. 'platform_role:super_admin'.
  --  Recorded so a later reader sees the authority, not merely that
  --  somebody was signed in.
  authority_basis       text not null,

  --  WHICH DOOR. The four callers of the canonical service. Kept as a
  --  CHECK so a fifth source cannot appear here without a deliberate
  --  migration — the database is the backstop for the source gate.
  creation_source       text not null,

  --  WHAT IDENTITY the property was given, and if none, why not. Copied
  --  rather than joined: this answers what was true AT creation.
  canonical_key         text,
  canonical_key_absent_reason text,

  --  Strings taught as resolved aliases in the same transaction.
  aliases_taught        jsonb not null default '[]'::jsonb,

  occurred_at           timestamptz not null default now(),

  constraint ck_pce_source check (creation_source in
    ('super_admin_wizard','bank_intake','owner_upload','deal_intake')),
  --  Same honest-blank rule as the property row itself.
  constraint ck_pce_identity_or_reason check
    ((canonical_key is not null and canonical_key_absent_reason is null)
      or (canonical_key is null and canonical_key_absent_reason is not null))
);

create index if not exists idx_pce_property on property_creation_events(property_id);
create index if not exists idx_pce_org on property_creation_events(organization_id);

--  Immutable in the database, not merely by convention. A creation event
--  that can be edited is not a history; it is a mutable claim wearing the
--  word "event". Deletion is refused for the same reason.
create or replace function refuse_property_creation_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception
    'property_creation_events is immutable: % refused. A creation record is history, not state.',
    tg_op
    using errcode = 'raise_exception';
end $$;

drop trigger if exists trg_pce_immutable on property_creation_events;
create trigger trg_pce_immutable
  before update or delete on property_creation_events
  for each row execute function refuse_property_creation_event_mutation();
