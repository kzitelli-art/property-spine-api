-- ════════════════════════════════════════════════════════════════════
--  139_no_longer_applicable_resolution.sql
--
--  §4.2 SPECIFIES A RESOLUTION CODE THE SCHEMA DOES NOT ALLOW.
--
--  The Release 0 plan defines the defect obligation's closure:
--
--      · a valid proof evaluation head exists   → 'satisfied'
--      · the work order is no longer terminal   → 'no_longer_applicable'
--
--  `satisfied` is already in the frozen vocabulary. `no_longer_applicable`
--  is not — 084 froze it to:
--
--      satisfied · superseded · revoked · dispatch_refused · expired
--
--  so `ck_oblig_resolution_code` would refuse the second closure outright.
--
--  ── WHY NOT REUSE AN EXISTING CODE ──────────────────────────────────
--  Considered and rejected, because none of them is true:
--
--      satisfied         the defect was NOT resolved by proof arriving
--      superseded        nothing replaced this obligation
--      revoked           implies a human withdrew it; nobody did
--      dispatch_refused  unrelated — a transport outcome
--      expired           implies time passed; the CONDITION changed
--
--  The honest statement is "the situation that caused this obligation no
--  longer exists". Picking the nearest wrong word to avoid a migration is
--  how a resolution vocabulary stops meaning anything — and this one is
--  read by reporting.
--
--  ── WHAT THIS WIDENS, AND WHAT IT DOES NOT ──────────────────────────
--  Additive: one value added to a CHECK. No existing row changes, no
--  existing code path can now do something it could not before — nothing
--  writes this value except the defect-closure service.
--
--  It IS a widening of a vocabulary that 084 called frozen, and that is
--  worth seeing rather than burying: a reviewer who disagrees can reject
--  this file alone and the rest of the release still stands, with the
--  'no_longer_applicable' closure simply unavailable.
-- ════════════════════════════════════════════════════════════════════

alter table obligations drop constraint if exists ck_oblig_resolution_code;
alter table obligations add constraint ck_oblig_resolution_code
  check (resolution_code is null
         or resolution_code in ('satisfied','superseded','revoked',
                                'dispatch_refused','expired',
                                'no_longer_applicable'));

comment on constraint ck_oblig_resolution_code on obligations is
  'Frozen resolution vocabulary (084), widened once by 139 to carry §4.2''s '
  'no_longer_applicable — the defect obligation closes that way when the work '
  'order leaves the terminal state, which none of the original five describes '
  'truthfully.';
