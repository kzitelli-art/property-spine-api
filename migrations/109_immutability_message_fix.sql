-- ════════════════════════════════════════════════════════════════════
--  109_immutability_message_fix.sql — CORRECTS A BUG IN 108's FUNCTION BODY
--
--  108 widened active-charge immutability correctly in SCOPE and wrongly in
--  MECHANICS. It accumulated the changed field names with
--
--      changed := changed || 'applies_to_renewal';
--
--  where `changed` is text[]. Postgres resolves the unknown-type literal
--  against the array || array operator first, tries to parse the string AS an
--  array, and raises `malformed array literal` (SQLSTATE 22P02) — before ever
--  reaching the raise exception that carries the real message.
--
--  ── WHY THIS WAS STILL CAUGHT, AND WHAT IT COST ──────────────────────
--  The write was REJECTED either way, so the invariant held and no bad data
--  could land. But it was rejected by a type-cast accident, not by the guard:
--    - the operator saw `malformed array literal: "applies_to_renewal"`,
--      which reads like a broken database, not a refused decision;
--    - the errcode was 22P02 (invalid text representation) rather than the
--      intended restrict_violation;
--    - a multi-field change named only the FIRST field, so the message could
--      never list everything the caller attempted;
--    - the "supersede it with a new row instead" instruction never appeared.
--  An invariant that holds for the wrong reason is not a proven invariant.
--
--  ── THE FIX ──────────────────────────────────────────────────────────
--  array_append(changed, '...') — unambiguous, no operator resolution, no
--  cast of a string to an array. The guarded column set is UNCHANGED from
--  108; only the accumulation and the raise are corrected.
--
--  CLASSIFICATION: Class 1 permanent invariant. Additive. Replaces one
--  function body. 105 and 108 are NOT rewritten.
-- ════════════════════════════════════════════════════════════════════

create or replace function ps_governed_charge_immutable() returns trigger as $$
declare
  changed text[] := array[]::text[];
begin
  if old.record_state = 'active' then

    -- identity
    if new.charge_code            is distinct from old.charge_code            then changed := array_append(changed, 'charge_code'); end if;

    -- the six 105 already guarded
    if new.amount                 is distinct from old.amount                 then changed := array_append(changed, 'amount'); end if;
    if new.economic_class         is distinct from old.economic_class         then changed := array_append(changed, 'economic_class'); end if;
    if new.cadence                is distinct from old.cadence                then changed := array_append(changed, 'cadence'); end if;
    if new.obligation             is distinct from old.obligation             then changed := array_append(changed, 'obligation'); end if;
    if new.effective_from         is distinct from old.effective_from         then changed := array_append(changed, 'effective_from'); end if;
    if new.published_by_person_id is distinct from old.published_by_person_id then changed := array_append(changed, 'published_by_person_id'); end if;

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
  'An ACTIVE governed charge is immutable in every material economic term, including applicability (applies_to_new_lease/renewal/transfer, applicability_basis, incurred_on_event, scope, unit_type_id, condition_key) and charge_code. Widened by 108 after a live probe found 16 unguarded columns; 109 corrected 108''s field accumulation, which raised a cast error instead of the intended restrict_violation. quote_state, activated_at, activated_by_person_id and the receipt columns stay mutable — they are the cutover working surface. display_label stays mutable by decision, not oversight.';
