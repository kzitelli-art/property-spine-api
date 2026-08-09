-- ════════════════════════════════════════════════════════════════════
--  141 — ASK SPINE READ RECEIPTS
--
--  Build 1 · the durable audit history behind every decision-grade
--  answer Ask Spine gives.
--
--  ── WHY A TABLE AND NOT A LOG LINE ─────────────────────────────────
--
--  The question a receipt answers is not "what is true?" — that is a
--  read, and it recomputes. The question is "what did Spine SAY on
--  March 3, and under which definition?" Re-running today's predicate
--  against today's database does not reproduce March; only a preserved
--  row does.
--
--  ── APPEND-ONLY, FOR THE SAME REASON AS THE EVALUATIONS ────────────
--
--  A receipt that can be edited is not history. `forbid_mutation()` —
--  migration 137's, reused rather than re-declared — refuses UPDATE and
--  DELETE outright.
--
--  ── IT CARRIES ITS OWN DEFINITION ──────────────────────────────────
--
--  intent_contract_version + intent_contract_digest + candidate_predicate
--  _version are the point: when the contract later changes, an old
--  receipt still names the definition that produced its answer. Without
--  those three columns the row would be a number with no meaning
--  attached, which is worse than no row.
--
--  ── READ TIME IS NOT FACT TIME ─────────────────────────────────────
--
--  `executed_at` is when the query ran. `evidence_as_of` is when the
--  world was observed. They are different facts and are stored
--  separately; `evidence_as_of` is NULLABLE on purpose, with
--  `evidence_as_of_basis` naming either the source timestamp it came
--  from or the reason there is none. Substituting now() for a missing
--  evidence time would be a fabricated observation.
--
--  ── NO DOMAIN MUTATION ─────────────────────────────────────────────
--
--  Writing a receipt is audit history, not an operational consequence.
--  Nothing in this migration touches work orders, obligations,
--  assignments, evaluations or evidence.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.ask_spine_read_receipts (
  id                          uuid primary key default gen_random_uuid(),

  --  WHICH GOVERNED QUESTION, UNDER WHICH DEFINITION
  intent_slug                 text        not null,
  intent_contract_version     text        not null,
  intent_contract_digest      text        not null,
  candidate_predicate_version text        not null,

  --  WHO ASKED, AND IN WHAT SCOPE — server-derived, never client-supplied
  property_id                 uuid        not null references public.properties(id),
  actor_user_id               uuid            null references public.users(id),
  staff_session_id            uuid            null,

  --  TIME: two different facts, never merged
  executed_at                 timestamptz not null default now(),
  evidence_as_of              timestamptz     null,
  evidence_as_of_basis        text        not null,

  --  BOUNDEDNESS, DISCLOSED
  total_matching              integer     not null,
  selected_count              integer     not null,
  result_cap                  integer     not null,

  --  THE ANSWER
  coverage_state              text        not null,
  conclusion_code             text        not null,
  source_outcomes             jsonb       not null,
  supporting_records          jsonb       not null,
  rendered_answer             text        not null,

  created_at                  timestamptz not null default now(),

  --  `selected_count <= result_cap` is NOT asserted, and the omission is
  --  deliberate. The cap is applied PER LANE — current integrity and
  --  pre-cutover history are separate bounded lists, so a large history
  --  cannot crowd current failures off the page. A two-lane answer can
  --  therefore select up to 2 x result_cap rows, and a constraint that
  --  said otherwise would encode a rule the product does not have. What
  --  IS asserted is the part that would be a lie if violated: you cannot
  --  have selected more rows than matched.
  constraint ck_asrr_counts_sane
    check (total_matching >= 0
       and selected_count >= 0
       and result_cap     >  0
       and selected_count <= total_matching),

  --  The five completed-answer outcomes. `clarification_required` is
  --  deliberately absent: it is a PRE-ANSWER interpretation state, and a
  --  receipt records a completed decision-grade execution.
  constraint ck_asrr_coverage_state
    check (coverage_state in
      ('decisive', 'valid_empty', 'partial', 'unavailable', 'unsupported'))
);

create index if not exists idx_asrr_property_time
  on public.ask_spine_read_receipts (property_id, executed_at desc);
create index if not exists idx_asrr_intent
  on public.ask_spine_read_receipts (intent_slug, intent_contract_version);

--  History, therefore immutable. Same function migration 137 uses for the
--  proof evaluations — one append-only mechanism in this codebase, not two.
drop trigger if exists no_update_asrr on public.ask_spine_read_receipts;
create trigger no_update_asrr before update on public.ask_spine_read_receipts
  for each row execute function public.forbid_mutation();
drop trigger if exists no_delete_asrr on public.ask_spine_read_receipts;
create trigger no_delete_asrr before delete on public.ask_spine_read_receipts
  for each row execute function public.forbid_mutation();

comment on table public.ask_spine_read_receipts is
  'Build 1: durable audit history for every decision-grade Ask Spine answer. '
  'Append-only. Carries the intent contract version and digest that produced the '
  'answer, so an old receipt remains readable after the contract changes. '
  'executed_at is read time; evidence_as_of is fact time; they are never merged.';
