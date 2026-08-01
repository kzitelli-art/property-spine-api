-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 121 — GOVERNED ECONOMICS: REASON, LINEAGE, STACKING
--
--  Slice 8, steps 2–3. Additive only. Nothing here changes an existing
--  row's meaning, and nothing retroactively alters signed or executed
--  economics — the spec forbids it and the lineage columns are NULL for
--  every row that predates governed publication, which is the honest
--  answer for terms that genuinely did not come from a governed sheet.
--
--  WHAT THIS CLOSES (see docs/slices-6-to-10/SLICE_8_ECONOMIC_AUTHORITY_AUDIT.md)
--
--   1. REASON — property_pricing_versions carried only a free-text `note`.
--      The spec asks for a structured reason_code + reason_note so a
--      pricing decision can be read by a machine and reported on, not
--      just squinted at.
--
--   2. LINEAGE — lease_offers was the ONLY downstream table carrying
--      source_pricing_version_id. Lineage died at the offer: a confirmed
--      application term and an executed lease rent could not prove which
--      governed sheet produced them. These columns are that proof.
--
--   3. STACKING — the spec says the server enforces stacking rules and
--      forbids silent stacking, but no column expressed a stacking rule
--      at all. Default 'exclusive' is deliberately the conservative
--      reading: nothing stacks today (concession application was never
--      implemented), so defaulting to exclusive preserves current
--      behaviour exactly and permits nothing new.
--
--  IDEMPOTENT: add-column-if-not-exists throughout; migrate.js owns the
--  transaction — no BEGIN/COMMIT here.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. STRUCTURED REASON ON A PRICING DECISION ──────────────────────
alter table property_pricing_versions add column if not exists reason_code text;
alter table property_pricing_versions add column if not exists reason_note text;

alter table property_pricing_versions drop constraint if exists ck_ppv_reason_code;
alter table property_pricing_versions add constraint ck_ppv_reason_code
  check (reason_code is null or reason_code in
    ('lease_up','market_adjustment','seasonal','renewal_strategy',
     'concession_change','correction','other'));

-- 'other' explains nothing on its own. Same rule as 054/059.
alter table property_pricing_versions drop constraint if exists ck_ppv_reason_other_needs_note;
alter table property_pricing_versions add constraint ck_ppv_reason_other_needs_note
  check (reason_code is distinct from 'other' or reason_note is not null);

-- ── 2. DOWNSTREAM LINEAGE TO THE GOVERNED SHEET ─────────────────────
--  NULL is meaningful and permanent for pre-governance rows: "this term
--  did not come from a governed pricing version." It must never be
--  back-filled with a guess.
alter table application_proposed_terms_confirmations
  add column if not exists pricing_version_id uuid
  references property_pricing_versions(id);

alter table executed_lease_records
  add column if not exists pricing_version_id uuid
  references property_pricing_versions(id);

create index if not exists idx_aptc_pricing_version
  on application_proposed_terms_confirmations (pricing_version_id)
  where pricing_version_id is not null;

create index if not exists idx_elr_pricing_version
  on executed_lease_records (pricing_version_id)
  where pricing_version_id is not null;

-- ── 3. CONCESSION STACKING + SUPERSESSION ───────────────────────────
alter table concession_policies
  add column if not exists stacking_rule text not null default 'exclusive';

alter table concession_policies drop constraint if exists ck_concession_stacking_rule;
alter table concession_policies add constraint ck_concession_stacking_rule
  check (stacking_rule in ('exclusive','stackable'));

alter table concession_policies
  add column if not exists supersedes_concession_id uuid
  references concession_policies(id);

alter table concession_policies drop constraint if exists ck_concession_not_self_superseding;
alter table concession_policies add constraint ck_concession_not_self_superseding
  check (supersedes_concession_id is null or supersedes_concession_id <> id);

alter table concession_policies add column if not exists reason_code text;
alter table concession_policies add column if not exists reason_note text;

alter table concession_policies drop constraint if exists ck_concession_reason_code;
alter table concession_policies add constraint ck_concession_reason_code
  check (reason_code is null or reason_code in
    ('lease_up','market_adjustment','seasonal','renewal_strategy',
     'competitive_response','correction','other'));

alter table concession_policies drop constraint if exists ck_concession_reason_other_needs_note;
alter table concession_policies add constraint ck_concession_reason_other_needs_note
  check (reason_code is distinct from 'other' or reason_note is not null);
