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
