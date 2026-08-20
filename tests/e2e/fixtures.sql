-- ══════════════════════════════════════════════════════════════════
--  TEST FIXTURES — NOT PRODUCTION TRUTH, NOT LEGAL PROOF.
--  Invented values that exist only to exercise the mechanism locally.
--  Terms are written while the version is DRAFT and the version is then
--  published, which is the order the immutability rule requires.
-- ══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

delete from pricing_terms t using property_pricing_versions v, properties p
 where t.pricing_version_id=v.id and v.property_id=p.id and p.name='Skyline E2E';
delete from property_pricing_versions v using properties p
 where v.property_id=p.id and p.name='Skyline E2E';

insert into property_pricing_versions (property_id, status, effective_from, note)
select id, 'draft', current_date - 1,
       'TEST FIXTURE — not authorized pricing. Exercises resolveSpaceEconomics only.'
  from properties where name='Skyline E2E';

insert into pricing_terms
  (pricing_version_id, property_id, unit_type_id, unit_type,
   lease_term_months, base_rent, offer_state)
select v.id, v.property_id, put.id, put.code, 12, 1025.00, 'offered'
  from property_pricing_versions v
  join properties pr on pr.id=v.property_id and pr.name='Skyline E2E'
  join property_unit_types put on put.property_id=v.property_id
 where v.status='draft';

update property_pricing_versions v
   set status='published', published_at=now()
  from properties p
 where v.property_id=p.id and p.name='Skyline E2E' and v.status='draft';

commit;
select 'published version', v.id, count(t.id) terms
  from property_pricing_versions v
  join properties p on p.id=v.property_id and p.name='Skyline E2E'
  left join pricing_terms t on t.pricing_version_id=v.id
 where v.status='published' group by v.id;
