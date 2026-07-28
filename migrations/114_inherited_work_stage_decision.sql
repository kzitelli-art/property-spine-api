-- ════════════════════════════════════════════════════════════════════
--  114 — INHERITED WORK MUST ENTER THE ORDERED FLOW
--
--  The correction migration 113 needed.
--
--  ── THE SEAM 113 LEFT OPEN ──────────────────────────────────────────
--  113 made `stage` nullable so BUILD 1 work would not be back-filled with a
--  guessed dependency. That was right while a unit has only initial-triage
--  evidence. It was WRONG the moment a complete turn scope is confirmed,
--  because the sequence reader treats NULL as:
--
--      stage = NULL  →  always actionable  →  never blocks paint or cleaning
--
--  So a real, known BUILD 1 blocker — "Refrigerator missing" — would sit
--  outside the flow forever after somebody confirmed a COMPLETE scope. Final
--  cleaning would read actionable with a missing refrigerator still open, and
--  the readiness walk would unblock with a known blocker unresolved.
--
--  That is the same failure shape as the defect BUILD 1 was built to correct:
--  an ABSENCE (no stage) silently reading as a POSITIVE fact (does not block).
--
--  ── THE RULE ────────────────────────────────────────────────────────
--  Unknown dependency must not silently mean "does not block."
--
--  Once a COMPLETE scope is confirmed, every unresolved inherited item must be
--  explicitly resolved one of three ways:
--    · placed in a stage
--    · marked stage-unknown, which REQUIRES a scope decision and BLOCKS
--      readiness while it stands
--    · superseded or withdrawn with an attributed reason
--
--  Anything left unaddressed is flagged by the service, blocks the readiness
--  walk, and surfaces a visible scope exception. It is never silently ignored.
--
--  A PARTIAL inspection may still retain unstaged work — the scope is
--  genuinely incomplete, so "not yet placed" is an honest state rather than an
--  unanswered question.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

-- ── stage_decision_required ─────────────────────────────────────────
--
--  TRUE means: this item is known and unresolved, a complete scope has been
--  confirmed around it, and NOBODY HAS DECIDED where it belongs in the turn.
--
--  It is deliberately distinct from `stage is null`:
--    stage null, flag false  →  not yet placed, and nothing has claimed the
--                               scope is complete. Honest incompleteness.
--    stage null, flag true   →  a complete scope was confirmed and this was
--                               left unplaced. An unanswered question, which
--                               blocks readiness and surfaces an exception.
--
--  Collapsing the two would make "nobody has looked yet" and "somebody said
--  they looked and this still has no answer" indistinguishable — and only the
--  second one is a problem.
alter table unit_triage_required_work
  add column if not exists stage_decision_required boolean not null default false;

--  Why the decision is outstanding, in plain words, so the exception surface
--  can say something better than "unknown". Written by the service when it
--  cannot confidently place an inherited item.
alter table unit_triage_required_work
  add column if not exists stage_decision_note text;

--  A flagged item must not ALSO carry a stage — that would be an answered
--  question still marked unanswered, and the two would disagree on every read.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ck_utrw_stage_decision_is_unplaced'
  ) then
    alter table unit_triage_required_work
      add constraint ck_utrw_stage_decision_is_unplaced
        check (stage_decision_required = false or stage is null);
  end if;
end $$;

create index if not exists idx_utrw_stage_decision
  on unit_triage_required_work(unit_id)
  where stage_decision_required and status = 'required';

-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────
--
--  It does not back-fill. Every existing row keeps stage_decision_required
--  = false, which is correct: no complete scope has been confirmed against
--  any of them yet. The flag is only ever set forward, by the service, at the
--  moment a complete scope is confirmed around an item nobody placed.
--
--  It does not guess a stage for any inherited item. Guessing is what 113
--  correctly refused to do, and this migration does not undo that refusal —
--  it makes the refusal VISIBLE instead of silent.
