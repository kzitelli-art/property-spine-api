-- 195 · Two-step leasing: a packet may be prepared from the applicant's
-- acknowledged, authored offer without a second human confirmation.
--
-- WHY A MIGRATION. The packet, issue and lineage checks all read ONE record:
-- application_proposed_terms_confirmations (confirmation.application_offer_id
-- and application_terms_hash must equal the bound offer). Keeping that single
-- lineage means the two-step path records the SAME kind of row — but it is
-- not an operator's re-confirmation, and the row must say so. 085 froze the
-- source and authority vocabularies with CHECK constraints, so widening them
-- is the honest change; writing 'operator_proposed_terms' for a system-
-- derived record would be a false attribution.
--
--   source          'authored_offer_acknowledged'  the confirmation is DERIVED
--                   from the immutable application offer the applicant
--                   acknowledged; no human re-typed or re-approved economics.
--   authority_basis 'authored_offer'                the authority is the offer
--                   author's (lease_offers.authority_basis_snapshot), carried
--                   by application_offer_id; the actor_user_id on the row is
--                   the staff member who PREPARED the packet, not an approver.
--
-- No column is added. No row is rewritten. Existing operator confirmations
-- keep their exact vocabulary and remain valid.
alter table application_proposed_terms_confirmations
  drop constraint if exists aptc_source_ck;
alter table application_proposed_terms_confirmations
  add constraint aptc_source_ck
  check (source in ('operator_proposed_terms', 'authored_offer_acknowledged'));

alter table application_proposed_terms_confirmations
  drop constraint if exists aptc_authority_ck;
alter table application_proposed_terms_confirmations
  add constraint aptc_authority_ck
  check (authority_basis in ('owner', 'role_authority', 'managed_role_override', 'authored_offer'));

-- A derived confirmation must always name the offer it was derived from.
alter table application_proposed_terms_confirmations
  drop constraint if exists aptc_derived_names_offer_ck;
alter table application_proposed_terms_confirmations
  add constraint aptc_derived_names_offer_ck
  check (source <> 'authored_offer_acknowledged'
         or (application_offer_id is not null and application_terms_hash is not null));

-- The application's projected term_source names the same basis, so a reader
-- never mistakes derived terms for an operator confirmation.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'la_term_source_ck') then
    alter table lease_applications drop constraint la_term_source_ck;
  end if;
  alter table lease_applications
    add constraint la_term_source_ck
    check (term_source is null or term_source in
      ('application_capture','confirm_term_repair','operator_proposed_terms','authored_offer_acknowledged'));
end $$;
