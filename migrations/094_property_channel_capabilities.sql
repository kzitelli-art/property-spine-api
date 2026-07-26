-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 094 — PROPERTY CHANNEL CAPABILITIES (operating authority)
--
--  Additive. ONE new table. No existing table, column, constraint, index
--  or row is touched. Nothing is seeded. Zero properties gain any
--  capability by running this file.
--
--  WHY: Fable ruling 2026-07-25 (FABLE-RULING-PRODUCTION-CLASSIFICATION):
--    "AGENT_AUTO_DISPATCH_PROPERTY_IDS is an acceptable deployment safety
--     switch. It is NOT sufficient as the source of operating authority."
--  Today a property's right to communicate is inferred from two accidents:
--  whether properties.sms_number happens to be non-null, and whether the
--  property id happens to appear in an environment variable. Neither is a
--  durable, attributed record; neither can say WHO activated it, WHEN,
--  under WHICH policy text, or FOR WHICH purpose. This file adds the
--  record. It does not yet gate anything — see THE DELIBERATE OMISSION.
--
--  FIVE CAPABILITIES, KEPT SEPARATE — Fable was explicit that a single
--  vague `sms_active` flag must not authorize everything:
--    receive_inbound            the property may ACCEPT inbound SMS
--    send_customer_care_human   a human may reply
--    send_ai_assisted_approved  AI drafts, a human approves and sends
--    send_ai_autodispatch       AI sends with NO human   ← own activation
--    send_marketing             promotional outbound     ← never implied
--  Being allowed to answer a question is not permission to let the AI
--  talk unsupervised, and neither is permission to market.
--
--  ── THE DELIBERATE OMISSION — READ THIS BEFORE "FINISHING" THE SLICE ──
--  This migration does NOT wire the capability check into
--  canSendSmsForRecord, and that is a decision, not an oversight.
--
--  The gate is fail-closed by design: absence of a capability row MUST
--  mean refusal. But no property holds a row the moment this runs, so
--  enforcing today would instantly refuse every send at Demo Building —
--  which is currently sending successfully (167 accepted comm_events).
--  That is a live outage of the only working demo, caused by a migration.
--
--  The obvious escape — seed Demo Building's current capabilities so
--  nothing breaks — is worse, for two independent reasons:
--    1. A seeded row needs an activated_by_user_id. A migration has no
--       human actor. Inventing one is the EXACT defect removed earlier
--       the same day, when the legacy /agent/ routes were deleted for
--       stamping a seeded "Demo Leasing Manager" as a human approver.
--       Honest blank beats confident wrong (§5) applies to activation
--       records too.
--    2. Fable ruled in the same document that Demo Building must NEVER
--       become a production property. Seeding it a production send
--       capability would contradict that ruling in the migration that
--       exists to implement it.
--  So: the table ships, the canonical reader ships (propertyHasCapability
--  in communications_boundary.js), and the AND-clause in the gate waits
--  for a DELIBERATE human activation of a chosen property. That activation
--  is an owner action with a real actor id, not a migration.
--
--  ACTIVATION CONDITION for wiring the gate: the first time a real
--  property is activated by a named human. At that moment the check goes
--  into canSendSmsForRecord above the classification check, refusing with
--  `property_not_activated_for_purpose`. Storage deliberately ahead of its
--  enforcement, with a named trigger — not built-but-dormant drift.
--
--  SAFETY CONTRACT — there is no staging; merging this EXECUTES it:
--    · CREATE TABLE IF NOT EXISTS only. No ALTER of anything existing.
--    · No INSERT. No backfill. No seed. The table is born empty.
--    · Nothing in the repo reads this table in a decision path yet, so
--      OLD CODE against NEW SCHEMA is trivially safe, and a code-only
--      rollback leaves an unread empty table behind.
--    · FK to properties uses ON DELETE CASCADE, matching the existing
--      convention ("dehydrate, not delete" — deletion is not deliberate
--      here yet). FK to users is ON DELETE SET NULL: losing the user must
--      never erase the fact that an activation happened.
--
--  KNOWN CONSUMERS THAT MUST STAY GREEN: none. This table has no reader
--  in any decision path as of 094. The only reader is the new
--  propertyHasCapability() helper, which is exported and harness-tested
--  but not yet called by the gate.
-- ════════════════════════════════════════════════════════════════════

create table if not exists property_channel_capabilities (
  id                   uuid primary key default gen_random_uuid(),

  -- PROPERTY-SCOPED, never organization-scoped (Fable §4: "the property
  -- remains the activation and relationship boundary"). Migration 093's
  -- organizations layer may later supply POLICY DEFAULTS; it does not own
  -- activation, and the first correct property activation must not be
  -- blocked waiting for it.
  property_id          uuid not null references properties(id) on delete cascade,

  -- 'sms' today. The column exists so the next channel is a row, not a
  -- migration.
  channel              text not null,

  -- one of the five. Deliberately NOT a single boolean.
  capability           text not null,

  status               text not null default 'active',

  -- the exact line this capability was granted against. If the property's
  -- number changes, the old capability does not silently transfer.
  provisioned_line     text,

  -- which consent/policy text was in force at activation. Consent language
  -- is reviewed by counsel and will change; a grant must remember which
  -- version it was made under.
  policy_version       text,

  activated_at         timestamptz not null default now(),

  -- NULLABLE ON PURPOSE. A null actor is an honest blank, and the
  -- accompanying activation_note must say why (e.g. a governed import).
  -- It is never to be filled with a convenient seeded user.
  activated_by_user_id uuid references users(id) on delete set null,
  activation_note      text,

  deactivated_at       timestamptz,
  deactivation_reason  text,

  created_at           timestamptz not null default now(),

  -- vocabulary is closed and narrow; widening it is a later, deliberate act
  constraint pcc_channel_known
    check (channel in ('sms')),
  constraint pcc_capability_known
    check (capability in (
      'receive_inbound',
      'send_customer_care_human',
      'send_ai_assisted_approved',
      'send_ai_autodispatch',
      'send_marketing')),
  constraint pcc_status_known
    check (status in ('active','suspended','revoked')),

  -- an ended capability must not still claim to be active, and an active
  -- one must not carry an end date. The record cannot contradict itself.
  constraint pcc_deactivation_coherent
    check (
      (status = 'active'  and deactivated_at is null and deactivation_reason is null)
      or
      (status in ('suspended','revoked') and deactivated_at is not null)
    ),

  -- a null actor must be explained; an unexplained anonymous grant is
  -- exactly the confident-wrong this table exists to prevent
  constraint pcc_actor_or_reason
    check (activated_by_user_id is not null or activation_note is not null)
);

-- AT MOST ONE ACTIVE grant per (property, channel, capability). Suspended
-- and revoked rows accumulate as history — the partial index is what makes
-- the table append-friendly without letting two live grants disagree.
create unique index if not exists pcc_one_active_per_capability
  on property_channel_capabilities (property_id, channel, capability)
  where status = 'active';

-- the hot read: "may THIS property do THIS thing right now?"
create index if not exists pcc_lookup
  on property_channel_capabilities (property_id, channel, capability, status);

-- history reads for a property, newest first
create index if not exists pcc_property_history
  on property_channel_capabilities (property_id, activated_at desc);

comment on table property_channel_capabilities is
  'Durable, attributed operating authority per property x channel x capability (Fable ruling 2026-07-25). Absence of an active row means REFUSAL. Not seeded; every row is a deliberate human activation.';
