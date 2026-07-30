-- ════════════════════════════════════════════════════════════════════
--  112 — POST-MOVE-OUT INITIAL UNIT TRIAGE
--
--  BUILD 1 of Maintenance Unit-Status Capture. The narrow slice: a staff
--  member walks a unit after move-out, says what they saw in their own
--  words, confirms one structured interpretation, and that becomes durable
--  operating truth with specific required work and one accountable owner.
--
--  ── WHAT THIS IS NOT ────────────────────────────────────────────────
--  Not a work-order system, not a turnover checklist, not a vendor or
--  purchasing rail, not deposit accounting, not a damage ruling, and not
--  final readiness confirmation. Those are separate and deliberately absent.
--
--  ── FOUR SEPARATE TRUTHS, NOT ONE ROW ───────────────────────────────
--  The whole point of the shape below is that these are DIFFERENT FACTS
--  with different lifetimes, and collapsing them is where the lie lives
--  (the same ruling tour_outcome.js made about attendance vs standing, and
--  migration 098 made about observation vs money meaning):
--
--    unit_observations         what the human SAID          — never edited
--    unit_triage_confirmations what they CONFIRMED it meant — superseded, never edited
--    unit_triage_findings      what is physically TRUE      — withdrawn, never deleted
--    unit_triage_required_work what must be DONE about it   — withdrawn, never deleted
--
--  A finding is not the work. "Refrigerator missing" is a finding; "source
--  and install refrigerator" is the work answering it. One finding may owe
--  several work items, and a finding may owe none yet — an observed
--  condition whose response is not yet established is a legitimate state,
--  not an incomplete row.
--
--  ── READINESS IS DERIVED, NEVER STORED ──────────────────────────────
--  There is deliberately NO readiness column anywhere below. Readiness is a
--  READ over confirmed findings, exactly as billback current-state is a read
--  over append-only entries (work_order_service.readBillbackState) and
--  exactly as commit 48c766e ruled for draft staleness: "staleness is
--  derived, not stored — remove the rolled-back writes."
--
--  Storing readiness would create a second thing that can disagree with the
--  findings, and the disagreement would be invisible. It is also the defect
--  this build exists to correct: readiness is currently derived from whether
--  a turnovers row exists, which makes an uninspected unit read `ready`.
--
--  AND: this flow may establish `not_ready` or `unknown` and MAY NEVER
--  establish `ready`. There is no value in any vocabulary below that can
--  express readiness. A first walk cannot prove a unit is ready, so the
--  schema does not offer a way to say it.
--
--  ── APPEND-ONLY, LIKE THE RAILS THAT CAME BEFORE ────────────────────
--  Same discipline as 099 (billback), 092 (person attributes), 111
--  (governed-charge rulings): no UPDATE path on history, no DELETE path,
--  correction is a NEW row pointing at what it supersedes. Current truth is
--  the latest row nothing supersedes.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) THE ATTRIBUTED OBSERVATION — the human's exact words ──────────
--
--  Never edited, never deleted, never re-interpreted in place. It survives
--  interpretation, confirmation, correction and supersession, because it is
--  EVIDENCE, not state. work_order_service already holds this line for the
--  work-order description ("stored VERBATIM"); this is the same rule for the
--  observation that precedes any work.
create table if not exists unit_observations (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  unit_id             uuid not null references units(id) on delete cascade,

  -- WHO SAW IT. Distinct from who confirms the interpretation and distinct
  -- again from who ends up owning the work. Frequently the same human;
  -- sometimes not. Three facts, never one column.
  observed_by_user_id uuid not null references users(id),

  -- The words. Not null, not blank — an observation with no observation is
  -- not a record, it is an empty row that reads as evidence.
  original_text       text not null check (btrim(original_text) <> ''),

  -- Evidence, not a condition of recording. A walk with no photos is a
  -- complete walk; a photo requirement here would mean a tech with a dead
  -- phone cannot report an infestation.
  photos              text[] not null default '{}',

  -- How it arrived. 'voice' is accepted now so the column does not need a
  -- migration when voice capture lands; nothing in this build writes it.
  capture_mode        text not null default 'text'
                        check (capture_mode in ('text','voice')),

  -- Server-stamped. A client-supplied capture time is a claim, not a fact.
  captured_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);
create index if not exists idx_unit_obs_unit     on unit_observations(unit_id, captured_at desc);
create index if not exists idx_unit_obs_property on unit_observations(property_id, captured_at desc);

-- ── 2) THE CONFIRMED INTERPRETATION ─────────────────────────────────
--
--  ONE confirmation per observation, by a named human, at a named time.
--  A correction is a NEW confirmation carrying supersedes_id — the original
--  is never touched. Current truth = latest row nothing supersedes.
--
--  The three axes are separate because they answer different questions and
--  fail independently. A unit can be confirmed vacant with uncertain
--  condition (walked the door, did not walk the rooms), or confirmed severe
--  with uncertain vacancy (saw the damage through a window). Collapsing them
--  would make one unknown contaminate the other.
create table if not exists unit_triage_confirmations (
  id                      uuid primary key default gen_random_uuid(),
  observation_id          uuid not null references unit_observations(id) on delete cascade,
  property_id             uuid not null references properties(id) on delete cascade,
  unit_id                 uuid not null references units(id) on delete cascade,

  -- WHO CONFIRMED. Separate from observed_by_user_id on purpose.
  confirmed_by_user_id    uuid not null references users(id),

  -- Is the unit physically empty NOW. This is a PHYSICAL observation and is
  -- deliberately NOT the same fact as the administrative move-out status or
  -- any legal possession conclusion. unit_events remains the possession
  -- source of truth; nothing here writes it. A staff member reporting that
  -- someone is inside is reporting what they saw — it is not a holdover
  -- finding, not a trespass finding, and not an eviction trigger.
  vacancy_observation     text not null
                            check (vacancy_observation in
                              ('vacant','occupied_or_someone_remains','uncertain')),

  -- Does the normal turn path apply. 'severe' means something prevents the
  -- normal turn from starting.
  initial_condition       text not null
                            check (initial_condition in
                              ('normal_turn','severe','uncertain')),

  -- The DEFAULT IS PARTIAL, and that is the entire point. Silence about a
  -- condition means unknown — never that the condition is absent. Nothing
  -- may read the absence of a finding as proof there is no finding.
  inspection_completeness text not null default 'initial_triage'
                            check (inspection_completeness in
                              ('initial_triage','complete_inspection')),

  -- CORRECTION RAIL. A correction says what it corrects and why.
  supersedes_id           uuid references unit_triage_confirmations(id),
  correction_reason       text,

  created_at              timestamptz not null default now(),

  -- A correction without a reason is a silent rewrite of the record. Same
  -- rule the billback rail enforces in application code, enforced here in
  -- the schema so no future caller can route around it.
  constraint ck_utc_correction_states_reason
    check (supersedes_id is null or (correction_reason is not null and btrim(correction_reason) <> '')),

  -- One confirmation per observation, unless it is an explicit correction.
  -- Two independent confirmations of one observation would be two competing
  -- truths with no way to tell which is current.
  constraint uq_utc_one_original_per_observation
    exclude (observation_id with =) where (supersedes_id is null)
);
create index if not exists idx_utc_unit       on unit_triage_confirmations(unit_id, created_at desc);
create index if not exists idx_utc_property   on unit_triage_confirmations(property_id, created_at desc);
create index if not exists idx_utc_supersedes on unit_triage_confirmations(supersedes_id) where supersedes_id is not null;

-- ── 3) CONFIRMED PHYSICAL FINDINGS ──────────────────────────────────
--
--  What is physically true. NOT the work instruction — see table 4.
--
--  Each finding is its own row with its own identity. Three conditions named
--  in one sentence are three findings, never one note. This is the
--  distinction the source audit found missing entirely: today a condition
--  survives only as prose inside a work order's title, which is why
--  management has to reconstruct a unit's state from work-order notes.
create table if not exists unit_triage_findings (
  id                  uuid primary key default gen_random_uuid(),
  confirmation_id     uuid not null references unit_triage_confirmations(id) on delete cascade,
  property_id         uuid not null references properties(id) on delete cascade,
  unit_id             uuid not null references units(id) on delete cascade,

  finding_text        text not null check (btrim(finding_text) <> ''),

  -- The operator's own words that produced this finding, when it came from
  -- the interpreter. A proposal that cannot show its evidence is a guess
  -- wearing a structure. Null when the operator added the finding by hand.
  evidence_text       text,

  -- Did this finding come from the machine's proposal or the human's hand.
  -- Kept so "Spine proposed it and the human let it stand" and "the human
  -- typed it themselves" stay different facts.
  origin              text not null default 'proposed'
                        check (origin in ('proposed','operator_added')),

  -- Does this alone prevent the normal turn from starting.
  is_severe           boolean not null default false,

  -- Is this of a kind that tends to control the schedule. NOT a duration and
  -- NOT a date — the operator is never asked to estimate either during a
  -- first walk, and nothing here may invent one.
  long_lead_kind      text
                        check (long_lead_kind is null or long_lead_kind in
                          ('appliance_replacement','hvac_failure','pest_treatment',
                           'access_or_possession_problem','major_cleanup','major_repair')),

  -- WITHDRAWAL, NOT DELETION. A finding that turns out to be wrong is
  -- withdrawn with an attributed reason and stays visible in history.
  withdrawn_at        timestamptz,
  withdrawn_by_user_id uuid references users(id),
  withdrawn_reason    text,

  created_at          timestamptz not null default now(),

  constraint ck_utf_withdrawal_is_attributed
    check ( (withdrawn_at is null and withdrawn_by_user_id is null and withdrawn_reason is null)
         or (withdrawn_at is not null and withdrawn_by_user_id is not null
             and withdrawn_reason is not null and btrim(withdrawn_reason) <> '') )
);
create index if not exists idx_utf_confirmation on unit_triage_findings(confirmation_id);
create index if not exists idx_utf_unit_live    on unit_triage_findings(unit_id) where withdrawn_at is null;

-- ── 4) REQUIRED WORK ────────────────────────────────────────────────
--
--  What must be DONE in response to a finding. Separate identity, separate
--  lifecycle, separate completion state.
--
--  Deliberately absent in this build, and their absence is the design:
--  no vendor, no cost, no schedule, no due date, no invoice, no billback, no
--  closeout proof. Required work may exist long before any of those are
--  known, and inventing any of them here would be a fake number with an
--  operator's name on it. Migration 098 already ruled that a maintenance
--  capture surface does not author money meaning; this holds that line.
create table if not exists unit_triage_required_work (
  id                  uuid primary key default gen_random_uuid(),

  -- The finding this answers. Nullable: an operator may add required work
  -- they know is needed without first naming a separate finding for it.
  finding_id          uuid references unit_triage_findings(id) on delete cascade,

  -- Always present, so a work item is never orphaned from its confirmation
  -- even when it has no finding.
  confirmation_id     uuid not null references unit_triage_confirmations(id) on delete cascade,
  property_id         uuid not null references properties(id) on delete cascade,
  unit_id             uuid not null references units(id) on delete cascade,

  work_text           text not null check (btrim(work_text) <> ''),

  origin              text not null default 'proposed'
                        check (origin in ('proposed','operator_added')),

  -- 'required' is the only live state this build writes. 'withdrawn' and
  -- 'superseded' exist so a correction has somewhere honest to land without
  -- a second migration. There is no 'complete' — completion is governed by
  -- the shared completion and proof foundations and is explicitly out of
  -- scope for BUILD 1. A status this table cannot honestly maintain is worse
  -- than a status it does not offer.
  status              text not null default 'required'
                        check (status in ('required','withdrawn','superseded')),

  superseded_by_id    uuid references unit_triage_required_work(id),
  withdrawn_at        timestamptz,
  withdrawn_by_user_id uuid references users(id),
  withdrawn_reason    text,

  created_at          timestamptz not null default now(),

  constraint ck_utrw_withdrawal_is_attributed
    check ( status <> 'withdrawn'
         or (withdrawn_at is not null and withdrawn_by_user_id is not null
             and withdrawn_reason is not null and btrim(withdrawn_reason) <> '') )
);
create index if not exists idx_utrw_confirmation on unit_triage_required_work(confirmation_id);
create index if not exists idx_utrw_finding      on unit_triage_required_work(finding_id);
create index if not exists idx_utrw_unit_live    on unit_triage_required_work(unit_id) where status = 'required';

-- ── OBLIGATION TYPES INTRODUCED BY THIS BUILD ───────────────────────
--
--  No schema change: obligations.type is free text and the routing engine is
--  shared. Recorded here so the vocabulary has one written home.
--
--    initial_unit_walk           walk the unit and report its condition.
--                                Born from move-out confirmation.
--    resolve_unit_readiness_scope  the ONE accountable obligation over the
--                                confirmed scope. Governs the outcome; does
--                                not mean one person performs every item.
--    protect_next_move_in        MANAGER decision when severe condition or a
--                                long-lead blocker meets a committed upcoming
--                                move-in. It creates a decision, never an
--                                action: this build may not contact a
--                                resident, promise a unit, transfer anyone,
--                                or change a lease.
--    unit_possession_exception   vacancy not confirmed. Preserves the
--                                uncertainty and routes it. NOT a legal
--                                determination of any kind.
