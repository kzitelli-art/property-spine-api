-- ════════════════════════════════════════════════════════════════════
--  091_lead_source_system_bucket.sql
--
--  WHAT IS BROKEN
--  intakeProspect (src/leasing/leasingleads.js) never mints a source from
--  untrusted input. A lead whose source is missing, or whose source name is
--  not one we map, is assigned to a HOUSE BUCKET instead — 'Unattributed'
--  when the caller supplied nothing, 'Unmapped' when the caller supplied a
--  name we do not recognise. The distinction is deliberate: an unmapped tag
--  is an integration defect to go fix, whereas unattributed is genuine
--  direct demand, and folding one into the other would hide a broken feed.
--
--  The bucket is created on first use with:
--      insert into lead_sources (name, source_type) values ($1,'system')
--
--  lead_sources_source_type_check permits only
--  (ils, website, paid_ad, organic, manual). 'system' is not among them, so
--  that insert has ALWAYS failed. The savepoint catch then re-selects, finds
--  nothing, and `fb.id` throws on an undefined row — taking the whole intake
--  transaction with it. The safety net has never once caught anything, and
--  neither bucket exists in the database.
--
--  Effect today: only the eight already-seeded source names can be captured.
--  Any other name, or no name at all, fails instead of falling back.
--
--  WHY 'system' AND NOT 'manual'
--  source_type is an analytics dimension. A house bucket is not an
--  acquisition channel. Reusing 'manual' would place "we do not know where
--  this came from" beside "Walk-in" in the source report, presenting a data
--  gap as real demand — the confident-wrong this system is built to refuse
--  (PHILOSOPHY §5). A separate value keeps every future report honest and
--  lets analytics exclude house buckets explicitly rather than by name.
--
--  SAFETY
--  Widening a CHECK cannot invalidate an existing row: all 8 live
--  lead_sources rows already hold one of the five prior values, so the new
--  constraint validates instantly. The drop/add pair takes a brief
--  ACCESS EXCLUSIVE lock on an 8-row table. Idempotent: `drop constraint if
--  exists` then add, so a re-run converges. No begin/commit here — migrate.js
--  wraps the whole file in one transaction with the ledger insert.
--
--  This migration does NOT create the bucket rows and does NOT backfill the
--  existing sourceless leads. Those leads are overwhelmingly internal_qa test
--  fixtures written by harnesses that bypass intake; labelling them
--  'Unattributed' would enshrine test residue as unknown-source demand.
--  Buckets are created on first real use by the code path above.
--
--  Class 1 — permanent product primitive. No removal condition; the house
--  bucket is a durable part of honest attribution.
-- ════════════════════════════════════════════════════════════════════

alter table lead_sources
  drop constraint if exists lead_sources_source_type_check;

alter table lead_sources
  add constraint lead_sources_source_type_check
  check (source_type in ('ils', 'website', 'paid_ad', 'organic', 'manual', 'system'));
