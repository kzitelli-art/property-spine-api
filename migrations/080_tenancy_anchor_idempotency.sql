-- ════════════════════════════════════════════════════════════════════
--  080_tenancy_anchor_idempotency.sql — the DB-enforced invariant for the
--  two-phase countersign. Reviewer-ruled shape: ONE lease anchor per
--  application, PERIOD.
--
--  RULING (reviewer, correction #1): leases.application_id is the provenance
--  of ONE tenancy decision. An application creates AT MOST ONE lease — ever.
--  A future re-lease arises from a NEW application or a governed renewal, not
--  from reusing the original application after its lease expires. Cancellation,
--  rescission, correction, renewal, and replacement are modeled as explicit
--  governed events that PRESERVE lineage — never by letting an expired lease
--  erase the application→lease history. (Corrections-preserve-lineage doctrine,
--  Master Document.)
--
--  Therefore the invariant is NOT status-scoped. It is simply:
--    at most one lease per non-null application_id.
--
--  ENFORCEMENT: the partial unique index below is the permanent DB backstop.
--  The Phase-2 service (confirm-term) additionally serializes the transition
--  with SELECT ... FOR UPDATE on the application row, so two concurrent
--  confirmations converge on the same lease WITHOUT ever throwing a raw
--  unique-violation. The index guarantees the invariant even if a code path
--  ever forgets the lock.
--
--  ADDITIVE · CONDITIONAL · IDEMPOTENT. No column, no data write, no behavior
--  change here. Safe to re-run.
--
--  PRE-FLIGHT SAFETY: if any application already maps to >1 lease (bad data
--  from before the invariant), index creation fails. We detect and REPORT it
--  first, to be resolved by a reviewed correction — never auto-deleted.
--
--  DEPLOY ORDER (reviewer, correction #4): the route-safe confirm-term patch
--  is deployed BEFORE this migration, so there is never a window where a live
--  concurrent request hits an uncontrolled unique violation.
-- ════════════════════════════════════════════════════════════════════

-- 1) Detect pre-existing violations and fail clearly if present.
do $$
declare
  dup_count int;
begin
  select count(*) into dup_count from (
    select application_id
      from leases
     where application_id is not null
     group by application_id
    having count(*) > 1
  ) d;
  if dup_count > 0 then
    raise exception
      'Cannot add tenancy-anchor unique index: % application(s) already map to >1 lease. Resolve via reviewed correction before applying 080.', dup_count;
  else
    raise notice 'No pre-existing application->lease violations; safe to add the unique index.';
  end if;
end $$;

-- 2) The unique index — one lease anchor per application, regardless of status.
create unique index if not exists leases_one_anchor_per_application
  on leases (application_id)
  where application_id is not null;
