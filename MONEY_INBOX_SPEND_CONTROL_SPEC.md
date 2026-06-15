# PROPERTY SPINE — MONEY INBOX & SPEND CONTROL

## North-Star Architecture Spec (frozen for FIRST BUILD SLICE — Jun 15 2026)

*The authoritative design for the real-time money layer. Whoever builds this
— next session, or the dev — builds THIS. Derived over a full design
conversation; do not re-derive. Supersedes the parked ACCOUNTING_v0_REFRAME.md
as the live direction for money capture.*

**On “frozen”:** the PHILOSOPHY is locked. The DETAILS are expected to change
once real transactions hit — that’s the point of building a slice. “Frozen for
first build slice” means the dev treats the philosophy as the contract and the
specifics as hypotheses to test, not that deviations are failures.

-----

## SCOPE WALL — REVENUE/PAYMENTS IS DELIBERATELY OUT

**Money Inbox watches money LEAVING (the spend side). It is NOT the revenue
ledger.** Plaid sees the whole account, including money coming in — rent
deposits, processor payouts, returns — and the natural drift is to start
classifying those here. Do not.

- Rent collection, payment returns, security deposits, and processor payouts
  belong to the **revenue / payment ledger path** (the charges/payments
  modules, the `payment_return` exception class, the FBO/KeyBank cash-proof
  work on 4233).
- **Operating truth for revenue starts at the lease / payment processor** (who
  owes what, what was charged, what cleared) — NOT at the bank. Plaid may
  *confirm* the cash landed, but that is downstream of the processor’s truth.
- This is an architectural wall, not a parking lot. It keeps two different
  truth sources (spend vs revenue) from bleeding into each other.

-----

## THE ONE-LINE THESIS

**Money Inbox captures operational truth in plain English. Spend Control
questions recurring spend. Accounting happens invisibly behind the scenes.
Reporting reads from all of it in real time.**

The field person records what is *true* about a charge. The general ledger is
a *byproduct* of that truth, produced by the backend — never something a
human types. This is the Spine thesis (“record the truth at the moment of the
event; reporting is a read, not a project”) applied to money movement.

-----

## WHY TWO LAYERS (the core insight)

These are **two products with opposite logic**, sharing one data substrate.
They are NOT one queue with filters — building them as one forces a bad
choice on the recurring-but-watched case (PECO every month).

### Layer 1 — MONEY INBOX  →  *“What is this money movement?”*

- **Event-driven.** A charge happens; the question fires once, at that moment.
- Per-charge. Resolves in **zero-to-one tap.**
- Recurring/known charges **auto-classify silently — no task created.**
- Output: operational truth (purpose + owner), which the backend translates
  to accounting privately.

### Layer 2 — SPEND CONTROL / WASTE FINDER  →  *“Should this money still be moving?”*

- **Pattern-driven.** Triggered by a pattern over time, a comparison against a
  baseline/budget, or the *absence* of an expected stop — never by a single
  event.
- Per **recurring relationship**, not per charge.
- Asks the questions that only exist over time: is the amount normal, is this
  vendor still expected, is this still needed, who owns this standing spend,
  has it been replaced.
- Output: an exception/accountability queue with its own status vocabulary.

**The labor model that ties them together:**

> Humans do NOT categorize the obvious. Humans review uncertainty, variance,
> and waste.

A near-empty Money Inbox is the GOAL, not a failure. Empty means everything
recurring is behaving and nothing has drifted. The recurring known stuff is
invisible until it misbehaves — at which point Spend Control surfaces it.

**The PECO proof of the split:** one PECO charge generates ZERO Money Inbox
work (recurring, known, auto-classified) but IS the input to Spend Control’s
variance check. Same charge, two completely different relationships to it.

-----

## THE FIVE CONCEPTS (kept architecturally separate)

|Concept                                                |Layer        |Behavior                                  |
|-------------------------------------------------------|-------------|------------------------------------------|
|**Categorization** — what is it?                       |Money Inbox  |Auto where known; one tap where not       |
|**Confirmation / accountability** — who says it’s real?|Money Inbox  |The tap, by the responsible role          |
|**Variance** — is the amount/timing abnormal?          |Spend Control|Compare to vendor history + budget        |
|**Waste review** — should we pay this at all?          |Spend Control|Subscription/obsolescence/duplicate review|
|**Accounting translation** — truth → books             |Backend      |Invisible to both; never user-facing      |

-----

## USER-FACING PRINCIPLE: EXPANSIVE TAXONOMY, SIMPLE CAPTURE

The buckets are **institutional-grade** (drawn from the most detailed
P&L / monthly-reporting lines): HVAC, plumbing, electrical, appliances, turns,
cleaning, pest control, landscaping, utilities, leasing, admin, insurance,
legal, capex, reimbursables, etc. The depth is real and load-bearing for
reporting.

But the **richness lives in the structure, not in the user’s face.** Vendor
history collapses 40 buckets down to the 1–2 the system already thinks are
right. The user never browses accounting categories or GL codes.

**The user path feels like:**

> Home Depot — likely plumbing / general supplies for Solo. Confirm?

Tap yes. Or quick-edit from a SHORT relevant list:

> plumbing  ·  turn  ·  appliance  ·  general supplies

**Hard rules:**

- **No GL codes in the user workflow. No accounting language** — not for
  maintenance, not for managers, ideally not even accounting except in
  setup/review mode.
- Backend holds a **private map: plain-English purpose bucket → GL / reporting
  category / journal logic.** PecoEnergy still becomes 6201 Electric — the
  *person* sees “utilities for 4125,” and 6201 happens where they never see it.
- **Don’t force fake precision.** A $480 Home Depot run defaults to “general
  supplies for the property/week” — one tap, no split math. Fake precision is
  its own kind of lie: a split claiming “$23.14 to unit 4B” when it was really
  a mixed cart is LESS true than “general supplies,” not more. (This is the
  gross-never-net rule in different clothes.)
- **Opt-in precision only when material:** unit / project / work-order when
  obvious; specific-item allocation only when there’s a big obvious item inside
  (e.g. a $260 plumbing part for a specific issue inside a larger run).
- **Splits only when necessary.**

**Engineering consequence:** the taxonomy depth is **seed DATA tables, not
UI.** The first slice carries NO category-admin screen — just the seeded
buckets table, the private bucket→GL map, the vendor→bucket history, and a
dead-simple capture (suggested bucket + confirm + short quick-edit). The rich
category-management UI is a later concern the architecture must not foreclose.

-----

## ROUTING: PROPERTY + ROLE (roles ARE the routing table)

> Charge hits → Plaid shows it pending same-day → property/entity resolves from
> bank account/card → role resolves from the property org chart → assigned
> person gets the tap → purpose bucket prefilled from vendor history → person
> confirms or edits → caps decide whether it clears or escalates → posted
> transaction inherits the confirmation later.

- **Property** is known from the bank account / card (Plaid → account → property).
- **Role** comes from the **`assignments` table (migration 004)** — the
  per-property org chart with a fixed role vocabulary
  (`property_manager`, `maintenance`, `leasing`, `bookkeeper`, `asset_manager`,
  `owner`). Category implies role; role resolves to the active person.
- **Caps and escalation are ALREADY in that table:** `spend_cap`,
  `approval_cap`, and `escalates_to_assignment_id`. A small charge clears at the
  role’s cap with one tap; a large one exceeds it and escalates up the pointer.
  The accountability ladder is half-built into the org chart already.
- **The named person and the cap both FALL OUT of the assignment** — no separate
  “who swiped the card” signal is required. The role is the answer.

**This is why keeping roles current is the operational precondition (below).**

-----

## PLAID MECHANICS: PENDING = DAY ZERO, ONE TOUCH

- Plaid surfaces a charge in two stages: **`pending`** (often same-day, the
  moment the card network sees the swipe) and **`posted`** (1–3 days later).
- `/transactions/sync` **already returns pending transactions** in the `added`
  array, each with `pending: true` and a `pending_transaction_id` linking to the
  posted version when it lands.
- **The design:** the person confirms the **pending** charge on day zero, while
  memory is fresh. When the posted version lands days later, the system
  **matches it to the already-confirmed pending item via `pending_transaction_id`
  and carries the confirmation forward. No second click.**
- **Pending and posted are ONE inbox item, never two.** The queue keys on the
  pending↔posted link, not only on the natural key. This is the difference
  between people trusting this and people cursing it.
- ⚠️ This is a more careful build than the currently-deployed `plaid.js` sync
  (which just inserts everything). The pending/posted match is real new logic
  the first slice must add.

-----

## AMAZON IS A SPECIAL CLASS: ORDER REVIEW, NOT TRANSACTION REVIEW

The structural mismatch: **one bank charge ≠ one order, and one order ≠ one
shipment.** Amazon bills when things ship, so a $340 order can post as
$120 + $95 + $125 over four days, and the bank string is just “AMZN Mktp.”
Reverse-engineering purpose from the *charge* is hopeless.

**Right model (flows the other direction):**

> Amazon order / import / receipt → identify meaningful items → user confirms
> purpose buckets / splits **against the order** → Plaid charges reconcile to the
> order later as they post in pieces.

NOT: *Plaid Amazon charge → guess what was inside.*

- The **order** is the unit of truth (it has line items; it knows what was
  bought). This is the same pending/posted-match machinery pointed at a
  different anchor — match charges to an **order**, not to each other.
- **Katie’s Amazon order originates in the maintenance module** as a supply
  request, and becomes *evidence* when the charge lands — the allocation exists
  BEFORE the charge does. That’s the cleanest version of the hard case.
- **Dependency:** this needs order data ingested (import / email-receipt parse /
  connected account) — a separate rung. The schema must leave the door open
  (a charge can belong to an order; an order carries its own purpose/splits).
- **First-slice behavior:** an un-reconciled Amazon charge lands in the inbox
  flagged **“Amazon — needs order review”** and waits. No guessing. Honest blank
  over confident wrong.

-----

## EXCEPTION CLASSES (what pulls a charge out of the one-tap path)

1. **Uncertainty** — system can’t confidently suggest a bucket → human reviews.
1. **Split needed** — genuinely multi-property charge → split screen that must
   **sum to the transaction total to the cent**, or it’s refused (parts equal
   the whole or nothing writes — the same-dollar-never-twice discipline).
1. **Wrong-entity card charge → flagged reimbursable / cross-entity mess.**
   When the Virtus card pays for a property because that property has no card,
   it’s a reimbursable. The system FLAGS it the day it happens (not normalized
   as clean). **The real fix is operational, not code: each SPE needs its OWN
   debit card — this is the closed-loop precondition.** The system makes the
   mess visible; it does not bless it.
1. **Amazon / order review** — see above.

-----

## REUSE: THE OBLIGATION ENGINE ALREADY DOES THE HARD PART

`money.js` (~line 246) **already** spawns a role-assigned obligation, with
`required_inputs` as proof and `escalates_to_role` for the cap ladder, when a
manual money-out event needs explaining — label literally *“Explain a $X
expense — vendor.”* It routes by `assigned_role`. **That is the Money Inbox’s
confirm-and-route mechanic, already live for manually-captured spend.**

So Money Inbox is largely REUSE, not new routing:

- Born through the shared **`spawnObligationFromEvent(client, spec)`**
  (server.js ~line 107) — the single obligation-creation path the whole system
  uses (leasing tours, collections, maintenance emergencies). spec carries
  `property_id, person_id, assigned_role, escalates_to_role, required_inputs, related_id/related_type`, etc.
- **The genuinely-new parts shrink to:** (a) Plaid charge → spawn the obligation
  (instead of a manual capture); (b) the pending/posted match; (c) the
  bucket suggestion from vendor history; (d) the inbox read surface + one-tap
  confirm; (e) the exception flags.

Everything about *who gets asked and how it escalates* is reuse. This is the
“one obligation engine, born from events” architecture paying off.

-----

## DATA SUBSTRATE (shared)

Both layers read the same **`bank_transactions`** claim table (migration 012).
Plaid is a **SECOND FEED** into it — NOT a new pipeline. It lands transactions
as `claimed` and reuses the existing alias/identification/exception engine.
(Plaid plumbing already built: migration `031_plaid_items` + `plaid.js` +
`package.json` plaid dep — but NOT yet deployed; 031 is absent from GitHub
until uploaded.)

- **Money Inbox** writes the *what / who* (purpose bucket + confirming person).
- **Spend Control** reads *what / who + history + budget* to surface
  *should-this-continue*.
- **Accounting translation** sits under both. **Reporting reads from all of it.**

-----

## SPEND CONTROL — RECURRING-CHARGE STATUS VOCABULARY

A recurring spend relationship can be:

- `active / approved`
- `needs owner`
- `duplicate`
- `likely obsolete`
- `replaced by Property Spine`  ← Spine watches the bank account and knows what
  it itself now does, so it can flag the tool it replaced as a kill candidate.
  A real edge most spend-control tools don’t have.
- `cancel candidate`
- `contract / renewal review needed`

**The subscription point:** a lot of software gets paid forever because nobody
questions it. Property Spine should not just RECORD those charges — it should
CHALLENGE them.

**Spend Control needs a baseline before it can flag variance.** “40% above
normal” requires knowing normal — vendor amount/timing history (the 4125
tracker IS twelve months of this, to the penny) plus the budget line (from the
monthly reporting packages). It is buildable against 4125 because the baseline
data exists — but it is a SECOND RUNG, after Money Inbox earns its receipt.

-----

## ANSWER KEYS (both from real 4125 data — this is how we know it works)

**Rung 1 (Money Inbox) — reproduce 4125’s hand-built monthly journal.**

- Source: `_Accounting/1.2 Bank Activity Tracker/4125 - Summary Bank Activities - 2026.xlsx`.
- Today’s reconciliation is ALREADY the model, done by hand, monthly: balanced
  double-entry J-rows, vendor charge → expense GL, offset against operating
  cash (1110), with the `property` column on every row.
- Recurring vendors tie to the penny every month:
  **PecoEnergy → 6201 (Electric), Philadelphia Water → 6206 (Water/Sewer),
  Scentair → 6711 (General Office), Stamps.Com → 6715 (Postage).**
- **Done =** a month of 4125’s Plaid transactions land, auto-identify the
  recurring vendors with the right bucket→GL, and reproduce this journal —
  with Amazon/Virtus exceptions pulled OUT into a visible pile instead of buried
  — **while the human never sees the journal’s accounting language.**

**Rung 2 (Spend Control) — catch the anomaly month-end review misses.**

- 4125 runs ~$1,000/month in clean recurring utilities, then **March 2026 has a
  $2,558.21 Revenue Collection Bureau charge (GL 6161)** that’s nothing like the
  pattern.
- **Done =** Spend Control surfaces that line the day it lands as a variance/
  unexpected-vendor exception.

**The kill target:** the old “Ask My Accountant” catch-all bucket (seen in the
real 2019 reconciliation export, where weeks-late Amazon debit-card lines piled
up because nobody remembered what they were). The whole point of the
Plaid-triggered queue is to KILL that pile by asking at the moment of the
charge instead of at month-end.

**The bar:** *Can we reproduce 4125’s monthly journal with minimal human work,
while making exceptions visible the day they happen? Better than today, not
perfect.*

-----

## BUILD ORDER

**Step 0 — Seed two layers from the 4125 tracker** (so suggestions aren’t
cold). The “no accounting language” rule means this is TWO maps:

- the private **bucket → GL/reporting** map (the accounting translation, set
  once in setup mode), and
- the **vendor → bucket** history (what drives the suggestion).
  The person’s path only ever touches buckets. Building the slice on an unseeded
  DB makes the answer-key test fail for the WRONG reason (it would correctly
  identify payees but have nothing to suggest).

**Then the smallest real slice (the dry-run and the workflow test in one):**

1. Plaid transaction lands, including **pending**.
1. System creates **one** inbox item.
1. Property/entity resolves from account/card.
1. Vendor alias/history suggests the **purpose bucket** (plain English).
1. Role assignment routes to the responsible person.
1. Person can **confirm / edit** (one tap default).
1. If amount exceeds cap, **escalate** through the assignment ladder.
1. When the **posted** transaction lands, it matches the pending item and
   **inherits** the confirmation.
1. Compare output to 4125’s hand-built journal.

Recurring vendors auto-classify silently throughout.

**Then Rung 2 — Spend Control**, on Rung 1’s classified stream + 4125’s
twelve-month baseline + the reporting budget: variance alerts, subscription/
waste review, the recurring-spend status vocabulary.

-----

## PRECONDITION (operational, not code — the real gate)

**Money Inbox routes by property + role. That only works if properties have
real roles assigned and current.** Even The Felix still points at a test
person, not real staff. A charge routing to a role nobody holds has no one to
tap — it falls to an **unassigned / property-manager / accounting fallback
queue**. So the precondition for the inbox being USEFUL is not more code — it’s
that the properties have their real roles assigned. That’s a team task, and
it’s the thing that unblocks everything downstream.

-----

## GATE POLICY (for now: soft only)

- **Soft gate:** on login, “You have N transactions waiting” + an aging
  indicator. Lives entirely in the dashboard.
- **NO hard block** on workflows yet. **Never block emergency or resident-facing
  work** (the leak-vs-Wawa-receipt rule). A hard gate touches other modules
  (work orders, leasing), is easy to get wrong, and hard to walk back — it waits
  until the queue proves people actually clear transactions. One rung at a time.

-----

## WHAT CLAUDE CAN AND CANNOT DO (honest limits)

Claude can build all of it: the migrations, the modules, the seeding scripts,
the pending/posted match, the inbox endpoints. Claude **cannot**:

- enter Plaid `client_id` / `secret` (Render env vars — Kameron pastes, same as
  Twilio keys);
- do the bank-login click (Plaid Link is a person-in-the-loop OAuth step by
  design);
- certify the 90% suggestion accuracy end-to-end from the sandbox — the deployed
  environment is unreachable. Claude can prove the logic against the 4125
  spreadsheet’s own rows (a strong dry-run); the live confirmation is a browser
  test Kameron runs.