-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 066 — INCIDENT DEDUPE DELTA  (CONDITIONAL — use ONLY if the
--  earlier 065 already ran on a shared / non-disposable environment)
--
--  A tracked migration will not re-run because its file changed. So if an
--  earlier 065 (without dedupe_key) already applied to a ledger that
--  matters, do NOT edit or re-apply 065 — apply THIS instead. It carries
--  ONLY the delta that the revised 065 adds.
--
--  If you deploy the revised 065 to a fresh target (recommended, matches
--  current live at ceiling 061), do NOT also apply this — you'd be doing
--  the same work twice. Use exactly one path: revised-065 OR 066.
--
--  IDEMPOTENT. migrate.js owns the transaction — no BEGIN/COMMIT.
-- ════════════════════════════════════════════════════════════════════

alter table concession_incidents add column if not exists dedupe_key text;

create unique index if not exists uq_concession_incident_dedupe
  on concession_incidents (dedupe_key)
  where dedupe_key is not null;
