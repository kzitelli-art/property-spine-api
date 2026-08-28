# Technician lifecycle — PROOF RECEIPT

**Status: PROVEN against real PostgreSQL 16.13 and real HTTP.**
Not merged, not deployed, not production-active.

| Harness | Result | Exit |
|---|---|---|
| `technician_lifecycle_proof.db.js` — **real HTTP + real DB** | **51/51** | 0 |
| `technician_route_proof.db.js` | **48/48** | 0 |
| `technician_acceptance.db.js` | **32/32** | 0 |
| `operations_reply_policy.db.js` | **32/32** | 0 |
| `communication_lines_slice_a.db.js` | **61/61** | 0 |
| `property_line_hardening.db.js` · `migration_ledger_inverse_gate.db.js` | 41/41 · 24/24 | 0 |
| `npm run verify` (**7** source gates) | PASS | 0 |

Migrations claimed: **131, 132, 133, 134** — 134 verified free across every remote branch.

---

## 1. The test that matters

> Could a good maintenance technician use this immediately, with no training,
> by texting exactly as they already text today?

This is the transcript the harness produced, through the real Express route
against real PostgreSQL. Not a mock-up — it is printed by the proof run.

```
TECH   Got it.
SPINE  Accepted. The Unit 302 sink leak is now yours and in progress.

TECH   I'm heading over.
SPINE  Got it — you're on the way to the Unit 302 sink leak.
       I'll keep it open until you tell me how it went.

TECH   Couldn't get in.
SPINE  Recorded no access on the Unit 302 sink leak. The work stays open,
       and access follow-up is now needed. The resident will be asked to
       coordinate entry.

TECH   the leak is stopped but it needs a valve
SPINE  Saved to the Unit 302 sink leak: the leak is stopped but it needs a valve

TECH   All done.
SPINE  I recorded that you finished the Unit 302 sink leak, but I still need
       a photo of the repair before I can close it.

TECH   here you go  [photo]
SPINE  I got your photo on the Unit 302 sink leak but couldn't save it.
       Please send it once more.

TECH   All done.
SPINE  I recorded that you finished the Unit 302 sink leak, but the photo
       didn't save, so I can't close it yet. One more photo of the repair
       will do it.

TECH   try again  [photo]
SPINE  Photo saved to the Unit 302 sink leak.

TECH   All done.
SPINE  Done — the Unit 302 sink leak is closed. The resident will be
       notified the repair is complete.

TECH   anything else open here?
SPINE  You have one thing open:
       • Unit 302 no heat

TECH   omw
SPINE  Got it — you're on the way to the Unit 302 no heat.
       I'll keep it open until you tell me how it went.
```

**Not one message in that transcript is a command.** No work-order number was
typed after the first turn; no status word, no syntax, no reference. Every reply
names the work the way the technician would name it, and none exposes a uuid, a
status, a constraint, a migration number or a routing term — asserted over every
reply the run produced.

And on the resident's line, from the property-facing number:

```
Your technician is on the way for the sink leak.
The technician could not access the unit. Please reply with the best way to coordinate entry.
The repair has been completed.
Your technician is on the way for the no heat.
```

---

## 2. Photos — I inspected the existing rail first, and did not reuse it

`work_proof_attachments` (migration 118) exists, with a service and its own
proof. **It is not reused, for a structural reason:**

- its central guarantee is the composite key
  `(work_id, property_id, unit_id) → unit_triage_required_work` — a *different
  parent object*, the unit-turn rail, not the maintenance work-order rail;
- `unit_id` is `NOT NULL` there, and a maintenance work order legitimately has
  no unit (a boiler, a roof, a parking gate);
- making it polymorphic would mean dropping that composite key, which is the one
  thing that makes "borrow one photo to close three other jobs" unrepresentable.

So `work_order_proof_attachments` is a **sibling on the same contract** — same
Class 1 / Class 2 split, same digest rule, same size-matches-bytes rule, same
scope-is-one-fact composite key — carrying the five things 118 has no need for
because it receives a browser upload and this receives a carrier's MMS: the
source communication event, the provider's own attachment identity, received
time as distinct from stored time, the durable-storage state, and the proof
classification.

**A provider URL is not proof.** A row starts `referenced` — a photo exists and
we have *not* preserved it. Only `stored` carries content, size, digest and
`stored_at`, and `ck_wopa_stored_is_complete` makes a partially-stored row
unexpressable. A fetch that fails leaves `fetch_failed`, which is visible,
counts as nothing, and produces a different sentence to the technician
("couldn't save it") than having sent nothing at all.

**A photo is not completion.** `completion_claimed` and `completed` are two
rows written by two decisions. The claim is *always* recorded; whether the work
order closes is decided against evidence that actually exists — proven three
times in the transcript above, including the case where a photo arrived and
could not be preserved.

---

## 3. Resident updates — derived, never forwarded

```
technician action commits → canonical progress row exists
  → resident-safe text DERIVED from that row
  → intent attached to the RESIDENT conversation
  → property-facing line sends it
  → delivery recorded separately
```

`resident_update.js` **does not accept the technician's note.** There is no
parameter through which their language could travel, so "we forwarded the raw
text" is not a mistake that can be made. Proven: no resident message contains
`valve`, `couldn't` or `all done`, and no resident message is attached to a
staff thread — `ck_comm_derived_is_resident_facing` refuses it at the database.

Resident-safe by default is **nothing**: only `en_route`, `no_access` and
`completed` are on the list. `blocked` and `finding` stay internal, so a verb
added later cannot accidentally start texting residents.

"The repair has been completed" requires the work order to actually be complete
— checked against the row, in addition to the fact that only the governed
service writes a `completed` progress row. Two independent reasons, neither
relying on the other.

---

## 4. ⚠ Three defects this round found in my own work

**1. "I've let the resident know" was a delivery claim inside an operating
receipt.** I wrote it into the no-access reply — the exact collapse the receipt
seams exist to prevent. An operating receipt cannot know a text arrived. It now
says "The resident will be asked to coordinate entry", and only when the update
intent was actually committed.

**2. A photo with a bare caption was recorded as a finding.** "here you go" +
photo produced *"Saved to the Unit 302 sink leak: here you go"* — which tells a
technician nothing about whether their proof landed. Evidence-only messages now
produce an evidence receipt.

**3. My own harness read the wrong line.** After resident updates started
working, `say()` returned "the last thing sent" — which was the resident's
message, not the technician's — and reported six false failures. Two lines, two
audiences, read separately now.

Also fixed, both caught by the language corpus rather than by inspection:
"waiting on **the** plumber" (an article the pattern did not allow) and
"anything else" on its own.

---

## 5. What the language layer will and will not do

`technician_language.test.js` is a corpus of real phrasings, on the standard
validation path — **77 assertions**, and it is as much about what must *not*
happen:

| Reads correctly | Never becomes an action |
|---|---|
| "Got it." · "on it" · "will do" · "mine" | "hi" · "ok" · "?" · "thanks" · "sorry" |
| "omw" · "heading there now" · "be there in 20" | "should I replace the valve?" |
| "nobody's home" · "locked out" · "no answer at the door" | "who is the resident here" |
| "need a part" · "waiting on the plumber" | "3 units affected" · "running late" |
| "all set" · "good to go" · "wrapped it up" | |

Consequence order is proven, not assumed: *"couldn't get in, heading to the next
one"* is a no-access report, not an en-route one, and *"fixed what I could but
need a part"* is blocked, not complete. Anything it cannot read confidently
comes back `unclear` and gets one short question — the fail-soft direction is
always toward asking.

**Deliberately not a model.** This layer decides what *consequential* action to
propose; a model that is usually right would sometimes close a work order
because somebody said "that's done with" about a phone call.

---

## 6. Recognition over re-entry

Spine already holds, and never asks for again: who the technician is, which
thread this is, which work order is live in it, what it last asked them, what is
already recorded, and what proof is still missing.

A reference is required only when the thread and their own assignments genuinely
cannot settle it — proven in the transcript, where every message after the first
names no work order at all. A bare "ok"/"yes" is recognised *only* as an answer
to a question Spine actually asked, never as a verb on its own.

---

## 7. Still not proven, unchanged

**The two resident SMS proofs.** They build no schema of their own and need a
full-schema copy; the chain still stops at `012_bank_intake.sql` on `yardi_code`
from empty. That remains the only outstanding proof blocker.

## 8. Before merge — unchanged, and not shortened by any of this

1. Migration **129** activation.
2. Slice A merge and **130** activation sequence.
3. Active-branch migration-number reconciliation (**131–134**).
4. The production-derived disposable full-schema database.
5. Both resident SMS proofs.
6. All lifecycle proofs re-run at the exact final SHA.
7. Rendered operator verification.
8. Controlled real-phone acceptance.

Local PostgreSQL and HTTP proofs being green does not make any of this
merge-ready or production-ready.

## 9. Next

`operator-surface visibility` — the field facts, evidence and completion state
now exist as canonical rows that no operator screen reads yet. That is the one
remaining step in the sequence, and it is a read, not a new model.
