# Future Rent Roll — system architecture

**2026-07-27.** Grounded against live source and live Neon. Written after R1 shipped, to
check that the next pieces accrete into the core product instead of becoming another
disconnected feature.

The system this belongs to:

```
Current Rent Roll → upcoming lease decisions → pricing and concessions
   → Future Rent Roll → revenue and NOI consequence
```

Renewals is one operating surface inside it. Pricing & Concessions is the governed economic
input. Future Rent Roll is the forward property-level read. Executed leases replace
projections as facts arrive.

---

## The finding that prompted the correction

**R1 shipped without successor awareness.** Its cohort was "any lease expiring in 90 days",
so **49 of 92 positions that already had a next lease were shown as open renewal
decisions**. The calculation contract had specified *"no successor lease on the same
position"*; the implementation omitted it.

That is the replacement rule failing at its first opportunity. It read as harmless only
because no successor was yet executed **and** funded, so nothing had been double-counted
into money. **Corrected in rev 2** — see the end of this document.

---

## 1. One underlying lease truth

**The spine already existed and nothing read it.** `src/tenancy/space_position.js` is dated,
per-space, derives from `leases / spaces / units / unit_events / turnovers`, writes nothing,
and its own header states the intent: *"One shared truth for current rent roll / forward rent
roll / availability — distinct fields, never one status."*

**What had gone wrong:** `notice_given` was independently re-derived in **three** places —
`availability.js:165`, `space_position.js:171`, and (as of R1) `renewals_read.js`. Same fact,
three SQL fragments, three vocabularies.

**The rule, now enforced:** *shared facts are derived once; each surface adds context, not a
new meaning.* `space_position` owns lease-spanning, successor state, notice, conflict,
availability and proof basis. Renewals adds urgency banding, days remaining, ordering and
conversation context — nothing positional.

**Still outstanding:** `/operator/rent-roll` reads `readLatestSnapshot()` — the imported
spreadsheet — while `space_position` is the canonical dated read. **Two rent-roll models.**
This is now the largest remaining violation of one lease truth, and is the subject of the
next convergence contract.

## 2. The permanent lifecycle

| Transition | Canonical event | State |
|---|---|---|
| current lease exists | `leases` row | ✅ 337/348 imported |
| approaching expiration | derived from `end_date` | ✅ correctly derived, not an event |
| notice given | `unit_events.notice_given` | ⚠️ exists, **0 rows ever** |
| **renewal decision** | — | ❌ **missing** |
| projected renewal / turnover | — | ❌ missing (assumption layer) |
| pricing applied | — | ❌ missing (no version→position link) |
| offer | `lease_offers` | ⚠️ exists, 0 rows, service orphaned |
| application | `lease_applications` + `application_submitted/approved` | ✅ working |
| executed | `executed_lease_records` + `executed_lease_verified` | ✅ working (2) |
| deposit paid | `scheduled_charges` + `lease_move_in_charge_sets` | ✅ working (2) |
| locked future position | executed **and** funded | ✅ rule implemented |
| becomes current | derived by date | ✅ correctly derived |
| **lease origin** (new/renewal/transfer) | — | ❌ **the keystone gap** |

The back half (application → executed → funded) is real and proven. The front half
(expiration → decision → projection → pricing) has **no events at all**. R1 sits exactly on
that seam and correctly records nothing.

## 3. Economic truth — one owner per class

| Economic fact | Long-term owner | Today |
|---|---|---|
| Current contractual rent | `leases.rent` | ✅ 231/234 |
| Renewal pricing | `pricing_terms` (renewal segment) | ❌ 0 rows |
| New-lease pricing | `pricing_terms.base_rent` | ❌ 0 rows |
| Concessions | `concession_policies` → `lease_economic_lines` | ❌ 0 rows |
| Fees | `pricing_terms.fee_terms` → `scheduled_charges` | ⚠️ 2 rows; still prose in `agent_facts` |
| Effective dates | `property_pricing_versions.effective_from/until` | ❌ 0 rows |
| Executed future economics | `lease_economic_lines` | ❌ 0 rows, lock orphaned |

**Pricing sheet governs uncommitted economics. Executed lease economics govern locked
positions.** R1 respects this: it reads `leases.rent` only — proven against a lease where
`rent` = $1,395 and `market_rent` = $1,505. **No screen-specific price calculation exists.**

## 4. Fact versus assumption — the permanent five

| Class | Owner | Immutable history | Exists |
|---|---|---|---|
| Contracted fact | `leases` + `executed_lease_records` | `events: executed_lease_verified` | ✅ |
| Confirmed opening truth | `leases.source_type` / `confidence` | `import_batch_id` | ✅ |
| Management goal | versioned assumption set | supersession chain | ❌ |
| Projection | computed, **never stored** in V1 | none by design | ❌ |
| Actual result | `economic_tenancy_activated_at`, `scheduled_charges` | `events` + money events | ✅ |

`proof_basis` — now derived once in `space_position` — is the seed of this separation, and
travels on every position and every renewal row.

## 5. Replacement behaviour

**Rule:** when a lease becomes executed **and** funded, it replaces the projected position
one-for-one. It never adds on top, never leaves a stale assumption, and never asks the
operator to reconcile two surfaces.

**Why it is expressible:** projections are derived, not stored. A locked lease changes the
input; the projection recomputes; the assumption disappears with no cleanup step.

**The three permanent outcomes for an expiring position:**

```
no successor                      → OPEN RENEWAL DECISION
successor, not executed+funded    → SUCCESSOR PENDING, NOT LOCKED
successor, executed and funded    → LOCKED FUTURE POSITION
```

A `SUCCESSOR PENDING` position contributes **zero locked rent and zero projected rent**. It
stays outside the projection until it becomes locked or disappears, and it remains visible as
unresolved exposure — never silently removed, never counted as open work.

A date-conflicted lease is **not** a successor. It is a contested position, excluded from
both sets with an explicit conflict reason, because which lease governs is unknown.

**`locked` uses the same governed rule everywhere:** executed **and** funded. A `pending`
lease_status alone never closes the economic position.

## 6. Product navigation

Renewals — where the operator handles upcoming resident decisions.
Pricing & Concessions — the governed truth sheet.
Future Rent Roll — where ownership sees the building-level outcome.

What makes these one continuous flow rather than three linked modules is **shared
derivation**, not shared links. That is why the three notice derivations mattered.

## 7. Reporting consequence

| Output | Needs | Blocked on |
|---|---|---|
| Projected rental revenue | locked + projected economics | pricing version, assumption set |
| Revenue gap vs plan | goal in assumption set | assumption set |
| Concession exposure | `lease_economic_lines` | calendar contract, lock rewiring |
| Future occupancy | `space_position` at date | **nothing — available now** |
| NOI outlook | above + expenses | out of scope |
| Sign-off & reporting | GENERATE gate | existing rung |

Nothing above requires replacing a primitive built today.

---

## Permanent objects and services

| Object / service | Real-world fact it owns | Who writes | Immutable history | Read by | Exists | R1 |
|---|---|---|---|---|---|---|
| `leases` | the contract on a position | import + executed-lease path | `events`, `import_batch_id` | all four surfaces | ✅ | reads it |
| `spaces` / `units` | the rentable position | property config | — | all | ✅ | reads it |
| `unit_events` | dated physical/contractual events (notice, move-in/out) | `notice.js`, possession writer | append-only | position read | ✅ (0 notices) | reads via spine |
| **`space_position`** (service) | **the dated position: spanning lease, successor, notice, conflict, availability, proof basis** | nobody — derives | none by design | Current RR, Renewals, Availability, Future RR | ✅ **now shared** | **consumes it** |
| `executed_lease_records` | this exact document was verified | verify-executed path | supersession lineage | position read, ledger | ✅ (2) | proof basis |
| `scheduled_charges` / `lease_move_in_charge_sets` | required move-in money and whether it cleared | charge + payment paths | append-only | locked rule | ✅ (2) | locked rule |
| `property_pricing_versions` + `pricing_terms` + `concession_policies` | approved asking economics | publish path | version supersession | Future RR, offers, Renewals (R2+) | ⚠️ 0 rows | not read (correct) |
| `lease_economic_lines` | executed dated economics | `lockLeaseEconomics` | append-only | Future RR, reporting | ⚠️ 0 rows, orphaned | not read (correct) |
| assumption set | management goal for a horizon | approval path | supersession | Future RR | ❌ | not read (correct) |
| lease origin | new / renewal / transfer + prior lease | lease creation | immutable at creation | Renewals, Future RR, reporting | ❌ | **absent — R1 correctly shows no `renewed`** |
| `renewals_read` (service) | the renewal WORK view | nobody — derives | none | Renewals door | ✅ | this slice |

---

## R1 after correction

| Aspect | Verdict |
|---|---|
| Derives from canonical leases and positions | ✅ aligned |
| Reads shared derivation, no duplicate notice query | ✅ **corrected in rev 2** |
| Successor awareness / replacement rule | ✅ **corrected in rev 2** |
| Conflict excluded with explicit reason | ✅ **added in rev 2** |
| `proof_basis` carried per row | ✅ aligned |
| `leases.rent` only, no `market_rent` | ✅ aligned |
| No stored position table | ✅ aligned |
| No `renewed` bucket | ✅ aligned (honest — origin does not exist) |
| Ownership declared, not inferred | ✅ aligned |
| Session-scoped, property server-derived | ✅ aligned |

**Measured after correction, Demo Building, 90-day horizon:**

```
92 positions expiring
   37  OPEN RENEWAL DECISION
   49  SUCCESSOR PENDING — NOT LOCKED
    0  LOCKED FUTURE POSITION
    6  CONTESTED (overlapping leases, excluded)
```

Buckets account for every expiring position exactly once, proven by assertion.

**No remaining R1 rework identified.**

## Next: the convergence contract

`/operator/rent-roll` still serves the imported snapshot as Current Rent Roll while Renewals
now reads canonical positions. That split is the largest remaining violation of one lease
truth, and the next read-only deliverable is a contract for moving Current Rent Roll onto the
same canonical position and economics derivation **without losing confirmed opening truth,
attribution, or honest disagreement states.**
