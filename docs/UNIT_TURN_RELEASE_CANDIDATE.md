# Unit Turn — release candidate

**Proof level: Built but dormant.**

Everything below is source-level or pure-function evidence. No Postgres was
contacted, no HTTP request was made, and no browser rendered anything. Three
pressure-test sections return **FAIL** and two return **UNPROVEN**; none of
those is a formality, and none is fixed by anything in this document.

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

**API (4)**

| File | Change | Category |
|---|---|---|
| `tests/operator_language_proof.js` | allowlist correction + RC doc paths | allowed #1 |
| `tests/release_candidate_proof.js` | **new** — the pressure test | allowed #7 |
| `docs/UNIT_TURN_RELEASE_CANDIDATE.md` | **new** — this file | allowed #7 |
| `docs/UNIT_TURN_THIN_LIVE_PROOF.md` | **new** — the acceptance script | allowed #7 |

Plus `docs/BUILD_1_6B_INTEGRATION_READINESS.md`, carried by the cherry-pick.

**App (2)**

| File | Change | Category |
|---|---|---|
| `index.html` | Maintenance → Turnovers becomes the entry; root mount removed | allowed #2 |
| `unit-turn-page.js` | mount guard; honest empty / unavailable + retry | allowed #2, #4 |

**No migration, no service, no interpreter, no door, no aggregate read was
modified.** Domain meaning, sequence rules, authority rules, completion
requirements, readiness meaning, availability guard order and agent scope are
all byte-identical to Build 6B.

---

## 3. Harness totals

```
$ for t in unit_triage_proof unit_turn_scope_proof work_acceptance_proof \
           readiness_certification_proof staff_agent_proof unit_turn_page_proof \
           operator_language_proof release_candidate_proof; do node tests/$t.js; done

  unit_triage_proof                  passed=92   failed=0
  unit_turn_scope_proof              passed=113  failed=0
  work_acceptance_proof              passed=76   failed=0
  readiness_certification_proof      passed=127  failed=0
  staff_agent_proof                  passed=154  failed=0
  unit_turn_page_proof               passed=104  failed=0
  operator_language_proof            passed=244  failed=0
  ─────────────────────────────────────────────────────────
  BUILD 1–6B cumulative              910         0
  release_candidate_proof            296         0
  ─────────────────────────────────────────────────────────
  RELEASE CANDIDATE total            1206        0
```

**910 / 0** is the expected Build 1–6B cumulative, met exactly, with the
allowlist correction included in the tested working tree.

The 296 release-candidate assertions include the three FAIL findings, asserted
as **facts about current behaviour** rather than suppressed. A harness that
went green by deleting the assertion that found something would be worse than
one that fails.

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
| 8 | authority | **FAIL** |
| 9 | idempotency and concurrency | **UNPROVEN** |
| 10 | history and correction | **PASS** |
| 11 | availability precedence | **PASS** |
| 12 | staff-agent boundary | **FAIL** |
| 13 | UI simplification | **PASS** |
| 15 | photo proof | **FAIL** |
| 16 | live-first seams | **UNPROVEN** |
| 17 | by-bed grain | **PASS** |

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

### §8 authority — **FAIL**

**Readiness authority is correct.** Three necessary conditions — active
assignment, management module access, and either an eligible manager title or
`primary_for_modules` delegation. Module access alone, title alone and
performing the work each grant nothing. The agent has no readiness write.

**The OPERATE gate disagrees across doors.**

| Door | Gate |
|---|---|
| `unit_triage.js` (B1) · `unit_turn_scope.js` (B2) · `work_acceptance.js` (B3) | **maintenance only** |
| `readiness.js` (B4) · `staff_agent.js` (B5) · `unit_turn.js` (B6A) | maintenance **or** management |

*Source:* `src/maintenance/unit_triage.js:65-73` and equivalents; contrast
`src/surfaces/unit_turn.js:34-40`.

*Failure scenario:* an operator whose `allowed_modules` is `['management']`
opens Maintenance → Turnovers, gets the turn list (6A admits management), opens
a unit, and is shown **Accept work**, **Complete work** and **Reopen** — every
one of which posts to a Build 1–3 door that returns 403. The page renders those
controls unconditionally and never reads `allowed_modules`.

*Consequence if wrong:* a manager sees controls that always fail. Not a truth
violation — nothing false is recorded — but it is the surface promising an
action the server will refuse, which is the same class of defect as a fake
number.

*Action:* rule which module may operate a turn, then align the six gates and
have the read emit a `may_operate` flag the page renders, exactly as it already
does for `may_walk`. **This is an authority-rule change and is therefore
documented, not implemented.**

*When:* **before live proof.** The thin golden path uses a maintenance
technician and a manager; if the manager is management-only, step 4 fails for
the wrong reason and the run is wasted.

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

### §12 staff-agent boundary — **FAIL**

**The vocabulary is correct and tight.** Confirmable: `initial_triage`,
`turn_scope`, `work_completion`. Non-confirmable: `redirect`, `unclear`.
All four retired intents — `work_acceptance`, `readiness_request`,
`failed_final_walk`, `correction` — are unreachable, including from stored
rows: seven legacy intents were driven through `confirmProposal` against
recording doubles and **no canonical service was reached**.

Classifier ordering holds: plurals match, "actually" scope corrections stay
`turn_scope`, a tie yields no work id, a photo with too little text is a
question, and "already painted" is not a readiness claim.

**But the box advertises a sentence it cannot read.** Purpose #1 is *"Report a
condition"* and the placeholder's own first example is
`There are cockroaches behind the refrigerator.` With a unit already open,
that classifies as **`unclear`**. So do *"The outlets in the bedroom are
dead."* and *"The bathroom door does not latch."*

*Source:* `src/agent/staff_agent_intent.js` — triage is gated on `S.vacancy`,
because Build 1 is **post-move-out initial triage**. A bare condition report
with no vacancy phrase reaches no branch and falls to `unclear`.

*Consequence if wrong:* an operator types the sentence the box suggested and is
asked "What did you want to record?". It is an **honest** failure — nothing
wrong is recorded, and it asks rather than guessing — but the surface
overpromises.

*Action:* rule whether a bare condition on an already-open unit should reach
triage, or whether the advertised purpose should read as the vacancy-scoped
thing it is. **Changing the classifier is an agent-scope change and is
therefore documented, not implemented.** The cheapest honest fix is copy: an
example that classifies.

*When:* **before live proof** if the golden path opens with a condition
report — the thin script therefore opens with a vacancy sentence.

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

### §15 photo proof — **FAIL**. See §10 of this document.

### §16 live-first seams — **UNPROVEN**. See §5 of this document.

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

| Actor | Operate a turn | Certify readiness | Source |
|---|---|---|---|
| Maintenance technician (`maintenance`) | ✓ all six doors | ✗ *"requires management module access"* | `readiness_service.js` |
| Management-only (`management`) | **✗ B1–B3, ✓ B4–B6A** — see §8 FAIL | depends on title/delegation | door gates |
| Management access, no assignment | ✗ | ✗ *"no active assignment at this property"* | `resolveWalkAuthority` |
| Manager title, no management access | ✗ certify | ✗ *"requires management module access"* | `resolveWalkAuthority` |
| Manager at another property | ✗ | ✗ — the query is property-scoped | `resolveWalkAuthority` |
| Inactive assignment | ✗ | ✗ | `resolveWalkAuthority` |
| Work performer, no readiness authority | ✓ operate | ✗ — performing grants nothing | asserted |
| Work performer who also holds authority | ✓ | ✓ — held independently, not earned | asserted |
| Senior property manager + management | ✓ | ✓ ladder rank 1 | `AUTHORITY_LADDER` |
| Assistant property manager + management | ✓ | ✓ ladder rank 2 (delegated) | `AUTHORITY_LADDER` |
| Delegated via `primary_for_modules` | ✓ | ✓ explicit delegation | `resolveWalkAuthority` |

Title matching asserted: *Senior Property Manager*, *Assistant Property
Manager*, *Property Manager*, *Asst. Manager* reach the ladder; *Maintenance
Technician*, *Leasing Consultant*, *Regional Director* and blank do not.

**Module access ≠ readiness authority. Title ≠ readiness authority. Performing
work ≠ readiness authority.** The agent creates no weaker path.

---

## 9. Component class ledger

| Component | Class | Exit condition |
|---|---|---|
| Migrations 112–117 | **1** permanent | — |
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

## 10. Photo proof — **FAIL**

The single most serious finding. Traced end to end:

| Step | Status |
|---|---|
| operator selects photo | **missing** — there is no `type="file"` anywhere in the page |
| browser processes file | **missing** — no `FileReader`, no `FormData`, no `.files[]` |
| upload endpoint / storage service | **missing** — the Build calls none |
| durable reference | **missing** — `photos text[]` holds whatever string was typed |
| completion claim | **exists** — `proof_photos: [<typed string>]` |
| proof read | **exists** — `evaluateProof` counts `photos.length` |
| Unit Turn page | **exists** — renders `proof_shortfall` |

**The control labelled "Photo reference" is a text input.** No file is chosen,
no bytes move, nothing is stored.

### The defect, executed

```
node -e "const P=require('./src/maintenance/work_proof'); …"

  no photos              satisfied=false  Missing a completion photo.
  ONE TYPED CHARACTER    satisfied=true   none      ← closes the work
  a single SPACE         satisfied=true   none      ← closes the work
  real-looking ref       satisfied=true   none
  photo, no sentence     satisfied=false  Missing a short confirmation that it works.
```

The module already knows the difference between evidence and a keystroke **for
text** — `functional_confirmation` shorter than 3 characters is refused with
*"A confirmation must be a sentence, not a keystroke."* The same care is not
applied to photos, because the array is only counted.

*Consequence:* work closes as **proof-satisfied** with no evidence, and the
Unit Turn page, the readiness gate and the availability read all treat it as
genuinely closed. That is a confident wrong number in the one place the whole
build sequence exists to prevent one.

### An attachment primitive already exists — and is not used

`main` carries a governed one: `multer` memory storage (`server.js:62`, 25 MB),
the `intake_media` table (`migrations/014_intake.sql` — `mime`, `byte_size`,
`bytes bytea`, `source_url`), and a serving route
`GET /intake/media/:id` (`src/onboarding/intake.js:332`).

- **Build 3 does not reference it.** **Build 6A does not reference it.**
- It is **password-gated**, not staff-session scoped: the intake page renders
  `<img src="/intake/media/<id>?password=…">`. It cannot be reused as-is for
  an operator surface without a session-scoped read.

**Do not create a second upload architecture.**

### Verdict and action

> **"Complete with photo" is not an operational flow.** The UI control pretends
> an upload occurred, and the proof gate can be satisfied by a keystroke.

*Recommended action, smallest separately-owned prerequisite:*

1. A **session-scoped attachment primitive** — `POST` multipart returning a
   durable id, and a `GET` that authorises against the staff session and the
   property, reusing `intake_media` rather than inventing storage.
2. `work_completion_claims.proof_photos` then holds **references that resolve**,
   and `evaluateProof` validates resolvability rather than counting.
3. The page's text input becomes a file input.

**None of that is done here.** Steps 2 and 3 change completion requirements and
domain meaning, which §20 forbids; step 1 is a new primitive outside this
thread. It is a separately owned prerequisite, and it is **load-bearing**: until
it exists, every "proof-satisfied" completion is unverified.

*When:* **before live proof** if the golden path is to mean anything at its
proof step. The thin script therefore captures the typed value **and** flags
the step as not-yet-real.

---

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
module access to operate and management + title/delegation to certify;
`gen_random_uuid()`; migration ceiling ≥ 111; pinned API origin
`https://property-spine-api.onrender.com`.

**No new environment variable. No photo storage. No background process.** The
18 Build-added source files reference zero `process.env` values.

**Assumed:** `gen_random_uuid()` exists on the baseline (the verifier checks
before anything is applied); the Render deployment serves the same database the
baseline is exported from.

**Still unknown:** the live ledger's contents; whether 112–117 are free *there*;
whether any real person carries the module permissions the golden path needs.

**No configuration value has been manufactured anywhere in this document.**

---

## 14. Proof level

> **Built but dormant.**

1206 assertions across eight harnesses, all source-level or pure-function.
Three sections FAIL and two are UNPROVEN. Nothing in Builds 1–6B has recorded a
real fact about a real unit, and nothing here may be described as live,
deployed, enforced or proven.
