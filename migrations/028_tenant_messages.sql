-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 028 — TENANT MESSAGE LOOP (Phase 2+3 of the text line,
--  browser door)
--
--  The rule this rung enforces: A MESSAGE CAN NEVER SILENTLY DISAPPEAR.
--  Every inbound tenant message is saved BEFORE classification, then the
--  system either acts (work order, live balance answer) or honestly
--  queues it for a human — and the inbox shows what happened to every
--  single message. Classification failure degrades to needs_human, never
--  to a lost message.
--
--  comm_events (baseline 001, threaded by 027) becomes the full message
--  store. Four columns record what the system DID with each message:
--
--    classification       — maintenance|balance|document|lease_question|
--                           emergency|general|unknown|human_review
--    created_object_type  — work_order|balance_inquiry|null
--    created_object_id    — the work order id when one was opened
--    needs_human          — the honest queue flag; emergencies and
--                           sensitive topics ALWAYS set it
--
--  The AI suggests and drafts. It opens work orders (reversible operating
--  objects, always needs_pm_review). It NEVER books money events.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records
--  the ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════

alter table comm_events
  add column if not exists classification text,
  add column if not exists created_object_type text,
  add column if not exists created_object_id uuid,
  add column if not exists needs_human boolean not null default false;

create index if not exists idx_comm_needs_human
  on comm_events(property_id, needs_human) where needs_human = true;

-- ── DRIFT FIX (found during this build, Jun 11 2026) ──────────────────
-- maintenance.js inserts these columns, but no migration in the repo ever
-- added them — they exist in Neon only because maintenance_schema.sql was
-- run there directly, pre-migration-discipline. On the live DB every one
-- of these is a no-op; on a fresh DB this makes the repo finally reproduce
-- the real work_orders shape. Defaults mirror maintenance.js expectations.
alter table work_orders
  add column if not exists field_category text,
  add column if not exists operating_category text,
  add column if not exists gl_category text,
  add column if not exists unit_state text,
  add column if not exists cause text,
  add column if not exists is_emergency boolean not null default false,
  add column if not exists is_capex boolean not null default false,
  add column if not exists billback boolean not null default false,
  add column if not exists est_cost numeric,
  add column if not exists needs_pm_review boolean not null default false;
