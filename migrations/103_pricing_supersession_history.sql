-- ════════════════════════════════════════════════════════════════════
--  103_pricing_supersession_history.sql
--
--  Migration 062 created:
--      create unique index uq_ppv_one_published
--        on property_pricing_versions (property_id) where status='published';
--
--  That index permits exactly ONE published version per property FOREVER, and
--  it makes the required lifecycle impossible. "A replacement version points
--  at the version it supersedes" and "superseded history is retained" cannot
--  both hold if the superseded row must stop being published in order for its
--  replacement to exist. The only way to satisfy the index is to retire or
--  delete history — which is the opposite of retaining it.
--
--  It was never wrong so much as too blunt. What it was reaching for is the
--  real invariant: A PROPERTY MUST NOT HAVE TWO ASKING RENTS ON ONE DAY. That
--  is a statement about overlapping EFFECTIVE PERIODS, not about row counts,
--  and migration 102 already expresses it exactly:
--
--      exclude using gist (property_id with =,
--                          tstzrange(effective_from, effective_until, '[)') with &&)
--        where (status = 'published')
--
--  The exclusion constraint is strictly stronger where it matters and
--  strictly weaker where it must be: it still refuses two versions covering
--  the same day, and it permits a closed prior period to remain published
--  history alongside its successor.
--
--  Found by the governance harness, which asserted the overlap refusal and
--  received the wrong error — the constraint that fired was the row-count
--  index, not the period rule.
--
--  CLASSIFICATION: Class 1 correction. Both pricing version tables are empty
--  (0 rows), so no history is affected.
-- ════════════════════════════════════════════════════════════════════

drop index if exists uq_ppv_one_published;

-- Re-assert the period rule so this migration is self-contained if 102 is
-- ever replayed against a database where it did not take.
create extension if not exists btree_gist;
alter table property_pricing_versions drop constraint if exists ex_pricing_versions_no_overlap;
alter table property_pricing_versions add constraint ex_pricing_versions_no_overlap
  exclude using gist (
    property_id with =,
    tstzrange(effective_from, effective_until, '[)') with &&
  ) where (status = 'published');

-- A published version must state when it starts. Without effective_from the
-- range is unbounded-below and would overlap everything, so the constraint
-- would be doing accidental work rather than stated work.
alter table property_pricing_versions drop constraint if exists ck_published_has_effective_from;
alter table property_pricing_versions add constraint ck_published_has_effective_from
  check (status <> 'published' or effective_from is not null);
