# Person Ingress — decision pass

**Read-only. No migration, no production writer change, no new identity
table, and the reproducible fork is deliberately left unfixed.**

Deliverables 1–6 from the import-identity decision brief. Everything here is
measured from real artifacts or read out of the tree; where something cannot
be measured, that is said rather than estimated.

Harnesses: `tests/resident_id_evidence_study.js` (files only, no database) and
`tests/person_spine_import_audit.db.js` (unchanged from the audit).

---

## 1 · The resident-ID evidence study

### 1.1 What artifacts actually exist

```text
Skyline 07/31/2026    REAL XLSX                          carries IDs
Skyline 04/30/2026    TRANSCRIPTION (seeds/data_skyline)  NO IDs
Solo    June 2026     SEED (seeds/data_solo) — OTHER PROPERTY   carries IDs
```

**Only one dated artifact per property carries IDs.** Half the questions in
the brief — does an ID's name change between artifacts, does its unit change,
do its lease dates change — **cannot be answered**, because there is no second
ID-bearing artifact for the same property. Stating that limit is the finding;
working around it would be inventing evidence.

The 04/30 Skyline transcription carries no IDs at all. Whether the 04/30
**source** carried them is unknown — the transcription may have dropped them.
Do not conclude the export format changed.

### 1.2 Skyline 07/31, measured

```text
total rows                                  251
resident-bearing rows                       128
rows with a parsable PMS resident ID        128   (100%)
rows without one                              0   (0%)
rows a looser regex would rescue              0

unique PMS resident IDs                     128
IDs appearing on multiple rows                0
IDs appearing in both current and future      0
same ID with different display names          0

duplicate display names with DIFFERENT IDs    3
    chyng shan chiu     s0004731  ·  s0004897
    nehal khosla        s0005655  ·  s0006165
    joshua mcphatter    s0006373  ·  s0006374
```

**Coverage is total and the mapping is clean.** Every resident-bearing row has
an ID, every ID appears exactly once, and no ID ever disagrees with itself
about a name. As a *row* key inside one artifact it is flawless.

### 1.3 The finding that undercuts the obvious conclusion

Those three duplicate names are the whole question, so they were opened:

```text
Chyng Shan Chiu   s0004731  1417-111 Room1  current
                  s0004897  1417-111 Room2  current
Nehal Khosla      s0005655  1417-409 Room1  current
                  s0006165  1417-409 Room2  FUTURE
```

Same unit, adjacent beds, in one case one **current** and one **future**.

That pattern is exactly what one human re-leasing into the next term in the
neighbouring bed looks like — **a new ID issued for a new tenancy**. It is also
what two roommates who share a name looks like, or one person renting two
beds. **The artifact cannot settle it.** A person who knows Skyline can settle
it in a minute; a regex never will.

So the honest reading of the evidence is:

> **The identifier is provably a durable key for a SOURCE ROW. It is not
> proven to be a durable key for a HUMAN.** On the available evidence it may
> well be a tenancy / lease-holder code, in which case matching on it alone
> would still fork Nehal Khosla on the next import — the exact failure we are
> trying to end.

This is the single most important measurement in the pass, and it argues
against the design I proposed two documents ago.

### 1.4 What links 04/30 to 07/31 today

```text
names present in BOTH artifacts             86
```

Eighty-six humans we would most want to carry across imports, and the only
evidence linking them is the display name — which the repo has ruled is not
identity. There is no ID path between these two artifacts at all.

---

## 2 · The namespace of the identifier

### 2.1 Two properties, one sequence

```text
Skyline   s-prefixed   128 ids   numeric range 3165 – 6604
Solo      t-prefixed   337 ids   numeric range 4902 – 6485

literal collisions between the properties            0
numeric-part collisions (prefix ignored)             0
combined distinct numbers            465 of 465  →  NO number reused anywhere
103 of Skyline's 128 numbers fall INSIDE Solo's numeric range
```

Heavily overlapping ranges with **zero** reuse is not what two independent
per-property counters produce — those would collide constantly in a shared
range. It is what **one monotonic sequence issued across the whole database**
produces.

**Finding: the namespace is at least the Yardi database / client, not the
property.** Scoping an identity key by `property_id` — which my parked
proposal did — would be **too narrow**, and would fail exactly when a resident
moves Solo → Skyline inside the same portfolio.

### 2.2 What the prefix means is NOT established

`s` correlates perfectly with Skyline and `t` with Solo in this sample. Two
readings survive the data and I cannot separate them:

```text
(a) the prefix is a per-property code, and the NUMBER is the global sequence
(b) the prefix is a record type, and these two properties happen to differ
```

Either way the **full literal** is unique across both properties. But (a) and
(b) imply different things about a third property, and this is one customer's
two buildings — it says nothing about Customer B's Yardi, which will have its
own database and its own sequence starting wherever it started.

**`s0005738` is therefore not globally meaningful. It is meaningful inside an
issuing system instance.** Nothing in the current schema names that instance —
see 2.3.

### 2.3 What could represent the issuer today — the search

```text
organizations              a Spine tenant/owner grouping. NOT a PMS instance.
properties.organization_id the same grouping, one level down.
import_batches             per-file: source_type, source_file,
                           source_as_of_date, confidence, leasing_model.
                           Records WHICH FILE, never which system issued it.
property_aliases.source_system   a VOCABULARY ('yardi','entrata',…) — names
                           the VENDOR, not the customer's instance of it.
scheduled_tour_sources / scheduling_source_mappings
                           per-property connector config for one channel.
                           The closest thing to a "source connection" object,
                           and it is scheduling-specific.
utility_provider_accounts  provider + external account id, utility-scoped.
```

**No primitive today represents "a PMS environment / customer database".** The
nearest concepts name either the *vendor* (`source_system = 'yardi'`) or the
*file* (`import_batches`). Neither distinguishes our Yardi from another
customer's Yardi.

That gap — not the missing person-alias table — is the real architectural
hole the million-unit case exposes.

---

## 3 · The two parsers, and why the writer bypasses the field map

Measured on the same two inputs:

```text
INPUT: "Jordan Vale (s0005738)"    (the Skyline shape — id inside the name)
  rent_roll_field_map    name="Jordan Vale"             resident_id="s0005738"
  snapshot_loader        name="Jordan Vale (s0005738)"  resident_id=null

INPUT: resident_id="t0005459", resident="Sungmin Choi"  (the Solo shape)
  rent_roll_field_map    name="Sungmin Choi"            resident_id="t0005459"
  snapshot_loader        name="Sungmin Choi"            resident_id="t0005459"
```

**The writer is not bypassing the field map arbitrarily — it was written for a
different source shape.** `snapshot_loader.normalizeRow` handles a *dedicated
`resident_id` column* correctly, which is the shape Solo arrives in and the
shape the loader was built against. It has simply never learned the **embedded**
form, which is how Skyline's Yardi export writes it.

So the divergence is not two competing parsers so much as **one parser that
knows one dialect and one that knows two**, wired to different callers:

```text
rent_roll_field_map   →  activation / evidence → proposal → confirm
snapshot_loader       →  the path that actually WRITES persons and leases
```

The path with the weaker parser is the one holding the pen. One canonical
parsing path is clearly right; **not changing it yet**, as instructed.

---

## 4 · The identity decision matrix

Proposed dispositions. Each names the evidence it rests on, because a ruling
whose basis is unstated becomes a rule nobody can revisit.

| | Case | Proposed disposition | Rests on |
|---|---|---|---|
| **A** | Same source ID, same namespace, same name | **Same Person** | The only case the artifact fully supports. Deterministic. |
| **B** | Same source ID, name changed | **Same Person**; the name change is history | `names_seen` is already the right home — `leasingShadowImport` uses it for exactly this, `{name, source, first_seen_at, last_seen_at}`, and never forks on a name variant. The rent-roll path leaves it empty today. |
| **C** | Same source ID, lease changed | **Same Person**, and lease resolution independently concludes *new lease* | This is the case that proves Person and Lease resolution must separate. It is also the reproducible fork demonstrated in the audit. |
| **D** | Same source ID, different room / property | **Same Person** *if* the namespace covers both. §2.1 says one sequence spans Solo and Skyline, so within this customer: same Person. A move must not mint a human. | Measured, not assumed. |
| **E** | Same name, different source IDs | **Different Persons** unless stronger evidence proves otherwise. Name cannot collapse them. | Repo doctrine, plus §1.3 — three real pairs. **But §1.3 also shows this rule can be wrong in the other direction**, and the artifact cannot tell which. See the open question below. |
| **F** | External ID says A, phone/email says B | **Identity conflict.** Governed reconciliation. No automatic merge, no "stronger field" contest. | `person_identity_conflicts` exists for precisely this and is written only by `leasingShadowImport` today. |
| **G** | No source ID, name only | **Do not fall back to name.** Route to the existing proposal/confirm philosophy: propose a new Person, requiring human confirmation, and say why. | Skyline is 100% covered so this is theoretical *for Skyline* — and a hard requirement for any source that is not. |
| **H** | Different external IDs, same phone/email | **Conflict, not a merge.** Could be duplicate source records, shared/recycled contact data, a real duplicate, or genuinely different people sharing a number. | `person_contact_discrepancies` handles email/name disagreement as **non-blocking context**; `person_identity_conflicts` handles unresolvable identity. Neither merges. |

### The open question inside case E

**E as written would keep Nehal Khosla as two people forever**, and D as
written would merge them if they carried one ID. The rule cannot be settled
from the file. What settles it is a fact only Skyline's operator has:

> *When a resident re-leases into a new term or a different bed, does Yardi
> issue them a NEW resident ID, or keep the old one?*

That single answer decides whether the ID is a person key or a tenancy key,
and therefore decides most of this matrix. **It is a question for Mike, not a
question for the code.**

---

## 5 · The dormant correction machinery — what it was actually for

Reconstructed from `migrations/104_person_record_retirement.sql`,
`docs/IDENTITY_HYGIENE_REGISTER.md` and the call sites.

**It was not built for import reconciliation.** Migration 104 exists because
*"re-running a staff-creation script produced a second identical staff person,
and there was no honest way to retire the loser."* A staff duplicate, not a
resident one.

What it froze is nonetheless directly load-bearing here, and it is stronger
than I assumed in the audit:

```text
record_status              active | retired          (CHECK)
retired_at / retired_reason  a retirement MUST say when and why (CHECK)
retired_by_user_id
superseded_by_person_id      cannot self-supersede    (CHECK)
```

The column comments are the ruling:

> `record_status` — *"Retirement NEVER deletes and never merges: relationships,
> leases, conversations and audit history stay attached to the row that earned
> them. A retired row cannot receive authority."*
>
> `superseded_by_person_id` — *"The surviving canonical record… An auditable
> pointer, **NOT a merge** — nothing is moved."*

**So the dormant machinery is not an unfinished merge service. It is a
finished ANTI-merge primitive with no writer.** It can record that two rows
are one human and deliberately refuses to move anything between them.

`docs/IDENTITY_HYGIENE_REGISTER.md` also records that a writer **was drafted in
Release 0 and deliberately not shipped** — *"an unused production-identity
writer sitting in the deployed checkout is the same class of latent hazard as
the row it was meant to remove."* That is a decision, not an oversight, and it
should not be quietly reversed.

Correction to the audit: I wrote that this was *"a merge/retire vocabulary with
no mechanism behind it."* The vocabulary is right and the absence is
deliberate; what is missing is a writer, and the doctrine for that writer is
already frozen.

---

## 6 · The smallest proposed architectural seam

Not a table. A **boundary**.

```text
                    ONE PERSON-RESOLUTION BOUNDARY
                     every source crosses it, or it
                     may not create a human at all

source artifact
      ↓
normalized resident evidence          (one canonical parser, both dialects)
      ↓
╔═════════════════════════════════════════════════╗
║  PERSON RESOLUTION                              ║
║    → existing Person   (deterministic evidence) ║
║    → new Person        (proposed, explained)    ║
║    → conflict          (governed queue)         ║
╚═════════════════════════════════════════════════╝
      ↓  person_id
LEASE RESOLUTION            ← independent question, runs SECOND
      → update existing lease / correction
      → new lease
      ↓
Person × Property  →  Person Card       (already works, unchanged)
```

**The proposed seam is the box, not its contents.** The claim worth ruling on
is narrow:

> *No domain writer in Property Spine may create a `persons` row directly. A
> source asserts evidence; one resolver decides identity; every importer calls
> it or refuses.*

That is enforceable as a gate over `insert into persons` — the same shape as
the existing source-governance gates — and it is true regardless of how cases
A–H are later ruled, regardless of whether the ID is a person key or a tenancy
key, and regardless of whether an external-ID table is ever built.

Three things it deliberately does **not** decide:

1. **What evidence the resolver may use.** That waits on the Mike question in
   §4 and on the contact-data ruling.
2. **Whether external IDs get a durable table.** §2 says any such table would
   need an *issuing-system* dimension that does not exist yet — so that
   decision has a prerequisite of its own.
3. **Whether `property_aliases` folds into anything.** Live and load-bearing;
   leave it.

### Why not fix the fork now

The fork is real, reproducible and demonstrated. But every available fix
encodes an answer to the Mike question:

```text
match on ID          assumes the ID is a person key — §1.3 says unproven
match on ID + name   re-introduces the name we removed
match on nothing     correct, useless, and what happens today
```

Fixing it now would freeze that assumption in the writer where it is hardest
to revisit. It stays broken, on purpose, until the ingress rule is ruled.

---

## What I would put in front of the next decision, in order

1. **The Mike question.** Does Yardi reissue a resident ID on re-lease or bed
   change? It decides most of the matrix.
2. **The contact-data ruling.** The canonical resolver keys on phone and
   email; onboarding is currently forbidden to carry either. Something has to
   give, and it is a product decision.
3. **The issuing-system gap.** Nothing today names "our Yardi" as distinct
   from "a Yardi". At two properties this is invisible; at a million units it
   is the whole problem.
