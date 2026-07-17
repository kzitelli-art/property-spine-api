-- ════════════════════════════════════════════════════════════════════
-- 083 — terms_review birth event + packet versioning (v3 brief §3/§5)
--
-- ALL ADDITIVE. No row is rewritten; no legacy vocabulary is renamed.
-- Old lease_activation obligations and activation_obligation_id keep
-- their historical meaning (§9). New approvals link terms_review_obligation_id.
--
--   1. lease_applications.terms_review_obligation_id
--        the corrected birth event's link (mirrors the activation_obligation_id
--        pattern; the old column is retained, read-only history).
--   2. lease_packets.supersedes_packet_id / superseded_at
--        the §5 immutability policy: "current packet" = latest NON-SUPERSEDED,
--        never merely highest version. sent/in_progress/submitted packets are
--        immutable; a terms change creates a NEW version that supersedes.
--   3. lco_one_terms_review_followup_per_conversion
--        the 068 race-killer, twinned for the new rung: at most ONE
--        terms_review_followup ever exists per conversion. A concurrent
--        double-approval dies in the DATABASE, not in a pre-read.
--   4. rung CHECK widened to admit 'terms_review_followup'.
--
-- ATOMICITY (deploy correction): the whole migration AND its ledger insert
-- run in ONE transaction, ledger LAST. A failure at any statement rolls back
-- everything — schema is never half-applied, and a partial migration can
-- never be recorded as complete. migrate.js already wraps each file in a
-- transaction; this explicit BEGIN/COMMIT makes the guarantee hold even when
-- the SQL is pasted straight into the Neon SQL Editor by hand.
-- ════════════════════════════════════════════════════════════════════

begin;

alter table lease_applications
  add column if not exists terms_review_obligation_id uuid references obligations(id);

create index if not exists idx_lease_apps_terms_review_oblig
  on lease_applications(terms_review_obligation_id)
  where terms_review_obligation_id is not null;

alter table lease_packets
  add column if not exists supersedes_packet_id uuid references lease_packets(id);

alter table lease_packets
  add column if not exists superseded_at timestamptz;

create unique index if not exists lco_one_terms_review_followup_per_conversion
  on leasing_conversion_obligations(conversion_id)
  where rung = 'terms_review_followup';

-- The rung vocabulary CHECK — widened to admit the new rung. Non-destructive:
-- drop + recreate with the full prior list plus terms_review_followup. (The
-- known enum/CHECK 500-trap, caught on the mirror proof before deploy.)
alter table leasing_conversion_obligations
  drop constraint if exists leasing_conversion_obligations_rung_check;
alter table leasing_conversion_obligations
  add constraint leasing_conversion_obligations_rung_check
  check (rung = any (array['tour_followup','applicant_followup','lease_signature_followup',
                           'application_approval','lease_terms_approval','lease_countersign',
                           'move_in_readiness','leasing_task','terms_review_followup']));

-- LEDGER INSERT LAST — inside the same transaction. If any statement above
-- failed, this line never runs and nothing is recorded. If migrate.js applies
-- this file, it records the ledger row itself; this insert is idempotent
-- against that (on conflict do nothing) so both paths are safe.
insert into schema_migrations (version, name)
  values ('083', '083_terms_review_and_packet_versioning.sql')
  on conflict (version) do nothing;

commit;
