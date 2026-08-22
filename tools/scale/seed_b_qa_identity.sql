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

-- ════════════════════════════════════════════════════════════════════
--  SELF-GUARD — THIS FILE PROTECTS ITSELF
--
--  Every other guard on this harness lives in the RUNNER:
--    activation_proof.js:36   SCALE_DATABASE_URL, localhost default, and
--                             deliberately NO fallback to DATABASE_URL
--    setup_baseline.sh:60     overwrites DATABASE_URL with localhost
--    assert_isolated_environment.sql  refuses outside 'r0scale'
--
--  `psql -f` on this file bypasses all three. That matters here more than
--  in its siblings, because this file INSERTS THE PRODUCTION PROPERTY UUID
--  a50fbdd0-… under a different name — see the note below, which has said
--  so for a long time without anything enforcing it.
--
--  The sentinel table cannot be checked here: setup_baseline.sh creates
--  release_0_scale_harness_guard AFTER these seeds run. So this guards on
--  database identity, and additionally on the sentinel WHEN it exists —
--  which is the strongest check available at this point in the sequence.
-- ════════════════════════════════════════════════════════════════════
do $selfguard$
declare p text;
begin
  if current_database() <> 'r0scale' then
    raise exception 'REFUSED: this seed runs only against the isolated scale database, not %',
      current_database();
  end if;
  if to_regclass('public.release_0_scale_harness_guard') is not null then
    select purpose into p from public.release_0_scale_harness_guard where id = true;
    if p is distinct from 'ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION' then
      raise exception 'REFUSED: harness sentinel present but wrong';
    end if;
  end if;
end $selfguard$;

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

