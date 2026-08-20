# Property Spine — Design Principles and Product Philosophy

This document governs how Property Spine should be designed, evaluated, and built.

It is not a list of stylistic preferences. It defines what the product is, what it must protect, and how to determine whether a proposed feature belongs in the system.

> **Read this governing doctrine before modifying product behavior.**

---

## 1. The North Star

**Record the truth at the moment of work, so reporting becomes a read, not a reconstruction project.**

The same sentence has a second consumer, and it is the same sentence:

> **Spine records truth so that operating, reporting, and asking are all reads
> of the same system.**

Operating, reporting and asking are not three products over three datasets. They
are three readings of one record — which is why the question a person will ask
is a design input to the schema, not a feature request against it (§31, §40).

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

How an economic consequence accumulates—and why cash and accrual are two
readings rather than two realities—is in §39.

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

Exposure is not only a headline. The per-item contract every unresolved
consequential item must satisfy is in §38, along with the separation of
recorded fact from derived attribution.

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
How will the system or release process notice when that condition becomes true?
```

Convenience is not a replacement condition.

**A removal condition without a mechanism that notices when it has become true is a promise, not a control.** For a Class 2 or Class 4 component, the replacement condition should have an executable gate where practical. Where a gate would be disproportionate, name the release or audit checkpoint that must re-evaluate it. A load-bearing temporary adapter may not become permanent merely because nobody remembered to reread its comment.

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
state the product intention
→ inspect current source and relevant history
→ run the existing path as far as it will go
→ identify the first actual break
→ confirm current schema and runtime around that break
→ scope the smallest correction
→ classify any new component
→ implement through the existing canonical owner
→ prove against real Postgres
→ prove through the real HTTP entry path
→ verify in the browser
→ preserve a run receipt or screenshot
```

**When an existing path can be exercised, an observed first red outranks an inferred missing capability.** Do not design a replacement because a call site, route, column, or screen appears absent. Drive the path first. The running system may reveal that the capability exists one layer down and is merely unwired, stale, dormant, or blocked by a narrower defect.

Do not build from stale handoffs.
Do not treat old migration numbers as deployment authority.
Do not replace a large file merely because it is large.
Do not create a second frontend merely because the current frontend is difficult to work in.

Preserve durable kernel work unless current evidence proves it is wrong.

The goal is not architectural beauty in isolation.
The goal is a truthful operating path.

## 31. The Eight Questions Before Any Feature

Before implementing a feature, answer in plain English:

1. **What will an authorized person ask about this, and what must be recorded for
   that to be answerable?** Name the compact standing projection an entitled
   person gets when they ask for this domain without knowing where it lives
   (§40.1, §40.6). Say which capability class is being claimed — retrieval,
   comparison, causal explanation (§40.10) — and which are not.
2. What real-world fact is being recorded?
3. What canonical service records it?
4. Who is the authenticated actor, and what property can they operate?
5. What durable object changes?
6. What immutable history remains afterward?
7. What other surfaces read this truth automatically — the screen **and** Ask
   Spine? "The screen renders it" is half an answer.
8. What happens when ownership, proof, or live data is missing?
9. What class is every new component, and what removes any temporary part?

**Question 1 moved.** It was question 6, asked after the domain was designed —
and a question asked sixth is answered by whatever the schema already happens to
support. Asked first, it is a specification.

The build question inverts with it:

```text
WAS   what screen does Debt need?
IS    what truth must Debt record so that every authorized person can ask
      the natural questions they will have about it and get a governed
      answer?
```

The screen is then one useful projection of that truth, and the conversational
reader is another. Neither is the truth (§7).

They are still called the Eight Questions. The count is not the point.

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

The proof ladder is explicit. A higher rung may rely on lower-rung evidence, but it may never be named as though the higher rung was observed:

```text
Reported
→ claimed in a handoff or receipt but not independently verified

Locally exercised
→ an isolated service, fixture, mock, static test, or local function behaves as expected

Built but dormant
→ implementation exists, and may have passing tests, but no real application path invokes it

Wired / reachable
→ the actual application composition has a real entry path capable of invoking it

HTTP proven
→ the real entry door traverses the real server composition and real database with evidence

Browser verified
→ the actual user path was clicked and observed in a real browser

Deployed
→ the exact code and required schema exist in the deployed environment

Production proven
→ the deployed path itself was exercised and observed in production
```

**A service-level harness cannot earn HTTP-proven status.** The proof must enter through the real application door that is supposed to call the service. A component with passing tests and no caller is *Built but dormant*, not working product behavior.

Do not call something live, deployed, enforced, or production-proven without the corresponding evidence. For operator workflows, browser verification is part of completion. Deployment is not proof that the deployed path works; production proof requires observation there.

### Prose is a claim, not proof

Comments, module headers, handoffs, runbooks, paths, commands, and reproduction instructions describe intended reality. They are claims about the system, not an authority over its behavior.

When prose is safety-critical, workflow-critical, or used to tell the next person how to reproduce a proof, verify it against executable behavior before relying on it. A named path must exist. A command must run. A removal condition must still describe the live mechanism. If prose and behavior disagree, the disagreement is itself a defect; do not choose whichever version is more convenient.

### Read everywhere also means reconcile everywhere

When several surfaces read the same governed concepts, Definition of Done includes a reconciliation proof across representative and hostile states. Compare governed concepts, not wording. A Person Card, operator review, standing projection, reporting read, and Ask Spine envelope may compress differently; they may not disagree about the underlying fact.

A reconciliation gate must be falsified deliberately at least once before it is trusted. A green gate that has never been shown capable of going red is evidence of nothing more than a green run.

### A domain is not done until Ask Spine can read it

```text
A CANONICAL SPINE DOMAIN IS NOT COMPLETE UNTIL ITS GOVERNED STANDING STATE
IS AVAILABLE TO ASK SPINE FOR ENTITLED USERS.
```

A domain is not integrated because the application can display it. It is
integrated when a person can **ask** for it without knowing where it lives in the
application (§40).

The build sequence, and the order is load-bearing:

```text
canonical truth
  → writer
  → canonical read
  → compact standing projection
  → operator UI
  → Ask Spine registration
  → browser proof
```

Not: build the entire application, then months later teach a chatbot about it.

**Registration is a rung on the ladder, not a follow-up ticket.** A domain that
has been browser-verified in the operator UI but is not readable by Ask Spine is
at *Browser verified* for its screen and **not done** as a domain. Say it that
way in the receipt; "the UI is done" is a true statement about a surface and a
false one about a domain.

Every governed domain needs conversational **reads**. Not every module needs
conversational **writes** (§40.9). The standing projection is deliberately small —
current position, important unknowns, next action — so it is cheap enough to
gather routinely; richer detail is a second read, called only when the question
requires it (§40.6). A domain whose only read is "everything the screen needs"
cannot participate.

**This cost is part of building the domain.** It is not free polish afterward, and
it stays visible in estimates. A rule of this shape is exactly what gets quietly
dropped under schedule pressure, so it belongs here rather than in a build doc —
and `tests/gate_ask_spine_readers.js` enforces it so that it does not depend on
this paragraph being remembered (§40.11).

## 34. Codex Operating Instructions

When working on Property Spine:

1. Read the governing doctrine before modifying product behavior.
2. State the intended operator experience and the product boundary that must remain true.
3. Inspect the current repository source **and relevant history** rather than relying on stale copies, handoffs, or conventional-industry assumptions.
4. If an existing path can be exercised, **run it before designing**. Record the last green step and first actual red; observed failure outranks an inferred gap.
5. Confirm the live schema and migration state before applying database changes. Do not infer a production ledger from filenames or memory.
6. Preserve existing durable primitives unless direct evidence shows they are incorrect.
7. Identify the single real-world fact the slice records and the one canonical service that owns that fact.
8. Before adding a service, route, table, status, store, resolver, or workflow, prove why the existing owner cannot truthfully carry the need.
9. Keep authentication, property authority, ownership, and attribution server-derived.
10. Keep product behavior identical across production, Solo, Demo Building, and controlled QA.
11. Never introduce fixture fallback into a signed-in operator workflow.
12. Never create a Solo-specific business branch.
13. Classify all temporary work, state the exact removal condition, and state how that condition will be noticed.
14. Write the durable fact once and update boards, Person Cards, reports, and Ask Spine through governed reads/projections.
15. Preserve append-only history and explicit corrections.
16. Show uncertainty, absence, failure, and unassigned work honestly.
17. Change one independently verifiable seam at a time; after each fix, rerun the same path rather than switching to a new theory.
18. Prove reachability through the real application composition. Passing isolated tests do not prove the feature is callable.
19. Prove the slice against real data and the real HTTP entry path, then verify the final user path in the browser.
20. When multiple surfaces read the same concepts, reconcile them structurally and falsify the reconciliation test at least once.
21. Verify critical comments, paths, commands, and reproduction instructions before publishing them to the next thread.
22. Report proof levels separately: written, locally exercised, reachable, HTTP proven, browser verified, deployed, production proven.
23. Report what remains uncertain without overstating completion. If production was not observed, say so plainly.

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

## 36. The Layered Architecture

```text
                         PROPERTY SPINE

                    DEAL SETUP / SOURCE TRUTH
                              │
            Property · Rent Roll · Documents · Standing Facts
                              │
              ┌───────────────┴────────────────────────┐
              │                                        │
              ▼                                        │
                                                       │
                   OPERATING SPINE                     │
                                                       │
    LEASING           MANAGEMENT          MAINTENANCE  │
    ───────           ──────────          ───────────  │
    Leads             Rent Roll           Work Orders  │  standing facts
    Tours             Tenant Relations     Turnover    │  create consequence
    Applications      Occupancy            Vendors     │  with no operating
    Leases            Evictions            Supplies    │  event at all
                                                       │
              │                                        │
              └───────────────┬────────────────────────┘
                              ▼

                    ECONOMIC CONSEQUENCE

            What did the operating fact mean economically?
            What does simply holding this deal mean economically?

              Expense side              Revenue side
              ────────────              ────────────
              Repair cost               Rent earned
              Vendor cost               Vacancy loss
              Supplies                  Turn delay
              Taxes                     Concessions
              Insurance                 Collections
              Debt                      Lost/gained revenue
                              │
                              ▼

                             MONEY

             Expected · Actual · Billed · Settled
             Service period · Cash · Accrual · Banks

                              │
                              ▼

                          ACCOUNTING

              Recognition · AP/AR · GL · Reconcile
                    Close · Opening Accounting Truth

                              │
                              ▼

                          REPORTING

              IS · BS · T-12 · Rent Roll · AP · AR
                 Bank Recs · Debt · Issuance History

                              │
                              ▼

                  OWNER / INVESTOR SURFACE
                       OWNER COMPRESSION

                What changed?
                Why?
                What does it mean financially?
                What is uncertain?
                What needs my judgment?
                What will show up in reporting?
```

> ⚠ **CORRECTED 2026-08-11.** The bottom of this diagram previously read
> `ASSET MANAGEMENT / OWNER COMPRESSION`, which taught that Asset Management
> *is* the owner surface. **It is not.** Asset Management is the fourth
> **operating door** — staff/operator side, beside Leasing, Management and
> Maintenance — where the economic structure and performance of the property
> become operable. The owner compression is a **later, different audience**,
> potentially behind a different login. The layers above are unchanged; only
> the audience at the bottom was misnamed.
>
> ```text
> Property Management / Operations → Asset Management → Owner / Investment Team
> ```
>
> That is progressive economic context and compression, not one screen with
> different permissions. Asset Management appears in this stack **twice over**:
> as an operating door that reads and operates the layers above it, and as one
> of the producers of the truth the owner compression later consumes.

> Setup establishes the world.
> Operations records what happens — Leasing, Management, Maintenance and
>   Asset Management are the four doors where it is recorded.
> Economic Consequence connects the deal and its work to money.
> Accounting recognizes, classifies, reconciles and closes period truth.
> Reporting packages it.
> The Owner / Investor surface explains the deal to the owner.

### Economic consequence has two parents, not one

The most consequential thing in this diagram is the fork.

Economic consequence descends from **standing truth and operating events
alike**. A great deal of economic reality originates directly from facts
established at setup, with nobody performing any operating work:

```text
a lease earns rent as time passes
a note accrues interest and amortizes principal
a tax schedule produces a bill
an insurance contract produces a premium
a management agreement produces a fee
```

**Do not architect every dollar as requiring an operating event parent.**
An economic consequence relates to whatever actually caused it — a work
order, a lease, a note, a contract, or the passage of time under one of
them. A model that insists on an operating parent will either invent
phantom operating events for rent and interest, or leave the largest and
most predictable numbers in the deal outside the causal graph entirely.

### Accounting is not the source of truth

Accounting **recognizes, classifies, reconciles and closes**. It is a
governed reading of period truth, not the origin of it.

Proof lives with the source that produced the fact:

```text
an invoice           the vendor's document
a settlement         the bank
a rent obligation    the lease
a repair             the work order and its evidence chain
an approval          the human who gave it, dated and attributed
```

Domain truth and accounting projections remain separate (§7, §17). When a
reported number is questioned, the answer is the source — never "because
accounting says so."

## 37. Four Users, Four Compressions of One Truth

Property Spine has four users doing fundamentally different jobs.
They are not four permission levels on one screen.
They are four compressions of the same truth.

```text
STAFF         Do the work and tell Spine what happened.
MANAGEMENT    Coordinate the operation and resolve exceptions.
ACCOUNTING    Turn economic reality into governed period truth.
OWNER         Understand the economic story and make consequential decisions.
```

What each is actually asking:

```text
STAFF         307 needs another part.
              Tour completed. Resident paid. This repair is done.
              They should barely feel accounting.

MANAGEMENT    Why isn't 307 ready? Who owns it?
              Is the move-in at risk? Did we promise the resident something?
              Do I need to intervene?

ACCOUNTING    What was incurred? What was earned? What was billed? What was paid?
              What belongs in July? What reconciles?
              What needs an accrual or adjustment? What can I close?

OWNER         Are we making the money we should be making?
              Why are we ahead or behind? Is this temporary or structural?
              What changed since I last looked? Where is money leaking?
              What decision actually requires me?
              What can I confidently tell the lender or investors?
```

### One fact, four readings

One boring maintenance fact — *unit 307 isn't ready because the repair
uncovered another $1,840 of work* — must arrive at four people as four
different sentences:

```text
TECHNICIAN    307 · additional repair needed · part ordered

MANAGER       307 turn delayed · move-in in 4 days · KZ owns repair

ACCOUNTING    $1,840 vendor cost · July incurred expense · invoice pending
              repair/CapEx treatment needs confirmation

OWNER         307 move-in is at risk.
              4 days of rent exposure + $1,840 additional work.
              Management recommends approving the additional repair today
              rather than moving the resident.
              Decision needed.
```

Nobody re-entered anything. Nobody reconstructed the story at month end.
The expense, the vacancy consequence, the invoice, the work order, the
approval, the payment, the period treatment and the variance explanation
are already connected, because they were connected when they happened.

### The rule

This is §7 at a different altitude:

```text
One recorded fact is never re-entered for another user.
Later authority may add new governed meaning,
but never rewrites or duplicates the original fact.
```

Adding meaning is not duplication. This chain is three **different facts**,
each attributed to whoever had the standing to state it:

```text
technician observation            "vendor quoted $1,840"
→ manager economic confirmation   approved · charged to this turn
→ accounting recognition          July incurred · repair, not CapEx
```

Each is dated, attributed and immutable. None of them overwrites the one
before it. What is forbidden is asking a second human to re-enter a fact
Spine already holds so a different screen can display it.

### Compression is not censorship

Each reading speaks **first** in that user's decision language. Underlying
source vocabulary appears when it is needed for explanation or drill-down.

```text
DEFAULT      say it in the language of the decision this user is making
ON DEMAND    the source vocabulary, whenever it explains the number
```

A maintenance manager may legitimately need to know that work is *not
approved* or that *budget impact is pending* — that is economic vocabulary
in an operating surface, and it belongs there because it changes what they
do next. An owner tracing a variance will legitimately end up looking at a
work order.

Compression decides what is said first, not what may ever be said. A
compression that withholds the truth underneath it is not compression; it
is censorship, and it breaks the traversal §38 depends on.

### The failure this section exists to prevent

The mistake is to build a nicer module per user — an owner-facing Leasing,
an owner-facing Maintenance, an owner-facing Accounting. That is still
property-management-software thinking. It is modules presented to a
different reader.

The owner does not care about the modules.
The owner cares about the deal.

**Different buttons on the same rows is permission, not compression.**
A surface that has never been asked a question in another user's language
has no evidence it could answer one.

> The staff operates the property.
> Management resolves the operation.
> Accounting proves the economics.
> The owner steers the deal.
> Spine makes all four views of the same truth.

## 38. The Owner Surface Is a Compressed Causal Model of the Deal

The owner surface is not a dashboard, not a task list, not a report viewer,
and not an onboarding wizard.

**It is also not Asset Management.** Asset Management is an operating door in
the staff product, where an asset manager *operates* the deal economically. The
owner surface is a later, different audience — potentially a different login —
that consumes the compressed story Asset Management and the other three doors
produce. Everything in this section describes that audience, not the door. Do
not build this surface into the Asset Management door.

At any moment it answers:

```text
What changed?
Why?
What does it mean economically?
What is uncertain?
What needs my judgment?
What happens next?
What will ultimately show up in the reporting?
```

This is the same philosophy the field person gets in §5 and §9 — *what is
happening, what is uncertain, what is mine, what I do next* — raised to the
altitude of the deal.

### Spine sorts the deal before the owner arrives

Do not give the owner a customizable cockpit with sixty widgets.
Have an opinion about what matters.

Simplicity here is hierarchy, not absence. The complexity does not go away;
the product absorbs it. The surface can be exceptionally calm precisely
because Spine is doing extraordinary work underneath.

### What changed

More important than another row of metrics:

```text
Leasing improved
11 leases signed this week. September occupancy now projected 94.2%.
+$31K monthly contracted rent

Turn costs increased
Four units required additional flooring work.
+$12.4K July expense · $7.1K supported · $5.3K awaiting invoices

Collections weakened
Delinquency increased $18.6K, concentrated in seven residents.
Management actions underway on five; two need decision.
```

The owner is looking at the building thinking — not at Leasing, not at
Maintenance, not at Accounting, but at the consequences of all three.

### Needs your judgment is not an inbox

This requires religious discipline. The owner does not see:

```text
invoice missing
resident needs callback
tech needs photo
rent-roll row unresolved
```

Those belong downstream and are solved underneath the owner.

The owner sees only what **owner authority or owner judgment changes**:

```text
Approve $22K unbudgeted chiller repair.
Decide eviction or payment agreement on material delinquency.
Accept management's recommendation to move $84K project into CapEx.
Approve lender reserve draw.
Decide whether August concession strategy should change.
Sign July package despite $13K of disclosed Exposure.
```

### The Exposure contract

Exposure is honesty, not failure (§15). Every unresolved consequential item
must be able to say, item by item:

```text
what it is about
possible magnitude, if known
why Spine cannot stand behind it
what would resolve it
when the uncertainty was observed
who owns resolution — or UNASSIGNED
```

An item that cannot answer these is not Exposure. It is a gap wearing
Exposure's name, and it will be managed cosmetically.

### No seam between the number and the story

An owner sees `Repairs +$38,420 vs budget`, and can walk it down to the work:

```text
+$38,420 vs budget
→ 14 events caused it
→ $7,800 · emergency plumbing · units 214/216
→ WO #1088 · vendor invoice · manager approval
→ accrued July 17 · paid August 3
```

Both directions must work:

```text
report → money → operating cause → human action → proof
proof → human action → operating cause → money → report
```

There is no seam between the number and the story. That is the Spine.

### Recorded fact and derived attribution are different kinds of thing

```text
$7,800 · emergency plumbing · units 214/216 · WO #1088   RECORDED
61% turnover delay · 24% weaker leasing                  DERIVED
```

The first happened and has an evidence chain. The second is the output of
an allocation model — an opinion with parameters that nobody recorded.

In a drill-down they sit two taps apart. If they look the same, Spine is
laundering a model as truth, at the altitude where the number goes to a
lender. §5 forbids this.

Derived attribution must be a visibly different class, and must name the
model that produced it — the way `UNASSIGNED` is a different class from a
person's name, not a disclaimer beneath one.

This matters most the moment Spine starts explaining variance. "WO #1088
cost $7,800" and "61% of the vacancy loss was caused by turnover delay" are
not the same kind of statement, and a surface that renders them identically
is a very convincing machine for producing confident nonsense.

### The package is the output contract, not the owner product

The full accounting package — balance sheet, income statement, T-12, GL,
trial balance, AP, AR, rent roll, deposits, bank recs, debt, management
fees, reconciliations — defines how rigorous the engine must ultimately be.

**Nobody wants to live inside that package every day.**

The owner interface makes the monthly package feel inevitable:

```text
Payroll is tracking $19K over plan because maintenance overtime increased
after three turns.
→ Two of those turns are complete. $11K supported; $8K remains unexplained.
→ Accounting accrued the supported portion into July.
→ July NOI is $27K below budget. $19K is operating performance.
  $8K remains Exposure.
→ July package ready for review. Two items need your sign-off.
→ GENERATE
```

That is a different product from opening a menu called Reporting (§16).

## 39. Economic Consequence Accumulates; It Does Not Advance

Money is not a fifth department beside Leasing and Maintenance. It is the
economic consequence layer underneath the deal and its work (§14, §36).

Every meaningful economic consequence must be able to accumulate a story:

```text
expected
happened
incurred / earned
billed
paid / collected
reconciled
reported
```

These are not a chain.

```text
One economic consequence accumulates multiple dated facts and
relationships. These stages are READINGS of that history,
not statuses on one row.
```

This is not pedantry. A single mutable status column cannot represent what
routinely happens:

```text
one invoice settled by three payments
a partial settlement that is never completed
a reversal, a credit memo, a re-bill
an accrual later trued up to a different actual
a payment that clears the bank after the period closed
```

Each of those is a **new dated fact related to the same consequence**. The
history is the truth; "billed" is a question you ask of it, not a state the
row is parked in.

Not every consequence reaches every reading. The structure is what matters.

```text
A repair is incurred in July and paid in August.
A resident owes July rent before the cash arrives.
A tax bill is expected months before it is invoiced.
A lender payment is contractually due, accrued, funded and settled
at four different moments.
```

### Cash and accrual are two readings, not two realities

Because the underlying history is truthful, an owner opening a financial
statement asks for `Accrual | Cash` and Spine gives two legitimate readings
of one deal.

That is categorically different from importing two reports and hoping they
reconcile. There is no cash/accrual configuration to maintain, because there
is only one set of facts.

### Every fact needs a durable causal hook

```text
A fact must leave a durable causal hook for economic meaning to
attach later.
```

A hook is identity and relationship — this fact, on this property, in this
unit, under this lease or note, caused by this work, observed by this
person, at this moment. Economic meaning attaches **to** the hook later, by
whoever has standing to add it. It does not have to live on the operating
row, and no operating surface should grow vendor and cost columns to
satisfy this.

This is the rule a shipped surface has already violated. A technician
reports *"more work required."* Spine records the reason, routes the
follow-up to an accountable role, writes an immutable event and ties the
follow-up to it. Clean, traceable, proven — and it can never become $1,840,
because there is no hook the vendor's invoice can attach to. When the
invoice arrives there is nothing to relate it to but an id and a date, and
someone reconstructs the story by hand. That is a second history, which is
the one outcome §7 exists to prevent.

### What the technician is, and is not, asked

```text
The technician is never asked to make the ACCOUNTING or ECONOMIC
determination. They are always free to report what they observed.
```

If the technician naturally knows something — *"vendor quoted $1,840"* —
Spine captures it as a **source observation**, attributed to them, dated to
the moment they said it. That is a fact about the world, and refusing to
record it would be its own dishonesty.

What the technician is never asked is what it *means*: expense or CapEx,
which period, whether it is approved, how it lands in the report. Authority
adds that meaning later, as its own dated fact (§37).

Honest blank still governs the magnitude:

```text
unknown cost is BLANK
never zero
never estimated into the record as though someone had said it
```


## 40. Ask Spine Is a Governed Interface, Not an AI Layer

§24 governs how the AI *speaks*. This section governs what it **is**.

Ask Spine is not a feature bolted onto Spine, and it is not a separate
intelligence that has to rediscover what Spine already knows. It is **another
reader of the same governed truth**, sitting beside the application rather than
on top of it.

```text
THE APP        the durable visual interface over Spine's truth
ASK SPINE      the conversational interface over the SAME truth
```

It never scrapes prose from a screen, retrieves over the rendered UI, or queries
arbitrary tables hoping to understand the schema. It calls the same server-side
canonical reads that produce the pages. Precedent: `dated_positions.js` —
*one service, four interpretations* — one altitude up.

**This section is a permanent interface contract of Property Spine, not a
description of a feature.** Ten rulings are frozen here, and an eleventh says how
they are kept. They are numbered so they can be cited:

```text
40.1   every domain has two primary readers
40.2   a domain is not complete until Ask Spine can read it
40.3   conversation is role-independent architecture
40.4   facts carry authority in their shape
40.5   truth walls are executable contracts
40.6   every domain exposes a compact standing projection
40.7   four silences remain distinct
40.8   entitlements precede intelligence
40.9   read capability is required; action capability is granted
40.10  retrieval and causal explanation are different capability classes
40.11  the rule is enforced by a gate, not by memory
```

### The rule that governs every implementation

```text
THE MODEL GETS FLUENCY OVER WORDING.
IT NEVER GETS AUTHORITY OVER ATTRIBUTION, SOURCE AUTHORITY, CURRENT STATE,
RELEVANCE, OR CONFLICT.
```

Everything load-bearing is decided server-side and handed to the model already
resolved. The model is a writer of things it was given, never a decider. A
surface that lets the model decide any of the five will eventually decide one of
them wrong, fluently, with a citation attached — and a confident wrong wearing a
citation is worse than a blank, because it reads as verified (§5).

### 40.1 Every domain has two primary readers

This is the shape every governed domain is built into. It is not an integration
diagram; it is the domain's own structure.

```text
                    CANONICAL DOMAIN TRUTH
                      durable · attributed · append-only
                              │
                              ▼
                     CANONICAL SERVICE
                      the one owner of business meaning
                              │
                              ▼
                    CANONICAL DOMAIN READ
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
            OPERATOR UI               ASK SPINE
       the durable visual         the conversational
        interface over it          interface over it
```

Same truth, two projections. Neither is privileged and neither derives from the
other.

**Ask Spine must never reverse-engineer a screen.** It does not scrape rendered
output, re-parse a page's prose, or reach around the canonical read into
arbitrary tables. A conversational layer that retrieves over the UI has made the
UI a source of truth, which §7 forbids at every altitude.

This is §7 — *capture once, read everywhere* — extended to say that "everywhere"
includes the conversation. A domain with exactly one reader has not proven it has
a canonical read at all; it has proven it has a screen.

### 40.2 A domain is not complete until Ask Spine can read it

```text
A CANONICAL SPINE DOMAIN IS NOT COMPLETE UNTIL ITS GOVERNED STANDING STATE
IS AVAILABLE TO ASK SPINE FOR ENTITLED USERS.
```

A domain is not integrated because the application can display it. It is
integrated when a person can **ask** for it without knowing where it lives in the
application.

The build sequence, and the order is load-bearing:

```text
canonical truth
  → writer
  → canonical read
  → compact standing projection
  → operator UI
  → Ask Spine registration
  → browser proof
```

Not: build the entire application, then months later teach a chatbot about it.

Registration is a step in the sequence, not a follow-up ticket. **This cost is
part of building the domain.** It is not free polish afterward, and it stays
visible in estimates. A rule of this shape is exactly what gets quietly dropped
under schedule pressure, which is why it is doctrine and why 40.11 makes a gate
enforce it rather than a memory.

### 40.3 Conversation is role-independent architecture

The same conversational interface serves every altitude of §37, and it is one
architecture rather than five products:

```text
TECHNICIAN         what needs doing, what did I record, what is waiting on me
LEASING AGENT      who is this person, where are they in the funnel, what next
PROPERTY MANAGER   what is at risk, who owns it, what missed its window
ASSET MANAGER      what does this cost, what is owed, what is not established
OWNER              what changed, what does it mean, what needs my judgment
```

Different authority, different scope, different verbs — **the same Spine truth
underneath**. What varies between them is entitlement and compression (§37), not
the source and not the architecture.

This is why Ask Spine cannot be built as a per-role assistant. A per-role
assistant is the same failure §37 names for surfaces: *"the mistake is to build a
nicer module per user."* Five conversational products over one truth is that
mistake in a new medium.

#### A screen is a pre-answered question

This is what the conversational reader is *for*, and why it is not simply another
interface.

Every screen is a guess about what someone will want to know, frozen into layout
at build time. That is a real service for the questions people ask constantly —
what is on my board, what is the rent roll, who is overdue. Pre-answering those
is worth doing.

```text
SCREEN        questions asked often enough that pre-answering is a service
CONVERSATION  the unbounded questions that emerge from actual work
```

The second set is larger, and it includes every question nobody thought to
anticipate.

Conversation is not the only surface that could serve four audiences from one
truth. It is the one that can do it **without pre-building four separate
interpretations of that truth** — because a screen must commit to an altitude
and a sentence need not. That is what makes §37 a property of the surface rather
than an aspiration maintained by discipline.

#### One agent, N role profiles

"Role-specific agents" is the right product intuition and the wrong structure.
Enumerate what a role actually needs its own rules for, and most of it turns out
to belong to something that already exists:

```text
information access     entitlement — §40.8, server-derived, NOT per-role
permitted actions      entitlement + §40.9              NOT per-role
confirmation           owned by the canonical writer    NOT per-role
privacy & disclosure   audience (§43)                   cross-cutting
escalation             the obligation engine (§11)      already exists
uncertainty            the four silences (§40.7)        universal by design

priorities             ← genuinely varies by role
interpretation         ← genuinely varies by role
```

Six of eight already have homes, and they are the security-relevant six. Only
**ranking** and **compression** vary.

So the shape is one engine and a small declarative profile per role — what this
role is trying to accomplish, how facts rank for them, which vocabulary leads.
Precedent in this repo: `dated_positions.js` — *"one service, four
interpretations."*

Six implementations of entitlement diverge six ways, and they diverge **silently**.

#### The agent layer is a meter, not just a layer

```text
If an agent needs logic the UI does not need, that logic is MISSING
FROM THE SPINE.
```

Agent thickness is a measurement, not a design choice. Every piece of reasoning
that accumulates in the conversational layer is a domain that failed to expose
its truth properly. The substrate is the durable advantage; the agent is the
instrument that keeps telling you whether you actually built it.

### 40.4 Facts carry authority in their shape

The composer never receives an undifferentiated bag of facts. Every fact carries,
at minimum:

```text
domain              which governed domain asserted it
concept             what it is about
value | truth_state the value, or why there is none
source_authority    what this source is AUTHORIZED to assert
provenance          where it came from
as_of / occurred_at when it was true, or when it happened
openable reference  the durable record — only if the actor is entitled
```

`source_authority` is not merely *where* a fact came from. It is **what that
source is authorized to assert**, and the levels are not peers:

```text
governed_read        canonical Spine truth
transcript_claim     evidence of what a transcription system recorded
email_claim
user_assertion
```

Only `governed_read` exists today. The lower classes are named now so that the
first one to arrive slots into a ranking that already exists, rather than
arriving as a peer of canonical truth because nothing said otherwise.

A lower authority may **coexist** with a governed read. It may never silently
upgrade one.

```text
transcript   "I think the taxes were paid last week"
governed     city_payment = NOT_ESTABLISHED

WRONG        "Taxes are paid."
RIGHT        "Spine does not have a confirmed City payment. In Tuesday's
              meeting, John said he believed they had been."
```

Lower-authority evidence may **explain** canonical truth. It may never replace
it, and the replacement is always silent when it happens — nobody writes a commit
saying "let the transcript win."

### 40.5 Truth walls are executable contracts

Natural language erodes distinctions the domain enforces. *"Are our taxes paid?"*
asks for a binary the governed truth does not have, and a conversational surface
inherits the **asker's** vocabulary unless something stops it.

```text
escrow funded          ≠  City paid
filed                  ≠  paid
financing established  ≠  coverage established
assessment             ≠  liability
coverage discussed     ≠  coverage bound
unknown applicability  ≠  not applicable
```

Each domain declares its walls, and its collapsing vocabulary — *paid, current,
covered, filed, funded, complete, insured, done* — **as data, as part of its read
contract.** When a question crosses a declared wall, the server constrains the
answer form so the named underlying states survive into the answer.

Declaring walls as data rather than prose has a second effect that matters more
than the first: the test suite is generated from the declaration. That is what
makes the rule survive Debt, Compliance and Payroll without being re-litigated,
and it is why this is a contract and not prompt craftsmanship.

### 40.6 Every domain exposes a compact standing projection

The canonical read that serves the screen is not automatically the read that
serves the conversation. The screen needs everything to render a page; gathering
that for every entitled domain on every question does not scale.

```text
STANDING PROJECTION      small · cheap · safe to gather routinely
                         current position
                         important unknowns
                         next action / next milestone

DETAIL PROJECTION        richer · called only when the question requires it
```

Same canonical service, two projections. The standing projection is deliberately
small so that many entitled domains can be gathered on every question, which is
what lets Ask Spine answer cross-domain questions **without a classifier or an
intent router** deciding in advance which domain the question was about. An
intent router is judgement with no edge, and it fails in the direction of
answering the wrong domain confidently.

A domain whose only read is "everything the screen needs" cannot participate.

**This constrains schema, not just reads.** A domain must be able to answer its
standing projection cheaply — without walking its full payment, amendment or
event history. That is a design input at the first schema conversation, not an
optimisation afterward.

### 40.7 Four silences remain distinct

```text
NOT_ESTABLISHED    a fact about the PROPERTY
READ_FAILED        a fact about SPINE
READ_TIMED_OUT     also about Spine, and different again
QUIET              read successfully, nothing needs attention
```

They must never collapse. **Composite silence may only mean "nothing needs
attention" when every required reader successfully returned** — computed from
reader outcomes in code, never asked of the model, never inferred from an empty
result set.

An attention surface that cannot tell quiet from blind is worse than none,
because composite silence reads as health (§5).

### 40.8 Entitlements precede intelligence

```text
authenticated actor → server-derived property scope
                    → ENTITLED DOMAIN READERS ONLY
                    → governed fact envelope → composer
```

Unentitled facts never enter model context. A prompt instruction is not a
security boundary (§21).

**Openable references are minted server-side from entitled facts**, never by
finding a name in the answer text and linking it afterward. The model is not
given record identifiers at all: a model holding an id is a model that can put an
id in a sentence, at which point a link is something it composed rather than
something Spine resolved. Those are different epistemic classes (§38), and only
one of them is safe to click.

#### Authorization must survive COMPOSITION, not just the door

A screen shows one domain, so its authorization only has to hold locally. One
conversational question does not.

```text
"Why is this deal underperforming?"
   → debt · insurance · payroll · maintenance · leasing · resident history
   ALL IN ONE ANSWER
```

Every one of those domains may be individually entitled and the composed answer
still disclose something none of them would alone. Aggregation is itself a
disclosure: a figure that is unremarkable per domain can identify a person, or
reveal a position, once it sits beside five others in one sentence.

**Endpoint-level and screen-level authorization do not compose.** Entitlement
must be carried on each fact, into the composer, and hold *inside* the assembled
answer — including on anything the answer derives from a mix of sources, which
inherits the most restrictive constraint of its inputs, never the loosest.

The same applies to audience (§43): sensitivity overrides relevance, and it
overrides it in the composition, not only at the door.

This is a **major architectural problem, and it is unsolved.** It is named here
so it is designed deliberately when the first genuinely cross-domain answer is
built, rather than discovered by a composed answer that was individually
authorized at every step and wrong as a whole.

### 40.9 Read capability is required; action capability is granted

```text
READS      required for every governed domain
ACTIONS    added only where a canonical service and an authority rule
           already permit them
```

Ask Spine will eventually write, communicate, route and act within authority.
When it does, it is a **new surface over existing canonical writers** — never a
parallel path to the same durable object. A conversational completion routes
through the canonical completion writer or it is a second writer, and the gate
that proves there is only one will fail, correctly.

Conversation never becomes another writer of domain truth, and the read door does
not quietly become the write door.

### 40.10 Retrieval and causal explanation are different capability classes

Do not let the second be inherited by assumption because the first shipped.

```text
"What is our debt service?"        governed retrieval
"Why did debt service increase?"   causal attribution
```

The second requires Spine to connect a changed result to a **recorded** cause —
rate reset, principal event, amendment, new financing terms. A cause may only be
asserted if it walks back to a recorded fact (§38); what cannot be supported
stays visible uncertainty.

A domain's first build may promise retrieval and **preserve the causal hooks**
without claiming causal explanation. Saying which of the two shipped is part of
the receipt, because a surface that answers "what" fluently is assumed to answer
"why" honestly.

#### Comparison is a third class, and it is not retrieval

```text
"What is insurance on 4125?"              governed retrieval
"Compare insurance across the portfolio"  NORMALIZATION
"Which properties are outliers?"          DERIVED ATTRIBUTION
"Why is 4125 higher?"                     causal attribution
```

The second is not a bigger version of the first. Comparing requires a basis —
per unit, per square foot, per coverage limit, per replacement value — and the
basis is a **model nobody recorded**. Change it and the answer changes, with no
underlying fact having moved.

"4125 is an outlier" is not a fact about 4125. It is the output of a comparison
whose parameters were chosen, and §38 requires it be a **visibly different class**
from a recorded figure, naming the basis that produced it — the way `UNASSIGNED`
is a different class from a person's name, not a disclaimer beneath one.

This matters most at asset-management and owner altitude, where comparison *is*
the value proposition and the number goes to a lender. A surface that says
*"insurance on 4125 is $84,000"* and *"4125 is an outlier"* in the same voice has
laundered a model as truth (§38).

Retrieval, comparison and causal explanation are three capability classes. Each
is claimed explicitly or not at all.

### 40.11 The rule is enforced by a gate, not by memory

Every domain that reaches a governed standing state must be **registered** as an
Ask Spine reader, or carry an explicit, dated waiver saying why not.

`tests/gate_ask_spine_readers.js` discovers domains from their canonical standing
reads rather than from a hand-maintained list, so a new domain that lands without
registering goes red on its own. A registry that only knows what someone
remembered to add to it cannot detect the omission it exists to prevent.

This is doctrine's own lesson applied to itself: a rule that lives only in a
document decays under schedule pressure, and *"we will wire it to the real path
later"* is a stop-sign phrase (§32).

## 41. Existing Mechanism First — Intent Before Gap

Property Spine is now large enough that a missing live path, a retired writer,
or an unfamiliar service is **not evidence that the product never solved the
problem**. The repository contains product memory: current source, schema,
migrations, tests, UI call sites, retired paths, and the history explaining why
they changed.

That memory must be used without letting history become current truth.

```text
CURRENT SOURCE + RUNTIME    what is true now
REPOSITORY HISTORY          why we got here
HANDOFFS + MEMORY            navigation aids, never authority over either
```

A mechanism may have been narrowed or retired because **one premise underneath
it was wrong while the rest of the mechanism remained useful**. Treating
"retired" as "rejected" can cause Spine to rebuild its own capability under a
new name. Treating "I do not see the current call site" as "missing" can create
a second canonical path beside one that already exists.

The hard rule is:

> **Never design from the gap outward until we have designed from product
> intention inward.**

Before proposing a meaningful build, recover this chain in plain English:

```text
INTENTION
What should the person doing the work experience?
What boundary of Property Spine must remain true?

EXISTING MECHANISM
What current source, schema, runtime, UI callers and tests already implement
some or all of that experience?

HISTORY
What relevant mechanism existed before, and why was it changed, narrowed or
retired?

RUN
If the path can be exercised, how far does the existing system actually run?
What is the last green step and the first observed red?

CLASSIFICATION
Is what we found live, reachable, dormant, partial, deliberately retired,
wrong, or genuinely missing?

STOP REASON
What evidence explains the stop? Distinguish an observed runtime break from an
inferred absence that has not been exercised.

PRESERVE
Which durable primitives and canonical owners survive?

ACTUAL MISSING PIECE
Only now: what is the smallest correction or addition required to finish the
intended operating path?
```

When the path can be exercised, **the first observed red outranks the inferred gap**. Do not keep designing outward from a theory after the running system has named a narrower failure. Fix the first real break inside its existing owner, rerun the same path, and continue until it works or reaches a genuine product, authority, legal, data, or infrastructure stop.

This is **existing-mechanism-first**, not archaeology-first. The purpose of the
search is to stop rebuilding what Spine already knows how to do. Once the chain
can be stated as:

```text
intent → existing mechanism → observed stop → why it stops → what survives → actual missing piece
```

stop searching and continue the vertical build.

### Product intention outranks implementation convenience

A locally clean architecture can still be globally wrong for Property Spine.
Before accepting a proposal, ask:

```text
Does this make a person leave Spine to do ordinary work?
Does it ask them to re-enter a fact Spine already holds?
Does it create another operating workflow or source of truth?
Does Spine have to reconstruct the event afterward?
Does it replace a durable primitive without evidence that the primitive is wrong?
```

Any `yes` is a stop sign requiring an explicit product ruling before build.

This matters because conventional software is full of familiar answers to local
problems: another portal, another provider console, another workflow system,
another status mirror. Those answers can be technically mature and still
recreate the exact seams Property Spine exists to collapse.

**"Conventional software does it this way" is not evidence.** Familiarity is
especially dangerous when it causes the implementation to drift away from the
product's reason for existing.

### The pre-build receipt

From this point forward, a meaningful Property Spine build is not ready to hand
to a developer until it can show:

```text
intent
→ evidence of the current mechanism
→ relevant history and the reason it changed
→ observed run / first red when runnable
→ classification of what exists
→ exact stop reason
→ primitives preserved
→ smallest missing piece
→ forbidden second path
```

The final line matters. Every build should name the parallel path it must **not**
create. That is how the product protects itself from competent local decisions
that slowly assemble a second operating system beside the first.
