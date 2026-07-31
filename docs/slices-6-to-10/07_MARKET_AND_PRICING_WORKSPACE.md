# SLICE 7 — MARKET & PRICING WORKSPACE

## Objective

Build the permanent commercial-control workspace:

```text
MARKET & PRICING

Availability
Pricing
Concessions
Rent Survey
Listings
Demand
```

Slice 7 creates the workspace and integrates existing truth. Slices 8 and 9 mature economics and evidence.

## First deliverable — commercial-source audit

For each section, return current endpoint/service, data source, property scope, authority level, live/fixture status, read support, write support, as-of timestamp, provenance, current destination, and known gaps.

Classify each as:

```text
live and canonical
live but incomplete
advisory only
fixture-backed
not implemented
```

## Workspace structure

Use one stable destination with sections:

```text
Availability
Pricing
Concessions
Rent Survey
Listings
Demand
```

Do not create six new Leasing-home cards.

## Availability

Availability is the live canonical foundation. Preserve marketable now, coming open, blocked by evidence, availability horizon, unit/space records, and canonical classification. Do not change the classifier unless a specific defect is separately proven.

## Pricing

Surface live governed pricing if it exists. Otherwise render:

```text
Pricing is not yet governed for this property.
```

No fixture rents. No inferred asking rents.

## Concessions

When live concessions exist, show effective dates, eligible units/spaces, concession type, amount/formula, approval status, and source. Otherwise show an honest not-configured state.

## Rent Survey, Listings, Demand

Until Slice 9, each may remain `Not yet connected`. Do not use sample competitors, fabricate rents, imply syndication, or invent demand analytics.

## Cross-links

Support canonical navigation from Availability to pricing context, Pricing to eligible concessions, Follow Up or Renewal blockers to Market & Pricing, and Market & Pricing to supporting evidence. Do not add writes merely for navigation convenience.

## Home summary

The Leasing-home strip continues to use the live workspace projection. At minimum:

```text
marketable now
coming open
```

Only add more facts when their sources are live and governed.

## Maturity labels

Every section visibly identifies:

```text
Live
Advisory
Not connected
Unavailable
```

Missing or advisory facts must not look authoritative.

## Failure isolation

One failed section must not erase successful sections. Retry should be section-specific where practical. No whole-workspace fixture fallback.

## Excluded

Do not include governed asking-rent policy, concession approval machinery, survey ingestion, listing integrations, demand modeling, Forward Rent Roll, or cross-domain ranking.

## Completion gate

Slice 7 closes only when:

1. Market & Pricing is one stable workspace.
2. Availability remains live and canonical.
3. Every section has a truthful maturity state.
4. No fixture commercial facts appear signed in.
5. Existing live pricing/concession reads render without browser derivation.
6. Unimplemented sections identify themselves honestly.
7. Home summary and workspace reconcile.
8. Cross-links preserve property and operating context.
9. Failed reads are isolated by section.
10. Production SHAs are confirmed.

## Required handback

```text
commercial-source audit
section maturity matrix
workspace contract
cross-link map
home-summary reconciliation
API branch and commit
App branch and commit
merged and deployed SHAs
test totals
desktop proof
390px proof
one-section-failed proof
all-sections-failed proof
no-fixture proof
unsupported sections
recommendation for Slice 8
```
