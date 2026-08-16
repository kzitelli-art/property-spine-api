# Person Ingress — approved rulings, open facts, and the confirmation trace

**Status: two rulings APPROVED. Nothing implemented. No schema, no writer, no
external-ID table, and the reproducible fork is deliberately still broken.**

---

# PART ONE — THE DOCTRINE

> **External systems do not tell Spine who a person is. They submit evidence
> about a person. Spine governs the resolution.**

Owner ruling, 2026-08-16. This is the sentence the whole investigation was
looking for, and it holds at one building and at a million units.

## Ruling 1 — the Person ingress boundary (APPROVED)

**No domain importer may mint a Person directly.** Source systems provide
evidence. One governed Person-ingress boundary resolves, creates, or refuses.

`snapshot_loader` inserting into `persons` is the architectural defect. This
ruling is independent of what Yardi IDs turn out to mean — it survives Yardi,
Entrata, AppFolio, acquisitions, one building or a million units.

*Approved. Not implemented.*

## Ruling 2 — Person correction stays ANTI-MERGE (APPROVED)

The existing `record_status` / `superseded_by_person_id` model is deliberately
anti-merge and **stays that way**. Spine must not rewrite a person's earned
history because somebody later decides two records refer to one human. A
supersession relationship explains the correction; leases, conversations,
applications and audit history do not move.

Frozen already in migration 104's own column comments — *"Retirement NEVER
deletes and never merges"*, *"an auditable pointer, NOT a merge — nothing is
moved."* This ruling confirms and preserves it.

*Approved. Not implemented.*

## NOT approved — the A–D identity matrix

The evidence does **not** support `same external ID → same human`, because we
do not know what Yardi's resident identifier identifies.

```text
PROVEN      s0005738 is a durable identifier for a SOURCE-SIDE
            resident/tenancy record, within at least a shared Yardi
            database namespace (465 ids across two properties, zero reuse).

NOT PROVEN  that it identifies a durable HUMAN.
```

Nehal Khosla is the warning: `s0005655` in 1417-409 Room1 **current** and
`s0006165` in Room2 **future**. One human with an old and a new tenancy
record, or two humans sharing a name. The file cannot distinguish them.

**Cases A–D are parked. E–H stand as written** (conflict, never auto-merge,
never fall back to name) because they are refusals, and a refusal does not
depend on what the identifier means.

## The eventual shape — deliberately one step longer than "ID → Person"

```text
SOURCE SYSTEM INSTANCE
        ↓
SOURCE RECORD
        ↓
evidence about a human
        ↓
PERSON INGRESS DECISION
        ├── resolves to existing Person
        ├── creates new Person
        └── conflict / human decision
```

The external ID stays extremely valuable without itself being the identity.

## One ingress contract, channel-specific evidence

Correcting my own framing: I wrote that the contact-data rule and the
canonical resolver collide, and that *"something must give."* **That was too
strong.** The leasing resolver keys on phone and email because that channel
naturally has them. It does not follow that every ingress channel must.

A rent roll may legitimately establish *I have a real resident, I know their
source record, their lease and their premises — and I do not know enough to
prove they are an existing Person.* The correct outcome there is a **proposed
new Person awaiting human confirmation**, not contact data forced into
onboarding.

```text
web lead          strong: verified phone / email
rent-roll import  strong: governed source record + confirmed mappings
                  unresolved: human review
staff identity    strong: verified account + deliberate bridge
```

All three terminate in the same `persons` table and are allowed to prove
identity differently. **One ingress contract, not one universal matching
algorithm.**

---

# PART TWO — THE OPERATIONAL QUESTION (blocks the matrix)

To be asked of Mike, verbatim:

> In Yardi, when the same person signs another lease, does the identifier
> shown after their name — for example `s0005738` — normally stay with that
> person, or can Yardi issue them a new one?
>
> Specifically:
>
> - same person renewing the same bed;
> - same person moving to another bed/unit;
> - same person leaving and later returning;
> - same person signing next year's lease while their current lease is still
>   active.
>
> And if you know: does that s/t number identify the person/resident, or the
> tenancy/lease record?

Until this is answered, no code encodes an assumption about it.

---

# PART THREE — THE CONFIRMATION TRACE (the final read-only investigation)

*Do we already have the workflow semantics for:* source resident evidence →
exact known Person **or** proposed new Person **or** identity conflict → human
confirmation → durable Person?

## The answer is YES, and further along than expected

### `proposed_records` — the workflow object already exists and is general

```text
target_type            what kind of thing is proposed   (NO check constraint —
                                                          the vocabulary is open)
natural_key            the dedup key
payload_json           the raw claim
normalized_json        the parsed claim
evidence_refs          jsonb pointers back to source
confidence             numeric
status                 staged | needs_review | blocked | confirmed
                       | promoted | rejected | CONFLICTED
status_reason          why, in words
conflict_group_id      groups rows that conflict with each other
promoted_record_id     the durable record it became
confirmed_by           who confirmed
confirmed_at           when
import_source_row_id   the source ROW this came from

UNIQUE (activation_id, target_type, natural_key)
UNIQUE (import_source_row_id, target_type)   ← one proposal per source row
```

Every state the brief asked for is already in that CHECK constraint —
including `conflicted` — and the human-confirmation fields already exist.

### The refusal semantics already exist too

```text
status = blocked | needs_review   →  CANNOT be confirmed as-is
    "cannot confirm — this row is not confirmable as-is"
    + reason + a stated fix
```

The activation confirm route already refuses to promote a row that is not
confirmable, with a reason and a next step. That is the exact shape a person
proposal would need.

### `import_source_rows` — the source-record link ALREADY EXISTS

```text
import_source_rows
  import_batch_id · row_index · raw (jsonb, the whole original row)
  produced_unit_id · produced_space_id · produced_person_id · produced_lease_id
  parse_note
```

**`produced_person_id` is a typed foreign key to `persons`, and the rent-roll
importer populates it.** Verified by running the real path: one source row in,
one `import_source_rows` row out, with both `produced_person_id` and
`produced_lease_id` set.

So Spine **already records, per import, "source row R produced person P"** —
and the raw row it preserves still contains the `(s0005738)` string.

Two honest qualifications:

1. **Nothing ever reads it on a later import.** The link is written and never
   consulted, which is why the fork happens anyway.
2. **It is a `produced-by` link, not an `asserts-identity` link.** "This row
   created this person" is history and should never be rewritten. "This source
   record refers to this human" is a claim that may later be corrected. They
   are different statements and conflating them would make a correction
   falsify the import history.

## What is missing — a short list

```text
1. target_type = 'person' is NOT supported.
     The confirm route refuses explicitly:
     "confirm not implemented for target_type 'X' (V1: lease only)"
     A deliberate scope limit, not an oversight.

2. A proposal cannot express "RESOLVES TO AN EXISTING RECORD".
     promoted_record_id exists, but the only promotion path INSERTS.
     "Confirmed → this is the person we already have" has no expression.

3. Nothing reads produced_person_id, or the preserved raw row, on re-import.

4. No repair writer — see the frozen ruling below.
```

## The frozen ruling I had not found until now, and its broken assumption

`src/identity/activation.js`, in the confirm path, carries an explicit reasoned
decision:

> *"We do NOT match an existing person by name: two different real residents
> can share a name, and merging them onto one person row would silently
> corrupt the truth (one person tied to two unrelated leases). **A duplicate
> person is an honest, fixable blank; a merged person is a wrong-confident
> value.** This matches every other module, which also inserts fresh."*

This is the **third** person-creating path in the onboarding area, and unlike
`snapshot_loader` it is not an accident — it is a deliberate ruling, and it is
consistent with everything approved above.

**But its assumption has never been true.** "A duplicate person is an honest,
*fixable* blank" presumes a repair path exists. It does not: `persons` carries
`record_status`, `retired_at`, `retired_reason` and `superseded_by_person_id`,
and **nothing in the tree writes any of them** — the writer was drafted in
Release 0 and deliberately not shipped.

So today Spine chooses duplicates over merges (correct), and then cannot fix
the duplicates (not correct). Ruling 2 says the repair must be anti-merge; it
does not say the repair may be absent.

**That is the gap I would name next, after the Mike question — not a new
table.**

## Assessment

The workflow semantics needed for governed Person ingress are **already
built**, in `proposed_records` + `import_source_rows` + the activation confirm
route's refusal behaviour. What is absent is a person-shaped use of them, a way
to say "resolves to existing", and a repair writer for the duplicates the
current ruling knowingly creates.

Nothing here was implemented. No schema, no writer, no external-ID table, no
fork fix.
