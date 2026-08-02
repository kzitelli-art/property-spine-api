# SLICE 9 — APPLICATION TARGET GRAIN

**What this document is:** the complete inventory of every path that can aim an
application at a unit, what each one validates, and where space lineage begins.

**Status:** Commits A–B landed. Commit C (submission-time revalidation) and
Commit D (leaseable-units + app) are recorded here as they land.

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

| Unit shape | Behaviour |
|---|---|
| exactly one space | supported — space derived **server-side** |
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

### 3.10 · `POST /applications/submit-public`

Commit C. Recorded there.

### 3.11 · `GET /operator/leasing/leaseable-units`

Commit D. Still on the legacy allowlist at the time of Commit B, marked
**Class 2** in source with its removal condition. It is one of the two internal
consumers Commit E must retire before deleting the legacy module.

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

Both run against real Postgres in a rolled-back transaction over a seeded
scratch property. Neither reads Demo Building.
