# Release 0 production audit — receipt

**Fill this in from a real run. Do not pre-fill any field.**
An empty field is an honest blank; a plausible-looking guess is the failure
mode this whole release exists to remove.

Authorization: [`../RELEASE_0_AUDIT_PLAN.md`](../RELEASE_0_AUDIT_PLAN.md),
under charter Open Ruling 4.

---

## 1. Authorization

```text
plan commit approved      <SHA of RELEASE_0_AUDIT_PLAN.md at approval>
approved by               <owner>
approved at               <timestamp, with timezone>
```

**If the plan was edited after that SHA, this run is not authorized.** Approval
attaches to a commit, not to a filename.

## 2. Run identity

```text
run at                    <timestamp, with timezone>
operator                  <who ran it>
API main SHA at run time  <git rev-parse origin/main>
tool                      tools/release0_proof_audit.js
tool SHA                  <git rev-parse HEAD -- for the tool's commit>
database                  <current_database() as reported by the tool>
connection user           <current_user as reported by the tool>
connection role is SELECT-only?   <yes / no — and if no, say why>
```

## 3. Read-only proof

```text
write probe result        <verbatim line from the tool>
```

Expected verbatim: `a write was attempted and refused before any read`.

**Anything else means the run is void.** The tool exits 2 rather than
producing findings, so a receipt with findings and a failed probe is
impossible unless it was hand-edited.

## 4. Query A — full ledger reconciliation

Run **first**, separately, and stop here if it is non-zero.

```text
command                   DATABASE_URL="…" node tools/ledger_reconcile.js
exit code                 <0 = reconciled>
orphan ledger rows        <count, and the versions>
repository files pending  <count>
duplicate numbers         <count>
documented exceptions     <count>
```

Release 0's migration cannot be numbered until this exits 0. The gate
evaluates the **entire** ledger, and the ledger below version 109 has never
been reconciled — see `MIGRATION_LEDGER_INVERSE_GATE.md` §6.

## 5. Findings

Paste the tool's `--json` output verbatim, and record its digest so the
receipt can be checked against a re-run:

```text
output sha256             <sha256sum of the --json output>
```

<details>
<summary>Raw findings</summary>

```json
<paste here>
```

</details>

### 5.1 The numbers that decide the release

| | Value | Meaning |
|---|---|---|
| B2 `flipping_work_orders` | | Work orders that lose proof when `unclassified` stops counting. Sizes the deployment window and the rollback decision. |
| C1 `complete` / no timestamp | | Ruling 1's predicate cannot evaluate these. |
| C1 `closed` / any | | The second completion lane. Does not reach the classification at all. |
| C4 `cross_property_progress_rows` | | Expected `0`. Non-zero means the composite FK is not doing what the schema says. |
| C5 rows with `has_column_photo` | | The third proof model — evidence the attachment reader cannot see. |

## 6. Conclusions withheld

Copy the tool's `withheld_conclusions` verbatim. **Do not summarise them and
do not resolve any of them here.** They are rulings, and §19 reserves rulings
to the owner.

```text
<paste>
```

## 7. What this run does not establish

- It does not set, imply, or inform the Release 0 activation boundary. That
  instant is **captured** when the proof-evaluation writer is verified live
  and persisted unchanged (Ruling 1). Nothing in this receipt is an input to
  it.
- It does not establish that Open Ruling 2's four proof states cover the real
  data. If §5.1's gap rows are non-zero, they demonstrably do not.
- It does not authorize any write, migration, backfill, or deploy.

## 8. Next action

```text
<one line: what the owner is being asked to decide, and what is blocked
 until they do>
```
