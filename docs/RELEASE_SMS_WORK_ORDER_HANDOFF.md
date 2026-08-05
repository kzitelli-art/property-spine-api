# RELEASE PACKAGE — resident SMS → work order → technician lifecycle → operator action

**Status: built, proven, NOT merged and NOT activated.**
Activation is a separate, deliberate act. See
[`ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`](ACTIVATION_SMS_WORK_ORDER_HANDOFF.md),
which is the operator-facing packet and is self-contained.

This document is the record of what ships, what proves it, what is dormant
until someone activates it, and what remains open. It contains no
credentials, no connection strings and no phone numbers.

---

## 1. Identity

| | |
|---|---|
| API repository | `kzitelli-art/property-spine-api` |
| API branch | `claude/conversational-seams-and-technician-loop` |
| API tip | the commit carrying this document — confirm with `git log --oneline -1` |
| API base | `origin/main` @ `8330aec` |
| App repository | `kzitelli-art/property-spine-app` |
| App branch | `claude/sms-work-order-handoff-qo3s8i` |
| App tip | `297cfb2` |
| App base | `origin/main` |
| Migrations added | `130` – `136` |
| Production applied ledger ceiling | **128** (to be re-confirmed read-only at activation) |
| Ceiling this release expects to start from | **129** |

**`main` cannot boot today, and that is deliberate.** `129_property_line_uniqueness.sql`
is on `main` and in no ledger, so the verify gate refuses to start and Render
keeps serving the previous build. This release **stacks on top of** that; it does
not replace it. **Migration 129 must be activated first** — that is
[`UNBLOCK_1_MIGRATION_129_ACTIVATION.md`](UNBLOCK_1_MIGRATION_129_ACTIVATION.md),
and it is a hard prerequisite, not a recommendation.

Reconcile with `main` by **merge**. Never rebase and never force-push either
branch — both have been merged from `main` before and their history is shared.

---

## 2. What ships, in product terms

A resident texts the property line. That becomes a canonical work order. The
technician holds an ordinary text conversation with the operations line — no
commands, no codes — and everything they report becomes a canonical fact. The
operator sees one compact queue of what needs attention, and every control on
it performs a governed write and returns a receipt.

### The technician side

Plain language, recognised in order: `no access` → `complete` → `blocked` →
`en route` → `accept` → `list work`. The technician can name a work order by
reference, by a bare number, or not at all — an unambiguous single assignment
resolves without a reference, and an ambiguous one produces the **smallest
useful question** rather than a menu.

Photos arrive as ordinary MMS. A caption with a photo is evidence, not a
finding. Completion is *claimed* by the technician and *closed* only by the
governed service, and only when preserved proof exists.

### The resident side

A resident update is **derived from a committed canonical fact** — never
forwarded, never quoted, never paraphrased. `resident_update.js` takes a
progress kind and a work order and has no parameter through which a
technician's words could travel. Only `en_route`, `no_access` and `completed`
are resident-safe. `completion_claimed` deliberately is not.

### The operator side

`Work Orders` inside the real app shell: one list, banded by attention
(**Needs action** / **In progress** / **Recently completed**), one state line,
one verb. Five controls, each with exactly one canonical service:

| Control | Service | What it does |
|---|---|---|
| Review | *(none — it is a read)* | Opens the same work order's detail. Writes nothing. |
| Assign | `assignWork` | An eligible technician becomes accountable; `ownership_origin='operator_assigned'`. |
| Ask *(technician)* | `askForPhoto` | One reply-bound request on the operations line. |
| Coordinate entry | `coordinateEntry` | One resident-safe message on the property line — **only where the resident has not already been asked** (§7.1). |
| Retry | `prepareRetry` + `recordAttemptResult` | A **new attempt** at an **existing** intent. |

`Review` has no service on purpose: it is a read, and a read that writes is the
thing `operator_actions.js` exists to prevent.

---

## 3. The rulings this build implements

**The operations line may send outbound only under `reply_only`.** The
capability is structural and three-state — `disabled` / `reply_only` /
`proactive` — enforced by a database constraint and trigger, not by
application code. A valid reply carries all five bindings:
`in_reply_to_comm_event_id`, `to_user_id`, `staff_thread_id`, `reply_reason`,
`communication_line_id`. A proactive push on the operations line is refused by
the database.

This is why `Ask Dana` is expressible at all: it binds to the technician's own
last inbound message, and asking for the proof their completion claim is
missing is genuinely a *clarification* of that claim — not an unprompted
broadcast.

**Operating receipt and delivery receipt never collapse.** `composeReceipt`
returns exactly `{operating, delivery}`, frozen, with whitelisted keys.
`delivered` derives from the transport's own state and from nothing else.
Nothing in this build says a resident was told because a work event occurred.

**A provider URL alone is not durable proof.** Evidence moves
`referenced` → `stored` | `fetch_failed`, with eight required associations. A
photo that arrived and could not be preserved is reported as
`not_preserved` — never as proof, and never silently dropped.

**Every delivery attempt is kept.** A retry is a new attempt at the same
operating cause: the intent stays put, each attempt is its own append-only row,
and `comm_events.sms_status` remains the current projection derived from the
latest attempt. "Failed at 9:05, failed at 9:31, delivered at 10:02" is the
record.

---

## 4. Component classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| `src/conversation/{clarification,receipt,work_reference,technician_intent}.js` | 1 — canonical | none |
| `src/technician/{work_selection,acceptance_service,lifecycle_service,evidence_service,resident_update,conversation,operator_actions}.js` | 1 — canonical | none |
| `src/surfaces/work_order_status_read.js` | 1 — canonical read | none |
| Migrations `130`–`136` | 1 — canonical schema | none |
| `work-lifecycle-door.js`, the `.wo-*` block in `index.html` | 1 — canonical surface | none |
| `work_lifecycle_browser_proof.browser.js` and the `tests/*.db.js` proofs | 2 — proof scaffolding | never runs in production; see §6 |
| `docs/mock_work_orders.html`, `docs/mock_work_orders_shell.js` | **3 — superseded** | **delete once the shipped surface is accepted in production.** They are design mocks that the real implementation replaced. |

Nothing in this release is a temporary product path. There is no
`if property is Solo` branch, no fixture fallback and no demo path.

---

## 5. Proof, and where each part sits on the ladder (§33)

All numbers below were re-run today against real PostgreSQL 16.13 and, for the
browser proof, real Chromium driving real HTTP against a real Express API.

| Harness | Result |
|---|---|
| `tests/communication_lines_slice_a.db.js` | 61 / 61 |
| `tests/property_line_hardening.db.js` | 41 / 41 |
| `tests/migration_ledger_inverse_gate.db.js` | 24 / 24 |
| `tests/technician_acceptance.db.js` | 32 / 32 |
| `tests/operations_reply_policy.db.js` | 32 / 32 |
| `tests/technician_route_proof.db.js` | 48 / 48 |
| `tests/technician_lifecycle_proof.db.js` | 57 / 57 |
| app `work_lifecycle_browser_proof.browser.js` | **99 / 99** |
| `npm run verify` (source governance) | 7 gates, exit 0 |
| 4 pure unit suites (clarification, intent, selection, language) | exit 0 |

**394 database-and-browser assertions.** The count rose from 368 because the
§7.1 ruling added its own proof — it did not replace anything.

### What the browser proof actually drives

The technician lifecycle is played through the **actual inbound-SMS route**
first — accept, on my way, no access, finding, claim, photo, completion — and
only then is the operator surface loaded and asserted against what those
messages wrote. Nothing is seeded into the projection, because a projection
seeded by the harness proves the harness.

Every one of the five controls is **clicked**, and its canonical consequence
checked in the database:

- **Assign** — the picker offers only eligible staff; an ineligible technician
  is refused `409 technician_not_eligible_at_property` whatever the client
  sends; the canonical owner changes; the queue then says who it is waiting on.
- **Review** — opens the detail, `work_order_progress` count unchanged, and it
  names the exact proof still missing.
- **Ask Dana** — exactly one outbound intent, reply-bound with all five
  bindings; a second press creates no second message and says "already
  prepared"; the receipt does not claim delivered.
- **Coordinate entry** — offered only where nobody has asked the resident; a
  receipt, delivery reported as its own fact, the row written on the **resident
  conversation** and never the staff thread, carrying derived text and not the
  technician's words, and not on the operations line. Pressed again, it creates
  no second message and says the resident has already been asked.
- **Retry** — no new message, work order or completion event; the attempt is
  recorded and attributed to the operator who pressed it; a failed retry stays
  actionable; both attempts are preserved (`failed`, then `sent`); the work
  order stays complete, because delivery never rolls back the work.

### Ladder position

| Part | Position |
|---|---|
| Seams, technician lifecycle, evidence, resident derivation | **Proven** — real DB + real HTTP |
| Operations-line reply-only policy | **Proven** — enforced at the database |
| Operator surface and all five actions | **Browser verified** |
| The whole path against **production-derived full schema** | **Not reached** — see §7 |
| The whole path on **real phones** | **Not reached** — that is the activation packet |

---

## 6. Harness safety — the rules that apply to every step

These are not stylistic. They exist because a proof suite once wrote synthetic
rows into the live operating database.

- Every database harness refuses to start without `HARNESS_DATABASE_URL`.
  Production `DATABASE_URL` is never an accepted default and there is no
  fallback.
- **Never run any harness in this repository, or in the app repository, in an
  environment where `DATABASE_URL` may point at production.** That includes a
  Render shell.
- **Do not run any test, proof, seed or repair script from a production shell**
  unless it is explicitly classified and approved as structurally read-only.
- **Do not treat a filename as evidence of safety.** `.db.js`, `_proof.js`,
  `smoke` and `test` say nothing about whether a script writes. Everything
  under `tests/` is write-capable. Most things under `tools/` are write-capable
  — they include seeds, backfills and repairs.
- Exactly two scripts are approved as structurally read-only for this release,
  and each proves it by attempting a write and being refused before it reads
  anything: **`tools/ledger_reconcile.js`** and **`tools/property_line_preflight.js`**.
- No production connection string is to be sent to, requested by, or pasted
  into any Claude thread. An authorized operator runs the read-only queries and
  pastes back **only sanitized rows**.

---

## 7. Rulings and known limits — read before activating

### 7.1 The duplicate resident message — **RULED AND CLOSED, 2026-08-05**

**The defect.** When a technician reported no access, the resident was already
sent, derived and automatically:

> The technician could not access the unit. Please reply with the best way to coordinate entry.

The operator's `Coordinate entry` control then sent **byte-identical** text.
Its duplicate guard could not see the first message — the guard was keyed on
`correlation_key` and the derived update carries none. Two writers, one cause,
no shared key.

**The ruling.** Do not send the same resident message twice. The operator
surface reports the current communication truth, and the action exists only
where nobody has asked:

| Coordination state | What the operator sees |
|---|---|
| no resident coordination intent exists | **Coordinate entry** |
| intent prepared but not sent | *Resident message prepared* |
| sent or delivered | *Asked resident at 10:04 AM · waiting for reply* |
| failed | *Resident text failed* · **Retry** |

No differently-worded follow-up was added. Follow-up timing and escalation are
a separate governed capability and are not in this build.

**The deduplication is structural, not cosmetic.** Both writers already
recorded the same canonical cause — the `no_access` progress row, in
`comm_events.derived_from_progress_id`. Migration `136` makes that column
unique, so a second resident message about the same fact is refused by the
database whichever writer attempts it and whether or not it thought to look
first. Hiding the button is the *consequence* of the fix, not the fix.

`coordinateEntry` now resolves against that cause before writing, and returns
`already_asked` with *when* — so a press that cannot send still tells the
operator what happened. The insert is wrapped in a savepoint so losing the
race leaves a usable transaction and an explainable answer rather than an
aborted one.

**Proven, in this order:**

- database — a second insert on the same cause is refused `23505`, and exactly
  one message survives (`technician_lifecycle_proof.db.js`);
- read layer — five coordination states derived from that one cause, `unknown`
  never rounded down to "not sent";
- browser — the row and the detail both say *"Asked resident at … · waiting for
  reply"* and neither offers a send control; the control **is** offered and
  clicked in the one state it exists for (no access reported before the
  resident was identified); pressing it again through the real route creates no
  second message, says the resident has already been asked, and claims no
  delivery; a failed coordination text is named *"Resident text failed"* — not
  as a completion — offers Retry, and a successful retry clears the exception
  and returns the row to *"Asked resident at …"*.

### 7.2 The full schema cannot be rebuilt from empty — pre-existing, still current

**Re-verified today.** Applying every migration in order into an empty database
fails at the twelfth file:

```text
migrations/012_bank_intake.sql:42  NOTICE: relation "vendors" already exists, skipping
migrations/012_bank_intake.sql:44  ERROR:  column "yardi_code" does not exist
```

`012` creates its index on `vendors (yardi_code)` after a
`create table if not exists vendors` that was skipped because an earlier
migration already made the table without that column.

Consequence for this release: the two **full-schema resident proofs** cannot be
run locally, because there is no way to stand up a production-shaped schema
from the repository. Every proof listed in §5 runs against a scoped schema
(`tests/_ops_scoped_schema.sql`) plus migrations `130`–`136`.

This blocker predates this work and this release does not touch it. It is
recorded here because it bounds what §5 is allowed to claim.

### 7.3 What this release does not do

- It does not send anything proactively on the operations line. The database
  refuses that.
- It does not close a work order on a technician's word. Only preserved proof
  and the governed service close one.
- It does not tell a resident anything on `completion_claimed`.
- It does not change the reporting package, the ledger gate, or any surface
  outside `Work Orders`.

---

## 8. Roles required to activate

| Role | Who it must be | What only they can do |
|---|---|---|
| **Release operator** | Someone with authorized Render **and** Neon access | Steps 1–14 of the activation packet: read-only reconciliation, the merges, the `130`–`136` release, boot verification. |
| **Technician tester** | A real staff user with an active `property_team_assignments` row at the test property, holding the handset | The inbound half of the acceptance script. |
| **Operator tester** | A signed-in staff session at the same property, in a browser | The five controls, clicked. |
| **Resident tester** | A **staff-owned second handset** enrolled as a test person with recorded `opted_in` consent — **not a real resident** | The resident-facing half. |
| **Owner** | You | The §7.1 ruling, and the GENERATE-equivalent decision that this is live. |

No Claude thread can perform any release-operator step. None has a
`DATABASE_URL`, Render access, or a phone.

---

## 9. Stop conditions

Stop and do not continue if any of these is true:

- Migration `129` is not yet in the applied ledger.
- The read-only reconciliation reports anything other than `✓ RECONCILED` and
  `EXIT 0`.
- More than `130`–`136` is pending after the merges.
- The applied ceiling before release is anything other than `129`.
- The boot verify names any pending migration after the release.
- The operations line's `outbound_policy` is anything other than `reply_only`.
- A resident-facing message appears on the operations line, or a technician's
  own words appear in a resident-facing message.
