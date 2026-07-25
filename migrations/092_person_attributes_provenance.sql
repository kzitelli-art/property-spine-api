-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 092 — person_attributes: PROVENANCE + CORRECTION LINEAGE
--
--  Additive. Ten nullable columns, thirteen NULL-admitting CHECKs, three
--  indexes, one labelled backfill. No rename, no drop, no type change,
--  no NOT NULL, no widened vocabulary.
--
--  WHY: person_attributes (061) is the person × property fact store the
--  Person Card reads. The Person Card History band ALREADY EMITS the full
--  §6 entry shape — occurred_at, recorded_at, source, verb, actor{id,name,
--  kind}, claim_strength, supersedes — but SYNTHESIZES all of it at read
--  time from row order and hardcodes claim_strength:'proven'. The contract
--  exists at the read layer and is unbacked at the storage layer. This
--  file adds the storage.
--
--  OWNER DECISION 2026-07-25 — THE READ IS NOT CHANGED IN THIS SLICE.
--  The design proposed replacing the hardcoded 'proven' on the Person Card
--  with the stored value, which would blank the 85 pre-092 rows. Kameron
--  declined: a stated budget is a working number, most prospects never
--  become revenue, and a visible blank is worse than a soft word. So the
--  card keeps rendering 'proven' exactly as it does today and NOTHING
--  VISIBLE CHANGES. The column is still populated going forward, because
--  this field will later carry facts where the distinction is not cosmetic
--  — an assistance animal, an income figure off an application.
--  ACTIVATION CONDITION for the read change: when a fact key is added
--  whose truth carries consequence (ESA status, income, or any application
--  -sourced value), the Person Card read switches to the stored value in
--  the SAME slice that adds the key. Class 1 storage, deliberately ahead
--  of its reader, with a named trigger — not built-but-dormant drift.
--
--  SAFETY CONTRACT — there is no staging; merging this EXECUTES it:
--    · every new column is NULLABLE with NO default (catalog-only ADD)
--    · every new CHECK admits NULL   (`col is null or ...`)
--    · no existing column, constraint, or index is altered or dropped
--    · the only data change is occurred_at/occurred_at_basis, which no
--      reader in the repo selects today
--  Therefore OLD CODE against NEW SCHEMA — the rolling-restart window,
--  and the permanent state after any code-only rollback — is safe.
--
--  KNOWN CONSUMERS THAT MUST STAY GREEN (exhaustive grep, 5 files):
--    src/comms/prospect_capture.js         (select / update / insert)
--    src/leasing/leasingleads.js           (intake + tour capture)
--    src/identity/operator.js              (vitals, presence, history)
--    src/shared/relationship_stage.js      (presence)
--    tests/fact_write_resilience_proof.js  (asserts uq_person_attr_active
--                                           exists and raises 23505)
--  That LAST one is why `status` and uq_person_attr_active survive this
--  file untouched.
--
--  DELIBERATELY NOT IN THIS FILE (each a decision, not an omission):
--    · attr_key's six-value CHECK is untouched. Widening it is a PRODUCT
--      change: a new key renders straight onto the live History band with
--      a machine-generated sentence and is silently dropped by vitals.
--    · `status` + uq_person_attr_active untouched. Class 2, see below.
--    · property_id stays NULLABLE. OWNER DECISION 2026-07-25: keep the
--      door open so a portfolio-wide fact (employer, relocation origin)
--      can exist without being stored once per building. Nothing is built
--      for it in this slice; the door simply is not closed.
--    · parent FKs stay ON DELETE CASCADE. OWNER DECISION 2026-07-25:
--      revisit when person deletion moves behind a deliberate "erase this
--      person" act with dormancy as the default. Restricting today would
--      500 the demo reset the first time a seeded person has a fact.
--    · no value normalization (no value_numeric). OWNER DECISION: collect
--      and organize first; filtering by "budget over $2,000" is its own
--      slice and needs an interpretation service that does not exist.
--    · no recorded_at column — created_at IS the recorded time.
--    · no NOT NULL and no NOT VALID provenance CHECK. Those land LATER,
--      after the writers are proven populating live.
--
--  NO begin/commit in this file. migrate.js wraps it in ONE transaction
--  together with the schema_migrations ledger insert. A self-issued commit
--  would end that transaction early and de-atomize the ledger receipt.
-- ════════════════════════════════════════════════════════════════════


-- ── 0. PREFLIGHT — dependency is fatal, ledger position is not ───────
do $$
declare head text; kind char;
begin
  if to_regclass('public.person_attributes') is null then
    raise exception '092 preflight: person_attributes does not exist — migration 061 has not been applied. Aborting.';
  end if;

  select c.relkind into kind from pg_class c where c.oid = to_regclass('public.person_attributes');
  if kind <> 'r' then
    raise exception '092 preflight: person_attributes is not an ordinary table (relkind=%). Aborting.', kind;
  end if;

  select version into head from schema_migrations order by version desc limit 1;
  if head is distinct from '091' then
    raise notice '092: expected ledger head 091, found %. This file is additive and order-independent; continuing.', head;
  end if;
end $$;


-- ── 1. THE COLUMNS ──────────────────────────────────────────────────
-- ADD COLUMN with no default is catalog-only in PG 11+ — no table
-- rewrite. IF NOT EXISTS makes each subcommand independently re-runnable.
--
-- NEITHER FK CARRIES AN ON DELETE CLAUSE, AND THAT IS LOAD-BEARING.
-- Omitting it means NO ACTION, whose referential check is deferred to the
-- END of the statement. ON DELETE RESTRICT is checked immediately, per
-- row, and cannot be deferred. When the persons cascade deletes a
-- superseded row and its successor in ONE statement, NO ACTION passes and
-- RESTRICT would raise 23503 — which would 500 the demo reset endpoint.
alter table person_attributes
  add column if not exists occurred_at        timestamptz,
  add column if not exists occurred_at_basis  text,
  add column if not exists actor_type         text,
  add column if not exists actor_user_id      uuid references users(id),
  add column if not exists claim_strength     text,
  add column if not exists verb               text,
  add column if not exists source_record_type text,
  add column if not exists supersedes_id      uuid references person_attributes(id),
  add column if not exists correction_reason  text,
  add column if not exists idempotency_key    text;


-- ── 2. §6 · OCCURRED TIME, AND WHETHER IT IS REAL ───────────────────
-- created_at (061) is the RECORDED time and stays authoritative for it.
-- No recorded_at column is added — two columns for one fact is drift.
--
-- occurred_at is when the person actually made the claim: the inbound
-- message's occurred_at, the lead's received_at. NO DEFAULT, deliberately
-- — a `default now()` would re-record write time as observation time,
-- the exact conflation this column exists to end.
--
-- occurred_at_basis says which it is:
--   source_record   taken from the source record's own business time
--   recorded_proxy  we used write time because no business time exists
alter table person_attributes
  drop constraint if exists pa_occurred_basis_vocab;
alter table person_attributes
  add constraint pa_occurred_basis_vocab
  check (occurred_at_basis is null
         or occurred_at_basis in ('source_record','recorded_proxy'));

alter table person_attributes
  drop constraint if exists pa_occurred_has_basis;
alter table person_attributes
  add constraint pa_occurred_has_basis
  check (occurred_at is null or occurred_at_basis is not null);

-- A fact cannot be recorded before it happened. Five minutes is
-- clock-skew tolerance, not permission to backdate.
--
-- WRITTEN AS SUBTRACTION ON PURPOSE. `created_at + interval '5 minutes'`
-- resolves to timestamptz_pl_interval, which Postgres marks STABLE, and
-- CHECK constraints reject non-IMMUTABLE functions — that form fails at
-- apply time, which on Render means prestart exits 1 and the instance
-- never boots. `occurred_at - created_at` is timestamptz_mi, IMMUTABLE.
alter table person_attributes
  drop constraint if exists pa_occurred_not_after_recorded;
alter table person_attributes
  add constraint pa_occurred_not_after_recorded
  check (occurred_at is null
         or occurred_at - created_at <= interval '5 minutes');


-- ── 3. §6 · RECORDING ACTOR ─────────────────────────────────────────
-- WHO WROTE THE ROW — not who claimed the fact. Every row this table can
-- currently receive is a claim about person_id made BY person_id, so the
-- claimant needs no column. If staff ever record an observation the
-- person did not claim, this model cannot express it — a NAMED gap.
--
--   operator      staff session; actor_user_id populated
--   agent         AI extraction from the conversation
--   prospect      the person's own form submission (public door, no user)
--   system        machine-originated (import, backfill)
--   unattributed  a human recorded it and the write path did not carry
--                 WHICH human. OWNER DECISION 2026-07-25: record this
--                 rather than leaving blank — a blank is indistinguishable
--                 from a pre-092 row, whereas 'unattributed' is a number
--                 you can watch. If it stays high, tours are being closed
--                 through the operator-key door instead of a staff session.
--
-- `source` (061) KEEPS ITS MEANING — WHERE the claim came from, the
-- capture channel. actor_type is authoritative for WHO recorded it.
alter table person_attributes
  drop constraint if exists pa_actor_type_vocab;
alter table person_attributes
  add constraint pa_actor_type_vocab
  check (actor_type is null
         or actor_type in ('operator','agent','system','prospect','unattributed'));

-- 'operator' means a NAMED staff member. No name → 'unattributed'.
alter table person_attributes
  drop constraint if exists pa_operator_actor_has_user;
alter table person_attributes
  add constraint pa_operator_actor_has_user
  check (actor_type is distinct from 'operator' or actor_user_id is not null);

-- ...and a users(id) actor is meaningless on any other actor kind.
alter table person_attributes
  drop constraint if exists pa_actor_user_only_for_operator;
alter table person_attributes
  add constraint pa_actor_user_only_for_operator
  check (actor_user_id is null or actor_type is not distinct from 'operator');


-- ── 4. §6 · CLAIM STRENGTH ──────────────────────────────────────────
--   asserted  an unverified self-report
--   proven    corroborated by a document or a verified system record
--
-- NULLABLE ON PURPOSE. A NOT NULL two-value CHECK would force a guess the
-- first time a source arrives that fits neither word. NULL is the honest
-- unknown. Pre-092 rows keep NULL: an unknown strength is never upgraded
-- to a word we did not record.
--
-- See the OWNER DECISION at the head of this file: the Person Card keeps
-- rendering 'proven' for now. This column is the storage that makes the
-- later, consequential distinction possible without a second migration.
alter table person_attributes
  drop constraint if exists pa_claim_strength_vocab;
alter table person_attributes
  add constraint pa_claim_strength_vocab
  check (claim_strength is null or claim_strength in ('asserted','proven'));


-- ── 5. §6 · VERB — the writer's INTENT, which row order cannot recover
--   captured   a new or changed truth
--   confirmed  the person restated the SAME value. Today this is thrown
--              away: all three writers skip an identical value, so a real
--              re-affirmation leaves no trace anywhere.
--   corrected  the prior row was WRONG — an error being fixed
--
-- 'captured' vs 'corrected' is the §6 correction distinction and it is
-- NOT derivable: ordering cannot tell "their budget went up" from "we
-- wrote the wrong number". The PRESENTATION verb stays derived. Nothing
-- derived is stored; the non-derivable half is. This is also the exact
-- marker identifying a service-written row: no legacy writer sets verb.
alter table person_attributes
  drop constraint if exists pa_verb_vocab;
alter table person_attributes
  add constraint pa_verb_vocab
  check (verb is null or verb in ('captured','confirmed','corrected'));


-- ── 6. §6 · SOURCE RECORD ID, TYPED ─────────────────────────────────
-- source_ref (061) is populated on 100% of live rows and is
-- uninterpretable: its type is only inferable from `source`, and that
-- inference is ALREADY WRONG IN PRODUCTION — the tour writer stores a
-- leasing_tours id under source='human', while 061 declares source_ref
-- means "comm_event id (AI) or lead id (form)".
--
-- THE TOUR TYPE IS 'leasing_tour', NOT 'scheduled_tour'. completeTour
-- Service reads `select * from leasing_tours where id=$1` and binds that
-- id into source_ref. scheduled_tours is a DIFFERENT table on the Acuity
-- import rail. Naming the wrong one would write a confidently wrong table
-- name into the very column added to fix a provenance bug.
--
-- 'unknown' means we hold a uuid we could not resolve. The receipt is
-- never discarded to make a type fit.
alter table person_attributes
  drop constraint if exists pa_source_record_type_vocab;
alter table person_attributes
  add constraint pa_source_record_type_vocab
  check (source_record_type is null
         or source_record_type in ('comm_event','leasing_lead','leasing_tour','unknown'));

-- A declared receipt table requires a receipt id. The INVERSE stays
-- legal: the 85 existing rows carry source_ref with no type.
alter table person_attributes
  drop constraint if exists pa_typed_source_has_ref;
alter table person_attributes
  add constraint pa_typed_source_has_ref
  check (source_record_type is null
         or source_record_type = 'unknown'
         or source_ref is not null);


-- ── 7. §6 · CORRECTION — the relationship between the two records ───
-- Direction matters. The pointer lives on the NEW row: it is set once, at
-- insert, and never requires a second UPDATE against a row whose
-- successor id was not yet known. It composes with the retire-then-insert
-- order all three call sites already use.
--
-- With the backward pointer, all six §6 correction elements exist:
--   prior record      the row supersedes_id points at (still present)
--   corrected record  this row
--   correction actor  this row's actor_type / actor_user_id
--   correction time   this row's created_at
--   the reason        this row's correction_reason
--   the relationship  supersedes_id
alter table person_attributes
  drop constraint if exists pa_correction_requires_reason;
alter table person_attributes
  add constraint pa_correction_requires_reason
  check (verb is distinct from 'corrected'
         or (correction_reason is not null and btrim(correction_reason) <> ''));

alter table person_attributes
  drop constraint if exists pa_correction_requires_prior;
alter table person_attributes
  add constraint pa_correction_requires_prior
  check (verb is distinct from 'corrected' or supersedes_id is not null);

alter table person_attributes
  drop constraint if exists pa_reason_only_on_correction;
alter table person_attributes
  add constraint pa_reason_only_on_correction
  check (correction_reason is null or verb is not distinct from 'corrected');

alter table person_attributes
  drop constraint if exists pa_no_self_supersede;
alter table person_attributes
  add constraint pa_no_self_supersede
  check (supersedes_id is null or supersedes_id <> id);


-- ── 8. INDEXES ──────────────────────────────────────────────────────
-- CREATE INDEX CONCURRENTLY is impossible here — migrate.js wraps the
-- file in a transaction. Plain CREATE INDEX takes a brief SHARE lock; at
-- 85 rows it is instant.

-- IDEMPOTENCY. prospect_capture is fire-and-forget from the agent loop and
-- is retried; a fact layer must not accrete a duplicate claim on a Twilio
-- redelivery. Key: '<verb>:<source_record_type>:<source_id>:<attr_key>'.
-- attr_key is IN the key because one source record legitimately yields
-- several facts. Partial: every existing row is NULL here.
--
-- THE SERVICE MUST NOT USE `on conflict ... do nothing` AGAINST THIS
-- INDEX. That turns a duplicate into a SILENT SUCCESS after the prior row
-- has already been retired, leaving the key with zero active rows. The
-- service pre-checks the key BEFORE retiring, and its INSERT carries no
-- conflict clause, so a genuine race raises 23505 and the caller's
-- savepoint rolls the retire back with it.
create unique index if not exists uq_person_attr_idem
  on person_attributes (person_id, idempotency_key)
  where idempotency_key is not null;

-- LINEAGE IS A CHAIN, NOT A FORK. One row may be superseded at most once.
create unique index if not exists uq_person_attr_supersedes
  on person_attributes (supersedes_id)
  where supersedes_id is not null;

-- THE PEOPLE INDEX'S INDEX. 061's only index is person-leading. The
-- People Index is property-leading: one row per person × property for ONE
-- property. Without this, `where property_id=$1 and status='active'`
-- seq-scans. Partial on status, so it retires WITH status.
create index if not exists idx_person_attr_property_active
  on person_attributes (property_id, person_id, attr_key)
  where status = 'active';


-- ── 9. THE ONE BACKFILL — labelled, not asserted ────────────────────
-- occurred_at := created_at, basis 'recorded_proxy', on every pre-092
-- row. NOT a claim that we observed anything at that moment — the basis
-- column says out loud that it is write time standing in for business
-- time.
--
-- WHY BACKFILL AT ALL, when actor and claim_strength are left NULL:
-- because the Person Card ALREADY renders occurred_at = created_at for
-- these rows. Writing it down changes nothing visible; it only makes the
-- existing approximation explicit and queryable. Actor and strength get
-- no such treatment — those were genuinely never recorded and inferring
-- them would be fabrication. source_record_type is likewise NOT
-- backfilled: probing which table a uuid lives in produces EVIDENCE, and
-- storing evidence in a provenance column records a derivation.
--
-- Idempotent: a re-run after a partial apply is a no-op.
update person_attributes
   set occurred_at       = created_at,
       occurred_at_basis = 'recorded_proxy'
 where occurred_at is null;


-- ── 10. POST-APPLY VERIFICATION — reports, never raises ─────────────
-- NOTICE only: nothing here may block a boot, because migrate.js rolls
-- back and exits 1 on any exception, and prestart failure means the
-- instance never serves.
do $$
declare
  n_rows int; n_cols int; n_occ int; n_actor int; n_disagree int;
begin
  select count(*) into n_rows from person_attributes;

  select count(*) into n_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'person_attributes'
     and column_name in ('occurred_at','occurred_at_basis','actor_type','actor_user_id',
                         'claim_strength','verb','source_record_type','supersedes_id',
                         'correction_reason','idempotency_key')
     and is_nullable  = 'YES'
     and column_default is null;

  select count(*) into n_occ   from person_attributes where occurred_at is not null;
  select count(*) into n_actor from person_attributes where actor_type  is not null;

  -- STATUS vs LINEAGE AGREEMENT — the Class 2 removal gate for `status`.
  -- Scoped to service-written rows (verb is not null); pre-092 rows have
  -- no lineage by construction and are correctly excluded.
  select count(*) into n_disagree
    from person_attributes pa
   where pa.verb is not null
     and (pa.status = 'active')
         <> (not exists (select 1 from person_attributes s where s.supersedes_id = pa.id));

  raise notice '092 verification -----------------------------------';
  raise notice '  rows in person_attributes                    : %', n_rows;
  raise notice '  new columns nullable, no default (want 10)   : %', n_cols;
  raise notice '  occurred_at populated (proxy backfill)       : %', n_occ;
  raise notice '  actor_type populated (0 until writer cutover): %', n_actor;
  raise notice '  status vs lineage disagreements (want 0)     : %', n_disagree;

  if n_cols <> 10 then
    raise notice '  !! expected 10 nullable no-default columns, found % - inspect before cutting the writers over.', n_cols;
  end if;
  if n_occ <> n_rows then
    raise notice '  !! occurred_at backfill covered % of % rows - inspect.', n_occ, n_rows;
  end if;
end $$;

-- The schema_migrations row is inserted by migrate.js, NOT here.
