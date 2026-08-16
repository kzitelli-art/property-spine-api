# Agent-readiness audit — validation against Slices 1–10

**Not a re-audit.** [`AGENT_READINESS_AUDIT.md`](AGENT_READINESS_AUDIT.md) was
performed against `origin/main` @ `47ed0f0`. This validates its findings against
the source that will land, and classifies each one.

**No implementation. No code. No writes. This is a review.**

---

## What this was validated against, and the caveat

```
API main            4983e5d   (PRs #33, #35 — documentation only)
Slice 10            PR #37, branch @ 46a6ff0, main merged in, behind 0
App main            357fb15
Slice 10E           PR #33, branch @ c1684d3
```

**The caveat, stated first.** "Final landed" is not yet true: neither PR is
merged, because migration 129 blocks the release path. What is validated here is
the **exact source that will land** — the branch is a descendant of current main
with no further work planned. **The content cannot change at merge; only the
SHA can.** Re-confirm the SHA after merge; nothing else in this file needs
re-running.

**Production proof level is unchanged and unknowable from here.** No production
credential exists in this environment and the production origin is denied at the
network policy (`403` to `CONNECT`, logged by the proxy as a policy denial). No
finding below carries a production claim.

## What Slice 10 can and cannot have changed

Slice 10 touches **four source files**, all in the tenancy/route lane:

```
src/tenancy/dated_position_rows.js       new
src/tenancy/forward_rent_roll_summary.js new
src/tenancy/forward_rent_roll_page.js    new
src/identity/operator.js                 +103 lines, one route
```

It therefore **cannot** have changed any finding about maintenance services,
leasing writes, applications, comms, identity or obligations. Those rows are
carried forward unchanged, and that is a reason, not an assumption. Where Slice
10 does bear on a finding, it is because it introduced a **pattern** the audit
asked for — never because it moved a capability.

---

## 1. Findings, classified

### Re-verified against source in this pass

| Finding | Classification | Evidence |
|---|---|---|
| `create_staff_obligation` is withheld **structurally**, not by configuration | **still valid** | `agent.js:1282–1285` — `activeTools` is a literal and does not include it. Unchanged. |
| Class I is **empty** — no competing canonical paths | **still valid** | exactly **1** `insert into work_orders` in the whole tree, inside `createWorkOrder`. One availability model with declared readers. |
| No actor-scoped obligations read exists | **still valid** | `operator_obligations_service.list` takes `property_id`, `allowed_modules`, `status`. `assigned_user_id` appears only in the projection list, never in a predicate. |
| Renewals are a **recording gap** | **still valid — and now proven harder** | `renewal_cases` exists as a table with **zero writers in `src/`**, and there is no `POST`/`PATCH`/`PUT` route matching `renewal`. The audit said "no write service located"; it is stronger than that. |
| Agent-interaction record: migration 117 carries 7 of 9 fields | **still valid** | unchanged by Slice 10. |
| `work_completion` is Class E on **grain** | **still valid** | `loadWork` still takes `{work_id, property_id}`; no unit-level resolver. |
| `initial_triage`, `turn_scope` are Class A | **still valid** | unchanged. |

### Partially resolved by Slice 10 — the pattern now exists

| Finding | Classification | What changed |
|---|---|---|
| **Canonical destinations** — no registry; a surface either invents a route or emits prose | **partially resolved by later source** | `GOVERNED_DESTINATIONS` (`dated_position_rows.js:262`) is a frozen registry keyed by obligation type, returning a typed destination **or `null` plus a `destination_note`** stating that no governed route is recorded. That is the shape the audit asked for. It covers **one** obligation type. |
| **Canonical object resolution** — the resolver discipline exists in only one place | **partially resolved by later source** | `actionForRow` requires the obligation's lease to be one **the row actually references**, returns `resolution_state: "conflict"` when more than one qualifies, and `no_canonical_action` when none does — **never first-match**. Second instance in the codebase, after `space_position.recordEffectivePossession`'s `AMBIGUOUS_SPACE`. The seam is now *liftable* rather than *inventable*. |
| **Honest non-answer states** — no shared vocabulary across services | **partially resolved, and honestly qualified** | `RESULT_STATE` (`:117`) lands as the closest thing to a general vocabulary — but it **declares one value it never returns**, documented in `SLICE_10_RECEIPT.md` §4. A seed, not a solution, and it must not be adopted as one without a producer. |
| Availability & commitment truth is read-ready | **still valid, strengthened** | a second governed dated read now carries typed blockers with `code`/`affects`/`detail`, typed evidence state, and per-axis coverage. Classification unchanged (**B**); the read got materially more agent-legible. |

### Unchanged, and requiring a decision rather than more code

| Finding | Classification |
|---|---|
| Scope of read in prose — a conversation has no empty slots | **requires a product ruling** |
| Stated-versus-inferred marking, and read-back of spoken numbers | **requires a product ruling** |
| `create_staff_obligation`: which authenticated actor may trigger it, and where confirmation sits | **requires a product ruling** |
| Which line an agent-initiated send leaves from | **requires a product ruling** — and blocked behind the communication-line model, which is another lane |
| Whether disagreement with a ranking is itself an operating fact | **requires a product ruling** |
| Three reserved contract states have no producer | **requires a product ruling** |

### Insufficiently proven — the audit's own honest gaps, still open

| Finding | Classification | What is missing |
|---|---|---|
| Deployed SHAs vs source SHAs | **insufficiently proven** | no production credential, network denied. Unchanged and not closable from here. |
| 8 of 19 Pass-1 capabilities marked FIRST-LOOK | **insufficiently proven** | module and exported surface located; files not opened. Deliberate, marked, and still the correct label. |
| Receipt contracts for leasing writes (tours, applications, approvals, follow-ups) | **insufficiently proven** | writes exist; their return shapes were never traced. This is the largest remaining unknown in the audit. |

### Stale

| Finding | Classification |
|---|---|
| The **brief's** premise that two competing canonical paths exist (raw work-order insert; two availability models) | **stale** — neither survives. Re-confirmed this pass. Class I is empty, which is a result, not an omission. |

**Nothing in the audit was invalidated by Slice 10.** Four findings were
partially resolved by patterns it introduced; one premise in the *brief* was
already stale before the audit ran.

---

## 2. The smallest missing seams, ranked

Ranked by value ÷ size. Every one is a seam, not a feature.
**None of these is implemented here.**

### 1 · Actor-scoped reads — smallest, highest value

`operator_obligations_service.list` already receives `property_id` and
`allowed_modules` as **server-derived arguments**. It needs one more, derived
the same way and never from the request. Today the system cannot answer *"what
am I responsible for?"* — which, in a system whose fundamental unit is an
accountable human, is its primary key.

**Also closes seam 8 outright**, because the only browser-trapped meaning found
was the client-side filtering this forces.

*Size: one predicate in one function that has an existing test surface.*

### 2 · Canonical object resolution — the binding constraint on every write

One contract: **one record, or one narrow clarification, or
`no_qualifying_record`.** Never the first row. Never a silent create. The
discipline exists twice in source already (`AMBIGUOUS_SPACE`; Slice 10's
`actionForRow`), so this lifts an existing pattern rather than inventing one.

Unblocks `work_completion` — Class E purely on grain, everything else about it
already Class A — and is a precondition for every later conversational write.

*Size: one resolver contract plus its per-capability lookups.*

### 3 · Structured receipts

One shape: actor · property · canonical target IDs · before/after where
material · evidence IDs · event IDs · obligations created/changed/closed ·
projections expected to change · `occurred_at` **and** `recorded_at` · replay
identity. Four services already return most of it; `claimCompletion` is the
template and carries the property none of the others do — a line refusing to let
its own success be over-read.

*Size: one shape, retro-fitted to four services.*

### 4 · Idempotent recovery

Twenty-plus modules carry `dedupe_key` or `idempotency_key` in three distinct
patterns. **No service returns its replay identity in its receipt**, so the
correct recovery — reread canonical truth → find the replay identity → recover
the actual result — cannot be performed by a caller whose receipt was lost. A
write that succeeded but whose receipt never arrived is currently unrecoverable
through any interface.

*Size: one field, once seam 3 exists. Do not do this before 3.*

### 5 · Canonical destinations

Extend Slice 10's `GOVERNED_DESTINATIONS` shape — registry, typed destination,
or `null` plus a `destination_note` — beyond one obligation type. The shape is
frozen and proven; this is population.

*Size: one entry per obligation type that has a real operator route.*

### 6 · Confirmation and proof boundaries

Two live patterns exist and correctly disagree: `create_staff_obligation`
executes immediately; `staff_agent_service` confirms once with an attributed
proposal, and Build 6B made four intents `redirect` with **no proposal row at
all**. The gap is that the boundary is not **declared per write** — it is
implicit in which service you happen to call.

*Size: a classification per write, plus enforcement. Needs seam 3 first.*

### 7 · Typed write proposals

`staff_agent_proposals.proposed` is one opaque JSONB. `unknowns text[]` records
what could not be established — the right instinct, and the schema says so:
*"confirming something you were not told was uncertain is not consent."* Its
**inverse is missing**: nothing distinguishes what the human stated from what
Spine inferred.

*Size: schema addition — but **gated on the stated-versus-inferred product
ruling**, which decides the shape. Do not build ahead of it.*

### 8 · Browser-trapped meaning

**One instance found**, and seam 1 closes it. Listed so the category is not
mistaken for empty coverage.

*Size: zero, after seam 1.*

---

## 3. Ordering, and what it implies

```
1 → 2 → 3 → 4 → 5        buildable in order, each smaller because of the last
6 → 7                    blocked on product rulings, not on code
8                        falls out of 1
```

Seams 1 and 2 together unblock more than the other six combined, and neither is
a feature. That is the shape the first conversational packet should take —
**after** Slice 10 is released and production-proven, not before.

---

## 4. What is NOT concluded here

- **No production proof level** is claimed for any capability.
- **No agent packet is chosen.** That is step 3, and step 3 requires production
  acceptance that has not happened.
- **No seam is implemented**, and none should be until the consolidated Slices
  1–10 map exists.
- The eight FIRST-LOOK rows and the untraced leasing receipt contracts remain
  the audit's honest gaps. They are the first thing a Pass 3 should close, and
  they are cheaper to close than any seam above.
