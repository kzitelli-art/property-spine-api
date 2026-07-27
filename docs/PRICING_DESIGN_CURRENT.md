# Pricing, Concessions & Fees — the design as it exists today

**Written 2026-07-27, after the live audit. Nothing here is built.** This is the
"bring back the current design so we can decide the simplest durable shape" artifact.

Owner's end state, verbatim:

> One approved pricing source for each property. Leasing, the AI, applications, offers,
> leases, and the Rent Roll all read from it. Nothing else is allowed to quote money.

Owner's constraint on the operating surface:

> asking rent · lease term · concession · fees · effective rent
> The engine can be complex underneath. The operating surface should not be.

---

## 1. The headline finding

**The data shape you are asking for already exists.** Migrations 062 and 063 model all
five operator fields, including fees and dated economic consequences. The build never
stalled on the shape. It stalled on three other things: nothing writes to it, nothing
reads from it, and one function in the middle is an honest stub.

So the decision in front of you is **not** "design a pricing object." It is "which parts
of the existing design do we turn on first, and what do we do about the one wall."

---

## 2. Where money is defined today — the disconnected places

Five places currently define or state money. None of them know about each other.

| # | Place | What it holds | Who reads it | Governed? |
|---|---|---|---|---|
| 1 | `units.market_rent` | one number per unit | **the AI**, `agent.js:294` | No. No version, no author, no date, no approval |
| 2 | `agent_facts` (`pricing_*`, `move_in_credits`, `pet_policy`) | fee amounts + move-in credits as **prose** | the AI, via the prompt | Partly — `status`, `approved_by_user_id`, `confirmed_at` exist; `effective_until` exists but **is never honored** |
| 3 | `property_pricing_versions` → `pricing_terms` / `concession_policies` | the governed, versioned design | **only** `commitmentledger.js` | Yes — and **0 rows** |
| 4 | `followup_runner.js` | rung copy | prospects, unattended | Was a hardcoded promise; **fixed 2026-07-27** |
| 5 | `app/index.html` `window.__pricingStore` | asking rents + `{free_months, dollars_off}` | the Marketing screen only | No. In-memory, dies on refresh, seeded only for real Solo's id |

Two of these state money to real prospects today: **#1 and #2**. Neither is versioned.
#3 is the only governed one, and nothing reaches it.

Note #5 models a concession as `{free_months, dollars_off}` — **the exact shape doctrine
forbids.** If the operator surface gets rebuilt on the governed object, that shape goes away.

---

## 3. The governed design that already exists

Plain English, from migrations 062 and 063.

### 3.1 A published price is a *version*, never an editable field (D9)

`property_pricing_versions` — `draft` → `published` → `retired`, with `effective_from` /
`effective_until`, `published_by_person_id`, `published_at`, `supersedes_version_id`, and
`authority_basis` (a snapshot of *why that person was allowed to publish*, captured at the
moment of publish). An edit does not mutate a price; it creates a new version and retires
the old one. **No offer ever points at mutable pricing.**

### 3.2 The price itself

`pricing_terms`, one row per (`unit_type`, `lease_term_months`):

- `base_rent` — the asking rent
- `renewal_rent`, `immediate_move_in_rent` — the other two segments
- **`fee_terms jsonb`** — fees already have a governed home here

### 3.3 A concession is a policy, not a flag

`concession_policies`, attached to a pricing version:
`concession_type` ∈ `free_rent` · `fixed_rent_credit` · `fee_waiver`, plus `value`,
`scope` / `scope_ref` (property-wide or by unit type), `lease_type` (new/renewal),
`required_term_months`, and `fee_category` when it is a waiver.

### 3.4 Discretion is a dial on the assignment graph (D11)

`concession_authority_grants` extends an existing `assignments` row — never a parallel
permissions product. It carries `guardrail_mode` (soft/hard), `escalation_threshold`,
`max_discretionary_value`, per-fee waiver booleans, `maximum_discretionary_free_rent_months`,
`may_edit_pricing`, `may_publish_public_offers`, and validity dates.
**No grant = fail-closed HARD.** That is why the open write surface is currently harmless:
the table is empty, so every discretionary offer is refused.

### 3.5 The promise, and the moment it becomes economics

`lease_offers` separates **`communicated_at`** (when the prospect was told) from
**`recorded_at`** (when staff captured it). An offer with no evidence is a `draft` and can
neither qualify nor lock. An offer may name an exact space or carry a scope ("any studio"),
and **never** creates a hold.

`lease_economic_lines` is the dated consequence — one row per month:
`line_type` ∈ `base_rent` · `recurring_fee` · `one_time_fee` · `concession_credit` ·
`fee_waiver`, with a sign constraint (credits and waivers must be negative, charges
positive) and a `reconciliation_state`.

**Read that line_type list again: rent, recurring fees, one-time fees, concessions and
waivers are all already modelled as dated lines.** This is the Forward Rent Roll's input.

---

## 4. The operator's five fields, mapped onto what exists

| Operator sees | Comes from | Exists? |
|---|---|---|
| **asking rent** | `pricing_terms.base_rent` | Yes |
| **lease term** | `pricing_terms.lease_term_months` | Yes |
| **concession** | `concession_policies` (published) or `lease_offers` (discretionary) | Yes |
| **fees** | `pricing_terms.fee_terms` | Yes |
| **effective rent** | computed — `computeConcessionValue()` (D12) already exists | Yes |

**All five map today.** No new table is required to put that screen on the wall.

### The unlock worth noticing

**Effective rent does not need the calendar contract.** Amortized effective rent is
`base_rent − (concession_value ÷ term_months)` — that is arithmetic, and `computeConcessionValue`
already implements the deterministic value. The calendar contract is only needed to decide
**which month** a credit lands in, which is what `lease_economic_lines` needs.

So the operator surface and the dated schedule are **separable**. The surface can be true,
governed and versioned while `computeScheduleLines` is still a stub. That is the "simple
surface, complex engine" split you asked for, and it is already latent in the design.

---

## 5. The honest gaps

Five, in the order they would bite.

1. **`computeScheduleLines` is a throw-only stub**, and `IMPLEMENTED_TIMING_PROFILES = []`.
   Every timing profile is unimplemented, by design, until real lease language answers where
   a free month actually falls. Until then nothing can lock dated economics. This is a wall,
   correctly built, and it is a **document question, not a code question.**

2. **The lock is orphaned.** `lockLeaseEconomics`, `computeScheduleLines` and
   `findEligibleOfferForApplication` have zero callers repo-wide; `countersign` appears in no
   `.js` file (it was retired in 088 for Verify Executed Lease → Confirm Term, and the lock
   did not move with it). `ledgerService` is passed into `applications.js:41` and
   `tenancy_anchor_service.js:53` and never invoked. **Reconnecting it is a restoration, not a
   new design** — the ruling is already in the code.

3. **Move-in credits do not fit cleanly.** Owner ruling: they are concessions. But they are
   granted on an **eligibility class** — first responder, military/veteran, Penn affiliate —
   and `concession_policies` has no eligibility dimension (only scope, lease type, required
   term). It also needs verification-required and one-time-at-execution semantics. This is
   the one place the existing shape genuinely needs an addition.
   Related: `isCalendarDependent()` exempts only `fee_waiver`. A one-time credit at execution
   is arguably month-agnostic too — decide whether it is exempt, or it will be calendar-blocked
   for no good reason.

4. ~~**`agent_facts.effective_until` is never honored.**~~ **CLOSED 2026-07-27** (owner
   decision — truth hygiene, not the pricing build). The agent's fact query now requires
   `effective_until is null or effective_until > now()`. Proven a no-op today (27/27 facts
   survive, zero active-but-expired rows exist) and a guard from here on: the moment dated
   concessions and fees live in facts, an expired one stops being quotable automatically.

5. **Nothing links a unit to a `unit_type`.** `pricing_terms` is keyed by `unit_type` text;
   `units` has `bedrooms`, `bathrooms`, `square_feet` and no type column. Publishing a price
   for "Studio Unfurnished" and having unit 530 read it requires a resolution rule that does
   not exist. **This is the smallest missing piece with the largest blast radius**, because it
   is what would let the AI stop reading `units.market_rent`.

---

## 6. The simplest durable shape — recommendation

**Do not design a new object. Turn on the one that exists, in this order.**

1. **Decide unit_type resolution** (gap 5). Without it nothing else connects.
2. **Publish one real pricing version for Demo Building** — asking rent, term, fees. That
   makes `property_pricing_versions` non-empty and gives `units.market_rent` a successor.
3. **Point the AI at it.** The agent stops reading `units.market_rent` and reads the published
   version. That single change is the whole "nothing else is allowed to quote money" rule,
   enforced where it actually matters.
4. **Move fees out of prose** into `pricing_terms.fee_terms`, and retire the `pricing_*`
   `agent_facts`. Until then the prompt rule shipped today (quote only from approved facts,
   otherwise say it needs confirmation) is the interim guard.
5. **Model move-in credits** as concessions with an eligibility class (gap 3).
6. **Only then** the dated schedule: fill the calendar contract from real lease language,
   implement one timing profile, reconnect the lock to Confirm Term, and let the Forward Rent
   Roll read it.

Steps 1–5 deliver the operator's five fields and the "one approved source" rule **without
touching the calendar contract**. Step 6 is where the engine gets complex, and it is
sequenced last on purpose.

---

## 7. Decisions owed before any of this is built

1. **How does a unit resolve to a `unit_type`?** (gap 5)
2. **Does published asking price leave `units.market_rent`,** and does that column then mean
   in-place rent only? Note the audit refuted the "asking mixed with in-place" reading —
   across 114 studios it matches the in-place lease rent only 9 times — so today it is a third
   thing with no defined meaning. Whatever it becomes should be *stated*.
3. **What is an eligibility class** for move-in credits, and who verifies it?
4. **Is a one-time credit calendar-dependent?** (gap 3)
5. **Who publishes?** Today exactly one identity can: Jordan Avery (demo), `owner`, Demo
   Building. Real staff need `assignments` rows or grants before this is operable.
6. **Ledger activation stays NO** (owner decision 6, 2026-07-27) until the authenticated user
   and property come from the **server** — not the request body — and dated economics actually
   flow through to the lease and the Forward Rent Roll.

---

## 8. What is already true, and needs no decision

- All 7 pricing tables exist and are correct. `Proven` — 0 rows each.
- The guardrail resolver, the deterministic concession value (D12), the authority snapshot
  (D10), the versioning doctrine (D9) and the evidence model are all implemented.
- The refusals are deliberate and should not be "fixed": 085 is `none`-only on concessions
  because hash equality cannot prove concession equality; Gate B was retired in 088 so a
  conflicting locked offer blocks rather than silently overriding an executed document;
  `computeScheduleLines` throws rather than guessing.

**The design is sound. It was never connected.**
