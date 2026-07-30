-- ════════════════════════════════════════════════════════════════════
--  115 — WORK ACCEPTANCE, PROOF AND FLOW PROGRESSION  (BUILD 3)
--
--  The operating loop:
--
--    required work exists → eligible staff ACCEPTS it → a due commitment is
--    confirmed → work is CLAIMED complete → lightweight PROOF is attached →
--    the obligation closes → the next stage becomes actionable
--
--  ── THREE THINGS THAT ARE NOT THE SAME ──────────────────────────────
--  ACCEPTANCE is not COMPLETION is not PROOF. They have different actors,
--  different times, and they fail independently. Collapsing any two is where
--  the lie lives — the same ruling tour_outcome.js made about attendance vs
--  standing, and 098 made about observation vs money meaning.
--
--    · a person can accept work and never do it        (missed commitment)
--    · a person can claim completion with no proof     (does NOT close)
--    · a person can finish work someone else accepted  (two actors, both kept)
--
--  ── EVERYTHING IS APPEND-ONLY ───────────────────────────────────────
--  Three new tables, no UPDATE path on history, no DELETE path anywhere.
--  A re-acceptance supersedes; a reopen is a NEW row pointing at the claim it
--  reopens. Current state is a READ over the latest rows nothing supersedes —
--  the same rail as work_order_billback_decisions (099), person attributes
--  (092), governed-charge rulings (111) and turn scopes (113).
--
--  Critically: reopening work MUST NOT erase the original claim or its proof.
--  "It was claimed done on Tuesday with these photos, and reopened Thursday
--  because the paint was still tacky" is the whole record. Deleting the
--  Tuesday claim would leave the reopen unexplainable.
--
--  ── WHAT THIS DOES NOT DO ───────────────────────────────────────────
--  No readiness certification — BUILD 3 cannot make a unit ready. No computer
--  vision, no photo scoring, no vendor, no purchasing, no invoice, no
--  billback, no missed-commitment scoring or gamification. A photo here is a
--  reference somebody attached; nothing inspects it.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) ACCEPTANCE ───────────────────────────────────────────────────
--
--  "I'll handle it tomorrow" is a PROPOSAL. This table only ever holds what
--  somebody explicitly confirmed.
--
--  FOUR SEPARATE PEOPLE-AND-TIME FACTS, deliberately not merged:
--    owner_user_id      who is ACCOUNTABLE for the work
--    accepted_by_user_id who performed the acceptance
--    accepted_at        when
--    due_at             what they committed to
--
--  owner and acceptor are usually the same human and sometimes are not — a
--  supervisor accepting on behalf of a tech who is already in the unit. One
--  column could not carry both without lying about one of them.
create table if not exists work_acceptances (
  id                  uuid primary key default gen_random_uuid(),
  work_id             uuid not null references unit_triage_required_work(id) on delete cascade,
  property_id         uuid not null references properties(id) on delete cascade,
  unit_id             uuid not null references units(id) on delete cascade,

  owner_user_id       uuid not null references users(id),
  accepted_by_user_id uuid not null references users(id),
  accepted_at         timestamptz not null default now(),

  -- THE COMMITMENT. Nullable, because a commitment nobody made is not a
  -- commitment, and a fabricated date is a fake number with a person's name
  -- on it. Accepting without a date is legitimate and stays visible as such.
  due_at              timestamptz,

  -- WHERE THE DATE CAME FROM. 'proposed_from_text' means Spine read it out of
  -- something the operator said and the operator confirmed it; it is never a
  -- silent inference. 'none' is the honest value when no date was committed.
  commitment_source   text not null default 'none'
                        check (commitment_source in
                          ('operator_entered','proposed_from_text','scope_default','none')),

  note                text,

  -- Re-acceptance (handover, re-commitment) supersedes rather than overwrites.
  supersedes_id       uuid references work_acceptances(id),
  supersede_reason    text,

  created_at          timestamptz not null default now(),

  constraint ck_wa_supersede_states_reason
    check (supersedes_id is null or (supersede_reason is not null and btrim(supersede_reason) <> '')),
  -- A commitment source that names a date must actually have one, and a date
  -- with source 'none' is a date nobody committed to.
  constraint ck_wa_commitment_source_matches_date
    check ((commitment_source = 'none' and due_at is null)
        or (commitment_source <> 'none' and due_at is not null))
);
create index if not exists idx_wa_work    on work_acceptances(work_id, created_at desc);
create index if not exists idx_wa_unit    on work_acceptances(unit_id);
create index if not exists idx_wa_owner   on work_acceptances(owner_user_id);
create index if not exists idx_wa_due     on work_acceptances(due_at) where due_at is not null;

-- ── 2) COMPLETION CLAIMS ────────────────────────────────────────────
--
--  A CLAIM, not a fact. The column is named `outcome` and the table is named
--  `claims` on purpose: somebody said this happened. Whether it closes the
--  work depends on whether the required proof came with it.
--
--  Three outcomes, and only one of them can close anything:
--    completed           may close IF proof requirements are met
--    unable_to_complete  work stays OPEN, with a structured reason
--    needs_followup      work stays OPEN
--
--  ACCEPTANCE IS NOT COMPLETION. Nothing here reads the acceptance row.
create table if not exists work_completion_claims (
  id                 uuid primary key default gen_random_uuid(),
  work_id            uuid not null references unit_triage_required_work(id) on delete cascade,
  property_id        uuid not null references properties(id) on delete cascade,
  unit_id            uuid not null references units(id) on delete cascade,

  -- Who is CLAIMING. May differ from the accepted owner; both are kept.
  claimed_by_user_id uuid not null references users(id),
  claimed_at         timestamptz not null default now(),

  outcome            text not null
                       check (outcome in ('completed','unable_to_complete','needs_followup')),

  -- Closed vocabulary for unable_to_complete, same discipline as
  -- NOT_DONE_REASONS in maintenance.js: a fixed list that REFUSES what it does
  -- not recognise, so a stall always routes somewhere real instead of
  -- vanishing into free text.
  unable_reason      text
                       check (unable_reason is null or unable_reason in
                         ('part_or_appliance_unavailable','specialist_required',
                          'additional_damage_found','access_issue',
                          'incorrect_scope','insufficient_time','other')),
  note               text,

  -- ── LIGHTWEIGHT PROOF ──
  --  References somebody attached. NOTHING INSPECTS THEM. There is no computer
  --  vision here and none is planned: a photo is evidence a human can look at,
  --  not a machine verdict. Deliberately an array with no minimum in the
  --  schema — how much proof each kind of work needs is a product rule that
  --  lives in work_proof.js, where it can change without a migration.
  proof_photos       text[] not null default '{}',

  -- Short functional confirmation, for work where a photo alone cannot show
  -- the thing works ("installed and cooling", "latches cleanly").
  functional_confirmation text,

  -- Did this claim satisfy its proof requirement at the moment it was made.
  -- Stored because the requirement can change later, and a claim must be
  -- judged by the rule in force when it was made — not retroactively failed.
  proof_satisfied    boolean not null default false,
  proof_shortfall    text,

  created_at         timestamptz not null default now(),

  -- unable_to_complete must say why. A stall with no reason cannot be routed.
  constraint ck_wcc_unable_states_reason
    check (outcome <> 'unable_to_complete' or unable_reason is not null),
  -- Only a 'completed' claim can ever be proof-satisfied.
  constraint ck_wcc_only_completed_satisfies
    check (proof_satisfied = false or outcome = 'completed')
);
create index if not exists idx_wcc_work on work_completion_claims(work_id, created_at desc);
create index if not exists idx_wcc_unit on work_completion_claims(unit_id);
create index if not exists idx_wcc_outcome on work_completion_claims(unit_id, outcome);

-- ── 3) REOPENINGS ───────────────────────────────────────────────────
--
--  Work claimed complete and later found incomplete. The ORIGINAL CLAIM AND
--  ITS PROOF SURVIVE — this row points AT them. "Claimed done Tuesday with
--  these photos, reopened Thursday because the paint was still tacky" is the
--  whole record, and deleting the Tuesday claim would make Thursday
--  unexplainable.
--
--  `triggered_by_work_id` carries the CASCADE case: final cleaning reopened
--  because a repair upstream of it was reopened. That is not the cleaner's
--  failure and the record must not read as though it were.
create table if not exists work_reopenings (
  id                   uuid primary key default gen_random_uuid(),
  work_id              uuid not null references unit_triage_required_work(id) on delete cascade,
  reopens_claim_id     uuid references work_completion_claims(id),
  property_id          uuid not null references properties(id) on delete cascade,
  unit_id              uuid not null references units(id) on delete cascade,

  reopened_by_user_id  uuid not null references users(id),
  reopened_at          timestamptz not null default now(),
  reason               text not null check (btrim(reason) <> ''),

  -- Set when this reopen was caused by another item reopening upstream.
  triggered_by_work_id uuid references unit_triage_required_work(id),

  created_at           timestamptz not null default now()
);
create index if not exists idx_wr_work on work_reopenings(work_id, created_at desc);
create index if not exists idx_wr_unit on work_reopenings(unit_id);

-- ── 4) THE STATUS VOCABULARY GAINS ONE VALUE ────────────────────────
--
--  required → complete, and back to required on a reopen.
--
--  `accepted` is deliberately NOT a status. Accepted work is still REQUIRED —
--  it is not done, it must still block downstream stages, and it must still
--  appear as outstanding. A separate 'accepted' status would make every
--  reader ask "does accepted count as open?" and half of them would answer
--  wrong. Acceptance lives in its own table where it cannot be mistaken for
--  progress.
--
--  turn_sequence.js keys `isOpen` on status = 'required', so completed work
--  stops blocking the next stage with no change to the sequence engine.
do $$
begin
  if exists (select 1 from pg_constraint
              where conname = 'unit_triage_required_work_status_check') then
    alter table unit_triage_required_work
      drop constraint unit_triage_required_work_status_check;
  end if;
end $$;

alter table unit_triage_required_work
  add constraint unit_triage_required_work_status_check
    check (status in ('required','complete','withdrawn','superseded'));

-- ── OBLIGATION TYPE INTRODUCED BY BUILD 3 ───────────────────────────
--
--    work_commitment   an accepted item with a due commitment. Closes when a
--                      proof-satisfied completion claim lands. Reopened work
--                      spawns a fresh one; the closed original stays.
--
--  ROUTINE SUCCESSFUL WORK RAISES NOTHING. Build 3 surfaces a management
--  exception only for: UNASSIGNED, unresolved consequential timing, a missed
--  commitment, an unable-to-complete outcome, missing or questioned proof, or
--  reopened work threatening the move-in flow.
