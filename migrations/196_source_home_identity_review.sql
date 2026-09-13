-- 196 · Source-to-home identity review before inventory materialization.
--
-- proposed_records remains the activation claim/decision ledger.  JSON keeps
-- the source claim, candidate evidence, hashes and the reviewed action.  These
-- three keys are the durable joins JSON cannot safely stand in for:
--
--   inventory_identity decision -> exact canonical unit / rentable space
--   lease proposal              -> exact approved identity decision
--
-- Existing rows predate this distinction and remain NULL.  No source claim is
-- rewritten and no second truth store is introduced.

alter table proposed_records
  add column if not exists selected_unit_id uuid references units(id) on delete restrict,
  add column if not exists selected_space_id uuid references spaces(id) on delete restrict,
  add column if not exists inventory_identity_decision_id uuid references proposed_records(id) on delete restrict;

create index if not exists ix_proposed_selected_unit
  on proposed_records (selected_unit_id) where selected_unit_id is not null;
create index if not exists ix_proposed_selected_space
  on proposed_records (selected_space_id) where selected_space_id is not null;
create index if not exists ix_proposed_inventory_identity_decision
  on proposed_records (inventory_identity_decision_id)
  where inventory_identity_decision_id is not null;

alter table proposed_records drop constraint if exists ck_proposed_selected_space_parent;
alter table proposed_records add constraint ck_proposed_selected_space_parent check
  (selected_space_id is null or selected_unit_id is not null);

-- An inventory decision is complete or it does not exist.  promoted_record_id
-- names the canonical subject: the selected space when the source identifies a
-- rentable space, otherwise the selected parent unit.
alter table proposed_records drop constraint if exists ck_proposed_inventory_identity_complete;
alter table proposed_records add constraint ck_proposed_inventory_identity_complete check
  (
    target_type <> 'inventory_identity'
    or (
      status = 'promoted'
      and resolution_kind is not null
      and resolution_kind in ('created', 'resolved_existing')
      and selected_unit_id is not null
      and promoted_record_id is not null
      and promoted_record_id = coalesce(selected_space_id, selected_unit_id)
      and confirmed_by is not null and length(btrim(confirmed_by)) > 0
      and confirmed_at is not null
      and inventory_identity_decision_id is null
    )
  );

-- Canonical target bindings belong only to the inventory decision.  Lease
-- rows consume that decision through inventory_identity_decision_id instead
-- of carrying a second, potentially divergent copy of the target.
alter table proposed_records drop constraint if exists ck_proposed_inventory_target_owner;
alter table proposed_records add constraint ck_proposed_inventory_target_owner check
  (
    target_type = 'inventory_identity'
    or (selected_unit_id is null and selected_space_id is null)
  );

comment on column proposed_records.selected_unit_id is
  'Exact canonical parent selected by a promoted inventory_identity decision. '
  'The source label remains unchanged in payload_json/normalized_json.';
comment on column proposed_records.selected_space_id is
  'Exact canonical rentable space selected by an inventory_identity decision, '
  'when the reviewed source grain identifies one.';
comment on column proposed_records.inventory_identity_decision_id is
  'The approved inventory_identity decision consumed by this proposal. May '
  'cross activations only after the service verifies property, immutable source '
  'hash, hierarchy, retirement state and scoped target fingerprint.';

comment on column proposed_records.resolution_kind is
  'created | resolved_existing. NULL until confirmation. For Person ingress '
  'it records whether the governed ingress created or recognised a person. For '
  'inventory_identity it records whether the reviewed source identity created '
  'or selected the exact canonical home. Historical NULL values stay unknown.';
