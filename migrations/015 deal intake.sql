-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 015 — DEAL INTAKE (the onboarding front door, batch edition)
--
--  One door: drop a messy acquisition / takeover folder, the system
--  classifies what arrived, resolves identity (read-only), and reports
--  found / missing / confidence. It is a SHELL around existing machinery:
--    • extraction of rent-roll facts  → existing ingest_runs/ingest_candidates
--    • identity                       → existing property_aliases registry
--    • tasks                          → existing obligation engine (later)
--  Nothing here duplicates those. These tables only remember WHAT WAS
--  UPLOADED, WHAT WE THINK EACH FILE IS, and WHAT THE HUMAN CORRECTED.
--
--  Corrections are CAPTURED AS DATA (corrected_document_type) — the system
--  does NOT change its own classification behavior from them. Learning is a
--  future rung with its own gate.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  ledger row. NO transaction control, NO ledger insert here. Conventions
--  match 001/009/010/011 (uuid pk, timestamptz, CHECK vocab, gen_random_uuid).
-- ════════════════════════════════════════════════════════════════════

create table if not exists deal_intakes (
  id              uuid primary key default gen_random_uuid(),
  onboarding_type text not null check (onboarding_type in
                    ('new_acquisition','existing_asset','management_takeover')),
  status          text not null default 'created' check (status in
                    ('created','files_received','classified')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists deal_intake_files (
  id                       uuid primary key default gen_random_uuid(),
  intake_id                uuid not null references deal_intakes(id),
  original_filename        text not null,
  relative_path            text,            -- folder path if the browser sent one
  mime_type                text,
  size_bytes               bigint,

  -- classification: what the system thinks, how it decided, what a human said
  detected_document_type   text not null default 'unknown',
  corrected_document_type  text,            -- capture-only; null = never corrected
  source_category          text not null default 'unknown' check (source_category in
                             ('seller_material','buyer_workpaper','third_party_report',
                              'closing_legal','operating_setup','unknown')),
  classification_basis     text,            -- 'filename' | 'path' | 'model' | 'human'

  -- identity (read-only resolve; the glance never mutates state)
  identity_label           text,            -- property string found in the doc header
  registry_status          text,            -- 'resolved' | 'ambiguous' | 'unknown' | 'no_identity_found'
  registry_property_id     uuid references properties(id),

  -- text content. FULL text kept only for tabular/financial types that feed
  -- downstream extraction (rent roll, T12, operating stmt, bank stmt); an
  -- excerpt for everything else. Binary bytes are NOT stored in v1.
  text_excerpt             text,
  extracted_text           text,

  -- if this file was handed into the real ingest pipeline, the receipt:
  ingest_run_id            uuid,

  created_at               timestamptz not null default now()
);

create index if not exists deal_intake_files_intake_idx
  on deal_intake_files (intake_id);
