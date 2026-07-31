# SLICE 10 — ECONOMIC CLOSURE AND ORCHESTRATION

## Objective

Close the economic loop:

```text
Market & Pricing
→ quoted or offered economics
→ application or renewal execution
→ executed lease schedule
→ Management Forward Rent Roll
```

Only after contractual closure is proven should Property Spine add cross-domain next-action orchestration.

Slice 10 has two sequential parts:

```text
10A — Contractual and economic closure
10B — Cross-domain orchestration
```

Do not begin 10B before 10A is accepted.

# PART 10A — CONTRACTUAL AND ECONOMIC CLOSURE

## First deliverable — contractual-lineage audit

Audit:

```text
application → executed lease
renewal → executed renewal lease
lease → unit/space
lease → resident/person
lease → pricing source
lease → concession source
lease → signed packet
lease → activation
lease → Forward Rent Roll
```

Return current canonical IDs, missing direct correlations, duplicates, contracted economics source, Current Rent Roll inclusion rule, Forward Rent Roll inclusion rule, effective-date handling, amendment handling, termination handling, and gaps.

## Canonical lease record

A lease record should support:

```text
lease_id
property_id
unit_id / space_id
primary_person_id
additional_signers
source_application_id
source_renewal_id
prior_lease_id
renewed_by_lease_id
lease_start
lease_end
possession_date
activation_date
termination_date
base_rent
recurring_charges
concession_snapshot
effective_rent
deposit
term_months
pricing_source_ids
concession_source_ids
quote_snapshot_id
packet_id
executed_document_id
execution_status
status
created_at
```

Use existing canonical schema where available. Add only missing direct lineage required for deterministic reads.

## Contracted snapshot

An executed lease must persist the economics actually contracted. It must not recalculate history from today’s pricing table.

Preserve an immutable snapshot of base rent, recurring charges, concessions, effective dates, term, and approved source lineage.

## Forward Rent Roll

Forward Rent Roll is a Management output derived from contractual facts:

```text
executed future lease
executed renewal
amendment
termination
possession/activation rules
```

The server projection should return:

```text
as_of
property_id
unit/space
current tenancy
future contractual event
effective date
future rent
source lease_id
change type
confidence / evidence state
blocking reason
```

The browser must not reconstruct the schedule.

## Current vs forward truth

```text
Current Rent Roll
what is economically active as of the read date

Forward Rent Roll
executed contractual changes scheduled after the read date
```

An offer, approved application, or unsigned packet does not belong in Forward Rent Roll. Only a contract meeting the server execution/admission rule may enter.

## Renewal closure

An executed renewal should create or identify the new contractual lease, link to the prior lease, preserve renewal source and economics, exit the active renewal rail, enter Forward Rent Roll when future-effective, and enter Current Rent Roll when economically active.

## New-lease closure

An executed new lease should link to the source application, preserve signed packet and economics lineage, exit Follow Ups, enter Forward Rent Roll if future-dated, and enter Current Rent Roll according to activation rules.

## Amendments and termination

Do not ignore rent amendments, term extensions, early termination, unit transfer, or lease cancellation. Unsupported cases must return explicit blockers rather than silently producing an incorrect schedule.

## Lease Records

This is the proper point to introduce a true Lease Records surface.

Recommended placement:

```text
Management
→ Lease Records
→ Current Rent Roll
→ Forward Rent Roll
```

An Application Record may link to its resulting lease. It does not replace Lease Records.

## 10A completion gate

10A closes only when:

1. Application-to-lease lineage is deterministic.
2. Renewal-to-lease lineage is deterministic.
3. Contracted economics are immutable or versioned.
4. Current and Forward Rent Roll use contractual truth.
5. Unsigned or merely approved work never enters Forward Rent Roll.
6. Executed future contracts do enter Forward Rent Roll.
7. Active Follow Up and Renewal rows exit through server-authored execution.
8. Amendments/terminations are supported or explicitly blocked.
9. Lease Records or equivalent canonical detail is available.
10. Production SHAs are confirmed.

# PART 10B — CROSS-DOMAIN ORCHESTRATION

## Objective

Add one server-authored daily next-action layer across:

```text
Tours
Follow Ups
Lead Conversations
Renewals
Market & Pricing
```

The browser must not compare domain rows itself.

## First deliverable — orchestration audit

For each domain, document candidate record, priority source, accountable owner, due state, waiting party, blocker, primary action, destination, and terminal state. A domain may not participate until these are authoritative.

## Candidate contract

```text
candidate_id
domain
record_id
property_id
title
state_label
accountable_user_id
assignment_state
due_at
due_state
waiting_on
blocker_code
priority_class
priority_reason
priority_evidence
primary_action { code, label, kind, target }
created_at
latest_activity_at
```

## Priority authority

Priority must be server-authored from explicit rules. The ranking service must be deterministic, testable, versioned, explainable, property-scoped, and stable under repeated reads.

Do not use an opaque model score as the sole authority. AI may summarize or explain the result. It may not silently override governed priority.

## Priority inputs

Potential inputs include safety/legal deadline, contractual deadline, overdue duration, resident/prospect waiting, revenue exposure, unit availability impact, unassigned work, blocked dependency, and manual escalation.

The exact hierarchy requires an owner ruling before implementation. Do not invent the hierarchy from UI convenience.

## Daily briefing

The Leasing home may show:

```text
Next action
Why it matters
Who owns it
When it is due
Open destination
```

It must also preserve domain facts. The briefing is a summary, not a replacement for domain destinations.

## AI boundary

AI may summarize a candidate, explain ranking, suggest wording, help navigate, or draft communication.

AI may not create obligations, change deadlines, assign ownership without authority, mark work complete, publish economics, or execute lease/renewal state transitions.

## 10B completion gate

10B closes only when:

1. Every participating domain emits authoritative candidates.
2. Ranking rules are explicit and versioned.
3. The top action is reproducible.
4. Priority reasons are visible.
5. Unassigned or unsupported work remains honest.
6. The browser does not rank.
7. AI cannot silently override priority.
8. The action opens the canonical destination.
9. Failed orchestration does not hide domain facts.
10. Production SHAs are confirmed.

## Required handback for Slice 10

```text
contractual-lineage audit
lease-record contract
contracted-snapshot design
Current vs Forward Rent Roll rules
application/renewal exit matrix
amendment/termination support matrix
orchestration candidate contract
priority-rule proposal
owner rulings required
priority versioning
AI authority boundary
API branch and commit
App branch and commit
migration IDs
merged and deployed SHAs
real-Postgres proof
authenticated HTTP proof
contract-admission proof
forward-rent-roll proof
renewal closure proof
new-lease closure proof
unsupported-amendment proof
candidate ranking proof
determinism proof
browser proof
failed-orchestration proof
no-browser-ranking proof
```
