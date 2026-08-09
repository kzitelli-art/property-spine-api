# After Release 0 — reporting research, not the roadmap

> **This spike does not choose the next build.** The official next direction is the
> governed read/intelligence layer over canonical operating truth — **Build 1**, see
> `docs/BUILD_1_FIRST_CAPABILITY.md`. What follows is useful input to that build and
> a record of what reporting will eventually need. Nothing here is scheduled.

**Status: read-only intelligence.** Nothing here is built. Release 0 is
build-complete and rehearsed; this is groundwork gathered before any design
argument, so the argument starts from measurement.

```bash
DATABASE_URL='…' node tools/next/reporting_readiness_intelligence.js
DATABASE_URL='…' node tools/next/reporting_readiness_intelligence.js --json
```

Read-only by construction — `BEGIN TRANSACTION READ ONLY`, rolled back. Same
discipline as the preflight and the acceptance receipt.

---

## The finding

The North Star is *"record the truth at the moment of work, so reporting becomes a
read, not a reconstruction,"* and the deliverable is the monthly investor & lender
package (§16).

Release 0 produced the system's **first fully governed operational fact**:
maintenance work-order completion, written by one canonical writer, backed by
evidence that is frozen the moment it is cited, enforced at commit by the database.

**`src/money/reporting.js` does not read it. There is no maintenance section at
all.**

That is not a defect in Release 0 or in reporting — the two were built in different
passes. It is the obvious next seam, and it is worth naming plainly: *we now record
the truth about maintenance work and do not yet report it.*

The reporting module already carries exactly the right shape for one. Every section
reports `{ status: 'proven' | 'pending', value, reason, owner }` and never a fake
zero. A maintenance section would be **additive, not a rewrite**.

---

## What Release 0 made readable, claim by claim

Three verdicts, measured rather than assumed. `READABLE` means a governed writer
records it and reporting is a SELECT. `RECONSTRUCTED` means derivable only by
inferring across ungoverned data — shipping one of those as a proven number is
exactly what §5 forbids. `NOT AVAILABLE` means the package must show it blank, with
a reason.

| | claim | verdict |
|---|---|---|
| **M1** | N work orders completed this period, each backed by evidence | **READABLE** (after activation; before it the reader says `unavailable`, correctly) |
| **M2** | …and here is the evidence behind each one | **READABLE** — cited evidence is frozen (R0005), so what the report shows is what the completion rested on |
| **M3** | work completed *before* the cutover | **READABLE, AND MUST BE LABELLED** `legacy_indeterminate` |
| **M4** | M work orders still open | **READABLE, NOT PROOF-BACKED** — `status='open'` has no governed writer |
| **M5** | what the work **cost** | **NOT AVAILABLE** |
| **M6** | who pays (owner vs resident) | **READABLE, WITH A CAVEAT** — a billback *decision* is not a *cost* |
| **M7** | who did the work | **READABLE** for who claimed it; **RECONSTRUCTED** for who performed it |
| **M8** | how long it took | **RECONSTRUCTED** — no governed "work started" fact |
| **M9** | completions the system cannot stand behind | **READABLE** — one audit view, same SQL function as the guard |
| **M10** | a month-end GENERATE that is a read | **PARTIAL** — see M5 |

### M5 is the load-bearing gap

`money_events` has **no `work_order_id`**. It links to obligations and assignments
instead. Cost per work order could only be produced by matching vendor, date and
description — a reconstruction, and *a plausible wrong number in a lender package is
the worst possible output*.

So today a maintenance section could prove **that the work happened and was
evidenced**, but not **what it cost** — and a lender package is largely about cost.

A governed spend↔work-order link is therefore the highest-value next rung: it is
what turns *"we did the work"* into *"we did the work, and here is what it cost,
and here is the photograph."*

### M3 is a doctrinal requirement, not a display preference

Pre-cutover completions read `legacy_indeterminate` — neither proven nor failed. A
reporting package that folded them into the completed count would be claiming proof
that was never captured. Release 0 spent its entire length drawing that line; the
next build inherits it.

### M9 inherits the sweep ruling unchanged

A non-empty invariant audit is a **system-integrity event, not a new human
accountability category**. That ruling is already settled and applies here without
re-argument.

---

## Rulings — SETTLED 2026-08-08

These were open when this document was written. They are now decided. They are
recorded here as constraints on any future build, not as opinions.

### R1 · Maintenance may report governed operational completion before cost is linked

**But it must not imply financially complete maintenance reporting.** The section
reports *operational* completion — work happened, here is the evidence. It may not
be headed, labelled or summarised in a way that a reader would take as maintenance
*spend*. M5 stays blank with its reason, and the section's own framing has to carry
the distinction, not a footnote.

### R2 · Three timings, all preserved, never collapsed

```text
operating period    = COMPLETION OCCURRENCE    ← what period the work belongs to
proof timing        = evaluation / recorded instant
package timing      = report month (output)
```

They disagree at month boundaries and that is the point. Work completed on the 31st
and evaluated on the 1st belongs to the earlier operating period, carries the later
proof instant, and may appear in either package month. **Collapsing any two of them
into one column is forbidden** — that is how a reporting system starts
reconstructing instead of reading.

### R3 · `legacy_indeterminate` is an operator/internal truth state

It may appear on operator surfaces. It may **never** be silently counted as proven
in anything external. If pre-cutover history materially matters to an external
package, it is described as **pre-cutover / unverified history** — the external
document does not carry our internal state name. Exposing the enum outward would
leak an implementation vocabulary into a lender's hands and invite them to interpret
it; describing it plainly does not.

### R4 · M5 is parked as the bridge into the money layer

Real and important, and **not** the next build. This document is research input, not
a roadmap decision — a reporting spike does not get to choose what gets built. The
official next direction is the **governed read/intelligence layer over canonical
operating truth** (Build 1). M5 is where that layer will eventually meet money, and
it waits there.

---

## What this branch deliberately does NOT contain

No migration, no writer, no route, no schema change, no reporting section. One
read-only tool and this document. The intelligence comes first, exactly as
instructed, so the design conversation starts from what is actually true in the
database rather than from what any of us remember being true.
