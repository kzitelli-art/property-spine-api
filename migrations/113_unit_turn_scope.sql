-- ════════════════════════════════════════════════════════════════════
--  113 — NORMAL TURN SCOPE AND ORDERED FLOW  (BUILD 2)
--
--  Extends a confirmed BUILD 1 initial triage into a complete normal-turn
--  scope that Spine can ORDER and operate. The point of this build is flow:
--  work is not a list of disconnected tasks, it is a sequence with real
--  prerequisites, and exactly one thing controls what happens next.
--
--  ── WHAT THIS IS NOT ────────────────────────────────────────────────
--  Not a workflow engine. Not vendor selection, purchasing, cost, billback,
--  completion proof, missed-commitment scoring, or final readiness
--  certification. The readiness walk is MODELLED as a blocked stage here and
--  is never performed or certified by this build.
--
--  ── ONE WORK LIST, NOT TWO ──────────────────────────────────────────
--  This migration does NOT create a second required-work table. It ALTERs
--  BUILD 1's unit_triage_required_work, because "required work on a unit
--  arising from a confirmed capture" is one concept whether it came from the
--  first walk or the full scope. Two work tables would be two competing
--  answers to "what does this unit need", and the disagreement between them
--  would be invisible — the exact defect migration 098 and the two
--  deriveCategories functions were about.
--
--  The table keeps its BUILD 1 name. A rename would churn every reader for a
--  cosmetic gain; the column comments carry the meaning.
--
--  ── STAGE IS NULLABLE AND THAT IS DELIBERATE ────────────────────────
--  BUILD 1 work rows were never staged. Back-filling them with a guessed
--  stage would invent an operating dependency nobody recorded — a triage
--  "Deep clean unit" is not evidence that a final-clean stage was intended.
--  NULL means UNSTAGED: always actionable, never a blocker, never blocked.
--  Only BUILD 2 scope work carries a stage.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) THE CONFIRMED TURN SCOPE ─────────────────────────────────────
--
--  Append-only and supersedable, the same rail as unit_triage_confirmations
--  and the billback ledger: a correction is a NEW row pointing at what it
--  supersedes. Current truth is the latest row nothing supersedes.
--
--  Anchored to the BUILD 1 triage confirmation it extends, so a scope can
--  never float free of the walk that justified it.
create table if not exists unit_turn_scopes (
  id                      uuid primary key default gen_random_uuid(),
  triage_confirmation_id  uuid not null references unit_triage_confirmations(id) on delete cascade,
  property_id             uuid not null references properties(id) on delete cascade,
  unit_id                 uuid not null references units(id) on delete cascade,

  -- WHO CONFIRMED THE SCOPE. Distinct from who observed, and distinct from
  -- who ends up accountable for resolving it. Maintenance staff may
  -- contribute findings; the accountable scope owner confirms completeness.
  confirmed_by_user_id    uuid not null references users(id),

  -- the operator's own words for this scope pass, preserved verbatim
  original_text           text,
  photos                  text[] not null default '{}',

  -- ── PAINT ──
  paint_level             text not null
                            check (paint_level in ('none','touch_up','partial','full','unknown')),
  -- only meaningful when paint_level = 'partial'; free text, the operator's words
  paint_areas             text,

  -- ── CLEANING ──
  --  'deep' is NORMAL TURN WORK. It is not severe and not schedule-controlling
  --  on its own — that ruling is enforced in the interpreter, and nothing in
  --  this schema may re-introduce it by treating 'deep' as special.
  cleaning_level          text not null
                            check (cleaning_level in ('none','touch_up','full','deep','unknown')),

  -- ── KEYS AND ACCESS ──
  --  What is KNOWN, recorded without a legal, resident-charge, or economic
  --  ruling. A missing key is a fact about keys, not a finding about a person.
  keys_status             text not null
                            check (keys_status in ('accounted_for','items_missing','unknown')),
  keys_note               text,

  -- ── INSPECTION COMPLETENESS ──
  --  'partial' preserves unknown scope and can never unlock final readiness.
  inspection_completeness text not null
                            check (inspection_completeness in ('complete_turn_scope','partial')),

  -- ── CORRECTION RAIL ──
  supersedes_id           uuid references unit_turn_scopes(id),
  correction_reason       text,

  created_at              timestamptz not null default now(),

  constraint ck_uts_correction_states_reason
    check (supersedes_id is null or (correction_reason is not null and btrim(correction_reason) <> '')),

  -- paint_areas only means something for a partial paint
  constraint ck_uts_paint_areas_only_when_partial
    check (paint_level = 'partial' or paint_areas is null),

  -- One original scope per triage confirmation; further rows must be
  -- corrections. Two independent scopes for one walk would be two competing
  -- truths with no way to tell which is current.
  constraint uq_uts_one_original_per_triage
    exclude (triage_confirmation_id with =) where (supersedes_id is null)
);
create index if not exists idx_uts_unit      on unit_turn_scopes(unit_id, created_at desc);
create index if not exists idx_uts_property  on unit_turn_scopes(property_id, created_at desc);
create index if not exists idx_uts_triage    on unit_turn_scopes(triage_confirmation_id);
create index if not exists idx_uts_supersedes on unit_turn_scopes(supersedes_id) where supersedes_id is not null;

-- ── 2) APPLIANCE CONDITION ──────────────────────────────────────────
--
--  One row per appliance the operator was asked about. 'unknown' is a real
--  answer and the default meaning of silence — an appliance nobody checked is
--  NOT working, and must never be recorded as such to keep a form tidy.
--
--  No per-unit appliance inventory exists anywhere in the schema today, so
--  the candidate list is served by the service from a standard set and the
--  read says plainly that the inventory is unknown. It does NOT fabricate a
--  unit-specific inventory, and when a real inventory arrives this table does
--  not change — only where the candidate list comes from.
--
--  Deliberately absent: cause, cost, vendor, delivery date, resident
--  responsibility. A condition observation authors none of those.
create table if not exists unit_turn_appliances (
  id            uuid primary key default gen_random_uuid(),
  scope_id      uuid not null references unit_turn_scopes(id) on delete cascade,
  property_id   uuid not null references properties(id) on delete cascade,
  unit_id       uuid not null references units(id) on delete cascade,

  -- free text key so a property with an unusual appliance is not forced into
  -- a closed list that does not fit it
  appliance_key text not null check (btrim(appliance_key) <> ''),
  label         text,

  condition     text not null
                  check (condition in ('working','needs_repair','needs_replacement','missing','unknown')),

  created_at    timestamptz not null default now(),

  -- one statement per appliance per scope
  unique (scope_id, appliance_key)
);
create index if not exists idx_uta_scope on unit_turn_appliances(scope_id);
create index if not exists idx_uta_unit  on unit_turn_appliances(unit_id);

-- ── 3) FINDINGS FROM THE FULL SCOPE ─────────────────────────────────
--
--  BUILD 1's unit_triage_findings is anchored to a triage confirmation.
--  Scope findings are anchored to a scope. Same discipline: a finding is what
--  is physically observed, and it is NOT the work that answers it.
alter table unit_triage_findings
  add column if not exists turn_scope_id uuid references unit_turn_scopes(id) on delete cascade;

create index if not exists idx_utf_turn_scope
  on unit_triage_findings(turn_scope_id) where turn_scope_id is not null;

-- A finding belongs to a triage confirmation OR a turn scope. Making
-- confirmation_id nullable would loosen BUILD 1's guarantee, so scope
-- findings carry BOTH: the scope that produced them and the confirmation the
-- scope extends. The index above is what scope reads use.

-- ── 4) STAGE AND SEQUENCE ON REQUIRED WORK ──────────────────────────
--
--  THE OPERATING DEPENDENCY, not a display preference:
--      1 repair   → 2 paint   → 3 final_clean   → 4 readiness_walk
--
--  · repair is eligible to begin first
--  · paint follows repair/replacement that would damage, open, disturb or
--    dirty painted surfaces
--  · final_clean follows ALL repair, replacement and paint work
--  · readiness_walk is blocked until everything else is complete AND the
--    inspection is complete. BUILD 2 never performs or certifies it.
--
--  NULL stage = BUILD 1 unstaged work. Always actionable, never blocking.
alter table unit_triage_required_work
  add column if not exists stage text
    check (stage is null or stage in ('repair','paint','final_clean','readiness_walk'));

alter table unit_triage_required_work
  add column if not exists turn_scope_id uuid references unit_turn_scopes(id) on delete cascade;

--  Does this specific repair disturb painted surfaces? Only repairs that do
--  can block paint. A leaking faucet under a sink does not require repainting
--  a bedroom, and treating every repair as paint-blocking would stall the
--  whole turn on unrelated work.
--
--  NULL = not assessed. Not assessed is treated as BLOCKING by the sequence
--  reader — the conservative reading, because getting this wrong the other
--  way means painting over work that has to be reopened.
alter table unit_triage_required_work
  add column if not exists disturbs_painted_surfaces boolean;

--  DELIBERATE SEQUENCE EXCEPTION. An authorized scope owner may release one
--  item from its prerequisite, with an attributed reason. It is per-item and
--  never global: there is no "ignore sequencing" switch.
alter table unit_triage_required_work
  add column if not exists sequence_exception boolean not null default false;
alter table unit_triage_required_work
  add column if not exists sequence_exception_reason text;
alter table unit_triage_required_work
  add column if not exists sequence_exception_by_user_id uuid references users(id);
alter table unit_triage_required_work
  add column if not exists sequence_exception_at timestamptz;

--  An exception with no actor or no reason is an unexplained override of an
--  operating dependency. Refused in the schema, not just in application code.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ck_utrw_exception_is_attributed'
  ) then
    alter table unit_triage_required_work
      add constraint ck_utrw_exception_is_attributed
        check ( sequence_exception = false
             or ( sequence_exception_by_user_id is not null
              and sequence_exception_at is not null
              and sequence_exception_reason is not null
              and btrim(sequence_exception_reason) <> '' ) );
  end if;
end $$;

create index if not exists idx_utrw_turn_scope
  on unit_triage_required_work(turn_scope_id) where turn_scope_id is not null;
create index if not exists idx_utrw_stage
  on unit_triage_required_work(unit_id, stage) where status = 'required';

-- ── OBLIGATION TYPES INTRODUCED BY BUILD 2 ──────────────────────────
--
--  No schema change: obligations.type is free text and routing is shared.
--
--    complete_turn_scope     capture the complete normal-turn scope from a
--                            confirmed initial walk. Born when triage is
--                            confirmed with a complete-enough vacancy answer.
--    resolve_turn_scope      the ONE accountable obligation over the confirmed
--                            turn scope. Default owner is the assistant
--                            property manager where the property has one.
--
--  ROUTINE TURN WORK RAISES NO MANAGER OBLIGATION. Build 2 escalates only on
--  a real exception (no eligible owner, a blocking prerequisite, a severe or
--  long-lead threat to a committed move-in, a partial inspection, disputed
--  scope, or consequential unknowns). Ordinary paint-clean-repair flow is
--  quiet by design.
