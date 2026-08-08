-- ════════════════════════════════════════════════════════════════════
--  138_proof_evaluation_defect_obligation.sql
--
--  §4.2 — A DUPLICATE OPEN DEFECT OBLIGATION IS UNREPRESENTABLE.
--
--  The sweep re-derives its population from the database on every run and
--  converges; a failed run is not compensated or replayed. That is only
--  safe if a second run cannot raise a second obligation for the same work
--  order — and "cannot" has to mean the database refuses it, not that the
--  service checks first. A check-then-insert is a race, and two sweep runs
--  overlapping is the ordinary case for a scheduled rail, not the exotic
--  one.
--
--  So the guarantee is a partial unique index. The service inserts and
--  treats a conflict as success.
--
--  ── WHY `status <> 'complete'` AND NOT `status = 'open'` ────────────
--  An obligation in flight is not always `open` — it can be accepted, in
--  progress, or otherwise mid-lifecycle, and every one of those is still
--  an outstanding defect that must not be duplicated. Scoping the index to
--  `open` alone would let a second obligation appear the moment the first
--  was picked up, which is exactly when a duplicate is most confusing.
--
--  A COMPLETED one is deliberately outside the index: if the defect is
--  resolved and later recurs, that is a NEW fact and deserves a new
--  obligation rather than being silently suppressed by a closed one.
--
--  ── ADDITIVE, AND SAFE TO APPLY BEFORE THE SWEEP EXISTS ─────────────
--  It constrains a (type, related_type) combination nothing writes yet, so
--  applying it changes no current behaviour. It is created NOT concurrently
--  because the qualifying set is empty — there is nothing to scan.
-- ════════════════════════════════════════════════════════════════════

create unique index if not exists uq_obl_proof_eval_missing_open
  on public.obligations (property_id, related_id)
  where related_type = 'work_order'
    and type = 'proof_evaluation_missing'
    and status <> 'complete';

comment on index public.uq_obl_proof_eval_missing_open is
  'Release 0 §4.2 — at most one outstanding proof_evaluation_missing obligation '
  'per (property, work order). Makes a duplicate unrepresentable rather than '
  'merely avoided, so the sweep can be idempotent by construction and retried '
  'without bookkeeping.';
