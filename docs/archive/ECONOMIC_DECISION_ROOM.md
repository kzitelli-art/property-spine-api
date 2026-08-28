# Economic Decision & Cutover — Return

**As of 2026-07-27** · api `52dcc69` · **582 assertions green**, 0 failing.

**Nothing published, retired, activated, sent or projected.**
Live state: `versions 0 · active_charges 0 · draft_charges 2 ·
active_concessions 0 · live_money_facts 13 · authority_rows 1`.

---

## Built this block

| Phase | Status |
|---|---|
| 5 — Ownership Decision Room | **done, HTTP-proven** |
| 7 — Atomic cutover plans (13 facts) | **done, HTTP-proven** |
| 6 — Multi-class publication preview | **done, HTTP-proven** |
| 1 — Six-section operator surface | **NOT BUILT** |
| 8 — Browser proof | **NOT DONE** (depends on Phase 1) |

## 3. Decision Room — `GET /operator/economics/decision-room`

**11 cards · 13 cutover plans · 0 preselected rulings.** Every
`ownership_decision` is null; options carry their consequence.

Each card ties a ruling to its **product consequence** from the shadow report:

```
application_fee
  AI says today  : "The application fee is $50."
  governed today : "It would hand off — no governed value exists yet."
  options        : approve / modify / reject, each with its consequence
```

The **administration-fee card flags what the prose hides**: "once at move-in
and at renewal" may mean a renewing resident pays $99 *again* — a materially
different offer from a one-off. That is a named option, not an assumption.

## 5. Cutover plans — all 13 facts

| Group | Facts |
|---|---|
| **ready after ownership approval** | `pricing_application_fee`, `pricing_admin_fee` |
| blocked by missing determinant | telecom, amenity, unit_transfers, entry_access |
| blocked by missing model | parking, pet, wifi, insurance |
| blocked by concession authority | move_in_credits |
| blocked by underwriting | security_deposit |
| prose only, owns no money | move_in_requirements |

Every plan encodes the rule: **legacy retirement lands in the SAME release as
the adapter switch**, and rollback reverts *both together*. Any other ordering
gives two independently quotable owners, or a silent gap where the AI
improvises.

## 4. Publication preview — `POST /operator/economics/publication-preview`

**No master publication object, by design.** Rent waits on eight rulings, the
application fee on one, recurring charges on a model that does not exist.
Coupling them would let the slowest hold the fastest hostage.

`writes_nothing: true` · `independently_publishable_today: []` · acting person
resolved as *Kameron Zitelli — Staff*.

Proven by construction: a fee check never reads a pricing version; `base_rent`
is forbidden in the charge catalog; `deposit_held` has no catalog row or code
path; a concession row reports `compiles`/`dated_lines`, and the live probe
refused `first_full_month` with `proration_basis_required`.

## 6. Shadow findings, tied to decisions

36 comparisons · **13 unsupported precision** · 2 applicability disagreements ·
**34 cannot survive cutover** · 0 duplicate ownership (nothing published yet).

## 7. Ready for approval — **2**

`fee.application` $50 · `fee.administration` $99. Both persisted as
**non-operational drafts**. I did not approve either.

## 8. Still blocked — **11**, each with its named determinant.

## 9–10. First safe sequences

**Publication:** approve $50 → publish `fee.application` → shadow passes →
adapter switch + `pricing_application_fee` retires in the same release →
one-source invariant. Then repeat for `fee.administration`.

**Live-AI cutover:** never before publication; never with the legacy fact
still active; explicit handoff if the governed read fails.

## 11. New contradiction found

The administration fee's **renewal re-assessment** is materially ambiguous and
had not been surfaced before: the prose supports both "$99 once" and "$99
every renewal".

## 12. Not built

The six-section operator surface and its browser proof. Recorded as
outstanding, not claimed.
