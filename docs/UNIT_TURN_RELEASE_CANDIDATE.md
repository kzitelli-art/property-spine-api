# Unit Turn — release candidate

**Proof level: Built but dormant.**

Everything below is source-level or pure-function evidence. No Postgres was
contacted, no HTTP request was made, no file was uploaded, and no browser
rendered anything.

**Closure slice — the golden path can now finish.** A technician opens the
work, adds one completion photo, and presses Complete. The photo and the
completion commit in one transaction on one route. Migration 118 is written
and deliberately **unapplied**.

All three pressure-test FAIL findings are now closed.

---

## 1. Branches and SHAs

| Repo | Branch | Base | Head |
|---|---|---|---|
| API | `claude/unit-turn-release-candidate` | `b562339` (Build 6B) | see final report |
| App | `claude/unit-turn-release-candidate` | `f60511a` (Build 6B) | see final report |

The integration-audit commit `bf1015b` was cherry-picked onto the API branch.
The infrastructure-discovery checkpoint `a269fce` and the baseline intake kit
`51971b9` are **absent** — separately governed infrastructure, verified absent
by `git merge-base --is-ancestor`.

Current `origin/main` is API `21adf9e` / app `ae7abe3`, migration ceiling
**111**, migrations **112–118 free**. Cumulative integration is a
fast-forward; no synthetic rebase was performed.

---

## 2. Changed files after Build 6B

**API (9)**

| File | Change |
|---|---|
| `src/maintenance/work_proof.js` | **FIX 1** — a photo is a verified attachment, not a string; fails closed |
| `src/maintenance/work_acceptance_service.js` | **FIX 1** — resolves references against an optional, property-scoped attachment store |
| `src/agent/staff_agent_intent.js` | **FIX 3** — a concrete observed condition reaches initial triage |
| `src/surfaces/unit_turn_read.js` | **FIX 2** — emits server-computed `capabilities` |
| `src/surfaces/unit_turn.js` | **FIX 2** — passes server-derived `allowed_modules` into the read |
| `tests/work_acceptance_proof.js` | Build 3 proof updated to verified attachments |
| `tests/operator_language_proof.js` | allowlist correction; Build 3 range pinned |
| `tests/release_candidate_proof.js` | pressure test + the three fixes + new failure modes |
| `docs/UNIT_TURN_RELEASE_CANDIDATE.md`, `docs/UNIT_TURN_THIN_LIVE_PROOF.md` | this file and the acceptance script |

Plus `docs/BUILD_1_6B_INTEGRATION_READINESS.md`, carried by the cherry-pick.

**App (2)**

| File | Change |
|---|---|
| `index.html` | Maintenance → Turnovers entry; root mount removed |
| `unit-turn-page.js` | mount guard; four honest states; **capability-gated controls**; **fake photo box removed** |

**ONE MIGRATION ADDED — 118, narrow and deliberately unapplied.** Sequence
rules, readiness meaning, availability guard order and the agent's three-intent
scope are untouched. Two things changed deliberately and are the point of this
revision: the **proof gate** (a string no longer closes work) and the
**capability surface** (controls render from a server decision).

---

## 3. Harness totals

```
$ for t in unit_triage_proof unit_turn_scope_proof work_acceptance_proof \
           readiness_certification_proof staff_agent_proof unit_turn_page_proof \
           operator_language_proof release_candidate_proof; do node tests/$t.js; done

  unit_triage_proof                  passed=92   failed=0
  unit_turn_scope_proof              passed=113  failed=0
  work_acceptance_proof              passed=83   failed=0
  readiness_certification_proof      passed=127  failed=0
  staff_agent_proof                  passed=154  failed=0
  unit_turn_page_proof               passed=104  failed=0
  operator_language_proof            passed=247  failed=0
  release_candidate_proof            passed=396  failed=0
  work_proof_photo_proof             passed=209  failed=0
  ─────────────────────────────────────────────────────────
  TOTAL                              1525        0
```

Up from 1206 → 1300 → **1525**. Every assertion that previously recorded a
defect has been **re-pointed at the fixed behaviour**, not deleted:
`work_acceptance_proof` now proves that `" "`, `"x"`, `"photo.jpg"` and a
random UUID all fail while a verified attachment succeeds;
`release_candidate_proof` §12 now proves five concrete conditions classify
while four vague ones still ask; §8 now proves five capability cases across
three operator shapes.

---

## 4. Primary navigation

```
Property Home → Maintenance → Turnovers → turn list → Unit Turn page
```

- `openMaintenanceModule('turns')` → `renderMaintenanceTurnPage(st)`, which
  creates `#psTurnList` / `#psUnitTurnPage` inside the Maintenance sub-page and
  boots the Build 6A module.
- **No document-root mount for the primary surface.** It was removed. The
  module no longer auto-boots on `DOMContentLoaded` and no-ops entirely when
  unmounted, so loading the script costs nothing and fires no request.
- **No new top-level module** — no Unit Turn, Readiness, Staff Agent or AI
  entry exists.
- Management attention is `?attention=true` on the same list, opening the same
  page. Asserted: no separate management endpoint.
- The legacy turnover dashboard is **retained and addressable** at
  `openMaintenanceModule('turns_legacy')`, deliberately not an equal primary
  choice. The Build 1–5 diagnostic doors keep their root mounts for QA.

---

## 5. Live-first status

| Seam | Turn list | Unit Turn page |
|---|---|---|
| **S1 identity** | inherited dependency | inherited dependency |
| **S2 authoritative property scope** | inherited dependency | inherited dependency |
| **S3 live service** | source-complete, runtime-unproven | source-complete, runtime-unproven |
| **S4 honest empty / unavailable** | source-complete, runtime-unproven | source-complete, runtime-unproven |

Verified absent from both surfaces: fixture libraries, `DEMO_DB`,
`demoRespond()`, minted demo sessions, client-selected property, offline
fallback after HTTP failure. The loader itself states *"No fixture fallback —
live-required resource"* and throws on network error, HTTP error and malformed
body.

**S4 now distinguishes four states** where two previously collapsed into a
blank panel: loading · honest empty (naming *which* zero) · unavailable with a
retry · not signed in.

**S1/S2 are inherited and not repaired here.** The page checks
`__psLive.hasSession()` and never names a property; the server derives property
from the session and refuses a client-supplied `property_id`. Whether a real
session carries the right assignment is a runtime fact this thread cannot
establish.

---

## 6. Pressure-test verdicts

| § | Section | Verdict |
|---|---|---|
| 5 | canonical truth boundaries | **PASS** |
| 6 | one governed work list | **PASS** |
| 7 | flow liveness | **PASS** |
| 8 | authority | **PASS** *(was FAIL — fixed)* |
| 9 | idempotency and concurrency | **UNPROVEN** |
| 10 | history and correction | **PASS** |
| 11 | availability precedence | **PASS** |
| 12 | staff-agent boundary | **PASS** *(was FAIL — fixed)* |
| 13 | UI simplification | **PASS** |
| 15 | photo proof | **PASS** — source-complete *(was FAIL, then PARTIAL)* |
| 16 | live-first seams | **UNPROVEN** |
| 17 | by-bed grain | **PASS** |
| 18 | new failure modes from the cleanup | **MIXED** — 7 prevented, 1 unproven |

### §5 canonical truth boundaries — PASS

No door, read or pure module writes a domain table. Every one of the eight
distinctions is enforced by the layer that owns it, and `'accepted'` is not a
work status. Missing evidence is never positive evidence: triage readiness has
no `ready` value, a partial inspection blocks, and `NULL disturbs_painted_surfaces`
is treated conservatively. **Exceptions: none.**

*Consequence if wrong:* two doors would mean two meanings for one operating
action. *Action:* none. *When:* n/a.

### §6 one governed work list — PASS

One `unit_triage_required_work` table; four canonical writers (Build 1 triage,
Build 2 scope, Build 3 acceptance, Build 4 failed walk); one read. Build 5
owns no work table and inserts none. Inherited unplaced work sits **inside**
the flow and blocks the readiness walk. *Action:* none.

### §7 flow liveness — PASS

15 constructed states. Every one yields a controlling next action or a named
manager exception. No state disappears, falsely completes, or leaves readiness
wrongly unblocked, and every controlling action carries a `why`. See §7 matrix
below. *Action:* none.

### §8 authority — **PASS** *(was FAIL; hardened again after a second finding)*

**The ruled model, by operator shape.** Not by door — by who the person is.

| Operator | Read turn | Operate work | Read proof photo | Certify readiness |
|---|---|---|---|---|
| `maintenance` only | ✓ | ✓ | ✓ | ✗ |
| `management` only, **no** eligible manager assignment or delegation | ✓ | ✗ | ✓ | ✗ |
| `management` only, **with** eligible manager assignment or explicit delegation | ✓ | ✗ | ✓ | ✓ when the gate is actionable |
| `maintenance` **+** `management` with eligible assignment or delegation | ✓ | ✓ | ✓ | ✓ when the gate is actionable |
| neither module | ✗ | ✗ | ✗ | ✗ |

Read the columns as three different questions, not one ladder:

- **Operate** is `maintenance`. A manager does not gain it by outranking anyone.
- **Read proof** is `maintenance` **or** `management`. Looking at evidence for a
  closed job is a read, and a manager reviewing work must be able to do it.
- **Certify** runs the *other* way: it is a management authority, and holding
  `maintenance` never confers it. It additionally needs an eligible manager
  assignment or an explicit `primary_for_modules` delegation **and** an
  actionable readiness gate. Its implementation is unchanged and correct.

**FINDING (hardening): the conversational door was weaker than the structured one.**
The structured completion route required `maintenance`. The staff-agent door
admits `maintenance` **or** `management`, and a `work_completion` proposal
confirmed through it called `workAcceptanceService.claimCompletion` directly. A
management-only operator could therefore close a job by talking to the agent
that the work door would have refused them. Two doors, two answers to *may this
person close a job*, and the conversational one won.

**Fixed at the canonical boundary, not on a route.** `claimCompletion` now calls
`assertMaintenanceOperator(client, { property_id: w.property_id, user_id:
actor_user_id })` — property from the **loaded work row**, actor from the
authenticated session — before the photo is stored and before anything is
written. Every caller passes it: the structured door, the staff agent, and
anything written later that nobody has thought of yet. A gate on a route governs
that route; a check in the service governs the fact.

A refused completion returns **403**, writes no attachment, no claim, no event,
closes no obligation, changes no work state, and leaves the proposal
unconfirmed — the agent's transaction rolls back around it. The message says
that management access can read the turn and view completion photos but cannot
record that work was finished.

**Management keeps the rest of the staff agent.** Reporting conditions and scope
through the agent stays available where those actions are governed. Only
recording a completion is refused.

The aggregate read emits server-computed capabilities:

```
capabilities: {
  may_operate_work,                 // maintenance module at this property
  may_read_proof,                   // maintenance OR management
  may_perform_readiness_walk,       // gate actionable + authorised + not yet certified
  may_view_management_attention,    // management module
  basis, why_no_work_controls, why_no_readiness_walk, enforcement_note
}
```

`allowed_modules` arrives from `req.operator` — the session's **active**
assignment row — and never from the request body. With nothing resolved it
**fails closed**: no modules, no controls.

Five capability cases asserted behaviourally: maintenance-only, management-only,
both, empty, and not-passed-at-all.

The page gates every work control on `capabilities.may_operate_work` and
**reads no module, role or title** — asserted. When a control is absent the page
says why rather than silently omitting it.

**Hiding is not the enforcement, and neither is the door.** All three Build 1–3
write doors are asserted to still enforce `maintenance` themselves; the service
now refuses independently of all of them. Negative control **N4** in the thin
live proof calls the accept route directly as a management-only operator and
requires a 403; **N9** does the same for a staff-agent completion confirmation.

*Action:* none before live proof. *When:* N4 and N9 exercise it.

### §9 idempotency and concurrency — **UNPROVEN**

| Write | Classification |
|---|---|
| proposal confirmation | **duplicate-safe** |
| completion claim | **duplicate-safe** (a second claim is a second attributed row) |
| work reopening | **duplicate-safe** |
| failed final walk | **duplicate-safe** |
| work acceptance | **unproven without Postgres** |
| readiness certification | **unproven without Postgres** |
| readiness correction / revocation | **state-checked but not idempotent** |

**Nothing classifies as unsafe.** Proposal confirmation is the strongest: a
`select … for update` row lock, an in-transaction status recheck, and a partial
unique index `uq_sap_one_confirmation … where status = 'confirmed'`.

Acceptance and certification are append-only supersede rails whose "live" row
is derived by a `not exists (… supersedes_id …)` read. That is correct *if*
Postgres serialises two concurrent inserts. **This harness cannot establish
that**, and the classification says so rather than claiming green.

UI disabling is **not** counted: `S.busy ? " disabled" : ""` is asserted to be
cosmetic, and every server guard exists independently of the client.

*Consequence if wrong:* two acceptances or two live certifications for one
unit — the second silently winning, with no operator aware.

*Action:* the thin live proof's negative control #1 exercises duplicate
confirmation. Add a concurrent-acceptance and concurrent-certification probe
once a database exists. *When:* **before live proof is called complete.**

### §10 history and correction — PASS

Nothing is deleted or edited in place. Original staff words are verbatim and
immutable; scope, acceptance and certification are supersede rails; a
correction must state a reason; a confirmed proposal is immutable.

The five questions are answerable from columns that exist: *what did we
believe* (`original_text`, `body`, `proposed`), *who corrected it*
(`confirmed_by_user_id`, `actor_user_id`), *why* (`reason`,
`correction_reason`, `withdrawn_reason`), *what is true now* (`supersedes_id`),
*what changed* (`resulting_kind`/`resulting_id`, `readiness_walk_id`,
`turn_scope_id`). *Action:* none before browser proof.

### §11 availability precedence — PASS

The guard chain is ordered, and every guard that outranks the triage overlay
returns before it: `overlapping_lease_claims`, `out_of_service`,
`opening_source_claims_occupied_without_lease`,
`lease_commenced_awaiting_move_in_funds`, `committed_to_a_future_resident`,
`spanning_lease`, `possession_not_returned`. Certification is a **deliberate
no-op fall-through**, so use-type guards still run after it and a certified
unit never overrides another axis. A guard does not erase the certification —
`certified_ready` stays on the row — and the page names the remaining blocker
and distinguishes *physically ready* from *marketable*.

Units with no triage evidence fall straight through to prior behaviour.
*Action:* none.

### §12 staff-agent boundary — **PASS** *(was FAIL)*

Vocabulary unchanged and still tight: confirmable `initial_triage`,
`turn_scope`, `work_completion`; non-confirmable `redirect`, `unclear`; four
retired intents unreachable, including from stored rows, verified by driving
seven legacy intents through `confirmProposal` against recording doubles with
**no canonical service reached**.

**The advertised sentence now works.** A *concrete thing* in a *concrete state*
reaches initial triage using the page's open unit:

| Message | Result |
|---|---|
| `There are cockroaches behind the refrigerator.` | `initial_triage` |
| `The bedroom window is cracked.` | `initial_triage` |
| `There is water under the kitchen sink.` | `initial_triage` |
| `The bathroom door does not latch.` | `initial_triage` |
| `The living-room carpet is stained.` | `initial_triage` |
| `The outlets in the bedroom are dead.` | `initial_triage` |
| `It is bad.` | `unclear` |
| `Needs work.` | `unclear` |
| `There is an issue.` | `unclear` |
| `I fixed it.` | `unclear` |

The gate is **both halves**: a nameable object from a bounded vocabulary, AND
either an observable state, a negated verb, or a "there is/are" presence claim.
`"There is an issue"` has the presence claim and no nameable object, so it
still asks. This is not vague-language guessing.

**It stays an observation.** Every condition proposal states that vacancy is
not assumed and that one condition is not a complete inspection. The Build 1
interpreter reads `vacancy = uncertain` when the words do not say, and
`inspection_completeness` is never upgraded. Nothing is recorded until a human
confirms through the existing Build 1 path.

**Ordering holds and is asserted from source:** completion is checked before
the condition branch (`The bathroom door is fixed.` → `work_completion`;
`The bathroom door does not latch.` → `initial_triage`), and the condition
branch is checked before scope, so an observed defect is never promoted to work
somebody has decided to do.

A condition with no unit anywhere still asks **"Which unit?"**.

*Action:* none. *When:* n/a.

### §13 UI simplification — PASS

Two screens, two containers, no modal, no drawer, no navigation away.
Completing work is **three clicks** from the turn list: open unit → open panel
→ Complete. The unit is selected once. A redirect opens the item in place.

The four questions are each answered by a named element: *what is happening*
(status block + summary), *what is uncertain* (unknowns, clarifications,
"Unknown — no confirmed walk"), *what is mine* (owner / `UNASSIGNED`), *what
happens next* (controlling next action).

**No internal name is printable**: `stage_decision_required`, every intent
name, `clarification_required`, `unclear`, `property_id`, `unit_id`, snake_case
in a rendered label, and service names are each asserted absent from the
page's printable strings. *Action:* none.

### §15 photo proof — **PARTIAL**. See §10 of this document.

### §16 live-first seams — **UNPROVEN**. See §5 of this document.

### §18 new failure modes from the cleanup — MIXED

Eight modes the three fixes could have introduced, each classified rather than
assumed away.

| Mode | Status |
|---|---|
| completion submitted twice with the same attachment | **duplicate-safe** — each submission appends its own attributed claim; the second closes nothing new |
| capabilities stale between read and write | **prevented** — capabilities are recomputed every read, never cached; every write re-resolves the session |
| assignment deactivated after page load | **prevented at the write** — `resolveStaffSession` requires `active = true`; the rendered page is stale, the authority is not |
| condition language that also reads like completion | **prevented by ordering** — asserted from source and behaviourally |
| attachment uploaded, completion transaction fails | **unproven without Postgres** — the claim rolls back; a stored blob would be orphaned with no cleanup path. Cannot occur today |
| attachment deleted after completion | **unproven — and NOT re-verified.** Proof is evaluated once and the verdict stored. A future upload design must make the reference immutable or re-derive proof on read |
| a sentence names more than one unit | **PARTIALLY UNPROVEN** — the first unit-shaped token wins and the second is silently ignored. Nothing wrong is recorded, but the operator is not told |
| an attachment id reused across two work items | **unproven — no store exists.** `resolveForProperty` is property-scoped, not work-scoped. Whether one photo may prove two items is a product question to rule when the primitive is built |

*Action:* the last four belong to whoever builds the attachment primitive,
except the multi-unit one, which needs a ruling on whether to ask or to take
the first. *When:* after browser proof.

### §17 by-bed grain — PASS

Captures are unit facts and stay unit facts. No Build migration references
`spaces`. The Builds never write `turnovers`. The overlay is scoped to
`if (p.triage)`, so a unit with no triage evidence keeps prior behaviour and
the existing by-bed derivation defect is neither used nor worsened. The defect
is named in source and **not repaired here**. *Action:* none in this thread.

---

## 7. State-transition / liveness matrix

`w=walk blocked`. Every row yields a controlling action or a named exception.

| State | open | actionable | blocked | w | Controlling next action | Manager decision |
|---|---|---|---|---|---|---|
| initial walk assigned, incomplete | 0 | 0 | 0 | ✓ | Confirm the turn scope | — |
| complete inspection, unstaged inherited work | 1 | 1 | 0 | ✓ | Place "…" in the turn sequence | `inherited_work_not_placed` |
| partial inspection | 1 | 1 | 0 | ✓ | do work | — |
| unknown stage, partial scope | 1 | 1 | 0 | ✓ | do work | — |
| no eligible owner | 1 | 1 | 0 | ✓ | Assign or accept … | `no_eligible_owner` |
| work accepted while blocked | 2 | 1 | 1 | ✓ | do the unblocking repair | — |
| accepted work, no due commitment | 1 | 1 | 0 | ✓ | do work | — |
| proof-short completion (still required) | 1 | 1 | 0 | ✓ | do work | — |
| unable to complete (still required) | 1 | 1 | 0 | ✓ | do work | — |
| scope correction (superseded drops out) | 1 | 1 | 0 | ✓ | do work | — |
| withdrawn work does not block | 0 | 0 | 0 | ✗ | Schedule the final readiness walk | — |
| reopened repair after paint | 2 | 1 | 1 | ✓ | the repair | — |
| dirty work reopened after final cleaning | 2 | 1 | 1 | ✓ | the repair | — |
| all work resolved, scope complete | 0 | 0 | 0 | ✗ | Schedule the final readiness walk | — |
| no confirmed scope at all | 1 | 1 | 0 | ✓ | do work | — |

Plus: the readiness gate is **not** actionable while work is open, **is**
actionable when the flow is clear, and an actionable gate is still not
readiness.

**No state disappeared, falsely read complete, wrongly unblocked readiness, or
required the operator to infer the sequence.**

---

## 8. Authority matrix

| Actor | Read turn | Operate a turn | Read proof photo | Certify readiness | Source |
|---|---|---|---|---|---|
| Maintenance technician (`maintenance`) | ✓ | ✓ all six doors | ✓ | ✗ *"requires management module access"* | `readiness_service.js` |
| Management-only (`management`) | ✓ | **✗ — refused by the canonical service, not only the door** | ✓ | depends on title/delegation | `assertMaintenanceOperator` |
| Management-only, **via the staff agent** | ✓ | **✗ 403 — the conversational door is no longer weaker** | ✓ | depends on title/delegation | `assertMaintenanceOperator` |
| Management access, no assignment | ✗ | ✗ | ✗ | ✗ *"no active assignment at this property"* | `resolveWalkAuthority` |
| Manager title, no management access | ✗ | ✗ | ✗ | ✗ *"requires management module access"* | `resolveWalkAuthority` |
| Manager at another property | ✗ | ✗ | ✗ | ✗ — the query is property-scoped | `resolveWalkAuthority` |
| Inactive assignment | ✗ | ✗ | ✗ | ✗ | `resolveWalkAuthority` |
| Work performer, no readiness authority | ✓ | ✓ | ✓ | ✗ — performing grants nothing | asserted |
| Work performer who also holds authority | ✓ | ✓ | ✓ | ✓ — held independently, not earned | asserted |
| Senior property manager + management | ✓ | only with `maintenance` | ✓ | ✓ ladder rank 1 | `AUTHORITY_LADDER` |
| Assistant property manager + management | ✓ | only with `maintenance` | ✓ | ✓ ladder rank 2 (delegated) | `AUTHORITY_LADDER` |
| Delegated via `primary_for_modules` | ✓ | only with `maintenance` | ✓ | ✓ explicit delegation | `resolveWalkAuthority` |

Title matching asserted: *Senior Property Manager*, *Assistant Property
Manager*, *Property Manager*, *Asst. Manager* reach the ladder; *Maintenance
Technician*, *Leasing Consultant*, *Regional Director* and blank do not.

**Module access ≠ readiness authority. Title ≠ readiness authority. Performing
work ≠ readiness authority.** And **rank ≠ operating authority** — a senior
property manager without `maintenance` cannot record that a job is finished, in
either door. **The agent creates no weaker path**, and that is now enforced by
`claimCompletion` itself rather than asserted about the doors.

---

## 9. Component class ledger

| Component | Class | Exit condition |
|---|---|---|
| Migrations 112–117 | **1** permanent | — |
| Migration 118 — attachment contract (columns, keys, checks) | **1** permanent | — |
| Migration 118 — `content bytea` storage | **2** temporary adapter | **Move behind object storage when real proof volume or multi-property operation makes database storage materially burdensome.** Attachment ids, the authority contract and the completion API are unchanged when that happens — only where the bytes sit. |
| `assertMaintenanceOperator` in the completion service | **1** permanent | — |
| Triage interpreter (Build 1, pure) | **1** permanent | — |
| Triage canonical service | **1** permanent | — |
| Turn-scope interpreter + service | **1** permanent | — |
| Turn sequence engine (pure) | **1** permanent | — |
| Work acceptance / completion service | **1** permanent | — |
| Work proof (pure) | **1** permanent | — |
| Readiness gate (pure) + readiness service | **1** permanent | — |
| Staff-agent classifier + service | **1** permanent | — |
| Unit Turn aggregate read | **1** permanent | — |
| Turn list + Unit Turn page | **1** permanent | — |
| Management-exception filter | **1** permanent | it is a query parameter on one list, not a surface |
| **Free-text role-title adapter** (`AUTHORITY_LADDER`) | **2** temporary adapter | **Delete when `property_team_assignments` carries a structured authority field.** Matching a manager by regex on a free-text title is a bridge, not a model. |
| **`primary_for_modules` readiness delegation** | **2** temporary adapter | **Delete when an explicit readiness-authority grant exists.** Reusing "which modules this user owns" as "may certify" is a reuse, not a definition. |
| Build 1–5 diagnostic API routes | **3** diagnostic | Retire after browser proof shows the two screens cover every operator need. Not before. |
| Build 1–5 diagnostic app doors | **3** diagnostic | as above |
| Build 1–5 document-root mount containers | **3** diagnostic | Remove with the doors they serve. |
| Unit Turn document-root mount | **removed in this RC** | — |
| Legacy turnover dashboard (`turns_legacy`) | **3** diagnostic | Retire with the Build 1–5 doors. |
| The seven Build harnesses + the RC harness | **3** test infrastructure | — |
| Baseline intake kit (`51971b9`) | **3** infrastructure, separately governed | Not in this release candidate. |

**No component is class 4, and no component is "temporary" without an exit
condition.**

---

## 10. Photo proof — **PASS, source-complete**

### The path

```
technician opens actionable work
  → Add completion photo  (camera or picker, one image)
  → small preview, "Photo ready"
  → Complete work
  → POST /operator/turn-work/:workId/claim   multipart, field `photo`
  → session authenticated · property derived · maintenance verified
  → work loaded and property-checked
  → image validated by its BYTES
  → work_proof_attachments row inserted
  → proof evaluated against that attachment id
  → work_completion_claims row inserted
  → work closed
  → COMMIT
```

**One route. One transaction. One receipt.** There is no `/upload`, no
`/claim-with-photo`, no `/complete-with-proof`, and no two-step submit.

### Migration 118 — `work_proof_attachments`

| Column | |
|---|---|
| `id` | uuid pk |
| `property_id` | **not null** → `properties` |
| `unit_id` | **not null** → `units` |
| `work_id` | **not null** → `unit_triage_required_work` |
| `uploaded_by_user_id` | **not null** → `users` |
| `original_filename` | text, kept for a human, never trusted |
| `mime_type` | check `image/jpeg · image/png · image/webp` |
| `byte_size` | check `> 0` |
| `sha256` | check `char_length = 64` |
| `content` | `bytea` — **Class 2 adapter** |
| `created_at` | server time |

All three scopes are NOT NULL foreign keys, so "one photo closing an unrelated
job" is **unrepresentable**, not merely refused. There is no `status`, no
`caption`, no `deleted_at`, no delete route.

**Classification.** The attachment *contract* is **Class 1, permanent**. The
`bytea` storage is **Class 2, temporary adapter**. *Replacement condition:*
move the bytes behind object storage only when real proof volume or
multi-property operation makes database storage materially burdensome —
preserving the same attachment ids, authority contract and completion API.

### File rules

Exactly one image. `image/jpeg`, `image/png`, `image/webp`. **5 MB.**

The type comes from the **magic bytes**, never the filename or the declared
`Content-Type`. A PDF named `photo.jpg` and declared `image/jpeg` is refused; a
PNG declared as JPEG is stored as PNG. A SHA-256 digest of exactly the stored
bytes is recorded. Zero-byte, oversized and second files are refused with
operator-readable messages — and none of them writes a row.

### The governed read

`GET /operator/turn-work/:workId/proof/:attachmentId` — the only way bytes
leave. Staff session required; **maintenance or management** may read (a
manager reviewing a closed job needs the evidence); property from the session;
attachment → work → property re-checked in the query. Cross-property,
cross-work and nonexistent all return the **same 404**, so the response never
confirms somebody else's attachment exists. `nosniff`, `no-store`, sandboxed
CSP, `inline`. No list route. No delete route.

The Unit Turn read returns only `attachment_id`, `mime_type`, `byte_size`,
`uploaded_at`, `uploaded_by`, `view_path` — never bytes. The page fetches the
image with the session header and renders a blob, because an `<img src>`
cannot carry it.

### Atomicity

`storeForWork` and `resolveForWork` both take the **caller's client**. The
attachment service never opens a connection and never sees a pool. Exercised
against a recording double:

- happy path → attachment insert, then resolution, then the claim, **in that
  order, on one client**
- claim insert fails → the error propagates; the attachment was on the same
  transaction and rolls back with it. **No orphan, and therefore no cleanup
  path to get wrong.**
- attachment insert fails → **no completion claim is written at all**
- no photo → the claim is still **recorded and attributed**, the work stays
  **open**, and the shortfall names the missing photo

### What is still not proven

That Postgres enforces the foreign keys, the check constraints and the
rollback. Written and reachable; unproven until the baseline arrives.

## 11. Simplifications

### Implemented

1. **The primary surface no longer mounts at the document root.** One fewer way
   to reach an operator workflow, and the element-id collision that a second
   mount would have caused cannot happen.
2. **The module no longer auto-boots.** It previously fired a live turn-list
   request on every page load for a surface nobody had opened.
3. **Four surface states replace two.** Loading, honest empty, unavailable +
   retry, and not-signed-in were previously collapsed into a blank panel or a
   bare error.

### Recommended, not implemented

| Recommendation | Why not now |
|---|---|
| Align the six door gates and emit `may_operate` (§8) | authority-rule change |
| Rule the bare-condition classification (§12) | agent-scope change |
| Session-scoped attachment primitive (§10) | new primitive, outside this thread |
| Retire `AUTHORITY_LADDER` regex matching | needs a structured authority field |
| Retire `primary_for_modules` delegation reuse | needs an explicit readiness grant |

### Considered and rejected

- **Retired-intent machinery in the agent** — `RETIRED_INTENTS` and
  `RETIRED_REFUSAL` look like dead weight. They are not: rows written before
  Build 6B may still carry those intents, and the refusal names the structured
  door that owns the act. Deleting them would make an old row fall through to
  "cannot be confirmed" with no explanation. **Keep.**
- **Diagnostic doors duplicating a primary action** — checked: **no duplicate
  write route exists** across all Build doors. They are alternate *views*, not a
  second business path. They are ugly-adjacent, not a second meaning of truth.
  **Keep until browser proof.**
- **Management exceptions** — confirmed a filter: one endpoint, a query
  parameter, and each row opens the same page. **Keep.**
- **Four unread aggregate-read fields** (`physical_readiness`, `certification`,
  `actions`, `final_walk`) — emitted but not rendered. `actions` is the
  documented delegation map the Build 6A harness asserts on. They create no
  second meaning. **Keep**, revisit after browser proof.

### Deferred display-language leaks (§14) — all four deferred

| Leak | Decision | Reason |
|---|---|---|
| raw work status (`complete`/`blocked`/`actionable`) | **leave for browser observation** | no server-computed label exists; a client map is the framework we must not build |
| generic receipt-key de-snaking | **leave for browser observation** | needs `receipt.lines` of finished sentences — a server shape change |
| diagnostic proposal-key de-snaking | **leave for browser observation** | diagnostic surface, lowest priority |
| raw vacancy values | **leave for browser observation** | *see below* |

The vacancy case looked fixable and is not, and the reason is worth stating:
`VACANCY_LABEL` **already exists** — `src/maintenance/unit_triage.js:92-96`,
mapping `occupied_or_someone_remains` → *"Someone remains in the unit"*. It is
declared **inside a route handler closure** and is not exported. Reaching it
from `unit_turn_read.js` means restructuring a Build 1 door, which exceeds the
allowed change list and would require weakening the very assertion that proves
Build 6B touched no other source. The words exist; their **location** is the
blocker. Smallest real fix: lift the map to module scope, export it, import it.
One file, no new copy, no framework.

---

## 12. Known legacy defects outside scope

1. **A legacy unit with no triage evidence may read ready from absent turnover
   evidence.** Named in `src/surfaces/availability_read.js`. Preserved
   deliberately. Not repaired here.
2. **By-bed grain in turnover/readiness derivation** — a unit-level turnover may
   be applied to every rentable bed. Ruled: captures are correct unit facts;
   the defect is downstream. Not repaired here.
3. **Migrations 001–087 cannot apply from a clean database.** The reason live
   proof needs a baseline. Not repaired here.
4. **`/intake/media/:id` is password-gated**, not session-scoped — see §10.

---

## 13. Baseline dependency and remaining runtime prerequisites

Blocked until `spine_schema_baseline.sql`, `spine_schema_migrations.sql` and
`manifest.txt` arrive (see `docs/RUNTIME_BASELINE_HANDOFF.md`, kit frozen at
`51971b9`):

restore an isolated database → verify ledger/object agreement → check live
migration collisions → apply pending Build migrations → run
`docs/UNIT_TURN_THIN_LIVE_PROOF.md`.

### Runtime prerequisites

**Known from source:** `DATABASE_URL`; an authenticated staff session
(`x-staff-session`); an active `property_team_assignments` row; `maintenance`
module access to **operate and to record a completion**; `maintenance` **or**
`management` to read the turn and view a completion photo; `management` +
eligible manager assignment or explicit delegation to certify readiness;
`gen_random_uuid()`; migration ceiling ≥ 117; pinned API origin
`https://property-spine-api.onrender.com`.

**Mandatory wiring.** The API now refuses to start unless multer and all three
attachment-service functions (`storeForWork`, `resolveForWork`, `readForWork`)
are injected. A deployment missing either is one where the primary completion
path can never succeed — the Complete button would be present and no photo
would ever be stored — so it fails loudly at construction instead of quietly at
6pm in a unit. This proves the **source composition** is complete. It proves
nothing about migration 118 existing in any database.

**No new environment variable. No external photo storage. No background
process.** The Build-added source files reference zero `process.env` values;
the completion photo lives in Postgres `bytea` as a declared Class 2 adapter.

**Assumed:** `gen_random_uuid()` exists on the baseline (the verifier checks
before anything is applied); the Render deployment serves the same database the
baseline is exported from.

**Still unknown:** the live ledger's contents; whether 112–118 are free *there*;
whether any real person carries the module permissions the golden path needs.
Migration 118's number is **provisional** — correct only if the live ceiling is
really 117, which the baseline verifier decides.

**No configuration value has been manufactured anywhere in this document.**

---

## 14. Proof level

> **Source-complete, Built but dormant.**

1676 assertions across nine harnesses, all source-level, pure-function, or
against recording doubles. No section FAILs; §9 idempotency and §16 live-first
remain **UNPROVEN** and are named as such.

Nothing in Builds 1–6B or the closure slice has recorded a real fact about a
real unit. Nothing here may be described as live, deployed, enforced or proven.

### What the hardening did and did not settle

| Claim | Status |
|---|---|
| A management-only actor cannot record a completion through **either** door | **source-complete** — enforced in `claimCompletion`, exercised against a recording client, unproven against Postgres |
| A conflicting `property_id` is refused on a **multipart** claim | **source-complete** — the real router's middleware order is asserted from the built router, not from a regex |
| Migration 118 refuses a cross-property or cross-unit attachment | **written only** — the composite key exists in the file; no server has parsed it |
| `byte_size` equals the stored bytes, ≤ 5 MB, digest is lowercase hex | **written only** — same |
| The API refuses to start with the photo path unwired | **source-complete** — the real module factory is constructed and observed to throw |

**"Written only" is not a synonym for done.** Five of the strongest guarantees
in this slice are constraint text in an unapplied migration. They become real at
negative control **N11**, and not one moment sooner.
