# Contracted Services canonical contract

Status: domain contract for the first Contracted Services operating registry.

Contracted Services lives at Asset Management -> Property Expenses ->
Contracted Services. It owns the property's governed service engagements: why a
third party is expected, who is engaged, what they are supposed to do, which
document governs, what the commercial terms say, and which decision or notice is
next. It is not a vendor directory, accounts payable, a work-order system, a
compliance register, or a document folder.

## The canonical question

The domain must make this chain understandable without inference:

```text
property
  -> service requirement or delivery decision
  -> provider relationship
  -> service engagement
  -> scope, locations and expected frequency
  -> governing document and execution standing
  -> effective commercial term and price components
  -> notice / renewal decision
  -> one accountable owner or UNASSIGNED
  -> financial and performance observations, kept in their own authority class
```

The order matters. A P&L line or invoice may reveal that money was associated
with a service. It does not establish who is contractually bound, what scope is
owed, whether an agreement was executed, whether service occurred, or whether
the amount was paid.

## Portfolio evidence behind the shape

The source read sampled owned assets and active deals rather than designing from
one building:

- 4125 Chestnut carries a historical service-contract summary, current operating
  expense lines, an executed PrintWithMe agreement, an executed Ehrlich pest
  agreement, and Otis and generator offers with blank signature fields. Current
  accounting names Patriot for pest service, so the evidence asks whether it
  replaced or supplements Ehrlich instead of rewriting the governed provider.
- 4233 Chestnut carries cleaning, trash, compactor, landscaping, elevator and
  other service files. The cleaning document states a monthly price and term but
  its signature fields are blank. The landscaping file is a proposal that says
  it is invalid until signed. The waste form contains a 36-month automatic
  renewal and a 90-day notice clause, again with blank signature fields in the
  extracted copy.
- 1417 North 15th carries recurring cleaning, extermination, fire, elevator,
  security, snow and landscaping spend. Its Fujitec elevator document includes
  an initial one-year term, a five-year automatic renewal, a 90-day notice
  requirement and price escalation language. The retained evidence does not
  establish the renewal or termination outcome after the initial term.
- 1325 North 15th carries an executed Amazon Hub amendment whose initial term is
  anchored to installation and activation, plus current cleaning, pest, waste,
  security, elevator and snow observations. The trigger is material, but it is
  not a calendar date and cannot be treated as one.
- 1439 North 15th shows a much smaller service set and materially lower spend.
- Tower Place carries cleaning, pest, snow, fire, elevator, security, HVAC,
  meter reading, waste, compactor, water treatment and other service evidence.
  A folder named `Current Contracts` and a security proposal do not by
  themselves establish that those documents govern today.
- Pump House's operating evidence primarily shows fire monitoring, while elevator
  service, pest control, snow and turnover cleaning appear elsewhere in repairs,
  inspections or utilities. Accounting taxonomy is not a contract taxonomy.

These records establish two product requirements. First, service classes are
open and property-specific; the UI must not render a giant invented checklist as
if every asset needs propane, scent service, a garage operator, or an elevator.
Second, the authority and execution state of the document must be visible in the
main read, not buried behind a file link.

## Durable concepts

`coverage review` is a dated human statement about the service census that was
actually reviewed for the property. It may establish that the current declared
service set is the reviewed set as of a date. Without one, the domain may be
partially established but cannot claim complete property-wide coverage.

`service requirement` is an effective-dated property decision for one open
service class. It says `contracted_service_required`, `managed_in_house`, or
`not_applicable`. Absence is `NOT_ESTABLISHED`, never no. A requirement may exist
before a provider or agreement is chosen.

`provider` is the party named as supplying contracted service. It is a
Contracted-Services-owned portfolio identity and may participate in several
engagements at several properties. It is not the accounting `vendors` primitive,
which is a payee learned from banking or ledger evidence, and it does not claim
formation-document legal identity. A later governed link may relate the two.

`engagement` is one property-scoped service relationship with one provider. A
provider may have several engagements at one property, and one service class may
have several providers or separate scopes. The engagement does not become
governed merely because it has a provider name.

`source document` classifies retained evidence as proposal, agreement, statement
of work, amendment, addendum, renewal notice, termination notice, invoice,
certificate of insurance, service report, accounting report, or other. Its
execution state is recorded separately: unverified, unsigned, partially
executed, or executed.

`term` is an append-only reading of one document's commercial terms. Its authority
is explicit: offered, governing, observed, or asserted. Only a term supported by
an executed governing document may establish the governed service term. A
proposal's dates and price may be shown as offered terms; they may not drive a
headline that says the contract is current. When a term begins on installation,
activation, or another event, the stated trigger and duration are preserved while
calendar standing remains `OUTCOME_NOT_ESTABLISHED` until the event date is known.

`scope` records the promised work, covered location(s), expected service
frequency, and material exclusions without flattening them into a category name.
`Building cleaning` is not a scope of work.

`price component` records the contract's stated economic expectation: monthly,
annual, per visit, hourly, per unit, flat, variable, or another described basis.
It is not an invoice, accrued expense, cash payment, or normalized portfolio
comparison.

`financial observation` records that a named source associated an amount with a
service or provider for a stated period. Accounting report, underwriting model,
budget and invoice remain distinct source kinds. An observation can expose a
service whose governing agreement is missing. It does not establish payment or
contract terms.

`decision milestone` is derived from a governed term and an as-of date. Notice
deadline and term end remain separate. A passed notice deadline with no retained
renewal or termination outcome is `OUTCOME_NOT_ESTABLISHED`; Spine does not infer
that nobody sent notice and does not silently declare an automatic renewal.

## Opening-truth contract

The first truthful read may contain any of these without manufacturing the
others:

- a required service with no selected provider;
- a provider and recurring invoice with no governing agreement;
- an unsigned proposal with offered scope and price;
- an executed agreement whose current successor term is not established;
- an executed event-anchored agreement whose trigger date is not established;
- a governed current term with no accountable owner for the next decision;
- an accounting line with no mapped engagement;
- a retained service document that is not yet linked to an engagement;
- an in-house or not-applicable determination with its basis.

Property-wide setup is `established` only when a current coverage review exists
and every reviewed contracted requirement has a governed engagement, current
scope, governing term, and accountable milestone disposition. Otherwise it is
`partially_established` or `not_established`, with exact unresolved questions.

## Truth walls

The executable declaration is `src/asset/contracted_service_contract.js`.

```text
financial expense line != executed service contract
budget or underwriting assumption != contractual commitment
invoice != governing agreement
invoice amount != contracted price
invoice amount != accrued expense
invoice amount != amount paid
vendor payee != contractual provider identity
provider identity != legal entity identity
provider relationship != one specific engagement
service category != scope of work
proposal != executed agreement
partially executed != executed
file in Current Contracts folder != current governing contract
document effective date != proof of execution
term end != notice deadline
automatic-renewal clause != confirmed renewal outcome
passed notice deadline != confirmed renewal
scheduled service != completed service
service report != contracted scope satisfied
certificate of insurance != active service agreement
certificate of insurance != current insurance coverage
contracted service != utility service topology
contracted service != compliance standing
contracted service != maintenance work execution
contract price != accounting actual
one provider != one contract
property agreement != portfolio master agreement
missing agreement != no agreement exists
NOT_ESTABLISHED != not applicable
```

## Domain boundaries

- Utilities owns utility service declarations, provider accounts, service points,
  meters, responsibility and provider statements. Contracted Services may own
  the waste-removal or utility-services agreement, but it cannot establish the
  utility topology.
- Compliance owns licenses, inspections, certificates, violations and regulatory
  standing. A fire-alarm inspection contract does not establish that an
  inspection occurred or that the property is compliant.
- Maintenance owns work orders, service events and proof of completed work.
  Contracted Services owns the standing economic and contractual expectation and
  may later reference Maintenance execution.
- Accounting owns recognized expense, payable and settlement. Contracted
  Services may retain contract price and financial observations but may not call
  either paid or actual accounting expense.
- Insurance owns coverage. A vendor COI remains evidence about a service provider
  and cannot establish the property's insurance standing.

## Capability claim

The first slice claims governed retrieval: current service engagements, source
authority, scope, stated price, term, notice milestone, important unknowns and
unmatched retained documents and financial observations. It does not claim
portfolio normalization, vendor-performance scoring, savings opportunity,
automatic-renewal outcome, causal explanation, or payment standing.
