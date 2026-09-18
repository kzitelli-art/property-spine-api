-- 198 · Retained source claims are unique by source row, not source-home key.
--
-- A source row is evidence of a dated claim. Two retained rows can name the
-- same canonical home (for example, a current vacancy and a future resident)
-- and both must reach the proposal ledger. Migration 156 already enforces one
-- proposal of a target type per import_source_row_id. Keep the older natural
-- key wall for proposals that predate or do not carry source-row evidence.
--
-- migrations/migrate.js owns the whole-file transaction. A conflicting lock
-- or failed index build therefore preserves the pre-198 index and leaves this
-- version unrecorded; it does not leave a schema without either uniqueness
-- wall. Do not add BEGIN/COMMIT here: that would escape the runner's atomic
-- ledger write.

drop index uq_proposed_natural;
create unique index uq_proposed_natural
  on proposed_records (activation_id, target_type, natural_key)
  where natural_key is not null and import_source_row_id is null;
