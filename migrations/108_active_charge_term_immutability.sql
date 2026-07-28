-- ════════════════════════════════════════════════════════════════════
--  108_active_charge_term_immutability.sql
--  AN ACTIVE CHARGE IS IMMUTABLE IN EVERY MATERIAL TERM, NOT SIX OF THEM
--
--  ── THE DEFECT THIS CLOSES (measured live, 2026-07-28) ───────────────
--  105 introduced ps_governed_charge_immutable, which guards exactly six
--  columns: amount, economic_class, cadence, obligation, effective_from,
--  published_by_person_id. Everything else on a PUBLISHED, LIVE charge was
--  freely updatable — no supersession, no receipt, no error.
--
--  Probed against the live database before writing this file, the following
--  were unguarded on an active row:
--    charge_code · applies_to_new_lease · applies_to_renewal ·
--    applies_to_transfer · applicability_basis · incurred_on_event ·
--    condition_key · applicability_scope · unit_type_id · waivable ·
--    waiver_authority_verb · amount_unresolved_reason · effective_until ·
--    refundable · currency · display_label
--
--  Why that matters more than it sounds: applicability is not decoration.
--  `applies_to_renewal` is the single field that decides whether a renewing
--  resident is quoted a fee at all. On the live $50 application fee it could
--  be flipped by any statement reaching this table, and the row would still
--  read as published, receipted and authorised. The amount would be honest
--  and the answer would be wrong.
--
--  ── WHY A TRIGGER AND NOT A CHECK CONSTRAINT ─────────────────────────
--  A CHECK sees one row and cannot compare it to its own prior value. The
--  invariant here is about CHANGE, so it needs OLD and NEW.
--
--  ── charge_code IS INCLUDED ──────────────────────────────────────────
--  uq_gc_active_code makes a DUPLICATE active code impossible, but nothing
--  stops an active row being renamed to a fresh unused code — which silently
--  orphans every quote, projection and legacy-retirement mapping that refers
--  to it. The unique index is not the guard people assume it is.
--
--  ── WHAT REMAINS DELIBERATELY MUTABLE ON AN ACTIVE ROW ───────────────
--  quote_state · activated_at · activated_by_person_id · cutover_receipt ·
--  publication_receipt · authority_basis · published_at · updated_at
--  These are the cutover's own working surface. Verified against every
--  `update property_governed_charges` in the repo before writing this: no
--  live path updates a material term on an active row, so nothing that
--  works today starts failing.
--
--  display_label is ALSO left mutable, deliberately and narrowly: a label is
--  presentation, not an economic term, and blocking it would prevent fixing
--  a typo without superseding a correct charge. FLAGGED rather than assumed
--  — a label CAN carry meaning ("Application fee" → "Application fee, non-
--  refundable"), so if ownership wants it guarded that is a one-line change.
--
--  ── SCOPE HONESTY ────────────────────────────────────────────────────
--  This guards record_state = 'active' only, matching 105's existing shape
--  and the authorised scope of this migration. Rows in 'superseded' or
--  'retired' state remain editable — that is history being rewritable, a
--  real and separate gap, recorded here rather than silently widened into.
--
--  CLASSIFICATION: Class 1 permanent invariant. Additive. Replaces one
--  function body; creates no column, drops nothing, changes no data.
--  105 is NOT rewritten.
-- ════════════════════════════════════════════════════════════════════

create or replace function ps_governed_charge_immutable() returns trigger as $$
declare
  changed text[] := '{}';
begin
  if old.record_state = 'active' then

    -- ── identity ──────────────────────────────────────────────────
    if new.charge_code            is distinct from old.charge_code            then changed := changed || 'charge_code'; end if;

    -- ── the six 105 already guarded ───────────────────────────────
    if new.amount                 is distinct from old.amount                 then changed := changed || 'amount'; end if;
    if new.economic_class         is distinct from old.economic_class         then changed := changed || 'economic_class'; end if;
    if new.cadence                is distinct from old.cadence                then changed := changed || 'cadence'; end if;
    if new.obligation             is distinct from old.obligation             then changed := changed || 'obligation'; end if;
    if new.effective_from         is distinct from old.effective_from         then changed := changed || 'effective_from'; end if;
    if new.published_by_person_id is distinct from old.published_by_person_id then changed := changed || 'published_by_person_id'; end if;

    -- ── applicability: WHO the charge applies to, and WHEN ─────────
    -- The field that decides what a renewing resident is told they owe.
    if new.applies_to_new_lease   is distinct from old.applies_to_new_lease   then changed := changed || 'applies_to_new_lease'; end if;
    if new.applies_to_renewal     is distinct from old.applies_to_renewal     then changed := changed || 'applies_to_renewal'; end if;
    if new.applies_to_transfer    is distinct from old.applies_to_transfer    then changed := changed || 'applies_to_transfer'; end if;
    if new.applicability_basis    is distinct from old.applicability_basis    then changed := changed || 'applicability_basis'; end if;
    if new.incurred_on_event      is distinct from old.incurred_on_event      then changed := changed || 'incurred_on_event'; end if;
    if new.applicability_scope    is distinct from old.applicability_scope    then changed := changed || 'applicability_scope'; end if;
    if new.unit_type_id           is distinct from old.unit_type_id           then changed := changed || 'unit_type_id'; end if;
    if new.condition_key          is distinct from old.condition_key          then changed := changed || 'condition_key'; end if;

    -- ── the rest of the material economic shape ───────────────────
    if new.waivable               is distinct from old.waivable               then changed := changed || 'waivable'; end if;
    if new.waiver_authority_verb  is distinct from old.waiver_authority_verb  then changed := changed || 'waiver_authority_verb'; end if;
    if new.amount_unresolved_reason is distinct from old.amount_unresolved_reason then changed := changed || 'amount_unresolved_reason'; end if;
    if new.refundable             is distinct from old.refundable             then changed := changed || 'refundable'; end if;
    if new.currency               is distinct from old.currency               then changed := changed || 'currency'; end if;
    if new.effective_until        is distinct from old.effective_until        then changed := changed || 'effective_until'; end if;

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

-- The trigger itself is unchanged from 105 and is re-asserted only so this
-- file is complete if 105 is ever replayed against a fresh database.
drop trigger if exists trg_governed_charge_immutable on property_governed_charges;
create trigger trg_governed_charge_immutable
  before update on property_governed_charges
  for each row execute function ps_governed_charge_immutable();

comment on function ps_governed_charge_immutable() is
  'An ACTIVE governed charge is immutable in every material economic term, including applicability (applies_to_new_lease/renewal/transfer, applicability_basis, incurred_on_event, scope, unit_type_id, condition_key) and charge_code. Widened by migration 108 after a live probe found 16 unguarded columns, of which applies_to_renewal decides what a renewing resident is quoted. quote_state, activated_at, activated_by_person_id and the receipt columns stay mutable — they are the cutover working surface. display_label stays mutable by decision, not oversight.';
