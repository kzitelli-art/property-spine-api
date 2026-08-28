# Economic Terms Convergence — Return

**As of 2026-07-27** · api `4dd7627` · **582 assertions green** (7 harnesses)

**Nothing published. No fact retired. No concession activated. No live AI
change. No FRR total changed. No other property received authority.**

---

## What was built

| Phase | Status |
|---|---|
| 2 — persisted draft candidates | **done, proven** |
| 3 — canonical Economic Picture | **done, proven, HTTP-proven** |
| 4 — extended shadow simulator | **done, proven, HTTP-proven** |
| 1 — six-section operator surface | **NOT BUILT** |
| 5 — Ownership Economic Decision Room | **NOT BUILT** |
| 6 — multi-class publication preview | **NOT BUILT** |
| 7 — atomic cutover planner | **NOT BUILT** |
| 8 — browser proof | **NOT DONE** (depends on Phase 1) |

I ran out of context, not judgment. The four unbuilt phases are recorded here
rather than half-shipped. **Phase 4 (shadow) is complete; Phase 1 (surface) is
not**, so the pair you named as gating is half-done.

---

## 2. Persisted draft receipts

| charge_id | code | source fact | state |
|---|---|---|---|
| `59f39d8d` | `fee.application` | `pricing_application_fee` | **draft** |
| `cba086d4` | `fee.administration` | `pricing_admin_fee` | **draft** |

`source_provenance = migration_candidate_from:<fact_key>`;
retirement condition recorded as *retire the legacy fact in the SAME release
that publishes its governed row*.

**Structurally non-operational, not merely flagged:**
- the DEFAULT `governedCharges` read returns **none** of them
- the dark adapter cannot see them **at all**
- `ck_gc_active_is_published` means a draft carries no publisher, no receipt
- both `agent_facts` rows remain **active** and are still the only live source

The existing `record_state` was already an honest draft state, so no new
lifecycle primitive was needed.

## 3. Economic Picture (`GET /operator/economics/picture`)

```
completeness.by_class: base_rent unresolved · one_time_fees unresolved
  · recurring_charges unresolved · deposit_requirements unresolved
  · advertised_concessions unresolved      overall: unresolved
one_time_fees: drafts 2, published 0
combined_monthly_total: withheld — [base_rent:unresolved, recurring_charge:unresolved]
contradictions: 11 · missing determinants: 6
```

A **composition, not a master version** — each class keeps its own source,
dates and authority receipt because they publish independently. A master
version would freeze a snapshot the rows then drift from, and it would look
authoritative while being stale.

Each source reads independently: one class failing never voids another.

## 4. Extended shadow (`GET /operator/economics/shadow`)

**37 comparisons. `sent_anything: false`.** `comm_events`, `persons`,
`obligations` and charge counts byte-identical before and after.

```
unsupported_precision            13
applicability_disagreements       2
duplicate_ownership_blocking      0
governed_refused / partial / ready   32 / 2 / 2
cannot_survive_cutover           35
```

It compares **more than dollars** — two answers can agree on the number and
still disagree dangerously: a `$30` that is monthly on one side and one-time
on the other, an optional charge presented as universal, a range quoted as a
point. Duplicate ownership is flagged **blocking** whenever both sides would
be quotable at once; it is zero today only because nothing is published.

---

## 8. Facts ready for ownership approval

**Two**, both persisted as drafts awaiting your explicit yes/no:

| Fact | Proposed governed row |
|---|---|
| `pricing_application_fee` | `fee.application` — **$50**, one_time, required, per applicant, new-lease |
| `pricing_admin_fee` | `fee.administration` — **$99**, one_time, required, per unit, new lease **and** renewal |

## 9. Facts still blocked, and the missing determinant

| Fact | Missing determinant |
|---|---|
| `pricing_telecom_fee` | **what decides $75 vs $99** |
| `pricing_amenity_fee` | new-lease vs renewal as two structured rows |
| `pet_policy` | fee/rent split **and** per-pet vs per-tenancy |
| `renters_insurance` | required coverage vs optional $15 programme |
| `pricing_security_deposit` | requirement vs held; underwriting ownership |
| `parking_pricing` | availability model |
| `utilities` | electric/water unmetered beside a precise $40 wifi |
| `unit_transfers`, `entry_access` | conditions unstructured; not pricing's to own |
| `move_in_requirements` | **no destination** — a charge row would make the duplicate permanent |
| `move_in_credits` | concession, calendar-dependent |

## 10. Contradictions exposed by the shadow

- **13 unsupported-precision answers** — chiefly the live rent path choosing
  one unit from an unexplained spread **by sort order**, which is the unit-530
  shape, plus ranges quoted as points.
- **2 applicability disagreements** between prose and governed scope.
- **Commercial space**: live `$0` against a governed refusal — a numeric zero
  is an absent decision, not a free unit.
- **35 of 37** live answers cannot safely survive cutover today, each with a
  named reason.

## 11. Confirmation

- ✅ no pricing published — `property_pricing_versions` = 0
- ✅ no charge term published — 0 **active**; 2 drafts
- ✅ no live AI message changed — adapter dark; `agent.js` clean
- ✅ no legacy fact retired — all 13 still active
- ✅ no real concession activated — 0
- ✅ no FRR total changed — 0 positions projected
- ✅ no other property received authority — 1 of 28

---

## Remaining work, in order

1. **Phase 1** — the six-section operator surface over
   `/operator/economics/picture` (server already returns every field it needs).
2. **Phase 8** — browser proof of the fourteen listed states.
3. **Phase 5** — Ownership Economic Decision Room (data exists in the
   migration preview and contradiction report; needs the decision shell).
4. **Phase 6** — multi-class publication preview.
5. **Phase 7** — atomic cutover planner for all 13 facts.
