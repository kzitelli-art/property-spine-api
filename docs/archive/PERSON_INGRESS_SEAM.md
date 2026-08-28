# Person Ingress — the proposed code boundary and hostile proof matrix

**RETURN CHECKPOINT. Nothing implemented. Awaiting approval before code.**

Written against the sharpened north star of 2026-08-16, which changed three
things from the previous pass: phone is elevated to *very strong* evidence, the
Yardi identifier is demoted to *source-system evidence/provenance*, and **the
Mike question no longer blocks** — whatever Yardi does, the model survives.

---

## 0 · The north star this seam serves

> **Spine owns the person. Yardi does not. The lease does not. The rent roll
> does not.**

```text
one human  →  one Spine person_id  →  one continuous Person identity
```

A new lease, renewal, bed transfer, unit transfer, future lease, move-out or
later return does **not** create a new Person. Those are new facts and
relationships around the same human.

### The evidence hierarchy (governing)

```text
Spine person_id            DURABLE IDENTITY — the only one
verified phone             very strong identity evidence
email / other credentials  supporting evidence
name                       label · weak evidence · NEVER creates identity
Yardi s000####             source-system evidence / provenance
lease · bed · unit         relationship facts · NEVER Person identity
```

A name match must never create identity. A Yardi ID must never become Spine's
Person ID. A matching phone is extremely strong evidence and still **not**
permission for a blind merge — numbers get reassigned, shared, mistyped and
corrected — so ingress owns the decision and contradiction refuses.

**Recognition over re-entry.** In normal operation the system recognises
continuity rather than asking people to recreate it.

### One more ruling this pass adds

> **`produced_person_id` remains history, not identity authority.**

`import_source_rows.produced_person_id` says *what a prior import produced*. It
may be **supplied to ingress as evidence**. It may never silently become
*"same source record = same Person"*. Those are different facts and the second
one is a claim that can later be corrected; the first is history that must not
be rewritten.

### And the boundary the Person Card keeps

The durable human persists across properties. **The Person Card stays a
Person × Property lens, not a global dossier.** Identity is not solved by
flattening property context together.

---

## 1 · The invariant

```text
SOURCE EVIDENCE
      ↓
GOVERNED PERSON INGRESS
      ├── known existing Person
      ├── genuinely new Person
      └── unresolved / conflict → human judgment
      ↓
person_id
      ↓
LEASE / APPLICATION / CONVERSATION / OTHER DOMAIN FACT
```

**No domain writer creates a Person. It receives one.**

---

## 2 · The exact code boundary

### 2.1 One new module — the whole seam

```text
src/identity/person_ingress.js        NEW · Class 1 · ~200 lines

  resolvePersonFromEvidence(client, {
    property_id,                 // scope for the decision, not for identity
    evidence: {
      channel,                   // 'rent_roll' | 'leasing_intake' | …
      name,                      // label only
      phone, email,              // may be absent — channel decides
      source_system,             // 'yardi' | … (vocabulary reused)
      source_record_id,          // e.g. s0005738 — EVIDENCE, never the key
      import_source_row_id,      // provenance
      prior_produced_person_id,  // history, offered as a CANDIDATE only
    },
    policy,                      // channel profile, see 2.2
  })
  →  { disposition, person_id?, proposal_id?, reason, evidence_used[] }

     disposition ∈ 'resolved' | 'proposed' | 'needs_review' | 'conflicted'
```

It is a **resolver plus a proposal writer**. It is not a matcher library, not a
registry, not a merge engine.

### 2.2 Channel profiles — one contract, channel-specific evidence

A small declarative table inside the module. Not a universal algorithm.

```text
leasing_intake   strong: verified phone → existing Person
                 then: legacy phone, then email     (today's behaviour, unchanged)

rent_roll        strong: phone, when the source carries one AND nothing
                         contradicts it
                 candidate: prior_produced_person_id + matching source_record_id
                         → SURFACED as a candidate, never auto-bound
                 evidence: source_record_id recorded either way
                 name alone: NEVER sufficient
                 otherwise: proposed new Person

staff_bridge     strong: verified account + deliberate bridge  (unchanged)
```

**A–D stay unencoded.** The Yardi identifier never *proves* a human in this
profile — it can only raise a candidate that a human confirms. If Mike's answer
later establishes it is durable human identity, the change is one line in this
table, and nothing else moves. That is the test of the abstraction.

### 2.3 Reuse the existing proposal machinery — invent no state machine

```text
proposed_records
  target_type      = 'person'          ← the only new value. No CHECK to alter:
                                         the column has no constraint today.
  natural_key      = source_system:source_record_id, or a batch-row key
  payload_json     = the raw evidence
  normalized_json  = the parsed evidence
  evidence_refs    = [import_source_row_id, import_batch_id]
  status           staged | needs_review | conflicted | confirmed | promoted
  status_reason    the sentence a human reads
  conflict_group_id  groups rival candidates
  confirmed_by / confirmed_at
  promoted_record_id ← the person_id, WHETHER RESOLVED OR CREATED
  import_source_row_id
```

**One extension is required**, and it is the only schema-adjacent change:

> A proposal must be able to say *"confirmation RESOLVES this evidence to an
> existing Person"*, not only *"confirmation CREATES one."* Today the confirm
> path always inserts.

Proposed expression, additive and boring: `payload_json.resolution_intent ∈
{'create','resolve'}` plus `payload_json.candidate_person_id`. `promoted_record_id`
then carries the resulting `person_id` in both cases. **No new column, no new
table, no new status.** If review prefers a real column instead of a JSON key,
that is a one-line migration and I would rather be told than choose.

### 2.4 What is removed

```text
src/shared/snapshot_loader.js    loses `insert into persons`; calls ingress
src/identity/activation.js       loses `insert into persons`; calls ingress
src/shared/seed_snapshot.js      seed/QA path — same treatment or explicit waiver
```

The three person-creating onboarding paths the audit found. Fixing one and
leaving two is fixing Skyline and leaving the leak three feet away.

`findLease` also loses its `lower(tenant name) = lower(incoming name)` clause:
with the person resolved first, the lease key becomes
`(space_id, status, dates, person_id)`. **Lease identity and Person identity
separate** — that is the coupling the audit isolated.

### 2.5 The gate that makes it structural

```text
tests/gates/gate_person_ingress.js     NEW · Class 3
```

Scans **the whole repo** — `src/`, `server.js`, `tools/`, `seeds/` — for
`insert into persons`, and fails on any occurrence outside
`src/identity/person_ingress.js` and an explicit, reasoned allowlist. Same
shape as the existing source-governance gates.

Written to **scan the same scope it asserts** — the gate that under-detected by
scanning one directory is the reason that sentence exists in CLAUDE.md.

### 2.6 Human attention spent once, not twice

The operator must **not** face a second 128-click confirmation project. Where
evidence is clean enough under the channel policy, **the existing opening-truth
review carries the identity judgment too** — the same confirmation that
establishes the opening row permits the Person it implies. Review is for the
exceptions: conflicts, contradictions, and candidates that need a human.

For the real 07/31 Skyline file that means **0 extra clicks** on the happy path:
no phone, no contradiction, no prior batch → 128 proposed new Persons, carried
by the one establishment confirmation the operator already performs.

### 2.7 The anti-merge repair writer — shipped with this seam, not parked

```text
src/identity/person_supersession.js    NEW · Class 1 · small

  supersedePerson(client, {
    retire_person_id, surviving_person_id,
    actor_user_id, reason, evidence_refs
  })
```

Deliberately boring. It sets `record_status='retired'`, `retired_at`,
`retired_reason`, `retired_by_user_id`, `superseded_by_person_id` — **and moves
nothing.** No lease rewrite, no conversation rewrite, no application rewrite,
no history rewrite. Reads may follow the supersession pointer where
appropriate; historical attribution stays true.

This exists because the frozen ruling in `activation.js` — *"a duplicate person
is an honest, **fixable** blank"* — has never been true. Ruling 2 says the
repair must be anti-merge; it does not say the repair may be absent.

**Explicitly not built:** no `dedupe`, no bulk merge, no fuzzy matcher, no
external-ID table, no `yardi_id`, no new UI.

---

## 3 · The hostile proof matrix

`tests/proofs/person_ingress_hostile.db.js` — real Postgres, real writers. Each row is
the failure it exists to prevent, not a feature it demonstrates.

| # | Hostile case | Required outcome |
|---|---|---|
| H1 | **Changed lease end date** (renewal) | **Zero** new durable Persons. Same `person_id`; the lease resolves separately as a new lease. *This is the reproducible fork today.* |
| H2 | **Changed bed / unit** (transfer) | Same `person_id`. No name-based match anywhere in the path. |
| H3 | **Two different humans, identical names** | Remain **distinct** Persons. Never collapsed. |
| H4 | **Same external ID, contradictory evidence** (different verified phone) | **Refuses** → `conflicted`. No auto-merge, no silent pick. |
| H5 | **No adequate identity evidence** (name only) | `proposed` / `needs_review`. Never a guess, never a name match. |
| H6 | **Confirmed → existing Person** | **No new `persons` row.** `promoted_record_id` = the existing id. |
| H7 | **Confirmed → new Person** | **Exactly one** `persons` row inserted. |
| H8 | **Identical import re-run** | Idempotent: zero new Persons, zero new leases, zero new proposals (the `(import_source_row_id, target_type)` unique index carries this). |
| H9 | **Supersession** | **No child history physically migrates.** Lease, conversation, application and audit rows still point at the retired Person, byte for byte. Asserted by comparing row sets before and after. |
| H10 | **A domain importer attempts direct Person creation** | `gate_person_ingress.js` goes **red**. Proven by deliberately reintroducing an `insert into persons` in a scratch fixture and showing the gate fails, then removing it. |
| H11 | **Phone present and resolves to an existing Person, nothing contradicting** | **Recognised**, not duplicated. The north star's normal case. |
| H12 | **Phone matches but name and external ID both differ** | `conflicted`. A matching phone is strong evidence, not permission. |
| H13 | **Same human, second property** | One global `person_id`, **two** Person × Property relationships. The Person Card at each property shows only that property's context. |

H9 and H10 are the two I would not ship without. H9 is the anti-merge ruling
made executable; H10 is the boundary made structural rather than remembered.

---

## 4 · What this deliberately does not do

```text
no external-ID table          no yardi_id column        no fuzzy matching
no merge engine               no dedupe pass            no identity registry
no new state machine          no new UI                 no A–D encoded
no change to Person Card, relationship_stage, Person × Property, or tenancy
```

## 5 · Scope, honestly

```text
person_ingress.js            new, ~200 lines
person_supersession.js       new, small
gate_person_ingress.js       new
person_ingress_hostile.db.js new, 13 cases
snapshot_loader.js           person insert removed; findLease loses the name
activation.js                person insert removed
seed_snapshot.js             same, or an explicit waiver
proposed_records             NO migration — resolution_intent rides in
                             payload_json unless review prefers a column
```

**One question for review before I write any of it:** §2.3 —
`resolution_intent` as a `payload_json` key (no migration) or as a real column
(a one-line migration)? A JSON key keeps this slice migration-free, which is
worth something; a column is more honest about a field the confirm path
branches on. I lean column, and it is genuinely arguable.

Then: implement, prove hostilely, and back onto the Skyline activation rail.
