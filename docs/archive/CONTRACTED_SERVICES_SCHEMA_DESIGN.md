# Contracted Services schema design (migration 171)

Status: Promoted to `migrations/171_contracted_services_canonical_truth.sql`.

The owner ruling assigned Contracted Services migration 171 after the refreshed
main and production ledgers both showed ceiling 170. The tables below are the
durable shape enforced by that migration. The pre-numbering SQL under
`proof/contracted_services/` is retained only as a frozen payload-parity record;
the numbered migration is the release authority.

## Proposed durable tables

```text
contracted_service_coverage_reviews
  id | property_id | reviewed_as_of | reviewed_by_user_id
  source_artifact_id? | provenance_note? | recorded_at

contracted_service_requirements
  id | property_id | service_class | service_label? | determination
  effective_from | effective_to? | supersedes_id? | revision_reason?
  basis? | source_artifact_id? | provenance_note?
  recorded_by_user_id | recorded_at

contracted_service_providers
  id | provider_name | normalized_name | source_artifact_id?
  provenance_note? | created_by_user_id | created_at

contracted_service_engagements
  id | property_id | service_class | service_label? | provider_id
  engagement_label? | effective_from? | effective_to?
  source_artifact_id? | provenance_note? | created_by_user_id | created_at

contracted_service_documents
  id | property_id | engagement_id? | source_artifact_id
  document_kind | execution_state | document_date?
  named_effective_date? | supersedes_id? | revision_reason?
  provenance_note? | confirmed_by_user_id | confirmed_at

contracted_service_terms
  id | property_id | engagement_id | document_id
  term_authority | commencement_date? | commencement_trigger?
  initial_end_date? | initial_term_months? | term_kind
  automatic_renewal? | renewal_period_months?
  notice_days? | continues_until_terminated
  termination_for_convenience? | source_artifact_id? | provenance_note?
  supersedes_id? | revision_reason? | recorded_by_user_id | recorded_at

contracted_service_scopes
  id | property_id | engagement_id | term_id?
  scope_summary | frequency_summary? | exclusions_summary?
  effective_from | effective_to? | source_artifact_id? | provenance_note?
  supersedes_id? | revision_reason? | recorded_by_user_id | recorded_at

contracted_service_locations
  id | property_id | scope_id | location_kind | location_label
  unit_id? | space_id? | effective_from | effective_to?
  recorded_by_user_id | recorded_at

contracted_service_price_components
  id | property_id | term_id | price_basis | amount_cents?
  currency_code | quantity_basis? | description? | recorded_by_user_id | recorded_at

contracted_service_financial_observations
  id | property_id | engagement_id? | service_class? | service_label? | provider_id?
  source_artifact_id | observation_kind | line_label?
  period_start? | period_end? | amount_cents? | currency_code | provenance_note?
  observed_by_user_id | observed_at | supersedes_id? | revision_reason?

contracted_service_decision_links
  id | property_id | engagement_id | obligation_id
  decision_kind | term_id? | linked_by_user_id | linked_at
```

## Required constraints

- Every property-scoped foreign key must preserve property identity; a record
  from another property may never be admitted and filtered later in JavaScript.
- Each property-owned table must expose a unique `(id, property_id)` pair.
  Composite foreign keys use that pair for engagement, document, term, scope,
  correction, financial-observation and decision relationships.
- A property-scoped source artifact must match the row's property. Because the
  existing source table does not expose a composite property foreign key, the
  migration needs a database trigger in addition to service validation.
- Unit, space and obligation links must be rejected unless the linked record is
  owned by the same property. A nullable link is allowed; a foreign-property
  link is not.
- Corrections are append-only and keep the corrected fact's effective date.
- Domain rows are immutable after insert. Database triggers reject `UPDATE`
  and `DELETE`; correction occurs only through a new row with `supersedes_id`
  and a nonblank `revision_reason`.
- A correction target must be from the same property and same canonical fact
  table. Requirement and scope corrections retain `effective_from`; term
  corrections retain `commencement_date` and any `commencement_trigger`;
  document corrections retain the same source artifact.
- A governing term requires an executed document for the same engagement.
  This is enforced by a deferred database trigger as well as by the service.
- Governing document kinds are limited to agreement, statement of work,
  amendment and addendum. A proposal, invoice, certificate or service report
  cannot govern terms.
- One artifact may support several confirmed facts but remains immutable source
  evidence. Source evidence never writes domain truth by itself.
- An amount uses integer cents and an explicit currency. Variable or unknown
  pricing uses a nullable amount with a required description; zero is never the
  default for unknown.
- Engagements do not have a persisted `current` status. Standing is derived from
  source authority, terms, successor terms, notices and the requested as-of date.
- Provider normalized name should be indexed for matching, not made globally
  unique; similar display names are evidence of possible identity, not proof.
- A requirement determination is open-service-class and effective-dated. No
  starter-category row is inserted merely to fill a checklist.
- `service_class` is a validated lower-snake-case key, not a closed accounting
  chart. A service label can preserve the property's own language.
- A fixed term requires either commencement and end dates, with end after
  commencement, or a stated commencement trigger paired with a positive initial
  duration in months. Event-anchored terms do not manufacture calendar dates.
  Automatic renewal requires a positive renewal period. Notice days are
  non-negative and remain distinct from the term end.
- Effective ranges reject an end before or equal to their start. They are
  queried as `[effective_from, effective_to)`.
- Financial observations require a retained source and at least one identifying
  handle: engagement, service class, provider or source line. They never write
  payment, payable or accounting-actual truth.

## Required indexes

- Property and effective-date indexes for requirements, engagements, scopes and
  coverage reviews.
- Property and engagement indexes for documents, terms, scopes, financial
  observations and decision links.
- Property and term indexes for price components.
- A non-unique normalized provider-name index for operator recognition.
- Source-artifact indexes for every table that cites retained evidence.
- Supersedes indexes for append-only head projection.

## Migration 171 proof obligations

The numbered migration must prove on real PostgreSQL that:

- it applies after the actual current ledger and follows repository down/up
  discipline;
- duplicate normalized provider names can coexist while one provider UUID can
  serve more than one property;
- every cross-property engagement, document, term, scope, location, financial
  observation, obligation and source-artifact relationship is refused;
- unsigned or ineligible evidence cannot carry a governing term;
- corrections preserve history and the original effective anchor;
- variable price is not coerced to zero;
- a passed notice deadline does not create a renewal outcome;
- canonical service writes can be read back through the canonical position
  reader with source attribution intact.

## Shared prerequisites

Migration 171 depends only on existing `properties`, `users`,
`source_artifacts`, `units`, `spaces`, and the canonical obligation identifier.
It must not add writes to Utilities, Compliance, Maintenance, Accounting,
Insurance, Debt, or their tables.
