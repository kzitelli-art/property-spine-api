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

-- ── SECTION B — before 087_internal_qa_leasing_coverage.sql ──────────
--  087 is DATA-DEPENDENT, not structural. It updates exactly one
--  property_team_assignments row and raises unless row_count = 1. The
--  user and property ids are HARDCODED IN THE MIGRATION:
--
--    user     e9a7659f-ee1a-4bde-9e0c-02c6632ff066
--    property a50fbdd0-3642-431e-b532-0dcd6ab8a4fe
--
--  The property id is the same one production serves as Solo on Chestnut.
--  These rows are synthetic stand-ins carrying those ids so the guard can
--  find its one row. They describe nothing real.
insert into properties (id, name)
  values ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe', 'SCALE HARNESS PROPERTY')
  on conflict (id) do nothing;

insert into users (id, name, role, account_kind, is_active, status)
  values ('e9a7659f-ee1a-4bde-9e0c-02c6632ff066', 'SCALE HARNESS QA OPERATOR',
          'property_manager', 'internal_qa', true, 'active')
  on conflict (id) do nothing;

insert into property_team_assignments
  (user_id, property_id, role_title, allowed_modules, active)
  values ('e9a7659f-ee1a-4bde-9e0c-02c6632ff066',
          'a50fbdd0-3642-431e-b532-0dcd6ab8a4fe',
          'property_manager', array['leasing','maintenance'], true)
  on conflict do nothing;

-- ── SECTION C — before 110_governed_charge_assessed_per.sql ──────────
--  110 is also DATA-DEPENDENT. It backfills `assessed_per` and raises
--  unless it updates EXACTLY ONE fee.application row and EXACTLY ONE
--  fee.administration row, and unless no other charge code carries
--  assessed_per.
--
--  Column values below are not guesses — they are the closed vocabularies
--  the live check constraints publish:
--    ck_gc_economic_class            one_time_fee | recurring_charge | deposit_required
--    ck_gc_cadence                   monthly | one_time | one_time_per_term | conditional | none
--    ck_gc_obligation                required | conditional | optional
--    ck_gc_amount_or_reason          amount XOR amount_unresolved_reason
--    ck_gc_required_has_applicability  obligation='required' ⇒ applicability_basis not null
insert into property_governed_charges
  (property_id, charge_code, display_label, economic_class, cadence,
   obligation, applicability_basis, effective_from, source_provenance, amount)
values
  ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe', 'fee.application',
   'Application fee', 'one_time_fee', 'one_time',
   'required', 'per_applicant', now(), 'harness_seed', 50),
  ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe', 'fee.administration',
   'Administration fee', 'one_time_fee', 'one_time',
   'required', 'per_unit', now(), 'harness_seed', 200);
