# Release 0 production audit — receipt

**Authorized under charter Open Ruling 4 against commit
`c0d995966cc24f52a20416f84c97a1244e92828a`. Executed. Facts only.**

No classification of the unresolved populations appears here, and no product
ruling is inferred from the data. The four open rulings remain open.

---

## 1. Authorization

```text
plan commit authorized    c0d995966cc24f52a20416f84c97a1244e92828a
scope                     one run of tools/ledger_reconcile.js; if and only if
                          it exits 0, one run of
                          tools/release0_proof_audit.js --json; completion of
                          this receipt from those exact outputs
integrity at run time     plan, query set and both tools unchanged since
                          c0d9959 — verified by diff before execution
```

Digests of the authorized instruments:

```text
1f556f98b645fc0c078e1fd42dff717f64fdc754503bf023fc736a717d836c9b  tools/ledger_reconcile.js
539a0685eb98bcac493964f7ca858835843929ee239aa2869dcba361b26b437d  tools/release0_proof_audit.js
```

## 2. Run identity

```text
executed in               Render web shell, instance mgbnb,
                          /opt/render/project/src
database                  neondb
executing user            neondb_owner
read-only proof           "a write was attempted and refused before any read"
API branch                claude/release-0-audit-plan-55r5kd
authorized commit         c0d9959
output digest             8298d75cc0c337877203fd7e67403e2dd9ad145f7ac5f7211c0c580d4981ea29
                          (sha256 of /tmp/release0_audit.json)
```

### 2.1 Deviations from the plan, recorded rather than smoothed over

Three, none of which affects the findings, all recorded because a receipt that
only lists what went to plan is not a receipt.

1. **The connection was `neondb_owner`, not a `SELECT`-only role.** The plan
   recommends a read-only role. The mutation barrier held regardless: the tool
   opens `BEGIN TRANSACTION READ ONLY` and proves a write is refused before
   reading, which does not depend on the role's privileges. The plan
   anticipated exactly this — "the probe does not depend on that being
   configured correctly."
2. **Two earlier attempts failed before reaching production, and one reached
   production with the wrong copy of a tool.** Detail in §6.
3. **The `sha256sum -c` verification output for the successful run was not
   preserved.** The instruments were fetched from
   `raw.githubusercontent.com` at `c0d9959` and the check was in the command
   block, but its `OK` lines were not captured in the record. The audit's own
   behaviour is consistent with the authorized copy — it emitted `proof.state`
   groupings and the withheld-conclusions list, which only the `c0d9959`
   version produces. **This is a gap in the evidence chain, not a defect in
   the result**, and it is recorded as a gap.

## 3. Query A — full ledger reconciliation

```text
command       node tools/ledger_reconcile.js
exit code     0
```

```text
ledger rows                                135
applied ceiling                            136
repository ceiling                         136

repository files missing from the ledger     0
ledger rows missing from the repository      0
genuine version/name conflicts               0
duplicate migration numbers in repo          0
documented legacy naming exceptions          1
documented ledger-only exceptions            0

documented legacy naming exception:
  012   ledger 'property_noi_goals'  vs file '012_bank_intake.sql'
        accepted because: ledger row never corrected after property_noi_goals
        was renumbered to 029; bank_intake verified applied
        removed when: the 012 ledger row is corrected to 'bank_intake'

✓ RECONCILED — every ledger row has its file, and every file is accounted
  for. Both directions agree across the WHOLE ledger.
```

**The ledger below version 109 is reconciled.** That was carried as an open
Release 0 blocker: the boot gate evaluates the entire ledger, and an orphan row
anywhere would make the Release 0 deploy refuse to start inside the deployment
window. It reconciles in both directions with one documented exception, which
is the known `012` case.

## 4. Queries B–E — verbatim

```text
B1  []
B2  [{"flipping_work_orders":0}]
B3  []
C0  [{"status":"closed","n":1},{"status":"needs_followup","n":1},
     {"status":"open","n":3},{"status":"scheduled","n":1}]
C1  [{"status":"closed","has_completed_progress_row":false,"n":1}]
C2  [{"completed_progress_rows":0,"earliest":null,"latest":null}]
C3  [{"work_order_id":"fa8acda9-7852-47b6-ac2b-4e50fe414d21",
      "property_id":"971c51ab-be96-4e5f-81df-0e59804c879b",
      "status":"closed","has_column_photo":true,
      "created_at":"2026-06-07T17:36:14.533Z",
      "updated_at":"2026-06-07T17:40:18.698Z"}]
C4  [{"cross_property_progress_rows":0}]
C5  [{"status":"closed","has_column_photo":true,"has_column_note":true,"n":1}]
D1a [{"conname":"fk_wop_work_scope",
      "definition":"FOREIGN KEY (work_order_id, property_id) REFERENCES work_orders(id, property_id) ON DELETE CASCADE"},
     {"conname":"fk_wopa_work_scope",
      "definition":"FOREIGN KEY (work_order_id, property_id) REFERENCES work_orders(id, property_id) ON DELETE CASCADE"},
     {"conname":"work_order_progress_property_id_fkey", …},
     {"conname":"work_order_progress_reported_by_user_id_fkey", …},
     {"conname":"work_order_progress_source_comm_event_id_fkey", …},
     {"conname":"work_order_proof_attachments_property_id_fkey", …},
     {"conname":"work_order_proof_attachments_source_comm_event_id_fkey", …},
     {"conname":"work_order_proof_attachments_uploaded_by_user_id_fkey", …}]
D1b [{"indexname":"uq_work_orders_id_property",
      "indexdef":"CREATE UNIQUE INDEX uq_work_orders_id_property ON public.work_orders USING btree (id, property_id)"}]
E1  [{"status":"closed","ruling_1_evaluable":"no_completion_timestamp","n":1}]
```

## 5. The facts, stated plainly

### 5.1 Population

```text
work orders in production, all statuses          6
  open                                           3
  scheduled                                      1
  needs_followup                                 1
  closed                                         1
  complete                                       0   ← the status value the
                                                       canonical reader tests
finished work (complete + closed)                1
```

### 5.2 Proof evidence

```text
rows in work_order_proof_attachments             0
  stored                                         0
  referenced                                     0
  fetch_failed                                   0
  not_preserved                                  0
work orders satisfying proof only via
  an unclassified attachment  (B2)               0
```

**The blast radius of removing `unclassified` from
`PROOF_REQUIRED_CLASSIFICATIONS` is zero rows.** There are no proof
attachments in production of any classification or storage state, so no
existing work order changes its rendered proof result.

### 5.3 Completion timestamps

```text
work_order_progress rows with kind='completed'   0
earliest / latest completion                     null / null
```

The canonical completion writer (`technician/lifecycle_service.js:192`) has
never written a row in this database.

### 5.4 The single finished work order

```text
work_order_id     fa8acda9-7852-47b6-ac2b-4e50fe414d21
property_id       971c51ab-be96-4e5f-81df-0e59804c879b
status            closed
completion_photo  present
completion_note   present
completed progress row   none
created_at        2026-06-07T17:36:14.533Z
updated_at        2026-06-07T17:40:18.698Z
```

It carries column-stored evidence, no attachment row, and no completion
timestamp.

### 5.5 Schema

```text
fk_wop_work_scope           present, composite (work_order_id, property_id)
fk_wopa_work_scope          present, composite (work_order_id, property_id)
uq_work_orders_id_property  present, unique btree (id, property_id)
cross-property progress rows                     0
```

Migration 134 applied as written. The composite scoping Release 0's evaluation
table would follow is present and enforced.

## 6. Attempt history — what preceded the successful run

Recorded so the successful run is not mistaken for the only one.

```text
1  Agent container.       Blocked before production. No credential present,
                          and TCP 5432 egress is blocked (DNS resolves, raw
                          TCP 443 connects, 5432 times out). Nothing attempted
                          against production.

2  Render web shell.      No production read. The DATABASE_URL placeholder was
                          pasted literally; pg parsed "<production>" as host
                          "base" → getaddrinfo ENOTFOUND base, exit 2. The
                          audit then ran despite that non-zero exit, because
                          the "ONLY IF" line in the supplied instructions was a
                          shell COMMENT rather than a guard. It failed
                          MODULE_NOT_FOUND — release0_proof_audit.js does not
                          exist on main, which is what Render deploys.

3  Render web shell.      Ledger reconciliation reached production and exited
                          0, but ran main's PRE-authorization copy of
                          ledger_reconcile.js, identified by its output
                          ordering. Its reconciliation logic is byte-identical
                          to c0d9959's — only the connect guard, the identity
                          query position and console messages differ — so the
                          finding is sound, but its provenance did not match
                          the authorization.

4  Render web shell.      git route dead: the Render checkout has NO remotes
                          (git remote -v empty; fetch and checkout both exit
                          128). Instruments fetched instead from
                          raw.githubusercontent.com at c0d9959.

5  Render web shell.      THE AUTHORIZED RUN. Both instruments the c0d9959
                          copies. Ledger exit 0, audit exit 0. §3–§5 above.
```

The ordering gate was subsequently enforced by an actual shell conditional on
the captured exit code rather than by a comment.

## 7. Conclusions withheld — verbatim from the tool

§19 reserves these to the owner. They are reproduced exactly as emitted:

```text
· What a work order with no completion timestamp emits under the proof-state
  contract. Ruling 1's predicate reads completed_at; without one, neither
  branch applies and none of the four published states describes the row.

· Whether a status='closed' work order is completed work for Release 0's
  purposes. lifecycleStateOf tests status='complete' only, so these never
  reach the classification. See RELEASE_0_COMPLETION_WRITER_MATRIX.md §3.

· Whether Open Ruling 2's four proof states cover column-stored photo proof.

· Any value for the Release 0 activation boundary. It is CAPTURED at the
  writer's verified-live instant under Ruling 1 and is never derived from
  production data, including anything in this audit.
```

## 8. What this run does not establish

- It does not set, imply, or inform the Release 0 activation boundary.
- It does not establish that Open Ruling 2's four proof states cover the real
  data.
- It authorizes no write, migration, backfill, deploy, or product change, and
  does not authorize building the Release 0 proof-state writer.
- **The four rulings remain open**: what proof state applies when no completion
  timestamp exists; whether `status='closed'` represents completed work; how
  column-stored proof enters the canonical proof model; and whether the
  closeout route is retired, redirected, or made canonical.

## 9. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This receipt | 1 — permanent record | Never removed. It is the production evidence Release 0's design is decided against. |
