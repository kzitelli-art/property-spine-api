-- ════════════════════════════════════════════════════════════════════
--  ISOLATED-ENVIRONMENT ASSERTION — harness only, NEVER promoted
--
--  Run FIRST, on the same connection, before the production payload.
--  It is deliberately NOT part of the payload transaction: the payload
--  must be byte-promotable to production, and a database-name check is
--  true only here.
--
--  Keyed to IDENTITY, not location. A file can be copied and a port can
--  be forwarded; neither is checked. What is checked is which database
--  this connection is attached to and what that database says it is for.
-- ════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════
--  THE ISOLATION GUARD — refuses before the payload runs
-- ════════════════════════════════════════════════════════════════════
do $guard$
declare
  n int;
  p text;
  ceil text;
begin
  --  1. database identity
  if current_database() <> 'r0scale' then
    raise exception 'REFUSED: this candidate runs only against the isolated scale database, not %',
      current_database();
  end if;

  --  2. the sentinel table exists
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'release_0_scale_harness_guard';
  if n <> 1 then
    raise exception 'REFUSED: harness sentinel table is absent — this is not the scale harness';
  end if;

  --  3. the sentinel carries the EXACT expected purpose
  select purpose into p from public.release_0_scale_harness_guard where id = true;
  if p is distinct from 'ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION' then
    raise exception 'REFUSED: harness sentinel purpose does not match; got %', coalesce(p, '<null>');
  end if;

  --  4. the ledger is exactly at the production ceiling
  select coalesce(max(version), '000') into ceil from public.schema_migrations;
  if ceil <> '136' then
    raise exception 'REFUSED: ledger ceiling is %, expected exactly 136', ceil;
  end if;

  --  5. 137 is absent — this candidate is not re-runnable over itself
  select count(*) into n from public.schema_migrations where version = '137';
  if n <> 0 then
    raise exception 'REFUSED: migration 137 is already recorded in the ledger';
  end if;
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'work_order_proof_evaluations';
  if n <> 0 then
    raise exception 'REFUSED: work_order_proof_evaluations already exists';
  end if;

  raise notice 'isolation guard passed: db=% ledger=%', current_database(), ceil;
end
$guard$;

