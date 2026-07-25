# Property Spine — Design Principles and Product Philosophy

This document governs how Property Spine should be designed, evaluated, and built.

It is not a list of stylistic preferences. It defines what the product is, what it must protect, and how to determine whether a proposed feature belongs in the system.

> **Read this governing doctrine before modifying product behavior.**

---

## 1. The North Star

**Record the truth at the moment of work, so reporting becomes a read, not a reconstruction project.**

Property operations usually happen through calls, texts, emails, spreadsheets, bank transactions, vendor conversations, and human memory. The formal record is created later, often at month-end, after context has been lost.

Property Spine closes that gap.

The intended sequence is:

```text
work happens
→ a claim enters Property Spine
→ context is recognized
→ a human confirms what requires judgment
→ proof is attached
→ obligations route to accountable people
→ exceptions remain visible
→ the manager signs off
→ the reporting package is generated
```

The system should reduce the time between real work and recorded truth.
It should not merely digitize the existing administrative burden.

## 2. The Product Promise

**Property Spine should make the building understandable to the person responsible for it in under three seconds.**

The operator should immediately understand:

```text
what is happening
what is uncertain
what belongs to them
what must happen next
```

They should not have to understand:

```text
database schemas
internal modules
event projections
routing rails
accounting classifications
migration history
system architecture
```

The engine may be complex.
The handle must remain simple.

## 3. The Product Integrity Test

Every feature, screen, workflow, and automated behavior must pass these seven tests:

1. Does it reduce the time between real work and recorded truth?
2. Does it reveal uncertainty rather than hide it behind a status?
3. Does it preserve context so the user does not re-enter what Spine should already know?
4. Does it ask for human judgment only where judgment is actually necessary?
5. Does it identify one accountable next action without inventing ownership?
6. Can the user understand the situation and act without learning the schema?
7. Does it make the eventual report more of a read and less of a reconstruction?

The hard rejection test is:

> If a feature makes Property Spine look more like conventional property software but does not make the building more truthful, do not build it.

## 4. Truth Is the Product

Property Spine is not primarily a dashboard, CRM, task manager, accounting interface, or leasing chatbot.

Its product is **trustworthy operating truth.**

Every fact begins as a claim.
A claim becomes institutional truth only when it is tied to proof, confirmed by an authorized human, or produced by an authoritative source under a governed process.

The system must preserve the distinction between:

```text
asserted
observed
scheduled
expected
confirmed
proved
corrected
resolved
```

These are not interchangeable states.
A status should never imply more certainty than the underlying evidence supports.

## 5. Honest Blank Beats Confident Wrong

Property Spine must never fabricate certainty to make the interface feel complete.

Never fake:

```text
a number
a status
an owner
a dispatch
a completed action
a healthy state
a proof record
a successful integration
a clean operating path
```

When information is missing, show that it is missing.
When the system is unavailable, say it is unavailable.
When no eligible owner exists, show `UNASSIGNED`.
When the system has a recommendation but has not acted, show the recommendation as a recommendation.

Examples:

```text
Ready to Apply
≠ Application Sent

recommended vendor
≠ vendor dispatched

scheduled host
≠ verified actual host

proposed concession
≠ governed commitment
```

An honest gap protects trust.
A believable fiction destroys it.

## 6. Claim Before Truth

All new information should enter Property Spine with appropriate provenance.

A durable fact should retain:

```text
source
source record ID
occurred time
recorded time
actor
verb
claim strength, where relevant
```

Corrections do not erase history.
A correction should preserve:

```text
the prior record
the corrected record
the correction actor
the correction time
the reason
the relationship between the two records
```

Current reads may update.
Historical truth remains auditable.

## 7. Capture Once, Read Everywhere

A real-world action should be recorded once through its canonical domain service.
That one write should update every relevant read surface.

```text
domain action
→ durable domain object
→ immutable event or history record
→ operating board projection
→ Person Card projection
→ reporting projection
```

The user should never separately update the board, Person Card, and report.
The capture surface gathers context and invokes the service.
The service owns the business meaning.
The browser does not own the truth.

## 8. Recognition Over Re-entry

Nothing should open blank when Property Spine already knows the relevant context.

The system should recognize:

```text
the person
the property
the relationship
the current conversation
the open obligation
the recent event
the expected financial consequence
the next likely action
```

The experience should feel like a relationship continuing, not a form restarting.

The system should collapse seams that are unnecessarily separate in conventional software:

```text
application link
→ application plus identity proof

form
→ conversation channel

normal work
→ operating record

capture
→ durable truth
```

Context should travel with the work.

## 9. Human Attention Is the Scarce Resource

Property Spine may capture a large amount of information.
It should interrupt the human only when human judgment is genuinely required.

The sequence is:

```text
capture automatically
→ recognize context
→ resolve what can be resolved safely
→ ask for confirmation only where consequence, ambiguity, or money risk requires it
```

Do not ask users to confirm facts the system already knows.
Do not require manual classification merely because conventional software does.
Do not create administrative work to prove that Property Spine is doing work.

The product must not recreate the bureaucracy it is intended to replace.

## 10. One Accountable Human

Every open obligation must have exactly one accountable human or be explicitly `UNASSIGNED`.
Never invent ownership to make a queue look organized.

Keep these concepts distinct:

```text
user account
durable person
authenticated actor
property-team member
active work assignment
task owner
scheduled host
actual-host claim
completion actor
```

They may refer to the same human in a particular case, but they are not the same system fact.

Accountability means someone has the authority and capacity to act.
It is not a mechanism for assigning blame.

Every ownership model must include:

```text
visible capacity
coverage
handoff
recovery window
escalation
```

The signal should move when a commitment is missed, rather than waiting for someone to raise the problem manually.

Escalation is not failure.
Missing the recovery window is failure.

## 11. The Obligation Engine Is the Operating Core

Captured events create obligations.
Obligations route through the authority graph:

```text
task type
→ eligible assignment
→ active coverage
→ escalation rules
→ one accountable human
```

When no eligible owner exists:

```text
→ UNASSIGNED
```

An obligation is not merely a task row.
It represents something the property now requires from a human.

The obligation engine should govern:

```text
follow-ups
handoffs
corrections
operating exceptions
money decisions
approval requirements
recovery windows
closures
reopens
reassignments
```

Open work must not disappear inside conversation history.
A shared board is shared to see.
Ownership is named to do.

## 12. Relationship Truth Is Person × Property

A person is durable.
A property relationship evolves.

The core read is:

```text
Person × Property
```

The relationship may progress through:

```text
lead
→ tour
→ application
→ lease
→ resident
→ communication
→ maintenance
→ balance
→ renewal
→ move-out
```

Housing relationships can repeat over a lifetime.
Do not collapse identity into a single flat person-property row.

A phone number, name, or email may be evidence of identity.
None of them may silently:

```text
create a durable person
merge two humans
prove staff identity
grant property authority
```

Identity must remain deliberate, durable, and correctable.

## 13. The Person Card Is Relevance, Not a Dossier

The Person Card is an attributed relationship read between one person and one property.

It should answer:

```text
what was said
what happened
what is known
what must happen next
```

It is not:

```text
a generic profile form
a generic timeline writer
a surveillance record
everything the company knows about a person
```

The Person Card has three bands:

```text
RELATIONSHIP
live conversation and working context

NEXT
the one or two obligations or decisions that matter now

HISTORY
attributed events in chronological order
```

`NEXT` appears before the full history.
Past, planned, due, and completed remain different truths.
A future obligation must not be rendered as if it already happened.

Messages, tours, applications, outcomes, offers, leases, obligations, and corrections may appear in one relationship spine, but each remains its own source-system object underneath.

## 14. Money Is a Layer Through the Work

Money should not be separated into a disconnected accounting room.
It is a layer running through Management, Leasing, Maintenance, and Reporting.

Field users should see plain operating language:

```text
Home Depot
$48.20
plumbing for Work Order #1042
Confirm?
```

They should not be forced to think in:

```text
GL codes
journal entries
ledger classifications
accounting abstractions
```

Distributed confirmations should funnel upward:

```text
operating work
→ contextual confirmation
→ unresolved money exceptions
→ manager review
→ sign-off
→ generated reporting package
```

The money engine should identify whether something:

```text
happened as expected
needs interpretation
should have happened but did not
falls outside the normal pattern
```

Major money decisions—including forgiveness, write-offs, and capital classifications—must use the same obligation, proof, attribution, and history discipline as other consequential work.

## 15. NOI and Exposure

Property Spine should ultimately present two headline truths for each property:

```text
NOI
→ proven operating result

Exposure
→ how much of the financial story remains unproven
```

Exposure is not failure.
Exposure is honesty.

Exposure must never become a vague red, yellow, or green score.
Wherever Exposure appears, it should explain:

```text
what specifically remains unproven
how much money is implicated
who owns the next action
what proof would resolve it
how long it has remained unresolved
whether it changes reported NOI
or only confidence in reported NOI
```

A status that users learn to manage cosmetically is not truth.

## 16. Reporting Is an Output Gate

Reporting is not merely another dashboard.
The report is the final read of operating truth.

The sequence is:

```text
work is captured
→ exceptions remain visible
→ supporting proof is attached
→ obligations are resolved or acknowledged
→ manager reviews
→ manager signs off
→ manager presses GENERATE
```

Generate is a governed act.
The report is closed by a human.
The system should make month-end reporting increasingly mechanical because the truth was recorded throughout the month.

## 17. One Canonical Architecture

Property Spine has one operating architecture.
It may have multiple isolated data contexts:

```text
production
Demo Building
controlled internal QA
integration testing
local development
offline preview
```

Those contexts may differ in data and deployment.
They may not differ in product meaning.

They must preserve the same:

```text
domain model
staff identity model
property authority model
canonical service layer
event and audit history
ownership resolver
API semantics
read projections
signed-in operator behavior
```

Demo data may exist.
Demo paths may not.

A tour cannot mean one thing in production, another thing in Demo Building, and a third thing in fixtures.
A temporary shortcut must never become a second product.

## 18. Classify Every Component

Before building any meaningful component, classify it:

- **Class 1 — Permanent product primitive.** A durable part of the real product architecture.
- **Class 2 — Temporary adapter.** A temporary bridge with a named and testable replacement condition.
- **Class 3 — Test or demo infrastructure.** Infrastructure that remains outside the signed-in operator workflow.
- **Class 4 — Delete-on-activation scaffolding.** A temporary mechanism that must be removed when the canonical operating path is activated.

No meaningful workflow may contain an unclassified parallel path.

For every temporary component, answer:

```text
What exact condition causes this to be removed?
```

Convenience is not a replacement condition.

## 19. Live-First Operator Experience

Every signed-in operator screen must read and write live, property-scoped truth through canonical services.

For every live surface:

```text
live records exist
→ render live property-scoped truth

live records are empty
→ show an honest empty state

live request fails
→ show unavailable and retry

never
→ substitute fixtures
→ mint a demo session
→ switch properties
→ show believable sample data
```

Offline preview is legitimate only as a separate, clearly marked developer or sales harness.
It may use fixtures.
It may not share a live operator session or make live operating writes.

A signed-in operating application never falls back to fiction.

## 20. The Four Live-First Seams

Live-first is not one global switch.
It is four independently verifiable seams:

```text
S1 — identity
Who is the operator?

S2 — authoritative property scope
What property may they operate?

S3 — live data source
Does this particular surface use the canonical live service?

S4 — honest empty and failure behavior
Does this surface show absence and failure honestly?
```

The order is mandatory:

```text
S1
→ S2
→ S3 per surface
→ S4 for that surface
```

S3 and S4 should be completed one surface at a time.
Do not globally disable offline behavior before the relevant surfaces have live reads and honest failure states.

One seam changes.
Browser behavior is verified.
Then the next seam may begin.

## 21. Server-Derived Identity and Authority

The browser may request an action.
It may not determine authority.

The server must derive and validate:

```text
authenticated actor
role
authorized property
property-team membership
module entitlement
task eligibility
session validity
```

A client-provided property ID is never authority.
The app shell, property name, modules, reads, and writes must all agree with the same server-authoritative context.

The forbidden state is:

```text
Solo chrome
→ another property's data
```

That is not merely a visual defect.
It means the authority model is not driving the experience.

## 22. Solo-First, Never Solo-Special

Solo on Chestnut is the first activation target.
It is not a special branch of the product.

Solo-specific information belongs in:

```text
property configuration
property branding
property-team assignments
module entitlements
unit and space configuration
property timezone
activation capability
```

It must never appear as special business behavior such as:

```text
if property is Solo
→ behave differently
```

A feature that only works through Demo Building is not ready for Solo.
A feature that works only because of a hardcoded Solo branch is not canonical.

The goal is to prove the general architecture first on Solo.

## 23. Foundations Before Features

Real features must not be built on fake beginnings until those beginnings become load-bearing.

The three real beginnings are:

```text
1. real staff authentication and property entitlement
2. real person or lead entry
3. real tour creation and booking
```

The required sequence is:

```text
real staff session issuance
→ server-authoritative property scope
→ controlled Solo internal-QA lead entry
→ live read and honest-empty behavior per surface
→ canonical Solo tour booking
→ tour completion
→ Follow-Ups
→ conversation
→ Person Card
→ attributed history
```

Do not use a seed-created person or tour to avoid implementing the real beginning of the lifecycle.

Controlled QA records should enter through the same canonical services as real records and be centrally classified.
They should be excluded where appropriate from:

```text
outbound communication
prospect outreach
reporting
leasing metrics
AI prompts
automated decision rules
```

Safety should be achieved through governed classification, not through a second runtime.

## 24. AI Philosophy

The AI should be:

```text
warm
brief
human
evidence-grounded
```

It should sound like a capable person, not a brochure or an internal system.
It may use known property facts, operating context, prior commitments, and observable patterns.

It must never invent:

```text
an operating fact
a dispatch
an available unit
an owner
a commitment
a price
a policy
a completed action
```

When evidence is insufficient, the AI should say so or hand off.
The AI should not make opaque character judgments about prospects, residents, employees, or vendors.
It should assist with context and action.
It should not become an unaccountable source of truth.

## 25. Navigation Philosophy

The north star is not a fixed number of modules.
The north star is immediate comprehension.

Four is the ceiling for an unprioritized decision screen.

A screen may contain more than four items when:

```text
one item is clearly primary
or
the items form a natural sequential workflow
```

Five or more equal choices means the hierarchy is wrong.
The system should perform the sorting before the user arrives.

Navigation should use clear doors into progressively more specific work.
Avoid presenting the full organizational or database structure as navigation.

## 26. Interface Feel

The visual and interaction standard is:

> **Quiet enough to think. Clear enough to act. Honest enough to trust.**

Minimalism means compression, not emptiness.
Whitespace should improve comprehension.
Whitespace that hides truth is a defect.

Avoid:

```text
busy dashboards
tiny metrics everywhere
loud colors
decorative clutter
long labels
explanatory walls of text
generic enterprise-software styling
empty space without hierarchy
nested bordered cards
```

Prefer:

```text
one leading truth
clear hierarchy
hairline divisions
plain labels
verb-first actions
progressive disclosure
full detail only when needed
```

Every page should be understandable in under three seconds.

## 27. Established Visual Language

Typography:

```text
Fraunces
→ headers and hero numbers

IBM Plex Sans
→ body copy

IBM Plex Mono
→ labels and data
```

Base styling:

```text
white backgrounds
near-black ink
hairline rules
status colors used sparingly
```

Established components include:

```text
command-card doors
mini-breakdown stat grids
hairline divider rows
one hero metric
stage badges
iMessage-style conversation threads
quiet attribution
three-band Person Card
verb-first history rows
progressive-disclosure capture sheets
full-page management surfaces
```

Do not nest bordered cards inside bordered cards.
Do not use double headers.
Do not let decorative structure compete with operating truth.

## 28. Action Language

Actions should be short, concrete, and verb-first.

Preferred field handles include:

```text
Confirm
Assign
Fix
Escalate
Sign
Generate
```

After every consequential action, show a plain-language receipt containing:

```text
what happened
the durable record ID
the important numbers or facts
what happens next
```

A button label must describe the action that will actually occur.
Do not label a recommendation as a dispatch.
Do not label an assertion as proof.
Do not label empty data as a healthy state.

## 29. Data-Model Principles

The following distinctions are load-bearing:

**Inventory first.** The rentable unit or bed is the primary inventory atom. By-unit versus by-bed behavior belongs in property configuration, not separate product branches.

**Physical state and tenancy state are distinct.** Do not collapse occupancy and readiness into one flat status.

**Future residents are not current occupancy.** Lease intent must not alter current occupancy denominators.

**Gross remains gross.** Receivables, delinquency, and exposure remain gross. Credits are shown separately.

**Identity is address, not display name.** Stable IDs must survive renames, rebrands, and collisions.

**Conversation truth has separate axes.** Keep distinct:

```text
commercial state
waiting on
control mode
delivery state
```

Intent and delivery are separate facts.

**Lifecycle authority is separated.** Keep distinct:

```text
terminal opportunity status
close and reopen history
current queue position
```

**Contractual schedule is not cash forecast.** Forward Rent Roll remains a dated contractual schedule. Concessions are dated schedule lines, not loose flags.

## 30. Build Philosophy

Build one narrow, real, vertically complete slice at a time.

The standard sequence is:

```text
design discussion
→ scope agreement
→ inspect current source
→ confirm current schema and runtime
→ classify every component
→ implement one canonical slice
→ prove against real Postgres
→ prove through real HTTP
→ verify in the browser
→ preserve a run receipt or screenshot
```

Do not build from stale handoffs.
Do not treat old migration numbers as deployment authority.
Do not replace a large file merely because it is large.
Do not create a second frontend merely because the current frontend is difficult to work in.

Preserve durable kernel work unless current evidence proves it is wrong.

The goal is not architectural beauty in isolation.
The goal is a truthful operating path.

## 31. The Eight Questions Before Any Feature

Before implementing a feature, answer in plain English:

1. What real-world fact is being recorded?
2. What canonical service records it?
3. Who is the authenticated actor, and what property can they operate?
4. What durable object changes?
5. What immutable history remains afterward?
6. What other surfaces read this truth automatically?
7. What happens when ownership, proof, or live data is missing?
8. What class is every new component, and what removes any temporary part?

If these questions cannot be answered, the feature is not ready to build.

## 32. Stop-Sign Phrases

Stop and reassess whenever a proposal includes:

```text
"It only works in demo mode."
"We will wire it to the real path later."
"This is a temporary alternate endpoint."
"It falls back to sample data when the API fails."
"We can clean up the history after the demo."
"We only need this special case for Solo."
```

Each phrase indicates a risk of creating a second product meaning or parallel runtime.
Temporary work is permitted only when it is explicitly classified and has a concrete replacement condition.

## 33. Definition of Done

A feature is not complete because:

```text
the source exists
the route compiles
the migration was written
the static page looks correct
the fixture demonstration works
```

The appropriate proof levels are:

```text
Reported
→ claimed in a handoff but not independently verified

Locally exercised
→ source inspection, fixture use, mock, or static test

Built but dormant
→ code exists but no real path invokes it

Proven
→ real database, real service, and real HTTP behavior with evidence

Browser verified
→ the actual user path was clicked and observed
```

Do not call something live, deployed, or enforced without the corresponding evidence.
For operator workflows, browser verification is part of completion.

## 34. Codex Operating Instructions

When working on Property Spine:

1. Read the governing doctrine before modifying product behavior.
2. Inspect the current repository source rather than relying on stale copies or handoffs.
3. Confirm the live schema and migration state before applying database changes.
4. Preserve existing durable primitives unless direct evidence shows they are incorrect.
5. Identify the single real-world fact the slice records.
6. Find or define the one canonical service that owns that fact.
7. Keep authentication, property authority, ownership, and attribution server-derived.
8. Keep product behavior identical across production, Solo, Demo Building, and controlled QA.
9. Never introduce fixture fallback into a signed-in operator workflow.
10. Never create a Solo-specific business branch.
11. Classify all temporary work and state the exact removal condition.
12. Write the durable fact once and update boards, Person Cards, and reports through projections.
13. Preserve append-only history and explicit corrections.
14. Show uncertainty, absence, failure, and unassigned work honestly.
15. Change one independently verifiable seam at a time.
16. Prove the slice against real data and real HTTP behavior.
17. Verify the final path in the browser.
18. Report what is proven, what remains uncertain, and what should happen next without overstating completion.

## 35. Final Standard

Property Spine is an operating funnel expressed as clear doors.

Work happens.
Structured truth is captured once at the moment of work.
Every read updates from the same source.
Obligations route to one accountable human or remain honestly unassigned.
Money is confirmed in context as a layer through the work.
Uncertainty remains visible.
The manager reviews the actual operating story, signs it, and presses Generate.

The product reaches production through one canonical, browser-proven vertical slice at a time—without demo paths, fixture fallback, invented ownership, special property branches, or a second meaning of truth.

**One Property. One Truth State. One Next Action.**
