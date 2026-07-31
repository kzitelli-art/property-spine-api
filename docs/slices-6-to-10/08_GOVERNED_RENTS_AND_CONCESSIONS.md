# SLICE 8 — GOVERNED RENTS AND CONCESSIONS

## Objective

Create one authoritative commercial economics source used by:

```text
Market & Pricing
Lead Conversations
Follow Ups
Applications
Lease packets
Renewal offers
```

The goal is to prevent competing rent and concession truths.

## First deliverable — economic-authority audit

Audit every current authoring or presentation surface:

```text
unit asking rent
space asking rent
leaseable-unit quote
application proposed terms
confirmed application terms
lease packet terms
renewal proposed rent
concessions
manual overrides
imported rent-roll values
marketing/listing rent
```

For each, return source table/service, authoring workflow, effective date, approval authority, property scope, unit/space scope, versioning, audit trail, downstream consumers, and conflict behavior. Identify all competing truths.

## Economic layers

The permanent model distinguishes:

```text
Observed economics
what an external or imported source reports

Proposed economics
what staff is considering

Approved economics
what an authorized decision-maker approves

Quoted economics
what was communicated to a prospect or resident

Contracted economics
what an executed lease establishes
```

Do not collapse these into one field.

## Governed pricing contract

A governed pricing record should support:

```text
pricing_record_id
property_id
unit_id or space_id
unit_type
base_asking_rent
effective_rent
term_months
available_from
effective_from
effective_through
status
source_type
source_reference
proposed_by_user_id
approved_by_user_id
approved_at
reason_code
reason_note
supersedes_pricing_record_id
created_at
```

Use an existing canonical model if it already covers these meanings.

## Governed concession contract

A governed concession should support:

```text
concession_id
property_id
unit_id / space_id / unit_type / property scope
concession_type
amount
formula
duration
eligible_terms
effective_from
effective_through
approval_status
approved_by_user_id
approved_at
stacking_rule
reason_code
reason_note
supersedes_concession_id
```

Do not use free text as the only concession representation when a structured value exists.

## Authority

Only authorized roles may approve or publish governed economics. The server enforces authority. Hidden or disabled buttons are not authorization.

## Versioning

Economic decisions are append-only or versioned. Preserve before, after, effective time, actor, and reason. Do not silently overwrite approved history.

## Effective pricing service

One server service should resolve pricing for:

```text
property
unit or space
term
start date
new-leasing or renewal context
```

Return:

```text
base asking rent
applicable concession
effective rent
source records
as-of timestamp
quotable status
blocking reason
```

Do not compute effective rent independently in multiple browser surfaces.

## Quote boundary

Approved or published does not automatically mean quotable. The server distinguishes:

```text
approved
published
quotable
expired
blocked
```

The requested term, start date, and context must be part of the decision.

## Downstream use

The same effective-pricing service feeds Lead Conversations, Follow Ups, Application proposed terms, Confirmed terms, Lease packets, and Renewal offers. A downstream workflow may persist a quoted or contracted snapshot, but must preserve lineage to the governed source.

## Concession enforcement

The server enforces eligibility, effective dates, term requirements, stacking rules, and approval status. No silent stacking.

## Existing contracts

Do not retroactively alter signed or executed economics. Future decisions apply according to effective dates.

## UI intent

Market & Pricing should show current effective economics, future approved changes, draft/proposed changes, approval status, reason/provenance, and history. Do not lead with an editable spreadsheet lacking authority and versioning.

## Excluded

Do not include rent-survey ingestion, listing integration, demand modeling, Forward Rent Roll reconstruction, cross-domain priority, or unrelated application/renewal redesign.

## Completion gate

Slice 8 closes only when:

1. One governed pricing source exists.
2. One governed concession source exists.
3. Approval authority is server-enforced.
4. Changes are versioned and audited.
5. Effective pricing is server-authored.
6. Quotable status is explicit.
7. New-leasing and renewal consumers use the same service.
8. Existing contracts are not retroactively changed.
9. Conflicts and expired economics fail honestly.
10. Production SHAs are confirmed.

## Required handback

```text
economic-authority audit
competing-truth inventory
canonical pricing contract
canonical concession contract
authority matrix
versioning and audit design
effective-pricing contract
downstream-consumer matrix
API branch and commit
App branch and commit
migration IDs
merged and deployed SHAs
real-Postgres proof
authenticated HTTP proof
authority proof
version-history proof
quote-context proof
concession-eligibility proof
desktop proof
390px proof
failed-read/write proof
remaining unsupported economics
recommendation for Slice 9
```
