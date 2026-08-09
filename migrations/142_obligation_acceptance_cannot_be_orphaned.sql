-- ════════════════════════════════════════════════════════════════════
--  142 — AN ACCEPTANCE MAY NOT OUTLIVE ITS ASSIGNMENT
--
--  Found by attacking the obligation ownership rail, before Ask Spine
--  was allowed to read it as canonical truth
--  (tools/build1/attack_obligation_ownership_rail.js, P7·D).
--
--  ── THE HOLE ───────────────────────────────────────────────────────
--
--  `ck_oblig_accepter_is_owner` reads:
--
--      accepted_by_user_id IS NULL OR assigned_user_id = accepted_by_user_id
--
--  and a CHECK constraint passes when its expression is NULL, not only
--  when it is TRUE. So with `assigned_user_id` set to NULL the comparison
--  yields NULL and the constraint waves it through:
--
--      update obligations set assigned_user_id = null where id = …;
--      -- succeeds, leaving accepted_by_user_id = Alice, assigned_user_id = NULL
--
--  An acceptance owned by nobody. Measured, not theorised: the attack
--  ran that statement against a real database and it committed.
--
--  ── WHY CLOSE IT IN THE DATABASE ───────────────────────────────────
--
--  No SHIPPED writer can reach it — `operator_actions.assignTechnician`
--  refuses with `already_accepted`, and the claim route is refused by the
--  original constraint because it sets a non-null assignee. The exposure
--  is a psql session, an unguarded script, or a route nobody has written
--  yet. That is the same argument migration 140 makes about completion,
--  and it gets the same answer: the invariant belongs where it cannot be
--  forgotten.
--
--  ── NOT VALID, DELIBERATELY ────────────────────────────────────────
--
--  Added NOT VALID so it binds every future write immediately without
--  validating history. A plain ADD CONSTRAINT would abort the migration
--  — and therefore the deploy — if a single orphaned acceptance already
--  existed in production, turning a hardening change into an outage. The
--  orphans, if any, are a human judgement (restore the assignment, or
--  clear the acceptance) and this migration must not guess.
--
--  Find them, then validate:
--
--      select id, property_id, related_type, related_id,
--             accepted_by_user_id, accepted_at
--        from public.obligations
--       where accepted_by_user_id is not null and assigned_user_id is null;
--
--      -- once that returns zero rows:
--      alter table public.obligations validate constraint ck_oblig_acceptance_has_owner;
--
--  ── WHAT IS NOT CHANGED ────────────────────────────────────────────
--
--  The original `ck_oblig_accepter_is_owner` stays exactly as it is. It
--  still refuses accepted_by <> assigned_user, which is what stops a
--  reassignment from stranding a stale acceptance. This migration adds
--  the case that one cannot express, and removes nothing.
-- ════════════════════════════════════════════════════════════════════

alter table public.obligations
  drop constraint if exists ck_oblig_acceptance_has_owner;

alter table public.obligations
  add constraint ck_oblig_acceptance_has_owner
  check (accepted_by_user_id is null or assigned_user_id is not null)
  not valid;

comment on constraint ck_oblig_acceptance_has_owner on public.obligations is
  'Build 1 / migration 142: an acceptance may not outlive its assignment. '
  'ck_oblig_accepter_is_owner cannot express this because a CHECK passes on NULL. '
  'Added NOT VALID so it binds new writes without risking a deploy on legacy rows; '
  'VALIDATE it once the orphan query in the migration header returns zero.';
