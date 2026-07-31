# SLICE 9 — MARKET EVIDENCE

## Objective

Add evidence that informs commercial decisions without becoming pricing authority.

```text
Rent Survey
Listings
Lead Demand
Tour Demand
Conversion
Market Context
```

Evidence informs pricing. It does not publish pricing.

## First deliverable — evidence-source audit

For each source, return source system, ingestion method, property/market scope, update frequency, as-of timestamp, provenance, confidence, structured fields, available history, known gaps, and fair-housing considerations.

Classify each source as canonical internal fact, external observation, operator-entered evidence, derived metric, or unsupported.

## Rent Survey

A rent-survey record should support:

```text
survey_record_id
subject_property_id
competitor_name
competitor_address
distance or market area
unit_type
bedrooms
bathrooms
square_footage
asking_rent
effective_rent
concession
availability
observed_at
source_type
source_reference
captured_by_user_id
confidence
notes
```

Always show observed_at and provenance. Do not overwrite governed pricing or treat an old observation as current truth.

## Listings

Listing/channel evidence should distinguish:

```text
configured
published
accepted by channel
rejected
stale
unverified
```

A listing record should support:

```text
listing_id
property_id
unit_id or space_id
channel
external_reference
published_rent
published_concession
status
last_submitted_at
last_confirmed_at
error_code
error_label
```

Do not claim a listing is live merely because Property Spine attempted to publish it.

## Lead demand

Lead demand should use real lead/conversation sources. Possible dimensions:

```text
new leads
qualified leads
lead source
unit type
price range
date window
```

Do not infer demand from message count alone.

## Tour demand

Tour evidence may include scheduled, completed, canceled, no-show, outcome captured, and applications generated. Use property timezone and canonical operating dates. Do not double-count rescheduled tours.

## Conversion

Conversion metrics should use explicit denominators:

```text
lead → tour
tour → application
application → approved
approved → executed
```

Every metric returns:

```text
numerator
denominator
window
as_of
definition_version
```

Do not display a percentage without its denominator and definition.

## Market context

Market context may include external or operator-entered observations, but must be labeled advisory. Examples include new supply, major employer events, seasonality, university calendar, local regulatory events, and competitor openings.

Avoid subjective neighborhood desirability classifications or language that creates fair-housing risk.

## Fair-housing boundary

Evidence must not rank or characterize neighborhoods or prospects using protected-class proxies.

Do not author or display demographic desirability scores, good/bad neighborhood labels, family-status targeting, or race/religion/national-origin/disability proxy segmentation.

Location and market facts may be objective, sourced, and operationally relevant.

## Evidence vs authority

Every evidence response identifies:

```text
advisory: true
source
as_of
confidence
```

No evidence endpoint may directly mutate approved pricing. A pricing decision may cite evidence IDs in its reason/provenance.

## UI intent

Market & Pricing should allow the operator to move from a pricing decision to supporting evidence, evidence age, source, and contradictory evidence. Do not hide disagreement between sources.

## Home boundary

Do not put broad market analytics on the Leasing home. A limited server-authored signal may be added only when clearly useful and truthful, such as `survey updated 3 days ago`.

## Excluded

Do not include automatic price publication, autonomous pricing decisions, Forward Rent Roll, cross-domain next action, or broad portfolio benchmarking unless separately scoped.

## Completion gate

Slice 9 closes only when:

1. Rent Survey has provenance and as-of dates.
2. Listing status distinguishes attempted from confirmed publication.
3. Lead, tour, and conversion metrics use canonical sources.
4. Conversion metrics expose numerator, denominator, window, and definition.
5. Evidence is labeled advisory.
6. Evidence cannot directly publish pricing.
7. Fair-housing boundaries are enforced.
8. Stale or failed evidence remains honest.
9. Market & Pricing renders conflicting evidence without silently choosing.
10. Production SHAs are confirmed.

## Required handback

```text
evidence-source audit
source/provenance matrix
rent-survey contract
listing-status contract
demand metric definitions
conversion definition version
fair-housing review
evidence-to-pricing lineage design
API branch and commit
App branch and commit
migration IDs
merged and deployed SHAs
real-Postgres proof
authenticated HTTP proof
stale-evidence proof
failed-source proof
conversion-denominator proof
listing-confirmation proof
desktop proof
390px proof
unsupported evidence
recommendation for Slice 10
```
