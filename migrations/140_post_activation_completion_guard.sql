-- ════════════════════════════════════════════════════════════════════
--  140 — THE FORBIDDEN COMMITTED STATE
--
--  After the cutover, NO NON-INVENTORIED WORK ORDER MAY COMMIT IN A
--  TERMINAL STATE THAT THE CANONICAL READER WOULD CLASSIFY AS
--  `missing_evaluation_defect`.
--
--  That state, and only that state, manufactures a false accountability
--  obligation: the §4.2 sweep raises `proof_evaluation_missing` against a
--  named role for something the SYSTEM did. The activation is not
--  reversible — the inventory tables are append-only — so the window
--  opens the instant the activation commits and never closes.
--
--  ── IT PROTECTS THE STATE, NOT THE CALLER ───────────────────────────
--
--  This is deliberately NOT "only claimCompletion may write a
--  completion". Caller identity is unenforceable at the database and
--  worthless against hand-run SQL. What is enforceable is the shape of
--  the committed row, and that is the thing that actually causes harm.
--
--  Consequences of choosing the state:
--    · any writer may complete work, PROVIDED it leaves a legal state
--    · a future caller nobody has written yet is already covered
--    · no application flag, no session variable, no service role — none
--      of which survives a second process sharing DATABASE_URL
--
--  ── DEFERRED: ONLY THE COMMITTED STATE IS JUDGED ────────────────────
--
--  A CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED. It fires at
--  COMMIT, not per statement, so a transaction may write its facts in
--  any order it likes:
--
--      begin;
--        update work_orders set status='complete' ...;   -- terminal first
--        insert into work_order_proof_evaluations ...;   -- evidence after
--      commit;                                           -- LEGAL
--
--  An immediate trigger would refuse that, and would therefore couple
--  this guard to the canonical writer's current statement order. §4
--  happens to write the evaluation first — but pinning a database
--  invariant to a code ordering means an innocuous refactor breaks
--  production. Deferring removes the coupling entirely.
--
--  It also means a transaction may pass THROUGH the forbidden state and
--  still commit, provided it does not END there.
--
--  ── IT RE-READS. IT DOES NOT TRUST `NEW`. ───────────────────────────
--
--  `NEW` is a snapshot of the row as it was when the event was queued.
--  By commit time the row may have moved again, so the function reads
--  the CURRENT row and uses `NEW` only for identity. Judging `NEW.status`
--  would judge an intermediate state — exactly what deferring exists to
--  avoid.
--
--  ── ONE FORBIDDEN STATE, NOT A SECOND READER ────────────────────────
--
--  release0/proof_state.js derives four states. This enforces the
--  negation of exactly ONE of them and knows nothing about the other
--  three:
--
--      an evaluation head exists            → satisfied / not_satisfied
--      not terminal                         → not yet due
--      terminal + inventoried               → legacy_indeterminate
--      terminal + NOT inventoried + no head → *** FORBIDDEN ***
--
--  Note it accepts ANY head, including `not_satisfied`. A work order
--  that was evaluated and FAILED is not a defect — it is a judgement
--  that was made. Requiring `satisfied` would enforce more than the
--  forbidden state and would block a legitimate outcome.
--
--  Interpretation still belongs to the reader and the sweep. The
--  database only refuses the one state that cannot be allowed to exist.
--
--  ── ACTIVATION-AWARE: INERT UNTIL THE CUTOVER ───────────────────────
--
--  With no activation row the reader reports `unavailable`, not
--  `missing_evaluation_defect` — so before the cutover there is no
--  forbidden state and this returns immediately. Pre-cutover terminal
--  rows are exactly what the census inventories; blocking them would
--  break the inventory the release depends on.
--
--  SO IT IS SAFE TO APPLY AT ANY TIME, and it MUST NOT be applied after
--  the activation: the window it protects opens when that transaction
--  commits.
--
--  ── WHAT CAN STILL DEFEAT IT (measured, not assumed) ────────────────
--
--    DROP TRIGGER                     by the table owner. Deliberate,
--                                     auditable DDL. No flag, by design.
--    session_replication_role=replica DISABLES constraint triggers —
--                                     but setting it is SUPERUSER-ONLY.
--                                     A non-superuser role is refused
--                                     with "permission denied to set
--                                     parameter". Everything holding
--                                     DATABASE_URL is therefore covered.
--
--  `SET CONSTRAINTS ALL IMMEDIATE` does NOT defeat it: that moves the
--  check earlier, it does not skip it. Proven, not assumed.
-- ════════════════════════════════════════════════════════════════════

create or replace function public.release_0_assert_no_manufactured_defect()
returns trigger as $$
declare
  v_status    text;
  v_property  uuid;
begin
  --  THE CURRENT ROW, not NEW. See the header: NEW is the queued
  --  snapshot; only the committed state is judged.
  select status, property_id into v_status, v_property
    from public.work_orders where id = new.id;

  --  Deleted later in the same transaction. Nothing can be a defect.
  if not found then
    return null;
  end if;

  --  Not terminal at commit — including a row that passed through a
  --  terminal status and was moved back.
  if v_status is null or v_status not in ('complete', 'closed') then
    return null;
  end if;

  --  Before the cutover the reader says `unavailable`, never `defect`.
  if not exists (select 1 from public.release_0_activation_current) then
    return null;
  end if;

  --  Legitimate legacy history, frozen by the cutover census.
  if exists (
    select 1 from public.release_0_legacy_cutover_inventory
     where work_order_id = new.id and property_id = v_property
  ) then
    return null;
  end if;

  --  ANY evaluation head, satisfied or not. A judgement that was made is
  --  not a missing judgement.
  if exists (
    select 1 from public.work_order_proof_evaluation_head
     where work_order_id = new.id and property_id = v_property
  ) then
    return null;
  end if;

  --  THE FORBIDDEN STATE. Explicit, never a silent rewrite to some other
  --  status: the caller's transaction fails and nothing is committed.
  raise exception
    'work order % would commit as ''%'' with no proof evaluation and no cutover inventory row',
    new.id, v_status
    using errcode = 'R0001',
          detail  = 'This is the committed state the canonical reader classifies as '
                 || 'missing_evaluation_defect. Post-activation it would raise a '
                 || 'proof_evaluation_missing obligation against a named role for '
                 || 'something no human did wrong.',
          hint    = 'Either record a proof evaluation for this work order in the same '
                 || 'transaction (the canonical writer, '
                 || 'technician.lifecycle_service.claimCompletion, does this), or do not '
                 || 'leave it in a terminal status. Statement order does not matter — '
                 || 'only the state at COMMIT is judged.';
end;
$$ language plpgsql;

alter function public.release_0_assert_no_manufactured_defect()
  set search_path = public, pg_temp;

drop trigger if exists guard_terminal_completion on public.work_orders;
drop trigger if exists assert_no_manufactured_defect on public.work_orders;

--  WHEN (new.status in (...)) keeps ordinary work-order writes free of any
--  cost: a non-terminal write queues no event at all. It cannot create a
--  hole — a row whose COMMITTED status is terminal must have had some
--  statement set it terminal, and that statement queues the event.
create constraint trigger assert_no_manufactured_defect
  after insert or update on public.work_orders
  deferrable initially deferred
  for each row
  when (new.status in ('complete', 'closed'))
  execute function public.release_0_assert_no_manufactured_defect();

comment on function public.release_0_assert_no_manufactured_defect() is
  'Release 0: refuses to COMMIT a work order in the one state the canonical reader '
  'classifies as missing_evaluation_defect (terminal, post-activation, not inventoried, '
  'no evaluation head). Deferred, so statement order is irrelevant. Inert before '
  'activation. No bypass flag by design; removal is DROP TRIGGER.';
