-- ════════════════════════════════════════════════════════════════════
--  KEEP_RETIRE_MAP.sql — what actually exists, before anything is retired
--
--  READ ONLY. Every statement is a SELECT. Nothing here writes, and
--  nothing here should be edited into a write.
--
--  WHY THIS FILE EXISTS
--  Source can say what the machinery permits. Only the database says what
--  is there. Every naming and cleanup decision in the 15 Sep briefing
--  depends on facts this file reads and nothing else can supply.
--
--  HOW TO RUN
--  Neon SQL Editor, production branch, one section at a time. Paste the
--  results back rather than summarising them — the summary is the thing
--  most likely to lose the detail the decision turns on.
--
--  THE RULE THIS FILE ENFORCES BY SHAPE
--  Do not infer identity from a matching name. Sections 1 and 6 exist
--  specifically to surface rows that LOOK like each other, so that a
--  human decides rather than a LIKE clause.
-- ════════════════════════════════════════════════════════════════════


-- ── 1 · EVERY PROPERTY, WITH ALL FOUR OF ITS NAMES ──────────────────
--  name is the internal load-bearing key; display_name is what people
--  see; canonical_key is address-anchored identity; an absent key should
--  carry a recorded reason (migration 150).
--
--  Read the `name` and `display_name` columns against each other. Where
--  they differ, something renamed the property for humans and left the
--  key alone — which is correct, and is also how a demo row can present
--  as a real one.
select
  p.id,
  p.name                          as internal_name,
  p.display_name                  as shown_name,
  p.canonical_key,
  p.canonical_key_absent_reason,
  p.address,
  p.leasing_basis,
  o.name                          as organization,
  p.created_at
from properties p
left join organizations o on o.id = p.organization_id
order by o.name nulls first, coalesce(p.display_name, p.name);


-- ── 2 · EVERY DEAL, AND THE PROPERTIES IT DURABLY CONTAINS ──────────
--  This is deal_intake_properties (migration 025) — the real membership
--  table. A deal with zero properties here has no durable membership,
--  whatever any picker shows.
select
  d.id                            as deal_id,
  d.deal_name,
  d.onboarding_type,
  d.status,
  o.name                          as organization,
  count(dp.property_id)           as properties_in_deal,
  coalesce(
    string_agg(coalesce(p.display_name, p.name), ' · ' order by p.name),
    '— no durable membership —')  as properties
from deal_intakes d
left join organizations o          on o.id = d.organization_id
left join deal_intake_properties dp on dp.intake_id = d.id
left join properties p             on p.id = dp.property_id
group by d.id, d.deal_name, d.onboarding_type, d.status, o.name
order by o.name nulls first, d.deal_name;


-- ── 3 · PROPERTIES BELONGING TO NO DEAL ─────────────────────────────
--  The inverse of section 2, and the more dangerous direction: a
--  property nothing claims. Retiring by deal would miss these entirely.
select
  p.id,
  coalesce(p.display_name, p.name) as property,
  p.canonical_key,
  o.name                           as organization
from properties p
left join organizations o on o.id = p.organization_id
where not exists (
  select 1 from deal_intake_properties dp where dp.property_id = p.id
)
order by o.name nulls first, property;


-- ── 4 · WHAT IS ATTACHED TO EACH PROPERTY ───────────────────────────
--  The dependency check. A row with real work attached is not a
--  candidate for retirement regardless of what its name suggests.
--
--  A zero across every column is the only safe signal, and even then the
--  decision is a human's.
select
  coalesce(p.display_name, p.name) as property,
  p.canonical_key,
  (select count(*) from property_team_assignments t where t.property_id = p.id and t.active) as active_team,
  (select count(*) from units u                  where u.property_id = p.id) as units,
  (select count(*) from leases l                 where l.property_id = p.id) as leases,
  (select count(*) from import_batches b         where b.property_id = p.id) as import_batches,
  (select count(*) from activations a            where a.property_id = p.id) as activations,
  (select count(*) from opening_tenancy_positions op where op.property_id = p.id) as opening_positions
from properties p
order by property;


-- ── 5 · DOES THE HARDCODED REGISTRY AGREE WITH THE DATABASE? ────────
--  src/onboarding/deal_registry.js pins six deals in source, two of them
--  to literal production property ids, and stores a leasing model that
--  properties.leasing_basis also stores.
--
--  This asks the database what it thinks, for exactly those six keys.
--  A mismatch in `leasing_basis` is the one to look at hardest: bed vs
--  unit decides how inventory is counted.
select
  k.registry_key,
  k.registry_model,
  p.id                             as db_property_id,
  coalesce(p.display_name, p.name) as db_property,
  p.leasing_basis                  as db_leasing_basis,
  case
    when p.id is null                      then 'NO PROPERTY WITH THIS CANONICAL KEY'
    when p.leasing_basis is null           then 'db has no leasing_basis'
    when p.leasing_basis <> k.registry_model then 'MISMATCH — registry and column disagree'
    else 'agrees'
  end as verdict
from (values
  ('solo',       '4233-CHESTNUT', 'unit'),
  ('uno',        '4125-CHESTNUT', 'unit'),
  ('greenery',   '1325-N-15',     'bed'),
  ('templenest', 'TEMPLE-NEST',   'bed'),
  ('skyline',    '1417',          'bed'),
  ('n1850',      '1850-BERKS',    'bed')
) as k(registry_key, canonical_key, registry_model)
left join properties p on p.canonical_key = k.canonical_key
order by k.registry_key;


-- ── 6 · ROWS THAT LOOK LIKE EACH OTHER ──────────────────────────────
--  The Solo case: migration 060 set display_name 'Solo on Chestnut' on
--  the row internally named 'Property Spine Demo Building', and the
--  registry also names a real solo at 4233-CHESTNUT.
--
--  Any group returning more than one row is a decision, not a duplicate
--  to clean up automatically.
select
  lower(btrim(coalesce(p.display_name, p.name))) as shown_name_normalised,
  count(*)                                       as rows_sharing_it,
  string_agg(p.id::text || '  [' || p.name || ']', E'\n' order by p.created_at) as the_rows
from properties p
group by 1
having count(*) > 1
order by 1;

-- and the same question by address
select
  lower(btrim(coalesce(p.address, ''))) as address_normalised,
  count(*)                              as rows_sharing_it,
  string_agg(coalesce(p.display_name, p.name), ' · ' order by p.created_at) as the_rows
from properties p
where coalesce(btrim(p.address), '') <> ''
group by 1
having count(*) > 1
order by 1;


-- ── 7 · WHO CAN OPEN WHAT, AND WITH WHICH DOORS ─────────────────────
--  The entitlement picture across the portfolio in one read. This is
--  what the dashboard's four doors are drawn from.
select
  coalesce(p.display_name, p.name) as property,
  u.name                           as person,
  t.role_title,
  t.allowed_modules,
  t.can_manage_roles,
  t.active
from property_team_assignments t
join users u      on u.id = t.user_id
join properties p on p.id = t.property_id
order by property, t.active desc, person;
