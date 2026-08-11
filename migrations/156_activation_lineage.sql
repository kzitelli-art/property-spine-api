-- ════════════════════════════════════════════════════════════════════
--  156 — THE CHAIN, MADE OF FOREIGN KEYS
--
--  The chain we want traceable:
--
--    exact uploaded file → exact source row → exact proposal
--      → exact decision → exact canonical object
--
--  Today it is broken in the middle. `proposed_records.evidence_refs` is
--  `[{source: "<a free-text label>", row: 3}]` — a DESCRIPTION of where a
--  proposal came from, written by the same code that made the proposal.
--  It cannot be joined, cannot be verified, and cannot survive the label
--  being edited.
--
--  ── WHAT THIS DOES NOT DO ───────────────────────────────────────────
--  It does NOT merge `import_source_rows` and `proposed_records`. They
--  answer different questions and both answers are wanted:
--
--    import_source_rows   what the source actually contained.   EVIDENCE
--    proposed_records     what Spine made of it, and what a
--                         human did about that.                 DECISION
--
--  Evidence is what arrived. A decision is what we did. Collapsing them
--  produces a table where correcting an interpretation edits the record of
--  what the document said — which is the one thing evidence exists to
--  prevent. They are LINKED, one row to one row, and stay separate.
--
--  ── AND THE TWO ENDS ────────────────────────────────────────────────
--  The batch gets the artifact it came from (replacing a filename string
--  with the file). The canonical objects already carry `import_batch_id`
--  from migration 046 — nothing new is needed at that end, which is the
--  whole reason this slice fits.
--
--  CLASSIFICATION: Class 1. Additive; every new column is nullable
--  because history predates all of it.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. batch → the file it came from ─────────────────────────────────
alter table import_batches
  add column if not exists source_artifact_id uuid references source_artifacts(id);

comment on column import_batches.source_artifact_id is
  'The retained file this batch was read from. Nullable: batches predating '
  'migration 153 have only source_file, which is a filename and not a file.';

create index if not exists ix_import_batches_artifact
  on import_batches (source_artifact_id);

-- ── 2. proposal → the exact evidence row it interprets ───────────────
alter table proposed_records
  add column if not exists import_source_row_id uuid references import_source_rows(id);

comment on column proposed_records.import_source_row_id is
  'The one evidence row this proposal is an interpretation of. Nullable: '
  'proposals staged before migration 156 have only evidence_refs prose.';

create index if not exists ix_proposed_source_row
  on proposed_records (import_source_row_id);

--  ONE INTERPRETATION PER EVIDENCE ROW, PER KIND OF THING.
--  A source row may one day yield a lease proposal AND a charge proposal —
--  different target_types, both legitimate. What it may never yield is two
--  competing lease proposals, because then "what did we decide about this
--  row" has two answers and the chain forks.
create unique index if not exists uq_proposed_one_per_source_row
  on proposed_records (import_source_row_id, target_type)
  where import_source_row_id is not null;

-- ── 3. the activation itself ─────────────────────────────────────────
--  `activations.deal_id` has existed since migration 040 as a bare uuid
--  with no foreign key and no writer — the column anticipated a deal and
--  then nothing ever put one in it. It gets its FK now.
do $$ begin
  alter table activations
    add constraint fk_activations_deal
    foreign key (deal_id) references deal_intakes(id);
exception when duplicate_object then null; end $$;

alter table activations
  add column if not exists source_artifact_id uuid references source_artifacts(id);

alter table activations
  add column if not exists import_batch_id uuid references import_batches(id);

alter table activations
  add column if not exists source_as_of_date date;

--  WHO OPENED IT. Server-derived; there is no body-supplied actor.
alter table activations
  add column if not exists opened_by_user_id uuid references users(id);

alter table activations
  add column if not exists authority_basis text;

-- ── 4. property is required, going forward ───────────────────────────
--  An activation with no property staged rows happily and then failed at
--  confirmation with "proposed record has no property_id — cannot tie."
--  Fail-late: the human has already done the work by the time it refuses.
--
--  The column is NOT made `not null`, because rows predating this
--  migration may legitimately have none and rewriting history to satisfy a
--  constraint is how a backfill becomes a lie. Instead the rule binds
--  only NEW rows, which is exactly where it belongs.
create or replace function public.activations_require_property()
returns trigger as $$
begin
  if new.property_id is null then
    raise exception 'an activation must name the property it is establishing'
      using errcode = 'not_null_violation',
            detail  = 'Without a property, rows can be staged but never confirmed — the '
                   || 'refusal arrives after the human has done all of the work.',
            hint    = 'Open the activation from the property inside the deal.';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.activations_require_property() set search_path = public, pg_temp;

drop trigger if exists trg_activations_require_property on activations;
create trigger trg_activations_require_property
  before insert on activations
  for each row execute function public.activations_require_property();

-- ── 5. decision vocabulary, stated as a constraint ───────────────────
--  `proposed_records.status` has carried its seven states in a comment
--  since migration 040. A comment is not a guard: any string at all is
--  currently storable, and a typo'd status silently disappears from every
--  count the review screen shows.
do $$ begin
  alter table proposed_records add constraint ck_proposed_status check
    (status in ('staged','needs_review','blocked','confirmed',
                'promoted','rejected','conflicted'));
exception when duplicate_object then null; end $$;
