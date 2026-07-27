# Identity & Authority Convergence

**As of 2026-07-27** · api `6d82223` · app `197167c`
**No person rows merged. No assignments transferred. No authority granted.
Zero links applied. Nothing published.**

`identity_authority_proof` **62/62** · pricing harnesses **229/229** →
**291 assertions green.**

---

## 1. Portfolio identity-graph inventory

| | |
|---|---|
| Active users | **58** |
| Persons | **900** |
| Active assignments | **23** |
| Authority grants | **0** |
| Users linked to a person | **22** |
| **Users reaching pricing authority** | **0** |
| Duplicate person labels | **248** |

| Classification | Users |
|---|---:|
| `linked_unique` | 3 |
| `linked_to_duplicate_person_label` | 6 |
| `unlinked_but_deterministically_resolvable` | 2 |
| `unlinked_and_ambiguous` | 34 |
| `linked_without_property_assignment` | 2 |
| `linked_to_inactive_person` | 0 |
| `linked_to_wrong_property_scope` | 11 |

Names are carried so a human can read the report, and are used only to
**disqualify** a link when two persons share one — never to create one. That
asymmetry is the design.

---

## 2. Canonical actor context

`resolveActorContext(pool, { user_id, property_id, as_of })` — the one place
that decides who a signed-in operator is, for pricing, concessions, renewals,
money, work ownership, Text-to-Spine attribution and reporting sign-off.

**A user is a credential; a person is a human.** The schema always knew this —
assignments, grants and most attribution columns are person-keyed. Nothing
enforced it, so a session's `user_id` could be written where a `person_id`
belongs and produce an audit trail pointing at a credential.

**Entitlement and authority are split.** An unlinked user keeps
`may_read_property` from the session scope and loses every person-governed
capability. Collapsing the two would either lock everyone out of a working
product or let an unidentified login approve money.

**A property manager gets no pricing authority.** `FULL_AUTHORITY_ROLES` is
enumerated, not pattern-matched, and `property_manager` is deliberately
absent: managing a property is not setting its rents.

**Cross-property authority is filtered in the query**, not after it — no
object exists in memory that could leak into a decision.

**Every failure denies:** unknown user, inactive user, dangling link, failed
identity read, failed authority read, missing session user, missing property.

---

## 3. Actor-assumption audit

| Finding | Class |
|---|---|
| No route writes `req.operator.id` into a `*_person_id` column | **CORRECT** |
| `staffbridge.js` — the only module joining `users.person_id` to assignments; refuses name/phone as evidence | **CORRECT** |
| `pricing_authority.js` resolved users→persons itself | **MIGRATED TO ACTOR CONTEXT** |
| Decision Room called a pricing-specific authority route | **MIGRATED TO ACTOR CONTEXT** |
| `commitmentledger.js` takes `published_by_person_id`, `granted_by_person_id`, `spoken_by_person_id` **from the caller** | **UNSAFE AUTHORITY PATH** — behind the `x-operator-key` gate, all tables 0 rows, no route supplies a session actor. Not reachable from a browser session today. **Left in place; flagged.** |
| `body.property_id` in `tenantlink`, `demo`, `leasingleads`, `maintenance`, `movein`, `charges` | **READ-ONLY AND SAFE** or validated against session scope — none is an authority decision |
| `conversion_obligation_closure.js` records `actor_user_id` **and** `actor_person_id_at_event` | **CORRECT** — both identities, already |
| `work_order_service.js` carries `actor_user_id` + `actor_person_id` | **CORRECT** |
| Pricing receipts named only a person | **FIXED** — now carry `session_user_id` **and** `acting_person_id` |

Corrected now: the two mechanical, proof-covered pricing paths. The ledger's
caller-asserted actor is a real defect but not mechanical — it needs its own
slice, and changing it blind would break the only publish path that exists.

---

## 4. Reconciliation receipt and dry-run tool

**Built on the existing bridge, not beside it.** `staffbridge.js` already owns
governed linking with a row lock and `user_person_bridge_audit`. A second
linking path would have created two answers to "who is this login", audited in
two places — the exact duplication this build removes. So
`identity_reconciliation.js` decides **whether** a link is deterministic; the
bridge decides **how** it is written.

Accepted evidence: `unique_verified_phone`, `unique_email`,
`explicit_invitation`, `prior_governed_link` — each must resolve to exactly
one person **and** originate from exactly one user.

Refused: name-only matches · multiple candidates · conflicting identifiers ·
unverified phone · a person already claimed · **`would_confer_governing_authority`**
· merging person rows.

That last refusal is the one that matters. Pricing is blocked, exactly one
person row can publish, and attaching a login to it would make the blockage
disappear. That is choosing an outcome and calling it identity.

Receipt shape: `before · evidence · proposed link · authority consequence ·
affected properties · after · reviewer · applied_at`.

---

## 5. Links applied: **zero** — and that is the honest outcome

Two users had unique **verified**-phone evidence and zero authority
consequence, so the tool proposed them:

| User | Evidence | Proposed person | Consequence |
|---|---|---|---|
| `kz8434@gmail.com` | verified `+1724…8434`, one person | `Kameron Zitelli` (tenant) | **NONE** — no assignment |
| `tmysl@me.com` | verified `+1862…3053`, one person | `QA Tester 3053` (lead) | **NONE** — no assignment |

**The bridge refused both.** It links only accounts a human has classified as
`human_staff`; both are `unclassified`. Classifying a login as staff is a
ruling about employment that contact evidence cannot establish.

A dry run that promises what the apply path will decline is worse than no dry
run, so the precondition now runs **during** the proposal. Both now report
`account_not_classified_as_staff` and the tool reports **0 applicable links**.

---

## 6. The Jordan Avery investigation

**Five person rows, not two.**

| Person | Created | Source | Attached | Assignment |
|---|---|---|---|---|
| `16b442ee` | 06-29 23:27 | `demo` | **nothing** | **owner @ Demo** |
| `5d1401a9` | 06-29 23:29 | `demo` | 2 obligations | — |
| `4c942baf` | 06-29 23:33 | `demo` | 2 obligations | — |
| `b2c29163` | 06-30 00:48 | `demo` | 1 conversation, 12 comm_events, 6 obligations | — |
| `bfa835d8` | 07-05 01:49 | `staff_bridge` | — | `property_manager` @ Demo |

**Verdict: not duplicates of one human — an accidental split.** The four
`(demo)` rows are demo **lead** records created minutes apart during demo
runs, with no email or phone at all; three carry real prospect activity, so
they were used as leads. The fifth is the **staff** identity, created later by
the bridge, with an internal email, and it is the only one linked to a login.

**The `owner` assignment sits on a demo lead row** (`16b442ee`) with empty
provenance and nothing else attached — created 07-02, three days before the
staff identity existed. The staff row got `property_manager`.

**Not moved, not merged.** Transferring the owner assignment would make
pricing work and would be exactly the prohibited action. It needs a human
ruling (§11).

---

## 7. Permanent invariants proven (62)

A user and a person are separate identities · an unlinked user cannot perform
a person-governed write · a linked user receives only the linked person's
assignments · duplicate labels grant nothing · authority is property-scoped ·
a property manager gets no publication authority · grants are verb-scoped and
window-scoped · expired grants are never loaded · a failed identity read fails
closed · a failed authority read fails closed · read entitlement survives an
unlinked session · every privileged receipt names both identities · no
browser-supplied person or property can substitute for the session.

---

## 8. Actor-context route and browser proof

`GET /operator/actor-context` → 200.

```
link_status: unlinked · reconciliation_required: true
may_read_property: true · all four person-governed verbs: false
denied_because: session_identity_not_linked_to_a_person
```

Decision Room, signed in, live: `data-ps-authority="denied"`, **0 publish
controls**, headline intact, and the operator is told the real obstacle —
*"This login is not yet reconciled to a verified person… That is an
administrative step, not a pricing one."* The two failures look identical to
an operator and need different actions, so exactly one sentence is shown.

---

## 9. Pricing on the shared context

`pricing_authority` delegates to `resolveActorContext` and no longer queries
`users` at all. Every pricing receipt — draft, review, publish — now carries
`session_user_id`, `acting_person_id`, `property_id`, `verb`,
`authority_basis`, `link_status` and, at publication, the reviewed proposal
digest.

---

## 10. Version-one worksheet

`GET /operator/pricing/version-one-worksheet` — 8 types, 9 rulings,
**0 pre-filled decisions** (verified over HTTP). A worksheet that arrives with
plausible numbers in the boxes is a recommendation wearing a form; the
reviewer's job silently becomes "spot the wrong one" instead of "decide".
Evidence sits beside each blank. It cannot populate a governed draft.

---

## 11. Ambiguous identities requiring a human ruling

1. **The owner assignment on a demo lead row.** Is `16b442ee` meant to be the
   owner of Demo Building, or was the assignment attached to the wrong row?
   Nothing but that assignment is attached to it.
2. **34 unlinked users with no deterministic evidence** — no verified
   identifier reaches any person.
3. **Two users blocked at classification** (`kz8434@`, `tmysl@`): is each a
   staff account? Contact evidence is deterministic; employment is not
   derivable.
4. **6 users linked to a duplicated person label** — links stand, but their
   person rows share a name with another row.
5. **11 users linked outside the current property scope.**
6. **2 users linked to a person holding no assignment.**

---

## 12. Exact next step before version one can be saved, reviewed, published

**One ruling unblocks everything:**

> Name the human who owns pricing on Demo Building, and identify **which
> person row** is that human.

Then, in order:

1. **Classify** that human's login as `human_staff` (governed, `/bridge/classify`).
2. **Link** login → person through the bridge, with deterministic evidence.
3. **Ensure that person holds** an active `owner`/`asset_manager` assignment —
   by explicit ruling, not by moving the existing one to fit.
4. `resolveActorContext` then returns `may_prepare_pricing`,
   `may_review_pricing`, `may_publish_pricing`.
5. Draft → review → publish becomes reachable. All three are already proven
   against live constraints and triggers.

Nothing in pricing is waiting on pricing. **The blocker is one identity
ruling.**
