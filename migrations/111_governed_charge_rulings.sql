-- ════════════════════════════════════════════════════════════════════
--  111_governed_charge_rulings.sql
--  WHO DECIDED THIS, WHEN, AND WHAT CHANGED
--
--  ── THE MISSING DURABLE OBJECT ───────────────────────────────────────
--  property_governed_charges answers ONE question: what are the terms now?
--  It cannot answer who decided them, against what question, on what
--  evidence, or what the terms were immediately before. The draft row is
--  mutable by design while a charge is unpublished, so a ruling recorded only
--  as a column change leaves no proof it was ever made.
--
--  ── WHY NOT AN EXISTING PRIMITIVE (each inspected on the live DB) ─────
--  decision_cases (0 rows) — carries a mutable case lifecycle (state,
--    resolved_by_person_id, resolved_at). A ruling is not a case that later
--    resolves; it is a fact that happened. It also has no digest columns and
--    no jsonb, so prior/resulting digests would have to live in `note`.
--  work_order_billback_decisions — the right SHAPE (append-only, entry_kind,
--    actor, supersedes_id) but work_order_id is NOT NULL. Wrong domain.
--  money_events — recording a governance ruling here would invent a money
--    event that never occurred.
--  events (768 rows) — property/person/unit/type/note only. No actor_user_id,
--    no digests, no jsonb, and it is precisely the generic company-wide audit
--    log this table is instructed not to become.
--
--  ── DELIBERATELY NARROW ──────────────────────────────────────────────
--  This table records ONE kind of fact: an ownership ruling changed the terms
--  of a governed-charge draft. There is no event_type vocabulary and no rows
--  for publication, cutover, rejection or supersession — those already have
--  their own receipts (publication_receipt, cutover_receipt) and adding empty
--  vocabulary now would be speculative schema. If a second event kind is ever
--  needed it arrives with the term that needs it.
--
--  ── APPEND-ONLY MEANS APPEND-ONLY ────────────────────────────────────
--  A trigger refuses UPDATE and DELETE outright. A correction is a NEW ruling
--  row; history is never edited. This is the same discipline as
--  work_order_billback_decisions, which was designed against the agent_review
--  failure where 173 rows closed with no record of how.
--
--  ── IDEMPOTENCY ──────────────────────────────────────────────────────
--  idempotency_key is UNIQUE. A retry of the same ruling returns the original
--  row instead of inserting a second, so a double-click cannot create two
--  histories of one decision.
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive; one table, one
--  trigger. No existing table or row is altered.
-- ════════════════════════════════════════════════════════════════════

create table if not exists governed_charge_rulings (
  id                     uuid primary key default gen_random_uuid(),

  -- Scope. Both derived from the authenticated session by the service — a
  -- client-supplied property is never authority (§21).
  property_id            uuid not null references properties(id) on delete cascade,
  governed_charge_id     uuid not null references property_governed_charges(id) on delete cascade,

  -- WHAT WAS ASKED, and WHAT WAS ANSWERED. The question is stored as a stable
  -- key rather than prose so two rulings on the same question are comparable.
  question_key           text not null,
  selected_answer        text not null,

  -- WHO. actor_user_id is the authenticated session identity; actor_person_id
  -- is the durable human behind it where the bridge resolves one. Both are
  -- kept because they are different facts (§10).
  actor_user_id          uuid references users(id),
  actor_person_id        uuid references persons(id),
  -- The verb the actor actually held when the ruling was recorded, e.g.
  -- may_publish_pricing. Recorded so a later reader can see the authority
  -- exercised, not merely that someone was signed in.
  authority_exercised    text not null,

  occurred_at            timestamptz not null default now(),

  -- The terms digest immediately BEFORE and AFTER the draft mutation, from the
  -- canonical governed-charge digest. resulting_terms_digest is computed from
  -- the row as actually committed in this transaction, so it can never
  -- describe terms that failed to land.
  prior_terms_digest     text not null,
  resulting_terms_digest text not null,

  -- Exactly which structured fields moved, and their before/after values.
  changed_fields_json    jsonb not null default '[]'::jsonb,
  -- Free-form supporting material: the evidence considered, an operator note,
  -- the prose that was superseded. Never authority — evidence.
  reason_or_evidence_json jsonb,

  idempotency_key        text not null,

  created_at             timestamptz not null default now(),

  -- The two answers the closed ruling vocabulary allows today. 'conditional'
  -- is deliberately absent: it requires a governed condition_key, which is a
  -- separate decision, not a variant of this one.
  constraint ck_gcr_selected_answer check
    (selected_answer in ('new_lease_only', 'new_lease_and_renewal')),
  -- A ruling that changed nothing is not a ruling.
  constraint ck_gcr_digests_differ check (prior_terms_digest <> resulting_terms_digest),
  constraint ck_gcr_authority_stated check (length(trim(authority_exercised)) > 0)
);

-- One ruling per idempotency key. A retry resolves to the original row.
create unique index if not exists uq_gcr_idempotency on governed_charge_rulings (idempotency_key);
create index if not exists ix_gcr_charge on governed_charge_rulings (governed_charge_id, occurred_at desc);
create index if not exists ix_gcr_property on governed_charge_rulings (property_id, occurred_at desc);

comment on table governed_charge_rulings is
  'APPEND-ONLY. One kind of fact: an ownership ruling changed the terms of a governed-charge draft. property_governed_charges answers "what are the terms now"; this answers "who decided this, when, and what changed". Deliberately narrow — no publication/cutover/rejection vocabulary, because those carry their own receipts. A correction is a NEW row; rows are never edited.';

-- ── append-only enforcement ──────────────────────────────────────────
create or replace function ps_governed_charge_ruling_append_only() returns trigger as $$
begin
  raise exception 'governed_charge_rulings is append-only — record a NEW ruling instead of %ing history',
    lower(tg_op) using errcode = 'restrict_violation';
end $$ language plpgsql;

drop trigger if exists trg_gcr_append_only on governed_charge_rulings;
create trigger trg_gcr_append_only
  before update or delete on governed_charge_rulings
  for each row execute function ps_governed_charge_ruling_append_only();
