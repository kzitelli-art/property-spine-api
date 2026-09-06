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

--  ── THE OPENING BASIS FOR THE BED ────────────────────────────────
--  A bed nobody has established is not an offer: canonical availability
--  refuses a position with no occupancy basis (occupancy_unknown), the Rent
--  Roll refuses to bucket it and Ask Spine counts it not established.
--  Until 2026-09-06 this fixture's Bed B read marketable only because the
--  classifier never asked the prior question, and the tour → application
--  → lease proof leaned on that. So the fixture now establishes what the
--  proof needs, the way the product does: one confirmed vacancy for
--  "3B|Bed B" under an established opening position, with the lineage a
--  confirmation writes (import_source_rows.produced_unit_id /
--  produced_space_id). The whole-unit placeholder beside the bed is
--  deliberately left with no claim: a placeholder beside a real bed is an
--  inventory inconsistency, and this fixture keeps it so the readers'
--  refusal of it stays exercised. Invented figures; not Skyline's data.
insert into import_batches (property_id, source_type, source_file, source_as_of_date, leasing_model, confidence, status)
select p.id, 'rent_roll_ledger', 'skyline-e2e-fixture.csv', date '2026-07-31', 'bed', 'confirmed', 'committed'
  from properties p
 where p.name = 'Skyline E2E'
   and not exists (select 1 from import_batches b where b.property_id = p.id and b.source_file = 'skyline-e2e-fixture.csv');

insert into activations (property_id, status, source_as_of_date, import_batch_id, source_label)
select p.id, 'activated', date '2026-07-31', b.id, 'skyline-e2e-fixture.csv'
  from properties p
  join import_batches b on b.property_id = p.id and b.source_file = 'skyline-e2e-fixture.csv'
 where p.name = 'Skyline E2E'
   and not exists (select 1 from activations a where a.import_batch_id = b.id);

insert into import_source_rows (import_batch_id, row_index, raw, parse_note, produced_unit_id, produced_space_id)
select b.id, 1, '{"unit_number":"3B","space_label":"Bed B","is_vacant":true}'::jsonb, 'fixture: confirmed vacancy', u.id, s.id
  from properties p
  join import_batches b on b.property_id = p.id and b.source_file = 'skyline-e2e-fixture.csv'
  join units u on u.property_id = p.id and u.unit_number = '3B'
  join spaces s on s.unit_id = u.id and s.space_label = 'Bed B'
 where p.name = 'Skyline E2E'
   and not exists (select 1 from import_source_rows r where r.import_batch_id = b.id and r.row_index = 1);

insert into proposed_records (activation_id, property_id, module, target_type, natural_key, normalized_json, status, status_reason, import_source_row_id, confirmed_at)
select a.id, p.id, 'leasing', 'lease', '3B|Bed B',
       '{"section":"current","unit_number":"3B","space_label":"Bed B","is_vacant":true}'::jsonb,
       'promoted', 'Fixture: confirmed as a vacant rentable position. No lease was created.', r.id, now()
  from properties p
  join import_batches b on b.property_id = p.id and b.source_file = 'skyline-e2e-fixture.csv'
  join activations a on a.import_batch_id = b.id
  join import_source_rows r on r.import_batch_id = b.id and r.row_index = 1
 where p.name = 'Skyline E2E'
   and not exists (select 1 from proposed_records pr where pr.activation_id = a.id and pr.natural_key = '3B|Bed B');

insert into opening_tenancy_positions (property_id, activation_id, import_batch_id, as_of_date,
        positions_established, positions_unresolved, source_rows_read, authority_basis, status)
select p.id, a.id, b.id, date '2026-07-31', 1, 0, 1, 'fixture:property_fixture.sql', 'established'
  from properties p
  join import_batches b on b.property_id = p.id and b.source_file = 'skyline-e2e-fixture.csv'
  join activations a on a.import_batch_id = b.id
 where p.name = 'Skyline E2E'
   and not exists (select 1 from opening_tenancy_positions o where o.activation_id = a.id);

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
       (select count(*) from opening_tenancy_positions o join properties p on p.id=o.property_id
         where p.name='Skyline E2E' and o.status='established') as opening_positions,
       (select count(*) from spaces s join units u on u.id=s.unit_id
          join properties p on p.id=u.property_id and p.name='Skyline E2E') as spaces;
