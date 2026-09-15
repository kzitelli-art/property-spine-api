# PROPERTY IDENTITY INVENTORY

**Evidence base for the property identity ruling. It makes no ruling and changed no data.**

Four property rows compete for the identity "Solo on Chestnut / 4233". The populated
Asset Management screen is backed by `Property Spine Demo Building` / `1 Demo Way`,
while canonical `4233 Chestnut` holds one compliance record. This document establishes
what actually hangs off each row, so the ruling can be made on evidence.

```text
BASE COMMIT   61f99bf   production lineage · verified 43 ahead of origin/main, 0 behind
BRANCH        claude/github-docs-review-5hr4jt
RUNG          LOCALLY_EXERCISED — the ceiling for this build, and not rounded up
DATABASE      no production database was contacted. A disposable local Postgres was
              created, used, and destroyed; every proof below that says "proven" was
              run there and nowhere else.
WRITES        none to any shared system. Deliverable is documents + read-only tooling.
```

| Slice | Deliverable | State |
|---|---|---|
| 1 | Dependency graph from migration source, no DB | **complete** |
| 2 | Census SQL — generated, never run against production | **complete** |
| 3 | Every source reference to each candidate row | **complete** |
| 4 | `source_artifacts` binding mechanism | **complete** |
| — | Ruling brief, three options, no recommendation | **complete** |

> Supersedes `docs/CC_BUILD1_PROPERTY_IDENTITY_INVENTORY.md`, which was the Slice 1-only
> draft under the working build name. That file has been removed rather than left beside
> this one — two documents describing the same thing is a second source of truth.

---

## ⛔ THE EPISTEMIC LIMIT — READ BEFORE QUOTING ANY NUMBER

Every count below is **declared schema**, not observed data.

**A catalog is a description of the world, not the world.** That is not a hedge; it is
this repository's own recorded defect. `docs/IDENTITY_HYGIENE_REGISTER.md` H-1:

> *"an inventory built on `information_schema` foreign-key views reported '67 tables
> checked, 0 rows attached' and I published that as proof of inertness. …The corrected
> Gate 4 check, which queries the production reachability predicates **directly**, found
> the lead immediately."*

```text
THIS SAYS          which FKs are declared, and what each would do
IT CANNOT SAY      whether a single row exists behind any of them
IT CANNOT SAY      what a delete or merge would actually destroy
IT CANNOT SAY      that the deployed database matches these files
```

Counting rows is a separate, deliberate act. That is Slice 2, generated here and run by
a human.

**One concrete instance of source and catalog disagreeing was found during this build,**
which is the best argument for the caution. See §1e.

---

# SLICE 1 · THE DEPENDENCY GRAPH

```sh
node tools/identity/property_dependency_graph.js          # report
node tools/identity/property_dependency_graph.js --json   # machine-readable
node tools/identity/property_dependency_graph_falsify.js  # 24 cases, must pass
```

Artifacts: `docs/build1_identity/SLICE1_DEPENDENCY_GRAPH.{txt,json}`, regenerable at any
time. 178 migration files, ledger ceiling 189.

## 1a · What a delete of one `properties` row would do

**154 foreign keys reference `properties`**, across 152 live tables. No table holds more
than one.

| Group | FKs | Meaning |
|---|---|---|
| **CASCADE** | **75 live** | deleting a property destroys these silently |
| **RESTRICT** | **42** | a delete is refused while a row exists — these are the walls |
| **NO ACTION** | **29** | behaves as restrict; **confirmed** — see below |
| **SET NULL** | **6** | a rebind orphans these unless handled explicitly |

**`NO ACTION` confirmed, as the spec asks.** PostgreSQL's `NO ACTION` refuses the delete
exactly as `RESTRICT` does; the only difference is *when* the check runs — `RESTRICT`
fires immediately, `NO ACTION` at end of statement, and can therefore be deferred if the
constraint were declared `DEFERRABLE`. None of the 29 are. For this ruling they are
walls, identical to `RESTRICT`. They matter because nothing was *written* — they are easy
to miss precisely because the clause is absent.

**So 71 FKs block and 75 cascade.** A plain `delete from properties` does not reach the
cascades if any one of the 71 holds a row.

**One correction to the number in circulation.** 77 cascades are *declared*, but two are
on `scheduled_charges`, dropped by migration 059. **75 are live.** The 154 and the 6 are
exact.

## 1b · The six `SET NULL` columns, named

Small enough to list, and the ones a rebind gets wrong quietly. No error, no log line, no
operating signal — the row survives with its property pointer nulled.

```text
person_identity_conflicts.property_id     050_identity_aliases_and_shadow_import.sql:105
person_intent_tasks.property_id           050_identity_aliases_and_shadow_import.sql:127
scheduled_tour_source_links.property_id   048_interaction_ledger_and_scheduling.sql:213
scheduled_tour_sources.property_id        048_interaction_ledger_and_scheduling.sql:140
scheduled_tours.property_id               048_interaction_ledger_and_scheduling.sql:168
unit_events.property_id                   006_unit_occupancy_state.sql:68
```

Five of the six are **identity and scheduling history** — the two categories where a
silently detached row is least likely to be noticed and most likely to matter to an
identity ruling.

## 1c · Defect #12 — one instance of a general pattern, and the pattern is worse

The spec asks whether `pricing_terms` cascading through its own publish-freeze is special
or general. **Proven on the disposable database, not reasoned about.**

**The freeze is real.** Deleting a published term directly is refused:

```text
ERROR:  the terms of a published pricing version are immutable
CONTEXT:  PL/pgSQL function ps_pricing_terms_frozen() line 7 at RAISE
```

**Deleting the property instead is accepted**, and terms, versions and property all go to
zero. Confirmed.

**The mechanism is not "cascades skip triggers."** They do not. The discriminating test:
deleting the *pricing version* directly — one level above the frozen table, nowhere near
`properties` — **also bypasses the freeze**. The guard fires, then reads its own parent to
decide:

```sql
select status into v_status from property_pricing_versions where id = v_id;
if v_status = 'published' then raise exception …
```

By the time the cascade reaches the child, the parent row is already deleted in the same
statement. `v_status` is `NULL`, `NULL = 'published'` is not true, and the guard passes
silently. **Any guard that reads a row being deleted in the same cascade is bypassable.**

Classifying all 57 `BEFORE DELETE` guard triggers in the schema:

| Kind | Count | Consequence |
|---|---|---|
| unconditional `raise` | **53** | cannot be bypassed — a hard wall |
| reads another row to decide | **4** | bypassable exactly as #12 is |

The four conditional ones are `pricing_terms`, **`concession_policies`**,
`release_0_activation_epoch`, and **`work_order_proof_attachments`**.

**Two findings the existing defect #12 entry does not carry:**

1. **`concession_policies` is an unnamed sibling.** It shares the identical trigger
   function `ps_pricing_terms_frozen` (`102_pricing_lifecycle_and_authority.sql:161`) and
   fails the same way. Defect #12 names only `pricing_terms`.
2. **`work_order_proof_attachments` is Release 0 proof evidence** — the completion guard
   that is one of the few `PRODUCTION_PROVEN` rows in `CURRENT_STATE.md`. It carries a
   delete-refusal trigger *and* a `CASCADE` FK to properties. **Proven: a property delete
   destroys it silently**, count 0, no error.

## 1d · Two walls the FK graph cannot see

The inverse case matters more for costing Option B. Cross-referencing guard triggers
against the FK graph found two tables with an **unconditional** delete-refusal *and* a
`CASCADE` foreign key:

```text
ai_leasing_operating_rules      CASCADE FK + unconditional guard
governed_charge_rulings         CASCADE FK + unconditional guard
```

Proven on the disposable database — one row in `ai_leasing_operating_rules` and the
property delete does not cascade, it **raises**:

```text
ERROR:  AI leasing operating rules cannot be deleted; retire the rule.
CONTEXT:  PL/pgSQL function protect_ai_leasing_operating_rule_history()
SQL statement "DELETE FROM ONLY "public"."ai_leasing_operating_rules" WHERE …"
```

With no such row, the same delete succeeds cleanly — so the refusal is the trigger, not
an FK. **An FK-only analysis reports these two as `CASCADE`, i.e. as things that would be
destroyed. They are the opposite: absolute walls.** Any cost estimate built from the FK
graph alone is wrong about them in the most dangerous direction.

## 1e · Where source and catalog actually disagreed

Migration 159 renames `opening_positions` → `opening_tenancy_positions` **inside a
`DO $$` block**. The parser blanks dollar-quoted bodies, so it never saw the rename and
the graph reported a table that has not existed since 159. It was caught by building the
same migration chain into the disposable database and comparing — the parser named a
table the schema did not have.

Fixed, with three falsification cases (including one specifically for a rename inside a
`DO $$` block). **This is the concrete instance of the H-1 lesson, found inside this
build**: the artifact derived from source was wrong, and only contact with a real schema
revealed it.

## 1f · What a rebind would collide with

The identity question is a **migration**, not a delete, and repointing is governed by
uniqueness rather than `ON DELETE`. **78 unique constraints involve `property_id`:**

| Class | Count | Behaviour on a merge |
|---|---|---|
| `ANCHOR` | 37 | includes the row's own `id` — **cannot** collide |
| `SINGLETON` | **4** | one row per property — collision **guaranteed** |
| `COLLIDABLE` | 37 | collides **if** both hold the same business key |

`ANCHOR` is the `unique (id, property_id)` pattern, which exists so a child can FK to
`(id, property_id)` and be forced to agree about its property; `id` is already unique, so
it cannot clash.

**The four hard stops:**

| Table | Predicate | Declared |
|---|---|---|
| `communication_lines` | `line_type='property_facing' and status='active'` | `130_communication_lines.sql:161` |
| `property_pricing_versions` | `status='published'` | `062_pricing_authority.sql:51` |
| `opening_tenancy_positions` | `status='established'` | `157_opening_positions.sql:144` |
| `deal_intake_properties` | `status='current'` | `155_deal_membership_currency.sql:81` |

Migration 157 states the intent in its own words — *"ONE CURRENT OPENING POSITION PER
PROPERTY. Re-establishing supersedes; it does not accumulate ambiguity"* — so this is the
schema's declared intent, not an inference from shape.

Two of the four intersect open work: `communication_lines` is the constraint under the
operations-line finding, and `property_pricing_versions` is the table gating Skyline
activation. **A merge fails part-way through on the first clash**, and no transaction
boundary for a repoint is stated anywhere in these files.

---

# SLICE 2 · THE CENSUS — GENERATED, NOT RUN

```text
tools/identity/property_census.sql              1,729 lines · GENERATED, do not hand-edit
tools/identity/generate_property_census.js      the generator
tools/identity/property_census_columns.json     captured column map
```

**It was not run against production, deliberately.** No `DATABASE_URL` was present in the
environment; had one been, it would still not have been used. An unattended session is
not the place to discover a credential was wider than advertised.

**Why generated.** 152 tables hand-maintained guarantees drift the moment a migration
lands. The table list comes from the dependency graph, so the census follows the schema
instead of remembering it. Its `--capture` mode **refuses any `PGURL` that is not
127.0.0.1 or localhost** — verified by pointing it at a fake remote host and watching it
exit 2.

**Safety, enforced by the database rather than by a comment.** The script opens
`begin transaction read only;` and ends `rollback;`. Verified: an `INSERT` inside that
wrapper is refused — `cannot execute INSERT in a read-only transaction`. A scan confirms
no `INSERT/UPDATE/DELETE/DDL/temp table/function/writing CTE` anywhere in 1,729 lines.

**Structure.** Candidate discovery (STEP 0) → identity of each candidate → per-table
counts, highest first → totals per property → the four guaranteed merge collisions → the
two trigger walls → `source_artifacts` → Marlow's tour. Every property id is named **once**
at the top, in one `values` block.

A table with no timestamp column reports `NULL` bounds rather than being omitted — an
omitted table would read as zero. 140 of 152 have one; 12 do not.

## What the local run proves, and what it does not

Executed against the disposable local Postgres, built from the real migration chain to
ceiling 189. **Exit 0.**

It proves more than parsing. That database was **not strictly empty** — the harness
precondition `tests/e2e/preconditions/087.sql` inserts one `properties` row, using the
**production Demo Building UUID**. So the census returned real non-zero counts
(`property_team_assignments` 3, `property_governed_charges` 2) and STEP 4 correctly
classified all five as `rows_a_delete_would_destroy`. **The aggregation and
classification logic is proven working on non-zero data**, not merely syntactically valid.

It proves nothing whatsoever about production data.

---

# SLICE 3 · THE FOUR ROWS, FROM SOURCE

## 3a · Only two of the four UUIDs are recoverable from the repository

| Row | Status |
|---|---|
| `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` | "Property Spine Demo Building" / displayed Solo — **91 referencing lines**, the most-referenced UUID in the codebase |
| `9e2bb96e-08e2-41db-81c2-91055ceb50a3` | canonical 4233 Chestnut — 33 lines, mostly read-and-guard |
| `21197bb1…` | **NOT_FOUND.** Prefix only |
| `79a5a8d1…` | **NOT_FOUND.** Prefix only |

The two unknown rows appear exactly once in the entire repository, as truncated prefixes
in `docs/THREAD_HANDOFF.md:2969–2974`, which came from a production boot log. The
remaining 28 hex characters are not recoverable from source. **The census's STEP 0 exists
for this reason** — a human resolves them before STEP 1.

**A framing correction.** The trio named "Solo on Chestnut" *includes* `a50fbdd0…`
(whose `display_name` is set to `'Solo on Chestnut'` by `060_property_display_name.sql:16`
— that migration is what created the collision). So "four rows competing" is **three
name-collisions plus one canonical-address row**, not four name-collisions.

## 3b · `a50fbdd0…` — all six claimed references confirmed, plus the rest

Every reference the spec named exists. Verified by opening each file:

| Reference | What it does | Class |
|---|---|---|
| `src/surfaces/owner.js:171` | last entry of `NEVER_DELETE`; `findDeletable()` excludes it. Comment records it holds *"the ONLY irreplaceable record in the system (Marlow's 2026-07-05 tour) plus … 344 leases, 431 comm_events, 15 tours"*, and that before this list it was spared only because its name didn't match `TEST_PATTERNS` — *"a naming coincidence, not a guard"* | PROTECTS |
| `seeds/seed_demo_slots.js:33` | seeds `tour_availability`; called at boot via `server.js:3649` | SEEDS |
| `seeds/seed_demo_live_tour.js:29` | refuses unless `DEMO_MODE=true`; verifies the name matches and refuses on mismatch | SEEDS |
| `src/applications/leasepackets.js:181` | sole key of `EXTERNAL_LEASE_CONFIG` — landlord `4233 Chestnut, LLC`, app fee 50.00, amenity 300/250, telecom 99, late 75, 60-day notice. **Real Solo lease economics stored under the Demo Building's UUID** | TARGETS |
| `src/leasing/demo_preflight.js:20` | read-only; asserts the allowlist contains it, and emits **STOP** if the real Solo id is in that allowlist | TARGETS + PROTECTS |
| `src/identity/demo_owner_ruling_packet.js:17` | read-only packet | TARGETS |

**Beyond those, in runtime `src/`: nothing.** `server.js` contains no occurrence of the
UUID. The remaining ~85 lines are 3 migrations that write it (`073`, `087`, `123`), 3
shell scripts, 11 tools, ~55 tests, and 11 docs.

**Two tool references worth the ruling's attention:**

- `tools/scale/seed_b_qa_identity.sql:43,49` inserts the **production Demo Building UUID**
  under the name `'SCALE HARNESS PROPERTY'`, and its own comment says *"The property id is
  the same one production serves as Solo on Chestnut."* Run against production it would
  collide with the row holding Marlow's tour.
- `tools/run_followups.js:20` and `tools/retire_hollow_leases.js:30` **default** to it
  absent an env var; the latter mutates.

## 3c · `9e2bb96e…` — canonical, guarded, with two exceptions

Mostly protective: `NEVER_DELETE` (`owner.js:162`), refusal walls in
`tools/seed_demo_agent_facts.js:25` and `seed_demo_inventory.js:26`, and 16 tests using it
as the *wrong property* in cross-property spoof assertions. `src/onboarding/deal_registry.js:16`
holds the canonical binding `{key:"solo", canonical_key:"4233-CHESTNUT", property_id:"9e2bb96e…"}`.

Two exceptions:

- **`tools/accept_brick_one.js:26` defaults to the real Solo** with no refusal wall, and
  mints operator invites scoped to it.
- **`src/identity/operator.js:1901` hardcodes the real Solo id inside a live authenticated
  operator route** (`GET /operator/economics/shadow`, as `other_property_id`). Read-only,
  but a production route with a real property id compiled into it.

## 3d · Marlow's tour is protected only transitively

**`31ca5801-a851-4be5-802d-28739f24d6e1` has exactly two references in the entire
repository**, and this is the finding that most needs saying plainly:

| file:line | What it is |
|---|---|
| `src/surfaces/owner.js:166` | **prose inside a comment**, written with a trailing ellipsis so it does not even match a full-UUID grep |
| `tests/never_delete_guard_proof.js:27` | a declared constant |

**Nothing is keyed on the tour id.** There is no guard that names it, no exclusion of it
from any delete or reset path, and no test asserting the row still exists.
`src/leasing/demo_reset.js` does not mention it. Its survival is entirely derivative: it
is safe *because its parent property is in `owner.js`'s `NEVER_DELETE` list*, and for no
other reason. If that property-level guard is bypassed, or a reset path narrower than a
property delete runs, nothing in source protects this row.

**"Protected forever" is currently a property-level guarantee, not a row-level one.**

## 3e · Property-scoped feature flags — eight, not seven

**No current value is resolvable from the repository. All live in Render.** The one
recorded value anywhere is a dated observation in
`docs/PRICING_GUARDS_VERIFICATION_2026-07-27.md:20` — not current state.

| Env var | Defined | Gates |
|---|---|---|
| `ACTIVATION_PROPERTY_IDS` | `src/identity/activation_perimeter.js:64` | the top-level activation perimeter |
| `SYNTHETIC_SEED_PROPERTY_IDS` | `src/shared/synthetic_data_perimeter.js:65` | which properties may receive synthetic data |
| `PROSPECT_ACTIVATION_PROPERTY_IDS` | `src/leasing/leasingleads.js:161` | promoting a web prospect to `production` + `opted_in` |
| `LEASING_INTAKE_PROPERTY_IDS` | `src/leasing/leasingleads.js:134` | binds the shared intake credential to a property set |
| `AGENT_TOUR_BOOKING_PROPERTY_IDS` | `src/leasing/leasingleads.js:1650` | whether the AI agent may book a tour |
| `AGENT_AUTO_DISPATCH_PROPERTY_IDS` | `src/agent/agent.js:1949, 1995` | auto-dispatch without human review |
| `EXECUTED_LEASE_PROPERTY_IDS` | `src/applications/executed_lease_service.js:53` | executed-lease intake (two-key with a kill switch) |
| **`APPLICATION_INTENT_PROPERTY_IDS`** | `src/identity/capability.js:129, 152` | whether an application link may be born |

**The count is eight because the eighth is invisible to the obvious search.**
`APPLICATION_INTENT_PROPERTY_IDS` is read through an `envList()` helper, so it does not
match a `process.env.*PROPERT*` grep. A naïve flag census returns seven — which is exactly
the "a count is a claim about a search" trap.

## 3f · Code that resolves a property BY NAME — the live violations

`docs/DB_HARNESS_ISOLATION.md:89` rules that a property's name can never prove a row is
synthetic. Production has **three** rows named "Solo on Chestnut". These resolve by name
anyway, taking `order by created_at asc limit 1` — i.e. by creation order, not identity:

| file:line | What it decides |
|---|---|
| **`src/leasing/leasingleads.js:1051`** | **a booking SCOPE WALL.** Its own comment: *"the link's property must be the Demo Building. **Re-verify by name**, so a tampered property_id can't aim a booking at a live property."* **No `limit 1`** — a multi-row result takes `.rows[0]` arbitrarily |
| `src/leasing/leasingleads.js:899` | `/demo/intake` — the server-derived property is chosen by name |
| `src/identity/operator.js:194` | resolves the demo property for an operator demo-start path |
| `src/leasing/demo_reset.js:78` | **what gets reset is chosen by name** |

**`leasingleads.js:1051` is the highest-risk item this build found**: a security boundary
implemented on a string known to be held by three rows. The same repository tells the
model the opposite rule at `server.js:1788` — *"the ADDRESS is the stable identity of a
property — NOT its name."* And `src/identity/registry.js:387` already returns the correct
refusal for this exact ambiguity: *"This string maps to MORE THAN ONE property … Resolve
by passing source= to disambiguate … NOT guessed."*

---

# SLICE 4 · SOURCE-ARTIFACT INTEGRITY

**Treated as its own question.** A document can be misfiled independently of which
property row is canonical, and assuming one cause would hide the other. No data was
queried; this is the mechanism only.

## 4a · There is no `property_id`, and that is deliberate

`migrations/153_source_artifacts.sql:29-44` states it verbatim:

> *"A rent roll belongs to a property. A loan document belongs to a deal. An operating
> agreement will belong to a legal entity. … A polymorphic scope cannot have a foreign
> key, so it gets a trigger that does the same job: the referenced row must exist."*

The binding is a **scope pair** — `scope_type` (`check in ('deal','property')`) and
`scope_id` (uuid, **no foreign key**).

**Consequence for this ruling, and it is a correction to Slice 1:** `source_artifacts`
appears **nowhere in the 154-edge dependency graph**, because it has no `property_id`
column to be an edge. Any cost derived from that graph alone omits it entirely.

## 4b · Server-derived or client-supplied?

**Server-derived on all seven Asset Management evidence doors.** Tax, insurance
(×2), utilities, contracted services, compliance all pass `scope_id: req.operator.property_id`
— the session scope resolved server-side in `src/identity/operator.js:126-141` and re-read
against live assignments per request. They additionally run `refuseClientAuthority`
(`src/surfaces/asset_management.js:354`), which **refuses rather than ignores** a
mismatched client `property_id`, with a deliberate middleware ordering note: multer must
run first or `req.body` is undefined and a body `property_id` would be silently ignored
instead of refused.

**One door is client-named and server-authorized:** `src/onboarding/deal_setup.js:280`
takes `req.params.propertyId` from the URL, but only after
`resolveActivationScope` requires the user to hold the deal *and* the property to be a
`status='current'` member of it, else `403 property_not_in_deal`. The authority is **deal
membership, not property session scope** — any property currently in a deal you hold is an
acceptable target. This is the rent-roll/onboarding door.

No writer accepts a body-supplied property id.

## 4c · Does anything prevent cross-property attachment?

**No — nothing does.**

There is no composite FK, no `(id, property_id)` agreement constraint, and decisively **no
validation of a document's content against the property it is filed under**. The scope
trigger checks only that *some* property row with that id exists
(`153_source_artifacts.sql:113`). The service inspects bytes for *shape* only — extension,
magic bytes, textuality — never for *subject*. Nothing reads an address, parcel number or
loan number out of a file and compares it to the property. The filename is explicitly
non-authoritative (`153:56-57`: *"it is never used to decide anything"*).

**A document is bound to whatever scope the uploader was standing in.** A "4125 Otis" file
uploaded while the session is scoped to a property displayed as Solo is stored under that
property with no objection anywhere in the stack. That is a sufficient explanation on its
own, requiring no identity confusion at all.

**Citation-time scope agreement is enforced unevenly.** Onboarding, Utilities, Contracted
Services, Compliance and Insurance-establishment all refuse an out-of-scope artifact —
e.g. `src/onboarding/activation_service.js:234`: *"The artifact must be about THIS deal or
THIS property. Otherwise one property's position could be established from another's
document by passing an id."* **Debt and Equity have no such guard**
(`debt_instrument_service.js`, `equity_position_service.js` insert
`source_artifact_id` with no scope read), and `tools/debt/establish_instrument.js:178`
resolves evidence by hash with **no scope filter at all**.

## 4d · The binding is immutable, and there is no rebinding path

`source_artifacts_are_immutable()` (`153:142-163`) **refuses every DELETE**, and refuses
any UPDATE that changes `content`, `sha256`, `byte_size`, `scope_type` or `scope_id`.

**Rebinding path: NOT_FOUND.** No `update source_artifacts … set scope_id` exists in
`src/`, `server.js`, `tools/` or `migrations/`. No authority — not super-admin, not a
repair tool — has a path to it. The designed remedy is stated in the trigger's own hint:
*"Upload the corrected file as a new artifact and establish again."* **The wrong-scope row
stays on record permanently.**

For a rebind this is the sharpest constraint in the whole inventory: artifacts are left
behind on the old `scope_id`, and the database actively refuses to move them.

---

# THE RULING BRIEF

Three options, costs stated, **no recommendation.** §12 — *identity is address, not
display name* — and the owner's ruling govern this.

**Common to all three:** the two unknown UUIDs must be resolved (census STEP 0) before any
option can be costed in rows rather than in tables. Nothing below is a row count, because
no row was counted.

## OPTION A · The demo row becomes canonical 4233

`a50fbdd0…` is renamed/re-keyed to be 4233 Chestnut; `9e2bb96e…` is retired.

```text
WHAT BREAKS
  · 91 referencing lines, of which 4 are runtime src/ and 3 are migrations that
    already wrote it
  · leasepackets.js:181 keys real Solo lease economics off this UUID — those become
    correct rather than incorrect, the one place where A is cheapest
  · every "demo" guard that PROTECTS it now protects production data under a demo
    name: owner.js NEVER_DELETE, _db_target_guard.sh, the seed refusal walls in
    seed_demo_agent_facts.js / seed_demo_inventory.js which currently refuse when the
    target equals Solo — after A, the demo target IS Solo and those walls invert
  · the four name-resolving call sites (§3f) keep resolving by a name three rows share
  · 9e2bb96e… has one compliance record that must go somewhere or be abandoned

WHAT A RENAME DOES NOT FIX
  · the name collision. Three rows are still named "Solo on Chestnut"; A changes which
    one is canonical, not how many share the string
  · leasingleads.js:1051's booking scope wall, which still re-verifies by name
  · source_artifacts, which are keyed to the UUID and would be correct by luck rather
    than by decision
  · CLAUDE.md's own warning applies in full: a rename is a contract change, and
    "renaming rendered text while routes, modules and identifiers keep the old word
    reserves nothing"

MARLOW'S TOUR   safest of the three — the row does not move, its parent does not move,
                and only the parent's name/key changes. No FK traverses.
```

## OPTION B · Move the demo row's governed records to `9e2bb96e…`

```text
HOW MANY ROWS, IN HOW MANY TABLES
  · up to 152 tables carry a property_id; how many hold rows is UNKNOWN until the
    census runs. That number is the whole cost of B and this build cannot supply it.

THE SIX SET NULL COLUMNS NEEDING EXPLICIT HANDLING
  · listed in §1b. On a rebind they do not follow the record — five of the six are
    identity and scheduling history, the least likely to be noticed missing.

WHAT BLOCKS THE ORDER
  · the 71 RESTRICT / NO ACTION walls constrain the SEQUENCE of a repoint, not merely
    whether one is possible
  · the FOUR SINGLETON constraints (§1f) are the hard stops: if both rows hold a
    published pricing version, an active property-facing line, an established opening
    tenancy position, or a current deal membership, the merge collides with certainty
  · ai_leasing_operating_rules and governed_charge_rulings (§1d) refuse deletion
    outright — relevant if B ends by deleting the emptied row
  · A MERGE FAILS PART-WAY THROUGH, and no transaction boundary for a repoint is
    stated anywhere in source. That is itself a thing B must build.

WHAT B CANNOT MOVE AT ALL
  · source_artifacts. The database REFUSES to change scope_id (§4d). Every artifact
    stays on a50fbdd0… permanently, or is re-uploaded as a new artifact and
    re-established — and the wrong-scope row remains on record either way.
    This is the single hardest constraint on B and it is invisible to the FK graph.

MARLOW'S TOUR   most exposed of the three. leasing_tours.property_id would be repointed
                by whatever mechanism B builds. The row is protected only transitively
                (§3d), so if B's repoint runs outside owner.js's NEVER_DELETE guard —
                which guards DELETION, not UPDATE — nothing in source names this row.
```

## OPTION C · Both rows persist under an alias / supersession model

```text
WHAT HAS TO LEARN ABOUT ALIASES
  · src/identity/registry.js already refuses ambiguous name resolution and asks for a
    `source=` disambiguator — C is closest to the mechanism that already exists
    (§41: existing-mechanism-first)
  · the four name-resolving call sites in §3f must stop resolving by name
  · every read that assumes one property row per identity: portfolio, owner surface,
    Ask Spine's standing reads, reporting
  · the person-correction precedent already in the repo is "retire + point, move
    nothing", which is structurally what C is

§12 SAYS IDENTITY IS ADDRESS, NOT DISPLAY NAME
  · C is the only option that does not require choosing which row "is" 4233 — but it
    must then state what the ADDRESS-level identity is and which row carries it, or it
    has preserved the ambiguity rather than modelled it
  · the risk specific to C: an alias model that is not read by every surface produces
    two properties that are sometimes one and sometimes two, which is worse than either
    A or B

MARLOW'S TOUR   untouched. No row moves. This is C's clearest advantage.
```

## What the census must answer before any option is costed

1. The two unknown UUIDs (STEP 0).
2. Row counts per table per candidate (STEP 3) — the whole cost of Option B.
3. Whether more than one candidate holds each of the four SINGLETON rows (STEP 5) — this
   decides whether B can run as one transaction at all.
4. Whether either candidate holds `ai_leasing_operating_rules` or `governed_charge_rulings`
   rows (STEP 6) — this decides whether a delete is possible at any price.
5. How many `source_artifacts` sit under each (STEP 7) — the permanently immovable set.
6. Which property currently owns Marlow's tour (STEP 8).

---

## DEFECTS FOUND, RECORDED NOT FIXED

Real, in the blast radius, recorded rather than chased (CLAUDE.md: *when you find an
adjacent defect… record it and move on*).

| # | Finding | Evidence |
|---|---|---|
| A | **Defect #12 has an unnamed sibling.** `concession_policies` shares the identical trigger function and fails identically | `102_pricing_lifecycle_and_authority.sql:161` |
| B | **Release 0 proof evidence is silently destroyed by a property delete**, despite carrying a delete-refusal trigger. Proven on a disposable DB | `work_order_proof_attachments`, `140_post_activation_completion_guard.sql:737` |
| C | **A security scope wall is implemented on a property NAME held by three rows, with no `limit 1`** | `src/leasing/leasingleads.js:1051` |
| D | **Marlow's tour is protected only transitively** — two references, one a comment; nothing keyed on the row | `src/surfaces/owner.js:166`, `tests/never_delete_guard_proof.js:27` |
| E | **Debt and Equity cite source artifacts with no scope check**, unlike five sibling domains | `debt_instrument_service.js`, `equity_position_service.js`, `tools/debt/establish_instrument.js:178` |
| F | **A scale-harness SQL file inserts the production Demo Building UUID** under a different name | `tools/scale/seed_b_qa_identity.sql:43,49` |
| G | **The property-scoped flag count is eight, not seven** — one is invisible to the obvious grep | `src/identity/capability.js:129,152` |

---

## WHAT THIS BUILD DID NOT DO

```text
✗ no ruling — the direction is not established here
✗ no database write, anywhere, of any kind
✗ the census was NOT run against production
✗ migrations/ untouched — ledger stays frozen at 189
✗ no PR against main, no merge, no deploy
✗ property-spine-app untouched
✗ nothing built that COULD execute a merge or rebind — this build produces documents
```

**Rung: `LOCALLY_EXERCISED`.** No browser, no production access, no deploy. The
disposable-Postgres proofs (defect #12's mechanism, the two trigger walls, the census
execution, the read-only wrapper) were run against a database created and destroyed
inside this session — real Postgres, real schema from the real chain, and still not
production.
