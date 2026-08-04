# Slice A — canonical communication-line model · PROOF RECEIPT

**Status: implemented and proven against isolated real PostgreSQL and real HTTP.**
**NOT merged. NOT deployed. NOT production-active.**

> Merge and deploy are blocked until migration 129 has been activated and
> receipted in production. This slice was built and proven on an isolated
> branch in the meantime, deliberately.

| | |
|---|---|
| Branch | `claude/sms-work-order-handoff-qo3s8i` |
| SHA that first earned 61/61 | `95f13c7` (against `main` @ `a792b9f`) |
| **Re-proven at** | **`2db937c`** — reconciled with `main` @ `8330aec`, 61/61, exit 0 |
| **Merge candidate** | the branch tip at merge time — **re-prove there, whatever it is** |
| Migration claimed | **130** — `130_communication_lines.sql` |
| Design | `docs/COMMUNICATION_LINE_MODEL_DESIGN.md` (approved, rulings 2026-08-03) |
| Database | PostgreSQL **16.13**, isolated scratch database, `HARNESS_DATABASE_URL` only |
| Harness | `tests/communication_lines_slice_a.db.js` |
| Result | **61 run · 61 passed · 0 failed** |
| Exit code | **0** |

> **Proof identity.** 61/61 was first earned at `95f13c7`. `main` then moved
> eight commits (PRs #33, #35, #36 — the last touching `src/identity/operator.js`),
> so that proof no longer described a merge candidate. It has since been
> reconciled twice more by MERGE — most recently at **`2db937c`** against `main`
> @ `8330aec`, which tightened the harness-isolation gate. **The suite was re-run
> there: 61/61, exit 0**, with `npm run verify` 8/8 and the full local regression
> set green.
>
> **This still is not the final receipt.** The five full-schema harnesses have
> never run against these changes, and the branch tip will move again before
> merge. Re-prove at whatever SHA actually merges — the exact artifact being
> advanced must be the artifact that earned the proof.

---

## 1. Migration number decision

**Claimed 130.** Verified before claiming, not assumed:

- repository ceiling on `origin/main`: **129**;
- maximum across **every** remote branch: **129**;
- `130` and `131` absent from every branch tree, including
  `origin/claude/slice-9-demand-evidence-mcxvav` (checked specifically — that
  thread stated it may take 130 for Slice 10B and has not);
- production applied ceiling: **128** (129 merged, unreleased).

**No collision.** If Slice 10B claims 130 before this merges, this branch
renumbers — the other thread's work is not to be renumbered or overwritten.

---

## 2. What is now structurally true

| # | Fact | Enforced by |
|---|---|---|
| 1 | A property-facing line belongs to one property and can never grant operational staff authority | `ck_cl_posture_coherent` |
| 2 | An operations line belongs to one organization and establishes organization context only | `ck_cl_posture_coherent` + `ck_cl_exactly_one_owner` |
| 3 | An organization-owned line never silently chooses a property | `resolvePropertyContextForStaff` — never reads the org's property list |
| 4 | Property context comes from an explicit work reference or a unique active assignment | same |
| 5 | Missing/ambiguous property context → smallest useful clarification, no property-scoped write | `clarificationFor` + the ops branch writes nothing |
| 6 | A property without an organization cannot receive an operations line | `ck_cl_posture_coherent` (operations requires `organization_id`) |
| 7 | One organization may hold only one active operations line | `uq_cl_one_active_ops_line_per_org` |
| 8 | Retired lines remain auditable but never resolve inbound traffic | partial indexes on `status='active'` + resolver predicate |
| 9 | Outbound is disabled by default and unused | `outbound_enabled default false` + `ck_cl_outbound_disabled_slice_a` |

Facts 1, 2, 6, 7 and 9 are refused **by the database**, not by application code —
asserted by matching on the constraint name in the error, not merely on failure.

---

## 3. ⚠ The false green this harness produced first, and the fix

**The first run passed 57/57 and was wrong.**

The inbound route acks the provider before awaiting anything and swallows
failures by design. So a query that *throws* looks identical to a clean refusal
from outside: zero rows written, HTTP 200. The scoped schema lacked `persons`,
`leases`, `tenant_invites` and `leasing_leads`, so the resident/lead lookup hit
`42P01` — and the assertion *"resolvable staff gains no authority"* went green
**because the query died**, not because the ceiling held.

That is the single most important assertion in the slice, and it was fake.

Two repairs, both kept:

1. **A sentinel.** Everything the boundary logs is captured, and any
   `42P01` / `does not exist` / `syntax error` anywhere in the run invalidates
   it — `RUN VALIDITY: no swallowed database error anywhere in the run`. It then
   caught two further gaps in sequence (`spaces`, then `leases.rent`).
2. **A corrected assertion.** `resolveInboundSmsContext` returns context and
   deliberately writes nothing for the resolved case — `runInbound` records the
   event once, downstream. The original assertion tested the wrong layer. It now
   asserts what actually makes the test hostile: the staff sender **fully
   resolves to a property and a person**, and the ceiling holds anyway.

Absence of red is not green — including when the absence is caused by the
harness itself.

---

## 4. The hostile tests

| Hostile case | Result |
|---|---|
| A **fully resolvable** staff sender texts a property-facing line | Resolves to property **and** person — proven, not assumed — and still gets `authority_ceiling='external'`, `grantsOperationalAuthority=false` |
| Staff with **multiple** property assignments texts the operations line | `many` · **no property selected** · zero rows written across the entire schema |
| A **single-property organization** | Resolves through the **same explicit path**, from the sender's own assignment |
| ...and adding an org property the sender is **not** assigned to | **Changes nothing** — proving resolution does not consult the organization's property list |
| A **retired line sharing a number** with an active one | Does not participate in resolution |
| A **second active operations line** for the organization | Refused by `uq_cl_one_active_ops_line_per_org` |
| A property with **no organization** | Cannot receive an operations line — no column can attach one |
| A **resident** texts the operations line | Zero rows written |
| A **divergent legacy write** to `properties.sms_number` | Refused, naming the canonical model |

The single-property case is the one that would have passed by luck and
misrouted the day a second property was added. It is proven by construction, not
by outcome.

---

## 5. Call-site ledger — all 25 sites classified

No site is unclassified. (24 at design time; the count moved to 25 as the
configuration route split into a canonical write plus a projection read.)

### Converted in Slice A — now use the canonical model

| Site | What changed |
|---|---|
| `communications_boundary.js` inbound resolution | `resolveInboundLine` — no longer reads `properties.sms_number` at all |
| `tenantlink.js:384` config write | Writes `communication_lines`; supersedes rather than mutates |
| `tenantlink.js` clash check | Reads `communication_lines`, not the projection |

### Served temporarily through the compatibility projection

Still read `properties.sms_number`, which is now a **read-only projection**
maintained by trigger from the canonical model.

| Site | Purpose |
|---|---|
| `communications_boundary.js:96-97` | outbound `propertyLine()` — see §6 |
| `communications_boundary.js:769` | property fetch after line resolution (display) |
| `communications_boundary.js:878, 903, 917` | property returned in context (display) |
| `tenantlink.js:253, 338` | tenant portal display |
| `tenantlink.js:439, 447` | config route response |

### Deferred to Slice B — display consumers

| Site | Purpose |
|---|---|
| `super_admin.js:140, 517` | admin property lists |
| `org_admin.js:72, 288` | organization property lists |
| `demo_preflight.js:89, 98, 99, 100` | preflight display |

### Deferred to the staff-OTP identity slice

| Site | Purpose |
|---|---|
| `teamaccess.js:98, 273` | staff OTP routing and send |
| `tenantlink.js:554, 570` | OTP availability check |

Per Ruling 3 this slice does not touch `teamaccess.js` or the migration-090
ordering issue. Replacement condition is recorded in the design §7.

### Dead

| Site | Status |
|---|---|
| `no076_failclosed_check.js:40` | Uninvoked manual check for migration 076. Its direct `properties.sms_number` insert is **now correctly refused** by the write guard. Removal deferred to Slice B cleanup; classified, not orphaned. |

---

## 6. Built-but-dormant — stated honestly (§33)

**`resolveOutboundLine` is implemented and proven at the unit level but is NOT
wired into the outbound path.** `communications_boundary.js:96` still reads the
projection to derive the outbound `from`.

That is deliberate — Slice A's scope is *inbound resolution and configuration
writes* — but it means outbound is **built-but-dormant**, not converted, and must
not be described as canonical. Wiring it belongs to Slice B or its own follow-up.

The existing `no_property_line` refusal discipline is preserved either way: with
no configured line the send refuses rather than falling back to a Messaging
Service default.

---

## 7. Safety

- `HARNESS_DATABASE_URL` only, no fallback; scratch database created and dropped.
- **Zero sends attempted** across the entire run — asserted, not intended. The
  SMS double never imports the Twilio client.
- Every configured number is in the reserved **`+1 555 01xx`** range — asserted
  by regex over every row in both `communication_lines` and `properties`.
- Every provider id is harness-minted (`HARNESSSID_` prefix) — asserted.
- Zero `DELETE` / `DROP` / `TRUNCATE` against anything outside the scratch
  database.

### Schema scope

Tables are built from the verbatim definitions in migrations 001, 027, 030, 038,
090 and 093 — the ones this code path touches — and migrations **129 and 130 are
then executed unmodified** against them. The full production schema is not built
because the migration chain cannot rebuild from an empty database
(`012_bank_intake.sql` fails on `yardi_code` — PR #33). Known, owned, outside
this slice.

What that costs: zero-write assertions are enforced as a **full row-count vector
over every table present**, which covers every table this path can reach. They
prove nothing about tables it never touches.

---

## 8. Regression — unchanged by this work

| Harness | Result | Exit |
|---|---|---|
| `migration_release_gate.test.js` | 11/11 | 0 |
| `migration_ledger_verdict.test.js` | 40/40 | 0 |
| `migration_ledger_inverse_gate.db.js` | 24/24 | 0 |
| `property_line_hardening.db.js` | 41/41 | 0 |
| `obligation_engine_one_implementation.test.js` | 14/14 | 0 |
| `obligation_engine_import_smoke.test.js` | pass | 0 |
| `gate_closure_boundary.js` | PASS | 0 |
| `gate_no_raw_bridge_joins.js` | PASS | 0 |

---

## 9. Stop conditions — none triggered

| Condition | Status |
|---|---|
| Current source contradicts the approved design | No |
| Migration number conflicts with another active branch | No — 130 free everywhere |
| Backfill requires an owner decision about production data | No — after 129 every value is canonical and unique; the backfill refuses rather than choosing if that is ever false |
| The compatibility projection cannot remain read-only | No — one-way trigger plus a guard that refuses divergent writes, both proven |
| The slice requires OTP, outbound, or technician behaviour to work | No |

---

## 10. What must happen before this merges

1. Migration **129** activated and receipted in production
   (`docs/PROPERTY_LINE_ACTIVATION.md`).
2. Re-verify **130** is still free across all branches immediately before merge.
3. Release **130** deliberately, after 129, with a fresh `EXPECTED_LEDGER_CEILING`.

Until then the honest statement is: **merged to no branch but this one, proven
locally, not production-active.**
