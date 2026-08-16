# Person Spine — rent-roll import audit

**Read-only. No schema changed, no product logic changed, no solution proposed.**

The question is not *"what identity architecture should we invent for imported
residents"* — it is *"how does a resident arriving in an external rent roll
enter the durable Person architecture that already exists, and where is the
first exact divergence."*

Method: `tests/person_spine_import_audit.db.js` runs the **real** import path
(`snapshot_loader.loadSnapshot`) against real Postgres, then interrogates the
result with the **real** canonical reads — the Person Card's own property-wall
SQL, `relationship_stage.js`, and the three lookup keys from
`leasingleads.js resolveOrCreatePerson`. Everything below is observed
behaviour, not a reading of the source.

**Bounded scope.** Working tree + live `spine_full` schema. Git history,
closed PRs and parked branches were not searched.

---

## The headline

**The rent-roll importer never enters the canonical Person path at all.**

Everything *downstream* of `persons` is already correct and already accepts an
imported resident. The gap is entirely **upstream** of `persons`.

```text
                    WHAT ALREADY WORKS
persons  →  Person Card wall      ADMITS the imported resident
            (A LEASE IS PRESENCE, operator.js — observed: YES)
persons  →  relationship_stage    returns  stage="resident"
            (basis="active_lease" — observed)

                    WHERE IT BREAKS
rent-roll row  →  lease import  →  local person create/reuse
                                    ↑ never touches the Person spine
```

The hypothesis in the brief was right, and the audit confirms it precisely.

---

## The 14 questions, answered by observation

### Q1 · What identity evidence arrives?

```text
unit_number   "101"
name          "Jordan Vale (s0005738)"     ← the PMS id, still inside the name
resident_id   null                          ← NOT extracted on this path
email         undefined
phone         undefined
lease_from    "2026-08-03"
lease_to      "2027-07-26"
```

**Finding A — there are TWO rent-roll parsers and they disagree.**

```text
rent_roll_field_map.js   (activation path)
    name → "Jordan Vale"      resident_id → "s0005738"    ✓ splits

snapshot_loader.normalizeRow (snapshot path)
    name → "Jordan Vale (s0005738)"   resident_id → null   ✗ does not split
```

So the PMS id is not merely *unstorable* — on the path that actually writes
persons it is never parsed out. It survives only as a substring of the display
name.

**And the two keys the canonical resolver needs — phone and email — are
structurally absent**, by our own standing instruction not to onboard contact
data. That is the crux of the whole problem, and it is a *product* decision
colliding with an *identity* design, not a bug.

### Q2–Q4 · Which code decides a Person exists, on what key, and what creates one?

`snapshot_loader.js` has **no person lookup of any kind**. Person reuse is a
side effect of *lease* reuse:

```text
findLease(space_id, row, status) keys on
    property_id + space_id + lease_status
  + start_date (exact) + end_date (exact)
  + lower(existing tenant name) = lower(incoming name)      ← NAME EQUALITY

match  → update the lease; the person is never touched
miss   → INSERT into persons, unconditionally
```

The person key is really a **lease key with a display name inside it**. The
repo's own refusal — `identity_reconciliation.js`
`never_does: ["match by display name", "merge person rows", …]` — governs
staff/user linking and does not reach this path.

### Q5 · What provenance is preserved on the Person?

```text
source              "historical_snapshot"     ✓
source_type         "historical_snapshot"     ✓
import_batch_id     <uuid>                    ✓
confidence          "confirmed"               ✓
lifecycle_status    "tenant"                  ✓
leasing_stage       "current_resident"        ✓
source_as_of_date   null                      ✗ passed in, not persisted
primary_phone_e164  null
email               null
names_seen          []                        ✗ never populated on this path
record_status       "active"
```

**Finding B — `source_as_of_date` is null on the person** though the batch
carries it. Minor, but it means a person cannot say which dated source
asserted them.

**Finding C — `names_seen` is empty.** `leasingShadowImport.js` populates it as
a name-alias history; the rent-roll importer does not, so name variants across
exports leave no trace.

### Q6–Q7 · Person × Property presence, and lease attachment

```text
leasing_leads         0 rows
conversations         0 rows     ← no thread exists for this resident
person_attributes     0 rows
leasing_conversions   0 rows
lease                 1, status=active
linkage               leases.tenant_ids — an untyped uuid[], NOT a foreign key
```

Presence at the property rests entirely on the lease. That is **correct and
sufficient** per the owner ruling — no fabricated lead or application is
needed, and none is created. Good.

### Q8 · Does the imported resident resolve through the Person Card?

**YES.** The property wall admits them via the `A LEASE IS PRESENCE` clause.
Observed directly against the real wall SQL.

### Q9 · Does `relationship_stage` produce resident / future_resident?

**YES.** `stage="resident"`, `basis="active_lease"`. A pending lease yields
`future_resident` by the same ladder.

### Q10 · If the same human later enters through leasing intake, is the imported Person reused?

**NO. It forks.**

Canonical intake keys on `primary_phone_e164` → legacy `phone` → `email`, and
never on name. The imported person has **all three null**. So the resolver
finds nothing and creates a second `persons` row for the same human.

```text
canonical intake finds: NOTHING  →  it will CREATE A SECOND PERSON
```

### Q11 · Same human at a second property — one global Person?

**Not reachable.** The system cannot match the human at property A, so it
cannot preserve one identity across A and B either. The global-identity
guarantee holds only for paths that key on phone or email.

### Q12 · What happens when signals conflict?

The machinery exists and is well designed — and the importer touches none of
it:

```text
person_identity_conflicts       exists (migration 050)
person_contact_discrepancies    exists (migration 050)
person_intent_tasks             exists (migration 050)
```

All three are written **only** by `leasingShadowImport.js`. The rent-roll
importer raises no conflict — **because it never attempts a match**, so it can
never discover one.

`leasingShadowImport.js` is worth reading as the precedent: it is already an
external-source import that joins the Person spine correctly, with a stated
governing key ("Phone identifies the human"), three explicit states, an
exception queue, and an explicit *"NEVER a duplicate person. A different
name/email is retained as alias / discrepancy, not a fork."*

### Q13 · What correction / merge / retirement mechanism already exists?

```text
persons carries: record_status · retired_at · retired_reason ·
                 retired_by_user_id · superseded_by_person_id · names_seen
```

**Finding D — none of the retirement/supersede columns has a governed writer.**
Every `update persons` in `src/` and `server.js` was enumerated: they set
`lifecycle_status`, `name`, `email`, `phone`, `primary_phone_e164` and
`names_seen`. Nothing writes `superseded_by_person_id`, `record_status`,
`retired_at` or `retired_reason` on `persons`. (The retire statements that do
exist target other tables entirely — `ai_leasing_operating_context`,
`recovery_variants`.) `staffbridge.js` *reads* `record_status` and branches on
it, so a retired person is honoured where it is read — but nothing sets it.

**There is a merge/retire vocabulary in the schema and no mechanism behind it.**

### Q14 · Which existing primitive should own an external PMS identifier?

**Deliberately not answered here.** The audit's job was to find the divergence,
and the candidates all carry open questions that belong in the design
conversation, not in an audit:

- `persons.names_seen` — already a per-source alias history with
  `{name, source, first_seen_at, last_seen_at}`, but it is a *name* alias
  store, not an identifier store.
- `property_aliases` (migration 011) — the correct *shape*
  (`source_system + external string → durable record`, with
  `resolved | proposed | unresolved` and a refusal on ambiguity) but scoped to
  properties by table name and FK.
- A new primitive — what the earlier proposal reached for, and what this audit
  was called to test the necessity of.

---

## THE FIRST EXACT DIVERGENCE

```text
snapshot_loader.js  ·  the person write, inside the findLease miss branch

    leaseId = await findLease(spaceId, row, leaseStatus);
    if (leaseId) { …update the lease; person untouched… }
    else {
      personId = INSERT INTO persons (…)      ← HERE
    }
```

This single line is where the rent-roll path should have called the canonical
person resolution and instead invents identity locally. Everything wrong
downstream — the fork on renewal, the fork on later intake, the missing
conflict queue entry, the empty `names_seen`, the unusable PMS id — descends
from it.

## The decisive demonstration

Same human, same bed, one renewal (`end_date` moves out a year):

```text
persons at this property before the renewal import:  1
persons at this property after  the renewal import:  2

    8361c28a…  Jordan Vale (s0005738)
    e7cbb964…  Jordan Vale (s0005738)
```

**The renewal forked the human.** Note also what an identical re-import does:
nothing — every component of `findLease`'s key matches and the lease is
reused. A proof that only tested a byte-identical re-import would report this
defect as absent.

---

## What the audit says about the earlier proposal

`docs/EXTERNAL_IDENTITY_PROPOSAL.md` is **superseded as a build path**. It
diagnosed the symptom correctly but reached for a new subsystem before
establishing that the existing one was unreachable rather than insufficient.
The audit shows the Person spine is *already correct and already reachable
from a lease* — what is missing is one adapter into it, plus one decision
about what key that adapter may use when the source carries no phone and no
email.

Its `property_aliases` finding stands and is retained for the design
conversation.

## The open question the design conversation has to answer first

The canonical resolver's keys are phone and email. **We have ruled that
rent-roll onboarding will not carry either.** So an adapter cannot simply call
`resolveOrCreatePerson`. Something must decide what a rent-roll resident is
allowed to be matched on — and every candidate has a cost:

```text
external PMS id   strong, but arrives inside a display string on the path
                  that writes persons, and is not parsed there at all
name              already rejected repo-wide, and rightly
name + lease      what happens today, in disguise
nothing           every import forks; correct but useless
```

That is the decision to take next, and it is a **product** decision about what
Skyline onboarding may carry, not only a schema one.
