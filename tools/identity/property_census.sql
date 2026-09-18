-- ════════════════════════════════════════════════════════════════════
--  PROPERTY IDENTITY CENSUS — READ-ONLY
--
--  GENERATED FILE. Do not edit by hand.
--    node tools/identity/generate_property_census.js > tools/identity/property_census.sql
--
--  Four property rows compete for the identity "Solo on Chestnut / 4233".
--  This answers what actually hangs off each one, so a ruling can be
--  made on evidence. It makes no ruling and changes no data.
--
--  ── WHAT THIS SCRIPT MAY DO ────────────────────────────────────────
--  SELECT only. No INSERT, UPDATE, DELETE, DDL, temp table, function,
--  or writing CTE appears anywhere below. It is safe to run against
--  production BY A HUMAN WHO HAS READ IT.
--
--  Run it in a READ-ONLY transaction so the database — not this
--  comment — is what enforces that:
--
--      begin transaction read only;   -- <- already the first statement
--      …                              -- <- the census
--      rollback;                      -- <- already the last statement
--
--  ── WHO RUNS IT ────────────────────────────────────────────────────
--  A human, in the Neon editor. It was NOT run by the thread that
--  generated it, deliberately: an unattended session is not the place
--  to discover that a credential was wider than advertised.
--
--  Derived from 178 migration files, ceiling 189.
--  152 dependent tables. Verified to parse and execute against a
--  DISPOSABLE LOCAL Postgres built from the real migration chain to the
--  same ceiling, exit 0, every count zero.
--
--  Precisely what that proves, and what it does not: that database was
--  not strictly empty — the harness precondition
--  tests/e2e/preconditions/087.sql inserts one `properties` row, and it
--  uses the PRODUCTION Demo Building UUID. So the run proves the SQL is
--  syntactically valid, that every table and column it names exists in
--  the real schema, and that it returns zero counts where there are no
--  rows. It proves nothing about production data.
-- ════════════════════════════════════════════════════════════════════

begin transaction read only;

-- ── STEP 0 · WHICH ROWS ARE THE CANDIDATES? ─────────────────────────
--  Two of the four ids are not recoverable from the repository: the
--  handoff records them only as the truncated prefixes 21197bb1… and
--  79a5a8d1…, which came from a production boot log. Run this first,
--  then paste the full ids into STEP 1.
--
--  This is a DISCOVERY query. Resolving a property by name is exactly
--  what docs/DB_HARNESS_ISOLATION.md forbids for operating code, and
--  the reason it is forbidden — three rows share the name — is the
--  reason a census has to start by listing them.
select id, name, display_name, canonical_key, created_at
  from properties
 where name ilike '%solo%' or name ilike '%chestnut%' or name ilike '%4233%'
    or name ilike '%demo building%' or display_name ilike '%solo%'
 order by created_at asc;

-- ── STEP 1 · THE CANDIDATES ─────────────────────────────────────────
--  EDIT ONLY THIS BLOCK. Every query below reads from it, so the ids
--  are named once rather than in 152 places.
--  Replace the two placeholder ids with what STEP 0 returned.

--  a50fbdd0… 'Property Spine Demo Building' / displayed Solo — populated
--  9e2bb96e… canonical 4233 Chestnut
--  21197bb1… ) two further rows named 'Solo on Chestnut', full ids
--  79a5a8d1… ) UNKNOWN to the repository — fill in from STEP 0

-- ── STEP 2 · IDENTITY OF EACH CANDIDATE ─────────────────────────────
with candidates (property_id) as (
  values
    ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'::uuid),   -- Demo Building / displayed Solo
    ('9e2bb96e-08e2-41db-81c2-91055ceb50a3'::uuid),   -- canonical 4233 Chestnut
    ('00000000-0000-0000-0000-000000000000'::uuid),   -- REPLACE: 21197bb1…
    ('00000000-0000-0000-0000-000000000000'::uuid)    -- REPLACE: 79a5a8d1…
)
select p.id, p.name, p.display_name, p.canonical_key, p.created_at
  from candidates c join properties p on p.id = c.property_id
 order by p.created_at asc;

-- ── STEP 3 · PER-TABLE ROW COUNTS, HIGHEST FIRST ────────────────────
--  One row per (property, table) where the count is non-zero.
--  A table with no timestamp column reports NULL for the date bounds
--  rather than being omitted — an omitted table would read as zero.
with candidates (property_id) as (
  values
    ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'::uuid),   -- Demo Building / displayed Solo
    ('9e2bb96e-08e2-41db-81c2-91055ceb50a3'::uuid),   -- canonical 4233 Chestnut
    ('00000000-0000-0000-0000-000000000000'::uuid),   -- REPLACE: 21197bb1…
    ('00000000-0000-0000-0000-000000000000'::uuid)    -- REPLACE: 79a5a8d1…
),
counts as (
  select 'activations'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join activations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'agent_facts'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join agent_facts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'agent_tour_offers'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join agent_tour_offers t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'ai_leasing_operating_rules'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join ai_leasing_operating_rules t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'application_intents'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join application_intents t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'application_invitations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join application_invitations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'application_proposed_terms_confirmations'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join application_proposed_terms_confirmations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'assignments'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join assignments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'bank_accounts'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join bank_accounts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'bids'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join bids t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'capital_stack_conflicts'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join capital_stack_conflicts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'capital_stack_positions'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join capital_stack_positions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'comm_events'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join comm_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'common_equity_class_terms'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join common_equity_class_terms t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'communication_lines'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join communication_lines t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'compliance_items'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join compliance_items t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'concession_authority_grants'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join concession_authority_grants t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'concession_incidents'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join concession_incidents t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'concession_policies'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join concession_policies t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_coverage_reviews'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_coverage_reviews t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_decision_links'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join contracted_service_decision_links t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_documents'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join contracted_service_documents t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_engagements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join contracted_service_engagements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_financial_observations'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join contracted_service_financial_observations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_locations'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_locations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_price_components'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_price_components t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_requirements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_requirements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_scopes'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_scopes t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_terms'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_terms t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'conversations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join conversations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'deal_intake_files'::text as table_name, 'registry_property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join deal_intake_files t on t.registry_property_id = c.property_id
   group by c.property_id
  union all
  select 'deal_intake_properties'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join deal_intake_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'debt_instrument_properties'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join debt_instrument_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'decision_cases'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join decision_cases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'demo_runs'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join demo_runs t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'deposit_claims'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join deposit_claims t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'documents'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join documents t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'events'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'executed_lease_records'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join executed_lease_records t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'governed_charge_rulings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join governed_charge_rulings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'import_batches'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join import_batches t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'ingest_candidates'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join ingest_candidates t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'ingest_runs'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join ingest_runs t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'insurance_coverage_properties'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join insurance_coverage_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'insurance_funding_arrangements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join insurance_funding_arrangements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'insurance_property_allocations'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join insurance_property_allocations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'inventory'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join inventory t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'inventory_retirements'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join inventory_retirements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lead_takeover_queue'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lead_takeover_queue t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_applications'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_applications t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_economic_schedules'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_economic_schedules t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_move_in_charge_sets'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_move_in_charge_sets t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_offers'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_offers t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_packets'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_packets t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leases'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_conversions'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leasing_conversions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_coverage_exceptions'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leasing_coverage_exceptions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_lead_lifecycle_events'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join leasing_lead_lifecycle_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_leads'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leasing_leads t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_tours'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leasing_tours t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'ledger_claims'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join ledger_claims t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'legal_entity_properties'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join legal_entity_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'meeting_evidence_meetings'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join meeting_evidence_meetings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'meeting_property_bindings'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join meeting_property_bindings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'money_events'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join money_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'obligations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join obligations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'onboarding_runs'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join onboarding_runs t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'opening_tenancy_positions'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join opening_tenancy_positions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'operator_session_invites'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join operator_session_invites t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'payments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join payments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_attributes'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join person_attributes t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_contexts'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join person_contexts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_identity_conflicts'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join person_identity_conflicts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_intent_tasks'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join person_intent_tasks t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_property_classifications'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join person_property_classifications t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'plaid_item'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join plaid_item t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'pricing_review_receipts'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join pricing_review_receipts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_ai_leasing_strategy_deployments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_ai_leasing_strategy_deployments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_aliases'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_aliases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_channel_capabilities'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_channel_capabilities t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_controls'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_controls t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_creation_events'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join property_creation_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_governed_charges'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_governed_charges t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_leasing_cycles'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_leasing_cycles t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_noi_goals'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_noi_goals t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_operating_timezone_changes'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join property_operating_timezone_changes t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_organization_events'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join property_organization_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_pricing_versions'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_pricing_versions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_team_assignments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_team_assignments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_unit_types'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_unit_types t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'proposed_records'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join proposed_records t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'reclean_rulings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join reclean_rulings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'recovery_variants'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join recovery_variants t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'renewal_cases'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join renewal_cases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'report_imports'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join report_imports t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'scheduled_tour_source_links'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join scheduled_tour_source_links t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'scheduled_tour_sources'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join scheduled_tour_sources t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'scheduled_tours'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join scheduled_tours t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'scheduling_source_mappings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join scheduling_source_mappings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'staff_agent_messages'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join staff_agent_messages t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'staff_agent_proposals'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join staff_agent_proposals t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'staff_agent_threads'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join staff_agent_threads t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'staff_sessions'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join staff_sessions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'supply_requests'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join supply_requests t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_clearances'::text as table_name, 'subject_property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join tax_clearances t on t.subject_property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_funding_arrangements'::text as table_name, 'subject_property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join tax_funding_arrangements t on t.subject_property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_obligation_applicability'::text as table_name, 'subject_property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join tax_obligation_applicability t on t.subject_property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_obligation_properties'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join tax_obligation_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_obligations'::text as table_name, 'liable_property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join tax_obligations t on t.liable_property_id = c.property_id
   group by c.property_id
  union all
  select 'team_invites'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join team_invites t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tenant_invites'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join tenant_invites t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tenant_sessions'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join tenant_sessions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_availability'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join tour_availability t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_availability_commands'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join tour_availability_commands t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_availability_events'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join tour_availability_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_booking_links'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join tour_booking_links t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_schedule_policies'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join tour_schedule_policies t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'turnovers'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join turnovers t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_events'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_observations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_observations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_readiness_certifications'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_readiness_certifications t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_readiness_walks'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_readiness_walks t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_triage_confirmations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_triage_confirmations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_triage_findings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_triage_findings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_triage_required_work'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_triage_required_work t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_turn_appliances'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_turn_appliances t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_turn_scopes'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_turn_scopes t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'units'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join units t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_account_meters'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_account_meters t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_account_service_points'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_account_service_points t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_account_services'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_account_services t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_arrangements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_arrangements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_meter_service_points'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_meter_service_points t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_meters'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_meters t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_provider_accounts'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_provider_accounts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_service_declarations'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_service_declarations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_service_points'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_service_points t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_service_providers'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_service_providers t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_services'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join utility_services t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_statement_usage'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_statement_usage t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_statements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_statements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'variance_explanations'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join variance_explanations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'vendor_aliases'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join vendor_aliases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'vendor_property_categories'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join vendor_property_categories t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_acceptances'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_acceptances t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_completion_claims'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_completion_claims t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_order_billback_decisions'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_order_billback_decisions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_order_progress'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join work_order_progress t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_order_proof_attachments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_order_proof_attachments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_orders'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_orders t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_proof_attachments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_proof_attachments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_reopenings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_reopenings t on t.property_id = c.property_id
   group by c.property_id
)
select table_name, fk_column, on_delete, property_id, row_count, earliest, latest
  from counts
 where row_count > 0
 order by row_count desc, table_name, property_id;

-- ── STEP 4 · TOTALS, SO THE FOUR ARE COMPARABLE AT A GLANCE ─────────
with candidates (property_id) as (
  values
    ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'::uuid),   -- Demo Building / displayed Solo
    ('9e2bb96e-08e2-41db-81c2-91055ceb50a3'::uuid),   -- canonical 4233 Chestnut
    ('00000000-0000-0000-0000-000000000000'::uuid),   -- REPLACE: 21197bb1…
    ('00000000-0000-0000-0000-000000000000'::uuid)    -- REPLACE: 79a5a8d1…
),
counts as (
  select 'activations'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join activations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'agent_facts'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join agent_facts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'agent_tour_offers'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join agent_tour_offers t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'ai_leasing_operating_rules'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join ai_leasing_operating_rules t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'application_intents'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join application_intents t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'application_invitations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join application_invitations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'application_proposed_terms_confirmations'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join application_proposed_terms_confirmations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'assignments'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join assignments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'bank_accounts'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join bank_accounts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'bids'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join bids t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'capital_stack_conflicts'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join capital_stack_conflicts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'capital_stack_positions'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join capital_stack_positions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'comm_events'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join comm_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'common_equity_class_terms'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join common_equity_class_terms t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'communication_lines'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join communication_lines t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'compliance_items'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join compliance_items t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'concession_authority_grants'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join concession_authority_grants t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'concession_incidents'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join concession_incidents t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'concession_policies'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join concession_policies t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_coverage_reviews'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_coverage_reviews t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_decision_links'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join contracted_service_decision_links t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_documents'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join contracted_service_documents t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_engagements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join contracted_service_engagements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_financial_observations'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join contracted_service_financial_observations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_locations'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_locations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_price_components'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_price_components t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_requirements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_requirements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_scopes'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_scopes t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'contracted_service_terms'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join contracted_service_terms t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'conversations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join conversations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'deal_intake_files'::text as table_name, 'registry_property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join deal_intake_files t on t.registry_property_id = c.property_id
   group by c.property_id
  union all
  select 'deal_intake_properties'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join deal_intake_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'debt_instrument_properties'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join debt_instrument_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'decision_cases'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join decision_cases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'demo_runs'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join demo_runs t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'deposit_claims'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join deposit_claims t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'documents'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join documents t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'events'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'executed_lease_records'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join executed_lease_records t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'governed_charge_rulings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join governed_charge_rulings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'import_batches'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join import_batches t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'ingest_candidates'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join ingest_candidates t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'ingest_runs'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join ingest_runs t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'insurance_coverage_properties'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join insurance_coverage_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'insurance_funding_arrangements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join insurance_funding_arrangements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'insurance_property_allocations'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join insurance_property_allocations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'inventory'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join inventory t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'inventory_retirements'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join inventory_retirements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lead_takeover_queue'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lead_takeover_queue t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_applications'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_applications t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_economic_schedules'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_economic_schedules t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_move_in_charge_sets'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_move_in_charge_sets t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_offers'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_offers t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'lease_packets'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join lease_packets t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leases'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_conversions'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leasing_conversions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_coverage_exceptions'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leasing_coverage_exceptions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_lead_lifecycle_events'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join leasing_lead_lifecycle_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_leads'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leasing_leads t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'leasing_tours'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join leasing_tours t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'ledger_claims'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join ledger_claims t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'legal_entity_properties'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join legal_entity_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'meeting_evidence_meetings'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join meeting_evidence_meetings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'meeting_property_bindings'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join meeting_property_bindings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'money_events'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join money_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'obligations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join obligations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'onboarding_runs'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join onboarding_runs t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'opening_tenancy_positions'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join opening_tenancy_positions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'operator_session_invites'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join operator_session_invites t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'payments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join payments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_attributes'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join person_attributes t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_contexts'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join person_contexts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_identity_conflicts'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join person_identity_conflicts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_intent_tasks'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join person_intent_tasks t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'person_property_classifications'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join person_property_classifications t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'plaid_item'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join plaid_item t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'pricing_review_receipts'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join pricing_review_receipts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_ai_leasing_strategy_deployments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_ai_leasing_strategy_deployments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_aliases'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_aliases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_channel_capabilities'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_channel_capabilities t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_controls'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_controls t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_creation_events'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join property_creation_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_governed_charges'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_governed_charges t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_leasing_cycles'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_leasing_cycles t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_noi_goals'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_noi_goals t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_operating_timezone_changes'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join property_operating_timezone_changes t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_organization_events'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join property_organization_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_pricing_versions'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_pricing_versions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_team_assignments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_team_assignments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'property_unit_types'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join property_unit_types t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'proposed_records'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join proposed_records t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'reclean_rulings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join reclean_rulings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'recovery_variants'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join recovery_variants t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'renewal_cases'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join renewal_cases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'report_imports'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join report_imports t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'scheduled_tour_source_links'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join scheduled_tour_source_links t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'scheduled_tour_sources'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join scheduled_tour_sources t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'scheduled_tours'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join scheduled_tours t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'scheduling_source_mappings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join scheduling_source_mappings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'staff_agent_messages'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join staff_agent_messages t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'staff_agent_proposals'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join staff_agent_proposals t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'staff_agent_threads'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join staff_agent_threads t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'staff_sessions'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join staff_sessions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'supply_requests'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join supply_requests t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_clearances'::text as table_name, 'subject_property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join tax_clearances t on t.subject_property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_funding_arrangements'::text as table_name, 'subject_property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join tax_funding_arrangements t on t.subject_property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_obligation_applicability'::text as table_name, 'subject_property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join tax_obligation_applicability t on t.subject_property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_obligation_properties'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join tax_obligation_properties t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tax_obligations'::text as table_name, 'liable_property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join tax_obligations t on t.liable_property_id = c.property_id
   group by c.property_id
  union all
  select 'team_invites'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join team_invites t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tenant_invites'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join tenant_invites t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tenant_sessions'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join tenant_sessions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_availability'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join tour_availability t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_availability_commands'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join tour_availability_commands t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_availability_events'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join tour_availability_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_booking_links'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join tour_booking_links t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'tour_schedule_policies'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, null::timestamptz as earliest, null::timestamptz as latest
    from candidates c left join tour_schedule_policies t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'turnovers'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join turnovers t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_events'::text as table_name, 'property_id'::text as fk_column, 'SET NULL'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_events t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_observations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_observations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_readiness_certifications'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_readiness_certifications t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_readiness_walks'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_readiness_walks t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_triage_confirmations'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_triage_confirmations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_triage_findings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_triage_findings t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_triage_required_work'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_triage_required_work t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_turn_appliances'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_turn_appliances t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'unit_turn_scopes'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join unit_turn_scopes t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'units'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join units t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_account_meters'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_account_meters t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_account_service_points'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_account_service_points t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_account_services'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_account_services t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_arrangements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_arrangements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_meter_service_points'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_meter_service_points t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_meters'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_meters t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_provider_accounts'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_provider_accounts t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_service_declarations'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_service_declarations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_service_points'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_service_points t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_service_providers'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_service_providers t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_services'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join utility_services t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_statement_usage'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_statement_usage t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'utility_statements'::text as table_name, 'property_id'::text as fk_column, 'RESTRICT'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.recorded_at) as earliest, max(t.recorded_at) as latest
    from candidates c left join utility_statements t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'variance_explanations'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join variance_explanations t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'vendor_aliases'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join vendor_aliases t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'vendor_property_categories'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join vendor_property_categories t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_acceptances'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_acceptances t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_completion_claims'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_completion_claims t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_order_billback_decisions'::text as table_name, 'property_id'::text as fk_column, 'NO ACTION'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_order_billback_decisions t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_order_progress'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.occurred_at) as earliest, max(t.occurred_at) as latest
    from candidates c left join work_order_progress t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_order_proof_attachments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_order_proof_attachments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_orders'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_orders t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_proof_attachments'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_proof_attachments t on t.property_id = c.property_id
   group by c.property_id
  union all
  select 'work_reopenings'::text as table_name, 'property_id'::text as fk_column, 'CASCADE'::text as on_delete, c.property_id,
         count(t.*) as row_count, min(t.created_at) as earliest, max(t.created_at) as latest
    from candidates c left join work_reopenings t on t.property_id = c.property_id
   group by c.property_id
)
select property_id,
       sum(row_count)                                  as total_rows,
       count(*) filter (where row_count > 0)           as tables_touched,
       sum(row_count) filter (where on_delete = 'CASCADE')   as rows_a_delete_would_destroy,
       sum(row_count) filter (where on_delete in ('RESTRICT','NO ACTION')) as rows_that_would_block_a_delete,
       sum(row_count) filter (where on_delete = 'SET NULL')  as rows_that_would_be_orphaned,
       min(earliest)                                   as earliest_activity,
       max(latest)                                     as latest_activity
  from counts
 group by property_id
 order by total_rows desc;

-- ── STEP 5 · THE FOUR GUARANTEED MERGE COLLISIONS ───────────────────
--  Each of these permits ONE row per property. If two candidates both
--  return a row here, a merge collides with certainty — no shared
--  business key needed. This is what decides whether Option B can run
--  as a single transaction at all.
with candidates (property_id) as (
  values
    ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'::uuid),   -- Demo Building / displayed Solo
    ('9e2bb96e-08e2-41db-81c2-91055ceb50a3'::uuid),   -- canonical 4233 Chestnut
    ('00000000-0000-0000-0000-000000000000'::uuid),   -- REPLACE: 21197bb1…
    ('00000000-0000-0000-0000-000000000000'::uuid)    -- REPLACE: 79a5a8d1…
)
select 'property_pricing_versions' as tbl, c.property_id, count(t.*) as rows
  from candidates c left join property_pricing_versions t
    on t.property_id = c.property_id
   and (status = 'published')
 group by c.property_id
union all
select 'communication_lines', c.property_id, count(t.*)
  from candidates c left join communication_lines t
    on t.property_id = c.property_id
   and (line_type = 'property_facing' and status = 'active')
 group by c.property_id
union all
select 'deal_intake_properties', c.property_id, count(t.*)
  from candidates c left join deal_intake_properties t
    on t.property_id = c.property_id
   and (status = 'current')
 group by c.property_id
union all
select 'opening_tenancy_positions', c.property_id, count(t.*)
  from candidates c left join opening_tenancy_positions t
    on t.property_id = c.property_id
   and (status = 'established')
 group by c.property_id
 order by 1, 2;

-- ── STEP 6 · THE TWO TRIGGER WALLS THE FK GRAPH CANNOT SEE ──────────
--  Both tables carry an UNCONDITIONAL delete-refusal trigger AND a
--  CASCADE foreign key. Proven on a disposable database: a single row
--  in either makes `delete from properties` RAISE, not cascade.
--  If either returns > 0, a delete of that property is IMPOSSIBLE
--  until the row is retired through its own governed path.
with candidates (property_id) as (
  values
    ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'::uuid),   -- Demo Building / displayed Solo
    ('9e2bb96e-08e2-41db-81c2-91055ceb50a3'::uuid),   -- canonical 4233 Chestnut
    ('00000000-0000-0000-0000-000000000000'::uuid),   -- REPLACE: 21197bb1…
    ('00000000-0000-0000-0000-000000000000'::uuid)    -- REPLACE: 79a5a8d1…
)
select 'ai_leasing_operating_rules' as tbl, c.property_id, count(t.*) as rows
  from candidates c left join ai_leasing_operating_rules t on t.property_id = c.property_id
 group by c.property_id
union all
select 'governed_charge_rulings', c.property_id, count(t.*)
  from candidates c left join governed_charge_rulings t on t.property_id = c.property_id
 group by c.property_id
 order by 1, 2;

-- ── STEP 7 · SOURCE ARTIFACTS — INVISIBLE TO THE FK GRAPH ───────────
--  `source_artifacts` has NO property_id column and NO foreign key to
--  properties. It binds by a polymorphic (scope_type, scope_id) pair,
--  so it appears NOWHERE in the 154-edge dependency graph. A property
--  delete leaves these orphaned but intact; a rebind strands them,
--  and an immutability trigger refuses to move or delete them.
with candidates (property_id) as (
  values
    ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'::uuid),   -- Demo Building / displayed Solo
    ('9e2bb96e-08e2-41db-81c2-91055ceb50a3'::uuid),   -- canonical 4233 Chestnut
    ('00000000-0000-0000-0000-000000000000'::uuid),   -- REPLACE: 21197bb1…
    ('00000000-0000-0000-0000-000000000000'::uuid)    -- REPLACE: 79a5a8d1…
)
select c.property_id, count(a.*) as artifacts,
       min(a.uploaded_at) as earliest, max(a.uploaded_at) as latest
  from candidates c
  left join source_artifacts a on a.scope_type = 'property' and a.scope_id = c.property_id
 group by c.property_id
 order by artifacts desc;

-- ── STEP 8 · MARLOW'S TOUR — PROTECTED FOREVER ──────────────────────
--  31ca5801-… must survive every option. Source protects it only
--  TRANSITIVELY, through its parent property being in owner.js's
--  NEVER_DELETE list. Nothing is keyed on the tour id itself.
--  Confirm which property currently owns it before any ruling.
select id, property_id, status, created_at
  from leasing_tours
 where id = '31ca5801-a851-4be5-802d-28739f24d6e1';

rollback;

