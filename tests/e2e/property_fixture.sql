-- ════════════════════════════════════════════════════════════════════
--  THE PROPERTY THE HARNESS DRIVES — a Skyline-SHAPED test property.
--
--  TEST FIXTURE. Not Skyline, not production data, not an inventory
--  record. A property let BY THE BED, because that is the shape the whole
--  leasing proof turns on: a unit with more than one rentable space, so an
--  application can be born at an exact bed and a lease can name it.
--
--  Idempotent. Safe to re-run; creates nothing that already exists.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

insert into properties (name, address)
select 'Skyline E2E', '1400 Skyline Blvd, Austin, TX 78704'
 where not exists (select 1 from properties where name = 'Skyline E2E');

insert into property_unit_types (property_id, code, label, sort_order)
select p.id, '3BR', '3 Bed / 3 Bath', 1
  from properties p
 where p.name = 'Skyline E2E'
   and not exists (select 1 from property_unit_types t
                    where t.property_id = p.id and t.code = '3BR');

insert into units (property_id, unit_number, unit_type_id)
select p.id, '3B', t.id
  from properties p
  join property_unit_types t on t.property_id = p.id and t.code = '3BR'
 where p.name = 'Skyline E2E'
   and not exists (select 1 from units u where u.property_id = p.id and u.unit_number = '3B');

--  Two spaces: the whole-unit position and one named bed. Two is the
--  minimum that makes "which bed" a real question rather than an inference.
insert into spaces (unit_id, space_label, use_type)
select u.id, v.label, 'residential'
  from units u
  join properties p on p.id = u.property_id and p.name = 'Skyline E2E'
  cross join (values ('(whole unit)'), ('Bed B')) as v(label)
 where u.unit_number = '3B'
   and not exists (select 1 from spaces s where s.unit_id = u.id and s.space_label = v.label);

--  The operator the harness signs in as.
insert into users (name, role, is_active, status, account_kind)
select 'Mike Grivna', 'property_manager', true, 'active', 'human_staff'
 where not exists (select 1 from users where name = 'Mike Grivna');

insert into property_team_assignments
  (user_id, property_id, role_title, allowed_modules, active, can_manage_roles)
select u.id, p.id, 'property_manager', '{leasing,management,maintenance}', true, true
  from users u, properties p
 where u.name = 'Mike Grivna' and p.name = 'Skyline E2E'
   and not exists (select 1 from property_team_assignments a
                    where a.user_id = u.id and a.property_id = p.id);

--  ── THE PROPERTY'S LEASE CONFIGURATION ─────────────────────────────
--  TEST FIXTURE, AND NOT SKYLINE'S NUMBERS. requireLeaseConfig fails
--  closed naming any missing key rather than rendering a plausible default,
--  which is correct — so a test property needs real-SHAPED values for the
--  packet path to exist at all. Every figure here is invented. Skyline's
--  actual configuration is a business input and enters only from its source.
--  `governing_instrument` is added separately by instrument_fixture.js.
update properties
   set lease_config = coalesce(lease_config, '{}'::jsonb) || jsonb_build_object(
         'landlord_entity',        'Skyline Owner LP (fixture)',
         'application_fee',        '50.00',
         'amenity_fee',            '300.00',
         'amenity_fee_renewal',    '250.00',
         'telecom_fee',            '99.00',
         'late_fee',               '75.00',
         'notice_requirement',     'At least 60 days written notice before the end of the term.',
         'utility_responsibility', 'Resident pays all utilities.',
         'rent_payment_location',  'the online resident portal',
         'insurance_note',         'Renter''s insurance is recommended.')
 where name = 'Skyline E2E';

select 'property fixture' as fixture,
       (select count(*) from properties where name='Skyline E2E') as properties,
       (select count(*) from spaces s join units u on u.id=s.unit_id
          join properties p on p.id=u.property_id and p.name='Skyline E2E') as spaces;
