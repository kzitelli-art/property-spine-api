-- Precondition for 087_internal_qa_leasing_coverage.sql
--
-- 087 grants leasing coverage to ONE canonical internal-QA identity on ONE
-- QA property, and refuses unless exactly one active assignment matches. In
-- production those rows exist. On an empty schema they do not, so the
-- migration correctly refuses and the chain stops.
--
-- TEST FIXTURE. Not production data. The identifiers are the ones 087 itself
-- names, because a different id would not satisfy it — that is the point of
-- the migration, not a detail to work around.
insert into users (id, name, role, is_active, status, account_kind)
values ('e9a7659f-ee1a-4bde-9e0c-02c6632ff066', 'Internal QA Operator',
        'property_manager', true, 'active', 'internal_qa')
on conflict (id) do update
  set account_kind = 'internal_qa', is_active = true, status = 'active';

insert into properties (id, name)
values ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe', 'Demo Building')
on conflict (id) do nothing;

insert into property_team_assignments
  (user_id, property_id, role_title, allowed_modules, active, can_manage_roles)
values ('e9a7659f-ee1a-4bde-9e0c-02c6632ff066',
        'a50fbdd0-3642-431e-b532-0dcd6ab8a4fe',
        'property_manager', '{leasing,management}', true, false)
on conflict do nothing;
