-- ════════════════════════════════════════════════════════════════════
--  162_insurance_coverage_participation.sql — "THIS PROPERTY IS NAMED ON
--  THIS POLICY", SEPARATED FROM "THIS PROPERTY'S SHARE IS $X".
--
--  ── THE DEFECT THIS EXISTS TO REMOVE ────────────────────────────────
--  Migration 161 gave insurance a complete economic architecture, and
--  made the ONLY property↔policy link an allocation row carrying an
--  amount:
--
--      insurance_programs    no property_id
--      insurance_coverages   no property_id
--      insurance_property_allocations
--                            property_id + allocated_amount_cents
--                                          bigint not null check (> 0)
--
--  Both reads are gated on that row. readPosition selects FROM
--  insurance_property_allocations; readCompleteness inner-joins it. So a
--  coverage established for a policy that does not state THIS property's
--  share is invisible to this property: readPosition returns
--  established:false and the dashboard looks exactly as it did before
--  anyone uploaded anything.
--
--  The consequence is a shared master policy — the normal case for a
--  portfolio — cannot be recorded at all. Its schedule of locations names
--  the property; the document states carrier, term, premium and policy
--  number. All recorded fact. To store ANY of it today you must first
--  produce a share, and where no broker figure exists that means deriving
--  one. So recording a fact requires manufacturing a different one.
--
--  ── WHAT 161 SEPARATED, AND WHAT IT DID NOT ─────────────────────────
--  161 already split HOW a share was arrived at — 'stated' vs 'derived',
--  with STATED_NEEDS_EXTERNAL_BASIS refusing a computed basis dressed as
--  external authority. What it did not split is whether PARTICIPATION
--  requires a share at all. These are two different statements:
--
--      "this property is named on this policy"     RECORDED FACT.
--                                                  On the schedule of
--                                                  locations, observed on
--                                                  a date, in a document.
--
--      "this property's share is $X"               RECORDED (broker- or
--                                                  carrier-stated) OR
--                                                  DERIVED (a model's
--                                                  output). §38.
--
--  This migration finishes what 161 started. It does not revisit it.
--
--  ── WHY A TABLE AND NOT A NULLABLE AMOUNT ───────────────────────────
--  Loosening allocated_amount_cents to nullable would corrupt the
--  over-allocation guard (insurance_allocation_service.js:162-170), the
--  sum math in readCompleteness, and the meaning of every existing row.
--  A null amount would be a fourth thing the allocation table means.
--
--  ── WHAT THIS TABLE IS NOT ──────────────────────────────────────────
--  It carries NO amount, NO status, NO renewal state, and it is NOT a
--  generalized standing-obligation primitive. Insurance is the specimen;
--  the common shape gets extracted after a SECOND obligation proves it,
--  not before. It records one fact and stops.
--
--  It also carries no deal_membership_id. Allocations stamp membership at
--  origin because they are economic and must stay explainable when a
--  property changes deals (161:172-176). Participation is a bare fact
--  about a document, no money hangs off it, and giving it a stamp it does
--  not need is how a narrow table starts becoming a wide one.
--
--  CLASS 1 — permanent product primitive.
-- ════════════════════════════════════════════════════════════════════

create table if not exists insurance_coverage_properties (
  id                     uuid primary key default gen_random_uuid(),
  coverage_id            uuid not null references insurance_coverages(id) on delete restrict,
  property_id            uuid not null references properties(id) on delete restrict,

  --  Evidence, where there is some. A participation observed in a
  --  document points at the document; one recorded from a broker's
  --  emailed schedule legitimately has no artifact and says so by being
  --  null, rather than by borrowing an unrelated one.
  observed_in_artifact_id uuid references source_artifacts(id),
  observed_as_of         date,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  --  ONE ROW PER (coverage, property). Naming the same property twice on
  --  one policy is the same fact stated twice, not two facts — and this
  --  is also the unique key the allocation FK below needs.
  constraint uq_ins_cov_prop unique (coverage_id, property_id)
);

--  The read is "which coverages does THIS property participate in", so
--  property_id leads. The unique constraint's index leads with
--  coverage_id and cannot serve it. Not speculative: readParticipation
--  issues exactly this shape.
create index if not exists idx_ins_cov_prop_property
  on insurance_coverage_properties (property_id);

-- ════════════════════════════════════════════════════════════════════
--  BACKFILL BEFORE CONSTRAINT. THE ORDER IS THE POINT.
--
--  Every existing allocation implies a participation: you cannot hold a
--  share of a policy you are not on. Inserting those rows FIRST means
--  this migration is safe against a populated allocation table and does
--  not depend on production happening to be empty. If there are no
--  allocations it is a no-op and costs nothing.
--
--  A release-time assumption ("the table should be empty") is the kind of
--  claim that is true until the once it is not, and it would fail as a
--  constraint violation mid-release with the FK half-applied.
--
--  ATTRIBUTION IS TRUTHFUL, NOT INVENTED. The backfilled row is
--  attributed to whoever confirmed the allocation that implies it, dated
--  to that confirmation, and carries that allocation's own artifact where
--  it had one. Where the allocation's provenance was a note rather than a
--  document, observed_in_artifact_id stays null — honest blank, not a
--  borrowed reference.
--
--  observed_as_of is deliberately NOT set from effective_from. An
--  effective date is when the share began to govern; it is not a claim
--  about when anyone observed the property on the policy. Writing one
--  into the other would invent an observation that never happened.
--
--  distinct on (coverage_id, property_id) collapses supersession chains
--  and multiple effective slices to the EARLIEST confirmation, which is
--  when the participation first became known.
-- ════════════════════════════════════════════════════════════════════

insert into insurance_coverage_properties
  (coverage_id, property_id, observed_in_artifact_id, observed_as_of,
   recorded_by_user_id, recorded_at)
select distinct on (a.coverage_id, a.property_id)
       a.coverage_id,
       a.property_id,
       a.source_artifact_id,
       null::date,
       a.confirmed_by_user_id,
       a.confirmed_at
  from insurance_property_allocations a
 order by a.coverage_id, a.property_id, a.confirmed_at asc
on conflict (coverage_id, property_id) do nothing;

-- ════════════════════════════════════════════════════════════════════
--  ALLOCATION IMPLIES PARTICIPATION — ENFORCED BY THE DATABASE.
--
--  §17: two copies of one rule is a defect even while they agree, because
--  agreement is not a mechanism. Without this constraint the invariant
--  holds only because the establish route happens to write both, and the
--  next writer that forgets creates an allocation for a property that is
--  on no policy — a second way to know a property participates, which is
--  exactly the conflation this migration exists to end.
--
--  With it, participation is a strict superset of allocation, forever,
--  and there is one way to know.
--
--  on delete restrict: retiring a participation while a share still hangs
--  off it would orphan the economics.
-- ════════════════════════════════════════════════════════════════════

alter table insurance_property_allocations
  drop constraint if exists fk_ins_alloc_participation;

alter table insurance_property_allocations
  add constraint fk_ins_alloc_participation
  foreign key (coverage_id, property_id)
  references insurance_coverage_properties (coverage_id, property_id)
  on delete restrict;
