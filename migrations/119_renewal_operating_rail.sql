-- ════════════════════════════════════════════════════════════════════
--  119 — RENEWAL OPERATING RAIL  (SLICE 6)
--
--  Turns Renewals from a read-only expiration cohort (renewals_read.js R1)
--  into a complete operating rail: accountable owner → governed economics →
--  offer → resident decision → execution.
--
--  ── WHAT THIS IS NOT ────────────────────────────────────────────────
--  Not pricing governance. Not a renewal PRICE. Slice 6 DISPLAYS existing
--  governed economics and routes to Market & Pricing to set them; it never
--  authors a renewal rent (Slice 8 owns governed renewal economics). No
--  survey, listing, demand evidence, or cross-domain ranking here.
--
--  ── ONE OWNERSHIP MACHINE, NOT TWO ──────────────────────────────────
--  Renewal ownership, assignment, due, and escalation reuse the canonical
--  `obligations` table (module='leasing', type='renewal_decision',
--  related_type='renewal'). We do NOT invent a second assignment/owner
--  field on renewal_cases: the audit's UNASSIGNED constant is replaced by a
--  REAL obligation, or by honest UNASSIGNED when no owner is eligible —
--  the same rail every other domain uses.
--
--  ── ONE OFFER MACHINE, NOT TWO ──────────────────────────────────────
--  Renewal offers reuse `lease_offers` with scope='renewal'. No second
--  offers table. offer_status / offer_sent_at / offer_expires_at come from
--  there.
--
--  ── renewal_cases IS APPEND-ONLY AND SUPERSEDABLE ───────────────────
--  A renewal's operating state (stage, resident decision, notice) is
--  recorded as a NEW row that supersedes the prior one, the same rail as
--  unit_triage_confirmations and the governed-charge ruling history. A
--  correction never mutates history; it points at what it replaces. The
--  ACTIVE case for a position is the latest non-superseded row.
--
--  ── STAGE / STATE ARE SERVER-AUTHORED VOCABULARIES ──────────────────
--  Only values with a real authoring site are emitted. NULL stays NULL:
--  a case with no recorded decision is `decision_status=NULL`, never a
--  guessed "pending". Silence is not a decision.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) RENEWAL CASE: the operating record for one expiring position ──
--
--  Keyed by the CURRENT lease + space. Append-only: the active case is the
--  latest row where superseded_by is null. It carries only what the shared
--  positional derivation (space_position) does NOT already own: the renewal
--  WORK lifecycle — stage, resident decision, notice acknowledgement, and
--  the link to the obligation that carries ownership + due.
create table if not exists renewal_cases (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  current_lease_id      uuid not null references leases(id) on delete cascade,
  space_id              uuid not null references spaces(id) on delete restrict,
  person_id             uuid,                    -- resident; null ⇒ "Resident not linked"

  -- SERVER-AUTHORED LIFECYCLE STAGE. One of the recommended machine stages;
  -- never inferred by the browser. NULL is not allowed — a case exists
  -- because a stage was authored.
  renewal_stage         text not null
    check (renewal_stage in ('approaching','decision_required','offer_preparation',
                             'offer_sent','resident_decision','execution')),

  -- OPERATING STATE. What the work is doing right now.
  operating_state       text not null default 'available'
    check (operating_state in ('available','waiting','blocked','complete')),

  -- WHO WE ARE WAITING ON. Only when operating_state='waiting'. NULL otherwise.
  waiting_on            text
    check (waiting_on is null or waiting_on in ('resident','staff','external_evidence')),

  -- WHY IT IS BLOCKED. Only when operating_state='blocked'. A real code with
  -- a real cause (e.g. 'no_governed_economics'). NULL otherwise.
  blocker_code          text,

  -- RESIDENT DECISION. NULL until the resident actually responds. Silence is
  -- never a decision.
  decision_status       text
    check (decision_status is null or decision_status in
           ('accepted','declined','counter_requested','notice_received')),
  decision_recorded_at  timestamptz,

  -- NOTICE. Distinct from the shared notice_state derivation: this is the
  -- renewal desk's acknowledgement that notice was RECORDED here, with who
  -- and when. The positional truth still comes from the governed unit_event.
  notice_status         text
    check (notice_status is null or notice_status in ('none','notice_received')),

  -- TERMINAL EXIT. A case leaves active work only through a server-authored
  -- terminal state. NULL ⇒ still active.
  terminal_state        text
    check (terminal_state is null or terminal_state in
           ('executed','declined','notice_received','moved_to_turnover','closed')),
  terminal_at           timestamptz,

  -- LINKS to the canonical machines that own ownership/offer.
  obligation_id         uuid references obligations(id) on delete set null,
  renewal_lease_id      uuid references leases(id) on delete set null,   -- successor once executed

  -- APPEND-ONLY SUPERSESSION.
  superseded_by         uuid references renewal_cases(id) on delete set null,
  authored_by_user_id   uuid,
  source_event_id       uuid references events(id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- The active case per position: latest non-superseded row. A partial unique
-- index keeps at most ONE active case per current lease.
create unique index if not exists uq_renewal_case_active
  on renewal_cases (current_lease_id)
  where superseded_by is null and terminal_state is null;

create index if not exists idx_renewal_cases_property on renewal_cases(property_id);
create index if not exists idx_renewal_cases_space    on renewal_cases(space_id);
create index if not exists idx_renewal_cases_active
  on renewal_cases(property_id) where superseded_by is null and terminal_state is null;

comment on table renewal_cases is
  'Append-only operating record for a renewal. Active = latest row with superseded_by IS NULL and terminal_state IS NULL. Ownership/due come from the linked obligation; offer from lease_offers scope=renewal; positional truth from space_position. Slice 6.';

-- ── 2) LEASE_OFFERS: recognise the renewal scope ────────────────────
--
--  lease_offers already carries scope/status/expires_at/decision_case_id.
--  This documents 'renewal' as a first-class scope value used by the rail.
--  No new column needed. (scope is a free-text column today; we do not add a
--  CHECK that would reject historical values.)
comment on column lease_offers.scope is
  'Offer scope: new-lease application, or ''renewal'' for a renewal offer (Slice 6 renewal rail). Renewal offers link back via renewal_cases.';

-- ── 3) EVENTS: renewal lifecycle events have a home ─────────────────
--  Renewal transitions record an event (for source_event_id + history), the
--  same as move-out/turnover. events.type is free text; no enum to extend.
--  Documented here so the vocabulary is discoverable:
--    'renewal_case_opened', 'renewal_owner_assigned', 'renewal_offer_prepared',
--    'renewal_offer_sent', 'renewal_decision_recorded', 'renewal_executed'.
