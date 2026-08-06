-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 137 CANDIDATE — release 0 proof evaluations
--
--  ⚠ THIS IS NOT A MIGRATION. It deliberately does not live under
--    migrations/ and migrate.js cannot see it.
--
--  It is the EXACT DDL intended for eventual production migration 137,
--  derived from docs/RELEASE_0_IMPLEMENTATION_PLAN.md §2.1–§2.5. It is a
--  candidate so the scale proof measures THE SCHEMA WE INTEND TO SHIP
--  rather than an easier schema that resembles it.
--
--  ── PROMOTION RULE ──────────────────────────────────────────────────
--  Once the SMS ingress gate closes, production migration 137 must be
--  created FROM THESE EXACT BYTES. Comments and the filename wrapper may
--  differ during promotion. DDL, functions, indexes, constraints,
--  triggers, views and transaction boundaries MAY NOT. Any substantive
--  difference invalidates the scale proof and requires rerunning it.
--
--  Its sha256 is recorded before every measured run.
--
--  ── ISOLATION ───────────────────────────────────────────────────────
--  The guard below refuses before ANY DDL unless all five identity
--  conditions hold. It is keyed to database identity and a sentinel row,
--  NOT to a port or a path — those are operational details that a copied
--  file or a forwarded connection would carry along unchanged.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ════════════════════════════════════════════════════════════════════
--  0. THE ISOLATION GUARD — refuses before any DDL
-- ════════════════════════════════════════════════════════════════════
do $guard$
declare
  n int;
  p text;
  ceil text;
begin
  --  1. database identity
  if current_database() <> 'r0scale' then
    raise exception 'REFUSED: this candidate runs only against the isolated scale database, not %',
      current_database();
  end if;

  --  2. the sentinel table exists
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'release_0_scale_harness_guard';
  if n <> 1 then
    raise exception 'REFUSED: harness sentinel table is absent — this is not the scale harness';
  end if;

  --  3. the sentinel carries the EXACT expected purpose
  select purpose into p from public.release_0_scale_harness_guard where id = true;
  if p is distinct from 'ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION' then
    raise exception 'REFUSED: harness sentinel purpose does not match; got %', coalesce(p, '<null>');
  end if;

  --  4. the ledger is exactly at the production ceiling
  select coalesce(max(version), '000') into ceil from public.schema_migrations;
  if ceil <> '136' then
    raise exception 'REFUSED: ledger ceiling is %, expected exactly 136', ceil;
  end if;

  --  5. 137 is absent — this candidate is not re-runnable over itself
  select count(*) into n from public.schema_migrations where version = '137';
  if n <> 0 then
    raise exception 'REFUSED: migration 137 is already recorded in the ledger';
  end if;
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'work_order_proof_evaluations';
  if n <> 0 then
    raise exception 'REFUSED: work_order_proof_evaluations already exists';
  end if;

  raise notice 'isolation guard passed: db=% ledger=%', current_database(), ceil;
end
$guard$;

-- ════════════════════════════════════════════════════════════════════
--  1. THE ADDITIVE UNIQUE CONSTRAINT the link table needs (§2.2)
--
--  work_order_proof_attachments must be referenceable by
--  (id, work_order_id, property_id) so a cross-scope link is
--  unrepresentable rather than merely discouraged.
-- ════════════════════════════════════════════════════════════════════
alter table public.work_order_proof_attachments
  add constraint uq_wopa_id_scope unique (id, work_order_id, property_id);

-- ════════════════════════════════════════════════════════════════════
--  2. PROOF EVALUATIONS — append-only, scoped, single linear chain (§2.1)
--
--  `state` carries ONLY the two computed values. legacy_indeterminate and
--  missing_evaluation_defect are DERIVED at read time (§3.2). Storing them
--  would make a derived fact writable and the cutover inventory would stop
--  being the authority.
-- ════════════════════════════════════════════════════════════════════
create table public.work_order_proof_evaluations (
  id                     uuid primary key default gen_random_uuid(),
  work_order_id          uuid not null,
  property_id            uuid not null,
  state                  text not null check (state in ('satisfied','not_satisfied')),
  evaluated_at           timestamptz not null default now(),
  evaluated_by_user_id   uuid references public.users(id),
  evaluated_by_service   text not null,
  rule_version           text not null,
  supersedes_id          uuid,
  created_at             timestamptz not null default now(),

  constraint uq_wope_id_scope unique (id, work_order_id, property_id),

  constraint fk_wope_work_scope
    foreign key (work_order_id, property_id)
    references public.work_orders (id, property_id) on delete restrict,

  --  COMPOSITE SELF-FK: a chain may never cross work orders or properties.
  constraint fk_wope_supersedes_scope
    foreign key (supersedes_id, work_order_id, property_id)
    references public.work_order_proof_evaluations (id, work_order_id, property_id)
    on delete restrict
);

--  Three indexes carry the chain discipline. NONE of them is advisory, and
--  all stay NON-DEFERRABLE — a deferred race check that fires at commit is
--  not a race check (§2.1.2).

-- ONE GENESIS per work order/property.
create unique index uq_wope_genesis
  on public.work_order_proof_evaluations (work_order_id, property_id)
  where supersedes_id is null;

-- AT MOST ONE SUCCESSOR per evaluation. No forks.
--  "must supersede the current head" falls out of this rather than needing
--  its own rule: any row that is not the head already HAS a successor.
create unique index uq_wope_one_successor
  on public.work_order_proof_evaluations (supersedes_id)
  where supersedes_id is not null;

create index idx_wope_scope
  on public.work_order_proof_evaluations (work_order_id, property_id);

-- ════════════════════════════════════════════════════════════════════
--  3. THE CHAIN INSERT GUARD (§2.1.1)
--
--  The indexes prove AT MOST one genesis, AT MOST one successor, and no
--  cross-scope link. They do NOT prove every component is a rooted acyclic
--  chain with exactly one head. Four states survive them:
--
--    a  a row supersedes itself      A.supersedes_id = A.id
--    b  a two-cycle                  A → B and B → A
--    c  a component with NO genesis   every cycle has none
--    d  a component with NO head      every cycle has none
--
--  uq_wope_genesis permits AT MOST one genesis — zero is also permitted, so
--  a pure cycle satisfies it. In a two-cycle each row is superseded exactly
--  once, so uq_wope_one_successor is satisfied. The composite self-FK is
--  satisfied because both rows share a scope. Self-supersession survives
--  because a self-referencing FK is checked once the row has landed.
--
--  The trigger and the indexes do DIFFERENT JOBS:
--    trigger    proves valid rooted, acyclic insertion
--    indexes    prevent concurrent genesis and successor races
-- ════════════════════════════════════════════════════════════════════
create or replace function public.wope_chain_guard() returns trigger as $$
declare
  pred  public.work_order_proof_evaluations%rowtype;
  walk  uuid;
  hops  int := 0;
begin
  -- 1. NO SELF-SUPERSESSION
  if NEW.supersedes_id is not null and NEW.supersedes_id = NEW.id then
    raise exception 'evaluation % may not supersede itself', NEW.id;
  end if;

  -- 2. GENESIS — permitted only when the scope is empty
  if NEW.supersedes_id is null then
    perform 1 from public.work_order_proof_evaluations
      where work_order_id = NEW.work_order_id
        and property_id   = NEW.property_id
      limit 1;
    if found then
      raise exception 'genesis refused: evaluations already exist for (%, %)',
        NEW.work_order_id, NEW.property_id;
    end if;
    return NEW;
  end if;

  -- 3. SUPERSEDING INSERTION
  --    LOCK the predecessor FIRST, so two concurrent successors serialize
  --    here rather than racing to the unique index.
  select * into pred
    from public.work_order_proof_evaluations
   where id = NEW.supersedes_id
     for update;

  if not found then
    raise exception 'predecessor % does not exist', NEW.supersedes_id;
  end if;

  if pred.work_order_id <> NEW.work_order_id
     or pred.property_id <> NEW.property_id then
    raise exception 'cross-scope supersession refused';
  end if;

  perform 1 from public.work_order_proof_evaluations
    where supersedes_id = pred.id limit 1;
  if found then
    raise exception 'predecessor % is not the head', pred.id;
  end if;

  -- 4. CYCLE REJECTION — walk back from the predecessor to a genesis.
  --    The walk must terminate at supersedes_id IS NULL and must never
  --    encounter NEW.id. This is CORRUPTION DETECTION, not insertion
  --    logic: it is the only check that would notice an already-corrupt
  --    chain rather than extending it.
  walk := pred.id;
  loop
    if walk = NEW.id then
      raise exception 'cycle refused: % is its own ancestor', NEW.id;
    end if;
    select supersedes_id into walk
      from public.work_order_proof_evaluations where id = walk;
    exit when walk is null;
    hops := hops + 1;
    if hops > 10000 then
      raise exception 'chain walk exceeded bound — chain is corrupt';
    end if;
  end loop;

  return NEW;
end $$ language plpgsql;

--  SCHEMA-QUALIFIED body plus a controlled search_path: PostgreSQL resolves
--  unqualified names through search_path, so an unqualified trigger body can
--  be pointed at a different table by whoever controls that setting (§2.1.2).
alter function public.wope_chain_guard() set search_path = public, pg_temp;

create trigger chain_guard_wope
  before insert on public.work_order_proof_evaluations
  for each row execute function public.wope_chain_guard();

-- ════════════════════════════════════════════════════════════════════
--  4. IMMUTABILITY (§2.1, §2.5)
--
--  A trigger rather than a REVOKE, because REVOKE does not bind the owner
--  role and the production audit established the application connects as
--  neondb_owner.
--
--  CAVEAT THAT MUST NOT BE OVERSTATED: a table owner can disable or drop
--  its own triggers. "Immutable" here means ENFORCED AGAINST NORMAL DML,
--  not unalterable by the runtime role. Separating migration, runtime and
--  audit roles is a later slice, explicitly out of Release 0 scope.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.forbid_mutation() returns trigger as $$
begin
  raise exception '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
end $$ language plpgsql;

alter function public.forbid_mutation() set search_path = public, pg_temp;

create trigger no_update_wope before update on public.work_order_proof_evaluations
  for each row execute function public.forbid_mutation();
create trigger no_delete_wope before delete on public.work_order_proof_evaluations
  for each row execute function public.forbid_mutation();

-- ════════════════════════════════════════════════════════════════════
--  5. THE HEAD VIEW (§2.1.3)
--
--  The head is THE ONE UNSUPERSEDED ROW, not the highest sequence number.
--  Revision 2 read "highest evaluation_seq", which is only equivalent to
--  the head if the chain is guaranteed linear — and it was not. The
--  sequence column is dropped; ordering is no longer load-bearing.
-- ════════════════════════════════════════════════════════════════════
create view public.work_order_proof_evaluation_head as
  select e.* from public.work_order_proof_evaluations e
   where not exists (
     select 1 from public.work_order_proof_evaluations s
      where s.supersedes_id = e.id);

-- ════════════════════════════════════════════════════════════════════
--  6. EVALUATION → ATTACHMENT LINKS — fully scoped (§2.2)
--
--  A cross-work-order or cross-property link is UNREPRESENTABLE, not
--  merely refused.
-- ════════════════════════════════════════════════════════════════════
create table public.work_order_proof_evaluation_attachments (
  evaluation_id   uuid not null,
  attachment_id   uuid not null,
  work_order_id   uuid not null,
  property_id     uuid not null,
  created_at      timestamptz not null default now(),
  primary key (evaluation_id, attachment_id),

  constraint fk_wopea_eval_scope
    foreign key (evaluation_id, work_order_id, property_id)
    references public.work_order_proof_evaluations (id, work_order_id, property_id)
    on delete restrict,

  constraint fk_wopea_attach_scope
    foreign key (attachment_id, work_order_id, property_id)
    references public.work_order_proof_attachments (id, work_order_id, property_id)
    on delete restrict
);

create trigger no_update_wopea before update on public.work_order_proof_evaluation_attachments
  for each row execute function public.forbid_mutation();
create trigger no_delete_wopea before delete on public.work_order_proof_evaluation_attachments
  for each row execute function public.forbid_mutation();

-- ════════════════════════════════════════════════════════════════════
--  7. ACTIVATION HISTORY — one genesis, no forks, head-only correction (§2.3)
--
--  activated_at is the CAPTURED instant (§6.1), never now().
-- ════════════════════════════════════════════════════════════════════
create table public.release_0_activation_history (
  id                 uuid primary key default gen_random_uuid(),
  activated_at       timestamptz not null,
  captured_at_step   text not null,
  captured_by        text not null,
  supersedes_id      uuid references public.release_0_activation_history(id),
  reason             text,
  recorded_at        timestamptz not null default now(),

  constraint ck_r0ah_supersede_has_reason
    check (supersedes_id is null or reason is not null)
);

-- ONE genesis activation, ever.
create unique index uq_r0ah_genesis
  on public.release_0_activation_history ((true))
  where supersedes_id is null;

-- AT MOST ONE successor. No forks. A correction must supersede the head.
create unique index uq_r0ah_one_successor
  on public.release_0_activation_history (supersedes_id)
  where supersedes_id is not null;

create view public.release_0_activation_current as
  select a.* from public.release_0_activation_history a
   where not exists (
     select 1 from public.release_0_activation_history s
      where s.supersedes_id = a.id);

-- ── the same four holes, closed the same way (§2.3.1) ────────────────
create or replace function public.r0ah_chain_guard() returns trigger as $$
declare
  head  public.release_0_activation_history%rowtype;
  walk  uuid;
  hops  int := 0;
begin
  -- 1. NO SELF-SUPERSESSION
  if NEW.supersedes_id is not null and NEW.supersedes_id = NEW.id then
    raise exception 'activation % may not supersede itself', NEW.id;
  end if;

  -- 2. GENESIS — permitted only when activation history is EMPTY
  if NEW.supersedes_id is null then
    perform 1 from public.release_0_activation_history limit 1;
    if found then
      raise exception 'genesis refused: activation history is not empty';
    end if;
    return NEW;
  end if;

  -- 5. A CORRECTION REQUIRES A NON-EMPTY REASON
  --    (the CHECK constraint forbids NULL; this forbids whitespace too)
  if NEW.reason is null or btrim(NEW.reason) = '' then
    raise exception 'a superseding activation requires a non-empty reason';
  end if;

  -- 3 + 4. IT MUST CITE THE CURRENTLY VISIBLE HEAD, AND THE HEAD IS LOCKED
  select * into head
    from public.release_0_activation_history
   where id = NEW.supersedes_id
     for update;

  if not found then
    raise exception 'cited activation % does not exist', NEW.supersedes_id;
  end if;

  perform 1 from public.release_0_activation_history
    where supersedes_id = head.id limit 1;
  if found then
    raise exception 'activation % is not the current head', head.id;
  end if;

  -- 6. CYCLE REJECTION
  walk := head.id;
  loop
    if walk = NEW.id then
      raise exception 'cycle refused: % is its own ancestor', NEW.id;
    end if;
    select supersedes_id into walk
      from public.release_0_activation_history where id = walk;
    exit when walk is null;
    hops := hops + 1;
    if hops > 10000 then
      raise exception 'chain walk exceeded bound — chain is corrupt';
    end if;
  end loop;

  return NEW;
end $$ language plpgsql;

alter function public.r0ah_chain_guard() set search_path = public, pg_temp;

create trigger chain_guard_r0ah
  before insert on public.release_0_activation_history
  for each row execute function public.r0ah_chain_guard();

create trigger no_update_r0ah before update on public.release_0_activation_history
  for each row execute function public.forbid_mutation();
create trigger no_delete_r0ah before delete on public.release_0_activation_history
  for each row execute function public.forbid_mutation();

-- ════════════════════════════════════════════════════════════════════
--  8. LEGACY CUTOVER INVENTORY — immutable (§2.4)
--
--  Populated ONCE, in the activation transaction, FROM THE LIVE TABLE —
--  never from a hand-written list and never from a stored receipt.
--
--  had_column_photo / had_column_note record PRESENCE ONLY. The app's only
--  writer of that column emits a stub:// string with no bytes, so presence
--  is all the column can honestly support.
-- ════════════════════════════════════════════════════════════════════
create table public.release_0_legacy_cutover_inventory (
  work_order_id      uuid not null,
  property_id        uuid not null,
  status_at_cutover  text not null check (status_at_cutover in ('complete','closed')),
  had_column_photo   boolean not null,
  had_column_note    boolean not null,
  activation_id      uuid not null references public.release_0_activation_history(id),
  captured_at        timestamptz not null default now(),
  primary key (work_order_id, property_id),

  constraint fk_r0lci_work_scope
    foreign key (work_order_id, property_id)
    references public.work_orders (id, property_id) on delete restrict
);

create trigger no_update_r0lci before update on public.release_0_legacy_cutover_inventory
  for each row execute function public.forbid_mutation();
create trigger no_delete_r0lci before delete on public.release_0_legacy_cutover_inventory
  for each row execute function public.forbid_mutation();

commit;
