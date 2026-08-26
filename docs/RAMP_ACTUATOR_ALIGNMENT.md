# Ramp Actuator Alignment

**Owner architecture ruling recorded 2026-08-26. Design doctrine only.**

This document aligns the vendor-source *Ramp x OneFive — Integration
Architecture & Build Plan* dated 2026-08-25 with Property Spine's Money
architecture. The vendor document is useful evidence about a possible execution
provider. It is not the governing Money design, an API contract, or authority to
begin a Ramp build.

The local source reviewed for this ruling was 258,232 bytes with SHA-256:

```text
52c103f99f5c4f8d3c057297785c9b9d04f9280155687fcf275ad26debcfd1c3
```

The PDF itself is not committed to this public repository. Its distribution
rights and confidentiality have not been ruled. The architectural conclusions,
open questions and build stops are retained here so they do not depend on a
Downloads folder or one conversation.

Read this beside:

- [MONEY_THESIS.md](MONEY_THESIS.md) — operating truth produces the economics;
- [BUDGET_FORECAST_NORTH_STAR.md](BUDGET_FORECAST_NORTH_STAR.md) — Ramp actuals
  are inputs to Planning, never the plan;
- [PHILOSOPHY.md](PHILOSOPHY.md) §§14, 17, 18, 37, 39–41 — Money through the
  work, one architecture, classification, accumulated facts, Ask Spine and
  existing-mechanism-first;
- [COMMUNICATION_LINE_ARCHITECTURE.md](COMMUNICATION_LINE_ARCHITECTURE.md) —
  conversational authority begins with the receiving line and server-derived
  actor scope.

## The governing sentence

> **Property Spine issues the economic mandate. Ramp enforces it, moves the
> money and returns execution evidence.**

Ramp is a plausible system of action for variable spend. Property Spine remains
the system of truth.

```text
occurrence
→ economic obligation
→ authority-backed Spine decision
→ execution mandate
→ Ramp enforcement and payment activity
→ retained provider and cash facts
→ recognition
→ reporting and planning reads
```

The Spine decision is not integration overhead. It is the authority boundary
that prevents a provider approval, a card swipe or a technician's coding choice
from becoming the original economic decision.

## Canonical ownership

| Fact or behavior | Canonical owner |
|---|---|
| Operating cause, work order, project and property context | Property Spine domain that recorded the work |
| Economic obligation and accountable next action | Property Spine obligation engine |
| Business purpose, liability, authority basis, permitted scope and ceiling | Property Spine economic decision |
| Card, Fund, provider authorization and spend-control enforcement | Ramp |
| Provider merchant, amount, provider timestamps, transaction, receipt and payment status | Ramp as source authority for those provider facts |
| Retained raw delivery, signature result, digest, receipts and invoice bytes | Property Spine evidence boundary |
| CapEx/repair, recognition period, intercompany meaning and reporting treatment | Authorized Property Spine accounting/economic mechanism |
| Budget, forecast assumptions, completeness and Operating Plan | Property Spine Asset Management planning domain |

Ramp records what Ramp did and observed. It does not infer why the property
spent, which entity ultimately owes, or how the amount belongs in reporting.

## Six conflicts that must not be designed away

### 1. The cardholder does not choose the GL account

The vendor example asks the person holding the card to select a GL account at
purchase. Property Spine forbids pushing accounting or economic judgment onto
the technician.

The operational capture may ask for or inherit:

```text
property
unit or space, when relevant
work order or project reference
what was bought or observed
receipt or other evidence
```

It must not require the technician to decide:

```text
GL account
repair versus CapEx
recognition period
liable legal entity
resident billback
```

If Ramp can inherit coding from a Fund, card or other enforcement object, the
coding must originate in the governed Spine mandate or be added later by an
authorized accounting actor. It must not become a cardholder choice.

The first vendor question is therefore:

> Can a Fund carry pre-set GL and dimension values so transactions inherit
> coding without the cardholder selecting it, and can GL be made non-selectable
> at the point of purchase?

No permanent purchase-to-accounting design begins until that contract is
confirmed in current official documentation and the OneFive sandbox.

### 2. Provider attribution never establishes liability

A default chain such as:

```text
user → location → Ramp entity
```

may describe the provider's proposed payer attribution. It never becomes
`liable_legal_entity_id` merely because the person swiped through that entity.

```text
Ramp entity          provider-reported payer
Spine decision       governed liable entity
agency rule          why one entity may pay for another
projector            due-to / due-from consequence, when established
```

When the agency or reimbursement basis is absent, the answer is an open
economic obligation and an authorized human decision. It is not a default.

### 3. Split purchases require an allocation-set ruling

One provider transaction may contain several line items benefiting different
properties or legal entities. The existing one-decision/one-durable-fact shape
cannot be stretched silently across that case.

The leading design candidate is:

```text
one authority-backed economic decision or mandate
→ one explicit allocation set
→ allocation lines with amounts, causal hooks and governed liability
→ provider transaction and line-item evidence related to those lines
```

That is a candidate, not a settled schema. The owner must rule whether one
multi-purpose purchase is one decision with allocations or several decisions
before any table or writer is designed. A provider split is evidence of how the
charge was divided; it is not authority over the division's economic meaning.

### 4. Effective-dated entity truth remains in Spine

Property Spine's legal-entity/property relationships are effective-dated.
Provider master data is commonly a current value. When ownership or agency
changes, those two shapes will drift unless one is authoritative.

```text
Spine retains the dated relationship history
→ Spine projects the current effective slice to Ramp
→ Ramp returns the provider entity used for execution
→ Spine never imports that current provider value as liability truth
```

Ramp may reject an execution because required provider master data is absent.
It may not silently supersede the dated Spine relationship.

### 5. Authorization, clearing and settlement are separate dated facts

The amount authorized at swipe is not necessarily the amount cleared or
settled. Partial capture, added items, refunds, reversals and adjustments are
ordinary.

Do not mutate a decision or one transaction row from authorized to settled.
Accumulate provider and cash facts:

```text
authorization fact     amount and provider time
clearing fact          amount and provider time
settlement fact        amount and provider time
refund/reversal fact   amount and provider time
Spine receipt time     recorded separately for each delivery
```

Quantified Exposure and cash readings derive from those dated facts. The
decision may carry a ceiling or no amount at all; it is not rewritten to match
the final cash result.

### 6. Vendor identity needs one owner

Ramp has a vendor master. Property Spine has vendor relationships and
property-specific categories. No current ruling establishes which system owns
durable vendor identity, alias resolution, tax identity or category.

Until that ruling exists:

- preserve Ramp vendor IDs and labels as provider facts;
- do not silently merge a Ramp vendor into a Spine vendor;
- do not allow a Ramp default entity or category to become Spine authority;
- unresolved identity creates accountable reconciliation work;
- do not create bidirectional vendor-master synchronization.

## The first stable integration slice

The first slice must not depend on beta PO creation, transaction coding writes,
line-item splits, embedded cards, Fund pre-coding or card-to-PO association.

The stable core is:

```text
1. Receive a transactions.authorized delivery.
2. Verify the Ramp signature against the exact raw bytes.
3. Retain the original bytes, signature result, provider event ID and SHA-256.
4. Record provider event time and Spine receipt time separately.
5. Deduplicate retries and retain duplicate/anomaly evidence.
6. Read the authoritative provider transaction.
7. Correlate it to an existing Spine mandate and operating cause.
8. If unresolved, create an accountable Spine obligation.
9. Record any human attribution or correction through the canonical Spine writer.
10. Exercise the ready-to-sync / sync-result receipt lifecycle.
```

For the first proof, an authorized accounting actor may complete coding in the
Ramp UI if stable write access is not available. The cardholder is not that
actor merely because they made the purchase. The Spine decision and evidence
remain canonical either way.

Any later coding write-back is an isolated capability adapter. It must check the
capability explicitly, fail honestly when unavailable and never discard the
canonical Spine decision.

## Evidence and event shape

The adapter should copy the existing Meeting Evidence discipline:

```text
exact provider delivery
→ signature verification over exact bytes
→ original bytes and digest retained
→ stable provider/event identity
→ duplicate and anomaly detection
→ provider time and Spine receipt time kept separate
→ binding to a Spine mandate or unresolved obligation
→ normalized provider fact
→ canonical reads
```

Authorization, clearing, receipt, coding, settlement, refund and reversal may
arrive out of order. They accumulate as related dated facts. A mutable provider
status mirror is not the truth.

Receipt and invoice evidence must be copied into the retained source-artifact
contract when the provider permits it. A provider URL alone is not retained
evidence. If only a URL is available, the missing bytes remain an explicit
evidence gap with an owner and next step.

## Ask Spine and the operating conversation

Ramp does not create another conversational agent. Staff SMS and the dashboard
remain two surfaces over the same Ask Spine architecture and canonical writers.

An entitled technician or manager may ask:

```text
What happened to the Home Depot charge?
Which work order is still missing a receipt?
What spend is waiting on my attribution?
Did the card authorization clear?
What do I need to do next?
```

Ask Spine may gather an operational fact or present an accountable next step.
It must not ask a technician for a GL account, liable entity, recognition period
or repair/CapEx judgment. If a conversational answer records or corrects
attribution, it invokes the same canonical economic-decision or evidence writer
as the application. The conversation is never a second Money writer.

The compact standing projection for an actuator domain should eventually expose:

```text
current provider position
correlated Spine mandate or NOT_ESTABLISHED
missing evidence or attribution
accountable next action
provider/read health separately from business truth
```

No identifiers enter model context merely to manufacture links. Entitlements,
references and action authority remain server-derived.

## Capability matrix required before adapter design

For the OneFive sandbox and production account, confirm each capability as:

```text
generally available
beta
private beta
account-gated
roadmap only
unavailable
```

The matrix must cover:

```text
signed webhook algorithms and retry contract
authoritative transaction reads
receipt and invoice byte retrieval
ready-to-sync / synced / failure receipts
purchase-order creation
Fund creation and pre-coding
transaction coding write-back
transaction and line-item splits
embedded card presentation
card-to-PO association
custom fields and external metadata
round-trip external identifiers
master-data limits and entity-specific option restrictions
```

Current vendor claims are `REPORTED` until checked against current official
documentation and the actual OneFive sandbox. No beta or gated capability may
become load-bearing in the permanent Money architecture.

## Correlation and master data

Every execution fact must return with one durable, unambiguous Spine correlation
that can be traversed in both directions across the supported chain:

```text
mandate → PO → Fund → card → transaction → split → receipt → bill → payment
```

Property and possibly Unit are plausible controlled dimensions. Work Order is
high-volume and short-lived; it may be better represented as external metadata,
a PO reference or another durable Spine correlation than as a permanent Ramp
dropdown. The vendor field shape does not decide the domain model.

## Planning consequence

Ramp may provide Actual and Cash evidence:

```text
provider authorization and settled amounts
merchant and vendor evidence
receipt and invoice evidence
payment timing
```

It does not author:

```text
approved budget
forecast assumptions
expected revenue or expense series
recognition period
forecast completeness
Budget / Forecast / Actual / Unquantified position
```

Every future Ramp receipt must answer:

```text
PLANNING CONSEQUENCE

What actual or expected-series fact does this slice provide?
What remains unquantified?
Are effective time, provider time, receipt time and recognition basis preserved?
Does this improve or block the future Operating Plan read?
```

## Component classes and removal conditions

### Class 1 — permanent primitives

- the provider-neutral actuator boundary;
- the Spine mandate and authority wall;
- retained provider evidence and accumulated dated facts;
- canonical reads and Ask Spine standing projection;
- the direct stable-capability Ramp adapter if Ramp is selected as the operating
  actuator.

### Class 2 — temporary adapters

**Ramp / RQS / Yardi interim accounting path**

Removal condition: the direct Property Spine accounting connection is proven,
coding and sync history are migrated or explicitly preserved, reconciliation is
complete, and the interim connection is disabled by a named release step.

**Beta or gated Ramp capability adapter**

Removal condition: the capability becomes a stable documented contract and is
promoted deliberately, or it is unavailable/withdrawn and the adapter plus all
callers are removed. An executable capability gate should notice either state.

No Class 4 scaffolding is authorized by this document.

## Sequencing and hard stops

```text
NOW
Gate Zero → deploy control → RC1 → Mike operating Skyline
Money Builds 0.75 → 1 → 2 → 3 → 4

READ-ONLY IN PARALLEL
Ramp sandbox and capability matrix
RQS/Yardi interim-path contract
vendor-identity ownership ruling
split-decision/allocation ruling
round-trip correlation contract

LATER
Recognition → Cash → Certification → Issuance → Planning → Actuator
```

Do not write permanent Ramp adapter code until all of these are true:

1. the first Money decision rail and authority wall are canonical and proven;
2. the Ramp funding boundary has an owned file/table manifest registered in
   `tests/gate_funding_boundary.js` before the adapter files exist;
3. the required stable capabilities are confirmed in the OneFive sandbox;
4. the GL-at-purchase question is answered without making the technician the
   accounting authority;
5. payer, liability, allocation and dated-entity semantics are ruled;
6. one durable round-trip correlation is proven;
7. source-artifact retention or its honest evidence gap is designed;
8. the Ask Spine standing read and canonical action boundary are in the slice;
9. the Planning Consequence is stated;
10. the first proof can run against isolated infrastructure without live money.

No Ramp document, provider field, approval state or sandbox behavior may create
a second economic authority because it is convenient.

## Final ruling

> **Ramp is a plausible actuator and evidence source. Property Spine owns the
> occurrence, obligation, authority-backed decision, liability, recognition,
> planning and report. Ramp enforces the resulting mandate and returns signed
> execution evidence. Provider convenience may never move that boundary.**
