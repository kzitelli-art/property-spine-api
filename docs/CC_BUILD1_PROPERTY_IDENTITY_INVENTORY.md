# CC_BUILD1 — Property identity inventory

**Evidence base for the property identity ruling. It does not make the ruling.**

Four rows compete for "Solo on Chestnut / 4233". Deciding what to do about that
is an owner ruling, and this document exists to make that decision *informed*,
not to pre-empt it. Producing evidence for a ruling is a thread's job; making one
is not.

```text
STATUS      Slice 1 complete · Slices 2 and 3 not started
READ AT     61f99bf  (production lineage — NOT main, which is 43 commits behind)
BRANCH      claude/github-docs-review-5hr4jt, branched from 61f99bf
RUNG        LOCALLY_EXERCISED — no database was contacted, by design
WRITES      none. Every artifact here is derived from migration text.
```

| Slice | Deliverable | State |
|---|---|---|
| **1** | Dependency graph from migration source, no DB connection | **complete** |
| 2 | Census SQL script — generated here, run by a human elsewhere | not started |
| 3 | Three-option brief with costs and no recommendation | not started |

---

## ⛔ THE EPISTEMIC LIMIT OF SLICE 1 — READ THIS BEFORE QUOTING ANY NUMBER

**This is a catalog. A catalog is a description of the world, not the world.**

That is not a hedge. It is this repository's own recorded defect, and it cost a
false published claim. `docs/IDENTITY_HYGIENE_REGISTER.md` H-1:

> *"an inventory built on `information_schema` foreign-key views reported '67
> tables checked, 0 rows attached' and I published that as proof of inertness.
> …The corrected Gate 4 check, which queries the production reachability
> predicates **directly**, found the lead immediately."*

Slice 1 is a further step *removed* from the world than the inventory that got
that wrong. It reads declared migration text — not even the live catalog.

```text
IT SAYS          which FKs are DECLARED, and what each would do
IT CANNOT SAY    whether a single row exists behind any of them
IT CANNOT SAY    what a delete or a merge would actually destroy
IT CANNOT SAY    that the deployed database matches these files
```

Counting rows is a separate, deliberate act against real data. That is Slice 2,
and it is generated here and run by a human with production access — never by
this thread, which has none.

**Why migration source rather than `information_schema`:** the only database
worth asking is production, and this build is read-only with no production
access. A source-derived graph is what can be produced honestly. It also carries
something the live catalog does not — the **migration and line** where each edge
was declared, so every edge is traceable to the change that introduced it. If
source and catalog disagree, that disagreement is itself a finding, and Slice 2's
census is what would surface it.

---

## SLICE 1 — the dependency graph

```sh
node tools/identity/property_dependency_graph.js            # the report
node tools/identity/property_dependency_graph.js --json     # machine-readable
node tools/identity/property_dependency_graph_falsify.js    # 21 cases, must pass
```

Artifacts, regenerable from source at any time:

```text
docs/build1_identity/SLICE1_DEPENDENCY_GRAPH.txt    the full report, 322 lines
docs/build1_identity/SLICE1_DEPENDENCY_GRAPH.json   every edge with file:line
```

178 migration files scanned, `000_schema_migrations.sql` … `189_unified_staff_onboarding.sql`.

### 1a · What a delete of one `properties` row would do

**154 foreign keys reference `properties`**, across 152 live tables — no table
holds more than one.

| | FKs | What it does to a delete |
|---|---|---|
| **BLOCKS** | **71** | refuses the delete outright |
| **DESTROYS** | **75** | deletes the child rows with the parent |
| **ORPHANS** | **6** | child row survives, pointer silently nulled |

By declared action: `CASCADE 75` · `RESTRICT 42` · `NO ACTION 29` · `SET NULL 6`.

**Reconciliation with the handoff, including one correction.** The handoff states
154 FKs, 77 `ON DELETE CASCADE`, 6 `ON DELETE SET NULL`. Counting *declared* edges
reproduces all three exactly. The correction is that **two of the 77 cascades are
on `scheduled_charges`, a table dropped by migration `059`** — so the live cascade
count is **75, not 77**. The handoff's other two numbers stand unchanged.

Two figures the handoff did not state, and the second is the consequential one:

- **42 `RESTRICT`** — refuse immediately if any child row exists.
- **29 FKs carry no `ON DELETE` clause at all**, defaulting to `NO ACTION`. These
  also refuse. They are easy to miss precisely because nothing was written.

### 1b · The finding that reframes the delete question

**71 FKs block. A plain `delete from properties` does not reach the cascades.**

If *any one* of those 71 tables holds a single row for that property, the delete
is refused and none of the 75 cascades fire. The 77-cascade figure describes a
destruction that, on a property with real operating history, the database would
most likely never permit.

This cuts both ways and neither way is comfortable:

```text
the reassuring reading    a stray delete is very likely refused, not silently
                          destructive
the alarming reading      a delete that DOES succeed had nothing blocking it —
                          which means it ran against a property with no
                          operating history, or someone cleared the blockers
                          first, and then 75 cascades fire at once
```

**Neither reading is established by this file.** Both depend entirely on which
tables hold rows, which is Slice 2. Recorded here so the census is designed to
answer it rather than merely to count.

### 1c · The graph the delete question does not cover

**The identity question is not a delete. It is a migration.** Repointing one
property's children onto another canonical row is governed by uniqueness, not by
`ON DELETE`. A delete-graph says nothing about it.

**78 unique constraints involve `property_id`**, in three classes that behave
differently:

| Class | Count | Behaviour on a merge |
|---|---|---|
| `ANCHOR` | 37 | includes the row's own `id` — **cannot** collide |
| `SINGLETON` | **4** | at most one row per property — collision is **guaranteed** |
| `COLLIDABLE` | 37 | `property_id` + a business key — collides **if** the key is shared |

`ANCHOR` constraints are the `unique (id, property_id)` pattern, which exists so a
child can foreign-key to `(id, property_id)` and be forced to agree about which
property it belongs to. Since `id` is already unique, they cannot clash.

#### The four `SINGLETON` constraints — the hard stops

These permit **one row per property**. Merge two properties that each have one and
the collision does not depend on a shared business key; it is certain.

| Table | Predicate | Declared |
|---|---|---|
| `communication_lines` | `line_type = 'property_facing' and status = 'active'` | `130_communication_lines.sql:161` |
| `property_pricing_versions` | `status = 'published'` | `062_pricing_authority.sql:51` |
| `opening_positions` | `status = 'established'` | `157_opening_positions.sql:144` |
| `deal_intake_properties` | `status = 'current'` | `155_deal_membership_currency.sql:81` |

Migration 157 states the intent in its own words — *"ONE CURRENT OPENING POSITION
PER PROPERTY. Re-establishing supersedes; it does not accumulate ambiguity"* — so
this classification is the schema's declared intent, not an inference from shape.

**Two of these four intersect open work already on the board**, which is why they
are called out rather than left in a table:

- `communication_lines` is the constraint underneath the handoff's own correction
  that *production has an operations line owned by `Demo ORG`, and OneFive has
  zero.* Whatever the ruling decides, at most one of the competing rows may hold
  the active property-facing line.
- `property_pricing_versions` is the same table gating Skyline activation, where
  `SKYLINE_ACTIVATION_PREREQUISITES.md` records `properties_with_publish_authority: 0`.
  A merge and a first pricing publication contend for the same constraint.

**A merge fails part-way through on the first clash**, which is worse than
refusing up front: it leaves children split across two identities with no
transaction boundary stated anywhere in these files. Whether any of the 41
non-anchor constraints actually clash is a row question — Slice 2.

The remaining 37 `COLLIDABLE` constraints are listed in full in
`docs/build1_identity/SLICE1_DEPENDENCY_GRAPH.txt`.

### 1d · The six quiet ones

`SET NULL` edges do not refuse and do not destroy. The row survives with its
property pointer nulled — no error, no log line, no operating signal.

```text
person_identity_conflicts.property_id     050_identity_aliases_and_shadow_import.sql:105
person_intent_tasks.property_id           050_identity_aliases_and_shadow_import.sql:127
scheduled_tour_source_links.property_id   048_interaction_ledger_and_scheduling.sql:213
scheduled_tour_sources.property_id        048_interaction_ledger_and_scheduling.sql:140
scheduled_tours.property_id               048_interaction_ledger_and_scheduling.sql:168
unit_events.property_id                   006_unit_occupancy_state.sql:68
```

Five of the six are identity and scheduling history — the two categories where a
silently detached row is least likely to be noticed and most likely to matter to
an identity ruling. `31ca5801-…`, Marlow's completed tour of 5 July 2026, is
permanently protected and lives in this blast radius.

---

## WHY THE PARSER'S "ZERO UNPARSED" MEANS SOMETHING

The report claims every statement referencing `properties` was parsed into an
edge. Per §33 — *"a green gate that has never been shown capable of going red is
evidence of nothing more than a green run"* — that claim is worth nothing on its
own, so it was falsified.

`tools/identity/property_dependency_graph_falsify.js` runs **21 cases**: real FK
forms that must be found, comments and string literals and lookalike table names
that must be ignored, and unhandled forms that must be **flagged rather than
silently dropped**. The parser strips comments before scanning, because *a
mention is not a guard*.

**Five deliberate breaks were introduced and each went red on the correct case**,
then were reverted:

| Break | Went red on |
|---|---|
| comment stripping disabled | commented-out FK counted; string literal counted |
| missing `ON DELETE` defaulted to `CASCADE` | the `NO ACTION` default case |
| catch-all `unparsed` push deleted | the non-DDL flag case |
| `SINGLETON` folded into `COLLIDABLE` | the `unique(property_id)` classification |
| paren-depth guard removed from the column splitter | the internal-comma expression case |

**Two of those cases exist only because the first version of the suite was
falsely green**, and both are the same failure this repo documents — *green is a
claim about what was measured*:

1. Deleting the catch-all flag left the suite fully green. The only "unhandled
   form" case happened to hit the `ALTER` branch's separate flag path. There are
   two flag paths; there are now two cases.
2. Removing the paren-depth guard left the suite fully green. The expression case
   used `lower(trim(label))`, which contains no internal comma and therefore
   splits identically with or without the guard. The case now uses the real
   tree's `coalesce(person_id, '…'::uuid)`.

An independent cross-check agrees: a plain `grep` over the migration tree counts
154 references, 77 `cascade`, 42 `restrict`, 6 `set null`. Two unrelated methods
producing the same four numbers is what makes them worth quoting.

---

## WHAT SLICE 1 ESTABLISHES, AND AT WHAT RUNG

```text
LOCALLY_EXERCISED   the parser, its 21 falsification cases, and the derived
                    graph. Real files, real parse, no database.
```

Not `HTTP_PROVEN`, not `BROWSER_VERIFIED`, and explicitly **not** a statement
about production. This thread has no browser, no production access, and cannot
deploy. `LOCALLY_EXERCISED` is the ceiling and this is it.

**What is now known:** the declared shape of everything attached to a property —
what refuses a delete, what destroys, what detaches quietly, and, separately,
what refuses a repoint. Every edge traceable to a migration and line.

**What remains unknown, and is not guessed at here:** whether any row exists
behind any edge; whether the deployed database matches these files; how many of
the four competing rows are populated, and where; and which of the 41 non-anchor
unique constraints would actually clash. All four are row questions.

---

## SLICE 2 — census script *(not started)*

Generates SQL that answers the row questions above for the four competing
identities. Generated here, **never run here.** It must be read-only by
construction, following `tools/identity/count_keyless_properties.js`, which opens
its connection read-only so the database refuses a write even if the file is
later edited carelessly.

Two constraints already established for its design:

- It must ask the questions production asks, against the rows production reads —
  the H-1 lesson, which is the reason this build exists in this shape.
- Every harness delete must be scoped to IDs it created. A test once ran
  `delete from leasing_tours where property_id = <demo>` at setup *and* teardown
  and wiped a real completed tour on every run. Demo Building is shared and
  carries irreplaceable history.

## SLICE 3 — three-option brief *(not started)*

Options with costs, **no recommendation.** The direction is not established and a
thread does not establish it.

---

## OPEN — for the ruling, not for this thread

- **The direction is not established.** This is an identity *migration*, never a
  cleanup. Nothing here should be read as favouring merge, supersession, or
  leaving the rows as they are.
- **No transaction boundary for a repoint is stated anywhere in these files.**
  Given that a merge can fail part-way through on a `SINGLETON`, that absence is
  itself a finding for Slice 3 to cost.
- **154 FKs, 77 declared cascades, and three permanently protected properties**
  mean no option here is cheap, including doing nothing.
