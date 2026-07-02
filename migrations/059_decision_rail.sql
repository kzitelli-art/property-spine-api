-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 059 — THE DECISION RAIL (money decisions become claims)
--
--  THE GAP THIS CLOSES (long-confirmed): rent forgiveness, ledger
--  write-offs, waivers (the hotel), and CapEx recategorization are the
--  biggest unstructured money events — today they live in Teams chats
--  with no trail, no gate, no proof. This table makes each one a
--  first-class captured decision that runs through the obligation
--  engine, so a decision-shaped hole can never quietly become furniture.
--
--  THE TWO-BAND MODEL (v0, deliberately small):
--    • amount ≤ decider's own approval_cap (their active assignment on
--      this property, from 004) → ACT-THEN-REVIEW: the decision is
--      recorded and CLOSED in one stroke, witnessed by a durable event.
--      Authority was already granted; Spine records, it does not nag.
--    • amount > cap (or the decider has NO cap — fail-closed) →
--      CLEAR-AND-PASS: state = pending_grant, and spawnObligationFromEvent
--      routes an obligation to the escalation target (the decider's
--      escalates_to assignment's role, else 'owner'). The grant or the
--      deny — by someone whose cap covers it, or the owner — closes it.
--      Denial IS a decision; the loop closes either way.
--
--  AUTHORITY LIVES ON THE ASSIGNMENT, NOT IN A NEW POLICY TABLE.
--  004 already gave assignments approval_cap + escalates_to_assignment_id
--  — the authority graph exists. This rail READS it. Setting anyone's
--  authority is one SQL update, no new surface. NULL cap = zero cap:
--  no explicitly granted authority means nothing closes quietly
--  (honest blank beats confident wrong).
--
--  AMOUNTS: numeric(14,2) dollars — the platform convention (036 charges,
--  004 caps). Never cents here.
--
--  IDEMPOTENT: create-if-not-exists throughout; re-running is a no-op.
--  migrate.js owns the transaction — no BEGIN/COMMIT and no ledger
--  insert in this file.
-- ════════════════════════════════════════════════════════════════════

create table if not exists decision_cases (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,

  -- the SUBJECT of the decision (the tenant being forgiven) — nullable:
  -- a CapEx recat has no person.
  person_id             uuid references persons(id) on delete set null,

  -- what the decision is about, same loose polymorphic link the
  -- obligations table uses (lease | charge | work_order | ...).
  related_id            uuid,
  related_type          text,

  type                  text not null
                        check (type in ('rent_forgiveness','writeoff','waiver','capex_recat')),
  amount                numeric(14,2) not null check (amount > 0),

  -- WHY — a small fixed vocabulary so patterns are queryable, with an
  -- escape hatch that must carry words. 'other' without a note is
  -- rejected in the module (belt) and here (suspenders).
  reason_code           text not null
                        check (reason_code in
                          ('hardship','service_failure','error_correction',
                           'retention','legal','other')),
  note                  text,
  constraint ck_decision_other_needs_note
    check (reason_code <> 'other' or (note is not null and length(trim(note)) > 0)),

  -- THE LOOP STATE. closed_recorded is the within-authority one-stroke
  -- close. pending_grant is the open loop that CANNOT linger silently —
  -- it is backed by an open obligation. granted/denied are the two ways
  -- the escalated loop closes; both are decisions.
  state                 text not null default 'pending_grant'
                        check (state in ('closed_recorded','pending_grant','granted','denied')),

  -- WHO decided (the actor, always a real person — money.js convention),
  -- and who resolved the escalation if there was one.
  decided_by_person_id  uuid not null references persons(id),
  decided_at            timestamptz not null default now(),
  resolved_by_person_id uuid references persons(id),
  resolved_at           timestamptz,
  resolution_note       text,

  -- the wiring: the witness/source event, and (escalated only) the
  -- obligation that keeps the loop visibly open until grant/deny.
  source_event_id       uuid references events(id) on delete set null,
  obligation_id         uuid references obligations(id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- the reads this rail serves: "what is pending on this property" (the
-- inbox) and "the decision history of this property".
create index if not exists idx_decision_cases_property_state
  on decision_cases (property_id, state);
create index if not exists idx_decision_cases_pending
  on decision_cases (property_id, decided_at desc)
  where state = 'pending_grant';
create index if not exists idx_decision_cases_person
  on decision_cases (person_id)
  where person_id is not null;
