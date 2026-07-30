# Unit Turn — thin live proof

**The executable acceptance script. Run it only after the baseline artifacts
have arrived and the disposable database verifies.**

One golden path, five negative controls. This is not a test plan for
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
node scripts/runtime-proof/verify-baseline.js            # 112–118 applied_and_recorded
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
> | **G** management-only | `management` | N4, N9 — reads the turn and the proof photos, cannot operate through EITHER door |

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

### Step 6 — one photo closes the work

| | |
|---|---|
| **Actor** | T (maintenance) |
| **Browser** | Complete work → **Add completion photo** → take or choose a real image → *"it cools"* → **Complete work** |
| **Route** | `POST /operator/turn-work/:workId/claim` — `multipart/form-data`, one field `photo` |

**The operator sees:** tap Add completion photo → camera or picker → a small
preview and *"Photo ready"* → Complete work → the receipt with the photo.
No upload step, no Save Photo button, no attachment id, no second screen.

- **Before choosing a photo:** Complete work is **disabled** and the panel
  says *"Add one completion photo to close this work."* Confirm that. The
  requirement must not be discovered through an error.
- **Canonical record:** one `work_proof_attachments` row **and** one
  `work_completion_claims` row, from the same request, in the same
  transaction. Work → `complete`.
- **Unit Turn read:** the item shows complete, with the photo as a small
  governed preview; the next stage unlocks.
- **DB:**
  `select property_id, unit_id, work_id, uploaded_by_user_id, mime_type, byte_size, sha256, created_at from work_proof_attachments where work_id=<w>;`
  → all present, `uploaded_by_user_id` = **T**.
- **DB:** `select proof_photos, proof_satisfied, claimed_by_user_id from work_completion_claims where work_id=<w>;`
  → `proof_photos` holds the **attachment id**, not a filename;
  `proof_satisfied = true`. **Uploader and completion actor are separate
  columns** — confirm both are recorded even when they are the same person.
- **DB:** `select count(*) from work_proof_attachments;` after a **double-tap**
  of Complete → still **1**. One photo, not two.
- **Governed read:** open `GET /operator/turn-work/<w>/proof/<attachmentId>`
  as T. Expect the image, `Content-Type` matching the stored type,
  `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.

### Step 6b — the file rules, exercised

Each of these must be **refused** with an operator-readable message, and must
write **no attachment row and no completion claim**:

| Attempt | Expected |
|---|---|
| a `.txt` renamed `photo.jpg` | *"That file is not a JPEG, PNG or WebP photo."* |
| a PDF sent with `Content-Type: image/jpeg` | same — the **bytes** decide, not the header |
| a zero-byte file | *"That photo is empty."* |
| a 6 MB image | *"Keep it under 5 MB."* |
| two files in one request | refused |

**DB after all five:** `select count(*) from work_proof_attachments where work_id=<w>;`
→ unchanged.

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

Nine. Each must **fail in the stated way**.

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
- Also call `POST /operator/turn-work/:workId/claim` directly as G, with a real
  photo attached. **Expect 403** — *"recording a completion requires
  maintenance-module access at this property … Nothing was recorded."*
- **DB:** no new `work_acceptances` row, no new `work_completion_claims` row,
  and **no new `work_proof_attachments` row** — the refusal precedes the store,
  so the image never reaches the database.
- **Assert:** `capabilities.may_read_proof` is `true` for G. Refusing to operate
  is not refusing to look; G must still be able to open a completion photo on a
  closed job.

### N5 — a photo cannot close a job it was not taken for

- Complete work item **A** with a photo. Note its attachment id.
- Submit a completion for work item **B** as JSON with
  `proof_photos: ["<A's attachment id>"]`.
- **Expect:** B is **NOT closed**. The shortfall names the missing photo.
- **Assert:** resolution is scoped to property **and** unit **and** work, so
  A's photo resolves to nothing on B.
- Repeat with an attachment id from **another property**. Same result.
- **DB:** `select proof_satisfied from work_completion_claims where work_id=<B>;` → `false`
- **Cross-property read:** as T at property 1, request
  `GET /operator/turn-work/<w2>/proof/<attachmentFromProperty2>`.
  **Expect 404** — the same answer as a nonexistent id, so the response never
  confirms that somebody else's attachment exists.

### N9 — a management-only operator cannot complete through the staff agent

*This is the control for the finding that the conversational door was weaker
than the structured one.*

- As **G** (`management` only), open the staff agent and send a completion
  message for an open work item — e.g. *"Finished the fridge in 304."*
- **Expect:** the message is captured and a `work_completion` proposal is
  produced. Capture is not authority; nothing is recorded yet.
- Confirm the proposal.
- **Expect 403** with the same words the structured door gives:
  *"recording a completion requires maintenance-module access at this property.
  Management access can read this turn and view completion photos, but cannot
  record that work was finished. Nothing was recorded."*
- **DB, all of these:**
  - `select count(*) from work_completion_claims where work_id=<W>;` → **unchanged**
  - `select count(*) from work_proof_attachments where work_id=<W>;` → **unchanged**
  - `select status from unit_triage_required_work where id=<W>;` → still `required`
  - `select status from obligations where related_id=<W>;` → still open
  - `select status from staff_agent_proposals where id=<P>;` → **still `pending`**,
    not `confirmed` — the whole transaction rolled back around the refusal
  - no new row in `events`
- Then repeat the **same message and confirmation as T** (`maintenance`).
  **Expect it to succeed.** A control that refuses everyone proves nothing.

### N10 — a conflicting `property_id` is refused on a multipart claim

*The refusal used to run before multer, so on a multipart request it judged a
body that did not exist yet.*

- As **T**, submit a completion for a real work item as `multipart/form-data`
  with a real photo **and** a form field `property_id=<another property's id>`.
- **Expect 403** — *"property authority is server-derived; a client-supplied
  property_id cannot select a different property."*
- **DB:** no new `work_proof_attachments` row and no new
  `work_completion_claims` row. The refusal runs after parsing but before the
  transaction, so the parsed image is discarded rather than stored.
- Repeat as **JSON** with the same conflicting `property_id`. **Expect 403.**
- Repeat with `property_id` set to **the correct** property. **Expect success** —
  a matching value is permitted and is still not the authority; the property
  used comes from the session and the loaded work row.
- Repeat with **no** `property_id` at all. **Expect success** — the ordinary case.
- **Assert unauthenticated callers never reach multer:** send a 5 MB multipart
  claim with **no** `x-staff-session`. **Expect 401**, and expect it *quickly* —
  authentication and module entitlement both run ahead of parsing.

### N11 — the database refuses a mis-scoped or mis-measured attachment

*Everything below is refused by `migrations/118` itself, through raw SQL that
never touches the service. Until this control runs, these are the only
constraints in the slice that no code has ever executed.*

Insert directly with `psql`, as the migration user, against the restored
baseline:

- A row whose `work_id`, `property_id` and `unit_id` are **each real** but do
  not belong together. **Expect** violation of `fk_wpa_work_scope`. This is the
  row three separate foreign keys used to allow.
- A row where `byte_size` disagrees with `octet_length(content)`, in both
  directions. **Expect** violation of `ck_wpa_size_matches_content`.
- A row larger than 5 MB. **Expect** the `byte_size <= 5 * 1024 * 1024` check to
  refuse it.
- A row whose `sha256` is 64 spaces, 64 uppercase hex characters, 63 characters
  or 65. **Expect** the format check to refuse each one.
- A correct row. **Expect it to be accepted** — the control must be able to pass.
- **Also confirm** `uq_utrw_id_property_unit` exists on
  `unit_triage_required_work`; without it the composite key cannot be created
  and migration 118 would fail at apply time.

### N12 — the API refuses to start with the photo path unwired

- Start the server with the attachment service not injected, and again with
  multer not injected.
- **Expect:** the process **fails to start**, naming the missing dependency and
  saying the completion photo could never be received or stored.
- **Assert:** it does **not** start and quietly serve a Complete button that can
  never close anything.
- Restore the wiring. **Expect a normal start.**

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

- **Storage scale.** The bytes live in Postgres — a deliberate Class 2 adapter
  for the pilot. Nothing here tests volume.
- **Concurrency beyond N1.** Acceptance and certification remain classified
  *unproven without Postgres* unless the extra probes in N1 are run.
- **Attachment lifecycle.** Proof is evaluated once, at claim time, and the
  verdict is stored. Nothing re-checks whether an attachment still exists.
- **Whether one attachment may satisfy two work items.** Unruled.
- **Anything about legacy units** with no triage evidence, or by-bed grain.

Record each of those five as still-open when reporting the run. A green
golden path is not a green product.
