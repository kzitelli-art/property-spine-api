# Claimed rent → trusted rent: the map, and a stop

**2026-09-19 · branch `claude-opus/lease-attach-20260919` from `origin/main`
@ `3f275823` · READ-ONLY on production (§46) · no source changed**

> ## ⛔ STOP — THE LANE'S PREMISE IS FALSIFIED IN CODE, AND OBSERVED ON THE OWNED RUNTIME
>
> The brief says: *"There is no proven path that takes such a lease and makes
> that position's rent trusted. Until there is, an onboarded building stays
> 'claimed' forever."*
>
> **That is not what the code does.** `contributesTrustedRent` never consults
> proof. It asks two things: is there a spanning lease whose `lease_status` is
> `active` (or `commercial`), and is its rent a finite positive number. Deal
> Setup writes `lease_status = 'active'` with the uploaded rent. So **a
> rent-roll import produces trusted rent by itself, at confirm time, with
> `proof_basis: "unproven"`.**
>
> Building the Part 3 attach door would send an operator on a manual march
> through positions that already count — and would not touch whatever is
> actually holding Skyline at 4.
>
> **The defect is the inverse of the one the lane assumed, and Part 1 Q2 told
> me to report it and not fix it: a claim already became truth.**

---

## The measurement, first

Owned proof database, PostgreSQL 16, schema replayed from this branch's
migrations. The positions below were built by the **real** Deal Setup path
(`activation_service.confirmProposal`) in earlier proof runs — nothing here
was hand-inserted to make the point.

```console
$ psql "$E2E_DATABASE_URL" -c "select lease_status, source_type, confidence, rent … from leases …"
 lease_status |   source_type    | confidence |  rent
--------------+------------------+------------+--------
 active       | rent_roll_ledger | extracted  | 850.00
 active       | rent_roll_ledger | extracted  | 875.00
 active       | rent_roll_ledger | extracted  | 900.00
```

```console
$ node -e "currentRentRoll(pool, { property_id })"    # the canonical read
{"unit":"101","tenancy":"contractually_occupied","economics":"available","trusted":true,
 "current_rent":850,"resident":"Jordan Vale","claimed_rent":null}
{"unit":"103","tenancy":"contractually_occupied","economics":"available","trusted":true,
 "current_rent":900,"resident":null,"resident_claim":"Avery Doss","claimed_rent":null}

economics_summary: {"available":5,"unavailable":0,"not_applicable":2,"total":7}
proof_summary:     {"native_verified":0,"confirmed_opening_import":0,"unproven":5,"no_lease":2}
```

**Five positions contribute trusted rent. All five carry `proof_basis:
"unproven"`.** The read already publishes both numbers side by side; nothing
downstream reconciles them.

Note the third row: **`trusted: true` while `resident` is null and the
resident is still an unlinked claim.** Trusted rent does not require a linked
person today.

---

## Part 1 — The map

### Q1 · What makes a lease "spanning", and what sets `contractually_occupied`

```js
// src/tenancy/position_classifier.js:40
const CURRENT_ECONOMIC_STATUSES = new Set(["active", "commercial"]);

// src/tenancy/position_classifier.js:167  — THE spanning lease
const current = leases.find((lease) =>
  CURRENT_ECONOMIC_STATUSES.has(normalizedStatus(lease)) && datesSpan(lease, asOf)) || null;

// src/tenancy/dated_positions.js:285
if (p.current_lease_position) return "contractually_occupied";

// src/tenancy/dated_positions.js:787-792
function economicsState(p) {
  const lease = p.current_lease_position;
  if (!lease) return "not_applicable";
  const rent = Number(lease.rent);
  return Number.isFinite(rent) && rent > 0 ? "available" : "unavailable";
}

// src/tenancy/dated_positions.js:801
function contributesTrustedRent(p) {
  return tenancyState(p) === "contractually_occupied" && economicsState(p) === "available";
}
```

**`proof_basis` is computed and carried but is not an input to any of it**
(`dated_positions.js:794` says so in as many words: *"AXIS 4 — proof_basis,
already decided by the classifier"*).

The three `proof_basis` values (`position_classifier.js:94-103`):

| value | condition | treated as contractual? |
|---|---|---|
| `native_verified` | `executed_verified && move_in_funds_cleared` | **yes — but so are the other two** |
| `confirmed_opening_import` | `source_type='historical_snapshot'` **and** `confidence='confirmed'` | yes |
| `unproven` | everything else | **yes** |

**The classifier treats all three identically for tenancy and economics.** The
word "trusted" in `contributesTrustedRent` means *uncontested and populated*,
not *proven* — the comment at `dated_positions.js:796-800` says exactly that.
The lane's brief reads it in the stricter sense. That gap in reading is the
whole lane.

`native_verified` is reachable only via `executed_lease_records` joined to the
lease (`space_position.js:237, 251`), and `move_in_funds_cleared` requires a
move-in charge set that exists and is fully paid (`space_position.js:241-247`)
— **absence of a charge set is not funded.**

### Q2 · What Deal Setup writes — ⛔ the defect, reported not fixed

```sql
-- src/onboarding/activation_service.js:1105-1109
insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date,
                    balance, lease_status,
                    import_batch_id, source_type, source_as_of_date, confidence)
values ($1,$2,$3,$4,$5,$6,$7,'active',$8,'rent_roll_ledger',$9,'extracted')
```

`lease_status` is the literal `'active'`. That is in `CURRENT_ECONOMIC_STATUSES`,
so the confirm produces `contractually_occupied`; the uploaded amount becomes
the lease rent, so `economics_state = available`.

**Yes — an imported claim produces `contractually_occupied` + `economics_state
available` on its own, and contributes trusted rent.** Its own `proof_basis` is
`unproven`, because `rent_roll_ledger`/`extracted` matches neither branch of
`proofBasis`. Observed above, not inferred.

Every other current-tenancy writer does the same:

| writer | `lease_status` | `proof_basis` it yields |
|---|---|---|
| `activation_service.js:1109` (Deal Setup) | `'active'` | `unproven` |
| `snapshot_loader.js:699` (current section) | `'active'` | `confirmed_opening_import` when `meta.confidence='confirmed'` (`:526`), else `unproven` |
| `identity/activation.js:434` | `'active'`, no source stamp at all | `unproven` |
| `tenancy_anchor_service.js:284` (executed-lease) | `'pending'` | not current until admitted |

**The one writer that carries real proof is the only one that does not produce
a current lease on insert.** That inversion is the finding under the finding.

### Q3 · The doors that could attach a signed lease

| door | input required | works for a non-Spine lease? | writes | gap |
|---|---|---|---|---|
| **Executed lease intake** — `executed_lease_service.js:52`, `EXECUTED_LEASE_INTAKE_ENABLED === "true"` + property allowlist | a `lease_applications` row | **No** | `executed_lease_records`, then a `'pending'` lease | env-gated *and* application-anchored; a rent-roll resident has no application |
| **`POST /operator/leasing/applications/:id/executed-lease/verify`** — `operator.js:5244`, `requireOperator` + `requireLeasingModuleAccess` | `:id` is an application id; property wall from the session | **No** | evidence record + admission attempt | same — the route is keyed on an application |
| **`tenancy_anchor_service.confirmTermService`** — `:178`, `:284` | `applicationId` | **No** | `'pending'` lease, then `executed_lease_records.lease_id` | the only path to `native_verified`, and it starts at an application |
| **`link_resident.js`** — `POST /operator/leases/:leaseId/link-resident`, `requireOperator` + management | an existing lease + a continuity handle | n/a — it links a **person**, not a lease | `leases.tenant_ids` only (`:216`) | touches no term, rent, status or proof; by design |
| **Deal Setup confirm** — `activation_service.js:1105` | a confirmed rent-roll proposal | **it IS the non-Spine path** | `'active'` lease with the uploaded rent | **no proof step at all** |

**There is no door that attaches an outside signed lease to an existing
position for a resident who never had an application.** That is true — but it
is a gap in *proof*, not in trusted rent. Those positions already count.

### Q4 · Claimed rent on the canonical read — row 80 (2) is partly fixed

The row carries **both** `current_rent` and `claimed_rent`, and the read
carries `claimed_rent_unverified` + `positions_with_claimed_rent_unverified`
(`rent_roll_canonical.js:164-168, 281-282`). So the magnitude is no longer
count-only.

**But it is scoped to one tenancy state:**

```js
// src/surfaces/rent_roll_canonical.js:158
if (r.tenancy_state !== "occupied_terms_not_established") return null;
```

So a Deal-Setup position reads `claimed_rent: null` — **not because the claim
is missing, but because the claim was promoted into `current_rent`.** Claimed
and trusted never appear side by side for an imported position, because they
are the same number wearing the trusted label.

`imported_claim` does not exist as a row key. The row key list is
`… lease, resident, resident_claim, current_rent, proof_basis, … claimed_rent`.

### Q5 · Where Ask Spine reads rent

`tenancy_position_read.js` counts `rentUnknown` (`:225`), `unavailableContractEconomics`
(`:228`), and:

```js
// src/tenancy/tenancy_position_read.js:231
const importedOnly = occupied.filter((p) => p.proof_basis === "confirmed_opening_import");
```

**It distinguishes imported from proven — and it misses the Deal Setup
positions**, which are `unproven`, not `confirmed_opening_import`. So the one
place that asks "is this only an import?" does not see the import path that
production actually runs. It carries the truth wall *"occupied ≠ paying"*
(`:71`) but has no wall for *claimed rent ≠ trusted rent*.

---

## Part 2 — Rulings for Kameron (not decided here)

**1 · What evidence is enough to call an outside lease trusted?**
This is now a harder question than the brief assumed, because *today the answer
is "none — the spreadsheet is enough."* The real ruling is whether
`contributesTrustedRent` should keep meaning **uncontested and populated** or
start meaning **proven**. Changing it re-prices every onboarded building at
once and is explicitly out of this lane's limits, so it is yours. If it does
become proof-bearing, the sub-ruling is whether a signed PDF on file is
sufficient, or whether term + rent + names confirmed by an operator with
property authority is required, or both.

**2 · Who may attach?**
Every executed-lease door today is `requireLeasingModuleAccess`
(`operator.js:5244`). `link-resident` is **management** (row 159: *"linking a
resident resolves who is in a home"*). An attach door decides the rent a lender
sees, which reads as management to me — but that splits the executed-lease
family across two modules. Worth deciding once for both.

**3 · Can a lease attach to a position whose resident is not linked?**
The brief guesses no. **From the code, the answer today is yes, and it already
happens** — unit 103 above is `trusted: true` with `resident: null` and an
unlinked claim. Nothing in `contributesTrustedRent`, `tenancyState` or
`economicsState` consults `tenant_ids`. So this is not a new ruling to make; it
is an existing behaviour to ratify or change. My read: rent and identity are
genuinely independent axes (§42 — *a position carries independent axes*), and
coupling them would make an unlinked resident silently erase a real rent, which
is the §5 failure in the expensive direction. But it should be said out loud
rather than left as an accident.

---

## What I would do instead of Part 3

1. **Rule on question 1 first.** Everything else is downstream of what
   "trusted" is allowed to mean.
2. **Find out why Skyline is 4 of 160 before building anything.** It cannot be
   "no attach door", because the import already trusts. From the code the
   candidates are: positions with no rent on the source row
   (`economics_state: unavailable`), positions whose import produced no
   spanning lease at all (`not_applicable` — note the runtime above produced
   **two** rows for units 197/198, one `unresolved` and one occupied), bed-grain
   positions the ledger never reached, and contested claims. **That is a
   coverage question about what the import produced, and one read of the
   production rent roll answers it.** I could not run it — no production
   credential in this session, and §46 forbids setting one up.
3. **Then**, if proof is wanted, the smallest honest slice is not an attach
   door — it is making `proof_basis` count for something a reader can see, and
   giving `tenancy_position_read.js:231` a bucket for `unproven` so Ask Spine
   stops reporting imported rent as though it were established.

---

## Hard limits honoured

No production read or write (§46) — every figure above is from an owned
disposable database. No source file was changed: this lane returns a map and a
stop, as the brief allows. `person_ingress` staging, `contributesTrustedRent`'s
meaning and `standing.truth_state` are untouched. Gates run on the unchanged
branch: `gate_current_state` 8/8, `gate_ask_spine_readers` 162/162,
`gate_person_ingress` 10/10.
