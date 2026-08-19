-- ============================================================================
--  187 - THE DEPOSIT ON THE LEASE IT BELONGS TO
--
--  ONE FACT: a lease records the security deposit its tenancy was formed on.
--
--  ── FOUND BY RUNNING THE PATH, NOT BY READING IT ───────────────────
--  Driving a real resident and a real company signature through
--  spine_lease_execution → verifyExecutedLease → admission →
--  confirmTermService, the tenancy write failed:
--
--      column "security_deposit" of relation "leases" does not exist
--
--  `tenancy_anchor_service.confirmTermService` — the ONE canonical tenancy
--  writer — reads the deposit, binds it, and inserts it:
--
--      const security_deposit = Number(executed.security_deposit);
--      insert into leases (..., security_deposit, lease_status, application_id)
--
--  The column is created by NO migration in this tree. 001_baseline defines
--  `leases` without it; the only three migrations that alter the table (046,
--  071, 089) never add it; 088 adds `security_deposit` to
--  executed_lease_records, which is a different table. So this writer has
--  never successfully written a lease — the canonical tenancy path was
--  structurally unreachable, and nothing said so until it was run.
--
--  ── WHY ADD IT RATHER THAN DROP IT FROM THE WRITER ─────────────────
--  Because `leases.rent` already exists and is the same kind of fact. A lease
--  carries its own economics: leases arrive by import as well as by execution
--  (source_type, import_batch_id on this table), and an imported lease has no
--  executed_lease_record to borrow a deposit from. Removing the column from
--  the writer would leave the deposit unrecorded for every tenancy that did
--  not originate in a Spine execution, which is most of them today.
--
--  This is not a second source of truth for an executed lease's deposit.
--  executed_lease_records.security_deposit remains the EVIDENCE of what was
--  executed; this is the tenancy's own operating figure, exactly as
--  leases.rent is beside executed_lease_records.rent.
--
--  ── NULLABLE ON PURPOSE ────────────────────────────────────────────
--  Every existing lease row predates this column and none of them can be
--  given a deposit without inventing one. NULL means "not recorded on this
--  lease", which is true, and is the honest blank §5 requires. A default of
--  0 would assert that thousands of tenancies took no deposit.
--
--  ⚠ NUMBER PROVISIONAL. The live migration ledger has not been read from
--  this thread (production is unreachable here), so 187 is the next number
--  in the LOCAL tree only. Confirm the ceiling before release. The statement
--  is idempotent and additive, so it is a no-op against any database that
--  already carries the column.
--
--  Additive. No data is read, written or moved.
-- ============================================================================

alter table leases
  add column if not exists security_deposit numeric(12,2);

comment on column leases.security_deposit is
  'The security deposit this tenancy was formed on. Written by '
  'tenancy_anchor_service.confirmTermService from the executed lease, and '
  'carried directly on imported leases that have no executed record. NULL '
  'means not recorded — never assume zero.';
