# IMMUTABLE ACTION AUTHORITY — CROSS-CUTTING FINDING

**Status: a constraint on a later governed schema discussion. Not a design,
not authorization to build one.**

This note exists because three separate receipt blocks turned out to be one
finding wearing three costumes. It records the finding and stops there. No
universal event ledger is designed here, and no accounting entries, journal
rules, generic receipt table or event bus are proposed.

---

## What the current system records well

Property Spine is genuinely good at **current lifecycle state**, and that is
not faint praise — most of what an operator needs to see today is correct,
walled to their property, and derived rather than typed:

- **Where a thing stands.** `lease_applications.status`, `leasing_tours.status`,
  `obligations.status` are maintained carefully, with real transitions and real
  refusals. A terminal application refuses re-decision. A settled tour refuses
  a silent re-capture.
- **What is owed and to whom.** The obligation engine models work that is owed,
  who owns it, when it is due, and what closes it. Unassigned is `UNASSIGNED`,
  not a guess.
- **Governing economics, where they exist.** `application_proposed_terms_confirmations`
  and `executed_lease_records` are exemplary: immutable, actor-attributed,
  application-named, payload-hashed, with `executed_at` and `effective_date`
  as separate columns and `supersedes_*` lineage. This is the shape the rest
  of the system does not yet have.
- **Property scope.** After the authority-hardening packet, every active staff
  write derives its actor and property from the session.

## Where immutable actor/object lineage is absent

The gap is narrow and specific: **an immutable row that says *this actor* did
*this operation* to *this governed object* at *this time*.**

- **`events`** — the general ledger — carries `property_id`, `person_id`,
  `unit_id`, `type`, `note`, `occurred_at`. It has **no actor column** and
  **no application, tour, obligation or work-order reference**. It can say
  "an application was denied for this person at this property". It cannot say
  which application, or by whom.
- **Application decisions** write only to the mutable `lease_applications`
  projection. Denial records `decision_by_user_id` there; **approval records no
  actor anywhere at all**.
- **Tour events** are immutable and actor-attributed — genuinely good — but
  carry **no `property_id`**, so property lineage is a join, and their replay
  identity lives in unindexed JSONB.
- **Obligations** are mutable and do not name the application or work they gate.

So the system has two good immutable islands (proposed terms, executed leases)
and, between them, a lifecycle model that remembers *where things are* far
better than *who moved them*.

## Which receipt operations are blocked because of it

```
tour.check_in            QUERYABLE OPERATION ID REQUIRES MIGRATION
tour.complete            QUERYABLE OPERATION ID REQUIRES MIGRATION
post_tour_capture        QUERYABLE OPERATION ID REQUIRES MIGRATION
tour.walk_in_capture     COMPOSITE IDEMPOTENCY SCOPE REQUIRES MIGRATION
                         no-outcome variant: NO DURABLE RECEIPT IDENTITY
application.approve      NO IMMUTABLE DECISION RECEIPT IDENTITY
                         DURABLE OPERATION ID REQUIRES MIGRATION
application.deny         NO IMMUTABLE DECISION RECEIPT IDENTITY
                         DURABLE OPERATION ID REQUIRES MIGRATION
```

Implemented and accepted: `executed_lease.verify` — precisely because the
executed-lease record already has every property the others lack.

## Why mutable projections are not historical authority

A projection answers "what is true now". History answers "what happened, and
who made it happen". They are different questions, and a projection cannot
stand in for history for three reasons:

1. **It is overwritten.** The next lifecycle write replaces the fields a
   receipt would have pointed at. A receipt that resolves through a mutable
   row can return a different answer tomorrow for the same `operation_id` —
   which breaks the one invariant the receipt contract exists to hold.
2. **It cannot hold two facts at once.** A correction and the thing it
   corrects must both survive. A status column holds one value.
3. **It cannot distinguish replay from a second mutation.** "This application
   is already approved" is a lifecycle refusal. It does not tell a caller
   whether *their* request was the one that approved it — which is exactly what
   a caller who lost its response needs to know. Lifecycle refusal and
   idempotent replay are different contracts, and only history can serve the
   second.

## Why this matters to agent execution

A conversational agent's failure mode is saying "done" when it does not know
that. The distinction it must be able to draw is:

```
I performed this action, and here is the immutable record of it
I attempted this action and do not know the outcome
```

Today, for most leasing writes, the agent could only inspect current state and
infer. Inference is how an agent says "I've checked her in" about a check-in
someone else recorded, or about one that failed after the response was lost.
**An agent cannot be honest about what it did without a durable record of what
it did.** That record does not exist for most operations yet, which is a
constraint on when agent execution can responsibly begin — not an argument
against it.

## Why this matters to future financial recognition

Money asks harder questions than operations do, and asks them later:

```
who acted · which governed object · when it occurred · when it became
effective · what evidence supports it · what corrected or superseded it
```

Every one of those must survive the moment it was recorded, because the
question is asked in a reporting period that closes long after. A projection
that has since been overwritten cannot answer any of them.

The two immutable islands show this is already understood in this codebase
where money is concrete — executed leases carry `executed_at`, `effective_date`,
`document_sha256` and `supersedes_record_id`. The finding is simply that
operational facts which may *later* become economic source evidence (work
completed, damage confirmed, cost-bearing work authorized) do not yet carry
the same lineage.

**This note assigns no accounting treatment and decides no recognition.** It
records that preserving operational truth is the precondition for a money layer
that reads rather than reconstructs.

## The three currently known migration dependencies

All wait on migration 129 leaving the ledger contested. All are briefed
separately; none is written.

1. **Tour ledger verb repair** — `docs/TOUR_LEDGER_VERB_SCHEMA_REPAIR.md` §1–13.
   Vocabulary: `reminder_sent` projected into a status that forbids it;
   `outcome_corrected` absent from the event-type enum.
2. **Tour operation receipt authority** — same file, second section.
   Access path: a queryable, property-resolvable operation identity for
   `tour_events`, plus property-scoped walk-in idempotency.
3. **Application decision authority** — this packet, Step C.
   An immutable decision record naming application, actor, property, decision,
   recorded time, governing terms and supersession lineage.

They share a table in two cases and a ledger position in all three, so the
schema owner should sequence them together. **Their domain semantics must not
be merged merely because they may share a migration** — a vocabulary fix, an
access-path fix and a missing record are three different changes, and a
combined migration nobody can review is worse than three that can be.

---

**This note is a constraint for the governed schema discussion after migration
129. It is not authorization to solve the architecture now.**
