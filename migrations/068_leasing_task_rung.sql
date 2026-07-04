-- ════════════════════════════════════════════════════════════════════
--  068 — LEASING_TASK JOINS THE RUNG VOCABULARY
--
--  Finding (task-queue proof, Jul 4 2026): migration 047's CHECK on
--  leasing_conversion_obligations.rung never included 'leasing_task',
--  but the deployed Loop-B code inserts exactly that value when an
--  operator multi-selects next moves. In production the first such
--  capture would have violated the constraint and rolled back the whole
--  post-tour transaction. The 067 sibling SUPPRESSION currently shields
--  the path; this migration fixes the floor so the task-queue home is
--  legal and a future re-enable is a deliberate flip, not a schema
--  scramble.
--
--  ALSO (second finding from the same proof): resolveRung stamps outcome/
--  resolution/closed_at on the link row but never WHO closed it, and the
--  shared engine's completeObligation accepts completed_by without writing
--  it — rung closures are unattributed today. The completion actor is a
--  distinct fact (doctrine); it now lives on the link row, the object that
--  owns the outcome. (The engine itself is untouched — core-spine surgery
--  is a separate slice; flagged in the handoff.)
--
--  This migration does NOT re-enable sibling generation.
--  Forward-only. Applied once through schema_migrations.
-- ════════════════════════════════════════════════════════════════════

alter table leasing_conversion_obligations
  drop constraint if exists leasing_conversion_obligations_rung_check;

alter table leasing_conversion_obligations
  add constraint leasing_conversion_obligations_rung_check
  check (rung in (
    'tour_followup','applicant_followup','lease_signature_followup',
    'application_approval','lease_terms_approval','lease_countersign','move_in_readiness',
    'leasing_task'
  ));

alter table leasing_conversion_obligations
  add column if not exists closed_by_user_id uuid references users(id);

-- CLOSURE IDENTITY SNAPSHOTS (067 doctrine): closed_by_user_id is the raw
-- authenticated session fact. The person/assignment columns snapshot the
-- identity RESOLUTION VALID AT CLOSURE TIME; if the bridge is later
-- corrected, closed history is never silently recomputed from today's
-- users.person_id. An unbridged closer keeps the raw user, null snapshots,
-- and basis 'unbridged' — honest blank beats confident wrong.
alter table leasing_conversion_obligations
  add column if not exists closed_by_person_id_at_close uuid references persons(id),
  add column if not exists closed_by_assignment_id_at_close uuid,
  add column if not exists closed_identity_resolution_basis text,
  add column if not exists resolution_basis text;

-- Coverage is visible: the owner closes as 'owner'; anyone else must state why.
alter table leasing_conversion_obligations
  drop constraint if exists lco_resolution_basis_check;
alter table leasing_conversion_obligations
  add constraint lco_resolution_basis_check
  check (resolution_basis is null or resolution_basis in
    ('owner','coverage','manager_intervention','completed_together','no_longer_needed','unassigned_pickup'));

-- APPROVAL IS AUTHORITY TRUTH, enforced by the DATABASE, not only app-code
-- idempotency: at most ONE lease_signature_followup may ever exist per
-- conversion. A concurrent double-approval race dies here, not in a pre-read.
create unique index if not exists lco_one_signature_followup_per_conversion
  on leasing_conversion_obligations(conversion_id)
  where rung = 'lease_signature_followup';

-- the machine-readable next move recorded AT SPAWN on the link that carries
-- it (queue contract §6). Existing rows stay null — honest blank.
alter table leasing_conversion_obligations
  add column if not exists next_move_code text;
