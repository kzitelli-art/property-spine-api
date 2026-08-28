# DB Harness Isolation — blocking infrastructure item

**Status: BLOCKING. No further `.db.js` harness runs against production Neon.**

Property Spine distinguishes production — real data, real consequences — from an
isolated QA/integration database where automated proof and destructive reset are
allowed. **These harnesses are currently crossing that boundary.**

Every `.db.js` harness connects to `process.env.DATABASE_URL` with no override
and no guard, and each one's `tx()` helper ends in `commit`, not `rollback`. On
Render that variable is production. So every run permanently adds synthetic
properties, users, persons, assignments, sessions, prospects, tours,
conversions, obligations and events to the production database.

Per-run unique fixtures (`362fcd7`, `99cc0d3`) fix a real harness defect — they
stop runs colliding with their own leftovers. **They do not make production an
acceptable test environment.** They make the pollution quieter.

---

## 1. Inventory of possible production pollution

**Derived from seed source, not measured.** Counts for rows written *through
services* are inferred from the call graph and must be confirmed by the
read-only queries in §1.4 before any cleanup plan is drafted.

### 1.1 `tests/proofs/test_conversion_rail.db.js` — per run

| Table | Count | Values written |
|---|---|---|
| `properties` | 1 | name **`'Solo on Chestnut'`** |
| `persons` | 5 | `Katie Leung`, `Warren Diaz`, `Candace Riley`, `Olivia Grant`, `Drew Halloran` — `lifecycle_status='lead'` |
| `persons` | 3 | `Ava Morgan`, `Marcus Webb`, `Priya Raman` — `lifecycle_status='lead'` |
| `users` | 5 | `role='leasing_agent'`, `account_kind='human_staff'`, `is_active=true`, `status='active'` — **no email column written** |
| `assignments` | 4 | `role='leasing'`, `is_active=true` (Drew deliberately excluded) |
| `property_team_assignments` | 4 | `role_title='Leasing Agent'`, `allowed_modules={leasing}`, `active=true` |
| `leasing_leads` | 1 | `status='tour_scheduled'` |
| `leasing_tours` | 1 | `status='completed'` |
| `leasing_conversions` | 3 | for Ava, Marcus, Priya |
| `leasing_conversion_obligations` | ~5 | rung links |
| `obligations` | ~5 | `module='leasing'`, types `tour_followup`, `applicant_followup`, `application_approval` |
| `leasing_conversation_handoffs` | ~4 | 3 origin + 1 handoff |
| `leasing_conversion_obligation_events` | ~6 | 069 ledger: created ×5, resolved ×1 |
| `events` | ≥1 | `obligation_completed`, plus any written by `spawnObligationFromEvent` (3 insert sites in the engine) |

**Scenario 4b, which I added this session, contributes `Drew Halloran`, its
person row, its user row, `Priya Raman`, and one conversion with its rung,
ledger and event rows.** That is my addition to the contamination and it should
be counted as such.

### 1.2 `tests/proofs/test_identity_bridge.db.js` — per run

| Table | Count | Values written |
|---|---|---|
| `properties` | 2 | `'Bridge Proof Property'`, `'Other Property (the wall)'` |
| `users` | 13 | 12 seeded + 1 `'Bot PM'`; emails `*@proof.internal` |
| `persons` | ~10 | `'Larry Lead'` (phone `+12155550101`), `'Katie P'`, plus staff persons created by `linkBridge(create_staff_person)` |
| `staff_sessions` | 4 | tokens `proof-*-token-*`, 6-hour expiry |
| `assignments` | ~6 | via `mkAsg` |
| `property_team_assignments` | 1 | `'Senior Maintenance Tech'` |
| `leasing_leads` | 2 | |
| `leasing_tours` | 1 | |
| `user_person_bridge_audit` | many | one per link/relink/unlink, plus `request_id` idempotency keys |
| `person_contexts` | ~8 | `context_type='staff'` |

### 1.3 `tests/proofs/test_release3.db.js` — per run

| Table | Count | Values written |
|---|---|---|
| `properties` | 2 | `'R3 Prop <ms>'`, `'R3 Prop2 <ms>'` |
| `users` | 3+ | emails `*<ms>@proof.internal` |
| `persons` | 3 | |
| `assignments` | 3 | |
| `staff_sessions` | 2 | |
| `property_team_assignments` | 2 | |
| plus conversions / obligations / events via the real services | | |

### 1.4 Distinguishability — the critical finding

**Conclusively distinguishable:**

- `test_identity_bridge` and `test_release3` **users** — `email like '%@proof.internal'`. A reserved-looking domain no real staff account would hold.
- `test_release3` **properties** — `name like 'R3 Prop%'`, carrying a millisecond timestamp.
- `test_identity_bridge` **staff_sessions** — `token like 'proof-%'`.

**NOT conclusively distinguishable — `test_conversion_rail.db.js` writes no
synthetic marker of any kind:**

1. **The property is named `'Solo on Chestnut'`.** That is the *same name* as the
   real Solo property. **Name alone can never establish that one of these rows is
   synthetic.** The real Solo property is
   `9e2bb96e-08e2-41db-81c2-91055ceb50a3` (which CLAUDE.md forbids writing to);
   any *other* row bearing that name is a candidate, but candidacy must be
   established by id and `created_at`, never by the name.
2. **The persons carry ordinary human names** — `Katie Leung`, `Warren Diaz`,
   `Ava Morgan` and the rest. No email, no marker, no source field. A real
   prospect could legitimately be named any of these. `Katie` in particular is
   also a real operating name in this system.
3. **The users row has no `email` column written at all**, so the
   `@proof.internal` discriminator that saves the other two harnesses does not
   exist here.
4. Every dependent row — conversions, obligations, rungs, ledger entries, events
   — is reachable **only** by graph traversal from the synthetic property id.

So the conversion-rail rows can be identified only by:

> `created_at` correlated against known harness run times, **plus** graph
> reachability from a property id that is not the real Solo property.

That is weaker evidence than a marker column, and it is why cleanup needs a
governed plan rather than a `delete ... where name = ...`.

Also worth noting: `'Larry Lead'` carries the phone `+12155550101` — a
plausible real number in a live area code. Fixtures should not use dialable
numbers.

**Read-only enumeration (safe, but not to be run until asked):**

```sql
-- marker-bearing rows (the easy two harnesses)
select id, name, email, created_at from users where email like '%@proof.internal' order by created_at;
select id, name, created_at from properties where name in
  ('Bridge Proof Property','Other Property (the wall)','Solo on Chestnut') or name like 'R3 Prop%'
  order by created_at;
-- the unmarked set: candidates only, by id and time — never by name alone
select id, name, created_at from persons
 where name in ('Katie Leung','Warren Diaz','Candace Riley','Olivia Grant','Drew Halloran',
                'Ava Morgan','Marcus Webb','Priya Raman','Larry Lead','Katie P')
 order by created_at;
```

**Nothing is to be deleted, updated, merged, or relabelled on the basis of this
manifest.**

---

## 2. Isolated proof database (next step, not done)

A separate Neon branch/database carrying the current schema and no real
operating consequences. The harness process points at it via an **explicit
per-shell override** — the Render service's own `DATABASE_URL` is never
modified. Do not create a synthetic property inside production as a substitute.

## 3. Reruns, once isolated

`test_release3.db.js`, `test_identity_bridge.db.js`, and the conversion rail if
its full pass has not been captured at the exact branch head. Every run must
print: branch and commit · database identity sufficient to show it is **not**
production · assertion-start marker · final assertion count · exit code.

`tests/_run_receipt.js` already prints branch, commit, and an assertion-start
marker; it prints `DATABASE set/unset` but **not an identity**, and it is wired
into the conversion rail only. Extending it is part of §4, not of this branch.

## 4. Permanent harness protection (small follow-on, NOT this branch)

Do not widen the obligation-engine branch with an infrastructure refactor. The
follow-on requires DB harnesses to:

- read `HARNESS_DATABASE_URL`, with **no fallback** to production `DATABASE_URL`;
- **fail** if the harness URL equals the production URL;
- print the target database before seeding;
- use unique per-run fixtures (already done: `362fcd7`, `99cc0d3`);
- roll back the run where the test shape permits;
- use a disposable database branch where cross-connection commits are necessary;
- refuse real messaging transports.

## 5. Production cleanup — governed, after inventory

A **dry-run** script keyed on explicit record IDs in dependency order, showing
exactly what would be removed and proving no real operating row is included.
Not executed without owner approval.

Dependency order matters: `leasing_conversion_obligation_events` references
`leasing_conversion_obligations` **`on delete restrict`** (migration `069`),
deliberately, so history cannot be erased by cascade. Cleanup must respect that
rather than route around it.

---

## Sequence

```
preserve the proven engine work
  → stop production test writes
  → inventory the contamination
  → establish an isolated QA database
  → finish the proof
  → clean production deliberately
```

---

# ⚠ THE CONVENTION HAS A HOLE — measured 2026-08-03

**The guard keys on a NAMING convention. Most database-touching scripts are
named outside it.**

## The measurement, and the two corrections it took

| | Count |
|---|---|
| `*.db.js` harnesses the guard covers | **8** |
| Guarded harnesses (use `harnessConnectionString()`) | 17 |
| Approved production-facing tools (allowlisted, each with a reason) | 5 |
| **Connect via `DATABASE_URL` with no guard** | **87** |
| — of those, **write-capable** | **67** |
| — of those, read-only | 20 |

The number moved twice before it settled, both times because the search was
**scoped rather than exhaustive**:

```text
 8  — "are the .db.js harnesses guarded?"        true, and incomplete
69  — "which tests/ scripts read DATABASE_URL?"  tools/ was never scanned
87  — walk BOTH roots, classify by behaviour
```

`tools/` is where the **repair and seed** scripts live — `retire_hollow_leases`,
`repair_invalid_task_owners`, `remove_duplicate_walkins`, `seed_*`. Missing that
directory understated exactly the most dangerous set.

> **A measurement you scoped by assumption is a measurement of your assumption.**

## What the finding is — and is not

**87 repository scripts are CAPABLE of writing to whichever database
`DATABASE_URL` names when run directly.** In a production Render shell that may
be the production database.

That is evidence of an unsafe **capability**. It is **not** evidence that every
script has executed against production, nor that every one has caused pollution.
Do not overstate it in either direction.

## Enforcement — `tests/gates/gate_harness_isolation.js`

A receipt-bearing gate classifies every script under `tests/` and `tools/` **by
behaviour, never by filename**:

```text
guarded harness · approved production tool · unguarded write-capable
unguarded read-only · dead or obsolete · no direct connection
```

It **fails** when:

1. a **new** unapproved direct `DATABASE_URL` consumer appears, or
2. a **frozen entry has been repaired** but not removed from the inventory.

Both failure modes were executed and confirmed to fire before this was committed;
the gate also passes at baseline (4/4). It does **not** claim the frozen
inventory is safe — it prevents growth and keeps the debt measurable.

`PRODUCTION_APPROVED` is a small explicit allowlist and **every entry states why**
that script may see production. New entries are an owner decision, not a
convenience.

## The rule this changes

> A script needs the guard because it **touches a database**, not because of what
> it is **called**. Audit by connection, across every root. `.db.js`, `_proof.js`,
> `smoke` and `test` are names, not evidence of safety.

## Operational containment, effective now

**Do not run any test, proof, seed or repair script directly from a production
Render shell** unless it is explicitly classified and approved as structurally
read-only.

- The structurally read-only production smoke remains the approved exception.
- Migration release remains governed separately (`MIGRATION_RELEASE` + ceiling).
- `slice_a_full_schema_suite.js` is **containment for the two scripts it runs**,
  not repair, and covers nothing else.

## Remediation — its own governed slice, AFTER Slice A

Sequencing ruling 2026-08-03: the full remediation does **not** jump ahead of
Slice A. Two exceptions are Slice A merge blockers because they sit in its
required proof set: `work_order_authority_proof.js` and
`work_order_canonical_path_proof.js`.

The remediation slice:

1. freeze the measured inventory at an exact SHA;
2. separate write-capable from read-only;
3. identify active / duplicated / obsolete / dead;
4. **delete dead proof infrastructure rather than modernising it**;
5. convert active scripts in bounded batches;
6. execute every converted script against an isolated database;
7. preserve direct-execution *and* orchestration receipts;
8. re-run this gate until no unapproved write-capable script reads `DATABASE_URL`.

**Do not mechanically replace `DATABASE_URL` with `HARNESS_DATABASE_URL` across
87 files.** Each has different schema assumptions, cleanup behaviour, transports
and fixture risk. A mass textual change would create 87 unexecuted safety claims —
which is the failure this repository has already recorded three times.

**Removal condition for this section:** closed when the gate reports zero
unguarded write-capable scripts.
