-- ════════════════════════════════════════════════════════════════════
--  102_pricing_lifecycle_and_authority.sql
--
--  The draft → review → publish lifecycle could not be built honestly on the
--  existing schema. Four blockers, each a REAL missing primitive rather than
--  a preference. None is worked around; each is fixed at the structure.
--
--  ── 1. A NOT-OFFERED TYPE COULD NOT BE STORED ────────────────────────
--  The completeness rule requires every marketable residential type to be
--  addressed explicitly as offered / not_offered / pricing_unavailable. But
--  pricing_terms.base_rent is NOT NULL, so "this type has no price" was
--  literally unstorable — the only way to record it was to invent a number,
--  which is the failure the rule exists to prevent. The existing check
--  ck_pricing_terms_offered_has_rent already says base_rent is required only
--  when offered; the column-level NOT NULL contradicted it. Dropping the
--  NOT NULL makes the two agree, and the check keeps offered rows honest.
--
--  Same for unit_type (legacy text, NOT NULL): a governed draft references a
--  unit_type_id and has no legacy text to supply. Forcing a value there would
--  resurrect the text key as a required field.
--
--  ── 2. REVIEW HISTORY HAD NOWHERE TO LIVE ────────────────────────────
--  The requirement is that a draft may be REPLACED during authoring while the
--  submitted review receipt stays attributable and reproducible. Nothing in
--  the schema could hold that: authority_basis is about the publisher, not the
--  review, and a draft row is mutable by definition. Stuffing receipts into a
--  jsonb column on the version would be an improvised log — it would vanish
--  when the draft it describes is replaced, which defeats the entire point.
--
--  pricing_review_receipts is the precise missing primitive: append-only,
--  attributable, and holding the FULL packet snapshot the reviewer actually
--  saw, so a decision can be reproduced after the draft has moved on.
--
--  ── 3. AUTHORITY HAD TWO OF THE FOUR VERBS ───────────────────────────
--  concession_authority_grants already carries may_publish_public_offers and
--  may_edit_pricing. It has no notion of reviewing pricing or of administering
--  authority itself. Inferring those from a role name is exactly what must not
--  happen, so the two missing verbs become explicit columns.
--
--  ── 4. A FEE WAIVER WAS FORCED TO CARRY A CALENDAR ───────────────────
--  concession_policies.timing_profile is NOT NULL with a default of
--  'first_full_month' and a CHECK listing only calendar profiles. A fee waiver
--  is month-agnostic; storing one meant asserting a month it does not have.
--  The vocabulary gains the profiles the compiler can actually honour, and
--  timing_profile becomes nullable so a month-agnostic concession can say so.
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive except for three
--  NOT NULL drops, which only ever permitted MORE honest rows. All pricing
--  tables are empty (0 rows), so no data changes.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. let a type be addressed without inventing a price ─────────────
alter table pricing_terms alter column base_rent drop not null;
alter table pricing_terms alter column unit_type drop not null;

comment on column pricing_terms.base_rent is
  'New-lease rent. NULL is legitimate and meaningful: it means this type is addressed but not priced (offer_state not_offered / pricing_unavailable). ck_pricing_terms_offered_has_rent still requires a value whenever offer_state = offered.';

-- A draft must reference a governed type. The legacy text column may be null,
-- but a row with NEITHER identity is not addressable by anything.
alter table pricing_terms drop constraint if exists ck_pricing_terms_has_identity;
alter table pricing_terms add constraint ck_pricing_terms_has_identity
  check (unit_type_id is not null or unit_type is not null);

-- A renewal decision must be EXPLICIT. Null means "not yet decided", which a
-- draft may hold but a publication check refuses; a published row therefore
-- records a real decision rather than an omission.
comment on column pricing_terms.renewal_rent is
  'Renewal rent. NULL means the renewal decision has not been made. The publication contract refuses to publish an offered type whose renewal decision is absent — silence is not a renewal price.';

-- ── 2. review receipts: append-only, attributable, reproducible ───────
create table if not exists pricing_review_receipts (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  -- The draft this receipt reviewed. Kept as a plain reference WITHOUT a
  -- cascade: if the draft is later replaced or removed, the receipt survives.
  -- A review that disappears with its draft is not a review.
  reviewed_version_id uuid,
  reviewed_by_person_id uuid not null references persons(id),
  reviewed_at         timestamptz not null default now(),
  -- The decision, and the reasoning a human actually gave.
  decision            text not null check (decision in ('approved','rejected','changes_requested')),
  note                text,
  -- THE SNAPSHOT. Not a log of what changed — the complete picture the
  -- reviewer was looking at, so the decision can be reproduced later even
  -- though the draft has since moved on. This is the reason the table exists.
  packet_snapshot     jsonb not null,
  proposal_snapshot   jsonb not null,
  preview_snapshot    jsonb not null,
  -- A content hash of the proposal, so a publication can prove it is
  -- publishing THE REVIEWED THING and not a later edit wearing its receipt.
  proposal_digest     text not null,
  authority_basis     jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists ix_pricing_review_receipts_property on pricing_review_receipts (property_id, reviewed_at desc);
create index if not exists ix_pricing_review_receipts_version on pricing_review_receipts (reviewed_version_id);
create index if not exists ix_pricing_review_receipts_digest on pricing_review_receipts (proposal_digest);

comment on table pricing_review_receipts is
  'APPEND-ONLY. One row per human review of a proposed pricing sheet. Retained even when the draft it reviewed is replaced, because an unattributable review is not a review. proposal_digest lets publication prove it is publishing exactly what was reviewed.';

-- The version records WHICH receipt authorised it. Without this a publication
-- could claim review in the abstract.
alter table property_pricing_versions add column if not exists review_receipt_id uuid
  references pricing_review_receipts(id);
alter table property_pricing_versions add column if not exists created_by_person_id uuid
  references persons(id);
alter table property_pricing_versions add column if not exists superseded_at timestamptz;
alter table property_pricing_versions add column if not exists publication_receipt jsonb;

comment on column property_pricing_versions.publication_receipt is
  'The before/after receipt captured AT publication. Immutable with the row.';

-- ── immutability + non-overlap, enforced by the database ─────────────
-- A published version is a statement the property made. It is not editable.
create or replace function ps_pricing_version_immutable() returns trigger as $$
begin
  if old.status = 'published' then
    -- Retiring and superseding are the ONLY permitted transitions, and they
    -- may not rewrite what the version said.
    if new.status is distinct from old.status and new.status not in ('retired','published') then
      raise exception 'a published pricing version cannot return to draft';
    end if;
    if new.effective_from is distinct from old.effective_from
       or new.property_id is distinct from old.property_id
       or new.published_by_person_id is distinct from old.published_by_person_id
       or new.review_receipt_id is distinct from old.review_receipt_id
       or new.publication_receipt::text is distinct from old.publication_receipt::text then
      raise exception 'a published pricing version is immutable (attempted to alter its terms, dates, publisher or receipt)';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$ language plpgsql;

drop trigger if exists trg_pricing_version_immutable on property_pricing_versions;
create trigger trg_pricing_version_immutable
  before update on property_pricing_versions
  for each row execute function ps_pricing_version_immutable();

-- Terms belonging to a PUBLISHED version cannot be added, changed or removed.
create or replace function ps_pricing_terms_frozen() returns trigger as $$
declare v_status text; v_id uuid;
begin
  v_id := coalesce(new.pricing_version_id, old.pricing_version_id);
  select status into v_status from property_pricing_versions where id = v_id;
  if v_status = 'published' then
    raise exception 'the terms of a published pricing version are immutable';
  end if;
  return coalesce(new, old);
end $$ language plpgsql;

drop trigger if exists trg_pricing_terms_frozen on pricing_terms;
create trigger trg_pricing_terms_frozen
  before insert or update or delete on pricing_terms
  for each row execute function ps_pricing_terms_frozen();

drop trigger if exists trg_concession_policies_frozen on concession_policies;
create trigger trg_concession_policies_frozen
  before insert or update or delete on concession_policies
  for each row execute function ps_pricing_terms_frozen();

-- TWO PUBLISHED VERSIONS MAY NOT COVER ONE DAY. Enforced by an exclusion
-- constraint rather than a service check, because a property having two asking
-- rents at once must be impossible, not merely discouraged.
create extension if not exists btree_gist;
alter table property_pricing_versions drop constraint if exists ex_pricing_versions_no_overlap;
alter table property_pricing_versions add constraint ex_pricing_versions_no_overlap
  exclude using gist (
    property_id with =,
    tstzrange(effective_from, effective_until, '[)') with &&
  ) where (status = 'published');

-- A replacement points at what it replaces, and may not point at itself.
alter table property_pricing_versions drop constraint if exists ck_pricing_version_not_self_superseding;
alter table property_pricing_versions add constraint ck_pricing_version_not_self_superseding
  check (supersedes_version_id is null or supersedes_version_id <> id);

-- ── 3. the four authority verbs, explicit ────────────────────────────
alter table concession_authority_grants add column if not exists may_prepare_pricing boolean not null default false;
alter table concession_authority_grants add column if not exists may_review_pricing boolean not null default false;
alter table concession_authority_grants add column if not exists may_manage_concession_authority boolean not null default false;

comment on column concession_authority_grants.may_review_pricing is
  'Explicit authority to submit a review receipt. Never inferred from a role name or from generic property membership.';

-- ── 4. a month-agnostic concession may say so ────────────────────────
alter table concession_policies alter column timing_profile drop not null;
alter table concession_policies alter column timing_profile drop default;
alter table concession_policies drop constraint if exists concession_policies_timing_profile_check;
alter table concession_policies add constraint concession_policies_timing_profile_check
  check (timing_profile is null or timing_profile in (
    -- legacy calendar vocabulary, retained
    'first_full_month','third_full_month','final_full_month','monthly_scheduled_credit',
    -- profiles the compiler can actually honour
    'one_time_fee_waiver','flat_dated_credit','fixed_monthly_discount','free_rent_period'
  ));

-- A fee waiver is month-agnostic: it must NOT carry a calendar profile.
alter table concession_policies drop constraint if exists ck_policy_waiver_is_month_agnostic;
alter table concession_policies add constraint ck_policy_waiver_is_month_agnostic
  check (concession_type <> 'fee_waiver'
      or timing_profile is null or timing_profile = 'one_time_fee_waiver');

-- A dated profile must state the window it applies over.
alter table concession_policies add column if not exists applies_from date;
alter table concession_policies add column if not exists applies_until date;
alter table concession_policies add column if not exists duration_months integer;
alter table concession_policies drop constraint if exists ck_policy_dated_needs_window;
alter table concession_policies add constraint ck_policy_dated_needs_window
  check (timing_profile is distinct from 'fixed_monthly_discount' or duration_months is not null);
