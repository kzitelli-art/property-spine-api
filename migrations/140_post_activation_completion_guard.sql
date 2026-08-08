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

--  ════════════════════════════════════════════════════════════════════
--  THE ONE DEFINITION THE DATABASE ANSWERS FROM
--
--  Revision 3 left the evidence-qualification rule in THREE places: the
--  JS evidence gate, the activation's population check, and this guard. A
--  source gate comparing the classification/MIME arrays is not enough —
--  the CONDITIONS can drift while the arrays stay identical. Three
--  implementations of a load-bearing definition of truth is where
--  divergence eventually becomes a production incident.
--
--  So the database now has exactly ONE answer to one question, and every
--  database caller asks it here:
--
--    release_0_evidence_qualifies(attachment)  → is this photo proof?
--    release_0_completion_proof_status(wo, prop)
--         → 'grounded' | 'ungrounded' | 'not_satisfied' | 'none'
--
--  The deferred guard, the activation's population validation and the
--  audit view all call the second. There is no fourth interpretation.
--
--  ── WHAT STAYS IN JAVASCRIPT, AND WHY THAT IS NOT DUPLICATION ───────
--
--  `technician/evidence_service.completionEligibleEvidenceFor` does a
--  DIFFERENT job: it SELECTS which attachments a completion may be built
--  on, before the writer creates the evaluation. This VALIDATES what was
--  actually recorded. Two deliberate responsibilities — JS SELECTS, DB
--  VALIDATES — and their equivalence over the full matrix is proven in
--  tools/step12/prove_evidence_equivalence.js, not assumed from two
--  arrays looking alike.
--  ════════════════════════════════════════════════════════════════════

create or replace function public.release_0_evidence_qualifies(p_attachment uuid)
returns boolean as $q$
  --  Every clause is a fact ABOUT THE STORED BYTES, not a carrier's claim.
  --  THE single definition; nothing else in the database restates it.
  --  `unclassified` is deliberately absent (§3.1): an unclassified photo
  --  is not proof of a repair.
  select exists (
    select 1 from public.work_order_proof_attachments a
     where a.id = p_attachment
       and a.storage_state = 'stored'
       and a.content    is not null
       and a.byte_size  is not null
       and a.sha256     is not null
       and a.stored_at  is not null
       and a.mime_type            = any (array['image/jpeg', 'image/png', 'image/webp'])
       and a.proof_classification = any (array['repair_photo', 'condition'])
  );
$q$ language sql stable;
alter function public.release_0_evidence_qualifies(uuid) set search_path = public, pg_temp;

comment on function public.release_0_evidence_qualifies(uuid) is
  'Release 0: THE definition of evidence a completion may rest on. One copy, in the '
  'database. Mirrors technician/evidence_service.completionEligibleEvidenceFor, whose job '
  'is to SELECT rather than validate; equivalence is proven, not assumed.';

create or replace function public.release_0_completion_proof_status(
  p_work_order uuid, p_property uuid)
returns text as $q$
declare
  v_head_id    uuid;
  v_head_state text;
begin
  select id, state into v_head_id, v_head_state
    from public.work_order_proof_evaluation_head
   where work_order_id = p_work_order and property_id = p_property;

  if v_head_id is null then
    return 'none';
  end if;
  if v_head_state is distinct from 'satisfied' then
    return 'not_satisfied';
  end if;

  --  GROUNDED: the head cites at least one qualifying attachment, in this
  --  work order's own scope. The composite FK already makes a cross-scope
  --  link unrepresentable; the scope predicate says so out loud rather
  --  than resting on that alone.
  if exists (
    select 1
      from public.work_order_proof_evaluation_attachments l
     where l.evaluation_id = v_head_id
       and l.work_order_id = p_work_order
       and l.property_id   = p_property
       and public.release_0_evidence_qualifies(l.attachment_id)
  ) then
    return 'grounded';
  end if;

  return 'ungrounded';
end;
$q$ language plpgsql stable;
alter function public.release_0_completion_proof_status(uuid, uuid)
  set search_path = public, pg_temp;

comment on function public.release_0_completion_proof_status(uuid, uuid) is
  'Release 0: is this work order''s CURRENT proof evaluation a grounded `satisfied` one? '
  'grounded | ungrounded | not_satisfied | none. The deferred completion guard, the '
  'activation''s population validation and release_0_completion_invariant_violations all '
  'call this — one definition, not four interpretations.';

create or replace function public.release_0_assert_completion_truth(p_work_order uuid)
returns void as $$
declare
  v_status       text;
  v_property     uuid;
  v_inventoried  boolean;
  v_at_cutover   text;
  v_proof        text;
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

  --  ONE call, one definition. The mapping from status to error code is
  --  the only thing that lives here.
  v_proof := public.release_0_completion_proof_status(p_work_order, v_property);

  if v_proof = 'grounded' then
    return;                       -- a completion we are entitled to believe
  end if;

  --  ══ C1 — THE TRUST ROOT: `satisfied` MUST BE GROUNDED ══════════════
  --  Revision 2 trusted the word. Raw SQL could insert an evaluation whose
  --  `state` column reads 'satisfied' with NO linked evidence and then
  --  terminalize the work order — which does not defeat the guard so much
  --  as move it one table over.
  if v_proof = 'ungrounded' then
    raise exception
      'work order % is terminal on a `satisfied` evaluation that cites no qualifying preserved evidence',
      p_work_order
      using errcode = 'R0004',
            detail  = 'The evaluation says `satisfied`, but no attachment it links to '
                   || 'qualifies under release_0_evidence_qualifies(): stored, with '
                   || 'content, byte_size, sha256 and stored_at present, an allowed image '
                   || 'MIME, and a repair_photo/condition classification. `satisfied` is a '
                   || 'claim about evidence; without it, a word in a column.',
            hint    = 'Complete through technician.lifecycle_service.claimCompletion, which '
                   || 'evaluates the stored bytes and links exactly what it evaluated.';
  end if;

  --  A1 / A2 — evaluated and FAILED. Valid data; not a completion.
  if v_proof = 'not_satisfied' then
    raise exception
      'work order % cannot be terminal: its current proof evaluation is not satisfied',
      p_work_order
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

--  ════════════════════════════════════════════════════════════════════
--  C2 (REVISION 4) — EVIDENCE THAT JUSTIFIED A COMPLETION IS HISTORY
--
--  Revision 3 closed the rot by RECOMPUTING: an attachment UPDATE fired
--  the deferred guard, which re-checked whether the completion still
--  stood. That refuses the mutations which BREAK a live completion, and
--  it is not enough. Two things slip past a recompute:
--
--    · SWAP THE BYTES. Replace `content` and `sha256` together with
--      another qualifying photo. The predicate still says grounded — but
--      the 10:00 completion now rests on a photo taken at 14:00. Nothing
--      was invalidated; the evidence was REPLACED.
--    · MUTATE WHILE NOT TERMINAL. Reopen, rewrite the evidence, complete
--      again. Every intermediate state is legal.
--
--  So the doctrine is stronger than "the completion must still compute":
--
--      PROOF USED TO JUSTIFY A COMPLETION BECOMES HISTORICAL EVIDENCE.
--      Correct it by adding new truth — a superseding evaluation, a
--      reopen — never by rewriting the evidence that justified the old
--      decision.
--
--  Truth is not protected merely because the decision was valid when it
--  was made. The evidence that justified it must remain intact, or the
--  decision's basis is whatever somebody last edited.
--
--  ── THE WHOLE ROW, NOT A COLUMN LIST ────────────────────────────────
--
--  An enumerated column list is what goes stale the day a column is added
--  — the same argument that kept a WHEN clause off the deferred trigger.
--  Once an attachment is CITED by any evaluation it is frozen entirely.
--
--  ── AND IT BREAKS NOTHING ───────────────────────────────────────────
--
--  Every shipped mutation of this table is the INGRESS pipeline
--  (technician/evidence_service.js: referenced → stored / fetch_failed),
--  which runs strictly BEFORE any evaluation can cite the row. Inventoried
--  and re-derived every run by tests/gate_evidence_immutability.js.
--
--  IMMEDIATE, not deferred: this is "you cannot rewrite this", a statement
--  refusal, and the error should name the row the caller just touched.
--  ════════════════════════════════════════════════════════════════════

create or replace function public.release_0_freeze_cited_evidence()
returns trigger as $q$
declare
  v_id uuid := coalesce(new.id, old.id);
  v_ev uuid;
begin
  select l.evaluation_id into v_ev
    from public.work_order_proof_evaluation_attachments l
   where l.attachment_id = v_id
   limit 1;

  if v_ev is null then
    return coalesce(new, old);    -- not yet evidence for anything
  end if;

  raise exception
    'proof attachment % is cited by evaluation % and may not be %d',
    v_id, v_ev, lower(tg_op)
    using errcode = 'R0005',
          detail  = 'Evidence that justified a proof evaluation is historical: the '
                 || 'evaluation was a judgement ABOUT THESE BYTES, with these storage '
                 || 'facts and this classification. Changing them now would silently give '
                 || 'a past decision a different evidentiary basis.',
          hint    = 'Add new truth instead: preserve a NEW attachment and record a '
                 || 'superseding evaluation, reopening the work order in the same '
                 || 'transaction if it is terminal. Nothing here prevents recording that '
                 || 'a completion was wrong — only rewriting why it was right.';
end;
$q$ language plpgsql;
alter function public.release_0_freeze_cited_evidence() set search_path = public, pg_temp;

drop trigger if exists freeze_cited_evidence_upd on public.work_order_proof_attachments;
drop trigger if exists freeze_cited_evidence_del on public.work_order_proof_attachments;

create trigger freeze_cited_evidence_upd
  before update on public.work_order_proof_attachments
  for each row
  execute function public.release_0_freeze_cited_evidence();

--  DELETE is already refused by fk_wopea_attach_scope ON DELETE RESTRICT.
--  This fires FIRST and says why in the product's own words rather than
--  surfacing as a foreign-key violation an operator has to decode.
create trigger freeze_cited_evidence_del
  before delete on public.work_order_proof_attachments
  for each row
  execute function public.release_0_freeze_cited_evidence();

--  ════════════════════════════════════════════════════════════════════
--  THE AUDIT, FROM THE SAME DEFINITION
--
--  "Show me every post-cutover work order whose committed terminal state
--  violates the completion invariant." The release instrumentation and
--  the proof harnesses read THIS — not a fourth handwritten
--  interpretation that agrees today and drifts next month.
--
--  Empty is the expected answer. A row means the guard was dropped,
--  deployed late, or bypassed by privileged DDL.
--  ════════════════════════════════════════════════════════════════════
create or replace view public.release_0_completion_invariant_violations as
select w.id          as work_order_id,
       w.property_id,
       w.status,
       public.release_0_completion_proof_status(w.id, w.property_id) as proof_status,
       case
         when w.status = 'closed' then 'closed_after_cutover'
         when public.release_0_completion_proof_status(w.id, w.property_id) = 'none'
           then 'terminal_without_evaluation'
         when public.release_0_completion_proof_status(w.id, w.property_id) = 'not_satisfied'
           then 'terminal_on_failed_evaluation'
         else 'terminal_on_ungrounded_evaluation'
       end          as violation
  from public.work_orders w
 where exists (select 1 from public.release_0_activation_epoch e
                where e.activation_id is not null)
   and w.status in ('complete', 'closed')
   and not exists (
         select 1 from public.release_0_legacy_cutover_inventory i
          where i.work_order_id = w.id and i.property_id = w.property_id
            and i.status_at_cutover = w.status)
   and not (w.status = 'complete'
            and public.release_0_completion_proof_status(w.id, w.property_id) = 'grounded');

comment on view public.release_0_completion_invariant_violations is
  'Release 0: every post-cutover work order whose COMMITTED terminal state violates the '
  'completion invariant, derived from release_0_completion_proof_status — the same '
  'function the deferred guard and the activation use. Expected to be empty.';

comment on function public.release_0_assert_completion_truth(uuid) is
  'Release 0: at COMMIT, a work order may be terminal only with a current `satisfied` '
  'evaluation, or as inventoried pre-cutover legacy with no evaluation at all; and '
  'inventoried legacy may not leave the terminal state. Inert before activation. '
  'Enforced from work_orders (insert/update) and work_order_proof_evaluations (insert).';
