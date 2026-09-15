-- ════════════════════════════════════════════════════════════════════
--  KEEP_RETIRE_MAP.sql — the preservation check, v2
--
--  READ ONLY. Every statement is a SELECT. Nothing writes.
--
--  ── WHAT CHANGED FROM v1, AND WHY ───────────────────────────────────
--  v1 was an inventory, not a preservation check, and it was wrong in
--  three ways that would have made an unsafe change plan:
--
--    1. It counted six dependency classes and implied that zero across
--       them made a record disposable. It does not — that reasoning stays
--       wrong regardless of what the counts turn out to be.
--
--       ⛔ BUT THE EXAMPLE I USED WAS FALSE, AND THE RUN PROVED IT.
--       v2 of this header said "Solo and Uno carry asset-management,
--       legal-entity, capital, tax, insurance, debt and document work."
--       I asserted that; I never established it. Section 4B run against
--       production on 2026-09-15 returns, across ALL 41 properties:
--         legal_entities        0   (every row)
--         capital_positions     0   (every row)
--         insurance_coverages   0   (every row)
--         tax_obligations       0   (every row)
--         documents             0   (every row)
--         debt_instruments      1   (Uno, 260b6bac, and nowhere else)
--         compliance_items     11   (1 on real Solo 9e2bb96e, 10 on the
--                                    DEMO building a50fbdd0)
--         deal_files            9   (1 Skyline, 8 greenery)
--       Solo and Uno carry one debt instrument and one compliance item
--       between them. The preservation risk I argued for is not there.
--       Sections 4A and 4B still earn their place — looking before
--       retiring is the method, and the method was right even though my
--       claim about what it would find was wrong.
--
--    2. It identified related properties by NAME. A change plan keyed on
--       names is exactly the failure this cleanup exists to avoid. Every
--       section now returns immutable ids alongside the human labels, and
--       section 2 returns the property ids INSIDE the membership output
--       rather than a concatenated string.
--
--    3. It compared the static registry to the database on canonical key
--       and leasing model only. The registry also PINS two properties by
--       explicit id. Section 5 now exposes identity disagreement — a
--       pinned id that resolves to a different row than the canonical key
--       does — which is a different and worse failure than two model
--       strings differing.
--
--  ── RETIREMENT IS NOT DELETION ──────────────────────────────────────
--  There is NO lifecycle column on `properties`. The added columns are
--  accountable_assignment_id, canonical_key, canonical_key_absent_reason,
--  display_name, operating_timezone, planned_unit_count — and none of
--  them retires anything. `migrations/180_inventory_retirement.sql`
--  retires UNITS, not properties.
--
--  The existing mechanism that removes a property from ordinary operation
--  while retaining every row is `property_team_assignments.active`.
--  `authorized_properties.js` reads `where a.user_id = $1 and a.active =
--  true`, so deactivating an assignment removes the property from that
--  person's chooser. It is reversible, per-person — which is what keeps
--  staff-specific access intact — and touches no history.
--
--  So a non-zero dependency count is NOT a blocker to retiring a record
--  from ordinary operation. It is a blocker to DELETING one, which is not
--  authorized and is not proposed.
--
--  ── HOW TO RUN ──────────────────────────────────────────────────────
--  Neon SQL Editor, production branch, section by section. Paste results
--  back whole; a summary loses the ids the plan is keyed on.
-- ════════════════════════════════════════════════════════════════════


-- ── 1 · EVERY PROPERTY, BY ID, WITH ALL ITS NAMES ───────────────────
select
  p.id                              as property_id,
  p.organization_id,
  o.name                            as organization,
  p.name                            as internal_name,
  p.display_name                    as shown_name,
  p.canonical_key,
  p.canonical_key_absent_reason,
  p.address,
  p.leasing_basis,
  p.created_at
from properties p
left join organizations o on o.id = p.organization_id
order by o.name nulls first, coalesce(p.display_name, p.name);


-- ── 2 · DEALS AND THEIR PROPERTIES, BOTH BY ID ──────────────────────
--  One row per membership, not an aggregate. A deal with no row here has
--  no durable membership, whatever any picker shows.
select
  d.id                              as deal_id,
  d.deal_name,
  d.status                          as deal_status,
  d.organization_id,
  o.name                            as organization,
  dp.property_id,
  coalesce(p.display_name, p.name)  as property,
  p.canonical_key,
  p.address,
  dp.note                           as membership_note,
  dp.created_at                     as member_since
from deal_intakes d
left join organizations o           on o.id = d.organization_id
left join deal_intake_properties dp on dp.intake_id = d.id
left join properties p              on p.id = dp.property_id
order by o.name nulls first, d.deal_name, property;


-- ── 3 · PROPERTIES BELONGING TO NO DEAL ─────────────────────────────
select
  p.id                              as property_id,
  coalesce(p.display_name, p.name)  as property,
  p.name                            as internal_name,
  p.canonical_key,
  p.address,
  o.name                            as organization
from properties p
left join organizations o on o.id = p.organization_id
where not exists (select 1 from deal_intake_properties dp where dp.property_id = p.id)
order by o.name nulls first, property;


-- ── 4A · OPERATING WORK ATTACHED TO EACH PROPERTY ───────────────────
--  Leasing and maintenance shape. Non-zero here means the property has
--  been operated, not that it may not be retired from ordinary view.
select
  p.id                              as property_id,
  coalesce(p.display_name, p.name)  as property,
  (select count(*) from property_team_assignments t where t.property_id = p.id and t.active) as team_active,
  (select count(*) from property_team_assignments t where t.property_id = p.id and not t.active) as team_inactive,
  (select count(*) from units u                     where u.property_id = p.id) as units,
  (select count(*) from leases l                    where l.property_id = p.id) as leases,
  (select count(*) from import_batches b            where b.property_id = p.id) as import_batches,
  (select count(*) from activations a               where a.property_id = p.id) as activations,
  (select count(*) from opening_tenancy_positions op where op.property_id = p.id) as opening_positions
from properties p
order by property;


-- ── 4B · THE WORK v1 MISSED — ASSET MANAGEMENT, ENTITY, CAPITAL ─────
--  This is where the Solo and Uno setup actually lives. A property can
--  read zero across 4A and still carry every one of these.
--
--  legal_entity_properties is the entity relationship the deal's
--  accounting hangs from; capital_stack_positions is the canonical
--  Equity domain; documents is retained evidence.
select
  p.id                              as property_id,
  coalesce(p.display_name, p.name)  as property,
  (select count(*) from legal_entity_properties le      where le.property_id = p.id) as legal_entities,
  (select count(*) from capital_stack_positions cs      where cs.property_id = p.id) as capital_positions,
  (select count(*) from debt_instrument_properties di   where di.property_id = p.id) as debt_instruments,
  (select count(*) from insurance_coverage_properties ic where ic.property_id = p.id) as insurance_coverages,
  (select count(*) from tax_obligation_properties tp    where tp.property_id = p.id) as tax_obligations,
  (select count(*) from compliance_items ci             where ci.property_id = p.id) as compliance_items,
  (select count(*) from documents d                     where d.property_id = p.id) as documents,
  (select count(*) from deal_intake_files df
     join deal_intake_properties dp2 on dp2.intake_id = df.intake_id
    where dp2.property_id = p.id)                                                   as deal_files
from properties p
order by property;


-- ── 5 · REGISTRY VERSUS DATABASE — IDENTITY, THEN MODEL ─────────────
--  src/onboarding/deal_registry.js pins six deals in source. Two carry an
--  explicit production property id; four resolve by canonical key only.
--
--  `identity_verdict` is the one to read first. A pinned id that resolves
--  to a DIFFERENT row than the canonical key is a silent mis-binding, and
--  no amount of model agreement makes it safe.
--
--  `model_verdict` is reported, NOT actioned. Bed-versus-unit decides how
--  inventory counts; a disagreement is evidence for a decision, never a
--  reason to convert grain administratively.
select
  k.registry_key,
  k.registry_model,
  k.pinned_property_id,
  byid.id                            as pinned_row_id,
  coalesce(byid.display_name, byid.name) as pinned_row,
  bykey.id                           as canonical_row_id,
  coalesce(bykey.display_name, bykey.name) as canonical_row,
  case
    when k.pinned_property_id is null and bykey.id is null then 'no pin, and no row for this canonical key'
    when k.pinned_property_id is null                      then 'no pin — resolves by canonical key only'
    when byid.id is null                                   then 'PINNED ID DOES NOT EXIST'
    when bykey.id is null                                  then 'pinned id exists; no row carries this canonical key'
    when byid.id <> bykey.id                               then 'IDENTITY DISAGREEMENT — pin and canonical key resolve to different rows'
    else 'pin and canonical key agree'
  end as identity_verdict,
  coalesce(byid.leasing_basis, bykey.leasing_basis) as db_leasing_basis,
  case
    when coalesce(byid.leasing_basis, bykey.leasing_basis) is null then 'db has no leasing_basis'
    when coalesce(byid.leasing_basis, bykey.leasing_basis) <> k.registry_model then 'model disagreement — REPORT, do not convert'
    else 'model agrees'
  end as model_verdict
from (values
  ('solo',       '4233-CHESTNUT', 'unit', '9e2bb96e-08e2-41db-81c2-91055ceb50a3'::uuid),
  ('uno',        '4125-CHESTNUT', 'unit', '260b6bac-4738-47c4-b86d-511b726adc48'::uuid),
  ('greenery',   '1325-N-15',     'bed',  null::uuid),
  ('templenest', 'TEMPLE-NEST',   'bed',  null::uuid),
  ('skyline',    '1417',          'bed',  null::uuid),
  ('n1850',      '1850-BERKS',    'bed',  null::uuid)
) as k(registry_key, canonical_key, registry_model, pinned_property_id)
left join properties byid  on byid.id = k.pinned_property_id
left join properties bykey on bykey.canonical_key = k.canonical_key
order by k.registry_key;


-- ── 6 · ROWS THAT LOOK ALIKE — A HUMAN DECIDES, NOT A LIKE CLAUSE ───
--  Any group with more than one row is a decision. The Solo case is the
--  known one: migration 060 set display_name 'Solo on Chestnut' on the
--  row internally named 'Property Spine Demo Building', and the registry
--  names a real solo at 4233-CHESTNUT.
--
--  Matching names and matching addresses are EVIDENCE OF A QUESTION.
--  Neither is grounds to merge, rename or delete.
select
  lower(btrim(coalesce(p.display_name, p.name))) as shown_name_normalised,
  count(*)                                       as rows_sharing_it,
  array_agg(p.id order by p.created_at)          as property_ids,
  array_agg(p.name order by p.created_at)        as internal_names
from properties p
group by 1 having count(*) > 1
order by 1;

select
  lower(btrim(coalesce(p.address, '')))          as address_normalised,
  count(*)                                       as rows_sharing_it,
  array_agg(p.id order by p.created_at)          as property_ids,
  array_agg(coalesce(p.display_name, p.name) order by p.created_at) as shown_names
from properties p
where coalesce(btrim(p.address), '') <> ''
group by 1 having count(*) > 1
order by 1;


-- ── 7 · WHO CAN OPEN WHAT ───────────────────────────────────────────
--  Both the active and inactive rows, because `active` is the retirement
--  mechanism and its current state is the thing a change plan moves.
--  Deactivating one person's assignment must not be read as retiring the
--  property for everyone.
select
  p.id                              as property_id,
  coalesce(p.display_name, p.name)  as property,
  u.id                              as user_id,
  u.name                            as person,
  t.id                              as assignment_id,
  t.role_title,
  t.role_key,
  t.allowed_modules,
  t.can_manage_roles,
  t.active
from property_team_assignments t
join users u      on u.id = t.user_id
join properties p on p.id = t.property_id
order by property, t.active desc, person;


-- ── 8 · ORGANIZATIONS ───────────────────────────────────────────────
--  One Five Capital must be identified by id before anything is scoped
--  to it. More than one row here that looks like it is a finding.
select
  o.id                                   as organization_id,
  o.name,
  (select count(*) from properties p   where p.organization_id = o.id) as properties,
  (select count(*) from deal_intakes d where d.organization_id = o.id) as deals,
  o.created_at
from organizations o
order by o.name;
