# Rent Roll × Person Spine — convergence build

2026-09-18 · owned disposable PostgreSQL 16 · real HTTP · real OTP staff
session · real Chromium. **No production data was mutated (§46).**

**Proven on** — the trees the runtime, HTTP and Chromium proofs actually ran
against:

```
API   5a588d8c6b7c3f3bdd07c32cf6370b9ee8cc7a9f   claude/rentroll-grain-refusal-20260918
app   767fde296957f57ba7c1a1885bbd131697585d51   claude/leasing-basis-asked-not-assumed-20260918
DB    spine_proof_e54051f7b4a1e6720322e249 · ledger 200
read  as_of 2026-09-18 · property tz America/New_York
```

**Candidate pair** — what to review and what CI runs. The app moved one
commit past the proven tree to *register* the §34–§36 hostile matrix that
the runtime had exercised but no harness asserted; no product source
changed between the two.

```
app   2bbdb63963b792770489c1afe6e918f33e948fb2   claude/leasing-basis-asked-not-assumed-20260918
API   the commit carrying this file on claude/rentroll-grain-refusal-20260918
      (docs + CURRENT_STATE 135–138 over 5a588d8c; no src change)
```

## §53 · THE FOUR VERDICTS

| | |
|---|---|
| **RENT ROLL TRUTH** | **ONE MODEL** |
| **PERSON IDENTITY** | **ONE DURABLE PERSON PATH** |
| **FUTURE RENT ROLL** | **SERVER-CANONICAL** |
| **PERSON CARD FROM RENT ROLL** | **SAFE** |

Each is explained below with the seam that carries it. Where something is
still owed it is named as owed, not folded into the verdict.

---

## §21–22 · Greenery canonical structure — read, not forced

```
property_id                  22222222-2222-4222-8222-222222222222
address                      1325 N 15th St, Philadelphia PA 19121
leasing_basis                bed
units                        64
canonical_rentable_positions 105
occupancy_denominator        105   (the server's own population)
positions_contributing_rent  87
down / non-revenue / retired 0 / 0 / 0
```

64 units and 105 beds, matching the business reference exactly. These are
not all "beds": the denominator is the server's, and rent-contributing
positions are 87 because seven occupied beds carry no rent in the source.

## §43 · Rent Roll states

| state | count |
|---|---|
| Occupied (contractually) | **94** |
| Occupied, terms not established | **1** |
| Open | **10** |
| Pending activation | 0 |
| Needs review | 0 |
| Not established | 0 |
| Contested / unclassified | 0 |
| **total** | **105** |

`/units` reports `occupied 95` because it folds the terms-not-established
position in; `/canonical` separates them. **The desk now shows 94 and names
the 1** — it previously showed 95 derived as `total − vacant`.

## §23 · Identity coverage — THE MOST IMPORTANT LINE IN THIS RECEIPT

The spec anticipated 95 unlinked residents. The truth is the inverse, and it
is worse in a quieter way.

| Identity state | Count |
|---|---|
| Current lease + linked durable Person | **95** |
| Current lease + no linked Person | **0** |
| Accepted occupied claim, no lease | 0 |
| No authoritative occupant evidence (Open) | 10 |
| Contested | 0 |

**`resident_not_linked = 0`. And every one of those 95 Persons has no
continuity handle whatsoever:**

```
with phone          0 / 95
with email          0 / 95
with primary_e164   0 / 95
phone_verified      0 / 95
confidence          'extracted'  (95/95)
import_batch_id     one batch    (95/95)
resolution_kind     'created'    (95/95, confirmed_by set)
authority           "operator confirmation of an activation row"
```

**This is governed, not a name match.** `ingestPerson` reaches
`createPerson` only when nothing conflicts AND no candidate exists, under a
named authority, and §9 lists operator-confirmed proposals as a legitimate
mechanism. The inversion worth naming is the routing:

> **no candidate → no review → create.** The path with the *least* evidence
> is the one that mints a durable human.

The operator confirmed a **tenancy row**; the same click carried the
authority to establish a **person**. Greenery's Person Spine exists on paper
and cannot recognise a single resident who texts next year — §0 calls phone
the continuity handle, and there are none.

**Nothing was created or repaired to improve this (§24/§40).** This is the
ingest's behaviour on the real August rent roll, and it is the most valuable
line here: the next operational project is resident identity establishment.

## §2–§12 · Person identity ingress — the negative case, closed first

Four defects, all confirmed by execution signed-in before any fix:

- `psRrRow()` returned `<button onclick='openPersonCard({person_id:"", …})'>`
  for **every** position, including the 11 the canonical read returns with
  `resident: null`, one of which renders "Resident not linked".
- `pcOpenLiveRail()` read `opts.person_id || null`, so the empty string
  became null and the rail opened. Chromium: `__pcLiveIds = {p:null,l:null}`,
  nothing thrown.
- the same click carried `unit_id` and `lease_id` — §4's forbidden
  substitution.
- `rrPersonArg()` probed three field names and used a **UUID-shape regex** as
  identity authority.

Now: a row is a Person Card target only when `resident.person_id` exists;
the rail refuses at the boundary with the *specific* reason first
(`relationship_id_is_not_identity` before `person_identity_not_established`);
`lead_id` survives as §5's one governed exception because the **server**
resolves it; one seam (`openCanonicalPersonFromRelationship`) with
`person_id` mandatory; and the authenticated argument shape is
`resident.person_id` **or nothing** — no aliases, no regex.

**§12 falsified in a live session:** all four preview seams
(`resolvePersonId`, `personSourceObject`, `pcResidentRecord`,
`pcRenderResidentCard`) wrapped in throwing stubs, Person Card driven,
**zero hits**.

**§31 needed no schema change** — inspected first, as instructed. The
canonical row already carries `resident: {person_id,name}` or `null`.

**§11/§30** — "Phone (verified login identity)" is gone. "Verified phone" is
said only when `phone_verified_at` is a recorded fact.

## §13–§19 · Forward and current convergence

**Agreement is not convergence.** The browser's forward classifier agreed
with the canonical server at every date tested:

| as_of | browser | server |
|---|---|---|
| 2026-12-01 | 94 / 11 / 1 | 94 / 11 / 1 |
| 2027-02-01 | 85 / 20 / 10 | 85 / 20 / 10 |
| 2027-08-01 | 0 / 105 / 95 | 0 / 105 / 95 |

It was faithful and it was still a second implementation. Signed in, both
Current and Forward now come from `psCanonicalForward()` →
`/operator/rent-roll/canonical?as_of=` + `/future-facts`, **proven by
network log, not by the numbers agreeing**. `null` means unavailable and
never falls back to the browser model.

### A real bug this build's own discipline caught

§42 asks for the effective `as_of` to be *recorded*. Recording it showed the
desk reading a horizon labelled "September 1" at **2026-09-01 — seventeen
days in the past** — because `_rrPlanningTargets` anchored every horizon to
the **source document's** as-of (2026-08-31). It also drifted: before the
rent roll loaded there was no meta and the base was today, so one session
produced both 2027-09-01 and 2026-09-01. A forward horizon is measured from
now; an import's as-of is provenance. Fixed.

### §18 · the permanent display ruling

```
every position unresolved      → Not projectable
zero committed + any unresolved → Not projectable   ("a floor of zero is not a floor")
some unresolved                 → ≥X% · N of D unresolved
none unresolved                 → X%
```

Live, at Greenery's configured September 1 2027 horizon, the desk now reads:

> **Not projectable** — *95 of 105 positions lack sufficient dated terms as of
> September 1 · nothing contracted at that date*

That is the true forward picture of a student building whose leases all
expire in July: not "0%", not "≥0.0%", but *we cannot project this yet*.

### §14b · the property-name regex

`_rrIsSoloContext` decided student-cycle membership with
`/solo|4233\s+chestnut/i` over the property **name** — `if (property ===
"Solo")` in disguise, and wrong on the facts: Greenery and Skyline are
student housing, do not match, and were denied their September date.
Measured before the fix: targets `30 · 60 · 90 · 120`, no September.

The cycle is now configuration (`properties.lease_config` →
`/operator/me.leasing_cycle`, validated into `{kind, anchor_month,
anchor_day, label}`). **null means NOT CONFIGURED** and renders rolling
horizons — never an inferred cycle. Greenery, configured, now gets
September 1 2027. The identity route `/auth/sms/verify` deliberately does
**not** also publish configuration: one source.

## §34–§36 · The hostile matrix

Built in the owned runtime: **one bed, two different durable Persons who
share the name "John Smith" exactly, on sequential leases.**

The server keeps them apart:

```
as_of 2026-10-01  current   person …441 "John Smith"
                  successor person …442 "John Smith"   conflict_state: clear
as_of 2027-03-01  activation_pending — a pending lease is NOT promoted to current
```

And the browser reproduces it instead of inferring:

| case | result |
|---|---|
| same name, different Persons | **future_leased**, never renewed |
| same durable Person | renewed |
| unknown identity both sides | **successor_identity_unresolved** (the third answer) |
| current lease with no end date | **unresolved_exposed**, not vacant, not occupied-forever |
| two overlapping future rights | **conflict** raised, not first-wins |

`_rrSameResident` signed-in answers from durable identity or returns
**null** — "Spine does not know", which is not "somebody else" — and
`_rrForwardPosition` gained the third branch that null requires.

## §44 · Code convergence receipt

| implementation | status |
|---|---|
| `openPersonCard` | **KEPT — CANONICAL** entry; live branch returns immediately |
| `pcOpenLiveRail` | **KEPT — CANONICAL**, now with the §4 refusal boundary |
| `openCanonicalPersonFromRelationship` | **NEW — CANONICAL** signed-in seam (§7) |
| canonical Rent Roll row person link (`psRrRow`) | **KEPT — CANONICAL**, gated on `resident.person_id` |
| `rrPersonArg` | **PREVIEW ONLY** — authenticated branch uses the canonical field; legacy probing walled behind `_rrSignedIn()` |
| `rrNameLink` | **NEW — CANONICAL** shared nav helper for both rent-roll surfaces |
| `resolvePersonId` / `personSourceObject` / `pcResidentRecord` / `pcRenderResidentCard` | **PREVIEW ONLY** — proven unreachable signed-in by throwing stubs |
| `_rrSameResident` | **PREVIEW ONLY** for its name predicate; identity-only when signed in |
| `_rrForwardPosition` / `_rrForwardSnapshotAt` / `rentRollForwardStats` | **PREVIEW ONLY** — authenticated Management no longer consumes them |
| `psCanonicalForward` | **NEW — CANONICAL** forward/current reader |
| `_rrIsSoloContext` | **PREVIEW ONLY** — id match only; the name regex is gone |
| `datedPropertyPositions` | **KEPT — CANONICAL** (server) |
| `/operator/rent-roll/canonical`, `/future-facts` | **KEPT — CANONICAL** (server) |
| `/operator/rent-roll` (legacy) | **LEGACY BUT STILL REACHABLE — FOLLOW-UP REQUIRED** — the app still loads it for row detail, and its `row.status` carries the **resident id**, which is what made `total − vacant` look right |
| `/operator/rent-roll/units` | **LEGACY BUT STILL REACHABLE — FOLLOW-UP REQUIRED** — **not a dated read**: echoes `as_of` and returns 95/10 at every date |
| `unitRentRoll` | KEPT (server) — feeds `/units` |
| `management_read.js` | **LEGACY BUT STILL REACHABLE — FOLLOW-UP REQUIRED** — consumed only by the app's profitability panel; its occupancy is a second definition. Its grain inference was corrected earlier today (CURRENT_STATE 131); its occupancy is not yet converged |

## §50 · Proofs — and where they are, and are not, registered

```
person_identity_ingress.test.js              40/40
forward_semantics_are_the_servers.test.js    34/34
forward_occupancy_unresolved.test.js         24/24
person_identity_signed_in.browser.js         14/14   coupled to an owned runtime
forward_convergence_signed_in.browser.js     14/14   coupled to an owned runtime
full app suite                               39 harnesses · 1607 passed · 0 failed
```

All green — in the **app repo's** own suite (`run_harnesses.sh`). **They are
NOT registered in the API's `verify_all.sh`, and that is a blocker, not an
omission.** I registered them; CI went red twice (runs 693 and 694,
`MODULE_NOT_FOUND`). A rung the API registers must exist at the app version
`tests/e2e/app_pin.txt` declares, and it does not.

With the app history fully fetched — a shallow clone makes `merge-base`
return nothing and invites a far worse conclusion — both app branches fork
from app main `c6769ba`. The declared pin `2e8199a` is **116 commits** past
main; this build's app `2bbdb63` is **10 commits** past main; neither
contains the other. The pinned `index.html` contains none of
`psCanonicalForward`, `pcPersonRefusal`,
`openCanonicalPersonFromRelationship`, `_rrLeasingCycle` or `Not
projectable`, so these rungs cannot pass at the pin by construction.

Moving the pin was tried and rejected with the measurement: the pin's
lineage carries ~45 proof files this one does not, starting with the
registered `retained_inquiry_dom` rung — that trade is 45 rungs for 3. The
pin is restored, the three registrations are commented out in place with the
reason and the re-registration condition beside them, and CI is back to the
green it had at run 692.

A trial merge conflicts in **6 hunks of `index.html` and no other file**, so
convergence is tractable — but it needs its own browser re-proof, because
the evidence above was gathered pre-merge and a clean merge is not proof the
merged app behaves the same. **The consequence to hold onto: this work is
proven, and CI does not yet defend it.** CURRENT_STATE row 139.

## §51 · Falsification — every guard, against a copied tree

| defect recreated | result |
|---|---|
| `person_id \|\| null` fall-through restored | "an empty person_id is REFUSED" red |
| row button re-enabled with no resident | 4 red |
| authenticated path probes the three legacy fields | 3 red |
| overclaiming phone label restored | 2 red |
| `_rrSameResident` falls through to name | 9 red, incl. *"same name are NOT a renewal (got renewed)"* |
| property-name regex restored | 3 red |
| planning base back to the import date | 3 red |
| ≥0.0% restored when nothing is contracted | 4 red |
| "Not projectable" removed | 5 red |

## What remains — named, not hidden

1. **Resident identity establishment is not an operator workflow (§41).** 95
   Persons exist with zero continuity handles. Establishing them is the next
   operational project; nothing here should be read as having solved it.
2. **`/operator/rent-roll/units` is not a dated read.** It accepts `as_of`
   and ignores it. Either honour it or stop accepting it.
3. **`/operator/rent-roll` ships the resident id in `row.status`.** The
   authenticated desk no longer depends on it, but any other consumer still
   inherits it.
4. **`management_read.js` occupancy remains a second definition**, reachable
   through the profitability panel.
5. **The ingest's identity routing** — no candidate → no review → create —
   deserves a deliberate ruling now that its effect is measured.
