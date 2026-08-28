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
MOD  tests/gates/gate_harness_isolation.js                three register entries
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

---

## Addendum — consultant-authorized completion build (same day)

**Gate 8 hardened to the full refusal matrix.** One-axis mismatch controls
(wrong tester, wrong line, outbound, missing provider SID), an attachment
landing on another work order, a completion claim, the proof-evaluation table
existing, and the status leaving `open` — every one observed to refuse. The
five corrupt-stored-row cases (missing sha256 / content / byte_size /
stored_at, unsupported MIME) were proven with the database constraints
**dropped in the isolated harness**, so the tool's refusals are its own and
not the schema's; the constraints were restored from saved definitions and
their restoration is itself asserted. Outbound replies are now reported
honestly: provider acceptance is recorded, handset delivery is **not claimed**
without a delivery receipt, and none of it can fail the run.

**Gate 10 receipt generator built: `release0_final_receipt.js`.** Every named
fact is checked by name — no green-count verdicts. Database facts are
re-derived live with the Gate 8 bindings; non-database facts (PR/merge SHAs,
deploy event, control results, rollback drill) enter via `--input` and every
missing key refuses. The deployment digests must agree three ways: authorized
constant, input claim, and the bytes of the checkout the tool runs in.
The unsigned and wrong-URL controls are explicitly **NOT CREDITED** when the
signed positive control is absent — the refusal names the reason.

**Falsification: 52/52, two identical clean runs.** Fifteen of those are
receipt refusals, including: deployed SHA removed · positive control omitted ·
unsigned-only · rollback drill absent · binding window absent · assignment
event deleted from the database under a perfect input · status flipped to
complete · completion event injected.

---

## Correction — Gate 4's collision check tested the wrong thing

Gate 4 `--pre` failed against the real production fixture on `T3`. The cause was
not the fixture: `T3` asked *"does any `persons` row share this phone"*, which
is not the question the production inbound resolvers ask. It failed on a dormant
`boardroom_demo` record that `communications_boundary.js` can never resolve —
that path requires an active lease with a used invite, or an open leasing lead,
and the record has neither. Measured: 67 foreign keys point at `persons(id)`,
zero rows reference it, and `users.person_id` (a declared FK, migration 067) is
not among them.

**The model was corrected, not the data.** `T3` now tests whether a *competing
operating identity* exists — replicating both production reachability tiers
verbatim in their essentials, retired rows excluded, deliberately not
property-scoped because a person reachable at any property is a real identity on
that property's line. Dormant same-phone rows are **reported on every run** as a
hygiene item rather than blocking or being hidden.

A person-retirement writer was built and **deliberately not shipped**. Writing
production identity data to turn a checker green inverts the order of trust, and
an unused identity writer in the deployed checkout is the same class of latent
hazard as the row it would remove. The record is logged as **H-1** in
`docs/IDENTITY_HYGIENE_REGISTER.md` for a governed cleanup slice.

**Falsification: 58/58, two identical clean runs.** Seven new Gate 4 controls pin
both ends of the distinction — dormant passes, open lead refuses, closed lead
passes again, lease-without-invite passes, lease-plus-used-invite refuses.

One of those controls was itself a fake at first. The resident-path seed chained
`psql … || psql …`; `spaces` requires a `unit_id` and `units` was empty, so both
arms inserted nothing and the chain reported success. `G4-3e` then passed while
describing a lease that did not exist, and only `G4-3f`'s failure exposed it.
`G4-3e0` now asserts the seed actually landed before the controls that depend on
it run — a seed that silently does nothing turns every control built on it into
decoration.
