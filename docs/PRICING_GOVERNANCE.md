# Governed Pricing — Authoring, Authority and Cutover

**As of 2026-07-27** · api `dd8a8f8` · app `e208e14`
**Nothing is published. No live AI message changed. No shadow message sent.**

Harnesses: `pricing_foundation_proof` 55/55 · `pricing_decision_packet_proof`
75/75 · `pricing_governance_proof` 99/99. **229 assertions green.**

---

## 1. Version lifecycle and audit behaviour

```
local proposal → server preview → saved draft → review receipt
  → authorized publication → effective published version → superseded history
```

One draft model. `property_pricing_versions.status` already separates draft
from published, so no second "proposed pricing" table exists.

**A draft has no operating effect, structurally.** Not by convention — every
consumer (`effectivePropertyPricing`, the AI adapter, Renewals, the Future
Rent Roll preview) filters `status='published'`. A draft is invisible because
nothing looks where it lives. Proven: with a full 8-type draft saved, the
property still reported `no_published_pricing_version` and the Future Rent
Roll preview was unchanged.

**Missing types are never inherited.** `saveDraft` deletes and rewrites terms
wholesale, so a type absent from the proposal is absent from the draft. A
stale price cannot outlive the decision that made it.

**The receipt survives its draft.** `pricing_review_receipts` is append-only
and holds the full packet, proposal and preview the reviewer actually saw.
Proven: after rewriting the draft, the receipt and its digest were intact.

**The digest is what makes the receipt mean anything.** Publication recomputes
the proposal digest and refuses on mismatch, so a sheet cannot be reviewed,
quietly edited, then published wearing the old approval. Proven:
`proposal_changed_since_review`.

**Published is immutable — enforced by the database.** Three triggers plus an
exclusion constraint. A service-level rule would protect only callers who go
through the service. Proven live: altering a published version's dates, its
terms, or returning it to draft all raise.

### Missing primitives found and fixed

| # | Blocker | Fix |
|---|---|---|
| 1 | `pricing_terms.base_rent` was NOT NULL, so **"addressed but not priced" was unstorable** — the only way to record a `not_offered` type was to invent a number | migration 102 drops the NOT NULL; the existing check still requires a rent when `offered` |
| 2 | **Review history had nowhere to live.** A jsonb column on the version would vanish with the draft it described | `pricing_review_receipts`, append-only, with snapshots and a digest |
| 3 | Authority had **two of four verbs** | `may_review_pricing`, `may_manage_concession_authority` added |
| 4 | **A fee waiver was forced to carry a calendar** (`timing_profile` NOT NULL default `first_full_month`) | nullable, plus the profiles the compiler can honour |
| 5 | **`uq_ppv_one_published` made supersession-with-history impossible** — one published version per property, forever | migration 103 drops it; the exclusion constraint on effective periods is the correct, more precise rule |

Finding #5 was caught by the harness: it asserted the overlap refusal and got
back the *wrong error*. The constraint that fired was a row-count index, not
the period rule.

---

## 2. Authority service and inventory

Four verbs — `may_prepare_pricing`, `may_review_pricing`, `may_publish_pricing`,
`may_manage_concession_authority` — from exactly two explicit sources: an
active `owner`/`asset_manager` assignment, or an in-window grant naming the
verb. **Never from a name, a title, or property membership.** Proven: a
`leasing` assignment (19 of them exist) grants nothing.

**Fails closed on every path.** Unknown person, unknown property, expired
grant, and — the one that matters — a failed database read all deny. A denied
verb carries `basis: null`, so a receipt can never show authority without
saying where it came from.

### The inventory is not production-ready, and worse than reported

| Fact | Value |
|---|---|
| Properties | 28 |
| Properties with any publish authority | **1** (Demo Building) |
| Publish-capable assignments portfolio-wide | **1** — `Jordan Avery (demo)`, `owner` |
| Authority grants | **0** |
| **Users whose session can reach ANY owner/asset-manager assignment** | **0** |

**The identity chain is broken.** `users.person_id` is NULL for 36 of 59
users, including the QA operator. Of the 23 linked users, **not one** resolves
to a person holding an owner or asset-manager assignment. The property has
**two `Jordan Avery (demo)` person rows**: the owner assignment sits on
`16b442ee…`, and the login user links to `bfa835d8…`, which holds
`property_manager`.

So **no signed-in operator can currently exercise any pricing verb.** This is
browser-proven: the Decision Room renders
*"You cannot author or publish pricing for this property — session identity
not linked to a person."*

Matching users to persons by **name** would have hidden this in one line. It
is the same label-join removed from every other surface, and here it would be
worse: it would hand publish authority to whichever duplicate row sorted
first. Not done. Reported instead.

---

## 3. Pricing Decision Room — browser proof

Signed in, live, `data-ps-source="live"`:

- **Headline is exposure, not price:** *"152 of 281 residential positions have
  no contractual cover in 90 days · 2 marketable now · 49 pending successors"*
- Per type: three bars (locked today / locked at 90d / **uncovered at 90d**),
  in-place median with lease count, native executed (**none on any type**),
  legacy dimmed as *evidence only*, client store as *retired — no candidate*,
  proposed rents as *not decided*, and the missing-decision list.
- **Commercial Space:** *"not residential — no pricing decision, legacy value
  is evidence only."*
- **The spread as distribution:** *"Studio — 75 of 108 at $1,450, with 8 other
  prices across 33 positions."* Both counts are stated, because 8 (distinct
  prices) and 33 (positions) are different units and conflating them changes
  the apparent size of the problem fourfold.
- **`data-ps-authority="denied"`** with the exact reason.
- **No Publish control is rendered for anyone**, including an owner: zero
  buttons in the panel. A button that cannot work is a lie about capability.
- **Dry-run preview through the sealed write channel:**
  `disposition: dry_run_no_write_performed`, `would_publish: false`, 18 quote
  previews, **0 quotable**.

**State not browser-proven:** the *unavailable* (failed-read) state. The
loader validates and **clears** a dead session on load, so a
signed-in-with-failing-read condition cannot be produced by revoking a token.
The catch branch exists and renders *"Pricing could not be read right now…
This is not the same as having no pricing"* — but it is **code-verified, not
browser-verified**, and is recorded here as such.

---

## 4. Executable economic-class validation

Eight refusals, each naming the wrong number it stops:

| Refusal | Prevents |
|---|---|
| `recurring_entered_as_one_time_fee` | $30/month becoming $30 once |
| `one_time_entered_as_recurring` | a $300 pet fee billed monthly |
| `requirement_entered_as_held_deposit` | a fabricated liability |
| `credit_advertised_without_authority` | a posting sold as an offer |
| `range_quoted_as_precise_amount` | $87 invented from "$75–99" |
| `cadence_unknown` | an amount that cannot be summed |
| `required_without_applicability` | "required" reading as required-of-everyone |
| `optional_presented_as_universal` | the $15 insurance shape |
| `duplicate_value_two_owners` | two copies that silently diverge |

**Recurring charges are refused from a pricing sheet, not flattened.** The
sheet is given an honest sentence instead: *"Recurring charges are governed
outside this version and are not yet available for precise quoting."* No
recurring-charge schema was created.

---

## 5. Money-fact cutover inventory

All 13 active facts are graded in
[PRICING_DECISION_PACKET.md](PRICING_DECISION_PACKET.md) §4 with class,
amount, cadence, applicability, source, runtime caller, quotability, canonical
owner and verdict. **Only 2 of 13 are cleanly governable.**

**Retirement conditions:**

| Fact | Retires when |
|---|---|
| `pricing_application_fee` | its governed row exists (ready now) |
| `pricing_admin_fee` | an event dimension distinguishes move-in from renewal |
| `pricing_amenity_fee` | new-lease vs renewal becomes structured, not prose |
| `pricing_telecom_fee` | **a determinant for $75 vs $99 is declared** |
| `pricing_security_deposit` | underwriting owns it; pricing stops quoting a band |
| `parking` / `pet rent` / `wifi` / `insurance` | the recurring-charge model exists |
| `unit_transfers`, `entry_access` | leasing policy / operations own them |
| `move_in_requirements` | **immediately on cutover — it owns nothing** |
| `move_in_credits` | the schedule engine can place its dated lines |

A range with no determinant stays unresolved. A prose fact duplicating numeric
values does not survive cutover as a second owner.

---

## 6. Concession schedule compiler

Pure and deterministic — no clock, no randomness, no database. Replaces the
throw-only stub.

| Profile | State |
|---|---|
| `one_time_fee_waiver` | **implemented** — one dated credit; refuses when the governed fee is unresolved |
| `flat_dated_credit` | **implemented** — one dated credit inside the term |
| `fixed_monthly_discount` | **implemented** — one line per month from the first full month |
| `free_rent_period` | **specified, not implemented** |
| `first_full_month`, `third_full_month`, `final_full_month` | **specified, not implemented** |
| `monthly_scheduled_credit` | **specified, not implemented** |

**The blocking primitive is `proration_basis.`** A period that does not align
to calendar months needs a declared basis — actual days, a 30-day month, or
full-months-only. On a 20-day February those differ by more than 10%, and
guessing would leave the ledger unable to reproduce the number. Named, not
invented.

`monthly_scheduled_credit` needs `schedule_source`: the vocabulary carries one
value and no schedule. `fixed_monthly_discount` is the implemented form of
that shape.

**Effective rent is derived from the lines**, never asserted beside them:
$1,450 − 300/12 = **$1,425**, from three real dated credits. `free_months`
never appears as economic truth. Nothing is activated; no route creates lines.

---

## 7. Shadow quote comparison

34 comparisons. **Sent nothing** — `comm_events` 653 → 653, `persons` 900 →
900, verified before and after.

- **23 live answers would become unavailable after cutover.**
- **15 carry unsupported precision.**
- **The unit-530 shape is detected mechanically:** the live path answers from
  `market_rent asc`, so it quotes one unit out of a spread chosen by *sort
  order rather than by a pricing decision*. That is the exact failure that put
  $1,687 in front of nine real phones.

The live side is **modelled** from the two sources `agent.js` reads, and every
row says so. Claiming to have executed the live agent would overstate it.

---

## 8. Future Rent Roll integration preview

Read-only, not wired into the roll. Proven:

- **0 locked positions repriced**; every one carries `pricing_applied: false`.
- Pending successors, contested and unclassified positions: **zero projected
  pricing**, each with its own reason.
- Pricing resolved **at the projection date**, so a future-dated version does
  not affect today.
- Only `published` is eligible — a draft is invisible.
- **0 positions given projected revenue.**

**"+ approved assumptions" is doing real work and does not exist.** Published
pricing states what would be *asked*; an assumption states how much would be
*got*. Uncovered positions therefore return `published_ask` with
`projected_rent: null` and
`assumption_set_not_built` — required first: `renewal_capture_rate`,
`downtime_between_tenancies`, `absorption_pace`. **Pricing alone cannot create
occupancy.**

---

## 9. Market-evidence interface contract

Contract only. No store, no network, no schema — asserted against its own
source. Twelve fields including append-only identity, `observed_at` vs
`recorded_at`, governed-type *relationship* (never identity), verification,
confidence, freshness and supersession.

Proven: an unverified public listing cannot claim high confidence; a
competitor's unit cannot **be** one of our governed types; consuming an
observation as pricing is refused; every displayed row is marked
`evidence_only_not_pricing`.

---

## 10. Remaining ownership decisions to publish version one

1. **The Studio outliers** — 8 other prices across 33 positions, including a
   lone `$1,045`. Data error or real?
2. **1 Bed** (`$1,200` singleton) and **Furnished 1 Bed** — same question.
3. **New-lease rent × 8 types.** In-place medians run below legacy on every
   type.
4. **Renewal rent × 8 types** — explicit, or explicit `pricing_unavailable`.
5. **Which lease terms.**
6. **3 Bed / 2 Bath** — in-place $3,300 vs legacy $3,900, the largest gap.
7. **Telecom determinant.**
8. **Pet policy split** — fee + recurring, per-pet or per-tenancy.
9. **Approve rewriting `move_in_requirements`.**
10. **Name a real publisher** — and **link that person to a login**, which is
    now the binding constraint (§2).

---

## 11. Live AI cutover sequence

Not started. `agent_facts` remains the live source; the adapter stays dark.

1. **Link session identity to persons.** Nothing else can proceed —
   §2 is a hard gate.
2. **Grant real authority** to a named publisher (not in this build).
3. **Publish version one** (rents only). Fees stay on `agent_facts`. Live
   quoting is unchanged; the sheet exists but nothing reads it.
4. **Run shadow mode on real conversations without sending.** Any disagreement
   is a defect found before a prospect hears it.
5. **Cut rent quoting over** at zero disagreement, behind its own receipt.
6. **Resolve the four blocked fees**, then migrate fees **one at a time**,
   retiring each `agent_facts` row in the same commit that adds its governed
   row, so two quotable copies never coexist.
7. **Delete `move_in_requirements`.**
8. **Recurring charges** — separate build.
9. **Concessions last**, after `proration_basis` is declared, starting with
   the one calendar-free shape.

Each of 5–9 needs its own reviewed receipt.

---

## 12. Contradictions and missing primitives discovered

| # | Finding | Status |
|---|---|---|
| 1 | `base_rent` NOT NULL made an unpriced type unstorable | **fixed** (102) |
| 2 | No home for attributable review history | **fixed** (102) |
| 3 | Two of four authority verbs missing | **fixed** (102) |
| 4 | Fee waiver forced to carry a calendar | **fixed** (102) |
| 5 | `uq_ppv_one_published` made supersession-with-history impossible | **fixed** (103) |
| 6 | **`users.person_id` NULL for 36/59; 0 users reach an owner assignment; duplicate Jordan Avery person rows** | **open — reported, not worked around** |
| 7 | **`proration_basis` undeclared** — blocks 4 concession profiles | **open — named** |
| 8 | **`schedule_source` undeclared** — blocks `monthly_scheduled_credit` | **open — named** |
| 9 | **Approved assumption set does not exist** — blocks any Future Rent Roll projection | **open — named** |
| 10 | Recurring-charge model does not exist — 4 live monthly charges invisible to every surface | **open — refused, not flattened** |
| 11 | Telecom range has no determinant | **open — unresolved by design** |
| 12 | `move_in_requirements` is a live second owner of 4 fee values | **open — retirement condition set** |
| 13 | Unavailable-state not browser-provable (loader clears dead sessions) | **open — stated, not claimed** |
