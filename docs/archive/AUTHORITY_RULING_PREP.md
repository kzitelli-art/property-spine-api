# The Controlled Path — Ready for Ownership's Ruling

**As of 2026-07-27** · api `bc10ec4`
**Nothing applied.** The demo lead's owner assignment is untouched, no login
linked, no grant created, no person merged, nothing published.

`authority_resolution_proof` **54/54** · identity **62/62** · pricing
**229/229** → **345 assertions green.**

---

## 1. Authority-resolution dry-run tool

`resolveAuthority(pool, { spec, apply })` — **nine independent proofs**, each
able to veto alone. They are not collapsed into a score: a "mostly valid"
authority grant is not a weaker grant, it is an invalid one that looks fine.

| # | Proof | Refuses when |
|---|---|---|
| 1 | `user_is_real_login` | no such user, or inactive |
| 2 | `person_is_classified_staff` | no `person_contexts.staff`, or `account_kind ≠ human_staff` |
| 3 | `link_is_governed_or_eligible` | person claimed elsewhere, or login already linked |
| 4 | `person_entitled_to_property` | staff context scoped to another property |
| 5 | `proposal_is_property_scoped` | non-authority role, or no property |
| 6 | `no_silent_overwrite` | a conflicting assignment or in-window grant exists |
| 7 | `person_is_not_a_counterparty` | lead/applicant/tenant/resident/vendor, **or used as a demo tenant** |
| 8 | `effective_window_valid` | a grant without a start |
| 9 | `reviewed_by_distinct_authorized_human` | no reason; reviewer is missing, self-reviewing, unclassified, not active staff for the property, or lacks `may_manage_concession_authority` |

**Staffness is a governed fact, not a name.** `person_contexts.context_type =
'staff'` is the marker written when a human classifies someone. Every genuine
staff person on Demo carries it; the person holding the owner assignment has
**none**. That is what proves it is a lead — not the `(demo)` in its label.
The label was always visible and established nothing: three sibling rows share
it and carry real prospect activity.

Proven: the tool never classifies, links or edits a person, and **no
comparison in it reads a display name**. `apply` throws rather than writing
when any check fails.

---

## 2. Demo owner-assignment ruling packet

Read-only. Sweeps **all 62 tables that reference `persons`** rather than a
hand-picked list, so "nothing else is attached" is measured, not claimed about
the tables somebody remembered to check.

**Person `16b442ee` — `Jordan Avery (demo)`**

| Evidence | Value |
|---|---|
| Staff contexts | **0** |
| `lifecycle_status` | `lead` |
| `source` | `demo` |
| Email / phone | **none at all** |
| Linked logins | **0** |
| Used as demo **tenant** | **yes** — `demo_attempts` row created in the *same second* as the person row, checkpoint `application_ready`, status `reset` |

**Everything attached, portfolio-wide: exactly two rows.**
`assignments.person_id × 1` (the owner assignment itself) and
`demo_attempts.tenant_person_id × 1`. Nothing else, in any table.

**Historical privileged use: none.** 0 published versions, 0 grants, 0
reviews, 0 concession incidents reference it. Removing it rewrites no history
and invalidates no record. It is also **unreachable** — no login is linked, so
the authority exists but cannot be exercised by anyone.

### The four options

| Option | Consequence | Preserves history |
|---|---|---|
| **Deactivate** | Nothing changes anywhere — the authority is already unreachable and was never used. Demo Building then has **zero** owner assignment until one is created on a verified human. | ✅ |
| **Transfer** | The row's creation timestamp and provenance would silently come to describe a different human. An audit would conclude the staff member has held owner authority since 2026-07-02, which is false. | ❌ |
| **Replace with a scoped grant** | Narrower: only the named verbs, an expiry, and a record of who granted it. An assignment carries all four verbs forever. | ✅ |
| **Leave it** | Every inventory keeps reporting "1 publish-capable assignment" for a demo prospect — the misleading state that made this investigation necessary. | ✅ |

The packet does not choose. Your stated direction — remove from the lead,
re-establish on the verified human as a **new attributable action** — maps to
*deactivate* then *assign/grant*, and the evidence supports it: nothing is
attached, nothing was ever exercised, nothing breaks.

---

## 3. Identity-versus-authority write sequence

Four **separately attributable** writes, never collapsed:

```
1. classify the account        users.account_kind = 'human_staff'
                               → staffbridge /classify, audited
2. establish verified identity users.person_id via staffbridge
                               → user_person_bridge_audit, reversible
3. confirm property entitlement person_contexts staff row for the property
4. assign or grant authority   assignments row, OR concession_authority_grants
                               → resolveAuthority, receipted
--------------------------------------------------------------------
5. exercise authority          resolveActorContext returns the verbs
```

`resolveAuthority` performs **step 4 only** and names the outstanding earlier
steps in `outstanding_sequence_steps`, so a single "make publisher" operation
cannot exist.

---

## 4. Privileged actor contract for `commitmentledger.js`

```
session caller supplies user_id ONLY
  → server resolves via resolveActorContext
  → privileged service receives a RESOLVED ACTOR OBJECT, never a bare id
  → non-session actions name an explicit SYSTEM ACTOR with its own basis
  → no caller supplies the authoritative acting person
```

**The harness caught a real hole in my first version.** The seal was a
symbol-keyed property — and object spread *copies* symbol keys, so
`{ ...realActor, acting_person_id: someoneElse }` produced a forged actor that
passed the guard. **Identity was mutable by one spread.** It is now a
`WeakSet` registry: membership travels with the object, not its shape. Both
the plain copy and the person-swapped copy are proven to fail.

Why an unforgeable type rather than a convention: a rule saying "pass the
resolved person id" is satisfied by passing *any* person id — the wrong one
type-checks perfectly. The guarantee moves out of reviewer diligence and into
the call signature.

**Ledger migration plan** (travels with the contract, in
`LEDGER_MIGRATION`): each entry point takes `actor` and calls
`requireResolvedActor`; `published_by_person_id` is read *from* the actor;
routes call `actorFromSession`; seeds pass `systemActor('seed')`; `canPublish`
keeps its own check — the actor proves *who*, the ledger still proves *may*.

**Risk today: latent, not live.** All routes sit behind the `x-operator-key`
gate, every ledger table has 0 rows, and no route supplies a session actor.
**Sequencing:** land it *after* ownership names the publisher and *before*
the first real publication, so it is exercised by the rehearsal rather than by
a live publish.

---

## 5. Rollback-only version-one rehearsal

Runs the full chain against **live** constraints and triggers, then rolls
back. A mocked publication would only prove the code agrees with itself.

Current result: **stops at `may_prepare_pricing`**, reporting *"Not linked —
session_identity_not_linked_to_a_person."* That is the useful output today.

Once authority exists it proves: draft saved → invisible to effective pricing
→ review receipt appended → **a one-dollar edit after review is refused**
(`proposal_changed_since_review`) → publication contract passes → transaction
rolled back → authority basis recorded → both identities recorded → reviewed
digest carried.

Economics are constructed (`$1,234` / `$1,244`). Choosing real rents is
ownership's decision; a rehearsal proposing plausible numbers would be a draft
of the answer.

Verified after the run: pricing tables byte-identical, no published version,
no Future Rent Roll total changed, no concession active, adapter still dark.

---

## 6. Management authority view — proven

`GET /operator/authority-view` → 200:

```
signed_in_account: Solo QA Operator [INTERNAL] (internal_qa)
verified_staff_identity: null · link_status: unlinked
missing_step: classify_account_as_human_staff
pricing_capabilities: all four false · may_read_property: true
invalid_authority_on_non_staff_records:
  owner — "Jordan Avery (demo)" — lifecycle lead, source demo,
  staff_contexts 0, linked_logins 0
  why_invalid: "No governed staff context — this is not a staff record."
```

It surfaces the exact row that made the inventory misleading, by evidence
rather than by label. Not a directory, not an HR system.

---

## 7. Exact write set after ownership names the publisher

Assuming *deactivate then re-establish*, with `P` = the named verified staff
person and `U` = their login:

| # | Table | Write | Reversible |
|---|---|---|---|
| 1 | `users` | `account_kind = 'human_staff'` for `U` | ✅ |
| 2 | `user_person_bridge_audit` | one audit row | append-only |
| 3 | `users` | `person_id = P` for `U` | ✅ |
| 4 | `person_contexts` | staff context for `P` on Demo *(if absent)* | ✅ |
| 5 | `assignments` | `is_active = false` on `4117da50…` (the demo lead's owner row) | ✅ |
| 6 | `assignments` **or** `concession_authority_grants` | one new row on `P`, provenance `authority_resolution` + reviewer + reason | ✅ |

**Six writes. Four tables. Each independently attributable.** Steps 1–3 go
through `staffbridge`; step 6 through `resolveAuthority`. Step 5 is its own
explicit decision, not folded into step 6.

---

## 8. Records that remain unchanged

- **All 900 person rows** — nothing merged, renamed or deleted.
- The other four Jordan Avery rows and their conversations, comm_events and
  obligations.
- Every other assignment on Demo (2 leasing, 1 property_manager).
- `property_pricing_versions`, `pricing_terms`, `concession_policies`,
  `pricing_review_receipts` — all **0 rows**.
- `units.market_rent`, all 13 `agent_facts` — live AI quoting unchanged.
- Future Rent Roll totals, Current Rent Roll, Availability, Renewals.
- The `demo_attempts` row that proves what the lead was.

---

## 9. New ambiguity that could prevent a safe ruling

1. **Which human is the pricing owner?** Not derivable. No person row on Demo
   both carries a staff context *and* is plausibly the property owner — the
   only staff-context human with an assignment is `Jordan Avery — Demo`, a
   **property_manager**, which is deliberately not an authority-bearing role.
2. **Is `Jordan Avery — Demo` a real person or a seeded demo staff identity?**
   `source = 'staff_bridge'`, email `jordan.avery@propertyspine.internal`,
   created by `seed_bridge_demo_staff`. It is a *seeded* staff record. Granting
   it owner authority would make a seed the publisher of record.
3. **Should Demo Building have a real owner at all?** It is the demo property.
   A time-bounded QA grant may be more appropriate than a permanent owner
   assignment — but per your instruction, no grant is preferable if the
   lifecycle can be proven without one, and **it can**: the rehearsal is
   rollback-only and needs no production authority to prove the machinery.
4. **`kz8434@gmail.com` and `tmysl@me.com`** remain blocked at classification.
   Deterministic contact evidence exists; employment is not derivable from it.

**Nothing above prevents a safe ruling — each is a question only ownership can
answer.**

---

## The gate

> Name (1) the human responsible for pricing on Demo Building, (2) the exact
> verified staff-person record, and (3) whether authority comes via an active
> property assignment or an explicit scoped grant.

Everything else is built, proven and waiting.
