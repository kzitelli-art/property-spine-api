-- 189_unified_staff_onboarding.sql
--
-- A staff invite used to establish only phone login and module access. Work
-- ownership also requires the governed users-to-persons bridge and a current
-- person assignment, so an accepted invite could operate while remaining
-- ineligible to own the work it created. Keep one invite and let its explicit
-- role/person choices feed both ledgers in the same acceptance transaction.

alter table staff_roles
  add column if not exists user_role role_name,
  add column if not exists assignment_role text,
  add column if not exists assignment_scope text;

update staff_roles
   set user_role = case key
         when 'maintenance_tech' then 'maintenance'::role_name
         when 'leasing_agent' then 'leasing_agent'::role_name
         when 'property_manager' then 'property_manager'::role_name
         when 'property_admin' then 'property_manager'::role_name
         when 'owner' then 'owner'::role_name
         else user_role end,
       assignment_role = case key
         when 'maintenance_tech' then 'maintenance'
         when 'leasing_agent' then 'leasing'
         when 'property_manager' then 'property_manager'
         when 'property_admin' then 'property_manager'
         when 'owner' then 'owner'
         else assignment_role end,
       assignment_scope = case key
         when 'maintenance_tech' then 'maintenance'
         when 'leasing_agent' then 'leasing'
         when 'property_manager' then 'management'
         when 'property_admin' then 'management'
         when 'owner' then 'all'
         else assignment_scope end;

alter table team_invites
  add column if not exists role_key text references staff_roles(key) on delete restrict,
  add column if not exists person_id uuid references persons(id) on delete restrict;

create index if not exists idx_team_invites_person on team_invites(person_id)
  where person_id is not null;

comment on column team_invites.person_id is
  'Existing person record explicitly confirmed by the inviting manager; null means acceptance creates the staff person.';

comment on column team_invites.role_key is
  'Canonical staff role whose access and person assignment are established together when the invite is accepted.';
