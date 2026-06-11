-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 018 — THE EXPLANATION RUNG
--
--  The compare layer (016/017) produces verdicts; tonight's Tower run
--  proved the verdicts are right but mute — every "unexplained" line had
--  a real, nameable reason that lived only in conversation. This table
--  makes explanations FIRST-CLASS: signed by a human, carrying evidence,
--  reducing the residual exposure only because someone attested to them.
--
--  The ladder grows one rung:
--    claim → vendor proof → category proof → comparison verdict
--          → EXPLANATION (named, signed, receipted)
--
--  Hard rules encoded:
--    • amount > 0 — explanations are GROSS contributions to a gap;
--      directionality lives in the note/evidence, never in sign games.
--    • created_by_person_id NOT NULL — no anonymous explanations. The
--      attestation IS the product.
--    • kind vocabulary is APP-LAYER (007 §1b precedent) — the list of
--      explanation kinds can evolve without a migration.
--    • Explanations never delete or alter compare data; they sit beside
--      it. Residual exposure = |variance| − attested explanations,
--      floored at zero, computed at read time — never stored.
--
--  Run AFTER 017. Idempotent.
-- ════════════════════════════════════════════════════════════════════

create table if not exists variance_explanations (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references properties(id),
  month                date not null,              -- first of month
  report_section       text not null,
  report_line          text not null,
  kind                 text not null,              -- app-layer vocabulary (explain.js KINDS)
  amount               numeric(14,2) not null,
  note                 text,
  evidence             jsonb,                      -- statements, invoice ids, check numbers…
  created_by_person_id uuid not null,
  created_at           timestamptz not null default now(),
  constraint variance_explanations_amount_gross check (amount > 0)
);

-- the read pattern: all explanations for a property-month line
create index if not exists ix_var_expl_line
  on variance_explanations (property_id, month, report_section, report_line);
