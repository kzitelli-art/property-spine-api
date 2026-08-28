# Phase 2, milestone 1 — technician work acceptance · RECEIPT

**Status: canonical core built; every decision proven; the database rung NOT
reached.** Not merged, not deployed, not production-active.

| | |
|---|---|
| Branch | `claude/conversational-seams-and-technician-loop` |
| Migration claimed | **131** — verified free across every remote branch (130 is Slice A's, and only Slice A's) |
| DB-free proof | `tests/unit/technician_work_selection.test.js` — **66/66**, exit 0 |
| `npm run verify` | **6/6 gates**, exit 0 |
| DB proof | `tests/proofs/technician_acceptance.db.js` — **written, NEVER RUN** (§5) |

---

## 1. The real-world fact being recorded

**A technician has taken this work on, and is now the accountable party for it.**

| Eight Questions (§31) | Answer |
|---|---|
| Real-world fact | This person has accepted this obligation and owes the work |
| Canonical service | `src/technician/acceptance_service.js` — `acceptWork`, the only writer |
| Authenticated actor | Server-derived: the operations line establishes the organization, `resolveStaffSenderForOrganization` establishes the user |
| Durable object | The obligation: `open → in_progress`, owned by the accepter |
| Immutable history | An `events` row of type `work_accepted` |
| Other surfaces | Every board and Person Card that reads `obligations.status` / `assigned_user_id` — no new projection needed |
| Missing ownership/scope | Refused by name. Nothing is written and nothing is guessed |
| Classification (§18) | All Class 1 (permanent). Nothing temporary was introduced |

`obligations.status = 'in_progress'` has existed since the baseline and
**nothing has ever transitioned into it.** "Someone has taken this on" was a
state the schema could describe and the product could not record. This is its
first real writer.

---

## 2. What migration 131 makes unexpressable

| # | Cannot exist | Constraint |
|---|---|---|
| 1 | Accepted, but nobody owns it | `ck_oblig_acceptance_paired` |
| 2 | Accepted by one person, assigned to another | `ck_oblig_accepter_is_owner` |
| 3 | Accepted, and still sitting in the open queue | `ck_oblig_accepted_not_open` |
| 4 | A key claiming an acceptance that never happened | `ck_oblig_acceptance_key_requires_acceptance` |
| 5 | One inbound message accepting two obligations | `uq_obligations_acceptance_key` |

Every column is nullable and every constraint is vacuously true for existing
rows, so the migration cannot change the meaning of any obligation already in
the table. There is no backfill because nothing has ever been accepted.

**It does not touch `ck_cl_outbound_disabled_slice_a`.** See §4.

---

## 3. Why the decision core is pure

Every decision in "an authenticated technician asks for their assigned
actionable work, names one of it, and accepts it" is a refusal waiting to
happen. A refusal that can only be exercised against a provisioned database is
a refusal nobody has ever seen fire.

`src/technician/work_selection.js` `require`s nothing, queries nothing, and is
proven exhaustively today with no credentials:

| Required proof | How it is refused |
|---|---|
| **Identity** | No actor, no work. A partial actor is refused by name — missing user, missing organization, missing scope are three different errors |
| **Organization context** | Required, never inferred. The line established it |
| **Property resolution** | `assignedPropertyIds` is supplied from the actor's **own** assignments and verified for membership. An empty scope offers nothing; an absent scope is refused, never treated as open |
| **Assignment eligibility** | Four named ineligibilities. Nothing is dropped silently — every refused row is returned with its reason |
| **Replay safety** | The same technician accepting the same work again is `already_accepted_by_actor` with `isNoop: true` — a no-op, not an error. Someone *else's* acceptance is `already_accepted_by_another` and is never reported as a no-op |
| **Cross-property refusal** | Belonging to the same company is not authority over every building in it. Refused for acceptance, not only for display |

### The selection rule that will look too strict, and is not

**One offerable item is still not selected without an explicit reference.**

This is the rule that stops an organization number choosing a building
(`resolvePropertyContextForStaff`), applied to work: a shortcut that reads "they
only have one, so they meant that one" is right until the second row exists and
then acts on the wrong work order. There is deliberately **no ordinal
reference** either — "the first one" depends on a list this module never sent
and cannot prove the technician saw.

---

## 4. ⛔ The stop-sign this milestone hit, and did not work around

**A technician cannot be told their acceptance was recorded.**

Slice A gave operations lines `outbound_enabled = false` under a database
constraint, `ck_cl_outbound_disabled_slice_a`. Sending an acceptance
confirmation requires lifting it. That is an owner decision about an
**unmerged** slice's deliberate ruling, made three days ago, and it is not
mine to reverse in passing.

So this milestone records the acceptance and sends nothing. The receipt seam
built earlier in this branch is exactly the vocabulary for saying so honestly:

```
operating: { committed: true,  outcome: "accepted", ... }
delivery:  { state: "not_attempted", attempted: false, delivered: false }
```

`not_attempted` is a third honest state. It is not "delivered" and it is not
"failed" — no message was sent, and the record says so rather than implying
either.

**The SMS route is therefore NOT wired.** `ctx.operationsLine` still returns
without acting, exactly as Slice A left it. Wiring it needs two things this
milestone does not have: the outbound ruling above, and a technician
reference-extraction step that cannot be proven without a database. Building
the route on top of an unprovable extraction and calling the loop closed is
precisely the "built-but-dormant described as converted" error the Slice A
receipt was written to prevent.

**What is honest to say today:** the canonical acceptance exists, is the only
writer, and refuses correctly. The conversational front door to it does not
exist yet.

---

## 5. ⚠ What has NOT been proven

`tests/proofs/technician_acceptance.db.js` is written and **has never run.** No
PostgreSQL server exists in this session — `psql` is installed, no server is.

It proves what only a database can: that the four constraints refuse **by
constraint name**, that the unique acceptance key makes a redelivery lose at the
database, that `acceptWork` derives scope from `property_team_assignments`
rather than trusting its caller, that exactly one immutable event is written,
and that every refusal leaves a byte-identical row-count vector across every
table.

> Until it runs, migration 131 and `acceptance_service.js` are at the
> **Built-but-dormant** rung of §33, not **Proven**. The decision core is
> proven; the write is not.

Unlike the resident SMS proofs, this harness **builds its own scoped schema**,
so it does not need a copy of production — any disposable PostgreSQL 16 will
do:

```bash
HARNESS_DATABASE_URL="postgres://…disposable…" node tests/proofs/technician_acceptance.db.js
```

It refuses to start without `HARNESS_DATABASE_URL`, has no fallback to
`DATABASE_URL`, and refuses if the two resolve to the same target.

---

## 6. Before this merges

1. `technician_acceptance.db.js` green against real PostgreSQL 16.
2. Everything this branch already owed: the two full-schema resident proofs
   (`docs/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md`), migration **129**
   activated (`docs/UNBLOCK_1_MIGRATION_129_ACTIVATION.md`), **130** and now
   **131** re-confirmed free immediately before merge.
3. Release order is **129 → 130 → 131**, each with its own fresh
   `EXPECTED_LEDGER_CEILING`. 131 depends on nothing in 130, but it ships
   behind it and the ledger must not be applied out of order.

---

## 7. Next, in order

1. **Owner ruling:** may an operations line send outbound? Until then a
   technician's acceptance is recorded silently, which is honest but not
   finished.
2. Technician reference extraction — a fourth conversational seam
   (`src/conversation/`), transport-independent, proven the same way as the
   other three.
3. Wire `ctx.operationsLine` to: offer → select → `acceptWork` → operating
   receipt → delivery receipt. Every piece of that sentence except the wiring
   now exists.
