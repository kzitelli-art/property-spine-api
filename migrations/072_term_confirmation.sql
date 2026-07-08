-- ════════════════════════════════════════════════════════════════════
--  072_term_confirmation.sql — the status vocabulary for the two-phase
--  countersign. Additive, conditional, idempotent.
--
--  RULING (COUNTERSIGN_TENANCY_ANCHOR.md §2–3): countersign records
--  acceptance and stops; term confirmation creates the tenancy anchor.
--  Phase 1 needs a status meaning "accepted, term not yet confirmed,
--  not yet a tenant." That value is `accepted_term_required`.
--
--  WHY CONDITIONAL: lease_applications.status may or may not carry a CHECK
--  constraint at the live schema. This migration does NOT assume. It:
--    · detects a CHECK constraint on lease_applications.status
--    · if one exists AND does not already permit the new value, widens it
--      to include 'accepted_term_required'
--    · if the column is free-text (no CHECK), does nothing — the value is
--      already writable
--  Either way the outcome is: 'accepted_term_required' is a legal status.
--
--  IDEMPOTENT: safe to re-run. The DO block is a no-op if the value is
--  already permitted (or no constraint exists).
--
--  NO other change. No new table. No column. No data write. No behavior.
--  The idempotency ENFORCEMENT for the pending-lease invariant is NOT here
--  — it is a guarded transaction in the Phase-2 service (proven against the
--  live lease_status vocabulary), per ruling gate C. A partial unique index
--  is deliberately NOT added until that vocabulary is confirmed in the
--  supervised write path.
-- ════════════════════════════════════════════════════════════════════

do $$
declare
  cc_name   text;
  cc_def    text;
begin
  -- find a CHECK constraint on lease_applications that references the
  -- status column (there is at most one such constraint by convention).
  select con.conname, pg_get_constraintdef(con.oid)
    into cc_name, cc_def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where rel.relname = 'lease_applications'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%status%'
   limit 1;

  if cc_name is null then
    -- no CHECK on status → the column is free-text; the value is already
    -- writable. Nothing to do.
    raise notice 'lease_applications.status has no CHECK constraint; accepted_term_required is already writable.';
  elsif cc_def ilike '%accepted_term_required%' then
    -- the constraint already permits the value (e.g. a prior run).
    raise notice 'accepted_term_required already permitted by %; no change.', cc_name;
  else
    -- widen the constraint: drop and recreate with the new value added.
    -- We reconstruct by appending the value to the existing IN-list. Because
    -- constraint definitions vary, we take the safe general path: drop the
    -- old constraint and add a new one that is the OLD definition OR the new
    -- value. This preserves every previously-legal value and adds one.
    execute format('alter table lease_applications drop constraint %I', cc_name);
    -- cc_def looks like: CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))
    -- Rather than parse it, re-assert it as a disjunction with the new value.
    execute format(
      'alter table lease_applications add constraint %I check ((%s) or status = %L)',
      cc_name,
      -- strip the leading "CHECK (" and trailing ")" to reuse the predicate
      regexp_replace(regexp_replace(cc_def, '^CHECK\s*\(', ''), '\)\s*$', ''),
      'accepted_term_required'
    );
    raise notice 'widened % to permit accepted_term_required.', cc_name;
  end if;
end $$;
