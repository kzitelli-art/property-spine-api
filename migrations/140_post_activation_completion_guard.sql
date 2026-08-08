-- ════════════════════════════════════════════════════════════════════
--  140 — COMPLETION TRUTH, ENFORCED AT COMMIT
--
--  ⚠ REVISION 3. Each revision was broken by measurement, not opinion.
--
--    rev 1  enforced only "not the missing_evaluation_defect state".
--           FOUR attacks walked past it (falsify_containment.js).
--    rev 2  required a current `satisfied` head. THREE more broke it
--           (falsify_activation_boundary.js, falsify_proof_trust.js):
--           the activation boundary was answerable from a stale snapshot,
--           `satisfied` was a word anyone could write, and the evidence
--           under a completion could be invalidated afterwards.
--
--  WHAT IT ENFORCES NOW, after the cutover:
--
--      NOT INVENTORIED
--        · not terminal                                        legal
--        · `complete` + a current `satisfied` head that CITES
--          qualifying preserved evidence                       legal
--        · `closed`                                            REFUSED (R0003)
--        · anything else terminal                              REFUSED (R0001/R0004)
--      INVENTORIED (pre-cutover legacy)
--        · status frozen at exactly `status_at_cutover`        legal
--        · any other status                                    REFUSED (R0002)
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
--      without proof.
--        → an inventoried row's status is FROZEN at what the census
--          recorded. Revision 2 required only "some terminal value",
--          which still permitted `closed → complete` with no evaluation:
--          a terminal-to-terminal rewrite relabelling history as a
--          governed completion.
--
--  A4  A TRANSACTION STRADDLING ACTIVATION at REPEATABLE READ committed,
--      because the deferred check reads through the transaction's frozen
--      snapshot. Closed on the other side: the activation takes SHARE ROW
--      EXCLUSIVE ... NOWAIT on work_orders. See activation_service.js.
--
--  B1  …BUT THAT ONLY COVERS A WRITER THAT ALREADY CONFLICTS. A
--      transaction that fixed a REPEATABLE READ snapshot on something
--      UNRELATED, waited the activation out, and touched work_orders only
--      afterwards never contended for that lock — and committed a
--      terminal work order the guard never judged. MEASURED.
--        → the activation epoch, read `for share`. See below.
--
--  C1  `satisfied` WAS JUST A WORD. Raw SQL could insert an evaluation
--      whose state column reads 'satisfied' with no evidence behind it and
--      terminalize the work order — moving the status bypass one table
--      over rather than closing it. We spent this release learning not to
--      trust work_orders.status; a column in another table has earned no
--      more trust than that one had.
--        → a satisfied head must CITE qualifying preserved evidence.
--
--  C2  THE EVIDENCE COULD ROT UNDERNEATH. Once evidence is part of the
--      invariant, `update work_order_proof_attachments set
--      proof_classification='unclassified'` — or un-storing it entirely —
--      hollows out a completed work order while touching NEITHER
--      work_orders NOR the evaluation. Both SUCCEEDED, and the reader went
--      on reporting `satisfied`.
--        → the predicate also fires on work_order_proof_attachments.
--
--  D1  `closed` WAS STILL AVAILABLE as a completion vocabulary. With
--      proof, revision 2 allowed a post-cutover `open → closed` — a second
--      permanently valid way to complete work, contradicting the frozen
--      Step 6 ruling that future completion writes `complete`.
--        → post-cutover `closed` is refused outright (R0003).
--
--  ── ONE PREDICATE, FOUR ENTRY POINTS ────────────────────────────────
--
--  `release_0_assert_completion_truth(uuid)` is the whole rule. The
--  triggers are thin wrappers that name the work order. Two copies of a
--  rule that must never differ is the drift this release exists to end.
--
--  ── WHAT IT DOES *NOT* GUARANTEE ────────────────────────────────────
--
--  IT PREVENTS TERMINAL-STATE / PROOF DIVERGENCE. IT DOES NOT MAKE
--  ARBITRARY SQL EQUIVALENT TO claimCompletion. A deliberate writer that
--  establishes real evidence and cites it can still commit a work order
--  with no progress rows, no obligation closure and no receipt — proof-
--  true and structurally hollow (falsify_proof_trust H1–H4). The Step 4
--  fact set catches that; the canonical service still owns the full
--  eight-fact completion transaction, and no receipt may claim otherwise.
--
--  ── STILL DEFERRED, STILL STATE-BASED ───────────────────────────────
--
--  All four fire at COMMIT, so statement order is irrelevant: a
--  transaction may write the status first and the evaluation second, or
--  pass THROUGH an illegal state, provided it does not END in one. The
--  predicate re-reads current rows and never judges `NEW`.
--
--  A consequence worth stating: correcting completed work is a REOPEN.
--  Recording a superseding `not_satisfied` while the row stays terminal is
--  refused; doing it in one transaction with a status change out of
--  terminal is allowed (falsify_proof_trust P9). The evidence is always
--  recordable — what is refused is claiming completion while saying so.
--
--  ── STILL INERT BEFORE ACTIVATION ───────────────────────────────────
--
--  With no activation the reader reports `unavailable`, never a proof
--  verdict, and pre-cutover terminal rows are exactly what the census
--  inventories. So this is safe to apply at any time — and it must be
--  applied BEFORE the activation, which now REFUSES to run without it.
--
--  ── THE BYPASS SURFACE, STATED EXACTLY ──────────────────────────────
--
--    ordinary DML (anything holding DATABASE_URL)   COVERED
--    a stale REPEATABLE READ snapshot               COVERED (40001)
--    SET CONSTRAINTS ALL IMMEDIATE                  moves the check
--                                                   earlier, never skips
--    session_replication_role = replica             SUPERUSER-ONLY
--    DROP/DISABLE TRIGGER by the TABLE OWNER        *** POSSIBLE ***
--
--  The last one is measured, not assumed: a non-superuser that OWNS
--  work_orders can drop these triggers. So the honest claim is
--  ACCIDENTAL DML BYPASS PREVENTED; PRIVILEGED DDL REMAINS AN AUDITABLE
--  ESCAPE. Step 7 refuses to activate unless the guard is present,
--  correctly defined, deferred AND ENABLED.
-- ════════════════════════════════════════════════════════════════════

--  ── THE ACTIVATION EPOCH ────────────────────────────────────────────
--  A SINGLETON ROW THAT EXISTS FROM THE MOMENT THIS MIGRATION APPLIES,
--  and which the activation UPDATES rather than inserts. That distinction
--  is the entire fix for B1: an INSERT is invisible to an older snapshot,
--  an UPDATE of a pre-existing row is a serialization conflict.
create table if not exists public.release_0_activation_epoch (
  id            boolean primary key default true check (id),
  activation_id uuid,
  activated_at  timestamptz,
  stamped_at    timestamptz
);
insert into public.release_0_activation_epoch (id) values (true)
  on conflict (id) do nothing;

--  Stamped BY A TRIGGER, not by the caller. The epoch must move in the
--  same transaction as the activation for every writer, including hand-run
--  SQL that never calls activation_service.js.
create or replace function public.release_0_stamp_activation_epoch()
returns trigger as $$
begin
  update public.release_0_activation_epoch
     set activation_id = new.id,
         activated_at  = new.activated_at,
         stamped_at    = now()
   where id;
  return null;
end;
$$ language plpgsql;
alter function public.release_0_stamp_activation_epoch() set search_path = public, pg_temp;

drop trigger if exists stamp_activation_epoch on public.release_0_activation_history;
create trigger stamp_activation_epoch
  after insert on public.release_0_activation_history
  for each row
  execute function public.release_0_stamp_activation_epoch();

--  Backfill, so applying this to an ALREADY-ACTIVATED database is correct
--  rather than silently inert. (Not the intended order — the runbook puts
--  this before the activation — but a guard that is wrong when applied
--  late is worse than one that refuses.)
update public.release_0_activation_epoch e
   set activation_id = h.id, activated_at = h.activated_at, stamped_at = now()
  from (select id, activated_at from public.release_0_activation_history
         order by recorded_at desc limit 1) h
 where e.id and e.activation_id is null;

create or replace function public.release_0_assert_completion_truth(p_work_order uuid)
returns void as $$
declare
  v_status       text;
  v_property     uuid;
  v_inventoried  boolean;
  v_at_cutover   text;
  v_head_id      uuid;
  v_head_state   text;
  v_activation   uuid;
begin
  select status, property_id into v_status, v_property
    from public.work_orders where id = p_work_order;
  if not found then
    return;                       -- deleted in this transaction
  end if;

  --  ══ B1 — THE ACTIVATION BOUNDARY, READ SO THAT IT CANNOT BE STALE ══
  --
  --  This was `if not exists (select 1 from release_0_activation_current)`
  --  and it was BYPASSABLE. A transaction that opens at REPEATABLE READ,
  --  fixes its snapshot on any unrelated read, waits for the activation to
  --  commit, and only THEN writes a terminal work order answers this
  --  question through its own pre-activation snapshot. The guard returned
  --  immediately and the row committed unjudged — measured, not feared
  --  (falsify_activation_boundary.js S3). The SHARE ROW EXCLUSIVE barrier
  --  in the activation cannot help: that transaction wanted no lock while
  --  the activation held one.
  --
  --  NO ORDINARY SELECT CAN FIX THIS. A snapshot does not escape itself.
  --  A ROW-LOCKING read can: in REPEATABLE READ, `for share` against a row
  --  whose latest version was committed after this transaction's snapshot
  --  raises 40001 (could not serialize access) instead of quietly
  --  answering from the past. The stale writer is REFUSED rather than
  --  exempted.
  --
  --  Which is why the epoch is a pre-existing row that the activation
  --  UPDATES. Had it been an inserted row, the stale snapshot would simply
  --  not see it and there would be nothing to conflict with.
  --
  --  `for share` and not `for update`: many completions commit
  --  concurrently and they must not serialize against each other. Shared
  --  locks coexist; the only conflict is with the one transaction that
  --  moves the epoch.
  select activation_id into v_activation
    from public.release_0_activation_epoch
   where id
     for share;

  --  Inert before the cutover: nothing here is a proof verdict yet.
  if v_activation is null then
    return;
  end if;

  select true, status_at_cutover into v_inventoried, v_at_cutover
    from public.release_0_legacy_cutover_inventory
   where work_order_id = p_work_order and property_id = v_property;
  v_inventoried := coalesce(v_inventoried, false);

  --  ══ A3 / D2 — LEGACY HISTORY IS FROZEN, EXACTLY AS IT WAS ══════════
  --  Revision 2 required only that an inventoried row stay "some terminal
  --  value", which still permitted `closed → complete` with no evaluation:
  --  a terminal-to-terminal rewrite that re-labels historical work as a
  --  governed completion. Grandfathering preserves historical truth; it is
  --  not a standing exemption. The status is pinned to what the census
  --  actually recorded.
  if v_inventoried and v_status is distinct from v_at_cutover then
    raise exception
      'work order % is cutover legacy history: its status is frozen at ''%'', not ''%''',
      p_work_order, v_at_cutover, v_status
      using errcode = 'R0002',
            detail  = 'It is in release_0_legacy_cutover_inventory, which is immutable. '
                   || 'If its status could move, the inventory would exempt a NEW '
                   || 'completion as though it were history.',
            hint    = 'Reopening or re-completing pre-cutover work is a separate governed '
                   || 'act this release does not build. Raise new work instead.';
  end if;
  if v_inventoried then
    return;                       -- unchanged legacy history
  end if;

  if v_status is null or v_status not in ('complete', 'closed') then
    return;                       -- not terminal: nothing to justify
  end if;

  --  ══ D1 — `closed` IS HISTORICAL VOCABULARY, AND ONLY THAT ══════════
  --  Step 6 froze the ruling that future completion writes `complete`;
  --  `closed` belongs to the legacy done-path this release retires. A
  --  post-cutover `closed` row is therefore refused EVEN WITH a satisfied
  --  evaluation. Revision 2 allowed it, because it asked only "is the
  --  proof good?" — which would have let `open → closed` become a second,
  --  permanently legal completion vocabulary the day after activation.
  if v_status = 'closed' then
    raise exception
      'work order % may not be set to ''closed'' after the cutover', p_work_order
      using errcode = 'R0003',
            detail  = '`closed` is the LEGACY done-path vocabulary. It is legitimate only '
                   || 'on rows the census inventoried before the cutover; after it, the '
                   || 'canonical completion status is `complete`.',
            hint    = 'Use the canonical writer '
                   || '(technician.lifecycle_service.claimCompletion), which sets '
                   || '`complete` and records the proof evaluation in one transaction.';
  end if;

  select id, state into v_head_id, v_head_state
    from public.work_order_proof_evaluation_head
   where work_order_id = p_work_order and property_id = v_property;

  --  ══ C1 — THE TRUST ROOT: `satisfied` MUST BE GROUNDED ══════════════
  --
  --  Revision 2 trusted the word. Nothing stopped raw SQL from inserting
  --  an evaluation whose `state` column says 'satisfied' with NO linked
  --  evidence at all, and then terminalizing the work order — which does
  --  not defeat the guard so much as move it one table over. We spent this
  --  release learning not to trust `work_orders.status`; a column in a
  --  different table that happens to read 'satisfied' has earned no more
  --  trust than that one had.
  --
  --  So a satisfied head must CITE at least one attachment that qualifies
  --  under the SAME predicate the canonical writer's evidence gate uses —
  --  facts about the stored bytes, not a carrier's claim. The writer links
  --  exactly the rows that gate returned
  --  (technician/evidence_service.completionEligibleEvidenceFor), so a
  --  genuine completion always passes; only a manufactured one does not.
  --
  --  ⚠ THIS IS A THIRD COPY OF THAT PREDICATE, and copies drift. The
  --  classification and MIME arrays are pinned against the service's
  --  exported constants by tests/gate_completion_guard_terminal_set.js.
  if v_head_state = 'satisfied' then
    if exists (
      select 1
        from public.work_order_proof_evaluation_attachments l
        join public.work_order_proof_attachments a
          on  a.id            = l.attachment_id
          and a.work_order_id = l.work_order_id
          and a.property_id   = l.property_id
       where l.evaluation_id = v_head_id
         and l.work_order_id = p_work_order
         and l.property_id   = v_property
         and a.storage_state = 'stored'
         and a.content    is not null
         and a.byte_size  is not null
         and a.sha256     is not null
         and a.stored_at  is not null
         and a.mime_type            = any (array['image/jpeg', 'image/png', 'image/webp'])
         and a.proof_classification = any (array['repair_photo', 'condition'])
    ) then
      return;                     -- a completion we are entitled to believe
    end if;

    raise exception
      'work order % is terminal on a `satisfied` evaluation that cites no qualifying preserved evidence',
      p_work_order
      using errcode = 'R0004',
            detail  = 'The evaluation says `satisfied`, but no attachment it links to is '
                   || 'stored with content, byte_size, sha256 and stored_at present, an '
                   || 'allowed image MIME, and a repair_photo/condition classification. '
                   || '`satisfied` is a claim about evidence; without the evidence it is '
                   || 'just a word in a column.',
            hint    = 'Complete through technician.lifecycle_service.claimCompletion, which '
                   || 'evaluates the stored bytes and links exactly what it evaluated. This '
                   || 'refusal means the proof was asserted rather than established.';
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

  --  No evaluation at all, and not inventoried — the inventoried case
  --  returned above, where its status is also pinned.
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

--  C2 — THE THIRD TABLE. Once a `satisfied` head must CITE qualifying
--  evidence, the attachment row becomes part of the invariant, and it can
--  be changed without touching work_orders OR the evaluation:
--
--    update work_order_proof_attachments set proof_classification='unclassified'
--    update work_order_proof_attachments set storage_state='not_preserved', content=null…
--
--  Both SUCCEEDED (falsify_proof_trust P1/P2) and the reader went on
--  reporting `satisfied`, because it reads the evaluation head and not the
--  bytes. The completion was left resting on evidence that no longer
--  qualified, and nothing anywhere noticed. Same lesson as A2, one table
--  further out: a cross-table invariant needs a trigger on every table
--  that can move it.
--
--  DELETE is already refused by fk_wopea_attach_scope ON DELETE RESTRICT
--  for any CITED attachment, and an uncited one is not evidence for
--  anything — so UPDATE is the gap, and only UPDATE is added.
create or replace function public.release_0_guard_attachment()
returns trigger as $$
begin
  perform public.release_0_assert_completion_truth(new.work_order_id);
  return null;
end;
$$ language plpgsql;
alter function public.release_0_guard_attachment() set search_path = public, pg_temp;

drop trigger if exists guard_terminal_completion on public.work_orders;
drop trigger if exists assert_no_manufactured_defect on public.work_orders;
drop trigger if exists assert_completion_truth_ins on public.work_orders;
drop trigger if exists assert_completion_truth_upd on public.work_orders;
drop trigger if exists assert_completion_truth_eval on public.work_order_proof_evaluations;
drop trigger if exists assert_completion_truth_attach on public.work_order_proof_attachments;

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

--  C2 — and the evidence itself. No WHEN clause: attachment updates are
--  rare (the ingress pipeline flips storage_state once), and an
--  enumeration of "the columns that matter" is exactly the kind of list
--  that goes stale the day a column is added. The predicate re-reads the
--  current state and returns immediately for anything not terminal.
create constraint trigger assert_completion_truth_attach
  after update on public.work_order_proof_attachments
  deferrable initially deferred
  for each row
  execute function public.release_0_guard_attachment();

comment on function public.release_0_assert_completion_truth(uuid) is
  'Release 0: at COMMIT, a work order may be terminal only with a current `satisfied` '
  'evaluation, or as inventoried pre-cutover legacy with no evaluation at all; and '
  'inventoried legacy may not leave the terminal state. Inert before activation. '
  'Enforced from work_orders (insert/update) and work_order_proof_evaluations (insert).';
