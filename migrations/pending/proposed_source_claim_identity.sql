-- UNALLOCATED: prepare for owner-reviewed migration allocation, not automatic
-- production application. Local proof applies this only to its nonce-owned DB.
-- A position key describes a place; each source row describes a dated claim.
-- Migration156 already protects one target claim per source row. Preserve the
-- legacy natural-key guard for claims without that evidence identity.
begin;
drop index uq_proposed_natural;
create unique index uq_proposed_natural
  on proposed_records(activation_id,target_type,natural_key)
  where natural_key is not null and import_source_row_id is null;
commit;
