-- ════════════════════════════════════════════════════════════════════
--  LEDGER + SCHEMA VERIFICATION — run in the Neon SQL editor BEFORE the proof.
--  Purpose: prove the EXACT expected objects from migration 085 exist — not
--  merely that the ceiling number is >= 085. A ceiling of 086 does NOT prove
--  085's contents. Do NOT reapply 085; this is read-only verification.
-- ════════════════════════════════════════════════════════════════════

-- 1. the ledger rows themselves (expect 085 = proposed_terms_confirmation,
--    086 = operational_escalation_idempotency from the parallel thread)
select version, name, applied_at
from schema_migrations
where version in ('085', '086')
order by version;

-- 2. the confirmation table exists (null → 085 body did not land)
select to_regclass('public.application_proposed_terms_confirmations') as confirmation_table;

-- 3. the four durable columns 085 added to lease_packets (expect 4 rows)
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name  = 'lease_packets'
  and column_name in (
    'proposed_terms_confirmation_id',
    'issue_actor_user_id',
    'issue_idempotency_key',
    'issued_at'
  )
order by column_name;

-- 4. the term_source vocabulary includes operator_proposed_terms
--    (the projection marker the generate drift-check depends on)
select pg_get_constraintdef(oid) as la_term_source_ck
from pg_constraint
where conname = 'la_term_source_ck';

-- 5. the lineage pointer column on lease_applications (composite-FK enforced)
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name  = 'lease_applications'
  and column_name = 'proposed_terms_confirmation_id';

-- PASS CRITERIA:
--   (1) returns a row for version '085' named for proposed_terms_confirmation
--   (2) confirmation_table is NOT null
--   (3) returns exactly 4 rows
--   (4) constraint text includes 'operator_proposed_terms'
--   (5) returns 1 row
-- If any fails, STOP — the schema the services assume is not live. Do not proceed.
