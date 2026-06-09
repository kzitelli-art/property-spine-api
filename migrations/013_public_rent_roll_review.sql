-- 013_public_rent_roll_review.sql
-- PUBLIC RENT-ROLL REVIEW — training/correction capture, fully isolated.
--
-- THE WALL (why these tables look the way they do):
--   These tables intentionally have NO foreign key to properties and NO link to
--   ingest_candidates. A public uploader has no property. Public uploads CANNOT
--   create candidates, CANNOT promote, CANNOT touch supported revenue. The only
--   thing that ever crosses into live parsing is mapping_memory, and it crosses
--   as a SUGGESTION the live parser may consult — never as a promotion.
--
--   This is structural, not policy: there is no column here that could be wired
--   to the promotion path by accident, because none of these rows reference a
--   real property or a real unit.
--
-- migrate.js applies this after 012. The file carries NO begin/commit and NO
-- ledger insert (the runner records the migration itself).

-- ── 1. UPLOAD SESSIONS — one row per public upload + its raw extraction ──
create table if not exists public_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  uploader_name text,                 -- optional, preferred
  uploader_email text,                -- optional, preferred
  source_filename text,
  detected_system text,               -- the parser's source-system guess
  format_signature text,              -- header fingerprint (for mapping memory)
  level_reached text,                 -- deepest level the extractor reached
  raw_extraction jsonb,               -- the full parser output (rows, mappings, prov)
  extracted_row_count integer default 0,
  created_at timestamptz not null default now()
);

create index if not exists ix_public_sessions_created_at
  on public_upload_sessions(created_at desc);
create index if not exists ix_public_sessions_signature
  on public_upload_sessions(format_signature);

-- ── 2. FEEDBACK — the uploader's grade + corrections for a session ──
create table if not exists public_rent_roll_feedback (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public_upload_sessions(id) on delete cascade,
  rating text,                        -- 'accurate' | 'partial' | 'wrong'
  corrected_mappings jsonb,           -- { source_column -> canonical_field } the human fixed
  corrected_rows jsonb,               -- per-row corrections: rent/unit/bed/tenant/status/lease_date/rent_type
  notes text,
  created_at timestamptz not null default now(),
  constraint public_feedback_rating_ck
    check (rating is null or rating in ('accurate','partial','wrong'))
);

create index if not exists ix_public_feedback_session
  on public_rent_roll_feedback(session_id);

-- ── 3. MAPPING MEMORY — the only table that may inform live parsing ──
-- A learned (format_signature, source_column) -> canonical_field mapping.
-- corrected_by_human distinguishes a real human correction (high trust) from an
-- auto-inferred pattern (low trust). times_seen counts reinforcement.
-- NOTE: nothing here promotes revenue. A mapping is an assumption; assumptions
-- are held-out by the revenue rule. This table only helps the parser GUESS the
-- column layout faster / flag suspicious columns — never to mark rent supported.
create table if not exists mapping_memory (
  id uuid primary key default gen_random_uuid(),
  format_signature text not null,     -- which file shape this applies to
  source_column text not null,        -- the raw header seen in the file
  canonical_field text not null,      -- what it maps to (unit_number, market_rent, status, ...)
  corrected_by_human boolean not null default false,
  confidence numeric,                 -- 0..1, optional
  times_seen integer not null default 1,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint mapping_memory_unique
    unique (format_signature, source_column, canonical_field)
);

create index if not exists ix_mapping_memory_signature
  on mapping_memory(format_signature);
