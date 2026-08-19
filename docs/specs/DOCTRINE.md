# DOCTRINE

> **Record the truth at the moment of the event, and reporting becomes a read, not a project.**

This is the line the system is built around. Everything in this repo is an
application of it. Module comment headers explain *how* each organ applies the
doctrine; this file is *what* the doctrine is. When they disagree, fix the
header — this file and the live code are the only sources of truth (Rule #11).

---

## 1. The problem

A middle-market operator — several hundred units, institutional reporting
obligations, mom-and-pop staffing — runs on five subscriptions that don't talk
to each other and a month-end *reconstruction*: a bookkeeper archaeologically
rebuilding what happened from receipts, emails, and memory, weeks after the
fact. The reconstruction is where the lag, the errors, and the
lying-by-accident live. Every input is simple individually — who changed the
toilet, payroll, leasing follow-ups, concessions — and combined they turn into
a chaotic mess.

## 2. The answer

Capture each event **once, at the moment it happens, with proof attached**.
AI structures it. The system routes it. Humans confirm the parts that matter.
At the end: a rent roll, a T-12, and every report you owe — automatically, in
real time, **queried, not produced**. The T-12 is true on the 14th of the
month at 2pm because every event already carried its proof when it happened.

## 3. Claimed vs. proven — the one epistemic rule

Every fact enters the system as a **claim**. Nothing — parse quality,
plausibility, even human approval of the parse — upgrades it to **truth**
except a structural tie a human signed.

- Revenue: parsed ≠ promoted. Supported revenue = **promoted** rent only
  (a real tie to a real unit). Everything else is held-out exposure.
- Deposits: the prior owner's claim is nothing until **cash_tie** — the
  ungameable gate. It tied to transferred cash or it didn't.
- Money: an event isn't **report_ready** until the last approver signs.
  The report is a read of approved truth, never a reconstruction.
- Identity: **name is not identity**. The registry resolves a string to one
  canonical property or surrenders it to a human. It never guesses.
- Intake: a captured field event is a claim. It becomes real only when a
  human routes it through the real endpoint from the review queue.

**AI can suggest the fact. A human / event / proof source confirms the fact.
Only confirmed facts hit reporting.** That is how we avoid month-end
reconstruction without letting AI invent truth.

## 4. Structural honesty, not policy honesty

Walls are built into the schema, not written into guidelines:

- The public parsing bench takes no propertyId and writes only to isolated
  tables — it *cannot* touch supported revenue.
- Double promotion is blocked by a DB unique constraint, not code discipline.
- Intake's routed_id is a recorded tie, not a foreign key — intake cannot
  block, cascade into, or mutate institutional tables.
- AI never moves money. No auto-approve. Unconfirmed money stays quarantined.

Policy honesty depends on people remembering. Structural honesty survives
turnover, bad days, and future contributors. **No fake numbers — ever.**
Render every step; populate only earned facts; mark everything else visibly
pending. The dashboard must be incapable of flattery.

## 5. The capture standard

> If capturing the event is harder than texting a photo, people will batch it
> later. If they batch it later, we are back to reconstruction.

So: **capture through the channel people already use. Structure in the
background. Escalate only the missing proof. Report by query.**

- Text a photo. Forward a receipt. Send a voice note. Reply to a prompt.
  Upload a rent roll. The app sits *behind* the behavior people already do.
- The user never thinks in chart-of-accounts, lender reporting, or proof
  trails. They just say what happened.
- **One question per event, maximum** — the single highest-value missing
  proof ("Was this tenant-caused?"). Everything else AI is unsure about goes
  silently to the review queue. The field gets one tap; the back office
  absorbs the ambiguity.
- The confirmation reply is also the receipt: fast, plain, done. The reply
  itself — timestamped, attributed, photo attached — is the audit log.

## 6. The three doors

1. **Shared upload link** — rent rolls, invoices, bank statements, leases.
   For owners, managers, bookkeepers, outside testers. (The parsing bench.)
2. **Text / email intake** — field events, receipts, work orders, photos,
   quick confirmations. (intake.js.)
3. **Internal review queue** — the system shows what it thinks happened; a
   human confirms, corrects, routes, or promotes. (Candidate queues, the
   attention queue, the intake review page.)

Frontline dead simple; institutional proof trail underneath.

## 7. Each deal is its own truth boundary

Facts resolve at the property / unit / event level, because that is how the
buyer's capital is structured — each deal has its own entity, lender, LPs,
waterfall. Per-deal reporting is the obligation. Portfolio visibility is a
roll-up *read* across deals — a convenience, never a consolidation that blurs
them.

## 8. Architecture rules

- Every module is an isolated organ: a factory taking injected deps
  (`module({ pool, ... })` → Express Router), mounted in one line, unable to
  reach into another organ's tables.
- The registry's resolver is the ONE identity path. No module reimplements
  matching.
- Migrations are numbered, idempotent, ledger-recorded, applied on deploy.
- **Rule #11:** read the real GitHub file before building. Never trust a
  handoff — or this file's memory of the code — over the live file. A
  "deployed" claim is unsupported until tied to a commit.
- **Rule #12:** existing mechanism first. Before declaring a capability
  missing or designing its replacement, recover the intended operator
  experience, inspect the current mechanism and its relevant history, explain
  exactly why it stops, and name what survives. Absence at the current call
  site is not proof that the product never solved the problem.

## 9. Anti-drift — intention before implementation

> **Never design from the gap outward until we have designed from product
> intention inward.**

Property Spine exists to collapse seams, preserve context, and keep work and
truth in one operating system. A technically plausible solution can therefore
be wrong even when every local service is clean. If it sends the operator into
another operating surface, asks them to re-enter something Spine already knows,
creates another workflow owner or source of truth, or forces Spine to reconstruct
what happened later, it is presumptively drifting away from the product.

Before a meaningful build, produce this receipt:

```text
INTENTION
What should the operator experience? What product boundary must remain true?

CURRENT MECHANISM
What current source, schema, runtime, UI call sites and tests already exist?

HISTORY
What relevant mechanism existed before, and why was it changed, retired or
narrowed?

CLASSIFICATION
Is the capability live, dormant, partial, deliberately retired, wrong, or
genuinely missing?

STOP REASON
At what exact point does the existing mechanism stop, and why?

PRESERVE
Which durable primitives and canonical owners survive the correction?

MISSING PIECE
Only now: what is the smallest new work required to complete the intended path?
```

Current source and runtime answer **what is true now**. Repository history
answers **why we got here**. Handoffs and memory are navigation aids, not
substitutes for either. A retired path is not automatically a rejected product
idea; sometimes one false premise was removed while the useful mechanism around
it remains the right mechanism.

The search is not archaeology for its own sake. Stop once the chain can be
stated plainly:

```text
intent → existing mechanism → why it stops → what survives → actual missing piece
```

Then continue building depth-first.

Before accepting any proposal, ask:

```text
Does this make a person leave Spine to do ordinary work?
Does it ask them to re-enter a fact Spine already holds?
Does it create another operating workflow or source of truth?
Does Spine have to reconstruct the event afterward?
Does it replace a durable primitive without evidence that the primitive is wrong?
```

If any answer is yes, stop and require an explicit product ruling before
building. "Conventional software does it this way" is not evidence. Familiar
vendor architecture is especially dangerous when it recreates the exact seams
Property Spine exists to remove.
