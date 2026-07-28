-- ════════════════════════════════════════════════════════════════════
--  110_governed_charge_assessed_per.sql
--  WHAT IS ONE CHARGE ASSESSED AGAINST?
--
--  ── THE MISSING DIMENSION ────────────────────────────────────────────
--  The governed catalog could say WHEN a charge is incurred
--  (incurred_on_event), WHETHER it is required (obligation), WHICH lifecycle
--  events it applies to (applies_to_new_lease / _renewal / _transfer) and HOW
--  OFTEN it recurs (cadence) — but not what it is assessed AGAINST.
--
--  "Per applicant" and "per unit" existed ONLY inside applicability_basis, a
--  free-text column. Measured on the live database before this migration:
--    fee.application    "Per applicant on a new-lease application."
--    fee.administration "Per unit, once at move-in and once at renewal."
--  and the 35 existing columns contained no structural carrier for it —
--  applicability_scope's CHECK vocabulary is
--  (property, unit_type, space, resident_condition, lease_condition,
--  elected_option), none of which means per-applicant or per-unit.
--
--  This was found by building the structured-terms renderer and running it
--  against the real $50 row: it produced a confident sentence that silently
--  dropped "per applicant", because no field carried it. Structure could not
--  become authoritative until the structure was complete.
--
--  ── applicability_scope IS NOT OVERLOADED ────────────────────────────
--  scope answers "which slice of the property does this row govern" (the whole
--  property, one unit type, one space…). assessed_per answers "what is the
--  charge multiplied by". A property-scoped fee can still be per applicant.
--  Both rows here are scope='property' and differ in assessed_per, which is
--  exactly why one column cannot carry both meanings.
--
--  ── VOCABULARY: TWO VALUES, DELIBERATELY ─────────────────────────────
--  applicant | unit | NULL. `lease` and `occurrence` are NOT added: no proven
--  governed term needs them today, and a vocabulary entry with no term behind
--  it is speculative schema. Extend by migration when a real term requires it.
--
--  NULL means the assessment basis is UNRESOLVED — never "assume per unit".
--  checkChargePublishable refuses to publish a precisely-quotable charge whose
--  basis is null (blocker: assessment_basis_unresolved), so a draft may carry
--  null while the question is open, and a live term may not.
--
--  ── THE TWO BACKFILLS, AND WHY THEY ARE NOT NEW ECONOMIC TERMS ───────
--  fee.application    -> applicant   already governed, live, and operating as
--                                    per applicant since publication.
--  fee.administration -> unit        every prose source agrees on "per unit";
--                                    the open ownership ruling concerns RENEWAL
--                                    applicability, not the assessment basis.
--  Both are controlled translations of meaning that already exists, keyed on
--  charge_code EXPLICITLY. Nothing is parsed out of applicability_basis: a
--  runtime inference would make prose authoritative again, which is the defect
--  this field exists to remove. Every other row stays NULL.
--
--  ── ORDER IS LOAD-BEARING ────────────────────────────────────────────
--  The backfill runs BEFORE assessed_per joins the immutability guard.
--  fee.application is ACTIVE, and 108/109 make an active charge's material
--  terms immutable — so adding the column to the guard first would make its
--  own backfill impossible. Column -> constraint -> backfill -> guard.
--
--  ── DIGEST CONSEQUENCE (stated, not discovered) ──────────────────────
--  termsDigest now includes assessed_per, so the digest of BOTH rows changes.
--  That is correct: a previously implicit material term became explicit.
--  Prior publication and cutover receipts are NOT rewritten — they remain
--  historical records produced under the earlier digest contract. Any FUTURE
--  approval must carry the new digest.
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive; one column, one
--  constraint, two controlled row updates, one function body replaced.
--  105, 108 and 109 are NOT rewritten.
-- ════════════════════════════════════════════════════════════════════

-- 1. the column — nullable, because "unresolved" is a real state
alter table property_governed_charges
  add column if not exists assessed_per text;

comment on column property_governed_charges.assessed_per is
  'What the charge is assessed against: applicant | unit. NULL means the assessment basis is UNRESOLVED and the charge cannot be published as precisely quotable. Distinct from applicability_scope (which slice of the property the row governs) — a property-scoped fee can still be per applicant.';

-- 2. closed vocabulary; NULL permitted and meaningful
alter table property_governed_charges drop constraint if exists ck_gc_assessed_per;
alter table property_governed_charges add constraint ck_gc_assessed_per
  check (assessed_per is null or assessed_per in ('applicant', 'unit'));

-- 3. the two authorized backfills, keyed on charge_code, with a row-count
--    assertion so a surprise row can never be silently swept in
do $$
declare
  n_app int;
  n_adm int;
  n_other int;
begin
  update property_governed_charges
     set assessed_per = 'applicant'
   where charge_code = 'fee.application' and assessed_per is null;
  get diagnostics n_app = row_count;

  update property_governed_charges
     set assessed_per = 'unit'
   where charge_code = 'fee.administration' and assessed_per is null;
  get diagnostics n_adm = row_count;

  select count(*) into n_other from property_governed_charges
   where charge_code not in ('fee.application', 'fee.administration')
     and assessed_per is not null;

  if n_app <> 1 then
    raise exception 'expected exactly 1 fee.application row to backfill, updated %', n_app;
  end if;
  if n_adm <> 1 then
    raise exception 'expected exactly 1 fee.administration row to backfill, updated %', n_adm;
  end if;
  if n_other <> 0 then
    raise exception 'a charge outside the two authorized codes carries assessed_per (%)', n_other;
  end if;
end $$;

-- 4. NOW the guard may own it. Same 21 columns as 109, plus assessed_per.
--    Body is otherwise identical to 109 — only the new field is added.
create or replace function ps_governed_charge_immutable() returns trigger as $$
declare
  changed text[] := array[]::text[];
begin
  if old.record_state = 'active' then

    -- identity
    if new.charge_code            is distinct from old.charge_code            then changed := array_append(changed, 'charge_code'); end if;

    -- the six 105 guarded
    if new.amount                 is distinct from old.amount                 then changed := array_append(changed, 'amount'); end if;
    if new.economic_class         is distinct from old.economic_class         then changed := array_append(changed, 'economic_class'); end if;
    if new.cadence                is distinct from old.cadence                then changed := array_append(changed, 'cadence'); end if;
    if new.obligation             is distinct from old.obligation             then changed := array_append(changed, 'obligation'); end if;
    if new.effective_from         is distinct from old.effective_from         then changed := array_append(changed, 'effective_from'); end if;
    if new.published_by_person_id is distinct from old.published_by_person_id then changed := array_append(changed, 'published_by_person_id'); end if;

    -- WHAT the charge is assessed against (110)
    if new.assessed_per           is distinct from old.assessed_per           then changed := array_append(changed, 'assessed_per'); end if;

    -- applicability: WHO the charge applies to, and WHEN
    if new.applies_to_new_lease   is distinct from old.applies_to_new_lease   then changed := array_append(changed, 'applies_to_new_lease'); end if;
    if new.applies_to_renewal     is distinct from old.applies_to_renewal     then changed := array_append(changed, 'applies_to_renewal'); end if;
    if new.applies_to_transfer    is distinct from old.applies_to_transfer    then changed := array_append(changed, 'applies_to_transfer'); end if;
    if new.applicability_basis    is distinct from old.applicability_basis    then changed := array_append(changed, 'applicability_basis'); end if;
    if new.incurred_on_event      is distinct from old.incurred_on_event      then changed := array_append(changed, 'incurred_on_event'); end if;
    if new.applicability_scope    is distinct from old.applicability_scope    then changed := array_append(changed, 'applicability_scope'); end if;
    if new.unit_type_id           is distinct from old.unit_type_id           then changed := array_append(changed, 'unit_type_id'); end if;
    if new.condition_key          is distinct from old.condition_key          then changed := array_append(changed, 'condition_key'); end if;

    -- the rest of the material economic shape
    if new.waivable                 is distinct from old.waivable                 then changed := array_append(changed, 'waivable'); end if;
    if new.waiver_authority_verb    is distinct from old.waiver_authority_verb    then changed := array_append(changed, 'waiver_authority_verb'); end if;
    if new.amount_unresolved_reason is distinct from old.amount_unresolved_reason then changed := array_append(changed, 'amount_unresolved_reason'); end if;
    if new.refundable               is distinct from old.refundable               then changed := array_append(changed, 'refundable'); end if;
    if new.currency                 is distinct from old.currency                 then changed := array_append(changed, 'currency'); end if;
    if new.effective_until          is distinct from old.effective_until          then changed := array_append(changed, 'effective_until'); end if;

    if array_length(changed, 1) is not null then
      raise exception
        'an active governed charge is immutable — supersede it with a new row instead (attempted change to: %)',
        array_to_string(changed, ', ')
        using errcode = 'restrict_violation';
    end if;

    if new.record_state = 'draft' then
      raise exception 'an active governed charge cannot return to draft'
        using errcode = 'restrict_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$ language plpgsql;

comment on function ps_governed_charge_immutable() is
  'An ACTIVE governed charge is immutable in every material economic term: identity (charge_code), amount/class/cadence/obligation/effective dates/currency/refundable, applicability (applies_to_new_lease/renewal/transfer, applicability_basis, incurred_on_event, scope, unit_type_id, condition_key), waiver terms, and assessed_per (added by 110). quote_state, activated_at, activated_by_person_id and the receipt columns stay mutable — they are the cutover working surface. display_label stays mutable by decision, not oversight.';
