# SLICE 9 — APPLICATION TARGET GRAIN

**What this document is:** the complete inventory of every path that can aim an
application at a unit, what each one validates, and where space lineage begins.

**Status:** Commits A–I landed (API + app), plus the acceptance correction
narrowing targeting to `marketable_now`.

---

## 1. THE GOVERNING BOUNDARY

The application segment is durably **UNIT-GRAINED**. Verified against live
schema, not inferred:

```
application_invitations   property_id, unit_id      NO space_id
lease_applications        property_id, unit_id      NO space_id
lifecycle BIRTH_FIELDS    unit_id                   NO space_id
executed_lease_records    space_id                  ← space grain begins
leases                    space_id NOT NULL         ← and is required here
```

`createSubmittedApplication` does not silently drop an unknown `space_id`. Its
closed allowlist refuses the entire birth with `birth_payload_unknown_field`.

Therefore:

| Unit shape / state | Behaviour |
|---|---|
| exactly one space **and `marketable_now`** | supported — space derived **server-side** |
| `upcoming` / `turnover_required` | refused · `future_application_target_not_supported` · 409 |
| more than one space | controlled refusal · `space_grain_not_supported` · **409** |
| zero spaces | refused · `application_target_unconfigured` · 409 |
| not at this property | refused · `not_at_property` · 404 |

> **A space choice cannot be offered unless the complete durable chain can
> preserve it.**

### Why space COUNT, not space eligibility

Filtering a two-space unit down to its one marketable space and taking what
remains is *"select the first marketable space"* wearing a different hat. The
durable record could not distinguish that space from its sibling afterwards.
A unit whose second space is a storage closet refuses too. Refusing is a valid
outcome; guessing is not.

### resolved_space_id is a VALIDATION RECEIPT, not lineage

It proves which space availability was evaluated against. It is **not** the
application's space and is not persisted as one — not in `captured` JSON,
notes, `unit_label`, event text, obligation metadata, or browser state
presented as durable truth. Proven by assertion: no column on
`application_invitations` holds it after a successful preparation.

---

## 2. THE CLOSED CENSUS

Every way an invitation or application can be born. This is the whole set —
verified by searching for the writes themselves, not by trusting a call graph.

```
insert into application_invitations   → 2 sites, both behind the authority
insert into lease_applications        → 1 site (application_lifecycle.js:283)
                                        reached only via submitApplicationService
```

**`src/applications/application_target_authority.js` · `resolveApplicationTarget`
is the one resolver.** It reads canonical availability
(`surfaces/availability_read`) and does not import the legacy
`tenancy/availability` module.

---

## 3. THE PATHS

### 3.1 · `POST /operator/leasing/application-invitations` — prepare

| | |
|---|---|
| **Source identity** | staff session → `req.operator.id`, `req.operator.property_id` |
| **unit_id source** | request body |
| **Durable object** | `application_invitations` @ `prepared` |
| **Target validation** | `unitOfferableState` → `resolveApplicationTarget`, plus the choke point inside `createPreparedInvitation` |
| **Transaction** | the route's own `client`, passed into resolution — target and write share one snapshot |
| **Sole-space** | proceeds; receipt carries `resolved_space_id` |
| **Multi-space** | 409 `space_grain_not_supported`, no invitation row |
| **Untargeted** | **refused at the route** — `unit_id` is required (400). Unchanged. |
| **Space lineage begins** | not here |

### 3.2 · `POST /operator/leasing/application-invitations/send` — prepare + provider send

As 3.1, then dispatch. **Ordering enforced:** resolve → invitation insert →
comm_event insert → communications boundary → provider attestation. A target
refusal happens before all four.

### 3.3 · `POST /operator/leasing/conversions/:id/send-application` — composite

| | |
|---|---|
| **unit_id source** | request body; the conversation shortcut (`cc.unit_id`) is the app-side origin |
| **Target validation** | `stageApplicationSend` → injected `unitOfferable` → the authority, with the open client |
| **Untargeted** | refused — `unit_id` required (400). Unchanged. |

The server does **not** infer a target from tour history, conversation text,
last-mentioned unit, prospect preference, timing, or unit number.

### 3.4 · `createPreparedInvitation` — THE CHOKE POINT

Every prepared invitation is created here, so the target is resolved here.

The prior check was a **property wall only** — it proved the unit was at this
property and nothing else. An invitation could be prepared for a unit that was
occupied, down, committed to another resident, or carried two spaces with no
way to say which one the application meant.

**Refusal precedes the insert.** No invitation row, no token, no comm_event
follows a refused target.

### 3.5 · `createAndDispatchApplicationInvitation` — provider dispatch

Its own inline insert, so its own resolution. Provider dispatch does not bypass
resolution merely because it holds a `unit_id`. Refusal lands before the
invitation insert, before the comm_event insert, therefore before any wire.

### 3.6 · Resume (`resume_invitation_id`)

Revalidates the **grain**, not the market: same property, still exactly one
space. A unit since split into two spaces is ambiguous and the link must not go
out.

`require_offerable` is **false** here, deliberately. This is crash recovery, not
a new offer — the unit may have become unmarketable *because of this very
applicant*, and demanding marketability would make a legitimate resume
impossible. Only structural grain failures refuse.

### 3.7 · `regenerateInvitation` / retry

Routes through `createPreparedInvitation`, so it inherits the authority with no
second rule. It revokes the old invitation before creating the replacement, and
both happen in the caller's transaction — **a refused regeneration rolls back
the revoke, leaving the original invitation intact.**

### 3.8 · `sendApplication`

Accepted `intended_move_in` and then **silently dropped it**, so a forward offer
was validated against "available today". It is now carried into the one
resolution.

### 3.9 · `submitApplicationService` — THE APPLICATION-BIRTH GRAIN FLOOR

Every application record is born here (public token, internal staff, import).

`require_offerable` is **false** by design: an application record is not an
offer. The internal path exists partly to record applications that **already
happened** (`source: 'import'`), and refusing those because the unit is no
longer marketable would make historical truth unrecordable.

What is **not** negotiable is the grain. A multi-space unit produces an
application nobody can attribute to a space, and `lease_applications` has no
`space_id` to attribute it with.

**Deliberate disposition, recorded rather than left unnamed:** offerability is
*not* enforced on the internal staff door. Offerability for the public token
door is enforced by its own submission-time revalidation (Commit C).

### 3.10 · `POST /applications/submit-public` — submission-time revalidation

| | |
|---|---|
| **Source identity** | bearer token → `application_invitations` row (`for update`) |
| **unit_id source** | the invitation, never the request body |
| **Durable object** | `lease_applications` @ `submitted` |
| **Target validation** | `resolveSubmissionTarget` |
| **Placement** | **after** the idempotency return, **before** the atomic consume |

**Placement has two intended consequences:**

- A previously completed submission has already returned above. Current
  availability is **never** re-run against a durably born application —
  revalidation applies before *first* birth only.
- A refusal leaves the invitation **unconsumed**. The token is not burned by a
  condition the applicant did not cause and cannot fix.

On refusal nothing downstream happens: no `lease_application`, no
`application_submitted` event, no progression obligation closed, no approval
obligation spawned. All of those live below the consume. The invitation is not
converted to another unit and no new space is selected.

**Preparation and submission apply ONE identical rule** (owner ruling, after the
acceptance addendum found them diverging):

```
preparation   marketable_now
submission    marketable_now
```

The earlier form admitted `upcoming` and `turnover_required` at preparation when
a supplied `intended_move_in` fell on or after a governed `available_from`. That
date is a **request parameter** and reaches no durable row, so submission could
not reproduce the verdict and applied a **strictly weaker** standard in three of
six cases. `turnover_required` was unreachable at preparation yet permitted at
submission.

> A target may not be offered unless **both boundaries can independently reach
> the same verdict from durable facts alone.**

`intended_move_in` is now threaded **nowhere**: it is absent from the authority,
from `createPreparedInvitation`, from `createAndDispatchApplicationInvitation`,
from `sendApplication` and from the route bodies. It is not persisted in
captured JSON, notes, labels, events, obligation metadata or communication
records. Proven by assertion, not by intent.

**`upcoming` and `turnover_required` remain truthful canonical availability
states.** They are not removed, not flattened into `unavailable`, and
`availability_read.js` is untouched by this correction. They are simply not
valid application targets under the present durable application contract.

**Ambiguity gets its own code.** A unit split into two spaces after the link
was sent returns `application_target_became_ambiguous`, not
`space_grain_not_supported` — the unit *changed* under an open invitation
rather than having been an unsupported shape all along, and the operator needs
to be told which.

### 3.11 · `GET /operator/leasing/leaseable-units` — the selector

| | |
|---|---|
| **Source identity** | staff session; `property_id` is **server-derived**, never the query string |
| **Returns** | `eligible_units` + `unsupported_multi_space_units` |
| **Target validation** | one canonical `availabilityRead`, then the authority's own `evaluateOfferability` per row |

**Two lists, not one filtered list.** A multi-space unit is not absent because
it failed a marketing test — it is present and unselectable, carrying the
server's reason. Dropping those rows silently would leave an operator hunting
for a unit visible in every other surface with no statement of why it is
missing here.

**One row per unit, never one per space.** Returning a selectable row per space
would offer a choice the invitation cannot preserve.

`resolveApplicationTarget` is deliberately **not** called per unit — it re-reads
availability for the whole property each time, which is quadratic. The
authority's exported policy function is applied to one canonical read instead.
Same rule, evaluated once per position.

**This discharges the Class 2 removal condition.** `LEASEABLE_STATES` and the
legacy import are gone from `operator.js` entirely, leaving **zero** legacy
availability consumers there — which is what unblocks Commit E.

### 3.11b · The app half

The app stays unit-grained. It sends `person_id` and `unit_id` only, never
`space_id`, and never reads `resolved_space_id` at all.

Multi-space units render as present-but-unavailable rows with no `data-uid`,
no button element, and no click action — unselectable structurally, not by
styling. The copy is *"Individual-space application links are not supported for
this unit yet"*, never *"select a space"*: selecting one cannot solve the
durable-lineage limitation, so wording that implies a forgotten step would be
false.

A `409` grain refusal on the `cc.unit_id` shortcut opens the selector with the
controlled reason and does **not** re-prepare the same unit, and never shows
prepared or sent.

**Space-grained rendering elsewhere in the app is correct and was left alone.**
The executed-lease surface names *"the exact space the lease names"* because
`executed_lease_records` and `leases` carry `space_id` — that is precisely
where space lineage is supposed to begin. The app proof scopes its assertions
to the application selector for this reason.

### 3.12 · `POST /operator/leasing/application-intent`

Records intent against a conversion. **Carries no `unit_id`** and creates no
invitation, so there is no target to resolve. Listed for completeness.

---

## 4. UNTARGETED APPLICATIONS

`resolveApplicationTarget` returns an explicit untargeted result
(`resolution_basis: 'untargeted'`, `offerable: false`, `ok: true`) for
`unit_id: null`.

**No production path is wired to it.** Every operator door that reaches an
invitation requires a unit and still returns 400 without one. The untargeted
result exists so a workflow that already supports an untargeted application
truthfully can use it — introducing untargeted behaviour to a path that
currently requires a unit is out of scope, and was not done.

---

## 5. WHERE SPACE LINEAGE BEGINS

```
invitation      unit-grained
submission      unit-grained
application     unit-grained
  ↓
confirm-term    tenancy_anchor_service.js → leases @ 'pending', space_id NOT NULL
                ← FIRST COMMITMENT, and the first point space identity is durable
```

The future migration that bridges invitation → submission → birth is
**narrowly scoped and parked outside this slice**.

---

## 6. EVIDENCE

| Proof | Result |
|---|---|
| `slice9_application_target_authority_proof.js` | 70 passed, 0 failed |
| `slice9_targeted_invitation_proof.js` | 26 passed, 0 failed |
| `slice9_public_submission_revalidation_proof.js` | 25 passed, 0 failed |

Both run against real Postgres in a rolled-back transaction over a seeded
scratch property. Neither reads Demo Building.
