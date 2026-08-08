-- ════════════════════════════════════════════════════════════════════
--  140 — POST-ACTIVATION COMPLETION GUARD
--
--  After the cutover, a work order may not become terminal unless a proof
--  evaluation justifies it. Enforced by the DATABASE, so it holds for
--  every writer: application code, a utility script, a psql session, a
--  future route nobody has written yet.
--
--  ── WHY THIS EXISTS ─────────────────────────────────────────────────
--
--  Step 6 closes the one legacy done-path we know about. It cannot close
--  the ones we do not: this repository still carries 87 scripts that
--  build a connection from DATABASE_URL with no guard, 67 of them
--  write-capable (tests/gate_harness_isolation.js).
--
--  Before activation a stray `closed` row is untidy. AFTER activation it
--  is terminal, absent from the immutable inventory, and therefore
--  `missing_evaluation_defect` — an obligation raised against a named
--  role for something the SYSTEM did. And the activation is not
--  reversible: the inventory tables are append-only.
--
--  A repo-wide cleanup of 67 scripts cannot produce a guarantee, because
--  it says nothing about the 68th. One boundary the writes must pass
--  through can.
--
--  ── IT IS INERT UNTIL ACTIVATION, ON PURPOSE ────────────────────────
--
--  With no activation row this trigger returns immediately. That is not
--  a weakness — before the cutover, legacy terminal rows are exactly
--  what the inventory exists to record, and blocking them would break
--  the census this release depends on.
--
--  It means this migration is SAFE TO APPLY AT ANY TIME. It changes no
--  behaviour until Step 7 runs, and then it arms itself. It does not
--  need its own deployment window, and it must not be sequenced after
--  activation — the window it protects opens the instant the activation
--  commits.
--
--  ── WHY THE CANONICAL WRITER PASSES WITHOUT CHANGES ─────────────────
--
--  `claimCompletion` writes the proof evaluation BEFORE it sets the
--  status, deliberately (§4, "written first and the rest is contingent
--  on it"). So by the time this trigger runs, in the same transaction,
--  the evaluation head already exists. The guard required no change to
--  the writer, which is the strongest evidence it is drawn at the right
--  boundary.
--
--  ── ITS TERMINAL SET IS THE READER'S ────────────────────────────────
--
--  'complete' and 'closed' — the same two statuses as
--  release0/proof_state.js TERMINAL_STATUSES and the same as the §4.2
--  sweep. Two predicates that can drift is the defect this release
--  exists to end, so a source gate asserts they still agree
--  (tests/gate_completion_guard_terminal_set.js).
--
--  ── NO BYPASS ───────────────────────────────────────────────────────
--
--  There is deliberately no session flag, no GUC and no service-role
--  exemption. A bypass that a utility script can set is not a guarantee;
--  it is a comment. Removing this guard requires DROP TRIGGER — a
--  deliberate, auditable DDL act by someone holding the privilege.
--
--  ── WHAT IT DOES NOT DO ─────────────────────────────────────────────
--
--  It does not police a work order that is ALREADY terminal: an update
--  that touches a completed row's columns is not a new completion.
--  It does not constrain the status vocabulary — `status` has no CHECK
--  constraint on this table, so a writer could still invent a value like
--  'Complete' that neither this guard nor the reader treats as terminal.
--  That row would be invisible rather than a manufactured defect; it is
--  a different (and smaller) problem, and it is recorded rather than
--  quietly folded in here.
-- ════════════════════════════════════════════════════════════════════

create or replace function public.release_0_guard_terminal_completion()
returns trigger as $$
declare
  v_activated    boolean;
  v_inventoried  boolean;
  v_evaluated    boolean;
begin
  --  1. Only a transition INTO a terminal status is a completion.
  if new.status is null or new.status not in ('complete', 'closed') then
    return new;
  end if;

  --  An already-terminal row being touched is not a new completion.
  if tg_op = 'UPDATE' and old.status is not null
     and old.status in ('complete', 'closed') then
    return new;
  end if;

  --  2. INERT BEFORE THE CUTOVER. Legacy terminal rows are what the
  --     inventory is for; blocking them would break the census.
  select exists (select 1 from public.release_0_activation_current)
    into v_activated;
  if not v_activated then
    return new;
  end if;

  --  3. A row the cutover inventoried is legitimate legacy history.
  select exists (
    select 1 from public.release_0_legacy_cutover_inventory
     where work_order_id = new.id and property_id = new.property_id
  ) into v_inventoried;
  if v_inventoried then
    return new;
  end if;

  --  4. A governed completion has an evaluation. The canonical writer
  --     has already written it, in this transaction, by now.
  select exists (
    select 1 from public.work_order_proof_evaluation_head
     where work_order_id = new.id and property_id = new.property_id
  ) into v_evaluated;
  if v_evaluated then
    return new;
  end if;

  --  5. EXPLICIT REFUSAL. Never a silent rewrite to a different status,
  --     and never a swallowed no-op: the caller's transaction fails and
  --     it is told exactly what is missing and what to use instead.
  raise exception
    'work order % cannot become ''%'' : the cutover is active and this work order has no proof evaluation',
    new.id, new.status
    using errcode = 'R0001',
          detail  = 'Post-activation, a terminal status requires a row in '
                 || 'work_order_proof_evaluations (or membership in '
                 || 'release_0_legacy_cutover_inventory for pre-cutover history).',
          hint    = 'Complete work through the canonical writer '
                 || '(technician.lifecycle_service.claimCompletion), which records the '
                 || 'evaluation and the status in ONE transaction. If you are running a '
                 || 'repair or utility script, it must not close maintenance work.';
end;
$$ language plpgsql;

alter function public.release_0_guard_terminal_completion()
  set search_path = public, pg_temp;

drop trigger if exists guard_terminal_completion on public.work_orders;
create trigger guard_terminal_completion
  before insert or update on public.work_orders
  for each row execute function public.release_0_guard_terminal_completion();

comment on function public.release_0_guard_terminal_completion() is
  'Release 0: after the cutover activation, refuses any transition of a work order '
  'into complete/closed without a proof evaluation or a cutover inventory row. '
  'Inert before activation. No bypass by design — removal is DROP TRIGGER.';
