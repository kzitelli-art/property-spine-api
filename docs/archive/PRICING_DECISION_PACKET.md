# Initial Pricing Decision Packet

**Property:** Demo Building · **As of:** 2026-07-27 · **Horizon:** 90 days (2026-10-25)
**Disposition:** read-only, preview-only. No pricing row was written. The AI's
live quoting behaviour is unchanged.

---

## 0. Correction applied

Commercial Space no longer reports as unpriced. It now reports
`not_applicable_to_residential_pricing`, owes no decision, and its legacy `$0`
is marked `legacy_evidence_only` and is not carried into the response as a
term. The AI adapter refuses it **by that name**, and — deliberately — it does
so *before* checking whether a version is published, because answering "no
version is published" would imply that publishing one would give it a price.

---

## 1. Economic-class contract

Seven classes, kept distinct because they differ in the questions they can be
asked, not in how they display. Each collapse produces a specific wrong number:

| Collapse | The number it produces |
|---|---|
| `base_rent` + `recurring_charge` | parking and pet rent enter the rent roll as contractual rent — **NOI overstates and the lender package is wrong** |
| `recurring_charge` + `one_time_fee` | a $300 one-time pet fee becomes $300/month |
| `deposit_required` + `deposit_held` | an underwriting requirement is booked as money we hold — **a fabricated liability** |
| `deposit_*` + `one_time_fee` | a refundable balance is recognised as income |
| `concession` + `credit` | either a promise with no posting, or a posting nobody authorised |

**The smallest permanent contract** — nine questions any money obligation must
answer: `economic_class`, `amount`, `cadence`, `applicability`, `required`,
`refundable`, `effective_from`, `authority`, `canonical_owner`.

**Can existing tables represent them honestly?**

| Class | Today | Owner |
|---|---|---|
| `base_rent` | **yes** — `pricing_terms.base_rent` keyed to a governed type | Pricing & Concessions |
| `one_time_fee` | **partially** — `fee_terms` is a blob with no cadence or applicability shape | Pricing & Concessions |
| `deposit_held` | **structurally** — `leases.security_deposit`, blank by honest absence | Money / ledger |
| `concession` | **structurally** — `concession_policies` exists, cannot be advertised | Pricing & Concessions |
| `recurring_charge` | **no** → `recurring_charge_model_not_built` | does not exist |
| `deposit_required` | **no** → `underwriting_requirement_not_modelled` | Risk / underwriting |
| `credit` | **no** → `schedule_line_engine_not_activated` | Money / ledger |

**No recurring-charge schema was created.** `fee_terms` has no cadence field,
so storing $30/month there would be indistinguishable from a $30 one-time fee.
Reporting it absent is more honest than representing it wrong.

---

## 2. Unit-type decision packet — inventory pacing first

| Type | Res. | Locked today | Locked @90d | Pending succ. | **Uncovered @90d** | Mktable now | In-place median (n) | Legacy range *(evidence only)* |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Studio | 108 | 89 | 51 | 23 | **57** | 0 | $1,395 (89) | $1,045–$1,687 |
| Furnished Studio | 28 | 20 | 11 | 5 | **17** | 0 | $1,400 (20) | $1,600 flat |
| 1 Bed | 102 | 79 | 48 | 18 | **54** | 0 | $1,700 (79) | $1,200–$2,200 |
| Furnished 1 Bed | 16 | 9 | 8 | 1 | **8** | 0 | $1,866 (9) | $1,800–$2,275 |
| 1 Bed + Den | 6 | 6 | 6 | 0 | **0** | 0 | $2,100 (6) | $2,150 flat |
| 2 Bed / 2 Bath | 14 | 7 | 3 | 2 | **11** | 2 | $2,800 (7) | $2,700–$2,900 |
| 3 Bed / 2 Bath | 6 | 5 | 2 | 0 | **4** | 0 | $3,300 (5) | $3,900 flat |
| 3 Bed / 3 Bath | 1 | 0 | 0 | 0 | **1** | 0 | — (0) | $3,990 |

**The pacing finding, which is larger than the pricing finding.**
**152 of 281 residential positions — 54% — carry no contractual cover at
2026-10-25.** Only **2** are marketable today, and **49** sit on pending
successors. This is not a rent table problem. Setting eight numbers without
looking at that column would price a building as though it were full.

Two rows deserve separate attention:
- **1 Bed + Den** is fully covered at the horizon (0 uncovered). Its price sets
  renewal posture, not absorption — a different decision from the same table.
- **3 Bed / 2 Bath** shows in-place $3,300 against a legacy $3,900. The largest
  gap in the building, on 6 positions, 4 of them uncovered at the horizon.

**Native executed evidence: zero, on every type.** Not one lease in the
building has been both executed *and* funded through the system. The strongest
evidence a pricing decision could rest on does not exist yet, so the first
version will necessarily be authored from judgment plus in-place rent.

**Client-store candidates: none.** `window.__pricingStore` is structurally
retired on signed-in surfaces and returns zero types. A value that only ever
existed in one operator's browser tab was never a candidate.

**The packet contains no `suggested_rent` field, by design.** A legacy range
and a browser object are not evidence for a price; presenting either as a
recommendation would launder an unauthored number into an authored one.

---

## 3. The Studio spread, explained

**The `$1,045–$1,687` framing overstates it.** The spread is not a tier
structure and not a continuum — it is **one dominant value with a thin tail**:

```
$1,045 ×1   $1,450 ×75   $1,475 ×9   $1,505 ×5   $1,555 ×5
$1,600 ×4   $1,605 ×5    $1,655 ×3   $1,687 ×1
```

**75 of 108 studios — 69% — carry exactly $1,450.** Both endpoints are
populations of one. `$1,687` is unit 530, already known. `$1,045` is a second
singleton nobody had identified.

Tested against every structural attribute that exists:

| Candidate explanation | Verdict |
|---|---|
| Furnished vs unfurnished | **Impossible** — already separate governed types |
| Square footage | **No** — 350 sf spans $1,045–$1,687, the entire range |
| Floor / view | **No** — every floor sits at $1,450–$1,6xx |
| Lease dates | **Correlated, not causal** (below) |
| Historical leases | Not applicable — `market_rent` is undated |
| Source error | **Likely for both singletons** |
| Concession embedded in rent | Cannot be tested — no concession record exists |
| Distinct cohorts | **No** — a cohort structure would be a few values with mass, not 1/75/9/5/5/4/5/3/1 |

**On lease dates.** Studios on 2026 leases show $1,045–$1,475; 2024–25 leases
show up to $1,655. That is a real correlation, and it is **not usable**:
`market_rent` carries no date, so this compares an undated column against lease
dates. It is equally consistent with drift, with re-import, or with error.
Correlation is reported; it is not converted into a rule.

**Same shape on 1 Bed:** 73 of 102 at exactly $1,800, with a single $1,200
outlier — and on Furnished 1 Bed, 10 of 16 at exactly $2,000.

**What this means for version one.** The building's legacy data is much closer
to a type-level asking rent than the min–max suggested. The honest statement is
not "Studios span $642" but: *"Studios are priced at $1,450, with eight
positions that disagree and nothing in the data explaining why."* The eight
outliers need a person to look at them, not a formula.

---

## 4. Fee and recurring-charge contradiction report

All 13 active money facts graded. **Review only — no governed copy created.**

| Fact | Class | Amount | Verdict |
|---|---|---|---|
| `pricing_application_fee` | one_time_fee | $50 | **consistent and governed** |
| `pricing_admin_fee` | one_time_fee | $99 | **consistent and governed** |
| `pricing_amenity_fee` | one_time_fee | $300 / $250 | conditional, condition missing |
| `pricing_telecom_fee` | one_time_fee | **unresolved** | conditional, condition missing |
| `pricing_security_deposit` | deposit_required | **unresolved** | not safe to quote |
| `parking_pricing` | recurring_charge | $300/mo | not safe to quote |
| `pet_policy` | recurring_charge + fee | $30/mo **+ $300** | **conflicting** |
| `utilities` | recurring_charge | $40/mo | not safe to quote |
| `renters_insurance` | recurring_charge | $15/mo | conditional, condition missing |
| `unit_transfers` | one_time_fee | **unresolved** | conditional, condition missing |
| `entry_access` | one_time_fee | $75/$25/$25 | legacy evidence |
| `move_in_requirements` | — | restates 4 facts | **prose duplication** |
| `move_in_credits` | concession | **unresolved** | not safe to quote |

**Only two of thirteen are cleanly governable today.**

- **Telecom $75–99:** the range has **no stated determinant**. Nothing in the
  fact, the schema or the unit record says what makes it $75 rather than $99.
  It resolves to *no amount* — never a guessed midpoint.
- **Amenity $300/$250:** not a conflict — two populations (new lease vs
  renewal) in one sentence. The condition is knowable but unstructured, so a
  consumer must parse prose to apply it.
- **Pet policy:** **one fact carrying two economic classes**, and it does not
  say per-pet or per-tenancy. A two-pet household has no determinable answer.
- **Parking $300:** the amount is unambiguous; the *availability* is not, and
  the fact says so. Quoting it implies a spot exists; no parking inventory
  model can check that.
- **Wifi $40:** precise, but the same sentence leaves electric and water
  usage-based with no amount. Quoting $40 alone understates the obligation.
- **Insurance $15:** insurance is required; the $15 is **not** — it applies
  only if the resident takes the building program. Quoting it states an
  optional price as mandatory.
- **`move_in_requirements`:** a second quotable copy of four values it does not
  own. If any of the four changes, this sentence silently disagrees.
- **`move_in_credits`:** a concession filed as trivia — unversioned, undated,
  authority-less. Calendar-dependent, so it **cannot be published** — and it is
  being quoted today anyway from prose. **The gap between what may be published
  and what is actually being said is the sharpest finding here.**

An ungraded money fact appearing tomorrow surfaces as `undeclared_money_fact`
rather than passing silently.

---

## 5. Fee waiver stays dark

The preview **refuses** a `fee_waiver` over any fee graded conflicting,
conditional-with-missing-condition, prose-duplicated or not-safe-to-quote —
proven against the telecom fee. A waiver's size *is* the fee's amount, so an
unresolved fee makes the discount unstatable. The permanent sequence holds:

```
governed fee → governed waiver authority → offer → dated economic consequence
```

---

## 6. Dry-run publication preview

`POST /operator/pricing/publication-preview` — a POST that **writes nothing**;
the body is a proposal, not a command, and the response says
`dry_run_no_write_performed`. There is no publish route to fall through to.

Returns completeness failures, missing types, missing rent decisions, invalid
terms, fee contradictions, unsupported concessions, date overlap, a
before/after receipt, publisher authority, what remains unavailable — and the
**exact AI quote preview per type, for both new-lease and renewal**.

That last item is the real deliverable: a pricing sheet is not a table, it is
what a prospect will be told. The preview runs the **same adapter function**
the live path would, via a `picture` seam, so there is one refusal path rather
than a copy of it. With a refused sheet, all 18 previews hand off and **no
dollar figure appears in any sentence**.

---

## 7. Publisher authority inventory

Read from an active `owner`/`asset_manager` assignment, or an explicit
`may_publish_public_offers` grant — **the same predicate the ledger's publish
path uses**, so the preview cannot pass where a real publish would refuse. It
is never taken from the request body.

Queried live:

- **Demo Building: exactly one publish-capable person — `Jordan Avery (demo)`,
  role `owner`** (`16b442ee…`).
- **Across all 28 properties there is exactly one publish-capable assignment —
  the same one.** Real Solo on Chestnut has none.
- `concession_authority_grants`: **0 rows**, so no grant-based authority exists
  anywhere.

So the portfolio's entire pricing-publication authority is a single
demo-named person. That is not a production publishing authority, and it means
**no real property could publish pricing today even if a sheet were ready.**
Naming a real publisher is decision #10 below.

---

## 8. Decisions needed to publish version one

1. **The eight Studio outliers** — and the single $1,045 in particular. Data
   error or real? The other 100 are $1,450 or within $200 of it.
2. **Same question for 1 Bed** ($1,200 singleton) and **Furnished 1 Bed**.
3. **New-lease rent per type** — eight numbers. In-place medians run $55–$600
   *below* legacy on every type; which is the starting point?
4. **Renewal rent per type** — explicit, or explicit `pricing_unavailable`.
   Silence is refused.
5. **Which lease terms** are published.
6. **3 Bed / 2 Bath**: in-place $3,300 vs legacy $3,900 — the largest gap.
7. **Telecom fee:** name the determinant, or resolve to one number, or mark it
   office-quoted.
8. **Pet policy:** split into fee + recurring, and state per-pet or per-tenancy.
9. **Approve rewriting `move_in_requirements`** to reference rather than
   restate.
10. **Name the publisher** with real authority on the property.

Deferred by ruling, not oversight: security deposit → underwriting; recurring
charges → their own build; move-in credits → blocked until the schedule engine
exists; market evidence → `governed_market_observations_not_built`.

---

## 9. Cutover plan — `agent_facts` → governed pricing

**Not executed. No step below has been taken.** `agent_facts` remains the live
source and the adapter remains dark.

1. **Publish version one** (rents only). Fees stay on `agent_facts`. Nothing
   about live quoting changes — the sheet exists but nothing reads it.
2. **Shadow the adapter.** Log what it *would* say beside what the live path
   *does* say, on real conversations, without sending. Any disagreement is a
   defect found before a prospect hears it. This is the step that would have
   caught unit 530's $237 gap.
3. **Cut rent quoting over** once shadow shows zero disagreement, behind its
   own reviewed receipt.
4. **Resolve the four blocked fees** (telecom determinant, amenity condition,
   pet split, insurance conditionality), then move fees into the governed sheet
   **one at a time** — retiring each `agent_facts` row in the same commit that
   adds its governed row, so two quotable copies never coexist.
5. **Delete `move_in_requirements`.** It owns nothing.
6. **Recurring charges** — separate build. Until it exists, parking, pet rent,
   wifi and insurance stay prose and are quoted with their conditions.
7. **Concessions last**, after the schedule engine, starting with the one
   calendar-free shape once its fee has a single governed owner and amount.

Each of steps 3–7 needs its own reviewed receipt. `agent_facts` is the live
source today, and a cutover that skips shadow-mode would be the same class of
mistake as the env-var change that did not restart the process.

---

## 10. Proof

- `tests/proofs/pricing_foundation_proof.js` — **53/53**
- `tests/proofs/pricing_decision_packet_proof.js` — **75/75**
- Adapter still dark: its only consumer repo-wide is the dry-run preview, and
  `src/agent/agent.js` does not reference it. **Live quoting is unchanged.**
