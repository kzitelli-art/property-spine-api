# SLICE 9 — SESSION HANDOFF

**Written:** 2026-08-02 · **API head at handoff:** `296bd2f239ecac13401c06f3aa74a507e6984ce9`
**Branch:** `claude/slice-9-demand-evidence` · tree clean, in sync with origin

> **Read this, then the consultant's "COMPLETE READ-SIDE CLOSURE" brief.**
> This document is what the brief assumes you already know. It does not replace it.

---

## 0. FIRST ACTIONS — do these before reading anything else

```bash
git fetch origin
git rev-parse HEAD origin/main
git rev-list --count origin/main..HEAD   # ahead
git rev-list --count HEAD..origin/main   # behind
git status --short
```

**Do not trust `296bd2f` or any ahead/behind number in this document as current.**
`origin/main` moved **twice** during the last session. The first time, a
50-commit-stale local `main` produced a confidently wrong collision analysis that
had to be retracted. Rebase before editing if behind.

**Verify repository layout before searching it.** `property-spine-app` is a
**flat repo with no `src/`**. A search against `property-spine-app/src` returns a
clean zero for every term — a false zero that nearly retired a live route last
session. Search the repo root.

Environments: Postgres often dies mid-session. `rm -f /var/lib/postgresql/*/main/postmaster.pid; pg_ctlcluster 16 main start`.
Proof DB used last session: `postgresql://spine:spine@127.0.0.1:5432/spine_merge`
(clone of `spine_s4` + migrations 120/122/123/124/126).

---

## 1. WHAT IS DONE (all committed and pushed)

| SHA | What |
|---|---|
| `6464c79` | isolated lifecycle authority boundary defects closed |
| `0c3db76` | non-null exact executed-lease pointer + two-connection contention proof |
| `ffdc929` | **Path A** — both application-birth doors cut to the authority |
| `aad8b0a` | **Paths B–E** — authority is the ONLY `lease_applications.status` writer |
| `fc23869` | send-window harness repair (async timezone regression I caused) |
| `45e2db4` | async timezone contract audit tool |
| `11ab91d` | status-read audit (20 production reads classified) |
| `fa8c7bb` | **read-side Pass 1** — canonical read authority + historical defects closed |
| `8fd2bbd` | **Pass 1.1** — terminal SQL raised to the row classifier's standard |
| `0d0733b` | **Pass 2 audit** — unit-commitment authority (documentation only) |
| `c3c4c2c` | **Pass 2A** — no availability state may outrank its lease's proof |
| `296bd2f` | **Pass 2A commit 1** — frozen commitment contract + consumer census |

Archive branch (do not delete until Slice 9 merges):
`archive/slice-9-pre-main-sync-fc23869`

---

## 2. THE GOVERNING FACTS — verified against source and live schema

### Application progression holds NO inventory

`position_classifier.js` never reads `lease_applications` at all. Approval,
`lease_ready` and `accepted_term_required` create no space reservation.

### The commitment chain

```
approve            no reservation
lease_ready        no reservation
admission          status only
confirm-term       tenancy_anchor_service.js:281  → leases @ 'pending', space_id NOT NULL   ← FIRST COMMITMENT
                                                     also first marketing suppression
locked             position_classifier.js:172     executed_verified && move_in_funds_cleared
activate tenancy   economic_tenancy_service.js:342 → leases @ 'active'
release            lease_void_service.js:106       → leases @ 'cancelled'
```

**The application goes `active` one governed step BEFORE the lease does.**
An application reading `active` does not imply current economic tenancy.

**A lease is only created after a verified executed record exists**, so
`executed_verified` is already true at birth. Pending vs locked differs by
**funding alone**. Imported leases (`activation.js:402`) insert directly at
`active` and never pass through pending.

**"Absence of a charge set is NOT funded"** (`space_position.js:149`). Fail-closed
and deliberate. Do not "fix" it into a default-true when leases look unlocked.

### The application segment is durably UNIT-GRAINED — schema-verified

```
application_invitations   property_id, unit_id      NO space_id
lease_applications        property_id, unit_id      NO space_id
BIRTH_FIELDS allowlist                              NO space_id
```

`createSubmittedApplication` does not silently drop an unknown `space_id` — it
**refuses the whole birth** with `birth_payload_unknown_field`. The Path A closed
allowlist is what makes this visible rather than silent.

`executed_lease_records` and `leases` DO carry `space_id`. The gap is confined to
**invitation → submission → birth**. That is the parked bridge, not a wholesale
absence of space grain.

---

## 3. WHAT IS LEFT — the consultant's brief covers all of it

Commits A–I: application-target authority · entry-path cutover · submission
revalidation · leaseable-units + app · retire legacy availability · deterministic
fixtures · turn priority · packet eligibility · close the status-read audit.

### Answers already established — do not re-derive

**Stop condition 6 will NOT trigger.** `leasepackets.js` writes `lease_packets`
only, no lease. First commitment is five steps later. Packet creation and
inventory commitment are already separated in source.

**Commit E's log question: logs are UNAVAILABLE.** Standing constraint against
production credentials in this environment. Record honestly — "retirement rests
on the repository census" — do not imply a check happened.

**Bare `GET /availability` has zero repository consumers.** The app requests only
`/operator/leasing/availability-canonical` and `/operator/leasing/leaseable-units`.
Verified by extracting every availability-shaped path literal, not a substring
grep. The MODULE still has two internal callers — `operator.js:3202`
(`unitOfferableState`) and `operator.js:3674` (leaseable-units). **Order is
forced: cut those over before deleting anything.**

**Zero consumers anywhere for** `commitment_tier`, `projected_ready_date`,
`date_confidence`, `tourable_in_person`.

**`applicant_demand` is safe to delete** from the legacy module — the app's only
reference is `demand_tier_key === 'applicant_demand'`, a different field on a
different surface.

**Commit G is the most likely real stop.** Turn priority is unit-grained;
commitment is space-grained. If a unit-level workflow needs to know *which*
space's successor drove priority, that link may not exist — stop condition 5.
Check early, before writing the cutover.

**Do not inherit my turn_priority classification.** Pass 2 audit §5 listed it as
"legacy active reading applications at `:57`" — accurate as inventory, but I never
established what business question it asks. Commit G starts with that audit.

---

## 4. RED BASELINES — pre-existing, NOT Slice 9

| Suite | Result | Cause |
|---|---|---|
| `availability_canonical_proof` | 38 passed / 4 failed | hardcodes Demo Building, seeds nothing; proof DB has that property with **zero spaces** |
| `cross_surface_invariants` | 47 passed / 1 failed | same empty-population cause |
| `resident_sms_route_proof` | 23 passed / 8 failed | **outside Slice 9** — main's own tree fails identically |

The first two are Commit F's job. All three verified against the archive branch on
the same database. **Never describe the repository as green because Slice 9's
suites are green.**

Harness invocation gotchas that look like failures:
- `leasing_stage_tabs_api.test.js` needs an **absolute** path arg → `node tests/… "$(pwd)/src/leasing"`
- `test_conversion_rail.db.js` needs `HARNESS_DATABASE_URL`, not `DATABASE_URL`
- `slice9_lifecycle_authority_proof.js` needs `UNDER_125=1` against a 125 DB

---

## 5. FIXTURE TRAPS THAT COST TIME LAST SESSION

- `leasing_conversions` has a **one-active-per-person/property** unique index — every scenario needs its own person.
- `lease_applications.conversion_id` has a real FK — a bare uuid is not a stand-in.
- Migration 124's compat trigger authors milestones on the crossing, so a **milestone-less progressed row cannot be created by INSERT** — reproduce pre-124 shapes by clearing afterwards.
- `ck_la_terminal_pair` forbids a half-pair, so "code with no instant" is **unreachable** — prove the DB refuses it instead.
- `executed_lease_records` has 13 NOT NULL columns; `record_state` is `'voided'` not `'void'`.

---

## 6. STANDING CONSTRAINTS

No production credentials or DB connections. No fixture-fallback, demo sessions,
or sample data in signed-in operator workflows. Server-derived property scope
only. Never push while a required harness is red. **Never print a fixed success
total — read every exit code, report actual passed and failed counts.** Use
explicit paths when staging; never `git add -A`.

Do not modify files owned by other threads: `tenantlink.js`, `work_order_service.js`,
`obligation_transitions.js`, `agent.js`, `server.js` (beyond the mount removal in
Commit E). Migration 121 is unmerged on `claude/getting-up-to-speed-nyf4ww`.

**No migration. No PR. No merge. No deployment. Do not move 125. Do not start
Slice 10 or the renderer.**

---

## 7. IF ANY DEPLOYMENT IS EVER DISCUSSED

API first, then app immediately. Never app-first: the app would show an exact
space choice and send identity the server cannot honor. A brief `409` window is
safer than a silent wrong write.

> **A space choice cannot be offered unless the complete durable chain can preserve it.**
