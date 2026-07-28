-- ════════════════════════════════════════════════════════════════════
--  117 — AUTHENTICATED STAFF AGENT CAPTURE  (BUILD 5)
--
--  A new capture DOOR into Builds 1-4. Not a new maintenance architecture.
--
--  ── FOUR FACTS THAT ARE NOT THE SAME ────────────────────────────────
--
--      staff message ≠ interpreted proposal ≠ operator confirmation
--                    ≠ resulting operating truth
--
--  Each is its own row with its own actor and time. The message is what a
--  human said. The proposal is what Spine thought it meant. The confirmation
--  is a human agreeing. The operating truth lives somewhere else entirely —
--  in the Build 1-4 canonical models — and this schema only holds a REFERENCE
--  to it.
--
--  ── THIS MIGRATION OWNS NO DOMAIN MODEL ─────────────────────────────
--  There is no agent finding, no agent required-work, no agent obligation, no
--  agent work status, no agent readiness, no agent ownership and no agent due
--  commitment anywhere below. Grep it. Those exist exclusively in the
--  canonical models, and the agent reaches them only by calling the services
--  that own them.
--
--  If a future change adds a domain column here, the agent has become a second
--  maintenance system and one operating action will mean two different things
--  depending on which door it came through. That is the failure this schema is
--  shaped to make impossible.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) THREAD ───────────────────────────────────────────────────────
--  One conversation, scoped to one authenticated staff member at one
--  property. Property is NOT a thread property in any sense that could widen
--  scope later — it records where the conversation happened, and every write
--  still re-derives authority from the session.
create table if not exists staff_agent_threads (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references properties(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_sat_user on staff_agent_threads(user_id, property_id);

-- ── 2) MESSAGE ──────────────────────────────────────────────────────
--
--  THE HUMAN'S EXACT WORDS, VERBATIM AND ATTRIBUTED. Never edited, never
--  deleted, never re-interpreted in place — the same rule BUILD 1 holds for
--  unit_observations.original_text and work_order_service holds for a work
--  order description.
--
--  `role` distinguishes what a person said from what Spine said back. An
--  agent reply is not evidence of anything except that Spine replied.
create table if not exists staff_agent_messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references staff_agent_threads(id) on delete cascade,
  property_id  uuid not null references properties(id) on delete cascade,
  user_id      uuid references users(id),

  role         text not null check (role in ('staff','agent')),
  body         text not null check (btrim(body) <> ''),

  -- Evidence attached by the human. NOTHING INSPECTS IT. There is no computer
  -- vision here and none planned: a photo without sufficient text produces a
  -- CLARIFICATION, never a confident physical finding.
  photos       text[] not null default '{}',

  -- The unit this message was understood to concern, when it could be
  -- resolved confidently. NULL is a real answer and means exactly that.
  unit_id      uuid references units(id) on delete set null,

  created_at   timestamptz not null default now()
);
create index if not exists idx_sam_thread on staff_agent_messages(thread_id, created_at asc);

-- ── 3) PROPOSAL ─────────────────────────────────────────────────────
--
--  WHAT SPINE THOUGHT THE MESSAGE MEANT. Not truth. A proposal may be
--  corrected or cancelled without creating any domain truth at all, and a
--  proposal that is never confirmed leaves the operating world untouched.
--
--  `resulting_*` are REFERENCES to canonical records the confirmation
--  produced. They are written AFTER the canonical service returns, and they
--  are the only link between this schema and the domain. Nothing here
--  duplicates what those records contain.
create table if not exists staff_agent_proposals (
  id               uuid primary key default gen_random_uuid(),
  thread_id        uuid not null references staff_agent_threads(id) on delete cascade,
  message_id       uuid not null references staff_agent_messages(id) on delete cascade,
  property_id      uuid not null references properties(id) on delete cascade,
  unit_id          uuid references units(id) on delete set null,

  --  Which EXISTING governed action this appears to be. Every value maps to a
  --  Build 1-4 canonical service; there is no agent-only action.
  intent           text not null
                     check (intent in ('initial_triage','turn_scope','work_acceptance',
                                       'work_completion','failed_final_walk',
                                       'readiness_request','correction','unclear')),

  --  The structured interpretation, as JSON. A snapshot of what was proposed,
  --  not a schema the domain reads — the domain reads its own tables.
  proposed         jsonb not null default '{}'::jsonb,

  --  What the interpretation could NOT establish. Shown to the operator
  --  before they confirm, because confirming something you were not told was
  --  uncertain is not consent.
  unknowns         text[] not null default '{}',

  --  Exactly one question when clarification is needed. Not an interview.
  clarification    text,

  status           text not null default 'proposed'
                     check (status in ('proposed','confirmed','corrected','cancelled','clarification_required')),

  --  Confirmation is its own attributed fact.
  confirmed_by_user_id uuid references users(id),
  confirmed_at         timestamptz,

  --  REFERENCES to what the canonical service created. Never copies.
  resulting_kind   text,
  resulting_id     uuid,
  resulting_summary jsonb,

  --  A correction is a NEW proposal pointing at the one it corrects. The
  --  confirmed proposal it supersedes is never edited — a confirmed proposal
  --  is immutable, because it is the record of what a human agreed to.
  corrects_id      uuid references staff_agent_proposals(id),
  correction_reason text,

  created_at       timestamptz not null default now(),

  --  A confirmed proposal must carry who confirmed it and when.
  constraint ck_sap_confirmed_is_attributed
    check (status <> 'confirmed' or (confirmed_by_user_id is not null and confirmed_at is not null)),
  --  A correction must say what it corrects and why.
  constraint ck_sap_correction_states_reason
    check (corrects_id is null or (correction_reason is not null and btrim(correction_reason) <> '')),
  --  Only a confirmed proposal may reference a canonical record. An
  --  unconfirmed proposal pointing at domain truth would mean truth was
  --  written before anybody agreed to it.
  constraint ck_sap_only_confirmed_has_result
    check (resulting_id is null or status = 'confirmed'),
  --  'unclear' can never be confirmed into anything.
  constraint ck_sap_unclear_never_confirms
    check (intent <> 'unclear' or status <> 'confirmed')
);
create index if not exists idx_sap_thread on staff_agent_proposals(thread_id, created_at desc);
create index if not exists idx_sap_message on staff_agent_proposals(message_id);
create index if not exists idx_sap_corrects on staff_agent_proposals(corrects_id) where corrects_id is not null;

--  ONE CONFIRMATION PER PROPOSAL, enforced structurally. A duplicate confirm —
--  a double tap, a retried request, a flaky connection — must not invoke the
--  canonical service twice and create the work twice. The partial unique index
--  makes the second write lose rather than duplicate.
create unique index if not exists uq_sap_one_confirmation
  on staff_agent_proposals(id) where status = 'confirmed';

-- ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────
--
--  No findings table. No required-work table. No obligations. No work status.
--  No readiness state. No ownership. No due commitments. No proof records.
--
--  The staff agent is a capture and interpretation layer. One operating action
--  means the same thing whether it came through the structured door or the
--  conversation, because both call the same service and write the same rows.
