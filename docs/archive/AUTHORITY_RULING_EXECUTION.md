# Demo Pricing Authority Ruling — Execution Report

**As of 2026-07-27** · api `12be1cf`
**STOPPED AT STEP 1.** No identity link, no classification, no authority grant,
no pricing publication, no AI change, no person merge.

**367 assertions green** — 73 authority · 63 identity · 101 governance ·
55 foundation · 75 packet.

---

## 1. Kameron evidence — the ruling's own stop condition is met

Searched by **contact identifier only**, never by name.

| Required | Found |
|---|---|
| `user_id` | **`78375274-922a-44c5-8b61-0c285d1b9911`** — "KZ", `kz8434@gmail.com`, `+17243098434`, **phone verified 2026-07-25**, `person_id = NULL`, `account_kind = 'unclassified'`, active |
| `person_id` | **none that qualifies** |
| verified contact basis | unique verified phone → resolves to exactly one person |
| staff context | **absent** |
| property entitlement | **none** |
| current assignments | **none** |

The single person matching that phone is **`ede3fe95` "Kameron Zitelli"** —
`lifecycle_status = tenant`, `source = boardroom_demo`, created 2026-07-17,
**no staff context**, and attached to **15 tables as a counterparty**: 135
`comm_events`, 100 `events`, 76 `obligations`, plus applications, tours,
conversions and charges.

**And no staff record can be Kameron:** of the 24 persons carrying a governed
staff context, **zero have any phone** and **zero have a non-internal email**.
Every one is a `staff_bridge` seed or an R3 smoke-test artifact.

> **There is no deterministically verified Kameron staff record.** Classifying
> the tenant row as staff would make a demo prospect the publisher of record
> — by fiat, not evidence. Creating a new person and calling it Kameron would
> be selection by name. Both refused.

**Steps 2 and 4 not started.**

---

## 2. Staffbridge and classification receipts

**None — correctly.** The chain never began. The bridge would have refused
anyway: it links only `human_staff` accounts, and this login is
`unclassified`. `user_person_bridge_audit` has **0 rows for this user**.

---

## 3. Deactivation receipt — applied

The correction is independent of who the future publisher is, so it was
applied.

```
assignment_id 4117da50-87fc-4624-b4a9-509921e7e97f
person_id     16b442ee-…  UNCHANGED   (no transfer)
role          owner       UNCHANGED   (row still shows what was created)
created_at    2026-07-02T14:45:57Z  UNCHANGED  (history not rewritten)
is_active     true → FALSE
row           still exists (not deleted)
```

`provenance` now carries:

```
deactivated_at 2026-07-27T21:31:23Z
deactivated_by_user_id e9a7659f-… (QA operator, internal correction)
governed_by "Demo Pricing Authority Ruling 2026-07-27"
deactivation_reason "Authority assignment attached to a non-staff demo lead.
  Deactivated after governed identity audit; no privileged action was
  exercised through this assignment."
evidence { staff_contexts: 0, lifecycle_status: lead, source: demo,
           used_as_demo_tenant: true, linked_logins: 0,
           privileged_actions_exercised: 0,
           attachments_portfolio_wide: [assignments, demo_attempts] }
```

**Demo Building now has zero active owner/asset-manager authority.**
Portfolio-wide: **0 of 28 properties** can publish pricing.

---

## 4. Scoped grant receipts

**None.** Blocked by step 1. Three independent grants
(`may_prepare_pricing`, `may_review_pricing`, `may_publish_pricing`, **not**
`may_manage_concession_authority`) are ready to create through
`resolveAuthority` the moment a verified staff person exists.

---

## 5. Corrected actor-context response

```
link_status: unlinked · reconciliation_required: true
denied_because: session_identity_not_linked_to_a_person
may_read_property: true · all four person-governed verbs: false
```

`/operator/authority-view`:

```
missing_step: classify_account_as_human_staff
invalid_authority_on_non_staff_records: 0   (was 1 before the correction)
inventory: by_assignment 0 · by_grant 0
summary: 0 of 28 properties with publish authority
```

---

## 6. Browser proof

Decision Room, signed in, live: `data-ps-state="no_version"`,
`data-ps-authority="denied"`, **0 publish controls**, and the operator is told
the real obstacle:

> *"You cannot author or publish pricing for this property. This login is not
> yet reconciled to a verified person, so no person-governed action is
> permitted. That is an administrative step, not a pricing one."*

---

## 7. Rehearsal

Against the **real session**, the rehearsal stops at `may_prepare_pricing` and
reports why — the honest live state.

The full chain **is** proven, under a constructed authority inside one
rolled-back transaction (`pricing_governance_proof`, 101 assertions):
draft saved → invisible to effective pricing → review receipt appended →
**a $1 edit after review refused** (`proposal_changed_since_review`) → both
identities recorded → published version refuses date change, term change and
return-to-draft → **overlap refused by `ex_pricing_versions_no_overlap`** →
nothing survived.

**I did not grant even a temporary assignment to make this run.** A real
assignment on a shared database survives a crash. Instead the block runs
inside one outer transaction with a shim that neutralises the services' own
`begin`/`commit`, and each intentional trigger failure runs in its own
savepoint. Nothing is ever committed.

---

## 8. Ledger actor boundary — closed

`publishPricing` no longer destructures `published_by_person_id` from the
caller. The publisher is **read from a sealed actor**.

A caller still supplying the old field is **refused**
(`CALLER_SUPPLIED_ACTOR`) rather than silently ignored — silently ignoring it
would let a caller believe it chose the actor while the server used another.

Proven refusals: raw person id · no actor · hand-built actor · **copied
actor** · **copy with a swapped acting person** · cross-property actor ·
system actor as publisher of record. The `WeakSet` seal is retained and
exercised through the privileged path.

The operator-key publish route now returns an explicit `no_session_actor`: it
carries no staff session and cannot mint an actor.

---

## 9. Operating state unchanged

| | |
|---|---|
| `property_pricing_versions` / `pricing_terms` / `concession_policies` / `pricing_review_receipts` | **0 / 0 / 0 / 0** |
| Published pricing | none |
| Live AI quoting | unchanged — adapter still dark, `agent.js` does not reference it |
| `units.market_rent`, 13 `agent_facts` | untouched |
| Concessions | none active |
| Future Rent Roll | 0 positions given projected pricing |
| Persons | **900** — none merged, renamed or deleted |
| Authority grants | **0** |

**One row changed in the entire database:** `assignments.is_active` and
`.provenance` on `4117da50…`.

---

## 10. Where identity could not be proven without a human record selection

1. **No Kameron staff person exists.** The only Kameron person is a demo
   *tenant* carrying 358 counterparty rows. Options — each requiring your
   ruling:
   - **(a)** Create a new staff person for Kameron and link the verified
     login. Clean, but a *new* record — I will not create one unasked.
   - **(b)** Classify the existing tenant record as staff. Makes the pricing
     publisher a record built by a boardroom demo, and mixes counterparty
     history with operator authority. **Not recommended.**
   - **(c)** Use a different real human who already has a staff record — but
     all 24 are seeds or test artifacts.
2. **`account_kind`** for `kz8434@gmail.com` is `unclassified`. Classifying it
   `human_staff` is a ruling about employment; contact evidence cannot
   establish it.
3. **Assignment vs grant** still unanswered for whoever is named. Given Demo
   is the demo property, a 30-day scoped grant looks right — and the rehearsal
   already proves the lifecycle **without** one.
4. **`tmysl@me.com`** remains in the same state, unrelated to pricing.

---

## The single question

> **Which person record should represent Kameron as staff — a newly created
> one, or the existing tenant record?**

Everything downstream is built, proven, and waits on that one answer.
