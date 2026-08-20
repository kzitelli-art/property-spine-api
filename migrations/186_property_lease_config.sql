-- ============================================================================
--  186 - DURABLE PROPERTY LEASE CONFIGURATION
--
--  ONE FACT: the configured lease terms a property's resident packet is
--  rendered from, stored on the property.
--
--  ── FOUND BY RUNNING THE PATH, NOT BY READING IT ───────────────────
--  Driving lead → tour → application-at-a-bed → approval → proposed terms
--  → lease packet against a real server and a real database, the packet
--  step refused:
--
--      409 lease_configuration_incomplete
--      missing: ["(no lease configuration for this property)"]
--
--  `leasepackets.js` resolves configuration in a stated order:
--
--      "ONE resolver. Order: (1) durable property.lease_config when it
--       exists; ..."
--
--  and its fallback is declared Class 2 with an explicit removal condition:
--
--      "CLASS 2 — TEMPORARY CONFIGURATION ADAPTER.
--       Replacement condition: durable property lease configuration
--       (properties.lease_config), OR an approved official lease-provider
--       integration, becomes the canonical source. When that lands,
--       leaseConfigFor reads it first (already does) and this map is
--       deleted."
--
--  The consumption path was built. The column never was: no migration in
--  the tree creates `properties.lease_config`. So the only reachable
--  source is EXTERNAL_LEASE_CONFIG, a hardcoded map holding exactly ONE
--  property id — Demo Building. Every other property, Skyline included,
--  cannot generate a resident packet at all.
--
--  That is the Class-2 adapter becoming the architecture, which is the
--  outcome §18's removal condition exists to prevent. This migration is
--  that removal condition, and nothing more.
--
--  ── WHY jsonb, AND WHY NOT A TABLE OF COLUMNS ──────────────────────
--  The shape is already defined by the code that consumes it, and the map
--  entries are the specimen: landlord_entity, application_fee, amenity_fee,
--  utility_responsibility, late_fee, notice_requirement and friends.
--  Promoting that shape to typed columns now would freeze a vocabulary
--  that a real lease form has not yet been read against (the Skyline form
--  of record is still an external input). jsonb keeps the same shape the
--  adapter already used, so the resolver needs no change at all — it
--  already reads this column first.
--
--  REQUIRED KEYS ARE NOT ENFORCED HERE, deliberately. `requireLeaseConfig`
--  already validates them and fails closed with the missing keys named:
--  "a plausible default could produce a materially wrong lease". Enforcing
--  the same rule in two places would let them disagree, and the one in
--  code is the one that can explain itself to an operator.
--
--  ── WHAT THIS DOES NOT DO ──────────────────────────────────────────
--  It configures no property. Adding the column does not give Skyline a
--  lease configuration — those values are a business input, and inventing
--  them would be exactly the "materially wrong lease" the resolver
--  refuses. It also does not delete EXTERNAL_LEASE_CONFIG: Demo Building
--  resolves through it today, and removing it is a separate, deliberate
--  act once that property carries a row.
--
--  Additive. No data is read, written or moved.
-- ============================================================================

do $$
begin
  if (select count(*) from schema_migrations where version = '034') <> 1 then
    raise exception 'migration 186 requires migration 034 (lease packets)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $$;

alter table properties
  add column if not exists lease_config jsonb;

comment on column properties.lease_config is
  'Durable lease configuration this property''s resident packet is rendered '
  'from — landlord_entity, application_fee, amenity_fee, utility_responsibility, '
  'late_fee, notice_requirement and related configured terms. Read FIRST by '
  'leasepackets.leaseConfigFor, ahead of the Class-2 EXTERNAL_LEASE_CONFIG map. '
  'NULL means the property has no configuration and packet generation fails '
  'closed naming the missing keys — never a plausible default.';
