# Property Spine — Build Handoff
## The plumbing is in. The product isn't.

Two releases shipped 2 August 2026 — an obligation security boundary, and Ask Spine Slice 1.
What exists now is a safe, proven way to ask one question. What comes next is deciding
what to say and how to say it.

```
Production API      efb8c71
Production app      5cbe948
Health              green, 9:24 PM ET
Migrations applied  none
```

---

## What is live

One authenticated endpoint answering one question from real recorded work.

**The server decides scope.** `GET /operator/ask-spine/attention` takes no parameters at
all. Property, modules and actor all come from the staff session. A client-supplied
`property_id` is refused with 403 — not ignored, because silently ignoring it would let a
caller believe it had asked about a different building.

**Ranking is recorded fact.** Four tiers, no score, no model:

```
1  overdue AND unowned
2  overdue
3  unowned
4  everything else
then soonest due first, nulls last
then id ascending  ← stability tiebreak, not priority
```

Money impact, missing proof, blockage and "someone is waiting" are deliberately absent.
No recorded fact supports them, so ranking on them would be invention.

**Failure admits failure.** The read goes through the `liveRequired` loader, never
`tryJSON` — whose empty-array fallback would turn an unreachable API into a confident
"nothing needs attention." A failed read says *"I couldn't read this property's open
work."* with a Retry. It never renders as an empty answer.

**Capped and counted honestly.** Five items maximum, enforced in SQL *and* in the service,
with `total_open` counted over the same predicate. That is where "Showing 5 of 20 open
items" comes from.

---

## What is not built

None of this was ever claimed. It is the next build.

| Missing | Reality today |
|---|---|
| **A text input** | The composer is a single chip. A recognizer exists beneath it that accepts several phrasings — **nothing can reach it**, because there is no field to type into. |
| **Interpretation** | No model, no intent parsing, no dataset. One recognized question. |
| **Conversation** | No thread, no follow-up, no memory of the previous answer. |
| **Writing** | Read-only. No proposals, no confirmations, and the question is not recorded as an agent message. |
| **Breadth** | Open obligations, one property. Nothing about money, tenants, documents or reporting. |

---

## Slice 2 — the questions to answer first

These are design decisions, not engineering ones. Answer them before any code.

**1. What does it say when it doesn't know?**
This is most of the work. A box that looks like a chat invites anything; Slice 1 answers
exactly one question. The honest floor today is a fixed sentence. The alternative is a real
interpreter — a different project with a different risk profile.

**2. Prose or cards?**
"You've got 20 open items, 5 overdue and unowned — the oldest is a tour follow-up from
Jul 25" reads better than a table. But every clause has to be a recorded fact, not a
generated sentence. That line is the one worth holding.

**3. Does it hold a thread?**
"What about maintenance?" after the first answer is conversation. One question with a text
box is still one question.

> **Why the plumbing matters here.** Server-derived scope, ranked recorded facts and an
> honest failure state are what make a conversational surface safe to build rather than
> dangerous. A composer on top of a loose read invents answers. A composer on top of this
> one can only say what was recorded.

---

## How today went

Order mattered. The security boundary had to land before anything was built on top of it.

```
2:01 PM   Obligation security, window 1 — app merged first, by design
2:06 PM   ABORTED at the first gate. A failed read rendered "Nothing needs you
          right now." — the exact lie the release existed to prevent
2:05 PM   Rolled back in four minutes. API never merged, no production writes
3:30 PM   Window 2, after repairing all eight obligation consumers.
          Mismatch check passed: honest "unavailable", not empty
3:33 PM   Security gate closed. Deployed boundary proof 10/10 + execution floor
9:25 PM   Ask Spine deployed onto the secured main — API first, app second
```

---

## Two defects worth remembering

Both were older than the work that exposed them. Neither was found by reading code.

**The false empty predated the fix.** Production had *always* rendered a confident empty on
a failed obligations read. The migration made the loader honest; two callers re-created the
swallow one layer up, where a browser check could finally catch it.

**"My Work" could never show a row.** `items.map(row)` where the function was named
`obRow`. It threw `ReferenceError` the instant it had anything to display, and an empty
`catch` swallowed it. The surface could only ever show the empty line, or nothing.

---

## Proof at deploy

| Rung | Result |
|---|---|
| Contract | 31 / 0 |
| Real Postgres | 23 / 0 |
| Real HTTP | 27 / 0 |
| Browser states | 27 / 0 |
| Desktop, API-backed | 11 / 0 |
| Phone, API-backed | 11 / 0 |
| Real outage | 8 / 0 |
| Visual repair | 24 / 0 |
| App suite | 749 / 0 |

**Security regressions:** obligation boundary 21/0 · canonical completion 12/0 ·
failure-state browser 61/0 · security browser 25/0 · deployed boundary 10/10 + floor.

Real Postgres, real staff sessions, real HTTPS, no interception on the live path.
Cross-property leakage, module entitlement in both directions, and revoked-assignment
lockout are each proven by **absence in a real response**, not by asserting the gate exists.

---

## Evidence gaps — stated, not glossed

Two acceptance checks were **not** completed on the deployed surface:

- Ask Spine request headers (staff session present, operator key absent, no `property_id`)
- one click-through from a result to the underlying record

Both are proven in the harnesses against this exact artifact. Neither was re-verified in
production. Recorded as a gap, not as a pass.

---

## Carried forward

Each has an owner. None blocks Slice 2.

| Item | Owner |
|---|---|
| Conversational composer — input, prose vs cards, thread, unknown-question behaviour | **Slice 2** |
| Leasing-task reassignment smoke `5b` — HTTP 400, `convOwner=true` | Separate lane |
| Obligations "unavailable" banner still shows developer language | UI follow-up |
| Claim button gates on the retired User ID field — visibility only, no authority | UI follow-up |
| Migration `121` — branch-only migration live in production, inert | Baseline lane |
| `deployment.md` teaches the false-green migration pattern | Baseline lane |
| Migration chain cannot rebuild from an empty database (`012`) | Baseline lane |

---

*Receipt: packet `6481153` on `claude/security-release-launch-packet` — full timeline of
both windows, the abort and rollback, the eight-consumer audit, and every proof count.*
