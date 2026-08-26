# Property Spine — Money Thesis

**Owner's working draft, recorded verbatim 2026-08-03.**
Committed so the handoff can point at it and every thread reads the same text.
It is doctrine-in-progress: it governs, and it is still being sharpened.

---

## The outputs are not the innovation.

Property Spine is not trying to invent a new rent roll, a new T-12, or a new
financial statement.

Institutional owners already understand those outputs. They must remain familiar,
auditable, and capable of producing the same level of reporting expected from
Yardi, Entrata, RealPage, and institutional accounting teams.

**The innovation is how those outputs are created.**

## Conventional property software starts with accounting.

Most property management systems begin when an invoice, payment, journal entry,
or accounting document enters the system.

Operations happen first.
Accounting reconstructs them afterward.

That reconstruction is where enormous amounts of administrative work, delayed
reporting, and uncertainty are introduced.

## Property Spine starts with responsibility.

**The fundamental unit is not a transaction. It is an accountable human
performing an operational action.**

Every day, hundreds of small actions occur across a property:

- ordering supplies
- approving a vendor
- completing a turnover
- signing a lease
- granting a concession
- collecting rent
- resolving delinquency
- completing a work order
- paying a utility bill

These are not accounting events. They are operating events performed by people
who already know they are responsible. Property Spine simply captures those
actions in context.

## Accountability is the operating system.

Every meaningful action already has someone responsible for it.

The software should make that responsibility visible, guide the work, collect the
minimum proof required, and identify the next accountable person when necessary.

The system is not attempting to record events independently of the people
performing them. It records **responsibility, action, confirmation, and
consequence.**

## Financial reporting becomes a byproduct.

As operational work is completed, the financial consequences naturally emerge.

```text
a completed turnover    → creates costs
a signed lease          → creates future revenue
a concession            → changes expected revenue
a completed repair      → validates related spending
collected rent          → changes cash and receivables
```

The accounting is no longer reconstructed after the fact. **It is derived from
the work itself.**

## Cash versus accrual is an output choice.

Operators perform the same work regardless of accounting basis. The property does
not behave differently because a report is cash or accrual. Those are reporting
treatments applied to the same underlying operational truth.

Property Spine should therefore focus first on capturing operational truth
correctly. The reporting engine determines whether that truth is expressed as
cash or accrual.

## The guiding principle

Property Spine is not building a better accounting system. It is building a
**better operating system whose disciplined daily actions naturally construct
institutional-grade financial reporting.**

The goal is simple:

> If every responsible person performs and confirms their work inside Spine, the
> rent roll, the T-12, and the financial statements should largely build
> themselves.

---

# What this forces on the build

Derived, not decorative. These are the constraints the thesis imposes.

## 1. Capture must be basis-agnostic

**Cash vs accrual is an output choice**, so any capture surface that forces an
accounting treatment at the moment of work is a defect. If completing a work
order ever required declaring capex/opex or recognise-now/recognise-later, an
output choice would have been pushed into capture — the exact inversion this
thesis rejects.

**Add to the Eight Questions habit:** *does this capture force an accounting
basis?* If yes, it is wrong.

## 2. Attribution is what makes a derived number auditable

If reporting is derived from operational actions, then *who performed the action*
must survive on the durable object. A derived figure whose originating action has
no accountable human is not auditable — it is a reconstruction wearing a
different costume.

This is why `BLOCKING_DESIGN_ITEMS.md` **ITEM 2** — `conversation_owner_user_id`
conflating attribution with ownership — sits in the money path rather than beside
it.

## 3. Exposure (§15) is the honesty valve for derivation

Derivation is only safe if what is *not* captured is visible. The gap between
"work happened" and "work recorded with proof" must surface as **Exposure**: a
first-class, itemised number with an owner — never a red/amber/green score, which
is something people learn to manage rather than resolve.

## 4. A receipt is a confirmation, not a courtesy

The receipt is the step that makes an operational event institutionally true, and
that truth is what the financial derivation reads. See
`docs/AGENT_CAPABILITY_SEAMS.md` seam 6 — currently transport-co-located, and
more important than that classification alone suggests.

## 5. Un-attributed writes are not a hygiene problem

If financial reporting derives from operational records, a script that writes an
un-attributed work order, lease or obligation into production is not polluting a
table. **It is injecting a fabricated operating event into the substrate the T-12
is built from.** A synthetic lease becomes future revenue. A synthetic work order
becomes cost. Nobody performed that action, nobody is accountable for it, and it
carries no proof — yet it derives into a number an investor reads.

That is what raises the stakes on `docs/DB_HARNESS_ISOLATION.md`: the remediation
slice is not test hygiene, it is protecting the integrity of the derivation.

## 6. The conversation never invents the accounting treatment either

`AGENT_CAPABILITY_SEAMS.md` says the conversation never invents the work, its
priority, its owner, or its completion. This thesis adds one clause: **nor its
accounting treatment.** A technician texting "done, $48.20 at Home Depot" is
capturing an operating fact with a cost attached — not making a journal entry
(§14).

## 7. Planning is a downstream composition, not another money writer

The eventual Operating Plan, approved budget and live forecast consume governed
Money and operating facts without taking ownership away from their source
domains. Their retained design contract, sequencing gate, completeness
vocabulary and required Money-build receipt question live in
[`BUDGET_FORECAST_NORTH_STAR.md`](BUDGET_FORECAST_NORTH_STAR.md).

That North Star is active doctrine and **not** an active implementation lane.
Until Skyline is operating and Money Build 4 is complete, there is no budget
table, forecast writer, Budget & Forecast API, fifth Asset Management room or
dead navigation control.

## 8. An execution provider enforces; it does not decide

An actuator such as Ramp may enforce a governed spending mandate, move money and
return provider evidence. It does not become the source of business purpose,
liable entity, repair-versus-CapEx treatment, recognition period, budget or
forecast merely because its card, Fund, approval or coding fields can carry those
values.

The technician records the operating fact and evidence. Property Spine records
the authority-backed economic decision. The provider returns authorization,
clearing, settlement, refund and receipt facts as separate dated evidence.

The complete boundary, unresolved vendor questions and build stops live in
[`RAMP_ACTUATOR_ALIGNMENT.md`](RAMP_ACTUATOR_ALIGNMENT.md). It is doctrine and
not an active Ramp implementation lane.
