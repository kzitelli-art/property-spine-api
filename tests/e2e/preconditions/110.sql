-- Precondition for 110_governed_charge_assessed_per.sql
--
-- 110 backfills `assessed_per` on exactly two governed charge codes and
-- refuses unless exactly one row of each is updated. That row-count
-- assertion is the right shape — a backfill that silently updates zero rows
-- is exactly the failure it guards against — but it means the chain stops on
-- any schema that does not already carry those two rows. Production does.
--
-- TEST FIXTURE. Not production data, and not a quotable fee.
--
-- The values are not arbitrary: `property_governed_charges` carries 22 check
-- constraints at this point in the chain and they interlock. A one_time_fee
-- may not be monthly and may not be refundable; a `required` obligation must
-- name an applicability_basis; a waivable charge must name a waiver
-- authority; an amount must be present exactly when no unresolved-reason is.
-- The row below is the smallest one that satisfies all of them, and it stays
-- in the default `draft` / `inactive` states so it can never be quoted.
insert into property_governed_charges
  (property_id, charge_code, display_label, economic_class, cadence,
   currency, obligation, applicability_basis, applicability_scope,
   applies_to_new_lease, applies_to_renewal, applies_to_transfer,
   refundable, waivable, amount, effective_from, source_provenance)
select p.id, v.code, v.label, 'one_time_fee', 'one_time',
       'USD', 'required', 'new_lease', 'property',
       true, true, false,
       false, false, 50.00, current_date, 'seed'
  from (values ('fee.application',    'Application fee (fixture)'),
               ('fee.administration', 'Administration fee (fixture)')) as v(code, label)
  cross join lateral (select id from properties order by created_at limit 1) p
 where not exists (
   select 1 from property_governed_charges g where g.charge_code = v.code);
