-- ============================================================================
--  183 - PRICING OVERRIDE UNIQUENESS
--
--  ONE FACT: uniqueness of a published pricing row is per SCOPE, not per
--  (version, type, term) alone.
--
--  ── THE DEFECT, EXACTLY ────────────────────────────────────────────
--  Migration 101 added `override_scope` / `override_ref` to pricing_terms
--  and said, in its own header:
--
--      "The eventual model is: property pricing version → unit-type default
--       → optional later override → inventory cohort or specific space.
--       This migration does NOT build cohort or space overrides. It only
--       avoids making them impossible."
--
--  In the same file it then created:
--
--      uq_pricing_terms_version_type_term
--        on (pricing_version_id, unit_type_id, lease_term_months)
--        where unit_type_id is not null
--
--  under the comment "One priced row per (version, type, term). A second row
--  for the same combination is a contradiction, not an override."
--
--  That index makes the overrides IMPOSSIBLE. A space override is, by
--  construction, a second row for the same (version, type, term) — that is
--  what "override" means. The reasoning was right for a world with no
--  override columns and was not revisited when they were added, so 101
--  reserved the shape and closed the door on it in the same breath.
--
--  Found by attempting a real by-the-bed override against real Postgres:
--      duplicate key value violates unique constraint
--      "uq_pricing_terms_version_type_term"
--
--  ── THE CORRECTION ─────────────────────────────────────────────────
--  101's intent is PRESERVED, not weakened. There is still exactly one
--  type-default row per (version, type, term); a second one is still a
--  contradiction and is still refused. What changes is that a row carrying a
--  narrower scope is no longer counted as that same row.
--
--      one DEFAULT   per (version, type, term)
--      one OVERRIDE  per (version, type, term, scope, ref)
--
--  Two partial indexes rather than one expression index, because the two
--  statements are genuinely different rules and a reader should be able to
--  see which one refused them. COALESCE over override_ref would have merged
--  them into a single clever predicate that says neither clearly.
--
--  ── WHY THE NULL SEMANTICS MATTER HERE ─────────────────────────────
--  A plain unique index over the five columns would NOT enforce the override
--  rule: in Postgres, NULLs do not collide, so every type-default row (whose
--  override_ref is null) would be mutually unique and the default rule would
--  silently stop being enforced. Splitting on `override_scope is null`
--  keeps each rule stated where it actually applies.
--
--  ── WHAT THIS DOES NOT DO ──────────────────────────────────────────
--  It does not build cohort membership, does not add a precedence rule to
--  the database, and does not publish any pricing. Precedence lives in
--  effective_pricing.js's resolveSpaceEconomics, which is the one owner of
--  advertised economics. This migration only stops the schema from refusing
--  a row the model was explicitly shaped to allow.
--
--  Additive and reversible: no data is read, written or moved.
-- ============================================================================

do $$
begin
  if (select count(*) from schema_migrations where version = '101') <> 1 then
    raise exception 'migration 183 requires migration 101 (pricing unit-type reference + override columns)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $$;

-- The index that closed the door.
drop index if exists uq_pricing_terms_version_type_term;

-- RULE 1 — one type DEFAULT per (version, type, term). 101's rule, unchanged
-- in meaning, now stated only where it applies.
create unique index if not exists uq_pricing_terms_default_version_type_term
  on pricing_terms (pricing_version_id, unit_type_id, lease_term_months)
  where unit_type_id is not null and override_scope is null;

-- RULE 2 — one OVERRIDE per (version, type, term, scope, ref). Two different
-- prices for the same bed on the same term in one published version is still
-- a contradiction, and is still refused.
create unique index if not exists uq_pricing_terms_override_version_type_term_scope
  on pricing_terms (pricing_version_id, unit_type_id, lease_term_months, override_scope, override_ref)
  where unit_type_id is not null and override_scope is not null;

comment on index uq_pricing_terms_default_version_type_term is
  'One unit-type DEFAULT price per version/type/term. A narrower-scoped row is '
  'an override and is governed by uq_pricing_terms_override_version_type_term_scope.';

comment on index uq_pricing_terms_override_version_type_term_scope is
  'One OVERRIDE price per version/type/term/scope/ref. Added at 183: migration '
  '101 reserved override_scope/override_ref and then made them unreachable with '
  'a unique index that did not include them.';
