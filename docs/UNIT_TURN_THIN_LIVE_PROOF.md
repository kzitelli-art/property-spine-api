# Unit Turn — thin live proof

**The executable acceptance script. Run it only after the baseline artifacts
have arrived and the disposable database verifies.**

One golden path, four negative controls. This is not a test plan for
everything Builds 1–6B can do — it is the smallest run that, if it passes,
means the unit turn works end to end, and if it fails, says exactly where.

Until every step below has been executed against real Postgres, through real
HTTP, in a browser, the correct description of this work remains
**Built but dormant**.

---

## Before you start

```bash
# The baseline must already be restored and verified.
node scripts/runtime-proof/verify-baseline.js            # must exit 0
./scripts/runtime-proof/apply-pending-build-migrations.sh --apply
node scripts/runtime-proof/verify-baseline.js            # 112–117 applied_and_recorded
```

Three people are needed, and they must be **different rows** in
`property_team_assignments`:

| Role | `allowed_modules` | `role_title` | Used for |
|---|---|---|---|
| **T** technician | `maintenance` | anything | steps 1–8 |
| **M** manager | `maintenance` + `management` | Senior/Assistant/Property Manager | steps 9–13 |

> **NOTE — provisioning.** The authority model is now ruled and implemented:
> either module may **read** a turn; only `maintenance` may **operate** work;
> readiness needs management + an eligible title or explicit delegation. Give
> **M both modules** so M can operate as well as certify, and provision a
> **third** actor for negative control N4:
>
> | Role | `allowed_modules` | Used for |
> |---|---|---|
> | **G** management-only | `management` | N4 — reads the turn, sees no work controls |

Capture for every step: the HTTP request/response, a screenshot of the Unit
Turn page, and the SQL result named in the step. A step with no receipt did not
happen.

---

## The golden path — Unit 304

### Step 1 — T reports the condition

| | |
|---|---|
| **Actor** | T (maintenance) |
| **Authority** | active assignment + `maintenance` |
| **Browser** | Property Home → Maintenance → **Turnovers** → the message box → send |
| **Message** | `There are cockroaches behind the refrigerator.` |
| **Route** | `POST /operator/staff-agent/message` |

> **Use that sentence exactly** — it is the app's own placeholder example, and
> it now classifies. A concrete thing in a concrete state reaches initial
> triage using the page's open unit, without the operator repeating that the
> unit is vacant.
>
> **Also send** `It is bad.` and confirm it comes back as a question. Vague
> language must still ask.

- **Canonical record:** one `staff_agent_messages` row (verbatim), one
  `staff_agent_proposals` row `intent='initial_triage'`, `status='proposed'`.
- **Unit Turn read:** thread shows *"You reported a unit condition"* with
  Confirm / Cancel.
- **Assert:** the proposal claims **no vacancy** and **no complete inspection** —
  the unknowns say both out loud.
- **Receipt:** *"Nothing operating has been recorded. This is a proposal."*
- **DB:** `select intent,status from staff_agent_proposals order by created_at desc limit 1;`
  → `initial_triage | proposed`
- **Also assert:** `select count(*) from unit_triage_confirmations where unit_id=<304>;` → **0**.
  A proposal must have written no domain truth.

### Step 2 — T confirms

| | |
|---|---|
| **Actor** | T · **Browser** Confirm · **Route** `POST /operator/staff-agent/proposals/:id/confirm` |

- **Canonical record:** `unit_triage_confirmations` 1 row; `unit_observations`
  carries the original text; `unit_triage_findings` ≥ 1; `unit_triage_required_work` ≥ 1.
- **Assert:** `vacancy_observation = 'uncertain'` — the message never said the
  unit was vacant, and nothing invented it.
- **Assert:** `inspection_completeness` is **not** a complete turn scope. One
  observation is not an inspection.
- **Unit Turn read:** vacancy *Confirmed vacant*; readiness **not** ready;
  required work listed; owner **UNASSIGNED**.
- **Receipt:** *"Recorded through the same canonical service the structured door uses."*
- **DB:** `select finding_text from unit_triage_findings where unit_id=<304>;`
- **Assert:** readiness is `not_ready` or `unknown` — **never `ready`**.

### Step 3 — scope and required work exist

| | |
|---|---|
| **Actor** | T · **Browser** *This needs full paint and a deep clean.* → Confirm |
| **Route** | `POST /operator/staff-agent/message` then `…/confirm` |

- **Canonical record:** `unit_turn_scopes` 1 row; required work now carries
  `stage`.
- **Unit Turn read:** work grouped Repairs → Paint → Final cleaning; one
  controlling next action.
- **Assert:** `inspection_completeness` is `partial` — a message never
  establishes a complete inspection.
- **DB:** `select work_text,stage from unit_triage_required_work where unit_id=<304> order by created_at;`

### Step 4 — T accepts the actionable work

| | |
|---|---|
| **Actor** | T · **Browser** **Accept work** on the refrigerator item |
| **Route** | `POST /operator/turn-work/:workId/accept` |

- **Canonical record:** `work_acceptances` 1 row, owner = T.
- **Unit Turn read:** owner `assigned`; status still **required**.
- **Assert:** there is **no** `accepted` status. Acceptance is not progress.
- **DB:** `select owner_user_id,due_at from work_acceptances where work_id=<w>;`

### Step 5 — proof-short completion stays open

| | |
|---|---|
| **Actor** | T · **Browser** Complete work → **Record what was done** |
| **Route** | `POST /operator/turn-work/:workId/claim` |

- **Canonical record:** `work_completion_claims` 1 row,
  `proof_satisfied=false`, a stated `proof_shortfall`.
- **Unit Turn read:** *"Claimed complete, NOT closed."* + the shortfall.
- **Assert:** work status is still `required`; the readiness walk is still blocked.
- **DB:** `select proof_satisfied,proof_shortfall from work_completion_claims where work_id=<w>;`

### Step 6 — required proof closes the work

> ⚠ **THIS STEP CANNOT BE RUN TODAY, AND THAT IS THE CORRECT BEHAVIOUR.**
>
> The fake "Photo reference" text box is gone and no attachment store exists,
> so photo-requiring work **stays open** and the panel says why. There is
> nothing to type that will close it — which is the point: a string is not a
> photo.
>
> **What to do instead:** run step 5, confirm the work is still `required`,
> screenshot the *"Photo proof is unavailable"* panel, and record this step as
> **BLOCKED on the attachment prerequisite** (release candidate §10).
>
> Run it as written only once a session-scoped attachment primitive exists:
>
> | | |
> |---|---|
> | **Actor** | T · **Browser** Complete work → **select a real file** → Record |
> | **Route** | `POST <attachment upload>` then `POST /operator/turn-work/:workId/claim` |
>
> - **Expect:** upload returns an opaque attachment id; the claim carries that
>   id; `proof_satisfied=true`; work → `complete`; the page can open the evidence.
> - **Assert:** the same claim with a *typed* id instead of an uploaded one is
>   **refused** — the store, not the string, decides.
> - **DB:** `select proof_photos, proof_satisfied from work_completion_claims where work_id=<w>;`
> - **DB:** the attachment row carries its own uploader and time, separate from
>   `claimed_by_user_id` on the claim.

### Step 7 — remaining work completes in sequence

| | |
|---|---|
| **Actor** | T · **Browser** complete paint, then final cleaning, in the order the page offers |

- **Assert:** the page never offers final cleaning before paint. If the
  operator can reach a later stage while an earlier one is open, **stop** — the
  sequence engine is wrong and nothing after this matters.
- **DB:** `select work_text,stage,status from unit_triage_required_work where unit_id=<304>;`

### Step 8 — the final walk becomes actionable; the unit is still not ready

| | |
|---|---|
| **Actor** | T then M · **Route** `GET /operator/units/:unitId/turn` |

- **Unit Turn read:** *"The walk may be performed. That is not readiness —
  readiness is the certification."*
- **Assert:** `status.certified` is **false** and `physical_readiness` is **not**
  `ready`. Closed work is not readiness.
- **Assert:** T sees `may_walk=false` (no certification authority); M sees `true`.
- **DB:** `select count(*) from unit_readiness_certifications where unit_id=<304>;` → **0**

### Step 9 — M fails the final walk

| | |
|---|---|
| **Actor** | **M** · **Authority** assignment + management + eligible title |
| **Browser** | Record a failed walk → *"The bathroom door still doesn't latch."* |
| **Route** | `POST /operator/units/:id/readiness/walk` (`outcome=not_ready`) |

- **Canonical record:** `unit_readiness_walks` 1 row `outcome='not_ready'`;
  new `unit_triage_required_work` row(s) linked by `readiness_walk_id`.
- **Unit Turn read:** the new work appears **in the same list**, in a stage.
- **Assert:** still no certification row.
- **DB:** `select work_text,readiness_walk_id from unit_triage_required_work where readiness_walk_id is not null;`

### Step 10 — the specific work reopens the flow

- **Unit Turn read:** one controlling next action pointing at the door latch;
  the readiness walk blocked again.
- **Assert:** the reopened work is visible to the **normal** work read, not a
  separate failed-walk view.

### Step 11 — repair and any recleaning complete

| | |
|---|---|
| **Actor** | T · complete the latch repair, then any recleaning the page requires |

- **Assert:** if the repair disturbs cleaned surfaces, the page requires the
  reclean **before** offering the walk. If it does not, record it — that is a
  sequence finding.
- **DB:** `select * from reclean_rulings where unit_id=<304>;`

### Step 12 — M explicitly certifies readiness

| | |
|---|---|
| **Actor** | **M** · **Browser** Perform final readiness walk — affirm **every** confirmation area |
| **Route** | `POST /operator/units/:id/readiness/walk` (`outcome=ready`) |

- **Canonical record:** `unit_readiness_walks` `outcome='ready'` **and**
  `unit_readiness_certifications` 1 row attributed to M.
- **Unit Turn read:** *"Physically ready — certified."*
- **Assert:** certification exists **only** because a named human affirmed every
  area. Try submitting with one area unaffirmed — it must be refused.
- **DB:** `select certified_by_user_id,certified_at from unit_readiness_certifications where unit_id=<304>;`

### Step 13 — another availability blocker keeps marketability false

| | |
|---|---|
| **Setup** | before step 12, give 304 a **non-physical** blocker — a successor commitment or a spanning lease |
| **Route** | `GET /operator/units/:unitId/turn` |

- **Unit Turn read:** *"Physically ready but not currently marketable. Reason: …"*
  and the blocker named.
- **Assert:** `status.certified=true` **and** `marketability ≠ marketable_now`.
- **Assert:** the certification is **not erased** by the blocker.
- **DB:** compare `unit_readiness_certifications` (present) with the availability
  read's `marketing_state` (not `marketable_now`).

> This step is the whole point of the sequence. **Physical readiness is not
> marketability.** If a certified unit reads `marketable_now` while a successor
> commitment exists, the guard chain is broken — stop and report it.

---

## Negative controls

Four. Each must **fail in the stated way**.

### N1 — duplicate proposal confirmation executes once

- Open the Unit Turn page in **two browser tabs**. Confirm the same proposal in
  both, as close to simultaneously as you can. Also double-click Confirm.
- **Expect:** the second returns `already_confirmed: true` with
  *"The canonical action ran once and was not repeated."*
- **DB:** `select count(*) from unit_triage_confirmations where unit_id=<304>;` → **exactly 1**
- **Assert:** exactly one canonical record. Two is a hard failure.
- *This is the only executable evidence for release candidate §9, which is
  currently **UNPROVEN**. Also attempt a concurrent double **acceptance** and a
  concurrent double **certification** — those rails are supersede-based and
  their concurrency behaviour has never been observed.*

### N2 — maintenance-only staff cannot certify readiness

- As **T**, with the gate open, attempt the certification — through the UI if
  it is offered, and directly via `POST /operator/units/:id/readiness/walk`
  with `outcome=ready`.
- **Expect:** refused. Reason: *"final-readiness certification requires
  management module access at this property."*
- **Assert:** the UI never offered it (`may_walk=false`), **and** the API
  refuses even when called directly. A UI that merely hides the button is not
  authority.
- **DB:** no new `unit_readiness_certifications` row.

### N4 — a management-only operator reads the turn but cannot operate it

- Sign in as **G** (`management` only, assigned to the property). Open
  Maintenance → Turnovers → Unit 304.
- **Expect:** the turn list and the Unit Turn page load normally. G sees
  status, blockers, ownership, the controlling next action and management
  attention.
- **Assert:** **no** Accept, Complete, Unable or Reopen control is rendered,
  and the page explains why —
  *"Accepting, completing and reopening turn work requires maintenance-module
  access at this property."*
- **Assert:** `capabilities.may_operate_work` is `false` and
  `may_view_management_attention` is `true` in the read.
- **HIDING IS NOT THE ENFORCEMENT.** Call the write route directly as G:
  `POST /operator/turn-work/:workId/accept`. **Expect 403.** A UI that merely
  omits a button has proved nothing.
- **DB:** no new `work_acceptances` row.

### N3 — "304 is ready" cannot bypass the final readiness walk

- As **T**, and again as **M**, send `304 is ready.` through the message box.
- **Expect:** a **redirect**, not a proposal: *"Readiness requires the final
  readiness walk. Open Final Readiness."* For T, additionally *"You cannot
  certify this unit: …"*.
- **Assert:** **no** `staff_agent_proposals` row was created at all — there is
  nothing to confirm, not merely a confirmation that is refused.
- **DB:** `select count(*) from staff_agent_proposals where created_at > <t>;` → **0**
- **DB:** no new `unit_readiness_certifications` row.

---

## What a pass means, and what it does not

A clean run moves Builds 1–6B from **Built but dormant** to
**Proven (real DB + real HTTP)**, and — because every step is driven from the
browser — to **Browser verified** for the paths it covers.

It does **not** cover:

- **Photo proof.** Step 6 is BLOCKED, deliberately. A string can no longer
  satisfy the gate and photo-requiring work stays open. Until a session-scoped
  attachment primitive exists, "complete with photo" is not an operational
  flow (release candidate §10).
- **Concurrency beyond N1.** Acceptance and certification remain classified
  *unproven without Postgres* unless the extra probes in N1 are run.
- **Attachment lifecycle.** Proof is evaluated once, at claim time, and the
  verdict is stored. Nothing re-checks whether an attachment still exists.
- **Whether one attachment may satisfy two work items.** Unruled.
- **Anything about legacy units** with no triage evidence, or by-bed grain.

Record each of those five as still-open when reporting the run. A green
golden path is not a green product.
