# Build 1B — Deal Setup, Activation, and the Opening Tenancy Position

> ## ⚠ VOCABULARY CORRECTION — read this before the body
>
> **This build shipped as "Asset Management" and was renamed the next day.**
> The body below is preserved **as written**, because the reasoning in it is
> still the clearest account of why the build is shaped the way it is. Its
> vocabulary is **superseded**. The file was renamed off the reserved name on
> 2026-08-11; nothing linked to it.
>
> | the body says | the shipped name is |
> |---|---|
> | Asset Management *(the surface)* | **Deal Setup** |
> | Opening Position | **Opening Tenancy Position** — shown to people as *"Lease & occupancy established"* |
> | Opening Truth | **Opening Accounting Truth** |
>
> **`Asset Management` is RESERVED** for the owner surface — operating truth →
> economic consequence → owner judgment → reporting. It is not this build, and
> this build must not be described with it.
>
> The rename moved the **routes, the module, the DOM ids and the function
> prefix** with it, which is the only thing that reserves a name. `/asset/*`
> survives as a ⏳ Class 4 alias that logs every use
> (`deal_setup_legacy_alias`); `asset_management_console` survives as a
> historical `creation_source` enum value and is a fact about existing rows,
> not a name spend. Migration **159** is part of this build; the header below
> says 153–158 because it was written before 159 existed.
>
> Current state, and what supersedes this document:
> [`THREAD_HANDOFF.md`](THREAD_HANDOFF.md) top section.

**2026-08-11. Started from `main` @ `6c577dc`.** Migrations **153–158**.
API branch `claude/property-spine-registration-365eys` · APP same branch.

The first build of Spine's **Asset Management** side, and the build that connects
owner setup to the same operating truth the staff application already reads.

```text
Create a Deal → add a Property → upload its rent roll → establish the
Opening Position → surface the exceptions → persist it → see the resulting
position from BOTH Asset Management and the existing staff Rent Roll.
```

---

## 1. Product language

| Term | What it means | What it is not |
|---|---|---|
| **Activation** | the PROCESS: source → evidence → proposal → review → canonical records | not a record |
| **Opening Position** | the OUTCOME: *as of X date, this is the established lease and occupancy position for this property, from these sources, with these remaining exceptions* | **not a second rent-roll store** |
| **Opening Truth** | reserved, unused — the later accounting conversion (opening GL and subledger balances) | not anything in this build |

Operating truth is unchanged and remains canonical: `units`, `spaces`, `persons`,
`leases`, and the dated position reads. `opening_positions` holds no copy of any
lease and never will — a proof asserts the table has no lease-shaped column.

No rename of old internal code containing the word *truth* was performed. New
vocabulary is correct going forward; `import_rent_roll_truth.js` and the
"rent-roll truth package" receipt are named as a follow-up, not touched.

---

## 2. The correction this build exists to make

The orientation found the flow already designed and never connected:

- `src/identity/activation.js` — the whole activation flow, **never mounted**
  (no `require`, no `app.use`), with an app screen calling routes that 404.
- Its confirm path wrote **canonical leases and nothing else**.
- But `GET /operator/rent-roll` — the `liveRequired` read behind the staff Rent
  Roll — reads `import_batches → import_source_rows` and overlays canonical
  positions on top.

So an activation that wrote only canonical records would establish leases the
operator's own rent roll could not show: *"No sourced rent roll has been imported
for this property."*

**One activation now writes both.** The evidence side is not reimplemented — it is
`loadLedgerSnapshot`, the existing ledger importer, called inside the caller's
transaction. There is no second importer.

```text
retained artifact
   └─▶ loadLedgerSnapshot ──▶ import_batches
                              import_source_rows        EVIDENCE
                              units · spaces
                    │
                    └── FK ──▶ proposed_records         DECISION
                                    │
                              confirm ──▶ persons · leases
                                    └──▶ produced_person_id
                                         produced_lease_id  written back
                                         onto the evidence row
```

`import_source_rows` has carried `produced_person_id` and `produced_lease_id`
since migration 046, and the ledger importer has always written `null` into both
because it deliberately creates neither. **Confirmation is the step that was
missing.** That is why this slice fits without new lineage columns on the
canonical objects.

---

## 3. Evidence and decision, deliberately not merged

| | answers | table |
|---|---|---|
| **Evidence** | what the source actually contained | `import_source_rows` |
| **Decision** | what Spine made of it, and what a human did about that | `proposed_records` |

Joined one-to-one by `proposed_records.import_source_row_id` (migration 156), with
a unique index so one evidence row yields at most one proposal per `target_type`.
`evidence_refs` prose is kept alongside the key — the key is what a join uses, the
prose is what a human reads in a receipt.

Collapsing them would produce a table where correcting an interpretation edits the
record of what the document said, which is the one thing evidence exists to prevent.

**The chain, walked in one SQL join** (proof G1):

```sql
source_artifacts → import_batches → import_source_rows
                 → proposed_records → leases → persons
```

---

## 4. The retained source artifact

`deal_intake_files` said it plainly: *"Binary bytes are NOT stored in v1."*
`import_batches.source_file` is a **filename**, which is a claim about a file.

`source_artifacts` (migration 153) stores the file:

- exact bytes, `sha256`, `byte_size` — with a CHECK that the size **is** the bytes
- original filename, MIME, upload time, **authenticated uploader**, as-of date
- `(scope_type, scope_id)` — `'deal'` or `'property'` today. `'legal_entity'` is
  deliberately **absent** from the CHECK: reserving a word for undesigned work is
  how a schema pretends to support something it has never written.
- a trigger enforcing the foreign key a polymorphic reference cannot have
- immutable: the bytes cannot be rewritten and the row cannot be deleted

Storage is the **same Class 2 adapter ruling** as migrations 118/134
(`work_order_proof_attachments`) — reused rather than invented, so this repo has
one binary-storage pattern. Replacement condition: object storage when volume
makes database storage burdensome; ids, authority and API unchanged.

A filename is a claim, not a fact: leading bytes are checked, so a workbook
renamed `.csv` is refused with a sentence a person can act on.

### The upload is app-first

The browser parsed the rent roll and the server never saw the file. Fixed in the
order that keeps the source:

1. the **exact file** goes to the server and is retained
2. the same file is parsed **in the browser**, by the parser that already exists
3. rows are sent **with the artifact's id**

The parser was not rewritten server-side merely to retain the source, and the
source is retained anyway. If step 1 fails, nothing is parsed and nothing is
established.

---

## 5. Deal authority — 1A's doctrine, one layer up

`deal_intakes` had no organization, and eleven of twelve deal routes
authenticated with a shared bearer key and no actor. Migration 154 gives a deal:

- `organization_id`, from the session — **never** the body
- `organization_absent_reason` when it could not be derived, with a CHECK that one
  or the other is always present
- `deal_creation_events` — immutable, both actor identities, authority recorded
- `refuse_deal_reparenting()` — org → org and org → null refused **in the database**
- `deals_explain_absent_owner()` — a bare INSERT is repaired, not trusted

Built on `resolveCreationScope` from `property_creation_service` — **reused, not
reimplemented**. Two resolvers would be two answers to "which organization may
this actor write into", and the day they disagreed the safer one would be the one
nobody called.

### The backfill, in four named populations

| Population | Reason written |
|---|---|
| every member property agrees on one owner | *(inherits it — derived, not guessed)* |
| members owned by more than one organization | `member_properties_disagree_on_owner` |
| has members, none owned | `member_properties_have_no_owner` |
| no members at all | `no_member_property_to_derive_owner_from` |

A deal whose properties disagree is **named, not resolved by picking one**.

---

## 6. Membership — reuse 025, add currency, keep history

`deal_intake_properties` already existed and is correct. Migration 155 adds
`status` (`current` / `released`), `released_at`, `released_reason`, and:

```sql
unique (property_id) where status = 'current'
```

**Not** `unique (property_id)`. A building really is sold, re-acquired and moved
between deals; a global constraint would make the first deal the only deal a
property may ever have had, and the day someone needs that history the only way to
record it would be to delete the row that proves it.

One current membership. Unlimited released ones. History is additive, and a
released membership stays readable (proof B6).

---

## 7. What was improved in the existing plumbing

Reused unchanged: the ledger importer, the position classifier, `dated_positions`,
`space_position`, the canonical rent-roll reads, `deal_intake_properties`,
`property_creation_service`, the proposal status vocabulary.

Improved, because each was weak or blocked this flow:

| Defect | Fix |
|---|---|
| **`import_batches.source_type` forbade `'rent_roll_ledger'`** — the value the canonical signed-in importer has always written. No migration ever allowed it. Against a schema built from this repo, `POST /operator/rent-roll/import` **could not succeed**. | Migration 158 widens the CHECK to what the code writes, and no further |
| `loadLedgerSnapshot` **silently dropped** rows it could not place | they are written as evidence with a `parse_note` and no produced objects; the rent-roll read filters them out of the display |
| the evidence row stored only *our reading* of the source | the original cells ride along as `_source_cells` |
| no header-mapping layer existed between the app's raw rows and the ledger's canonical keys | `rent_roll_field_map.js` — one mapping, which also **reports its own work** ("what Spine understood") |
| **`VACANT` in the resident column became a person named VACANT** — inflating occupancy, revenue and the position at once | non-revenue markers are read as state, never as a name |
| an occupied row with only a **market** rent was staged as if that were the contract rent | it needs review, and says *"Asking rent is not what they pay."* |
| an activation with no property staged rows and refused at confirmation — **after** the human did the work | refused at creation (migration 156 trigger) |
| `proposed_records.status` had its seven states in a **comment**; any string was storable | a CHECK constraint |
| `confirmed_by` / `promoted_by` / `reviewed_by` read from the request **body** | rejected with `body_actor_field_rejected` (PR #38's frozen ruling) |
| the column mapping vanished on reload | **re-derived** from the evidence rather than stored, so it cannot drift from what is actually there |

---

## 8. The bare lease writer, contained

`POST /leases` created canonical lease truth from a shared bearer key, with
`property_id` and `space_id` taken from the body and believed — the same shape as
the fifth property-creation door, one level down, on the object the whole rent
roll reads.

**Contained, not deleted** (410, naming both governed paths). Nothing in this repo
posts to it — the app's every `/leases/` reference is an
`/operator/leasing/leases/:id/…` sub-path — but the shared operator key is held
outside this repository and source can prove a consumer exists, never that one
does not.

`tenancy_anchor_service.js` — a **new** lease signed natively through Spine — is
untouched. It is the right path for the thing it does.

**Retirement condition:** delete the route once a deploy has passed with no
`bare_lease_writer_contained` line in the logs. That is the only evidence
available that nobody outside was calling it.

---

## 9. Proof

| Rung | Result |
|---|---|
| Real Postgres — `tests/deal_activation_opening_position.db.js` | **60 / 60** |
| Real HTTP against **the real `server.js` process** — `tests/asset_management_http.db.js` | **25 / 25** |
| Real Chromium, real app, real API — `asset_management_opening_position.browser.js` | **19 / 19** |
| Build 1A regressions (canonical · HTTP · authority containment) | 25 / 17 / 38 |
| All 12 source-governance gates | **pass** |

### Two things worth naming about the proof

**The HTTP harness boots `server.js` itself.** The Build 1A HTTP harness names its
own gap — it rebuilds the gate chain rather than booting the server, which is a
proof about a transcription. This build adds `isAssetPath()` to that gate, so a
transcribing harness would be marking its own homework. It spawns the real
process and talks to it over a socket; the parent sets only
`HARNESS_DATABASE_URL`, so the same-target refusal still protects production.

**The load-bearing assertion is H20**: `GET /operator/rent-roll` — the staff Rent
Roll — shows the position established from Asset Management, with the source file
named and the canonical leases overlaid onto its rows. That is the two sides of
Spine sharing one truth rather than becoming two apps with separate data.

### And one thing the proof caught about itself

The browser run reported 18/19 twice against a server process that predated the
fix by 79 seconds. *Green is a claim about what was measured.* The third run, on a
verifiably fresh process, is the one that counts.

---

## 10. What this does NOT prove

A successful rent-roll activation proves: file → artifact → evidence →
interpretation → exception → confirmation → canonical records → durable Opening
Position, **for a structured, tabular source**.

It proves nothing about loan PDFs, tax notices, insurance policies, contracts,
emails, human claims, or narrative embedded in spreadsheets. Those are the harder
Money sources. The mechanism does not obviously prevent them — the artifact is
already scope-flexible and `artifact_kind` already exists — but none of it is
solved here and none of it should be claimed.

Also not done, deliberately: legal entities, accounting Opening Truth, journals,
cash/accrual, the final Asset Management IA, multi-property source mapping, the
unfinished `/operator/rent-roll/canonical` migration (left to its owning thread).

---

## 11. Findings for the next build

1. **`leases` has no `security_deposit` column** in the schema these migrations
   build — yet the dormant activation module and the old bare writer both wrote to
   one. Either production has columns the ledger never created, or those paths
   have never run there. The deposit is retained in evidence and in the proposal;
   nothing was invented to make a write look complete.

2. **`import_batches.source_type` disagreed with its only writer** and nothing
   caught it for eight migrations. Worth one query in production:
   `select source_type, count(*) from import_batches group by 1;` — the answer
   says whether the constraint was widened by hand outside the ledger, or whether
   `POST /operator/rent-roll/import` has simply never run.

3. **One setup reads one source.** A second, different file into the same
   activation is refused; correcting a file is a new setup that supersedes
   cleanly. `opening_position_sources` is already a join table for the day a
   position is genuinely established from a rent roll *plus* a correction — that
   refusal is what stops the plural case arriving before it is designed.

4. **`deal_intakes.status`** is still `created / files_received / classified`.
   There is no deal lifecycle vocabulary (`active` / `closed`), which is why
   "one active deal per property" is enforced on **membership currency** rather
   than on deal state. That vocabulary is the next design question above the
   property.
