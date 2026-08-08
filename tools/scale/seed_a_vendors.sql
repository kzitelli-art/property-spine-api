-- ════════════════════════════════════════════════════════════════════
--  RELEASE 0 SCALE HARNESS — BASELINE SEED
--
--  ⚠ ISOLATED POSTGRES ONLY. NEVER production, never Neon.
--
--  The migration ledger cannot replay from an empty database. This file
--  supplies the minimum a fresh replay needs to reach ceiling 136, and
--  NOTHING ELSE. Every statement here exists because a specific migration
--  refused without it — see docs/RELEASE_0_SCALE_BASELINE.md for the
--  refusal each one answers.
--
--  ── WHAT THIS IS NOT ────────────────────────────────────────────────
--  It is NOT a claim about production's shape or contents. It is a
--  synthetic scaffold that lets the ledger run. Where production differs
--  — and for `vendors` it certainly does — that difference is recorded in
--  the baseline document rather than papered over here.
--
--  ── WHY NOT FIX THE MIGRATIONS ──────────────────────────────────────
--  Plan §7.6: migration 012's un-replayability does NOT need repairing
--  inside Release 0. Repairing history to make a harness convenient is a
--  larger change than the release, and it would rewrite the record of what
--  production actually did.
--
--  APPLY ORDER
--    1. run migrate.js until it refuses at 012
--    2. run section A
--    3. run migrate.js until it refuses at 087
--    4. run section B
--    5. run migrate.js until it refuses at 110
--    6. run section C
--    7. run migrate.js to completion — ceiling 136
-- ════════════════════════════════════════════════════════════════════

-- Split out of baseline_seed.sql so setup_baseline.sh can apply each
-- section at the exact refusal it answers. See docs/RELEASE_0_SCALE_BASELINE.md.

-- ── SECTION A — before 012_bank_intake.sql ──────────────────────────
--  001_baseline.sql creates `vendors` as the MAINTENANCE vendor table
--  (name, trade, phone). 012 creates `vendors` as the PAYEE table
--  (canonical_name, yardi_code, vendor_type) with `create table if not
--  exists`, which is a NO-OP once 001 has run — so 012's columns never
--  arrive and its indexes fail on columns that do not exist.
--
--  TWO DIFFERENT TABLES SHARE ONE NAME. Production resolved this some
--  other way; this harness does not know how and does not guess.
--  `vendors` is not a Release 0 table, so the divergence does not affect
--  what the scale proof measures.
alter table vendors add column if not exists yardi_code text;
alter table vendors add column if not exists canonical_name text;
update vendors set canonical_name = name where canonical_name is null;
alter table vendors alter column canonical_name set not null;
alter table vendors add column if not exists vendor_type text not null default 'vendor';

