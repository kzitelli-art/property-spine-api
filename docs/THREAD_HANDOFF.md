# Property Spine — Thread Handoff

**Closing state: 2026-07-28** · api `0bbd179` · app `ae7abe3`
Start here. Nothing in this file requires reconstructing the prior conversation.

---

## What is LIVE

**One governed economic term.**

```
fee.application   $50   one-time · required · per applicant · NEW-LEASE APPLICATION ONLY
                        record_state=active  quote_state=live
                        renewal: false   transfer: false
Assistant says:   "The application fee is $50 — Per applicant on a new-lease application."
Source:           property_governed_charges   (NOT prose)
```

Everything else economic is **unpublished**: no pricing version, no recurring
charge, no deposit requirement, no active concession.

## What remains DRAFT

```
fee.administration  $99  record_state=draft  quote_state=inactive
                         BLOCKED on one ruling (below)
```

Its legacy fact `pricing_admin_fee` is **still the only live source**.

## Legacy source retired

`agent_facts.pricing_application_fee` → `status='retired'`, row retained and
historically visible. It is the **only** fact ever retired. 12 money-bearing
facts remain live.

## Exactly one live economic owner

```
governed_active 1 · legacy_active 0 · quotable_sources 1
verdict: one_canonical_truth
```

Enforced by `uq_gc_one_live_owner` (partial unique index) plus an
inside-transaction owner recount in `cutOver()` that refuses to commit on two
owners *or* zero.

## Demo authority

```
Kameron Zitelli — Staff  (person c1dedf39, login 78375274 kz8434@gmail.com)
asset_manager on Demo Building ONLY
may_prepare · may_review · may_publish · may_manage_concession_authority
```

**1 of 28 properties** has any pricing authority. The invalid `owner`
assignment on a demo-lead person is deactivated with its history intact.

---

## Browser-proofed UI states

| State | Proof |
|---|---|
| **live** ($50) | chip *"LIVE — ONE GOVERNED SOURCE"*, before/after reads *"said before / says now"*, legacy labelled retired, **0 buttons**, *"Changing it means superseding it with a new decision"* |
| **draft** ($99) | chip *"DRAFT — NOT IN USE"*, open question + 3 rulings, **0 buttons**, blocked on the ruling not on authority |
| **unauthorized** | 0 buttons, amount still visible, plain-English denial naming the *account-setup* step |
| **unavailable** | no amount shown; states a read failure is not the absence of a fee |
| audit disclosure | collapsed in every state; **no internal codes** in operator copy |
| approved / published-not-live / cutover-ready / rejected | **code-proven only** — cannot be produced without another publication |

## The reusable decision-card contract

`psEconomicDecisionCard(elId, resourceName)` renders any server read of this
shape. **Adding a governed term needs a server read, not new UI.**

```
truth        state chip · question · amount · 3 facts
decision     open_question { question, why_it_matters, rulings[], preselected: null }
consequence  today {label, source, the_ai_says} → after_cutover {label, source, the_ai_will_say}
next action  actions { may_approve/modify/reject, denied_reason, labels }
collapsed    audit { ids, digests, record_state, quote_state, provenance, authority }
```

Rules: the **server** decides state and labels; the browser renders. No
internal code appears in operator copy. `may_approve` is false when the
blocker is a *question*, not authority.

---

## The unresolved administration-fee ruling

> **Is the $99 administration fee charged only for a new lease, or again when
> an existing resident renews?**

| Ruling | Consequence |
|---|---|
| New lease only | Renewal quotes exclude it. |
| New lease **and** renewal | Renewal economics carry another one-time $99. |
| Conditional | The renewal condition must be governed before it can be quoted at all. |

### Evidence audit — reported, not weighed

**Supporting renewal (2 independently authored prose sources):**
- `agent_facts.pricing_admin_fee` *(active)*: "A $99 admin fee applies per
  unit, once at move-in and at renewal."
- `agent_facts.fee_policy` *(retired)*: "a $99 admin fee per unit (at move-in
  and renewal)" — written separately, same claim.

**Corroborating pattern (about a different fee):** `pricing_amenity_fee` —
"$300 ($250 upon renewal)". Shows the property charges *some* fees at renewal.
Says nothing about this one.

**Contradicting renewal:** none.

**Transactional evidence: NONE — and this is not evidence against.** Only 2
scheduled charges of *any* kind exist on the property, so nothing has been
posted for any fee. Zero ledger entries mention admin. No lease-document table
carries fee terms.

**Conclusion:** the prose is consistent but ambiguous — *"once at move-in and
at renewal"* reads either as one charge covering both events or one at each.
**This needs a human ruling, not a reading.**

---

## Remaining product primitives

| Primitive | State |
|---|---|
| Recurring-charge model | **not built** — blocks parking, pet rent, wifi, insurance |
| Approved projection assumptions | **not built** — blocks all Future Rent Roll revenue |
| Deposit-held ↔ deposit-required separation | contract only; underwriting owner unnamed |
| Market evidence / Rent Survey | interface contract only, no store |
| Six-section economic inventory surface | **not built** (decision cards deliberately prioritised) |
| Separate reviewer permission | not built — `asset_manager` approves *and* publishes |
| Concession activation UI | not built; compiler complete, nothing activated |
| Eight version-one rents | **undecided** — no pricing version can publish |
| 11 blocked money facts | each with a named missing determinant |

## Confirmed unchanged

No other economic value published or activated · no concession · no offer or
lease economic line · no projection · no other property received authority ·
no person merged or deleted · no `agent_facts` retired beyond the one ·
`units.market_rent` never an authority · retired client pricing store never
restored.

---

## Operational notes for the next thread

- **Migration numbers collide across contributors.** Two `106` files broke
  every API deploy until renumbered. Check `ls migrations/` before adding one.
- The migration ledger keys on **version**; the runner correctly refuses a
  different file reusing a recorded version.
- `POST /operator/session` body field is **`proof`**, not `token`.
- In the browser use `window.__psLive.beginOperatorSession(<invite>)`; setting
  `sessionStorage` directly does **not** sign you in.
- App repo local branch is `r1/renewals-live-read`; push with
  `git push origin HEAD:main`.
- `DATABASE_URL` in `api/.env` is dead; pull it from Render env per session.
- Harnesses: `governed_economics_proof`, `demo_authority_ruling_proof`,
  `authority_resolution_proof`, `identity_authority_proof`,
  `pricing_governance_proof`, `pricing_foundation_proof`,
  `pricing_decision_packet_proof` — **583 assertions**.

## Key documents

`PRICING_GOVERNANCE.md` · `IDENTITY_AND_AUTHORITY.md` ·
`GOVERNED_ECONOMIC_TERMS.md` · `ECONOMIC_CONVERGENCE.md` ·
`ECONOMIC_DECISION_ROOM.md` · `AUTHORITY_RULING_EXECUTION.md`
