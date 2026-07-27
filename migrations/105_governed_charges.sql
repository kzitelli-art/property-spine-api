-- ════════════════════════════════════════════════════════════════════
--  105_governed_charges.sql — THE CANONICAL CHARGE CATALOG
--
--  There was no governed charge model. scheduled_charges is a POSTING table
--  (a dated amount owed on one lease); ledger_entries is empty. Neither can
--  answer "what does this property charge, to whom, how often, and who said
--  so" — which is the question every quote, rent roll and projection needs.
--
--  ── WHY A SEPARATE TABLE FROM pricing_terms ──────────────────────────
--  pricing_terms answers "what is the rent for this unit type on this lease
--  term". A charge is a different shape: it may be monthly or one-time, may
--  apply to an optional election rather than to a position, and may exist
--  independently of any pricing version. Folding them together would force a
--  parking fee to pretend it has a lease term.
--
--  ── THE CLASS IS STRUCTURAL, NOT A LABEL ─────────────────────────────
--  economic_class is CHECKed and drives constraints, so the collapses that
--  produce specific wrong numbers are impossible rather than discouraged:
--
--    recurring_charge MUST be cadence 'monthly'  — a $30/month pet rent can
--      never be stored as a $30 one-time charge, because the class forbids
--      the cadence.
--    one_time_fee MUST NOT be monthly.
--    deposit_required MUST be refundable, and is never revenue.
--    deposit_held is DELIBERATELY ABSENT from this table: it is money we
--      actually hold, it lives on the lease, and giving it a catalog row
--      would let a requirement masquerade as a liability.
--    base_rent is likewise absent — it belongs to pricing_terms. A catalog
--      row claiming to be base rent would create a second asking rent.
--
--  ── AN UNRESOLVED AMOUNT IS A FIRST-CLASS STATE ──────────────────────
--  A range without a determinant is NOT a governed amount. Rather than
--  forcing a midpoint, amount may be NULL while amount_unresolved_reason
--  explains why — and a row in that state can never be quoted precisely.
--  This is the telecom $75–99 shape, made storable without being made up.
--
--  ── CROSS-PROPERTY IS IMPOSSIBLE BY KEY SHAPE ────────────────────────
--  (property_id, unit_type_id) -> property_unit_types(property_id, id), the
--  same composite-FK discipline as pricing_terms.
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive; no data changes.
-- ════════════════════════════════════════════════════════════════════

create table if not exists property_governed_charges (
  id                        uuid primary key default gen_random_uuid(),
  property_id               uuid not null references properties(id) on delete cascade,

  -- Stable identity. A charge code is how a quote, a rent roll and a
  -- projection refer to the SAME obligation without matching on its label.
  charge_code               text not null,
  display_label             text not null,

  economic_class            text not null,
  cadence                   text not null,

  -- A resolved number, or an explicit unresolved state. Never a guess.
  amount                    numeric,
  amount_unresolved_reason  text,
  currency                  text not null default 'USD',

  -- required | conditional | optional. Three states, because two would force
  -- a conditional charge to pretend to be one of the others.
  obligation                text not null,
  applicability_basis       text,          -- WHO/WHAT it applies to, in words
  applicability_scope       text not null default 'property',
  unit_type_id              uuid,          -- set when scope = 'unit_type'
  condition_key             text,          -- set when obligation = 'conditional'

  -- The event a one-time fee is incurred at.
  incurred_on_event         text,
  applies_to_new_lease      boolean not null default true,
  applies_to_renewal        boolean not null default false,
  applies_to_transfer       boolean not null default false,

  refundable                boolean,
  waivable                  boolean not null default false,
  waiver_authority_verb     text,

  effective_from            date not null,
  effective_until           date,

  -- active | draft | superseded | retired. A draft has zero operating effect.
  record_state              text not null default 'draft',
  supersedes_charge_id      uuid references property_governed_charges(id),

  source_provenance         text not null,
  authority_basis           jsonb,
  publication_receipt       jsonb,
  published_by_person_id    uuid references persons(id),
  published_at              timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint ck_gc_economic_class check (economic_class in
    ('one_time_fee','recurring_charge','deposit_required')),
  constraint ck_gc_cadence check (cadence in
    ('monthly','one_time','one_time_per_term','conditional','none')),
  constraint ck_gc_obligation check (obligation in ('required','conditional','optional')),
  constraint ck_gc_scope check (applicability_scope in
    ('property','unit_type','space','resident_condition','lease_condition','elected_option')),
  constraint ck_gc_record_state check (record_state in ('draft','active','superseded','retired')),

  -- A recurring charge recurs. Monthly is the only shape this model defines,
  -- so anything else has no meaning rather than a weaker one.
  constraint ck_gc_recurring_is_monthly check
    (economic_class <> 'recurring_charge' or cadence = 'monthly'),
  -- A one-time fee is not monthly. This is the $300-pet-fee-becomes-$300-a-month failure.
  constraint ck_gc_one_time_not_monthly check
    (economic_class <> 'one_time_fee' or cadence <> 'monthly'),
  -- A deposit requirement is refundable and is never income.
  constraint ck_gc_deposit_refundable check
    (economic_class <> 'deposit_required' or refundable = true),
  constraint ck_gc_fee_not_refundable check
    (economic_class <> 'one_time_fee' or coalesce(refundable,false) = false),

  -- An amount is a number OR an explained absence. Never both, never neither.
  constraint ck_gc_amount_or_reason check
    ((amount is not null and amount_unresolved_reason is null)
      or (amount is null and amount_unresolved_reason is not null)),
  constraint ck_gc_amount_nonneg check (amount is null or amount >= 0),

  -- A REQUIRED charge must say who it applies to. "Required" with unknown
  -- scope reads as "required of everyone" the moment anybody quotes it.
  constraint ck_gc_required_has_applicability check
    (obligation <> 'required' or applicability_basis is not null),
  -- A CONDITIONAL charge must name its condition, or it is just "sometimes".
  constraint ck_gc_conditional_has_condition check
    (obligation <> 'conditional' or condition_key is not null),
  -- A unit-type-scoped charge must name the type.
  constraint ck_gc_scope_has_type check
    (applicability_scope <> 'unit_type' or unit_type_id is not null),
  -- A waivable charge must say who may waive it.
  constraint ck_gc_waiver_has_authority check
    (waivable = false or waiver_authority_verb is not null),
  -- An ACTIVE charge must carry its publication receipt.
  constraint ck_gc_active_is_published check
    (record_state <> 'active' or (published_by_person_id is not null and published_at is not null)),
  constraint ck_gc_dates check (effective_until is null or effective_until > effective_from),
  constraint ck_gc_not_self_superseding check
    (supersedes_charge_id is null or supersedes_charge_id <> id)
);

-- Cross-property references impossible by key shape, as with pricing_terms.
alter table property_governed_charges drop constraint if exists fk_gc_unit_type;
alter table property_governed_charges add constraint fk_gc_unit_type
  foreign key (property_id, unit_type_id) references property_unit_types (property_id, id);

-- One ACTIVE charge per code per property at a time. A second active row for
-- the same code is a contradiction, not a variant.
create unique index if not exists uq_gc_active_code
  on property_governed_charges (property_id, charge_code)
  where record_state = 'active';

create index if not exists ix_gc_property_state on property_governed_charges (property_id, record_state);
create index if not exists ix_gc_class on property_governed_charges (economic_class);

comment on table property_governed_charges is
  'The governed charge catalog: one_time_fee, recurring_charge, deposit_required. base_rent lives in pricing_terms and deposit_held lives on the lease — both are deliberately absent so a catalog row can never become a second asking rent or a fabricated liability.';
comment on column property_governed_charges.amount_unresolved_reason is
  'Set when the amount is NOT a governed number — e.g. a range with no declared determinant. A row in this state can never be quoted precisely.';

-- ── immutability of published charges ────────────────────────────────
create or replace function ps_governed_charge_immutable() returns trigger as $$
begin
  if old.record_state = 'active' then
    if new.amount is distinct from old.amount
       or new.economic_class is distinct from old.economic_class
       or new.cadence is distinct from old.cadence
       or new.obligation is distinct from old.obligation
       or new.effective_from is distinct from old.effective_from
       or new.published_by_person_id is distinct from old.published_by_person_id then
      raise exception 'an active governed charge is immutable — supersede it with a new row instead';
    end if;
    if new.record_state = 'draft' then
      raise exception 'an active governed charge cannot return to draft';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$ language plpgsql;

drop trigger if exists trg_governed_charge_immutable on property_governed_charges;
create trigger trg_governed_charge_immutable
  before update on property_governed_charges
  for each row execute function ps_governed_charge_immutable();
