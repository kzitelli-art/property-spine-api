-- 086_operational_escalation_idempotency.sql
-- Slice 1 (ESCALATE move): make each operational-escalation obligation idempotent
-- WITHOUT letting the database collapse two DIFFERENT staff tasks into one.
--
-- An inbound may legitimately request MORE THAN ONE piece of staff work
-- (e.g. "confirm Sunday readiness AND check parking") — those are two distinct
-- obligations and must both be written. So the dedupe key is NOT (source_event_id,
-- type): that would wrongly treat the second task as a replay of the first.
--
-- Instead each operational_escalation row carries a stable `dedupe_key` =
-- sha256(inbound_comm_event_id + ':' + normalized_reason). Same inbound + same
-- task → same key → convergence (idempotent replay / concurrent-double loser
-- raises 23505, resolved to the existing row). Same inbound + DIFFERENT task →
-- different key → a second, distinct obligation, exactly as intended.
--
-- PARTIAL and scoped: the column and its unique index apply only where
-- dedupe_key is present (operational_escalation writes set it; nothing else does),
-- so this cannot affect any other obligation type or any existing row. Additive.

ALTER TABLE obligations ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_obligations_operational_escalation_dedupe
  ON obligations (dedupe_key)
  WHERE type = 'operational_escalation' AND dedupe_key IS NOT NULL;
