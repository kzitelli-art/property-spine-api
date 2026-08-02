# SLICE 9 — APPLICATION STATUS READ AUDIT

**Branch:** `claude/slice-9-demand-evidence` · **Audited head:** `45e2db4` (rebased onto `origin/main` `4a04855`)
**Date:** 2026-08-02 · **Scope:** every production read of `lease_applications.status`

> **This is a documentation commit. No production behavior changes here.**
> The remediation is the next slice, sequenced at the end of this document.

---

## Why this audit exists

Slice 9 made the lifecycle authority the only writer of `lease_applications.status`,
and made it author milestones — `submitted_at`, `approved_at`, `terminal_at`,
`terminal_code` — at the moment each transition happens.

That closed the **write** side. It did not close the **read** side. Current status
is a single mutable label: it can only ever describe where an application is *now*.
Every question of the form "did this ever reach X" is unanswerable from it, because
reaching X and then moving on overwrites the evidence.

The canonical example, and the one that is actually live in two modules today:
an application that is **approved and later withdrawn** currently reads as
`declined`. The approval did happen. The label no longer says so.

## Method

Scanned the **rebased** tree, not the pre-rebase one — main added material after
the branch diverged. Raw literal counts overstate the surface badly: 15 files
contain application-status literals, but most are on *other* tables
(`agent_facts`, `application_invitations`, `lease_packets`, `lease_offers`,
`units`, `leases`, `obligations`, `leasing_leads`, `leasing_tours`). Those are
excluded. What follows is only reads of `lease_applications.status`.

Canonical groups, from the authority (`src/applications/application_lifecycle.js`):

```
SUBMISSION_REACHED : submitted, approved, lease_ready, tenant_signed, countersigned, accepted_term_required, active
APPROVAL_REACHED   :            approved, lease_ready, tenant_signed, countersigned, accepted_term_required, active
TERMINAL           : declined, withdrawn, expired
```

Database CHECK constraint on `lease_applications.status`:

```
draft, submitted, approved, lease_ready, tenant_signed, countersigned,
active, declined, withdrawn, expired, accepted_term_required
```

---

## Categories

| | Category | Count |
|---|---|---|
| **A** | Current state — a status read may be correct | 6 |
| **B** | Historical milestone — must use `*_at` columns | 2 |
| **C** | Terminal outcome — must use `terminal_code` / `terminal_at` | 0 (folded into B) |
| **D** | Progression / ordering — must consume a canonical group | 9 |
| **E** | Display / compatibility only | 3 |
| **F** | Test / fixture / documentation — not production | not counted |

**Production occurrences: 20.** Remediation required on **11** (categories B and D).

> **Count correction (2026-08-02):** an earlier revision of this table said D=8 /
> total 19 / remediation 10 while the D table below listed D1–D9. The table was
> right and the totals were wrong. `leasepackets.js:405` (D9) is a genuine
> production read of `lease_applications.status` — a JS comparison against
> `app.status` gating packet creation — so it counts. D=9, total=20,
> remediation=11.

---

## B — HISTORICAL MILESTONE (defective; highest severity)

### B1 · `src/identity/operator.js:2919–2929`
### B2 · `src/leasing/leasing_desk_loader.js:219–229`

**These two are the same logic, duplicated.** Both derive an application funnel
state with a `CASE` over current status:

```sql
when exists (... and la.status in ('approved','lease_ready','tenant_signed','countersigned','active'))
  then 'approved'
when exists (... and la.status in ('denied','declined','withdrawn'))
  then 'declined'
when exists (... and la.status = 'submitted')
  then 'submitted'
```

- **Business question:** did this lead ever reach approval / get declined / submit?
- **Is current status authoritative?** **No.** This is a history question.
- **Failure:** an application **approved then withdrawn** matches the second
  branch and reports `declined`. The approval is erased from the funnel. An
  application **approved then expired** reports neither — `expired` is in no
  branch, so it silently falls through to "no application".
- **Canonical replacement:** `approved_at is not null` for reached-approval;
  `terminal_code` for the closing outcome; `submitted_at is not null` for reached-submission.
- **Historical rows:** `approved_at` is NULL for pre-124 rows that were approved
  under the old writer (migration 124 backfills only where current status still
  proves approval). Those rows must read as **unknown**, not as "never approved".
  Honest blank beats confident wrong.
- **Operator surface:** the leasing desk funnel and the operator lead board.
- **Severity: HIGH.** Wrong numbers on an operator-facing funnel, and two copies
  drift independently.

---

## D — PROGRESSION / ORDERING (defective; each maintains a private ladder)

No two of these agree, and none matches the authority.

| # | Location | Ladder as written | Missing vs canonical |
|---|---|---|---|
| D1 | `leasingconversion.js:479` | submitted, approved, lease_ready, tenant_signed, countersigned, active | `accepted_term_required` |
| D2 | `leasingconversion.js:486` | tenant_signed, countersigned, active | `accepted_term_required` |
| D3 | `leasingconversion.js:818` | approved, lease_ready, tenant_signed, countersigned, active | `accepted_term_required` |
| D4 | `leasingconversion.js:890` | NOT IN (denied, declined, withdrawn) | **`expired`** |
| D5 | `leasingconversion.js:1069` | NOT IN (denied, declined, withdrawn) | **`expired`** |
| D6 | `applicationSubmission.js:2004` | NOT IN (denied, declined, withdrawn) | **`expired`** |
| D7 | `availability.js:176` | submitted, tenant_signed, lease_ready | `approved`, `countersigned`, `accepted_term_required` |
| D8 | `turn_priority.js:57` | submitted, tenant_signed, lease_ready, accepted_term_required | `approved`, `countersigned` |
| D9 | `leasepackets.js:405` (JS) | lease_ready, tenant_signed, approved | `countersigned`, `accepted_term_required` |

### Three distinct defects fall out of that table

**`expired` is missing from every "still open" exclusion (D4, D5, D6).**
An expired application is terminal, but these read it as **live**. Effect: the
system believes an open application exists, so it will refuse to start a new
one and will keep counting the dead one in conversion state.
**Severity: HIGH** — `expired` is exactly the disposition Slice 9 introduced as
a first-class terminal code, so this gap widens as the vocabulary gets used.

**`accepted_term_required` is missing from six ladders.**
It is the state an application sits in between executed-lease admission and
activation — a real, occupied, live state. Anything that skips it treats a
tenancy mid-flight as absent.
**Severity: HIGH for D7** (`availability.js`): a unit held by an approved or
term-pending application can read as **available**. That is a double-leasing
exposure on an operator surface, not a reporting nicety.

**`'denied'` is dead vocabulary, filtered in 5 places.**
The CHECK constraint does not permit `denied`; the database cannot hold it, and
a scan of live data shows only `active, approved, declined, draft, submitted`.
Harmless today (an extra exclusion that never matches) but it is evidence these
lists were copied forward from a pre-constraint era and never re-derived —
which is the same root cause as everything else in this table.
**Severity: LOW**, but remove it in the same pass so the vocabulary is honest.

---

## A — CURRENT STATE (status read is legitimate)

| Location | Question | Verdict |
|---|---|---|
| `applicationSubmission.js:855` | may I deny from here? | correct — the authority re-checks |
| `tenancy_anchor_service.js:190` | is it at `accepted_term_required` now? | correct |
| `tenancy_anchor_service.js:114` | current-state switch | correct |
| `activation_perimeter.js:221` | is current state in the eligible set? | correct |
| `proof_next_action_resolver.js:41–44` | what is the next action *now*? | correct |
| `applications.js:428` | may I approve from here? | correct — the authority re-checks |

These ask a present-tense question, which is the one thing current status can
answer. Leave them.

## E — DISPLAY / COMPATIBILITY ONLY

`operator.js:2223–2224` (`statusMap` + `raw_status`), `tenancy_anchor_service.js:130`,
`demo.js:111`. Labels in a response shape; they imply no history. Retain.

---

## The eight required cases

| Case | Current status says | Milestones say | Who gets it wrong today |
|---|---|---|---|
| approved → withdrawn | `withdrawn` | `approved_at` set, `terminal_code='withdrawn'` | **B1, B2** report `declined`; approval lost |
| submitted → declined | `declined` | `submitted_at` set, `terminal_code='declined'` | B1/B2 correct by luck |
| approved → expired | `expired` | `approved_at` set, `terminal_code='expired'` | **B1, B2** fall through to "no application"; **D4–D6** read it as still open |
| historical approved, `approved_at` NULL | `approved`/beyond | unknown | must read **unknown**, never "not approved" |
| active after accepted_term_required | `active` | both milestones set | D2 ok; D7/D8/D9 miss the intermediate state |
| terminal with retained milestones | terminal label | full history preserved | B1/B2 discard the history |
| submitted, no approval milestone | `submitted` | `approved_at` NULL — genuinely not approved | correct |
| missing canonical milestone | any | NULL | must report unknown, not false |

---

## SEARCH / ASK SPINE BOUNDARY — governing rule for other builds

> **"Currently approved" may read current status.**
>
> **"Was approved", "has reached approval", "approved before withdrawal", or any
> historical or ever-happened search MUST use `approved_at is not null`.**
>
> The search build must not implement its own application lifecycle ladder or
> infer status history. It consumes the canonical read helpers (below) or asks
> for one to be added.

A NULL milestone on a historical row means **unknown**, and search must render
it as unknown rather than as a negative.

---

## Proposed canonical read-helper surface

To be built in the next slice, exported from the authority so there is one
definition and drift is impossible (the existing status-group drift proof
already guards the group constants):

```
reachedSubmission(app) / reachedApproval(app) / isTerminal(app)   — already exported
SQL fragment helpers, property-scoped and parameterized:
  sqlReachedApproval(alias)     ->  alias.approved_at is not null
  sqlReachedSubmission(alias)   ->  alias.submitted_at is not null
  sqlIsOpenApplication(alias)   ->  alias.status <> all(TERMINAL)     -- includes expired
  sqlHoldsUnit(alias)           ->  alias.status = any(SUBMISSION_REACHED minus terminal)
```

The three "still open" sites and the two funnel derivations are the first
consumers.

---

## Overlap with other active builds

| File | Also touched by | Note |
|---|---|---|
| `src/leasing/leasingconversion.js` | — | D1–D5 live here; no other branch modifies it |
| `src/identity/operator.js` | — | B1 lives here |
| `src/leasing/leasing_desk_loader.js` | — | B2 lives here |
| `src/comms/communications_boundary.js` | main (double-send guard) | already reconciled in this rebase; **not** part of the read audit |
| `src/leasing/leasingleads.js` | AI-leasing thread (migration 121, unmerged) | Slice 9 touched only the timezone wrapper; the read audit does not touch it |

Migration `121_ai_leasing_operating_context.sql` is still unmerged on
`claude/getting-up-to-speed-nyf4ww`. Re-run the inventory if it lands.

---

## Correction sequence (next slice, not this commit)

1. Add the canonical read helpers to the authority; extend the drift proof to cover them.
2. Fix **D4, D5, D6** — add `expired` to the terminal exclusions. Smallest change, highest live risk.
3. Fix **D7** (`availability.js`) — a unit held by an approved application must not read available.
4. Fix **B1** and **B2** together, collapsing the duplicate into one helper.
5. Fix **D1, D2, D3, D8, D9** onto the canonical groups; drop `'denied'`.
6. Re-run: leasing desk, availability, conversion, turn priority, and the Slice 9 lifecycle suites.

Do **not** begin the read-side refactor in this audit commit.
