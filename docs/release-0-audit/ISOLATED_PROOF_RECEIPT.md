# Release 0 audit — isolated proof receipt

**This is NOT a production audit.** No production connection was opened and no
production query was run. This receipt records that the audit *instrument* was
built and proven against an isolated local Postgres, so that when the owner
authorizes the real run under Open Ruling 4, the tool being authorized is one
whose behaviour is already known.

```text
proved on         PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
                  — the same version MIGRATION_LEDGER_INVERSE_GATE.md §5 was proved on
cluster           local, unix-socket + loopback only, created for this run
database          release0_audit_test  (isolated, synthetic fixtures only)
API main SHA      ec9887732748e482deab21d76080a0d5f8c347c2
```

---

## 1. The schema this was proved against

`tests/fixtures/release0_audit_schema.sql` — a **faithful subset**, and the
word matters.

The full migration chain is not replayable from an empty database: `012` fails
with `column "yardi_code" does not exist`, which is the same legacy `012`
naming problem `MIGRATION_LEDGER_INVERSE_GATE.md` §4 documents. So the two
tables the audit actually reads are copied **verbatim** out of
`migrations/134_technician_lifecycle.sql` — every check constraint, default,
composite foreign key and index — rather than hand-written to be convenient.

That is what makes query D1 a real test. It found the real
`fk_wop_work_scope`, `fk_wopa_work_scope` and `uq_work_orders_id_property`,
because those are the production definitions, not a replica of them.

`work_orders` carries the baseline columns the audit reads. **It deliberately
has no `completed_at` column, because production has none** — reproducing the
absence is the point.

## 2. The populations

`tests/fixtures/release0_audit_populations.sql` — 13 work orders across **two**
properties, with fixed UUIDs so output is diffable.

| Case | Shape | Must |
|---|---|---|
| 1 | stored `unclassified` only | **flip** |
| 2 | stored `repair_photo` | not flip |
| 3 | stored `unclassified` **and** `repair_photo` | not flip |
| 4 | `unclassified` but `referenced`, never stored | not flip — never had proof |
| 5 | stored `unclassified` + stored `access_attempt` | **flip** — `access_attempt` does not satisfy proof |
| 6 | stored `condition` (+ a `fetch_failed` row) | not flip |
| 7 | `complete`, **no** `completed` progress row, but a `completion_claimed` row | appear as no-timestamp |
| 8, 9 | `closed` with column photo | appear as the second lane |
| 10, 11 | `open`, `needs_followup` | never appear in finished-work queries |
| 12, 13 | property B, flipping / no-timestamp | prove property scoping and ordering |

Case 7 is the deliberate trap: a `completion_claimed` row is **not** a
completion. Had the `kind = 'completed'` filter been dropped, work order 7
would have silently gained a completion timestamp it does not have.

## 3. Results — every case landed as designed

```text
B2 flipping_work_orders   3      → exactly work orders 1, 5 and 12
C0 status census          closed 2 · complete 9 · needs_followup 1 · open 1
                                 → surfaced `needs_followup` and `closed`, neither
                                   of which appears in 001_baseline's column comment
C1 complete / true        7
   complete / false       2      → work orders 7 and 13; the claim row did NOT count
   closed  / false        2      → the second lane, never summed with the first
C4 cross_property         0      → the composite FK holds
C5 closed + column photo  2      → the third proof model, counted by presence only
```

Full text output: [`isolated_run.txt`](isolated_run.txt).

## 4. Falsification — the guards were made to fail on purpose

A guard that has never fired is a guard nobody has tested.

### 4.1 Read-only guard — REMOVED the read-only transaction

```text
change   await client.query("begin transaction read only")
      →  await client.query("begin")                        (one line, diffed)

result   ✗ REFUSED — this transaction accepted a write.
         A read-only tool that can write is not read-only.
         Nothing was read.
exit     2
```

The probe is not decorative: with a writable transaction it detects the write
and refuses **before reading anything**.

### 4.2 Savepoint — REMOVED the savepoint wrapper

```text
change   deleted `savepoint write_probe` and `rollback to savepoint write_probe`

result   ✗ current transaction is aborted, commands ignored until end of
           transaction block
exit     1
```

This reproduces the documented incident exactly. Without the savepoint the
failed probe aborts its own transaction and every read after it dies. It fails
loudly rather than reporting a clean empty run — but only because the savepoint
is what makes the probe survivable in the first place.

### 4.3 Forbidden-field test — INJECTED a violation

```text
change   C0's  select status, count(*)  →  select status, completion_note, count(*)

result   ✗ work_orders.completion_note contents never selected
         23 passed · 1 failed
exit     1
```

One failure, and the right one. The **presence** check on the same column still
passed, which is the distinction §5 turns on: `completion_photo is not null` is
permitted, `completion_photo` is not.

### 4.4 A genuinely SELECT-only role

```text
role     release0_auditor — SELECT only, TEMPORARY revoked on the database
audit    exit 0, findings produced
control  psql … -c "delete from work_orders"
         ERROR:  permission denied for table work_orders
```

The tool runs against the safest connection available, and that connection was
proven unable to write by an independent command.

### 4.5 Every exit path, exercised

The first pass shipped exit codes that had been *written* but never *run* —
asserting behaviour without demonstrating it, which is the failure this whole
release is about. All four refusal causes are now exercised:

```text
DATABASE_URL unset      ✗ DATABASE_URL is not set. Refusing to guess a connection.
                        exit 2

database unreachable    ✗ Could not connect to the database. Nothing was read.
                          connect ECONNREFUSED 127.0.0.1:5999
                        exit 2

required table absent   ✗ B1: a required table does not exist in this database.
(run against an empty     relation "work_order_proof_attachments" does not exist
 database)                This is a finding, not a crash — but it is not an audit.
                        exit 2

transaction can write   ✗ REFUSED — this transaction accepted a write.
(§4.1)                  exit 2
```

**Running them found a real defect.** `client.connect()` sat outside the try
block, so an unreachable database produced an unhandled promise rejection and a
Node stack trace instead of a refusal. It "exited 1", so a table of exit codes
would have looked correct while the operator could not tell *the audit failed*
from *the audit crashed*. A stack trace is not an answer. The connect is now
guarded and refuses in the tool's own voice.

Regression after the fix: the happy-path text output is byte-identical to
`isolated_run.txt`, the `--json` digest is unchanged, 24 forbidden-field
assertions pass, 7 source-governance gates pass.

## 5. Determinism

```text
two consecutive --json runs, byte-identical
sha256   b73aada89c035a965e4d72b2f0cf9ce2607c1aa5676dc1e011daf9be0ca4d508
bytes    9568
```

A receipt can therefore be diffed against a re-run instead of eyeballed.

## 6. What this receipt does NOT establish

- **Nothing about production.** Every number above is synthetic. The
  production populations are unknown and remain unknown until Open Ruling 4 is
  granted.
- Query A (full ledger reconciliation) was **not** run. It requires a
  production connection and is delegated to `tools/ledger_reconcile.js`.
- No claim about the activation boundary, the proof-state contract's
  completeness, or what the gap populations should emit. Those are rulings.

## 7. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| `tools/release0_proof_audit.js` | 3 — temporary instrument | Removed when Release 0 ships and its production receipt is preserved. |
| `tests/fixtures/release0_audit_*.sql` | 3 — temporary | Removed with the tool. |
| `tests/release0_audit_forbidden_fields.test.js` | 3 — temporary | Removed with the tool it guards. |
| This receipt | 1 — permanent record | Never removed. It is the evidence the instrument was proven before it was pointed at production. |

---

## Appendix — full isolated run

```text
════════════════════════════════════════════════════════════════
  RELEASE 0 PROOF AUDIT — read-only
  database   release0_audit_test  (user release0_auditor)
  read-only  a write was attempted and refused before any read
════════════════════════════════════════════════════════════════

── B1  Proof attachments by storage state and classification
   authority: plan §4 B1 · charter §16 acceptance 1
   storage_state  proof_classification  n
   fetch_failed   unclassified          1
   referenced     unclassified          1
   stored         access_attempt        1
   stored         condition             1
   stored         repair_photo          2
   stored         unclassified          4

── B2  Work orders whose proof is satisfied ONLY by an unclassified attachment
   authority: plan §4 B2 · THE NUMBER THAT SIZES THE RELEASE
   flipping_work_orders
   3                   

── B3  Identifiers of the flipping work orders
   authority: plan §4 B3 · identifiers only
   work_order_id                         property_id                         
   11111111-0000-0000-0000-000000000001  aaaaaaaa-0000-0000-0000-000000000001
   55555555-0000-0000-0000-000000000005  aaaaaaaa-0000-0000-0000-000000000001
   12121212-0000-0000-0000-000000000012  bbbbbbbb-0000-0000-0000-000000000002

── C0  Status census — run before anything filters on status
   authority: plan §4 C0 · charter §6 (a filter may not define the question)
   status          n
   closed          2
   complete        9
   needs_followup  1
   open            1

── C1  Ruling 1 gap: finished work by lane and completion-timestamp presence
   authority: plan §4 C1 · §19 Ruling 1 predicate
   status    has_completed_progress_row  n
   closed    false                       2
   complete  false                       2
   complete  true                        7

── C2  Recorded completion-time range (NOT an activation-boundary input)
   authority: plan §3.3 · the boundary is CAPTURED at the writer's verified-live instant
   completed_progress_rows  earliest                                                        latest                                                        
   7                        2026-02-01T10:00:00.000Z                                        2026-02-12T10:00:00.000Z                                      

── C3  Identifiers with no completion timestamp — Ruling 1 cannot evaluate these
   authority: plan §4 C3 · identifiers and presence booleans only
   work_order_id                         property_id                           status    has_column_photo  created_at                                                      updated_at                                                    
   88888888-0000-0000-0000-000000000008  aaaaaaaa-0000-0000-0000-000000000001  closed    true              2026-01-08T00:00:00.000Z                                        2026-01-08T00:00:00.000Z                                      
   99999999-0000-0000-0000-000000000009  aaaaaaaa-0000-0000-0000-000000000001  closed    true              2026-01-09T00:00:00.000Z                                        2026-01-09T00:00:00.000Z                                      
   77777777-0000-0000-0000-000000000007  aaaaaaaa-0000-0000-0000-000000000001  complete  false             2026-01-07T00:00:00.000Z                                        2026-01-07T00:00:00.000Z                                      
   13131313-0000-0000-0000-000000000013  bbbbbbbb-0000-0000-0000-000000000002  complete  false             2026-01-13T00:00:00.000Z                                        2026-01-13T00:00:00.000Z                                      

── C4  Cross-property scoping check (expected zero)
   authority: plan §4 C4 · §21 property is the scope of every read
   cross_property_progress_rows
   0                           

── C5  The third proof model: evidence stored in columns, counted by presence
   authority: plan §4 C5 · presence permitted, contents forbidden (§5)
   status    has_column_photo  has_column_note  n
   closed    true              false            1
   closed    true              true             1
   complete  false             false            9

── D1a  Composite foreign keys on the progress and attachment tables
   authority: plan §4 D1 · confirms migration 134 applied as written
   conname                                                 definition                                                                                        
   fk_wop_work_scope                                       FOREIGN KEY (work_order_id, property_id) REFERENCES work_orders(id, property_id) ON DELETE CASCADE
   fk_wopa_work_scope                                      FOREIGN KEY (work_order_id, property_id) REFERENCES work_orders(id, property_id) ON DELETE CASCADE
   work_order_progress_property_id_fkey                    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE                             
   work_order_progress_reported_by_user_id_fkey            FOREIGN KEY (reported_by_user_id) REFERENCES users(id)                                            
   work_order_progress_source_comm_event_id_fkey           FOREIGN KEY (source_comm_event_id) REFERENCES comm_events(id)                                     
   work_order_proof_attachments_property_id_fkey           FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE                             
   work_order_proof_attachments_source_comm_event_id_fkey  FOREIGN KEY (source_comm_event_id) REFERENCES comm_events(id)                                     
   work_order_proof_attachments_uploaded_by_user_id_fkey   FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)                                            

── D1b  The uniquely-constrained (id, property_id) the composite FKs reference
   authority: plan §4 D1
   indexname                   indexdef                                                                                          
   uq_work_orders_id_property  CREATE UNIQUE INDEX uq_work_orders_id_property ON public.work_orders USING btree (id, property_id)

── E1  Finished-work population by lane and Ruling 1 evaluability
   authority: plan §4 E1 · NO classification claim is made for either gap population
   status    ruling_1_evaluable        n
   closed    no_completion_timestamp   2
   complete  has_completion_timestamp  7
   complete  no_completion_timestamp   2

── CONCLUSIONS WITHHELD (§19 reserves these to the owner)
   · What a work order with no completion timestamp emits under the proof-state contract. Ruling 1's predicate reads completed_at; without one, neither branch applies and none of the four published states describes the row.
   · Whether a status='closed' work order is completed work for Release 0's purposes. lifecycleStateOf tests status='complete' only, so these never reach the classification. See RELEASE_0_COMPLETION_WRITER_MATRIX.md §3.
   · Whether Open Ruling 2's four proof states cover column-stored photo proof.
   · Any value for the Release 0 activation boundary. It is CAPTURED at the writer's verified-live instant under Ruling 1 and is never derived from production data, including anything in this audit.

── QUERY A (full ledger reconciliation) IS NOT RUN BY THIS TOOL
   Run tools/ledger_reconcile.js separately. It shares classifyLedger
   with migrate.js, so it cannot disagree with what a deploy decides.
```

## Appendix — forbidden-field test

```text

══ Release 0 audit — forbidden field enforcement ══

  queries under test: 12

  ✓ comm_events.body contents never selected
  ✓ work_order_progress.note contents never selected
  ✓ work_orders.description contents never selected
  ✓ work_orders.title contents never selected
  ✓ work_orders.completion_note contents never selected
  ✓ work_orders.completion_photo contents never selected
  ✓ users.name contents never selected
  ✓ persons.name contents never selected
  ✓ persons.phone contents never selected
  ✓ persons.email contents never selected
  ✓ work_order_proof_attachments.provider_media_url contents never selected
  ✓ work_order_proof_attachments.content contents never selected
  ✓ completion_photo IS still checked for presence (C5 not silently dropped)
  ✓ completion_note IS still checked for presence
  ✓ no query uses SELECT * (a wildcard would defeat every check above)
  ✓ persons is never read
  ✓ conversations is never read
  ✓ staff_threads is never read
  ✓ every query names the plan section that authorizes it
  ✓ every multi-row query carries an ORDER BY (receipts stay diffable)
  ✓ every singleRow declaration is honest (no top-level GROUP BY)
  ✓ the tool source contains no write verb outside the write probe
  ✓ the tool ships its withheld-conclusions list
  ✓ the activation boundary is named as a withheld conclusion

  24 passed · 0 failed

```
