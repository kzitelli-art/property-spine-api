-- 087_internal_qa_leasing_coverage.sql
--
-- Controlled activation correction:
-- The canonical QA operator is `account_kind = internal_qa`, which correctly
-- excludes it from operational ownership. Its original assignment title
-- ("Internal QA") was also rejected by the application-link authority resolver,
-- making the controlled QA send path impossible to exercise.
--
-- Give this exact QA identity manager COVERAGE on this exact QA property while:
--   * keeping account_kind = internal_qa;
--   * keeping can_manage_roles = false;
--   * requiring the existing active leasing entitlement;
--   * changing no prospect, obligation owner, production user, or other property.
--
-- This is execution authority for controlled QA, not operational ownership.

do $$
declare
  affected integer;
begin
  update property_team_assignments as pta
     set role_title = 'property_manager',
         can_manage_roles = false,
         updated_at = now()
    from users as u
   where pta.user_id = u.id
     and pta.user_id = 'e9a7659f-ee1a-4bde-9e0c-02c6632ff066'
     and pta.property_id = 'a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'
     and pta.active = true
     and u.account_kind = 'internal_qa'
     and u.is_active = true
     and u.status = 'active'
     and 'leasing' = any(coalesce(pta.allowed_modules, '{}'::text[]));

  get diagnostics affected = row_count;

  if affected <> 1 then
    raise exception
      '087 refused: expected exactly one active leasing assignment for the canonical internal-QA operator on the QA property; found %',
      affected;
  end if;
end
$$;
