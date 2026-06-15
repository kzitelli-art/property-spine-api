-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 041 — WIDEN ASSIGNMENT ROLES: + reporting, + capital
--
--  The operator home screen is now organized around six ROOMS, each needing
--  one accountable owner per property:
--    Management · Leasing · Maintenance · Money · Reporting · Capital Desk
--
--  Owners are stored in the assignments table (004) as person↔property↔role.
--  Four rooms already map to a role cleanly:
--    Management → property_manager   Maintenance → maintenance
--    Leasing    → leasing            Money       → bookkeeper
--  But Reporting and Capital had no clean role. Reusing asset_manager / owner
--  would make the screen look clean while the DATA LIES (reporting owner ≠
--  always asset manager; capital/investor owner ≠ always legal owner). Spine
--  does not bake in that mismatch.
--
--  DECISION (Option 1, the pragmatic wall): widen the role vocabulary by two
--  official values — 'reporting' and 'capital' — so every room gets its own
--  honest role with no collision. This is NOT the larger Option 3 refactor
--  (making "room" a first-class column); assignments stays the truth table.
--  It is the smallest change that lets the room model stop fighting the schema.
--
--  After this, the room→role map is clean and 1:1:
--    Management → property_manager   Money     → bookkeeper
--    Leasing    → leasing            Reporting → reporting
--    Maintenance → maintenance       Capital   → capital
--
--  SCOPE NOTE: the assignments table also has a ck_assign_scope CHECK. The new
--  roles use scope='all' (both are cross-property oversight), which is ALREADY
--  a permitted scope value — so only the ROLE constraint needs widening, not
--  the scope constraint.
--
--  IDEMPOTENT + SAFE: drops and re-adds the named CHECK only if needed; guards
--  every step. Re-running is a no-op. No data is touched — existing rows all
--  use roles that remain valid. migrate.js owns the transaction; no BEGIN/
--  COMMIT and no ledger insert here.
--
--  orgchart.js mirrors this vocabulary in app code (const ROLES) and MUST be
--  updated in the same deploy to add 'reporting' and 'capital', or the app
--  guard will reject assignments the DB would accept. (Handled in the code
--  change that ships with this migration.)
-- ════════════════════════════════════════════════════════════════════

do $$
begin
  -- widen ck_assign_role to include the two new room-roles
  if exists (select 1 from pg_constraint where conname = 'ck_assign_role') then
    alter table assignments drop constraint ck_assign_role;
  end if;

  alter table assignments add constraint ck_assign_role
    check (role = any (array[
      'property_manager',
      'maintenance',
      'leasing',
      'bookkeeper',
      'asset_manager',
      'owner',
      'reporting',   -- NEW: owns the monthly reporting package for a property
      'capital'      -- NEW: owns investor/lender/partner-facing communication
    ]));
end $$;
