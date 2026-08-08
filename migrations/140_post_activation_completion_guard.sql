-- ════════════════════════════════════════════════════════════════════
--  140 — COMPLETION TRUTH, ENFORCED AT COMMIT
--
--  ⚠ REVISION 2. The first version enforced only "not the
--  missing_evaluation_defect state", and FOUR adversarial cases broke it
--  (tools/step12/falsify_containment.js). The invariant was wrong, not
--  the callers. What it enforces now:
--
--      AFTER ACTIVATION, A WORK ORDER IS LEGAL ONLY IF
--        · it is not terminal, or
--        · it is terminal WITH A CURRENT `satisfied` EVALUATION, or
--        · it is terminal, INVENTORIED, and has no evaluation at all
--          (legitimate pre-cutover legacy history)
--      AND an inventoried legacy row MAY NOT LEAVE the terminal state.
--
--  ── WHAT BROKE, AND WHY EACH CLAUSE EXISTS ──────────────────────────
--
--  A1  TERMINAL + A FAILED EVALUATION was allowed. The reader then
--      reported status=complete with proof.state=not_satisfied — a
--      completion the system cannot stand behind — reached without ever
--      touching missing_evaluation_defect.
--
--      Revision 1 accepted any head on the reasoning that "a judgement
--      was made". True, and beside the point: RELEASE 0 GOVERNS
--      COMPLETION, NOT WHETHER SOMEBODY MADE A JUDGEMENT. A failed proof
--      evaluation is perfectly valid data and is NOT sufficient to
--      justify a terminal status.
--        → the head must be `satisfied`.
--
--  A2  THE PROOF HEAD COULD BE FLIPPED AFTER COMPLETION. Appending a
--      `not_satisfied` evaluation that supersedes the satisfied head
--      touches NO work-order row, so a work_orders trigger never fired.
--      The invariant is CROSS-TABLE and one table's trigger cannot hold
--      it.
--        → the same predicate also fires on work_order_proof_evaluations.
--
--  A3  LEGACY EXEMPTION LAUNDERING. `closed → open → closed` on an
--      inventoried row was allowed, and the reader still called the
--      result `legacy_indeterminate`. The inventory is immutable, so
--      membership was a PERMANENT, REUSABLE LICENCE to complete work
--      without proof — historical grandfathering turned into a future
--      bypass.
--        → an inventoried row may not leave terminal at all. Legacy
--          history is frozen. Reopening it is "a different, governed act
--          that this slice does not build" (lifecycle_service), and this
--          makes that sentence true rather than aspirational.
--
--  A4  A TRANSACTION STRADDLING ACTIVATION at REPEATABLE READ committed,
--      because the deferred check reads through the transaction's frozen
--      snapshot and never saw the activation. That is NOT fixable here —
--      no SELECT escapes its own snapshot — so it is closed on the other
--      side: the activation transaction takes SHARE ROW EXCLUSIVE on
--      work_orders, which conflicts with any in-flight DML. See
--      release0/activation_service.js. READ COMMITTED was already refused
--      correctly.
--
--  ── ONE PREDICATE, THREE ENTRY POINTS ───────────────────────────────
--
--  `release_0_assert_completion_truth(uuid)` is the whole rule. The
--  triggers are thin wrappers that name the work order. Two copies of a
--  rule that must never differ is the drift this release exists to end.
--
--  ── STILL DEFERRED, STILL STATE-BASED ───────────────────────────────
--
--  All three fire at COMMIT, so statement order is irrelevant: a
--  transaction may write the status first and the evaluation second, or
--  pass THROUGH an illegal state, provided it does not END in one. The
--  predicate re-reads current rows and never judges `NEW`.
--
--  ── STILL INERT BEFORE ACTIVATION ───────────────────────────────────
--
--  With no activation the reader reports `unavailable`, never a proof
--  verdict, and pre-cutover terminal rows are exactly what the census
--  inventories. So this is safe to apply at any time — and it must be
--  applied BEFORE the activation, because the window opens when that
--  transaction commits.
--
--  ── THE BYPASS SURFACE, STATED EXACTLY ──────────────────────────────
--
--    ordinary DML (anything holding DATABASE_URL)   COVERED
--    SET CONSTRAINTS ALL IMMEDIATE                  moves the check
--                                                   earlier, never skips
--    session_replication_role = replica             SUPERUSER-ONLY
--    DROP TRIGGER by the TABLE OWNER                *** POSSIBLE ***
--
--  The last one is measured, not assumed: a non-superuser that OWNS
--  work_orders can drop these triggers. So the honest claim is
--  ACCIDENTAL DML BYPASS PREVENTED; PRIVILEGED DDL REMAINS AN AUDITABLE
--  ESCAPE. Step 7 refuses to activate unless the guard is present and
--  matches its expected definition, so dropping it cannot go unnoticed
--  before the one irreversible act.
-- ════════════════════════════════════════════════════════════════════

create or replace function public.release_0_assert_completion_truth(p_work_order uuid)
returns void as $$
declare
  v_status       text;
  v_property     uuid;
  v_inventoried  boolean;
  v_head_state   text;
begin
  select status, property_id into v_status, v_property
    from public.work_orders where id = p_work_order;
  if not found then
    return;                       -- deleted in this transaction
  end if;

  --  Inert before the cutover: nothing here is a proof verdict yet.
  if not exists (select 1 from public.release_0_activation_current) then
    return;
  end if;

  select exists (
    select 1 from public.release_0_legacy_cutover_inventory
     where work_order_id = p_work_order and property_id = v_property
  ) into v_inventoried;

  --  A3 — LEGACY HISTORY IS FROZEN. Without this, membership of the
  --  immutable inventory is a permanent licence: reopen, re-close, and
  --  the row is laundered back into `legacy_indeterminate` with no
  --  evaluation.
  if v_inventoried and (v_status is null or v_status not in ('complete', 'closed')) then
    raise exception
      'work order % is cutover legacy history and may not leave a terminal status', p_work_order
      using errcode = 'R0002',
            detail  = 'It is in release_0_legacy_cutover_inventory, which is immutable. '
                   || 'If it could be reopened it could also be re-closed, and the '
                   || 'inventory would exempt that NEW completion as though it were history.',
            hint    = 'Reopening pre-cutover work is a separate governed act this release '
                   || 'does not build. Raise new work instead.';
  end if;

  if v_status is null or v_status not in ('complete', 'closed') then
    return;                       -- not terminal: nothing to justify
  end if;

  select state into v_head_state
    from public.work_order_proof_evaluation_head
   where work_order_id = p_work_order and property_id = v_property;

  --  A governed completion: the head says the proof was satisfied.
  if v_head_state = 'satisfied' then
    return;
  end if;

  --  A1 / A2 — evaluated and FAILED. Valid data; not a completion.
  if v_head_state is not null then
    raise exception
      'work order % cannot be terminal: its current proof evaluation is ''%''',
      p_work_order, v_head_state
      using errcode = 'R0001',
            detail  = 'Release 0 governs COMPLETION, not whether somebody made a '
                   || 'judgement. A failed proof evaluation is valid data and does not '
                   || 'justify a terminal status.',
            hint    = 'Either record a superseding `satisfied` evaluation, or take the '
                   || 'work order out of the terminal state. Only the state at COMMIT '
                   || 'is judged, so statement order does not matter.';
  end if;

  --  No evaluation at all. Legal only as inventoried legacy history.
  if v_inventoried then
    return;
  end if;

  raise exception
    'work order % would commit as ''%'' with no proof evaluation and no cutover inventory row',
    p_work_order, v_status
    using errcode = 'R0001',
          detail  = 'This is the committed state the canonical reader classifies as '
                 || 'missing_evaluation_defect. Post-activation it would raise a '
                 || 'proof_evaluation_missing obligation against a named role for '
                 || 'something no human did wrong.',
          hint    = 'Record a `satisfied` proof evaluation (the canonical writer, '
                 || 'technician.lifecycle_service.claimCompletion, does this in the same '
                 || 'transaction), or do not leave it terminal. Only the state at COMMIT '
                 || 'is judged, so statement order does not matter.';
end;
$$ language plpgsql;

alter function public.release_0_assert_completion_truth(uuid)
  set search_path = public, pg_temp;

--  Thin wrappers. The rule lives in exactly one place.
create or replace function public.release_0_guard_work_order()
returns trigger as $$
begin
  perform public.release_0_assert_completion_truth(new.id);
  return null;
end;
$$ language plpgsql;
alter function public.release_0_guard_work_order() set search_path = public, pg_temp;

create or replace function public.release_0_guard_evaluation()
returns trigger as $$
begin
  perform public.release_0_assert_completion_truth(new.work_order_id);
  return null;
end;
$$ language plpgsql;
alter function public.release_0_guard_evaluation() set search_path = public, pg_temp;

drop trigger if exists guard_terminal_completion on public.work_orders;
drop trigger if exists assert_no_manufactured_defect on public.work_orders;
drop trigger if exists assert_completion_truth_ins on public.work_orders;
drop trigger if exists assert_completion_truth_upd on public.work_orders;
drop trigger if exists assert_completion_truth_eval on public.work_order_proof_evaluations;

--  INSERT and UPDATE are separate triggers because a WHEN clause on an
--  INSERT trigger may not reference OLD, and the UPDATE case must also
--  fire when a row LEAVES a terminal status (A3).
create constraint trigger assert_completion_truth_ins
  after insert on public.work_orders
  deferrable initially deferred
  for each row
  when (new.status in ('complete', 'closed'))
  execute function public.release_0_guard_work_order();

create constraint trigger assert_completion_truth_upd
  after update on public.work_orders
  deferrable initially deferred
  for each row
  when (new.status in ('complete', 'closed') or old.status in ('complete', 'closed'))
  execute function public.release_0_guard_work_order();

--  A2 — THE CROSS-TABLE HALF. Appending an evaluation can change the
--  head under a terminal work order without touching work_orders at all.
--  Evaluations are append-only, so INSERT is the only way in.
create constraint trigger assert_completion_truth_eval
  after insert on public.work_order_proof_evaluations
  deferrable initially deferred
  for each row
  execute function public.release_0_guard_evaluation();

comment on function public.release_0_assert_completion_truth(uuid) is
  'Release 0: at COMMIT, a work order may be terminal only with a current `satisfied` '
  'evaluation, or as inventoried pre-cutover legacy with no evaluation at all; and '
  'inventoried legacy may not leave the terminal state. Inert before activation. '
  'Enforced from work_orders (insert/update) and work_order_proof_evaluations (insert).';
