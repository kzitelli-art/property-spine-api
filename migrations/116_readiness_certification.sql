-- ════════════════════════════════════════════════════════════════════
--  116 — FINAL READINESS WALK AND CERTIFICATION  (BUILD 4)
--
--  The final operating gate, and the FIRST build permitted to establish
--  `ready` — only ever through an explicit human certification.
--
--    all confirmed turn work completed and proven
--      → final readiness walk becomes actionable
--        → authorized manager performs the walk
--          → missed conditions create new work and reopen the flow
--          → OR the manager certifies the unit ready
--            → availability and management reads update
--
--  ── THE RULE THIS WHOLE BUILD EXISTS TO HOLD ────────────────────────
--
--      THE ABSENCE OF OPEN WORK IS NOT READINESS.
--
--  Every prior build refused to emit `ready`. This one may — and only from a
--  row in readiness_certifications, written by a named human who said so. No
--  query, no derivation, no "everything looks closed" heuristic can produce
--  it. That is the entire point: readiness is an affirmative claim somebody
--  put their name to, not the residue of an empty task list.
--
--  It is also the §5 defect this whole sequence started from, inverted. The
--  legacy classifier reads `ready` from the ABSENCE of a turnover row. This
--  table is the opposite shape by construction.
--
--  ── WHAT READINESS DOES NOT MEAN ────────────────────────────────────
--  Not possession. Not keys handed over. Not an active lease. Not legal
--  occupancy. Not the absence of every cosmetic imperfection. Not completed
--  move-out administration. Physical readiness stays a separate axis from
--  possession, economic tenancy and move-in delivery — and nothing here
--  writes any of those.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) THE FINAL WALK ───────────────────────────────────────────────
--
--  The observation. Recorded whether the walk passes or fails, because a
--  failed walk is evidence too — it is how we know the unit was looked at and
--  what was found.
--
--  THREE PEOPLE, KEPT APART (ruling 4). They are usually the same human and
--  sometimes are not:
--    walked_by_user_id        who physically performed the walk
--    (certification carries)  who certified
--    senior_accountable_*     where the buck stops at this property
--
--  No new authority model is invented. senior_accountable_user_id is resolved
--  from EXISTING property_team_assignments when it can be, and left NULL with
--  a stated reason when it cannot. An unresolved accountability is recorded
--  honestly rather than papered over with a second obligation or a duplicate
--  readiness owner.
create table if not exists unit_readiness_walks (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references properties(id) on delete cascade,
  unit_id              uuid not null references units(id) on delete cascade,
  turn_scope_id        uuid references unit_turn_scopes(id) on delete set null,

  walked_by_user_id    uuid not null references users(id),
  walked_at            timestamptz not null default now(),

  -- Resolved from existing assignments where possible; NULL is a real answer.
  senior_accountable_user_id uuid references users(id),
  senior_accountable_basis   text,

  outcome              text not null check (outcome in ('ready','not_ready')),

  -- The confirmation areas. Each is a boolean the walker affirmed, or NULL
  -- for "not confirmed" — never defaulted to true to make a form look
  -- complete. A `ready` outcome requires all of them affirmed; the service
  -- enforces that, and the constraint below backs it structurally.
  work_complete_confirmed        boolean,
  cleaning_acceptable_confirmed  boolean,
  appliances_present_confirmed   boolean,
  appliance_function_confirmed   boolean,
  no_repair_blocker_confirmed    boolean,
  keys_accounted_confirmed       boolean,
  condition_acceptable_confirmed boolean,
  no_unknowns_confirmed          boolean,

  note                 text,
  -- OPTIONAL. The final walk is not a photo checklist — a walker who took no
  -- photos performed a complete walk.
  photos               text[] not null default '{}',

  created_at           timestamptz not null default now(),

  -- A `ready` walk cannot leave a confirmation area unanswered. This is the
  -- structural backstop; the service gives an honest 400 naming what is missing.
  constraint ck_urw_ready_requires_all_confirmations
    check (outcome <> 'ready' or (
      work_complete_confirmed is true and cleaning_acceptable_confirmed is true
      and appliances_present_confirmed is true and no_repair_blocker_confirmed is true
      and keys_accounted_confirmed is true and condition_acceptable_confirmed is true
      and no_unknowns_confirmed is true))
);
create index if not exists idx_urw_unit on unit_readiness_walks(unit_id, walked_at desc);
create index if not exists idx_urw_property on unit_readiness_walks(property_id);

-- ── 2) THE CERTIFICATION ────────────────────────────────────────────
--
--  A NEW DURABLE FACT. The only thing in this system that can make a unit
--  physically ready.
--
--  It preserves THE EXACT STATE IT RELIED ON (ruling 7) in relied_on_state:
--  which work was complete, which proof was satisfied, the cleaning, the
--  unresolved unknowns. Without that, a later dispute has nothing to examine —
--  "it was certified" would be unfalsifiable. With it, you can ask whether the
--  certification was reasonable ON WHAT WAS KNOWN AT THE TIME, which is the
--  only fair question to ask a human.
--
--  Append-only. A correction or revocation is a NEW row pointing at what it
--  supersedes, never an UPDATE and never a DELETE. `ready` must never silently
--  flip back to `not ready`.
create table if not exists unit_readiness_certifications (
  id                    uuid primary key default gen_random_uuid(),
  walk_id               uuid not null references unit_readiness_walks(id) on delete cascade,
  property_id           uuid not null references properties(id) on delete cascade,
  unit_id               uuid not null references units(id) on delete cascade,

  -- WHO CERTIFIED. Distinct from who walked, kept separately even when equal.
  certified_by_user_id  uuid not null references users(id),
  certified_at          timestamptz not null default now(),

  -- Carried onto the certification so the record stands alone.
  walked_by_user_id     uuid not null references users(id),
  senior_accountable_user_id uuid references users(id),
  senior_accountable_basis   text,

  -- 'ready' is the affirmative state. 'revoked' and 'corrected' are how it
  -- ends — as NEW rows, never as an edit to this one.
  state                 text not null default 'ready'
                          check (state in ('ready','revoked','corrected')),

  note                  text,
  photos                text[] not null default '{}',

  -- The evidence this certification rested on, captured at the moment it was
  -- made. JSON because its shape is a snapshot, not a schema.
  relied_on_state       jsonb not null default '{}'::jsonb,

  -- The move-in this was certified against, when one existed.
  next_move_in_date     date,

  -- CORRECTION / REVOCATION RAIL
  supersedes_id         uuid references unit_readiness_certifications(id),
  correction_reason     text,

  created_at            timestamptz not null default now(),

  constraint ck_urc_correction_states_reason
    check (supersedes_id is null or (correction_reason is not null and btrim(correction_reason) <> '')),
  -- A row that ENDS a certification must say what it ended and why.
  constraint ck_urc_terminal_states_supersede
    check (state = 'ready' or supersedes_id is not null),

  -- One live certification per walk. Further rows must be corrections.
  constraint uq_urc_one_original_per_walk
    exclude (walk_id with =) where (supersedes_id is null)
);
create index if not exists idx_urc_unit on unit_readiness_certifications(unit_id, certified_at desc);
create index if not exists idx_urc_property on unit_readiness_certifications(property_id);
create index if not exists idx_urc_supersedes on unit_readiness_certifications(supersedes_id) where supersedes_id is not null;

-- ── 3) FINAL-WALK FINDINGS REUSE THE CANONICAL PATH ─────────────────
--
--  A failed walk creates findings and required work through the SAME tables
--  Builds 1-3 use — unit_triage_findings and unit_triage_required_work. There
--  is no raw insert and no generic "final walk failed" note (ruling 5).
--
--  These columns let a finding say it came from the final walk, so the record
--  can distinguish "we knew about this at scoping" from "the final walk caught
--  it" — which is exactly the distinction a manager reviewing a slipped
--  turn needs.
alter table unit_triage_findings
  add column if not exists readiness_walk_id uuid references unit_readiness_walks(id) on delete set null;
alter table unit_triage_required_work
  add column if not exists readiness_walk_id uuid references unit_readiness_walks(id) on delete set null;

create index if not exists idx_utf_walk on unit_triage_findings(readiness_walk_id) where readiness_walk_id is not null;
create index if not exists idx_utrw_walk on unit_triage_required_work(readiness_walk_id) where readiness_walk_id is not null;

-- ── 4) RECLEAN RULINGS ──────────────────────────────────────────────
--
--  Ruling 6: corrective work that creates dust, debris, paint disturbance or
--  installation mess must reopen final cleaning — but NOT every reopened item
--  requires recleaning, and assuming so would send crews to reclean units that
--  are still clean.
--
--  Where corrective work clearly does not disturb the cleaned condition, an
--  authorized human may rule recleaning unnecessary. That ruling is ATTRIBUTED
--  and durable: it is a decision somebody made, not a default the system took.
create table if not exists reclean_rulings (
  id                  uuid primary key default gen_random_uuid(),
  work_id             uuid not null references unit_triage_required_work(id) on delete cascade,
  property_id         uuid not null references properties(id) on delete cascade,
  unit_id             uuid not null references units(id) on delete cascade,

  reclean_required    boolean not null,
  ruled_by_user_id    uuid not null references users(id),
  reason              text not null check (btrim(reason) <> ''),
  ruled_at            timestamptz not null default now(),
  created_at          timestamptz not null default now()
);
create index if not exists idx_rr_work on reclean_rulings(work_id, created_at desc);

-- ── OBLIGATION TYPES INTRODUCED BY BUILD 4 ──────────────────────────
--
--    final_readiness_walk    the walk itself, once prerequisites are met
--    readiness_reinspection  spawned when a certification is revoked or
--                            corrected — the unit must be looked at again
--
--  A SUCCESSFUL certification is QUIET. It spawns no manager obligation and
--  appears on no exception list. Management visibility is required only when
--  the walk fails, readiness authority is unavailable, a certification is
--  corrected or revoked, a near-term committed move-in is exposed, or another
--  availability blocker needs judgment.
