-- ════════════════════════════════════════════════════════════════════
--  175_person_ingress_resolution_kind.sql
--
--  ONE NULLABLE COLUMN, and it exists to record an INSTITUTIONAL FACT:
--  when a human confirmed this proposal, did Spine CREATE a human from
--  this source evidence, or RECOGNISE the evidence as belonging to a
--  Person it already knew?
--
--  ── WHY THIS IS A COLUMN AND NOT A JSON KEY ─────────────────────────
--  The first design put a `resolution_intent` in payload_json. Two things
--  are wrong with that and both matter five years from now:
--
--    1. IT WOULD LET THE PROPOSAL DECIDE ITS OWN CONFIRMATION.
--       A proposal is a CLAIM. Storing 'create' or 'resolve' on it at
--       proposal time collapses proposal into confirmation, which is the
--       one boundary this whole seam exists to hold. 040's own header:
--       "a proposed record is NOT a unit/lease/tenant yet. It is a
--       structured claim... waiting for a human signature."
--
--    2. MUTABLE JSON IS TOO WEAK FOR AN INSTITUTIONAL FACT. Whether Spine
--       created this human or recognised them is not parsing metadata. It
--       is what the human/system actually decided happened, and it must be
--       answerable long after the payload has been rewritten by a
--       re-proposal.
--
--  So: NULL until confirmation. Written inside the SAME atomic transaction
--  that sets promoted_record_id, by the canonical ingress service, which
--  derives and VALIDATES the action rather than trusting anything stored.
--
--      source proposes  →  Spine/human resolves  →  durable truth
--
--  ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────
--  No candidate_person_id column. A candidate is EVIDENCE and belongs in
--  payload_json / normalized_json with the rest of it. There may be zero,
--  one or several candidates later, and a single column would quietly cap
--  that at one. The count of candidates today is not a schema decision.
--
--  No external-identifier table, no yardi_id, no merge machinery. The
--  Yardi resident id stays what the evidence study proved it is: a durable
--  identifier for a SOURCE RECORD, carried as provenance, never Spine's
--  key for a human.
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive; every existing
--  row keeps resolution_kind NULL, which is correct — those promotions
--  predate the distinction and must not be back-labelled with a guess.
--
--  TRANSACTIONS: migrate.js wraps each file in begin/commit and records the
--  ledger row. NO transaction control and NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════

alter table proposed_records
  add column if not exists resolution_kind text;

alter table proposed_records drop constraint if exists ck_proposed_resolution_kind;
alter table proposed_records add constraint ck_proposed_resolution_kind
  check (resolution_kind is null
         or resolution_kind in ('created', 'resolved_existing'));

-- A resolution_kind without a promoted record is a decision about nothing.
-- The reverse is deliberately ALLOWED: every promotion written before this
-- column existed carries a NULL, and back-filling a guess would be exactly
-- the confident-wrong value this repo refuses (§5).
alter table proposed_records drop constraint if exists ck_proposed_resolution_needs_promotion;
alter table proposed_records add constraint ck_proposed_resolution_needs_promotion
  check (resolution_kind is null or promoted_record_id is not null);

comment on column proposed_records.resolution_kind is
  'created | resolved_existing. NULL until confirmation. Written ONLY by the '
  'canonical Person-ingress confirmation, in the same transaction as '
  'promoted_record_id, from an action it derived and validated — never from a '
  'value the proposal stored about itself. Records whether Spine created a '
  'durable record from this source evidence or recognised the evidence as '
  'belonging to a record it already held. NULL on rows promoted before this '
  'column existed: those predate the distinction and are not back-labelled.';

create index if not exists ix_proposed_resolution_kind
  on proposed_records (resolution_kind) where resolution_kind is not null;
