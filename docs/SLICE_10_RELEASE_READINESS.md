# Slice 10 — Release readiness

**`SLICE 10 SOURCE RELEASE CANDIDATE — PRODUCTION GATES REMAIN`**

Source, browser and documentation are closed **against current `main`**. Every
remaining blocker is external to this lane: a migration release, a manual
security verification, or a production credential this environment does not
have.

The full evidence is in [`SLICE_10_RECEIPT.md`](SLICE_10_RECEIPT.md). This file
is the release sheet only.

---

## ⚠ An earlier version of this sheet said every blocker was external. It was wrong.

`main` moved to `fbd7a3a` after Slice 10 froze, and that commit added a second
direction to `tests/gate_harness_isolation.js`: requiring
`HARNESS_DATABASE_URL` is no longer enough, a harness must **refuse** a value
that resolves to the same host, port and database as `DATABASE_URL`.

Four Slice 10 harnesses failed it. `deploy.sh` runs the gate under `set -e`, so
this blocked a **deploy**, not merely a merge — and because the gate runs first
and the runner stops at the first failure, the other two gates were not running
at all.

```
slice-10e alone                verify  6 assertions · 6 passed · EXIT 0
main (fbd7a3a)                 verify  8 assertions · 8 passed · EXIT 0
slice-10e + main, BEFORE fix   verify  8 run · 7 passed · 1 FAILED · EXIT 1
slice-10e + main, AFTER fix    verify  8 run · 8 passed · 0 failed · EXIT 0
                                       3 of 3 gates invoked, all exited 0
```

**Repaired in-lane, not exempted.** All four now take their connection from
`receipt.harnessConnectionString()`. Three had compared the two URLs as
*strings* — which a different user, a trailing `sslmode`, or an extra query
parameter defeats while still resolving to the same database.
`slice10d_scale_transport_proof` only checked the variable was present, and
`slice10d_build_fixture` — which commits roughly 110,000 spaces, the most
write-capable script in the set — had no guard at all.

The gate classifies a file as guarded by **grepping for the identifier**, so a
decorative mention would have satisfied it while proving nothing. Checked by
execution instead: with the two variables spelled differently but resolving to
the same target, all four refuse and run no assertions; all four also refuse
with the variable unset.

*Known and out of lane:* `sameTarget()` compares hostnames literally, so
`localhost` and `127.0.0.1` are not recognised as the same host. It never
claimed otherwise — it is documented as host + port + database — and changing
it belongs to the harness-remediation slice, not here.

---

## Identities

| | |
|---|---|
| API branch | `claude/slice-10e-browser-acceptance-t0zk33` |
| API `main` | **`fbd7a3a`** — was `4983e5d` when this sheet was first written |
| API ahead / behind `main` | **behind 0** — `fbd7a3a` merged in, and is an ancestor |
| App branch | `claude/slice-10e-browser-acceptance-t0zk33` @ `c1684d3` |
| App `main` | `357fb15` — an ancestor; **behind 0**. The app side never drifted. |
| Documentation branches | resolved — see *Orphan branch disposition* below |
| Migrations changed by this work | **none** — `git diff --name-only origin/main...HEAD -- migrations/` is empty |
| Deployed API / app SHAs | **NOT READ — see gate 3** |

## Proof totals — re-run at the INTEGRATED candidate, not carried forward

Every number below was produced by a run against the tree that contains
`fbd7a3a` and the harness repair. The earlier run at `4584991` is evidence for
`4584991` and was not reused.

```
server    90 / 36 / 58 / 62      0 failed   real Postgres, isolated harness DB
app       18 harnesses · 779 / 0            no regression
publish   19 globals measured · 19 stubbed · 0 divergent
verify    3 of 3 gates invoked · all exited 0
browser   IN PROGRESS at this candidate — see the note below
```

Scale re-measured rather than restated: **400 pages at limit 25 (831,288 ms)
and 50 pages at limit 200 (107,154 ms)**, all 10,000 positions returned exactly
once in an identical order both times, against a neighbouring property carrying
100,000. Query count **18 at 10,000 and 18 at 100,000** — flat, not per-row.
Payload **18 KB summary · 96 KB default page · 325 KB maximum page · 2,229 B
largest row**.

**A counting correction worth recording.** The first attempt to total the app
suite reported **219**, because ten of eighteen harnesses use summary formats
the counter did not parse and were silently counted as zero. The suite was
never wrong; the measurement was. A harness whose total cannot be parsed now
fails the counter instead of contributing zero — `0 pass 0 fail exit 0` is
exactly what a vacuous measurement looks like.

### ⚠ A stale artifact nearly became a false green

The browser acceptance writes to a scratch directory that is **not cleaned
between sessions**. After the server proofs finished, that directory still held
`acceptance.out` reading `96 passed, 0 failed`, plus an `api.log` saying the API
was listening. All three files were **sixteen hours old**, from the run at
`4584991`, and nothing distinguished them from a fresh result except their
timestamp.

They survived because the guard meant to chain the browser run behind the scale
proof was written as `while pgrep -f slice10d_scale_transport; do sleep; done`
— and `pgrep -f` matched **the very shell running it**. The loop waited on
itself, the browser run never started, and the previous run's output sat there
looking exactly like this run's output.

Two rules this is worth stating for: **check the timestamp before believing a
proof artifact**, and **delete the previous artifact before re-running rather
than trusting it to be overwritten**. A proof file is evidence only if
something in this run wrote it.

## Frozen contracts

```
forward_rent_roll_rows_v1       src/tenancy/dated_position_rows.js
forward_rent_roll_summary_v1    src/tenancy/forward_rent_roll_summary.js
frr_cur_v1                      src/tenancy/forward_rent_roll_page.js
pagination                      default 50 · max 200 (clamped WITH disclosure)
                                order unit_number asc, space_id asc
                                stateless HMAC cursor bound to property, date,
                                ordering and BOTH contract versions
                                consistency: best_effort_live, NOT a snapshot —
                                unit_number is mutable and the response says so
```

## Consumer inventory

```
src/identity/operator.js                     9  the route
tests/hotfix_future_rent_roll_guards_proof  21
tests/slice10d_scale_transport_proof        17
tests/slice10b_dated_position_rows_proof    11
tests/slice10c_summary_authority_proof       5
tests/cross_surface_invariants.js            2  asserts body.property_id
app  index.html                              2  psLiveFutureRentRoll + manifest
app  rent_roll_cutover_app.test.js           1
```

The deprecated compatibility block (`property_id`, `as_of`, `totals`, `rows`) is
retained because `cross_surface_invariants.js` and the app renderer read it
today. It is computed from `complete_stats`, before the page is sliced, so it
describes the whole property and not the page.

## Publish artifact

```
included   index.html + 14 door scripts, by ALLOWLIST
stubbed    property-spine-data.js · policy.js  (empty globals, Class 4)
excluded   every other repository-root file
refuses    any copied file that DECLARES one of the 19 incident globals
refuses    rails present with zero globals extracted (broken measurement)
```

## Release gates — all external to this lane

| # | Gate | Owner | Status |
|---|---|---|---|
| 1 | Migration 129 released | SMS lane | **BLOCKED.** `129_property_line_uniqueness.sql` is on `main`, claimed, unreleased. Slice 10 adds no migration and cannot clear this. |
| 2 | API `main` boots after 129 | SMS lane | blocked by 1 — the runner refuses to start on a file not in the ledger |
| 3 | Deployed API and app identities recorded | owner | **UNRESOLVED PRODUCTION-VERIFICATION GATE.** No production credential and no route to the production origin exist here. Not inferred from repository history. |
| 4 | PR #36 guards proven live | owner, after 5 | **PR #36 is MERGED** (2026-08-03) and its source is on `main` — landing is done. What is outstanding is *production proof*: leasing entitlement + strict `as_of`, re-proven locally 62/0 at this candidate, never against production. |
| 5 | Render app suspension verified in a private window | owner | manual |
| 6 | Both repositories private | owner | manual |
| 7 | Public forks checked | owner | manual |
| 8 | Allowlisted artifact is the only deployed artifact | owner | requires the §7 reactivation gate |

**Do not** revert PR #36. **Do not** merge Slice 10 into a known non-booting
release path to call the source landed. **Do not** reactivate the app before
gates 5–8.

## Orphan branch disposition

Three branches carried Slice 10 work outside PR #37 with no PR of their own.
Reviewed against current facts rather than merged because they existed.

```
LANDED    docs/SLICE_10_SOURCE_AUDIT.md          from claude/slice-10a-…
          the pre-build authority audit and its two correction passes,
          including "obligations.lease_id does not exist". Durable
          reasoning record for why Slice 10 was built the way it was.
          Not superseded by the receipt — the receipt records what was
          built, this records why it was blocked.

LANDED    docs/AGENT_READINESS_AUDIT_BRIEF.md    from claude/slice-10-handoff
          owner-authored charter, preserved as issued. Its three output
          documents were already in this branch WITHOUT it; an audit's
          output without its charter cannot be reviewed.

ABANDONED docs/SLICE_10_HANDOFF.md               from claude/slice-10-handoff
          §5 states 10E browser acceptance "has not been run" and is "the
          entire remaining scope". It HAS been run — 96/0. Landing it
          would put a false claim into docs/. Superseded by
          SLICE_10_RECEIPT.md and this sheet.

ABANDONED its THREAD_HANDOFF.md diff (+16)       from claude/slice-10-handoff
          corrected main from a08c1da to 47ed0f0; main is now fbd7a3a, so
          the correction was two moves stale before it could land. The
          OBSERVATION inside it was revalidated and still holds — Slice 10
          and the Forward Rent Roll are absent from main's handoff
          entirely, Slice 9 and the app repo get one mention each — and is
          landed rewritten, citing documents rather than SHAs.

SUPERSEDED claude/slice-10b-dated-position-rows
          its head d1279de is already inside this branch. Redundant.
          Remove when branch cleanup is authorized.
```

## Release order, once the gates clear

```
 1  release migration 129 through its own lane
 2  prove API main boots
 3  merge PR #38 (write-authority hardening) FIRST — it is already based on
    current main and green, so merging it second would invalidate a Slice 10
    proof run the moment it landed
 4  integrate the resulting main into the Slice 10 branch
 4a REPAIR any harness the isolation gate refuses at that point, then rerun
    npm run verify and CONFIRM ALL THREE GATES RAN — the failing gate is
    first in the list and stops the others from executing at all
 5  rerun API, HTTP, scale and regression proofs AT THAT SHA
 6  merge and deploy the API
 7  prove PR #36 entitlement and date guards in production
 8  prove Forward Rent Roll against an authenticated real property
 9  integrate the app PR onto current app main
10  rerun publish-boundary and browser proofs
11  merge and deploy ONLY the allowlisted artifact
12  run production desktop and 390px acceptance
13  record exact deployed API and app SHAs
```

**Steps 3–5 are the lesson this candidate paid for.** A proof run is evidence
for the tree it ran against and nothing else. Do not carry a green from one
candidate onto another because the merge was textually clean — the merge that
broke this branch changed no Slice 10 file at all.

## Remaining blockers, in one list

```
EXTERNAL   migration 129 release · main boot · deployed SHAs · PR #36 live proof
           Render suspension · repo privacy · fork check · artifact gate
PRODUCT    3 reserved contract states have no producer — a decision about when
           lineage counts as unresolvable, not a rendering change
OTHER LANE 012_bank_intake vs 001_baseline (vendors.yardi_code) — recorded in
           DB_CONNECTION_INVENTORY.md Appendix H by the baseline lane, not
           repaired here, and it touches no table Slice 10 reads
OTHER LANE INCIDENT_STATIC_DATA_EXPOSURE.md §3b says eighteen globals; there are
           nineteen — handed over in the app repo's
           docs/SECURITY_LANE_NOTE_GLOBAL_COUNT.md, not edited here
```

**No Slice 10 source or browser defect is open.**
