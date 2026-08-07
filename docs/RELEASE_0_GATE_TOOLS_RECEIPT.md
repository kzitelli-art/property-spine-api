# Release 0 — Gate 4 / 8 / 9 / 10 tools: built and falsified

**Date** 2026-08-07 · **Branch** `claude/release-0-audit-plan-55r5kd`

## Why these exist now

Gates 4, 8, 9 and 10 of the final transport build all require scripts run in the
Render shell. The rotation proof already demonstrated that anything over ~30
lines cannot be pasted there, and `/tmp` cannot resolve `pg`. These tools were
therefore built ahead of need, falsified on the isolated baseline (real schema,
ledger ceiling 136), and are ready to ride the same code-only deploy as the
signature-control tools. Nothing under `tools/` is reachable at runtime.

```text
NEW  tools/activation/technician_fixture_proof.js   Gate 4   read-only
NEW  tools/activation/evidence_ingress_proof.js     Gate 8+10 read-only
NEW  tools/activation/supersede_operations_line.js  Gate 9   WRITE by design
NEW  tools/activation/gate_tools_falsify.sh         23 controls, isolated only
MOD  tests/gate_harness_isolation.js                three register entries
```

## Design decisions that matter

**Identity is resolved by production code, not by a copy.** Gate 4 calls
`resolveStaffSenderForOrganization` and Gate 9 calls `resolveInboundLine` — the
same functions the routes run. A query written inside a tool can drift from the
one production runs; a required function cannot.

**The organization is derived, never typed.** Work order 1006 names its
property; the property names its organization; the operations line is found
from that. No UUID in these tools' arguments — after the corrupt-UUID transit
failure, hand-carried identifiers are treated as radioactive.

**Gate 8 is bound, not "the newest rows".** Same discipline as the rotation
proof: one T0 captured from database time, one tester, one line, `sms_sid`
required, and **exactly one** matching event — two matches is an ambiguous run
and refuses. Completion safety is asserted as absolute zeros, which `--before`
proves is also the baseline, so nothing is hand-carried between the two runs.

**Completion language is checked in the tool.** The handset message must
reference 1006 with no "done/complete/finished". V2 reads the actual stored
body, because the spec's requirement is about what production received, not
about what the tester was told to type.

**The phone number never appears.** It enters via `TEST_FROM`, goes to the
resolver, and is printed only as `****last4`. Receipt fields are booleans and
internal IDs.

## Findings — three schema truths the spec's wording missed

**1. `superseded` is not a status.** Gate 9's spec says "set operations-line
status to superseded". The schema says `status in ('active','suspended',
'retired')` — the spec's word **violates `ck_cl_status`**, and the first draft
of the rollback died on that constraint in falsification. Migration 130's own
design words: *"retired lines stay auditable but never resolve inbound
traffic."* The tool now writes `status='retired'` + `superseded_at=now()`
(the timestamp column does carry the spec's word). Had the rollback been
prepared as prose instead of run against a real schema, it would have failed
at the exact moment the rail needed to be disabled.

**2. Operations lines are organization-scoped, structurally.**
`communication_lines` enforces `property_id XOR organization_id`. The Gate 5
spec's required row ("property_id = work order 1006 property" *and* an
organization_id) is unsatisfiable; the live line's org-only shape is not a
deviation, it is the only legal shape.

**3. Phone ambiguity between users is impossible; a shared resident phone is
not.** `uq_users_phone_normalized` refuses a second user with the same
normalized phone — the falsifier discovered this when its "two active users"
negative control could not be seeded. The reachable identity failures are a
deactivated tester (resolver returns `none`) and a `persons` row sharing the
phone; both are controls now. The conflict check also uses `persons` — the
table's real name; the first draft wrote `people` and died honestly.

## The rollback's shape (Gate 9)

One row, named by `LINE_ID`, `--execute` gated on `CONFIRM_SUPERSEDE=yes`.
Inside one transaction: lock, verify it is the active operations line, census
every *other* line, update, call the production resolver — commit **only** if
the resolver stopped returning the row and no other line changed.
`--dry-run` executes the identical transaction and always rolls back: that is
how the command gets tested against production before it is ever needed, which
is what the Gate 5 spec demanded and what was never done for the live line.

## Proof

```text
tools/activation/gate_tools_falsify.sh    23 / 23   exit 0   two identical clean runs
npm run verify (7 source-governance gates)          PASS     exit 0
```

Negative controls that were **observed to refuse**: deactivated tester ·
resident sharing the phone · `--post` with no assignment · SQL-only assignment
with no governed event (the two-half-actions failure class) · completion
language in the message · attachment `referenced` instead of `stored` · a
`completed` progress event appearing · two bound events in one window ·
`--execute` without confirmation · supersession of the property-facing line ·
a second supersession with nothing active.

## What still requires the owner

The tools must reach the deployed checkout (the pending "deploy the tools"
decision — this branch's `tools/activation/` now carries seven files, all
runtime-inert). Then, in order: Gate 2/3 binding → Gate 4 `--pre` → governed
assignment in the Work Orders door → Gate 4 `--post` → Gate 7 controls →
Gate 9 `--dry-run` (the rollback test, while nothing is broken) → Gate 8
`--before` → one real handset photo → Gate 8 `--verify` → Gate 10 receipt.
