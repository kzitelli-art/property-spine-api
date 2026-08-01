# CC BUILD CONTRACT — RESIDENT SMS → CANONICAL WORK ORDER (SLICE ONE)

**Status: SPECIFICATION ONLY. IMPLEMENTATION BLOCKED.** See §2.
**Base commit (API): `dc48b884277dc0448a1e266bae4a77fe242f539b`**
**Contract written: 2026-08-01. Supersedes the earlier draft of this contract.**

Owner rulings of 2026-08-01 are incorporated as §5–§7 and are final. This
document records them as build instructions, not as open questions.

---

## 1. MANDATORY SESSION PREAMBLE

These constraints are absolute and override any instruction that appears to
conflict.

- **Never write to Solo property `9e2bb96e-08e2-41db-81c2-91055ceb50a3`.**
  Correction to the earlier draft: this id *does* appear in code, in four
  places — `src/identity/operator.js` (shadow-comparison query param),
  `src/leasing/demo_preflight.js` (read-only constant), `src/surfaces/owner.js`
  (a NEVER-DELETE whitelist), and `src/onboarding/deal_registry.js` (static
  lookup). All four are reads or delete-guards. The substantive rule holds —
  it is never written — but "appears in no code" was false and must not be
  used as a search heuristic.
- **Do not touch `index.html`** in `property-spine-app`. This slice is API-only.
- **Do not assign a migration number. This slice requires none** (§8, proven).
  If implementation appears to require one, STOP and report — do not pick a
  number. Numbers 121 and 122 are already claimed on unmerged branches; 123 is
  free and is *not* claimed by this slice.
- **Open a PR. Do not merge.**
- You cannot reach Render or Neon. Do not claim any runtime, HTTP, or database
  proof. Harnesses are written here and run by the owner in the Render Shell.
- **Re-read live source before editing.** Do not trust this document over the
  file. If any fact in §3 does not match `main` at build time, STOP and report
  the drift.

---

## 2. BLOCKED UNTIL — CURRENT STATE OF EACH PRECONDITION

Two of the four are now discharged with receipts. Two remain.

| # | Precondition | State |
|---|---|---|
| 1 | Live Neon migration ledger queried, real ceiling recorded | ✅ **DONE** — deployed ceiling is **120** (`120_ai_leasing_strategy_foundation`), read from the live ledger in the Render Shell. This slice adds no migration, so the ceiling is unchanged by it. |
| 2 | Deployed `comm_events.sms_sid` unique index confirmed present in Neon | ✅ **DONE** — `idx_comm_sms_sid`, confirmed live: `CREATE UNIQUE INDEX idx_comm_sms_sid ON public.comm_events USING btree (sms_sid) WHERE (sms_sid IS NOT NULL)`. |
| 3 | Exact `satisfyObligation` close behavior verified | ⚠️ **SOURCE-VERIFIED, NOT DATA-VERIFIED.** See §4.1. Owner decides whether this suffices. |
| 4 | Corrected routine and emergency obligation transitions specified field by field | ✅ **DONE** — §6.2 and §6.3 below. Requires owner sign-off, not further discovery. |

Implementation remains blocked on **#3** and on owner sign-off of **#4**.

---

## 3. VERIFIED FACTS AT HEAD — DO NOT RE-DERIVE, DO RE-CONFIRM

Every claim below was read from live source at `dc48b88`.

**3.1 Inbound route.** `POST /communications/inbound-sms`
(`src/comms/tenantlink.js:938`). Order: `smsReady()` → `sms.validateWebhook`
(403) → require `MessageSid`/`From`/`To` →
`commBoundary.resolveInboundSmsContext({To, From, MessageSid, body})`. Early
returns, all `emptyTwiml`, all zero-write: `idempotentReplay`, `unknownLine`,
`ambiguous`, `consentSignal`. Then forks on `ctx.relationship`: `lead` → agent
`processInbound`; `resident` → `runInbound`.

**3.2 The boundary writes NOTHING on the resolved path.**
`resolveInboundSmsContext` (`src/comms/communications_boundary.js:616`) returns
`comm_event: null` for a resolved resident or lead. The first durable inbound
record for a resolved resident is written inside `runInbound`. The boundary DOES
write for: ambiguous/unmatched sender (person-less, property-scoped,
`classification='unknown'`, `needs_human=true`) and consent keywords.

**3.3 Idempotency.** The `sms_sid` lookup runs FIRST in the resolver
(`communications_boundary.js:626`). Backed by the partial unique index confirmed
live in §2. A duplicate `MessageSid` never reaches `runInbound`.

**3.4 `runInbound`** (`tenantlink.js:814`) is shared by BOTH `/tenant/messages`
(line 902, browser door) and `/communications/inbound-sms`. Seven `pool.query`
calls, **zero transaction**. Steps: `placeOf` → upsert `conversations` → insert
inbound `comm_events` → `classifyMessage` → branch → update inbound row with
audit → insert outbound `comm_events` → touch conversation. **Any change to
`runInbound` affects the browser door. Browser-door behavior must be preserved.**

**3.5 Two raw inserts.** `runInbound`'s emergency branch (line 847) and its
`maintenance && confidence>=0.7 && !needs_human` branch (line 859) raw-insert
into `work_orders`. Both are self-flagged in source as bypassing the canonical
service, producing no event and no routing obligation.

**3.6 `createWorkOrder`** (`src/maintenance/work_order_service.js:209`).
Requires an open-transaction `client`. Requires `urgency_status` ∈
`["emergency","regular","needs_confirmation"]`. Requires a valid `emergency_type`
key when emergency (throws, `httpStatus:400`, `allowed: Object.keys(EMERGENCY_TYPES)`).
Derives `is_emergency` AND `needs_pm_review` from `urgency_status === "emergency"`
— **`needs_pm_review` is NOT a parameter** (confirmed at the values-array level,
line 305). Stores `description` verbatim. Dedupes on
`(idempotency_key, property_id, reported_by_person_id)` returning
`{deduped: true}`. Writes work order → event (`work_order_opened` |
`emergency_work_order`) → routing obligation.

**3.7 `satisfyObligation`** (`server.js:275`). Removes ONE input from
`required_inputs`, writes an `input_satisfied:<input>` event. **Does not change
`status`. Does not auto-close.** `completeObligation` (`server.js:316`) is
separate and refuses while inputs remain. See §4.1 for the residual risk.

**3.8 `spawnObligationFromEvent`** (`server.js:186`) defaults
`assigned_user_id = null` and runs no role-to-user resolver. **Honest UNASSIGNED
is the existing behavior, not something to add.**

**3.9 `classifyUrgency`** (`src/maintenance/maintenance_urgency.js`) emits
exactly five `emergency_type` values: `fire_life_safety`, `active_leak`,
`electrical_hazard`, `security_issue`, `sewer_backup`. All five are valid
`EMERGENCY_TYPES` keys. It is structurally incapable of emitting an invalid type.

**3.10 `classifyMessage`** (`tenantlink.js:764`) is an Anthropic call with hard
regex overrides, fail-soft to `needs_human=true` / `confidence=0`. Its
`"emergency"` classification carries **no `emergency_type`** — routing it into
`createWorkOrder` as emergency will throw. See §7.4.

**3.11 `appendClarification`** (`work_order_service.js:512`) — five defects, all
to be fixed (§6):
- Never transitions `needs_confirmation` → `regular`.
- Never satisfies or removes `urgency_confirmation`. On escalation the stale
  input remains and blocks completion.
- On escalation, updates obligation `type`/`priority`/`severity`/
  `escalates_to_role`/`due_at` but **not `label`** — leaving a label that
  contradicts the type.
- Escalation is a bare UPDATE with **no event written**. Escalation history does
  not exist.
- Falls back to `EMERGENCY_TYPES.manager_override` on an unknown type
  (line 527) where `createWorkOrder` throws — a contract mismatch inside one
  service.

**3.12 `emergency_type` is not a `work_orders` column.** Neither create nor
clarify stores it. It lives only in event-note JSON and the obligation label.

**3.13 `conversations` is `unique (property_id, person_id)`** — confirmed in
`migrations/027_tenant_link.sql`. One thread per resident per property.

**3.14 `comm_events` columns.** Correction to the earlier draft: it **does**
carry one `jsonb` column — `media_refs`, added in `migrations/048`. The earlier
claim "no jsonb, no array" was false. The substantive point survives: no column
exists that could durably hold a set of competing work-order choices, so §7.2's
refusal to ask the resident to choose still stands — but it stands on the
absence of a *suitable* field, not the absence of any structured field.

**3.15 `sendPropertySms`** (`communications_boundary.js:505`) takes `eventId` and
stamps `sms_status`/`sms_error`/`sms_sid` onto the caller's existing comm_event.
**No internal retry and no double-send guard.**

**3.16 Injection.** `server.js:3410` —
`tenantLinkModule({ pool, anthropic, INGEST_MODEL, sms, commBoundary, workOrderService, getAgentService })`.
`satisfyObligation` is NOT currently injected.

**3.17 No canonical obligation-retype helper exists.** `reassignObligation`
(`server.js:374`) changes only `assigned_role`/`escalates_to_role`. The
`confirm_urgency` → `maintenance_repair`/`emergency_repair` transition needs an
explicit evented path. See §6.1 — this is the central new primitive of the slice.

**3.18 `events.type` is unconstrained.** `type text not null default 'note'`
(`migrations/001_baseline.sql:161`), no CHECK. The CHECK constraints that exist
are on `unit_events.event_type` (006, 082) and `lead_events.event_type` (038,
055) — **different tables**. New event types therefore need no migration.

**3.19 There are no triggers on `obligations`.** Confirmed by search across all
123 migrations. Nothing auto-closes an obligation when `required_inputs` empties.

---

## 4. THE ONE REMAINING VERIFICATION

### 4.1 `satisfyObligation` — what is and is not proven

**Source evidence (strong).** `server.js:275–312`. The function's only write to
the obligations row is:

```sql
update obligations set required_inputs = $1, updated_at = now() where id = $2
```

It never references `status`. Closure lives exclusively in `completeObligation`
(`server.js:316`), a separate exported function with its own gate. Combined with
§3.19 (no triggers on `obligations`), there is no mechanism in the repository by
which satisfying the final input could close the obligation.

**What source cannot rule out.** A trigger or rule created directly against the
deployed database, outside the migration chain. The repo cannot see that.

**The check that would close this.** In the Render Shell:

```
node -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query(\"select tgname, tgrelid::regclass as tbl from pg_trigger where tgrelid='obligations'::regclass and not tgisinternal\").then(r=>{console.table(r.rows);p.end()})"
```

Zero rows ⇒ precondition #3 fully discharged, and `satisfyObligation` is safe to
use as specified. Any rows ⇒ STOP and report before implementing §6.

**Design consequence either way.** §6.2/§6.3 never rely on satisfaction alone to
leave the obligation in a correct state — the retype in the same transaction sets
`required_inputs` explicitly. So the risk this check addresses is a *transient*
in-transaction state, not the committed outcome. It is still worth confirming.

---

## 5. RULING ONE — TWO-STAGE FAILURE DESIGN (APPROVED)

### 5.1 Transaction boundary

```
T1  upsert conversations (the comm_event FK requires it)
    insert inbound comm_event, needs_human = TRUE   → COMMIT
T2  BEGIN
      canonical work-order create  OR  clarification resolution
      → events and obligation create/transition
      → outbound reply INTENT comm_event
      → clear needs_human on the T1 inbound row
    COMMIT
AFTER COMMIT  sendPropertySms(..., eventId) — network send, stamps delivery result
```

If T2 fails:

- the original claim remains durably preserved;
- it remains visibly flagged for human attention (`needs_human=true`, surfaced by
  the existing `idx_comm_needs_human` partial index from `migrations/028`);
- no success reply is sent;
- no work order is falsely represented as created.

**The Twilio network call is never inside an open transaction.**

### 5.2 No replay-resume in slice one

Do not build an automatic replay-resume mechanism merely because Twilio retries
the same `MessageSid`. The existing dedupe (§3.3) may stop the retry, but the
message no longer stalls invisibly — it sits in the operator exception queue.

Automatic resumable processing requires an explicit **processing-state contract**
and must not be inferred from the presence of a dedupe row. That is a later slice.

**Implementation note.** This has a consequence worth stating plainly rather than
discovering later: after a T2 failure, a Twilio retry carrying the same
`MessageSid` will be dedupe-rejected at §3.3 and will *not* re-attempt the work.
That is the accepted behavior for slice one — the claim is preserved and flagged,
and a human resolves it. Do not "fix" this by weakening the dedupe.

---

## 6. RULING TWO — FIX THE CANONICAL SERVICE, NOT THE SMS CALLER

Do **not** wrap `appendClarification` with SMS-specific corrective SQL. The web
door (`/tenant/messages`) reaches the same service and carries the same latent
defect. A second correction path would create two meanings of clarification.

### 6.1 New shared primitive: `transitionObligation`

§3.17 established that no canonical retype helper exists. Build one **in the
shared obligation engine in `server.js`**, beside `spawnObligationFromEvent`,
`satisfyObligation`, `completeObligation`, and `reassignObligation` — not inside
`work_order_service.js`, and not inline in the caller.

Rationale: the retype must be available to every caller that will ever resolve an
urgency question (SMS door, web door, future operator UI). Putting it in the
maintenance service would make it a maintenance-private mechanism and guarantee a
second implementation later. This is the same reasoning that put the front half
of the loop in one place.

Mirror `reassignObligation`'s exact shape (`server.js:374`): take an open
`client`, `select ... for update`, refuse when `status='complete'`, perform one
UPDATE, write a durable event, return the updated row.

```
transitionObligation(client, {
  obligation_id,
  type,                 // required — the new obligation type
  label,                // required — must be updated with the type, never left stale
  required_inputs,      // required — the complete new set, not a delta
  priority, severity, escalates_to_role, due_at,   // optional, default unchanged
  reason,               // optional operator-language note
  event_type,           // required — the durable transition event to write
  event_note,           // required — structured JSON payload
})
```

Rules it must enforce:

- Refuses a `complete` obligation (mirrors `reassignObligation`).
- **`label` and `required_inputs` are required, not optional.** The defect in
  §3.11 is precisely a type that moved while its label did not; the signature
  must make that impossible rather than merely discouraged.
- Writes the transition event in the same transaction. An unaudited UPDATE is the
  defect being fixed, so a transition with no event is not a valid call.
- Uses the array-parameter form for `required_inputs` (as `satisfyObligation`
  does at `server.js:305`), not the `"{a,b}"` string-literal form
  `spawnObligationFromEvent` uses at line 217. Both work; pick one and note it.

### 6.2 Field-by-field — clarification resolves as NON-EMERGENCY

Read `obligationSpecFor` (`work_order_service.js:162`) and mirror its `regular`
shape exactly. Do not hardcode values this document states if the source
disagrees — report the disagreement.

`work_orders`:

| Field | Before | After |
|---|---|---|
| `urgency_status` | `needs_confirmation` | `regular` |
| `urgency_basis` | prior | `classifyUrgency(text).basis` |
| `urgency_decided_by` | `system` | `resident_clarification` |
| `urgency_decided_at` | prior | `now()` |
| `is_emergency` | false | false |
| `needs_pm_review` | false | false |
| `updated_at` | — | `now()` |

Obligation (the open `confirm_urgency` row for this work order):

| Field | Before | After |
|---|---|---|
| `type` | `confirm_urgency` | `maintenance_repair` |
| `label` | "Maintenance request — urgency needs confirmation" | mirror `obligationSpecFor` regular → `"Maintenance request"` |
| `required_inputs` | `{urgency_confirmation}` | satisfy the stale input, then set to the regular shape → `{closeout_proof}` |
| `status` | `open` | **`open` — MUST NOT CLOSE** |
| `assigned_role` | `maintenance` | unchanged |
| `assigned_user_id` | `null` | unchanged (§3.8 — honest UNASSIGNED) |
| `priority` / `severity` | `normal` | `normal` / `normal` |

Events: `+work_order_clarification`, `+input_satisfied:urgency_confirmation`,
`+work_order_urgency_resolved` (new; carries prior and new `urgency_status`,
basis, and decider).

**One accountable repair obligation must remain open. Answering the urgency
question never closes the repair.**

**Ordering hazard — must be inside one transaction.** Between
`satisfyObligation('urgency_confirmation')` and the `transitionObligation` call,
the row transiently has `type='confirm_urgency'` and `required_inputs={}` — a
state in which `completeObligation` would happily close it, since its only gate
is "no inputs outstanding" (`server.js:341`). T2 makes this atomic. Do not split
these two calls across transactions, and do not reorder them so the window widens.

### 6.3 Field-by-field — clarification resolves as EMERGENCY

Mirror `obligationSpecFor`'s `emergency` shape.

`work_orders`:

| Field | Before | After |
|---|---|---|
| `urgency_status` | `needs_confirmation` | `emergency` |
| `is_emergency` | false | true |
| `urgency_basis` | prior | `classifyUrgency(text).basis` |
| `urgency_decided_by` | `system` | `resident_clarification` |
| `urgency_decided_at` | prior | `now()` |
| `needs_pm_review` | false | true |
| `updated_at` | — | `now()` |

Obligation:

| Field | Before | After |
|---|---|---|
| `type` | `confirm_urgency` | `emergency_repair` |
| `label` | prior | mirror `obligationSpecFor` emergency → `` `EMERGENCY: ${emDef.label} — needs on-call to own it` `` |
| `priority` | `normal` | `urgencyToPriority(emDef.urgency)` → `high` |
| `severity` | `normal` | `emergency` |
| `escalates_to_role` | null | `property_manager` |
| `due_at` | null | `urgencyToDueAt(emDef.urgency)` |
| `required_inputs` | `{urgency_confirmation}` | satisfy the stale input, then `{closeout_proof}` |
| `status` | `open` | `open` |

Events: `+work_order_clarification`, `+input_satisfied:urgency_confirmation`,
`+work_order_urgency_escalated`.

The escalation event note MUST carry `emergency_type`, `emergency_label`, prior
and new `urgency_status`, basis, and decider. Per §3.12 this event is **the only
durable home for `emergency_type`** on a clarification-driven escalation — if it
is not written there, that fact does not exist anywhere.

### 6.4 Clarification received, uncertainty remains

| Target | Before | After |
|---|---|---|
| `work_orders.*` | any | **unchanged** |
| obligation | `confirm_urgency` / `open` / `{urgency_confirmation}` | **unchanged** |
| events | — | `+1 work_order_clarification` |

The question was not answered. Do not pretend it was.

### 6.5 Already emergency

No downgrade. The existing `wo.urgency_status !== "emergency"` guard
(`work_order_service.js:524`) is preserved. Only `+work_order_clarification` is
written.

### 6.6 Vocabulary contract

Remove the `|| EMERGENCY_TYPES.manager_override` fallback at
`work_order_service.js:527`. An unknown `emergency_type` must throw with the same
shape `createWorkOrder` throws — `httpStatus: 400`,
`allowed: Object.keys(EMERGENCY_TYPES)`. One closed vocabulary, both entry points.

Note: per §3.9 `classifyUrgency` cannot currently emit an invalid type, so this
changes no reachable behavior today. It is closing the contract mismatch before
a second caller makes it reachable, not fixing a live defect.

---

## 7. RULING THREE — THE INBOUND DECISION GATE

### 7.1 Decision order inside T2

**Corrected 2026-08-01 — see §14.1. The obvious lookup is wrong.**

Find the questions **we asked this person**, not the obligations that happen to
name them:

```sql
select o.id, o.related_id as work_order_id, ce.id as question_event_id
  from comm_events ce
  join obligations o
    on o.related_type = 'work_order'
   and o.related_id   = ce.created_object_id
   and o.status       = 'open'
   and o.type         = 'confirm_urgency'
 where ce.property_id = $1
   and ce.person_id   = $2
   and ce.direction   = 'outbound'
   and ce.created_object_type = 'work_order'
```

1. Run the query above.
2. **Zero** → normal path: `classifyMessage` + `classifyUrgency` → `createWorkOrder`.
   But first apply §7.6 — a zero result has two different meanings.
3. **Exactly one** → run the answer-recognition gate (§7.2), passing
   `question_event_id`'s body as the question context.
4. **More than one** → preserve, `needs_human=true`, make no work-order change,
   make no automated association, reply truthfully that more than one request is
   open and the team will review. **Do not ask the resident to choose** — the
   system cannot durably preserve a set of offered choices (§3.14).

**Do NOT key this lookup on `obligations.person_id`.** That column holds
`affected_person_id ?? reported_by_person_id` (`work_order_service.js:330`) — the
person whose home it is, not the person we texted. §14.1 explains why that
distinction silently misroutes.

### 7.6 A zero result has two meanings — distinguish them

Zero pending clarifications does not by itself mean "new problem." Re-run the
query without the `o.status='open' and o.type='confirm_urgency'` join
conditions. If an outbound question to this person exists but its work order no
longer carries an open `confirm_urgency` obligation, the resident is answering a
question **that has already been resolved by someone else** — most likely an
operator, while the reply was in flight.

- Question exists, obligation already resolved → **preserve, `needs_human=true`,
  no work-order change.** Do not create a second work order for an issue that is
  already being handled.
- No outbound question to this person at all → genuine new-request path.

Without this split, the in-flight race produces a duplicate work order for an
issue already in progress, and nothing in the system would ever notice.

### 7.2 Answer-recognition gate

Context: the linked outbound clarification question (found via
`created_object_id` on the outbound comm_event) plus the inbound text.

| Verdict | Action |
|---|---|
| `answers_question` | `appendClarification` on that work order (§6.2–§6.5) |
| `separate_problem` | normal new-request path — `createWorkOrder` |
| `both` | preserve, `needs_human=true`, no work-order change |
| `unclear` | preserve, `needs_human=true`, no work-order change |

**Fail-soft default is `unclear`.** If the model call fails, the message is
preserved and flagged — never guessed.

**Identity plus one open obligation may NOT determine intent on its own.** The
fact that a resident with one pending question sent a message is not evidence
that the message answers it.

### 7.3 Separate problems use the normal path

A clearly separate maintenance problem creates a **new work order through the
normal canonical path** — not an enrichment of the existing one. This keeps
capture-first intact without letting uncertain interpretation corrupt an existing
work order.

### 7.4 Emergency conflict rule

If `classifyMessage` returns `"emergency"` but `classifyUrgency` yields no
`emergency_type`, create at `needs_confirmation` and ask. **Never invent an
`emergency_type` to satisfy the service.**

### 7.5 Reply strings

Truthful acknowledgment only. A work order was recorded and will be reviewed.
**No response time, no technician name, no dispatch claim, no assignment claim.**
Preserve the existing honest emergency string including the call-911 line
(`tenantlink.js:856`). Set `created_object_type`/`created_object_id` on the
outbound reply so the question links to its work order.

---

## 8. SCHEMA — NO MIGRATION, PROVEN

**No migration. No new table. No new column.**

This is proven, not assumed:

- The two new event types need no schema change — `events.type` is unconstrained
  free text (§3.18).
- Every obligation field the transition writes already exists: `type`, `label`,
  `priority`, `severity`, `escalates_to_role`, `due_at`, `required_inputs` — all
  written today by `spawnObligationFromEvent` (`server.js:220`).
- `emergency_type` needs no column; its durable home is the escalation event note
  (§3.12, §6.3).

If implementation appears to require a migration, STOP and report rather than
creating one. **123 is free and is not claimed by this slice.**

---

## 9. `sendPropertySms` DOUBLE-SEND GUARD

Before sending, if `eventId` is supplied and that comm_event already carries a
non-null `sms_sid` **or** an `sms_status` indicating a completed send, **refuse**
and return `{ sent: false, reason: "already_sent", sid: null }`.

Do not rely on callers to remember. Do not add retry logic in this slice — this
guard is the precondition for a retry mechanism being safe to add later.

---

## 10. SCOPE

### In scope

1. `runInbound` becomes transactional and routes work-order creation through
   `createWorkOrder`.
2. Pending-clarification lookup and the answer-recognition gate.
3. `appendClarification` repaired in the shared canonical service.
4. `transitionObligation` added to the shared obligation engine (§6.1).
5. `satisfyObligation` injected into tenantlink.
6. Outbound clarification question linked via existing `created_object_*` columns.
7. `sendPropertySms` double-send guard.
8. Harnesses.

### Explicitly out of scope

- Any migration or schema change.
- Any change to the `lead` branch or the leasing agent.
- Any automatic assignment, dispatch, technician naming, or promised response time.
- Any automated selection among multiple pending clarifications.
- Any replay-resume mechanism (§5.2).
- Staff authority of any kind on the property-facing line.
- `index.html` or any app-repo change.

---

## 11. HARNESSES (written here, run by the owner)

Every harness asserts against executed behavior, not source. Every harness must
**fail against pre-change `main`** and pass after. State that explicitly in the PR.

Required cases:

1. Ambiguous report → one work order at `needs_confirmation`, one
   `confirm_urgency` obligation, `assigned_user_id` null, clarifying question sent.
2. Clear routine report → one work order `regular`, one `maintenance_repair`
   obligation, `assigned_user_id` null.
3. Emergency-sounding report → `emergency_repair` obligation with `due_at` and
   `closeout_proof`; or honest fall to `needs_confirmation` when no valid type.
4. Duplicate `MessageSid` → exactly one work order, one obligation, one inbound
   comm_event.
5. Unknown/ambiguous sender → zero rows on the resident path, zero outbound.
6. Clarification answers routinely → §6.2 transitions exactly; **obligation still
   open**, `required_inputs = {closeout_proof}`.
7. Clarification answers with emergency → §6.3 transitions exactly; escalation
   event present and carrying `emergency_type`.
8. Clarification leaves uncertainty → §6.4; nothing changes but the note.
9. Separate-problem reply → new work order, original untouched.
10. Both / unclear reply → preserved, `needs_human=true`, no work-order change.
11. Two pending clarifications → preserved, flagged, no change, no choice offered.
12. T2 failure → inbound row survives, `needs_human` true, zero outbound, no work
    order.
13. Double-send guard → second `sendPropertySms` on the same `eventId` refuses.
14. Browser door (`/tenant/messages`) behavior unchanged.
15. **`transitionObligation` refuses a `complete` obligation**, and refuses a call
    that omits `label` or `required_inputs`.
16. **An unknown `emergency_type` throws identically** from `appendClarification`
    and `createWorkOrder` (§6.6).
17. **Reporter ≠ affected (§14.1).** A work order created with a *different*
    `reported_by_person_id` and `affected_person_id`, at `needs_confirmation`.
    The reporter answers. The gate must find the question and enrich that work
    order — not create a second one. This case fails against any implementation
    that keys the lookup on `obligations.person_id`.
18. **Question predating the slice (§14.2).** An open `confirm_urgency`
    obligation whose outbound question carries no `created_object_id`. The
    resident's answer is preserved and flagged, and no work order changes.
19. **Answer to an already-resolved question (§7.6).** The question exists, but
    an operator resolved the obligation first. Preserved and flagged; **exactly
    one** work order exists afterwards, not two.
20. **Mid-failure visibility (§14.3).** Force a failure between the inbound
    insert and the branch; assert the committed row has `needs_human = true`.
    This must fail against pre-change `main`, where it commits `false`.

---

## 12. PR REQUIREMENTS

- One PR, not merged.
- State the exact base SHA built against and confirm §3 matched at build time, or
  list every drift found.
- List every file changed and why.
- State the claim level honestly: **source-complete, harness-written, not run
  against Postgres, not deployed, not browser-proven.**
- Do not claim any live proof.
- Classify every component touched: permanent primitive, temporary adapter with
  replacement condition, test infrastructure, or delete-on-activation scaffolding.
  `transitionObligation` is a **permanent primitive** (Class 1).

---

## 13. STOP CONDITIONS

Stop and report rather than proceeding if any of these occur:

- A migration appears necessary.
- `runInbound` cannot be made transactional without changing browser-door behavior.
- `obligationSpecFor` shapes disagree with §6.2/§6.3.
- Any fact in §3 does not match live source.
- The `pg_trigger` check in §4.1 returns any row.
- Fixing `appendClarification` would change behavior for a caller outside the
  tenant maintenance path in a way not specified here.
- The pre-existing-obligation population in §14.2 turns out to be non-empty in a
  way that makes the fallback behavior unacceptable.

---

## 14. SELF-REVIEW — DEFECTS FOUND IN THIS CONTRACT

Written 2026-08-01, after the rulings, by re-reading the contract against live
source rather than trusting it. Four defects, all confirmed. §7.1 and §5.1 above
are already corrected; the reasoning is recorded here so a later edit does not
undo it without knowing what it cost.

### 14.1 The pending-clarification lookup was keyed on the wrong person

The original §7.1 queried `obligations` by `person_id`. That column is set to
`affected_person_id ?? reported_by_person_id` (`work_order_service.js:330`), and
`obligationSpecFor` inherits it — deliberately, because as the service's own
comment says, "the obligation hangs off the affected relationship."

But **the clarifying question is sent to the reporter**, not the affected
resident. `work_order_service.js:213` is explicit that these are two people and
frequently not the same one: *"a neighbour reports a leak coming through a shared
wall."*

So for any work order where reporter ≠ affected, the gate would query for the
texting neighbour, match nothing, and classify their answer to our own question
as a brand-new maintenance problem — creating a second work order and leaving the
original question unanswered forever.

This is **latent, not live**, in slice one: `runInbound`'s existing raw inserts
pass the texter as *both* `reported_by_person_id` and `affected_person_id`
(`tenantlink.js:851`, `values ($1,$2,$3,$3,…)`), so the two ids coincide today.
It becomes live the moment any surface creates a work order with a distinct
reporter — which the canonical service explicitly supports and which routing this
slice through `createWorkOrder` makes more likely, not less.

Corrected by keying on the **outbound question** instead: the comm_event we sent
carries `person_id` = the person we asked. "Did we ask *you* this?" is the
question the gate is actually trying to answer, and it is the only lookup that
stays correct when reporter and affected diverge.

### 14.2 The linkage the corrected lookup depends on does not exist yet

§7.5 requires setting `created_object_type`/`created_object_id` on the outbound
reply. Confirmed absent today — `runInbound`'s outbound insert
(`tenantlink.js:891`) writes `classification='auto_reply'` and nothing else; the
`created_object_*` columns are set only on the **inbound** row (line 885).

Consequence: **every `confirm_urgency` obligation that exists at deploy time has
no linked question.** The corrected §7.1 lookup will return zero for all of them,
and §7.6 will route their answers to preserve-and-flag rather than into
`appendClarification`.

That is the correct fail-safe direction — a human sees it, nothing is corrupted —
but it must be a stated behavior rather than an accident:

> **Ruling required.** For any work order whose clarifying question predates this
> slice, a resident's answer is preserved and flagged, never auto-applied. These
> obligations drain naturally as operators resolve them; no backfill is
> specified, and none should be invented from message bodies.

Note the population is probably small: `runInbound` today never calls
`createWorkOrder`, so it has never produced a `confirm_urgency` obligation at
all. Any that exist came from the operator path. **Owner should confirm the count
before accepting the fail-safe** — the check is one query, and if it is large the
fallback deserves a better answer than "a human handles each one."

### 14.3 `needs_human` defaults to FALSE, so today's save-first is already leaky

`migrations/028_tenant_messages.sql:33` —
`needs_human boolean not null default false`.

`runInbound` inserts the inbound row at step ① and only sets `needs_human` at
step ④, after classification and the work-order branch. There is no transaction.
So **today**, any failure between those two steps commits a resident's message
with `needs_human = false` — invisible to the exception queue that
`idx_comm_needs_human` serves, on **both** the SMS door and the browser door.

This is not a hypothetical introduced by the new design; it is a live latent
defect in the current code, and it is exactly the failure mode Ruling One's T1
flag closes. Recorded because it strengthens the ruling and because it means the
browser door gets a real fix out of this slice, not merely "preserved behavior."

**Browser-door consequence, stated explicitly.** On success the
`/tenant/messages` response shape is unchanged, to the byte. On failure it
changes: today the caller gets a 500 with an invisible orphan row; after this
slice it gets a 500 with the message durably preserved and *visibly flagged*.
That is a behavior change, it is an improvement, and §3.4's "browser-door
behavior must be preserved" should be read as covering the success contract, not
as forbidding this.

### 14.4 No index supports the pending-clarification lookup

`obligations` carries only single-column indexes — `idx_obl_property`,
`idx_obl_status`, `idx_obl_role`, `idx_obl_due` (`001_baseline.sql:352–355`).
Nothing composite covers `(property_id, person_id, type, status)`, and the
corrected §7.1 lookup now drives from `comm_events` instead.

For slice one this is acceptable and **no index should be added**: the join is
bounded by one property and one person, on tables already indexed by
`property_id`, and it runs once per inbound resident message — a volume measured
in messages per day, not per second. Adding an index would also mean a migration,
which §8 forbids.

Recorded so that if this lookup later moves onto a hot path, the absence is a
known decision rather than an oversight.
