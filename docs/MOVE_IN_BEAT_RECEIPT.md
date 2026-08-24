# The move-in beat — §41 pre-build receipt

**Thread:** CABIN · `claude/docs-philosophy-review-s5yalc`
**Base:** `7e67f50` (ledger 192), not `main` · **Date:** 2026-08-24
**Lane:** `src/tenancy/` only. Everything outside it was read, never edited.

**The question:** a lease is signed and executed. What has to happen for that
resident to appear as live occupancy, and where does the existing path stop?

**The headline:** the beat is **not broken**. The gap this thread was handed is
**refuted**, on real Postgres. The real finding is a different one, one rung
down, and it is latent rather than active.

---

## INTENT

An operator signs and executes a lease. Without anyone re-entering a fact,
the resident should become live occupancy on the Current Rent Roll and in the
Ask Spine standing projection — and possession must remain a separate axis, so
that "the lease is active" never silently claims "they have the keys" (§29).

---

## THE CLAIM I WAS ASKED TO VERIFY, NOT TRUST

> "the rent roll is unit-keyed with no `person_id`, and the signed-lease
> resident is person-keyed, so a real signed lease may not become live
> occupancy"

### REFUTED. Observed, not argued.

`tests/move_in_beat_drive.db.js` — **12/12**, real Postgres built from the real
chain to ledger 192.

The rent-roll read is unit-keyed at the top and **carries the person all the
way down**. `tenancy_anchor_service` writes `tenantIds = app.person_id ? [app.person_id] : []`
into `leases.tenant_ids`; `loadSpaceRows` aggregates `l.tenant_ids`; `spacePosition`
resolves them against `persons`; `classifyPosition` emits them as `tenants[]`.
Observed at both ends of the beat:

```
D1  pending lease   → RESIDENT NAMED — Dana Resident <cab10001>   (person_id present)
D6  after activation → RESIDENT NAMED on live occupancy — Dana Resident <cab10001>
```

> **I got there by going red on my own bad assertion first.** My first pass
> asserted `.resident` and failed against a payload that plainly contained
> `"tenants":[{"person_id":"…","name":"Dana Resident"}]`. The key is `tenants`,
> not `resident`. Recorded because a harness that names the wrong field
> **manufactures a defect** — and this one would have "confirmed" a gap that
> does not exist.

---

## EXISTING MECHANISM

One canonical chain, and every writer in it already exists:

```
executed lease (verified)
  → tenancy_anchor_service.confirmTermService   lease_status='pending', tenant_ids=[person]
  → economic_tenancy_service.confirmMoveInChargeSet   raises first_month + deposit
  → payments applied to those charges
  → economic_tenancy_service.attemptEconomicTenancyActivation   lease_status='active'
  → spacePosition / datedPropertyPositions / readTenancyStanding   occupancy
```

`lease_status='active'` has exactly **one** writer in `src/`:
`economic_tenancy_service.js`, at the line reading `set lease_status='active',`.

### Two corrections to the map I was given

**1. Nothing writes `'signed'`.** I expected the stop to be a read/write
vocabulary split — `position_classifier` accepts `ACTIVATION_PENDING_STATUSES =
{"pending","signed"}` while the activation writer accepts only `'pending'`. It
is not a stop: no code in `src/` or `server.js` ever writes `'signed'`. Every
insert is `'pending'` (`tenancy_anchor_service`), `'active'`
(`onboarding/activation_service`, `identity/activation.js` — the latter is dead,
never mounted), or `'cancelled'` (`lease_void_service`). `'signed'` is defensive
vocabulary for data arriving from elsewhere. **The inferred stop was wrong and
running it is what showed that.**

**2. `docs/CURRENT_STATE.md` on `main` attributes the wrong file.** Its row
reads *"Confirm hard-codes `lease_status='active'` (`activation_service.js:696`)"*.
Both halves are true of **different** services: `onboarding/activation_service.js`
inserts `'active'` — that is the **opening rent-roll import**, not confirm-term.
Confirm-term is `tenancy_anchor_service.js`, and it writes `'pending'` exactly as
it should. Not corrected in that file by me — I did not personally re-verify the
row's original context, and it is shared and append-only.

---

## WHAT I ACTUALLY RAN

Disposable local Postgres 16.13 on `127.0.0.1:55434`, schema built by
`tests/e2e/apply_migrations.sh` to **ledger ceiling 192, zero stops**. No Neon,
no Render, no production, no migration number assigned.

| # | Step | Result |
|---|---|---|
| D1 | pending lease reads as ACTIVATION PENDING, resident named, not yet occupied | pass |
| D2 | activation refuses before funds | `409 move_in_funds_outstanding` |
| D3 | `confirmMoveInChargeSet` through the canonical writer | raised `deposit=1500` + `first_month=1500` |
| D4 | pay every raised charge | funds `cleared`, `cash_proven` |
| D5 | `attemptEconomicTenancyActivation` | activated |
| D6 | unit reads CURRENT OCCUPANCY, resident named, `proof_basis=native_verified` | pass |
| D6 | standing projection agrees — `occupied = 1` | pass |
| D6 | possession stays PENDING — economic ≠ physical (§29) | pass |

**Fixture boundary, stated.** The harness seeds the *durable output* of
confirm-term (a `pending` lease linked to a verified `executed_lease_record`)
rather than driving confirm-term itself, because that route lives in
`src/identity/operator.js` behind `dormantWriteGuard` and an activation
perimeter — outside this lane. **So this proves the segment from the anchor
onward and does NOT prove confirm-term.** Said plainly: a harness that seeds its
own precondition and then claims the whole chain is how a green run becomes a
false rung.

---

## THE OBSERVED STOP

**There is no functional stop in the beat.** It runs. The two real gates are
deliberate and both behaved correctly:

1. **Entry is switched off by default.** `confirm-term` sits behind
   `dormantWriteGuard` — `COMMITMENT_LEDGER_MODE` must equal exactly `enabled`,
   fail-closed on unset or typo — plus an activation perimeter. That is a
   Class-4-shaped release switch, not a defect, and it is outside this lane.
2. **Funds gate holds.** Activation refuses with `409 move_in_funds_outstanding`
   until a confirmed charge set is fully applied. Absence of a charge set is
   *not* treated as funded — the honest direction.

### What I found instead, one rung down

**A unit-grain write performed for a space-grain fact.**
`attemptEconomicTenancyActivation` ends with:

```sql
update units set occupancy_status='occupied', updated_at=now() where id=$1   -- lease.unit_id
```

On a **bed-grain** unit, activating **one** bed stamps the whole unit. Measured
on a real 3-bed unit:

```
units.occupancy_status   unknown → occupied     (bed A activated; B and C have no lease)
bed B  occupancy_claim = 'occupied'   ← no lease of its own
bed C  occupancy_claim = 'occupied'   ← no lease of its own
```

This matters because the brief names bed-grain as the imminent live case.

### But it is LATENT, and that distinction is the finding

Every reported number is **identical** with and without the spill, isolated by
holding the activation constant and toggling only the column:

```
with spill     {"occupied":1,"open":0,"not_established":2,"activation_pending":0,"needs_review":0}
without spill  {"occupied":1,"open":0,"not_established":2,"activation_pending":0,"needs_review":0}
```

`positionBasis()` refuses to let the unit-level column establish anything. Its
own comment states the rule — *"THE UNIT-LEVEL COLUMN IS CONTEXT, NEVER A BASIS
… a placeholder must not be the thing that offers a bed to a prospect"* — and
the read names the weak basis explicitly: `basis_type='unit_occupancy_status_only'`,
`authoritative:false`. Checked three consumer surfaces; none moves:

| Consumer | Effect of the spill |
|---|---|
| `datedPropertyPositions` / rent roll | claim value changes, every classification identical |
| `readTenancyStanding` (Ask Spine) | identical |
| `leasing_inventory.availableUnits` | identical — excluded by the live-lease predicate regardless |

**So I did not change the write.** There is no observed red, and §30 says
preserve durable primitives unless current evidence proves them wrong. Changing
a writer with two consumers on the strength of a theory is the move this
repository keeps paying for.

---

## SMALLEST MISSING PIECE — and it was a gate, not a fix

The invariant that makes the bad write harmless was held by **a comment and one
string literal**. Nothing went red if someone changed it.

`tests/bed_grain_occupancy_spill.db.js` (**6/6**) makes it executable: E1 the
spill is real, E2 the false claim reaches unleased beds, E3 it is latent, **E4
the invariant** — a unit-level claim never establishes a bed and never makes one
contractually free.

### Falsified product-side, at an exact SHA

Not a selector or a rename — the real invariant, flipped:

| | |
|---|---|
| SHA | `41c1aa6129f5346435096e48d969311e4ea75137` |
| file | `src/tenancy/dated_positions.js`, `positionBasis()` unit-level arm |
| change | `state: "not_established"` → `state: "established"` (one literal) |
| intended blob | `acd1388b6a1690793a41cd635025c14a3e8787c0` |
| falsified blob | `3275f60c36553cc5cddeb82494f77c233972365e` |
| result | **E3 and E4 red · 4 passed, 2 failed · exit 1** |
| restored | blob back to `acd1388b…`, byte-identical · **6/6, exit 0** |

With the invariant broken, `not_established` collapses 2 → 0 and two unleased
beds acquire an established basis from an undated, overwritten, unit-grain
placeholder. That is the bed offered to a prospect who then arrives at an
occupied room.

> **E3 caught me too.** My first version compared before-activation against
> after-activation and went red — it was measuring the *activation*
> (`activation_pending 1 → occupied 1`, the product working correctly), not the
> spill. The wrong control is how a correct system gets reported as broken.

---

## FORBIDDEN SECOND PATH

A future thread must **not** build:

- **A second writer of `lease_status='active'`.** There is exactly one in
  `src/` today. ⚠ `server.js:1557` already contains a bare inline
  approve/reject route doing `update leases set lease_status=$1` with **no**
  funds gate, no economic-tenancy record, no activation event. It bypasses
  every guard proven above. Reported, not touched — `server.js` is outside this
  lane. If it is live, it is a hole in the move-in beat.
- **A second occupancy column.** The fix for the bed-grain spill is *not* a new
  `spaces.occupancy_status`. Space-level occupancy is already derived from
  leases and possession events; adding a stored column creates a second truth
  that must then be reconciled.
- **A bed-grain branch in the activation writer.** Any correction is "write the
  fact at the grain it is true," not `if (property is bed-grain)` — §22.
- **A unit-level fallback that trusts `occupancy_status`.** The gate above now
  fails if anyone tries.

---

## COMPONENT CLASSIFICATION

| Component | Class | Note |
|---|---|---|
| `economic_tenancy_service.js` (activation, charge set, funds) | **1** | permanent; unchanged by this slice |
| `tenancy_anchor_service.js` confirm-term | **1** | permanent; read only |
| `positionBasis()` unit-level arm | **1** | permanent; the wall, now pinned |
| `tests/move_in_beat_drive.db.js` | **3** | test infra, no removal condition |
| `tests/bed_grain_occupancy_spill.db.js` | **3** | test infra, no removal condition |
| `update units set occupancy_status` (unit-grain write) | **1, suspect** | not reclassified without a ruling — see below |

**No Class 2 adapter was created**, so there is no removal condition to track.

---

## THE RULING THIS RECEIPT ASKS FOR

The unit-grain write is wrong at the grain and currently harmless. Three
options, none taken unilaterally because the write has a second consumer
(`turnover_service.js` writes `'vacant'` to the same column, with the **same**
structural problem in the opposite direction — one bed turning over would mark
the whole unit vacant):

1. **Leave it, keep the gate.** Cheapest. The wall is now executable.
2. **Guard the write** to fire only when the unit has exactly one space. One
   line, in this lane — but it changes a column two other domains read.
3. **Retire the column as a basis entirely.** Largest, and the only one that
   removes the class of defect rather than this instance.

**Recommendation: 1 now, 3 eventually.** Option 2 is the tempting middle and it
leaves `turnover_service` writing the same wrong grain.

## Schema this receipt needs

**None.** No migration number assigned, nothing applied. The correction under
discussion is a write-grain question, not a schema question.

---

# ⛔ CORRECTION, appended 2026-08-24 — the rung above is overstated

**Everything above is left exactly as written.** It is the original receipt and
stays visible as history. Where it and this section disagree, **this section is
correct**.

## The rung

The body above reports the move-in beat, the bed-grain spill observation and the
product-wall falsification at **`HTTP_PROVEN`**. That is wrong.

`docs/CURRENT_STATE.md` defines `HTTP_PROVEN` as **one test carrying real
Postgres *and* a real router** — `require("pg")` plus `listen()` in the same
file. These harnesses have the first and not the second. Measured, not asserted:

```
tests/move_in_beat_drive.db.js          http-markers=0   requires-pg=1
tests/bed_grain_occupancy_spill.db.js   http-markers=0   requires-pg=1
```

> ### The honest rung is `LOCALLY_EXERCISED`.

They used **real Postgres at the service boundary** — schema built from the real
migration chain to ledger 192, canonical services called directly — and **did not
traverse an HTTP route**. **No `HTTP_PROVEN` rung was earned.**

The same correction applies to the two Slice 1 harnesses in
`docs/TENANCY_STANDING_COST_RECEIPT.md`, which have the identical shape and the
identical zero HTTP markers. Recorded in `CURRENT_STATE.md`'s correction section.

## The fixture boundary, restated as a limit on the claim

The body above already states that the harness seeds confirm-term's durable
output rather than driving confirm-term. Stated here as a **rung** limit rather
than a footnote:

**`confirmTermService` was never executed and is not proven.** The beat is
established *from the anchor onward*, at the service boundary only.

## What the CI run proves

https://github.com/kzitelli-art/property-spine-api/actions/runs/32758785833 ·
SHA `ea8b5a97c328cdfddfe6039b831520ecef745292` · parent exit **0** · **NOT RUN:
none** · later proofs executed.

It proves the **existing 17-step branch baseline only**. **Neither harness in this
receipt is declared in `tests/e2e/verify_all.sh`**, so that green run does not
prove either of them in CI. The runner never invoked them.

## What the falsification was

A **local working-tree falsification** based on commit
`41c1aa6129f5346435096e48d969311e4ea75137`, evidenced by blob identity
(`acd1388b6a1690793a41cd635025c14a3e8787c0` →
`3275f60c36553cc5cddeb82494f77c233972365e` → restored to `acd1388b…`) and by
**exit 1 → exit 0**.

**It was NOT an exact committed red SHA, and NOT a GitHub red run.** No red
commit and no red CI run exist for it.

## What is unchanged

- The **refuted resident-carry gap** and the **latent bed-grain spill** stand as
  observations. Only the rung naming them is corrected.
- Both harnesses remain **Class 3**, no removal condition. Tenancy primitives
  remain **Class 1**. **No adapter exists.**
- The unit-grain writer was not changed. `server.js:1557` remains **`REPORTED`**
  and outside the CABIN lane.
