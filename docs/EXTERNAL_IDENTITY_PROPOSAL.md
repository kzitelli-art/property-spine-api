# External Resident Identity — investigation, finding, and proposal

**STATUS: SUPERSEDED AS A BUILD PATH — see `docs/PERSON_SPINE_IMPORT_AUDIT.md`.**

This document diagnosed the symptom correctly and then reached for a new
subsystem before establishing that the existing Person architecture was
*unreachable* rather than *insufficient*. The audit shows it is reachable: the
Person Card wall already admits an imported resident through
`A LEASE IS PRESENCE`, and `relationship_stage` already derives `resident`
from the active lease. What is missing is one adapter into that spine, not a
parallel identity system beside it.

**Do not build `source_identities` on the strength of this document.** Its
`property_aliases` finding (§2) and the `findLease` finding (§3) stand and are
retained for the design conversation; §4's proposed table is parked.

Original status line: proposal, no migration written, no implementation.

Slice 1 item 1. The question: how does Spine say
`source system + external identifier → durable Property Spine person`
without baking a vendor into the Person model.

---

## 1. Scope of the search — what was looked at, and what was not

**Searched:** the live `spine_full` schema (216 tables) for every column
matching `external | source_system | source_key | foreign_ | vendor_id |
remote_ | upstream | xref | crosswalk | natural_key | provider_ref |
source_ref | source_record`; every table carrying an `entity_type` /
`record_type` / `object_type` / `subject_type` column; every
`insert into persons` in `src/`, `server.js` and `migrations/`; the person
matching logic in `src/shared/snapshot_loader.js`,
`src/onboarding/activation_service.js` and `src/identity/`; and
`migrations/011_property_registry.sql`.

**Not searched:** git history, closed PRs, parked branches. A frozen ruling
could exist in one of those; this claim is bounded to the working tree and the
live schema.

## 2. Does a generic primitive already exist?

**No — but the exact shape does, one entity over, and it is already load-bearing.**

`property_aliases` (migration 011) is precisely this pattern for properties:

```text
property_aliases
  property_id      → the durable Spine record
  source_system    yardi | entrata | mri | lender | bank | sharepoint
                   | rent_roll | other                        (CHECK)
  alias_type       code | name | account | folder | entity
                   | loan_number | address_string             (CHECK)
  alias_value      the external string
  confidence       resolved | proposed | unresolved           (CHECK)
  note
  UNIQUE (source_system, alias_value)
```

Migration 011's own header states the ruling this was built on:

> *Before any cross-system join (Yardi ↔ Entrata ↔ MRI ↔ lender ↔ bank) is
> trustworthy, every string a system uses for a property must resolve to ONE
> canonical property. … **Name is NOT identity.***

Resolution is read in `property_resolution_service.js`: an alias at
`confidence = 'resolved'` returns the property; **two** matches return
`ambiguous` and refuse rather than pick the older row.

This is the same problem, the same rule, and a working answer — for one entity
type. It is not generic: the FK, the table name and the vocabulary are all
property-specific.

**Nothing entity-generic exists.** No table carries an `entity_type`
discriminator over an identifier. `person_attributes` is not a candidate — it
is a preferences store with a closed `attr_key` list (`move_month`, `budget`,
`unit_type`, `occupants`, `pets`, `reason`) and no identity role.

## 3. The finding that matters more than the missing table

**Persons are not matched at all on rent-roll import, and the reuse that does
happen is name-matched.**

`src/shared/snapshot_loader.js`:

```text
findLease(space_id, row, status)   →  matches on
      property_id
    + space_id
    + lease_status
    + start_date  (exact)
    + end_date    (exact)
    + lower(existing tenant name) = lower(incoming name)     ← name equality

if a lease matched   → update the lease. The PERSON is never touched.
if none matched      → INSERT a new persons row, unconditionally. No lookup
                       of any kind is performed against persons.
```

Two consequences, both live today:

- **The person key is really a lease key**, and it contains the name. The
  repo forbids name-based identity in `identity_reconciliation.js`
  (`never_does: ["match by display name", "merge person rows", …]`) — that
  refusal governs staff/user linking and does **not** reach this path. The
  rent-roll importer does name equality as a component of its lease lookup.

- **Any real-world change forks the person.** A renewal, a corrected date, a
  move to another bed, a nickname, a diacritic, a `LAST, First` vs
  `First Last` flip — each produces a *new* `persons` row with no link to the
  old one. On the real July export two names already appear twice
  (`Chyng Shan Chiu`, `Nehal Khosla`), so the duplicate-person path is not
  hypothetical for Skyline.

This is why the PMS id matters. The source hands us `s0005738`, a durable
identifier the vendor already guarantees, and today it is parsed out of the
name string by `rent_roll_field_map.js` and then **dropped on the floor** —
`persons` has nowhere to put it.

It is also a **Phase 1 dependency**, not only hygiene: "ahead or behind last
cycle" and "returning vs new resident" cannot be answered if the same human
becomes a new row each import. See `docs/PHASE_1_NORTH_STAR.md` §5.

## 4. Proposal — smallest general structure

Mirror the frozen precedent rather than invent a second shape. One table,
entity-generic, so the next entity that needs it (vendor, unit, lease,
legal entity) does not produce a third pattern.

```text
source_identities
  id                 uuid pk
  source_system      text NOT NULL   CHECK (…)   -- vocabulary below
  entity_type        text NOT NULL   CHECK ('person','property','unit',
                                            'space','lease','vendor')
  entity_id          uuid NOT NULL               -- the durable Spine record
  external_id        text NOT NULL               -- the vendor's identifier
  id_kind            text NOT NULL   CHECK ('resident_id','tenant_code',
                                            'unit_code','lease_id',
                                            'vendor_code','other')
  confidence         text NOT NULL   CHECK ('resolved','proposed','unresolved')
  property_id        uuid NULL       -- scope, see §4.3
  first_seen_batch   uuid NULL  → import_batches(id)
  last_seen_batch    uuid NULL  → import_batches(id)
  note               text
  created_at, updated_at

  UNIQUE (source_system, entity_type, external_id, property_id)
  INDEX  (entity_type, entity_id)
```

No FK on `entity_id` — it is polymorphic, and the `entity_type` CHECK plus a
writer that only accepts known types is the guard. (The alternative, one table
per entity, is what produces the fifth vendor column.)

### 4.1 Uniqueness

`UNIQUE (source_system, entity_type, external_id, property_id)` — one external
id, in one system, for one entity type, at one property, points to exactly one
Spine record. Mirrors `property_aliases`' `UNIQUE (source_system, alias_value)`
with the entity and scope dimensions added.

**Deliberately NOT unique on `(entity_type, entity_id)`**: one person may
legitimately carry a Yardi id *and* an Entrata id *and* a legacy code. Many
external ids → one durable record is the whole point; the reverse is the
error.

### 4.2 Resolution — how a later import finds an existing person

```text
1. exact  (source_system, entity_type='person', external_id, property_id)
     ↓ 1 row at confidence='resolved'   → THAT person. Done. No name involved.
     ↓ 1 row at 'proposed'              → propose, do not auto-bind
     ↓ >1 row                           → AMBIGUOUS · refuse · human queue
     ↓ 0 rows                           → step 2
2. NO FALLBACK TO NAME. A person with no resolved external identity is a NEW
   person, proposed with its external id at confidence='proposed'.
```

The refusal to fall back on a name is the design, not an omission. It means a
first import creates people and every subsequent import matches them by the
vendor's own key.

### 4.3 Scope — why `property_id` is in the key

A resident id is unique inside a PMS *database*, which in practice is scoped
per property or per portfolio. Two properties on separate Yardi instances can
both hold `s0005738` for different humans. Including `property_id` keeps that
collision impossible. `NULL` means portfolio-wide, and the partial-unique
handling of NULL needs deciding at implementation (likely `coalesce` in a
unique index) — **flagging it rather than hiding it.**

### 4.4 Correction behaviour

Correction is not an UPDATE of `external_id`. Two moves, both auditable:

```text
MISBOUND      the id pointed at the wrong person → retire the row
              (confidence='unresolved' + note), write the correct one.
              Never repoint entity_id in place: the audit trail of what
              Spine once believed is the thing being corrected.
DUPLICATE     two Spine persons turn out to be one human → this table does
              NOT merge them. Person merge is a governed action that does
              not exist yet, and adding it here by the back door would let
              an import silently collapse two people.
```

### 4.5 Vocabulary

`source_system` reuses `property_aliases`' list so the two agree:
`yardi | entrata | mri | lender | bank | sharepoint | rent_roll | other`
(plus `appfolio`, `realpage`, `resman` when a real file demands one — added by
migration, never free text).

### 4.6 What this does NOT do

- It does not carry contact information. Names + source identity + lease facts
  only, per the standing instruction.
- It does not make the PMS id a universal person-merging key. It resolves
  *within one source system*; two systems agreeing about one human is a
  separate, later, governed question.
- It does not change `persons`. No `yardi_id`, no `pms_id`, no `appfolio_id`.

## 5. What must change alongside it — and this is the real cost

The table alone fixes nothing. `snapshot_loader.js` must be changed so that:

1. person resolution happens **before** lease resolution, against
   `source_identities`, not as a by-product of `findLease`;
2. **the name equality is removed from `findLease`** — with a person resolved
   first, the lease key becomes `(space_id, status, dates, person_id)`;
3. a row whose external id is absent from the source is proposed as a new
   person and says so, rather than silently forking an existing one.

Point 2 is a behaviour change to a path that has already imported data, so it
needs its own falsification proof. Two cases, and the difference matters:

```text
IDENTICAL EXPORT, IMPORTED TWICE
  Already idempotent today. Every component of findLease's key matches, the
  lease is reused, no person is written. This case is NOT the problem, and a
  proof that only tested it would report the defect as absent.

A CHANGED EXPORT — the real case
  One resident renews, so end_date moves. One moves from Room1 to Room2.
  One appears as "CHIANG TSAE-CHYNG FAN" in one export and
  "Chiang Tsae-Chyng Fan" in the next. Each breaks findLease's key and each
  FORKS THE PERSON today. This is the assertion to write first:
  a second export in which N residents changed term, bed or name spelling
  must produce ZERO new persons for those residents.
```

The first case passing is exactly the kind of green that means nothing here —
it measures the one path where the missing key cannot hurt.

## 6. Open questions for review

1. **Entity-generic table, or `person_source_identities` mirroring
   `property_aliases` exactly?** Generic avoids a third pattern later;
   per-entity keeps FKs real. I lean generic, and it is genuinely arguable.
2. **Should `property_aliases` fold into it?** It is live and load-bearing —
   I would **not** touch it in this slice. But then two shapes coexist, which
   is the thing this proposal exists to avoid. Recommend: build generic, and
   record `property_aliases` as a migration candidate with a stated condition.
3. **`property_id` NULL semantics** in the unique key (§4.3).
4. Skyline's export gives resident ids embedded in the name string
   (`Jalen Holder (s0005738)`), extracted by a regex in
   `rent_roll_field_map.js`. Is that extraction trustworthy enough to be an
   identity key, or does establishment need a source that carries the id in
   its own column?

**Question 4 is the one I would answer before writing any migration.** An
identity key parsed out of a display string by a regex is a weaker foundation
than the whole design assumes.
