# Property Spine — Release 0 status

**2026-08-09 · canonical status record**

---

## Headline

**The first governed work-order completions now exist in production.** Two of
them, with real evidence behind them, recorded at the moment of work.

**This is not "Release 0 is live."** The **writer rail** is live and Boundary 5 is
passed. The **canonical read and activation regime is not deployed** — and that
distinction is load-bearing, because production currently contains the exact
writer/reader disagreement described below.

The distinction this release exists to make is now a fact rather than an
argument. The path being retired wrote `status='closed'` with a `stub://` string
in a column — no bytes, no digest, no evaluation, no attributable actor. The new
path produced 887KB of real JPEG with SHA-256 digests, an evaluation deriving
`satisfied` *from* that evidence, and the completion claim recorded separately
from the completion itself.

---

## What was proven, and how

Two production runs, deliberately kept apart so neither borrows the other's
conclusion.

**WO 1008 — writer proof.** Real handset, real MMS, two photos preserved.
Official 12-check receipt: `completion_writer_proof: PASS`. **Assignment was
staged by hand**, so this proves the writer, transport and evidence path — not
the operational rail.

**WO 1009 — rail proof.** Nothing staged. Work order created through the
canonical service (obligation born unassigned) → assigned through the app's
picker by an authenticated operator → technician saw it over SMS by asking →
completed from a handset with a photo. Official receipt: **PASS**. Identity
chain verified from persisted rows: assignee, completion claimant and completer
are **one continuous human**.

**That second receipt is what discharges Boundary 5**, and it is the strategic
result in this document — not the photographs.

> **WO 1009 proves the replacement operating rail without borrowing eligibility
> from SQL.** Everything before it proved components. 1009 proves a human can
> enter through the normal system, take responsibility for the work, perform it
> from the handset, produce governed evidence, and create the completion fact.

---

## Where the release stands

```text
4    transport                CLEARED    A2P verified, operations line live
5    handset completion       PASSED     WO 1009, nothing staged
6    app completion control   ELIGIBLE   candidate prepared, held
7    legacy done-path closed  next
7b   migration 140 guard      next
8    census + activation      after a fresh census
9-13 reader, sweep, cleanup   after 8
```

### The activation population

**Latest production census: one explainable pre-cutover terminal row,
`POPULATION_NOT_EXPLAINABLE = 0`.** Production holds 8 work orders; exactly one
predates the cutover unevaluated, and it is explainable.

⚠ **That is a measurement at a point in time, not authorization.** Until
Boundary 7 closes the legacy done-path, the population can still change — any
open work order can still be closed by the retired writer. **A fresh census
immediately before activation remains mandatory.** This record must never be
read as permission to reuse an old one.

The item flagged as highest-variance and least rehearsable currently measures as
a single grandfathered record.

---

## The most consequential finding

A proof defect, caught before it could do damage.

One of the twelve Step 4 checks compared the proof's evidence vocabulary against
a **reader that belongs to a later boundary and has not deployed**. Run against
production, it would have failed a genuinely valid completion — and the
temptation would have been to record the red as "expected."

It was corrected at the root rather than waived: the check now takes its
vocabulary from the **deployed writer's own gate**, the predicate
`claimCompletion` actually consulted. The reader question moved into its own
conclusion, reported as `DEFERRED` until the boundary that owns it ships.

```text
completion_writer_proof   PASS       persisted production facts only
reader_source_alignment   DEFERRED   becomes required at Boundary 9
```

### ⚠ Boundary 9 is a restoration of meaning, not a read-layer deployment

The correction surfaced a live production disagreement:

```text
deployed WRITER   ["repair_photo", "condition"]                 refuses unclassified
deployed READER   ["repair_photo", "condition", "unclassified"] would render it as proof
```

**Until the reader is narrowed, the writer and the reader disagree about what
proof means.** Boundary 9 must be treated as restoring one meaning across the
system — not as shipping a UI or read layer. Scheduling it as cosmetic cleanup
would leave two definitions of proof running in production.

---

## Four operational gaps — logged, not fixed

**1 · Assignment is silent.** The operations line is `reply_only` by database
constraint, so nothing can tell a technician they have work. They find out by
asking. A system that only answers when spoken to is a lookup, not a
conversation. Closing this needs its own governed notification rail — bound to a
durable operating fact naming the recipient, so directed notice becomes
expressible while broadcast stays impossible.

**2 · A control collision on `SMS_SEND_MODE`.** One configuration variable is
doing two unrelated jobs. Traced path, measured in source:

```text
POST /auth/sms/start
  -> sendPropertySms(purpose: "staff_otp")      teamaccess.js:282
  -> canSendSmsForRecord
  -> mode === "disabled"  ->  refuse ALL        send_mode_disabled
```

`staff_otp` is in `CREDENTIAL_PURPOSES`, and the `disabled` branch refuses every
purpose before that distinction is reached. So the same switch that darkens
resident outbound also blocks the staff sign-in code on this path. Observed
live: staff sign-in failed under `SMS_SEND_MODE=disabled` and recovered under
`proof_only` + `SMS_ALLOW_CREDENTIAL_SENDS=1`.

The setting reads as "stop texting residents" and, on this path, also means
"nobody receives a sign-in code." Resident safety and staff authentication
should not share one switch.

**3 · The work-order board hides work order numbers.** People discuss jobs by
number across text, phone, Ask Spine and the app; the number is not on the
screen. Rows are also individually shaped — owner, acceptance, progress and
completion each occupy the same slot in different rows — so the list cannot be
scanned.

**4 · Acceptance is narrated but not required.** The board says "waiting for X
to accept"; completion proceeds without it. WO 1009 completed with
`accepted_by_user_id` null.

None blocks Release 0. All are real.

---

## Assessment

The remaining work is a rehearsed production sequence, not discovery. Every
semantic question of the last two days resolved by measurement rather than
argument — and in four separate cases a plausible-looking check would have let
the wrong thing through. The gates caught each one.

**Release 0 is an execution problem.** The sequence is fixed:

```text
6 -> 7 -> 7b -> fresh census -> 8 -> 9-13
```

with a receipt at each irreversible or semantics-changing boundary, and no
further architecture.
