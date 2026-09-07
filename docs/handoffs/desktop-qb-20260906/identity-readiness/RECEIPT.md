# Identity and readiness evidence — Fable independent assignment, 2026-09-07

Return to QB task 01a076e5-512c-70c3-a237-e8ca01c528f0. Evidence branch
`claude/identity-readiness-evidence-20260907`, cut from `4915c9d` (API) and
read against QB's `codex/claim-relay-20260907` head `94298bc` for the files QB
owns. **No product file was edited.** Two files under `tests/` and this
directory only:

| File | What it is | In CI |
|---|---|---|
| `tests/proofs/identity_lineage_challenge.db.js` | NEW. Observation proof, 20 assertions, real writers (`openActivation`, `ingestRentRoll`, `confirmProposal`, `establishOpeningPosition`, `retireInventoryUnits`, `reinstateInventoryUnit`); direct inserts only to replay rows the old writer produced | **No, on purpose.** It pins current behaviour including the two defects it argues for; wiring it into `verify_all.sh` would make QB's repair go red. QB's repair should split it into witness/successor the way `opening_claim_identity.db.js` is split |
| `tests/proofs/availability_readiness_axis.db.js` | +11 lines: the same seven readiness shapes now also pass through `evaluateOfferability`, so the application-targeting column of the matrix below is exercised, not read | Already in `verify_all.sh`; 15/15 successor and 15/15 parent (`PROOF_EXPECT_DEFECT=1` on `e86b746`) |

No PR, merge, rebase, force-push, migration allocation, production or
provider action, real-user mutation, or actual-source confirmation. The
pending claim-index DDL exists only in the nonce-owned proof database, which
is dropped at the end of this thread. Runtime identifiers in the two JSON
artifacts beside this file are replaced with `<uuid>`.

```text
. run1/env_all.sh          # owned DB spine_proof_<nonce>, fenced preloads, PROOF_OUTPUT_DIR
node tests/proofs/identity_lineage_challenge.db.js       → 20 passed, 0 failed
node tests/proofs/availability_readiness_axis.db.js       → 15 passed, 0 failed
PROOF_EXPECT_DEFECT=1 PROOF_BUSINESS_ROOT=<e86b746 worktree> \
  node tests/proofs/availability_readiness_axis.db.js     → 15 passed, 0 failed
node tests/proofs/opening_claim_identity.db.js            → 17 passed, 0 failed (case D reads as a recorded control)
```

---

## Q1 — can present-null lineage distinguish a valid sole-position confirmation from an ambiguous unit-level promotion?

**Answer: no. Not by lineage shape, not by count, and not without an
inventory-history table.** Reproduced with the writers, not by inspection.

### What the ingest actually writes (exercised)

Three properties, one bare `101,VACANT` style row each:

| Property shape | `produced_unit_id` | `produced_space_id` at ingest | spaces after ingest |
|---|---|---|---|
| sole bed (`101` → Room1) | linked | **null** | 1, unchanged |
| bed set (`102` → Room1..3) | linked | **null** | 3, unchanged |
| by unit (`103` → `(whole unit)`) | linked | linked to `(whole unit)` | 1, unchanged |

So a bare row on a bed property is **present-null at the space for every
bed count**. Present-null is the universal pre-confirmation shape on bed
properties, not a signature of ambiguity.

### What the current writer does (exercised, `confirmProposal` after QB's `0414e52`)

| Row | Result | Lineage after |
|---|---|---|
| sole bed | confirmed | `produced_space_id` → Room1 |
| bed set | refused, "…which bed…", `needs_review` | still null, nothing linked |
| by unit | confirmed | `produced_space_id` → `(whole unit)` |

### The replay (exercised): old writer on a bed set and on a fresh sole bed

Both promoted with `produced_space_id` still null, then established.

| Case | Reader result | Lineage at read time |
|---|---|---|
| current writer, sole bed (`101`) | `opening_claim_vacant` on Room1 | space linked |
| old promotion, bed set (`102`) | `not_established` on all three beds | unit linked, space null |
| old promotion, sole bed (`104`) | `opening_claim_vacant` on Room1 | unit linked, space null |

The `104` row and the `102` row are **byte-identical in lineage shape**. The
reader separates them only by *today's* position count (rule 2 in
`space_position.js`: bare key on a unit-linked row attaches when the unit has
exactly one position). That is the sole-position ruling working as frozen; it
is not a distinction between "valid when confirmed" and "ambiguous when
confirmed". If `104` later gains a second bed, its claim stops attaching, and
if `102` is later collapsed to one bed, its claim starts attaching. Neither
transition consults history.

### The word "exclusively" — evidence and the strongest counterexample

Row 63 / the earlier assessment said present-null promoted rows are
"exclusively" old-writer rows. Evidence for it: the current writer links the
space on every confirmation it accepts (`confirmProposal` resolves the space
first and refuses `ambiguous_bed` / `unknown_space_label`), so a row promoted
by it is never present-null. That part holds on the exercised paths.

**Strongest counterexample:** "exclusively old-writer" is a statement about
*promoted* rows; the pre-confirmation shape is present-null for every bare
row on every bed property, current writer included. Any path that flips
`status` to `promoted` without going through `confirmProposal` — a bulk
promotion, a repair script, a future "accept all" — produces a present-null
promoted row from the current writer's own ingest. The proof does exactly
that in one SQL statement. So the safe wording is: *present-null promoted
rows are rows whose promotion did not pass through the space-resolving
writer*, which today means old-writer rows and any direct status write.
"Exclusively old-writer" is true of the writers, not of the table.

### Creation time as identity

Not used anywhere in the proof, and it would not help: the `104` replay was
written *after* the `101` confirmation and the reader still treats them the
same, correctly, because the rule is about shape.

### Recommendation, kept separate from what is proven

Proven: present-null lineage cannot carry the distinction. Recommended (not
proven, QB's call): **no rule change.** The sole-position ruling is already
the honest reading of an unlinked claim, and the shrink-to-one edge is
recorded in row 63 as a compatibility boundary. The one durable fix is to
stop *producing* the shape, which QB's writer already does; the residue is a
backfill question (link `produced_space_id` for existing promoted sole-bed
rows), not a reader question. I did not write that backfill.

Ledger single-bed control: `opening_claim_identity.db.js` case D still reads
as a recorded control (17/17 on this branch).

---

## Q2 — does clearing `reversed_at` let an old null-lineage claim cross onto replacement identity?

**Answer: yes for a text-only claim, no for a unit-linked claim, and the
scenario cannot be reached through the writers alone.** Exercised twice.

Sequence in both variants: promote → establish → `retireInventoryUnits`
(reason `superseded_inventory_grain`) → **manual rename** of the retired unit
to `201 (retired)` → insert replacement `201` → `reinstateInventoryUnit`.

| Variant | While retired | After reversal |
|---|---|---|
| unit-linked claim (`201`, `produced_unit_id` set, space null) | replacement `not_established` | claim follows its **durable** unit, the reinstated `201 (retired)`; replacement still `not_established` |
| null-lineage claim (`202`, no evidence row, the legacy shape the pending index still admits) | replacement `not_established` | claim **crosses onto the replacement** `202`; the reinstated `202 (retired)` it was confirmed against gets nothing |

### Before calling it a defect: the reversal's own checks (source, `inventory_retirement.js:259–276`)

`reinstateInventoryUnit` requires a human actor and a reason, and refuses
when there is no live retirement. It has **no** check that live inventory
already carries `original_unit_number`, and no lease or replacement conflict
check. Date-insensitivity is intentional and is not the issue here.

### Why the scenario is narrower than it looks

- `retireInventoryUnits` (`inventory_retirement.js:141–250`) **does not
  rename** the retired unit. `uq_unit_per_property(property_id, unit_number)`
  therefore forbids inserting a replacement with the same number while the
  retired row exists. The proof had to rename by hand. Migration 180 stores
  `original_unit_number` because renumbering was anticipated, but no writer
  in `src/` performs it. State where I looked: `src/` and `server.js`.
- The crossing needs a claim with **no evidence row at all** (or an evidence
  row with neither `produced_unit_id` nor `produced_space_id`). Every row the
  activation ingest writes has `produced_unit_id`, so this is the pre-lineage
  legacy shape only.

### Strongest competing explanation

The text rule (rule 3) is doing exactly what it says: with no lineage, a
claim attaches to whichever live unit carries the number today. After
reversal there is no retirement standing between the text and the
replacement, so the reader is consistent with its own contract. What is
missing is not in the reader; it is that **reversal has no conflict check**.

### Smallest supported protection (proposed, not implemented; owner: `inventory_retirement.js`)

Refuse `reinstateInventoryUnit` with a named code (e.g.
`REINSTATEMENT_NUMBER_IN_USE`) when another live unit on the property carries
the retirement's `original_unit_number`, and say which unit. This is the
writer's boundary, needs no new inventory writer, removes no row, and leaves
date-insensitivity untouched. Reader-side alternatives (keeping the retirement
fence after reversal) would contradict the meaning of reversal.

---

## Q3 — a NAMED `(whole unit)` claim, or a durable link to a retained placeholder, beside real beds

**Answer: both attach, both are offered `marketable_now`.** The bare-key
refusal in the readers covers only the bare shape.

Fixture: bed property, unit `301` with `(whole unit)` retained beside Room1..3,
unit `302` with `(whole unit)` beside Room1..2. Five real beds, two placeholders.

| Claim | Shape | Attaches | Availability |
|---|---|---|---|
| `301` source row `301,(whole unit),VACANT` replayed as an old promotion | named, space null | yes, to the placeholder | `marketable_now` |
| `302` row with `produced_space_id` pointed at the placeholder, key rewritten to `302` | durable link | yes, to the placeholder | `marketable_now` |

Seven positions read for five beds. Neither phantom is visible as a phantom
on the availability row.

### Canonical owner

`spaces.position_kind`, written by `inventory_materialization.js` (kinds
`bed` | `unit`). Both fixtures leave it null, which is the retained-placeholder
state in production too. `dated_positions.js:761–767` already derives
`position_kind` as `unit` for a `(whole unit)` label when the governed value
is null, and `availability_read.js:535` carries it on the row. So the signal
already exists on the read side.

### Strongest competing explanation

A `(whole unit)` position beside beds could be a legitimate mixed-grain
fact: a property that leases most units by the bed and this one whole. If so,
the named claim is right and the beds are the phantoms. **Nothing recorded
distinguishes the two today** because `position_kind` is null on both. That
is why the protection below holds rather than removes.

### Smallest supported protection (proposed, not implemented; owner: QB's readers, `dated_positions.js` / `availability_read.js`)

A unit whose positions carry both kind `unit` and kind `bed` (governed or
derived) is a shape conflict: a whole-unit position and a bed cannot both be
rentable positions of the same unit at once. Read-side, hold every position
in that unit out of `marketable_now` with a named blocking fact (e.g.
`inventory_shape_conflict`), count the unit once in a "needs inventory
decision" bucket, and let materialization resolve it by writing
`position_kind`. No new writer, no silent row removal, no dependence on the
label beyond what `dated_positions` already does. The bare-key refusal stays.

---

## Q4 — readiness: the exact gates, in operator language

Traced in source and, where a proof exists, exercised. Shapes are the seven
in `availability_readiness_axis.db.js`; every one has an established vacancy
basis so readiness is the only axis in play.

| Gate | Where the decision is made | What it reads | Evidence |
|---|---|---|---|
| **Marketing** ("can we advertise it?") | `availability_read.js` `marketingState` | lease / commitment / possession / turnover, then basis and evidence guards, then triage: `readiness_unknown` when a walk is assigned and not done or a triage found no blocker but no readiness inspection; `not_ready_confirmed` on a severe triage; otherwise offered | exercised, 15/15 both modes |
| **Touring** ("can we show it?") | no unit-state gate. `tour_availability_service.js` slots take an optional `unit_id`; nothing in `src/leasing/tour*.js` reads marketing state, readiness or occupancy | nothing | source only; searched `src/leasing`, `server.js` |
| **Application targeting** ("can someone apply for it now?") | `application_target_authority.js` `evaluateOfferability` | `marketing_state` only. Allowlist: `marketable_now` offerable; `upcoming` / `turnover_required` need a governed date; everything else `not_offerable`. Readiness is never consulted a second time | exercised: offerable exactly where marketing offers |
| **Delivery** ("can we hand over keys?") | `movein.js` move-in delivery inputs `unit_ready` and `keys_access_ready`; `unit_ready` is fed by approving the `rent_ready_approval` obligation (`movein.js:39, 256–257`), which "proves physical readiness only" | an operator approval, **not** `unit_readiness_certifications` | source only; not exercised here |

### Decision matrix (what an operator sees, per shape)

| Shape | Owner says | Marketing | Touring | Application | Delivery |
|---|---|---|---|---|---|
| nothing recorded | unknown | offered | allowed | offerable | waits on rent-ready approval |
| walk assigned, not done | unknown | held, "initial inspection pending" | allowed | not offerable | waits |
| walked, no blocker | unknown | held, "readiness unconfirmed" | allowed | not offerable | waits |
| walked, severe | not ready | held, "severe condition confirmed" | allowed | not offerable | waits |
| certified ready | ready | offered, certification shown | allowed | offerable | waits on the same approval |
| certified, then revoked | unknown | offered, as if never looked | allowed | offerable | waits |
| turn completed, not certified | unknown | offered | allowed | offerable | waits |

Read down a column: **marketing and application move together; touring
never moves; delivery is a separate approval that does not read
certification.** Read across the rows: a unit nobody has looked at is treated
more generously than one someone has started looking at. That is the ruling
row 65 already records as owed, now shown to extend to applications, not just
listings.

### Rulings this leaves with Kameron and QB (no global certification policy proposed)

1. Whether "assigned but not done" should hold marketing while "never
   assigned" does not. Today it does, which rewards not assigning walks.
2. Whether a revoked certification should read as *revoked* rather than
   *never looked*. The row carries `certified_ready=false` and
   `readiness_basis=none` for both; the superseding revoked row exists in
   `unit_readiness_certifications` and is not relayed.
3. Whether delivery should read certification at all, or keep the
   rent-ready approval as its own operator act.

None of the staged July/Skyline claims are treated as confirmed vacancies
anywhere in these proofs; every fixture is synthetic.

---

## Evidence limits

- Exercised: everything in the tables marked exercised, on an owned
  Postgres with the real modules, no HTTP. The Q4 touring and delivery
  cells are source reads and say so.
- Not exercised: a real `(whole unit)` placeholder left by production
  materialization (the fixture creates the shape directly); a reversal on a
  property with leases; the rent-ready approval flow end to end.
- Where I looked for touring gates: `src/leasing/`, `src/surfaces/`,
  `server.js`. Where I did not: the app, which may gate touring client-side
  and which is not authority.
- Counts here are claims about these searches, not about the tree.
