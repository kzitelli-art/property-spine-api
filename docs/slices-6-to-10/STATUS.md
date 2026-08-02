# SLICES 6–10 — STATUS

**Last updated:** 2026-08-02

> **NEXT FOCUS AFTER 8–10 WRAP: BY-BED PRICING.**
> Owner ruling, 2026-08-01. Governed pricing resolves per `unit_type_id`; no
> space-level rent column exists anywhere in the schema. Extending pricing to
> the bed/space level changes the canonical contract's shape and touches every
> consumer, so it gets its own expanded treatment rather than being smuggled
> into Slice 8. **Do not add a space-level rent column before that work** — a
> dormant space rent is a competing truth waiting to be read. See
> `SLICE_8_ECONOMIC_AUTHORITY_AUDIT.md` ruling 1.

Read this before starting any slice. It records what is actually closed, what is
authorized, and what has never been started. Do not reconstruct this from git
history.

---

## Roadmap state

| Slice | Title | Status |
|---|---|---|
| 6 | Renewals Operating Rail | **CLOSED** — live-proven, browser verified |
| 7 | Market & Pricing Workspace | **CLOSED** — live-proven, browser verified |
| 8 | Governed Rents and Concessions | **STEPS 1–4 BUILT & PROVEN** — step 5 held |
| 9 | Market Evidence | **IN PROGRESS** — lifecycle authority + Paths A–E built and locally proven; status-read audit complete; see below |
| 10 | Economic Closure and Orchestration | Not started |
| — | **By-bed pricing** | **NEXT FOCUS after 8–10** (ruled 2026-08-01) |

Slices 1–5 are closed. Slice 8 steps 1–4 are on branch
`claude/new-session-via3v4` (API), pushed, **not merged, no PR**. Slices 9 and
10 have no branch, no commit, and no closure doc in either repository.

## Slice 9 — exact bounded state (2026-08-02)

Branch `claude/slice-9-demand-evidence`, rebased onto `origin/main` `4a04855`.
**Slice 9 is NOT complete.** What is true right now, and nothing more:

| Item | State |
|---|---|
| Lifecycle authority (5 writers) | built, locally proven |
| Paths A–E writer cutover | built; A/B/C proven through real HTTP; **D and E caller-side only** |
| `lease_applications.status` writers | authority is the ONLY one, codebase-wide walk confirms |
| Migrations 123 / 124 | **unmerged**; proven to apply cleanly onto a DB already at 126 |
| Migration 125 (enforcement) | **staged outside `migrations/`**, deliberately not runnable |
| Async timezone contract | audited, zero defective call sites |
| Status-read audit | **complete** — `SLICE_9_APPLICATION_STATUS_READ_AUDIT.md`, 10 sites need correction |
| Read-side refactor | **not started** |
| Canonical journey builder / Funnel 2 re-grain | not started |
| Evidence contract freeze | not done |
| Renderer | not built |
| Production acceptance | not started |
| Browser verification | not done |

Known open defects, from the read audit: `expired` missing from three
"still open" exclusions; a unit held by an approved application can read as
available; two duplicated copies of a historical inference that loses an
approval when an application is later withdrawn.

## Closed slice identity

| Slice | API | App | Migration |
|---|---|---|---|
| 6 | PR #20, merged `9cba504` | PR #21 | **119** |
| 7 | none needed (audit found concessions already ride `/operator/pricing/effective`) | PR #22, merged `5a2c7ac` | — |

Authorship: Slices 6 and 7 were built by Tomasz Mysliwiec.

## Live architecture — preserve unless the owner changes it

```text
TODAY IN LEASING

TOURS                  FOLLOW UPS

LEAD CONVERSATIONS     RENEWALS

MARKET & PRICING
```

Inside Follow Ups: `Active Work` · `Application Records`

## Market & Pricing section maturity (as shipped)

| Section | Maturity |
|---|---|
| Availability | Live |
| Pricing | Live (honest absence — no governed pricing version published) |
| Concessions | Live (honest absence — no concessions in effect) |
| Rent Survey | Not connected — honest panel |
| Listings | Not connected — honest panel |
| Demand | Not connected — honest panel |

Slice 8 fills Pricing and Concessions. Slice 9 connects the other three.

---

## What each remaining slice does

### Slice 8 — Governed Rents and Concessions (audit delivered)

**Audit: `SLICE_8_ECONOMIC_AUTHORITY_AUDIT.md` (2026-08-01). Read it before
building anything.**

The audit changed the shape of this slice. The governed economics spine Slice 8
was scoped to *create* **already exists** — migration 062 built versioned
pricing authority, structured concessions, and fail-closed approval grants;
migration 063 added offer economics with lineage. It is **dark**:

- `publishVersion()` is complete but **has no HTTP route**. That single
  unmounted function is why every property reads `published_version: null`.
- `pricing_adapter.js` (the AI's correct route to pricing) is **dark by
  construction**, and two tests actively pin it dark
  (`pricing_governance_proof.js:432`, `demo_authority_ruling_proof.js:184`).
- The live AI instead quotes `units.market_rent` — an imported spreadsheet
  column with no approval, effective date, version, or actor. This has already
  misquoted real prospects (`$237` on unit 530, to nine phones; documented in
  `pricing_adapter.js`'s own header).

Seven tables can answer "what is the rent." Only `pricing_terms` is governed.
Lineage to governed pricing exists **only** on `lease_offers` and dies there.

**Build order (each step independently provable):** mount publish → downstream
lineage columns → concession read/approve (+ `stacking_rule`) → renewal socket
→ **AI cutover last**, so the governed sheet is real and populated before
anything speaks from it.

**Open rulings — 2, 3, 4, 5 in the audit.** Ruling 1 (by-bed) is settled:
deferred. **Ruling 3 is the blocker with live consequences:** when the AI moves
to governed pricing, any property without a published sheet stops quoting rent
and hands off instead. Doctrinally correct, but a visible behavior change
everywhere — Demo has zero published versions today. Confirm before scheduling
the cutover step.

Unblocks: Slice 6's `Set renewal economics` cross-link stops routing onward and
starts producing a real `proposed_rent` from `pricing_terms.renewal_rent`.
The socket is already cut and labelled at `renewals_read.js:313–314`.

### Slice 9 — Market Evidence

Connect Rent Survey, Listings, Lead Demand, Tour Demand, Conversion, Market
Context. Evidence **informs** pricing; it never becomes pricing authority.
First deliverable is an evidence-source audit classifying each source as
canonical internal fact, external observation, operator-entered evidence,
derived metric, or unsupported.

### Slice 10 — Economic Closure and Orchestration

Two sequential parts. **10A** closes the loop: Market & Pricing → quoted or
offered economics → application or renewal execution → executed lease schedule
→ Management Forward Rent Roll. **10B** adds cross-domain next-action
orchestration, and only after 10A's contractual closure is proven.

---

## NEXT FOCUS — By-bed pricing (ruled 2026-08-01, after 8–10)

Its own work stream, deliberately not folded into Slice 8. Starting questions
for the expanded treatment — not answers, and not a design:

- **Where does a bed price live?** Governed pricing is keyed to
  `unit_type_id`. A bed price is either a new scope on `pricing_terms`, a new
  governed table, or a `space`-scoped extension. Each choice ripples through
  `effective_pricing`, `pricing_adapter`, offers, applications, and renewals.
- **What is the unit-type price *for* once beds are priced?** A parent default,
  a fallback, or meaningless? "Both exist and disagree" is the failure mode.
- **Bed heterogeneity.** `concession_policies.scope` already admits `bed_type`,
  so the concession model anticipated this; the pricing model did not.
- **Availability is already positional.** `space_position` and the Slice 6/7
  classifier work per space, so the *inventory* side is bed-aware today.
  Pricing is the half that is not — that asymmetry is the actual problem.
- **Renewals by bed.** A renewal is per lease; a lease may cover one bed.
  `pricing_terms.renewal_rent` is type-level.
- **Honest absence.** Until bed pricing exists, a by-bed property must not be
  shown a type price dressed as a bed price.

**Standing constraint until this work starts:** do not add a space-level rent
column in Slices 8–10. A dormant space rent is a competing truth waiting to be
read — exactly the defect Slice 8 exists to remove.

---

## Carried-forward work that belongs to no slice

These fall through the cracks between slices. Track them explicitly.

1. **Renewal write commands** (from Slice 6). `prepare_renewal_offer`,
   `record_resident_response`, `verify_execution` and siblings are named by
   `primary_action`, but their server contracts were never built. The
   destination currently routes the operator to where the work is done.

2. **internal_qa two-views hygiene** — recorded during Slice 5, deliberately not
   changed during that merge.

3. **`conversations-board.js` eyebrow / `enhanceConversations()` text collision**
   — pre-existing, cosmetic.

4. **Migration-chain fresh-replay hardening.** The chain does not replay cleanly
   on an empty database; three shims are required (vendors columns for the
   001-vs-012 divergence, 087 recorded applied-empty, 110 DDL-only).

---

## Owned by a DIFFERENT thread — do not build here

Owner decision, 2026-08-01: the AI leasing agent work was pulled into its own
thread so Slices 8–10 get undivided focus. **This thread does not build these.**

- **AI leasing strategy replay validation.** Maya, James and Claire are visible
  on Lead Conversations and correctly report `Needs validation`. Activation is
  blocked at the database level until the replay corpus runs — ≥50 scenarios
  across `first_response`, `ongoing_reply`, and `regenerated_reply` against real
  model output.
- **Governed operating context package** (consultant, 2026-08-01). Returned, not
  merged. Blocked on three installer defects plus the manager/admin authority
  gate for governance writes.

### ⚠️ Known collision — sequence before building

**Slice 8's final step is an AI cutover, and it edits `agent.js` — the same file
the other thread owns.**

Slice 8 step 5 retires the live `units.market_rent` quote path and moves the AI
onto `pricing_adapter.js`. That touches `agent.js` and requires inverting two
guard assertions (`pricing_governance_proof.js:432`,
`demo_authority_ruling_proof.js:184`). The governed-context package **also**
patches `agent.js`, at the generation/prompt seam.

They do not overlap logically — Slice 8 changes **where the rent number comes
from**; the other thread changes **what governs the language around it**. But
they land in one file, and `agent.js` is the highest-risk junction in the
codebase (live prospect-facing messages).

**Handling:** build Slice 8 steps 1–4 freely — none of them touch `agent.js`.
Hold step 5 (AI cutover) until the other thread's `agent.js` state is settled,
then rebase and re-run the full agent regression set before flipping. Whichever
thread lands second owns the merge.

---

## Recently landed (not part of 6–10)

| Work | API | App |
|---|---|---|
| AI leasing strategy foundation | PR #23, merged `dc48b88`, migration **120** | — |
| AI leasing visible status | PR #24, merged `afd1ef1` | PR #24, merged `30e550b` |

App build stamp for the visible-status slice:
`window.__PS_BUILD.code_sha` = `9422d454d5fa60ec6df65d0ee2ea593017f877df`.

Next free migration number: **123**.

> Migration numbering, 2026-08-01: main is at 120. The AI-leasing thread claims
> **121** (`121_ai_leasing_operating_context.sql`, branch
> `claude/getting-up-to-speed-nyf4ww`). Slice 8 therefore took **122**.
> Always `ls migrations/` before choosing a number — two `106` files once broke
> every API deploy.
