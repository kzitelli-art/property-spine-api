-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 065 — OFF-GUARDRAIL INCIDENTS + REVIEW IDEMPOTENCY
--  (Commitment Ledger guardrail rev 2 — charter corrections #3 and #4)
--
--  THE SYMMETRY THIS COMPLETES (the anti-Mark rule in both modes):
--    SOFT records the promise as a valid offer + a review trail.
--    HARD blocks the binding offer but RECORDS the promise as an
--    incident needing resolution. Neither mode ever loses what was
--    actually said.
--
--  An agent can speak a promise on a tour before touching the capture
--  screen. If a hard block stored nothing, Spine would recreate the old
--  software failure: reality happened, the system has no record. So a
--  hard block creates a durable, attributable INCIDENT — what was said,
--  by whom, to whom, where and when, the proposed value, the evidence —
--  plus an open resolution obligation (retract | correct | approve |
--  replace) routed to the authority level. The incident NEVER enters
--  the Forward Rent Roll and NEVER creates lease economics. It exists
--  so management resolves the real-world promise instead of
--  discovering it later.
--
--  REVIEW IDEMPOTENCY (correction #4): one soft-over-threshold review
--  obligation per source offer, enforced by a partial unique index —
--  a countersign retry, repeated HTTP request, or replay cannot mint
--  three owner-review obligations for one promise. (The module also
--  checks in-transaction; this index is the belt under the suspenders.)
--
--  IDEMPOTENT. migrate.js owns the transaction — no BEGIN/COMMIT.
-- ════════════════════════════════════════════════════════════════════

create table if not exists concession_incidents (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  person_id             uuid references persons(id) on delete set null,  -- the prospect told
  -- WHO made / attempted the promise (attributable, always)
  spoken_by_person_id   uuid not null references persons(id),
  -- WHO captured it in Spine (may equal spoken_by)
  recorded_by_person_id uuid references persons(id),

  -- WHAT was promised / attempted — the same snapshot vocabulary offers
  -- use, so a later 'approve' resolution can reissue faithfully.
  proposed_terms        jsonb not null,
  proposed_value        numeric(14,2) not null check (proposed_value >= 0),  -- D12-computed
  guardrail_mode        text not null check (guardrail_mode in ('hard','none')),
                        -- 'none' = no grant existed at all (fail-closed hard)
  why                   text,          -- the plain-language out-of-scope reason

  -- WHERE/WHEN — same evidence model as offers; nullable because a
  -- blocked write may be an ATTEMPT the prospect never heard.
  communicated_at       timestamptz,
  recorded_at           timestamptz not null default now(),
  evidence_type         text check (evidence_type in
                          ('dispatched_message','tour_host_attestation','follow_up_dispatch')),
  evidence_ref          text,
  source_tour_id        uuid,

  -- THE LOOP: open until a human resolves it, backed by an obligation.
  status                text not null default 'open'
                        check (status in ('open','resolved')),
  resolution            text check (resolution in ('retract','correct','approve','replace')),
  resolution_note       text,
  resolved_by_person_id uuid references persons(id),
  resolved_at           timestamptz,
  constraint ck_incident_resolved_whole
    check ( (status = 'open' and resolution is null)
         or (status = 'resolved' and resolution is not null and resolved_by_person_id is not null) ),

  source_event_id       uuid references events(id) on delete set null,
  obligation_id         uuid references obligations(id) on delete set null,
  -- #3 IDEMPOTENCY KEY: {evidence_ref}::{concession signature}. One durable
  -- incident per communicated promise shape — a double-submit / retry / replay
  -- cannot mint duplicates. Nullable (a signature is only computed for
  -- communicated hard blocks); the unique index below is partial on non-null.
  dedupe_key            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_concession_incidents_property_open
  on concession_incidents (property_id, recorded_at desc)
  where status = 'open';
create index if not exists idx_concession_incidents_spoken_by
  on concession_incidents (spoken_by_person_id);
create unique index if not exists uq_concession_incident_dedupe
  on concession_incidents (dedupe_key)
  where dedupe_key is not null;

-- one concession_review obligation per source offer — durable idempotency
create unique index if not exists uq_obl_concession_review_per_offer
  on obligations (related_id)
  where type = 'concession_review' and related_type = 'lease_offer';
