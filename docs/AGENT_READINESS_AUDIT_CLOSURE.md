# Slices 1–9 agent-readiness audit — closure

**Closes the FIRST-LOOK evidence gap.** Traced against API `main` `4983e5d`
with Slice 10 merged in (branch `claude/slice-10e-browser-acceptance-t0zk33`).
Read-only. No code, no writes, no renewal writer created.

**Nine FIRST-LOOK rows, not eight** — the earlier count was wrong. All nine are
resolved below.

---

## 1. The finding that changes the most rows

**There are two authentication seams behind the leasing writes, and they are
not equivalent.**

| | `/operator/*` | `/leasing/*` · `/applications/*` |
|---|---|---|
| gate | `resolveStaffSession(x-staff-session)` → real `users` row | portfolio-wide shared `OPERATOR_KEY` via `x-operator-key` |
| actor | **server-derived**, `req.operator.id` | **absent**; recovered from a session *if one happens to be sent*, else taken from the body |
| property scope | the session's property, enforced against the row | **none** — from the path or body |
| module entitlement | `requireLeasingModuleAccess` | **none** |

`src/identity/operator.js:130` versus `src/leasing/leasingleads.js:93`.

`resolveRecorderUserId` (`leasingleads.js:104`) is explicit about the
degradation: *"b.actor_id is accepted ONLY as a fallback on the shared-key-only
path (no session)."* That is honest, and it is still a caller supplying the fact
that attributes it.

**Verified on two decision routes**, because this is a strong claim:

```
POST /applications/:id/deny      const { …, decided_by_user_id = null } = req.body
                                 passed straight to closeApprovalGate and to the
                                 decision record. Never validated, never replaced.
POST /applications/:id/approve   const { approved_by = null } = req.body
```

The **same business act** has a session door and a key door. The *service* is
shared — this is not Class I — but the **attribution is not**. Every write
behind the key is therefore **Class F, authority gap**, not Class C.

This is the same defect `operator_obligations.js` was created to retire on the
read side: *"protected only by the portfolio-wide shared operator key while
taking its property scope from the query string."* The reads were fixed. **The
writes were not.**

---

## 2. The nine rows, reclassified

| # | Capability | Was | Now | Receipt class |
|---|---|---|---|---|
| 1 | lead & person intake | FIRST-LOOK C | **TRACED — C** | PARTIAL |
| 2 | tour booking & modification | FIRST-LOOK C | **TRACED — F** (key door) | PARTIAL |
| 3 | post-tour capture | FIRST-LOOK C | **TRACED — C** | PARTIAL, **best idempotency in the lane** |
| 4 | follow-up obligations | FIRST-LOOK C | **TRACED — F** (key door) | PARTIAL |
| 5 | application review | FIRST-LOOK C | **TRACED — B** (read-only) | n/a |
| 6 | application approval & rejection | FIRST-LOOK C | **TRACED — split: C on the session door, F on the key door** | approval PARTIAL; **rejection authority-gapped** |
| 7 | move-in queue & delivery gaps | FIRST-LOOK C | **TRACED — C** | PARTIAL |
| 8 | market & pricing evidence | FIRST-LOOK F | **TRACED to route + gate — F, unchanged** | not opened; see §5 |
| 9 | recently closed & durable receipts | FIRST-LOOK B | **TRACED — B** (`GET`, session-gated, read-only) | n/a |

**No row moved to A. Two moved from C to F**, and one split, because tracing
found the authority seam rather than a missing wrapper.

---

## 3. The traced chains

### Post-tour capture — the model, and the only one with real recovery

```
POST /operator/leasing/tours/:tourId/complete   session + leasing module
POST /leasing/tours/:tourId/complete            OPERATOR_KEY
  → BOTH call completeTourService (leasingleads.js:1943). One service, no fork.
  → property wall: enforcePropertyId vs tour.property_id, 403
  → recordedByUserId = req.operator.id on the session door — "SERVER-DERIVED,
    never the body" (operator.js:2885)
  → writes leasing_tours, tour_events, tour_units_shown, leasing_conversions,
    and the concession rail when a promise was spoken
  → durable event: tour_events row carrying capture_idempotency_key in metadata
  → obligations: opens the follow-up rail via createConversionFromTour
  → receipt: { receipt: "<assembled prose>", tour_id, conversion_id }
```

**Idempotency is real and correct.** A terminal tour with a matching
`capture_idempotency_key` returns `{ok:true, replayed:true, tour_id,
conversion_id, receipt:"Already saved — nothing changed."}`. The source states
the reason: *"the operator has no idea their tap went out twice and should never
be shown an error for it."* A **different** capture on a settled tour is refused
in words, and correction has its own lane (`/correct-outcome`) which never
mutates the original.

**Receipt class: PARTIAL.** It names canonical targets and it recovers, but the
operation and its consequences are **an assembled English sentence**. A
conversational layer would have to parse prose to learn what happened.

### Tour booking and modification — Class F

`request` → `insert into leasing_tours … status='requested'`, returns
`{receipt, tour_id}`. `confirm` → `update leasing_tours` + `insert into
lead_takeover_queue`, returns `{receipt, tour_id}`. `reschedule` → releases the
old slot, creates a **new** tour row with `rescheduled_from`, books the new slot.

All behind `OPERATOR_KEY`. No `tour_events` row on request/confirm. **No
idempotency key on any of them** — a double-tapped confirm re-runs.

### Follow-up obligations — Class F, structured return

```
POST /leasing/rungs/:obligationId/resolve        OPERATOR_KEY
  → resolveRung (leasingconversion.js)
  → returns { receipt: "Rung X closed as <outcome>/<resolution>; spawned Y",
              rung, outcome, resolution, spawned, … }
```

**The only leasing write whose response is structured beyond one id.** Still
PARTIAL — no actor, no event id, no property — but its shape is the closest in
the lane to the receipt contract seam 3 asks for.

### Application submission — token-authenticated, idempotent

`POST /applications/submit-public` is deliberately **public** and carries its
own auth: the invitation token, **digest-matched and row-locked inside the
route**; invalid, expired or never-sent tokens fail closed. Server comment
records why: *"Discovered the first time a real applicant reached submit: the
page was public, the submit it calls was behind the key gate."*

Returns `{receipt:"Application already submitted.", application, idempotent:true}`
on replay. **PARTIAL, with real idempotency.**

### Application approval — the split

```
POST /operator/leasing/applications/:id/approve   session; actor server-derived
  → returns { receipt, application: shape(...), terms_review_obligation_id }
POST /applications/:id/approve                    OPERATOR_KEY; approved_by from body
```

The session door's response is the **closest thing to a durable structured
receipt in the leasing lane** — it names the operation, the canonical target,
and the **obligation it created**. It still omits actor, event id and
`occurred_at`/`recorded_at`.

### Application rejection — authority gap

`POST /applications/:id/deny`, key-gated, `decided_by_user_id` from the body.
Status transition is guarded (`submitted|approved|lease_ready` only) and the
approval gate is closed with the decision. It also **releases any open
lease-signature follow-up** so the team is not told to chase a signature on a
dead application — a genuinely good consequence.

But the decider is caller-supplied, so **the durable record of who declined an
application cannot be trusted from this door.**

### Move-in delivery — the cleanest chain traced

```
POST /operator/leasing/leases/:leaseId/delivery/keys-ready    session + module
  → THE WALL is the row, not the browser: select lease, compare property_id,
    403 (operator.js:4246-4251)
  → actor: resolveActorPersonId(req.operator.id, req.operator.property_id)
  → deliveryHelper.satisfyDeliveryInput(input_key:'keys_access_ready')
  → completeDeliveryIfReady → the move-in delivery obligation completes
  → honest no-op: "No open move-in delivery obligation for this lease. Either it
    was already completed, or the term has not been confirmed yet." (404)
  → receipt names what happened AND what happens next
```

Everything seam 3 needs except the identity fields. **PARTIAL.**

### Lease packet and execution evidence

`POST /applications/:id/lease-packet` → `{packet: publicPacket(bundle)}`, key
door. `POST /operator/leasing/applications/:id/executed-lease/verify` → session
door, **carries idempotency and calls `spawnObligationFromEvent`**, and the
executed record itself is the strongest evidence artifact in the codebase
(`payload_hash`, `document_sha256`, `verified_by_user_id`, `event_id`,
`supersedes_record_id`, CHECK-enforced document identity).

---

## 4. Renewals — `RECORDING GAP — VERIFIED`

The search scope, stated exactly, so the conclusion can be falsified:

```
table-qualified INSERT / UPDATE / UPSERT   src/ server.js tools/ seeds/   → 0
query-builder forms .from/.table/.into     src/                           → 0
database functions mentioning it           pg_get_functiondef over public → 0
triggers on the table                      pg_trigger, non-internal       → 0
obligations of type 'renewal_decision'     src/ server.js                 → 0
rows on a fully migrated database                                         → 0
```

`renewal_cases` appears in exactly **two** source files, **both reads**:
`renewals_read.js:308` (`from renewal_cases`) and comments in
`renewal_lifecycle.js`. Created by `migrations/119_renewal_operating_rail.sql`.

**The design is complete and the writer was never built.** 119's own header
specifies the intended rails in detail — ownership through a real `obligations`
row (`module='leasing'`, `type='renewal_decision'`, `related_type='renewal'`),
offers through `lease_offers` with `scope='renewal'`, and the case table
append-only and supersedable. **Neither half has a writer.**

This is why the renewals surface reads as working: `renewals_read.js` derives
its cohort from position and lease facts and reads `renewal_cases` only when
present. The read is real. The operating record behind it has never been
written to.

**No renewal writer was created here.** It is a recording gap, and building one
is a slice, not an audit.

---

## 5. What is still not traced, stated rather than implied

- **Pricing draft → review → publish service internals.** Routes located and
  confirmed session-gated (`/operator/pricing/{draft,review,publish}`). Not
  opened. It stays **Class F** on separately-gated authority, which is a
  property of the authority model and no amount of further tracing changes it.
- **Concession ledger internals** reached from post-tour capture
  (`ledgerOut.blocked / exploratory / band`) — seen at the call site, not
  followed into the service.

Neither affects any classification above.

---

## 6. Receipt census across the leasing lane

```
DURABLE STRUCTURED RECEIPT      0
PARTIAL RECEIPT                 8   tour request · tour confirm · tour reschedule ·
                                    post-tour capture · follow-up resolve ·
                                    application submit · application approve
                                    (session door) · move-in keys-ready
ACKNOWLEDGMENT ONLY             1   lease-packet create — returns the packet, not
                                    the act
NO CANONICAL WRITE LOCATED      1   renewal cases (and renewal_decision obligations)
```

**Zero durable structured receipts in the leasing lane.** Every write returns a
prose sentence plus at most one or two canonical ids. None returns the actor,
the durable event id, `occurred_at` **and** `recorded_at`, or its replay
identity.

```
idempotency found        post-tour capture (capture_idempotency_key, replay
                         returns the original and reads as success)
                         application submit (idempotent:true)
                         executed-lease verify
idempotency absent       tour request · confirm · reschedule · follow-up resolve ·
                         application approve · application deny ·
                         lease-packet create · move-in delivery inputs
unknown-outcome recovery NONE anywhere — no leasing write surfaces its replay
                         identity, so a lost receipt is unrecoverable through
                         any interface even where the write itself is idempotent
```

That last line is the sharpest result of this pass: **idempotency exists in
three places and is unreachable in all three**, because nothing tells the caller
what key to replay.

---

## 7. Product rulings, updated

Carried forward: scope of read in prose · stated-versus-inferred marking and
number read-back · who may trigger `create_staff_obligation` · which line an
agent send leaves from · whether ranking disagreement is an operating fact ·
producers for the three reserved contract states.

**New, from this pass:**

7. **Do the key-gated leasing writes get retired behind staff sessions?** The
   reads were migrated for exactly this reason and the writes were left. Until
   they are, the durable record of who approved, declined, confirmed a tour or
   resolved a follow-up is caller-supplied on those doors. This is a security
   and attribution question before it is an agent question.
8. **Does the renewal rail get its writer, or does `renewal_cases` get
   retired?** A designed, migrated, zero-writer table is a standing invitation
   to assume it is populated.

---

## 8. Ranked seams — revised

The ranking **changes**. Two entries move.

| | Seam | Change |
|---|---|---|
| **1** | **Authority on the leasing write doors** | **NEW — now first.** Nothing downstream is worth building on a write whose actor comes from the request body. It is also not agent work: it is closing the door the read-side migration already closed. |
| 2 | Actor-scoped reads | was 1 |
| 3 | Canonical object resolution | was 2 |
| **4** | **Structured receipts — now carrying replay identity** | was 3; **merged with old 4.** Tracing showed idempotency and receipts are one seam, not two: three writes are idempotent and none is recoverable, because the key is never returned. |
| 5 | Canonical destinations | unchanged |
| 6 | Confirmation and proof boundaries | unchanged, ruling-blocked |
| 7 | Typed write proposals | unchanged, ruling-blocked |
| — | Idempotent recovery | **folded into 4** |
| — | Browser-trapped meaning | **closed by 2**, one instance |

**None of these is authorized. None is implemented.**

---

## 9. Final classification

```
SLICES 1–9 AGENT READINESS AUDIT ACCEPTED
SOURCE-TRACED
PRODUCTION COLUMN PENDING
```

Nine FIRST-LOOK rows resolved. Two capabilities reclassified C → F on traced
authority evidence, one split across its two doors. Renewals verified as a
recording gap across six search forms. Two new product rulings raised. Zero
durable structured receipts found in the leasing lane.

**No source ambiguity blocks this audit.** The two untraced items in §5 are
named, bounded, and change no classification.

The production column stays empty and cannot be filled from this environment.
