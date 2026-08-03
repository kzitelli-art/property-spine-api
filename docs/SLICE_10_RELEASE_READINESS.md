# Slice 10 — Release readiness

**`SLICE 10 RELEASE READY — BLOCKED ON DEPLOYMENT GATES`**

Source, browser and documentation are closed. Every remaining blocker is
external to this lane: a migration release, a manual security verification, or
a production credential this environment does not have.

The full evidence is in [`SLICE_10_RECEIPT.md`](SLICE_10_RECEIPT.md). This file
is the release sheet only.

---

## Identities

| | |
|---|---|
| API branch | `claude/slice-10e-browser-acceptance-t0zk33` |
| API `main` | `4983e5d` (PRs #33, #35 — documentation only, no migrations, no source) |
| API ahead / behind `main` | **ahead, behind 0** — `origin/main` merged in, and is an ancestor |
| App branch | `claude/slice-10e-browser-acceptance-t0zk33` @ `c1684d3` |
| App `main` | `357fb15` — an ancestor; **behind 0** |
| Documentation corrections | `claude/slice-10a-forward-rent-roll-audit` @ `8709ed1` · `claude/slice-10-handoff` @ `1f422f6` |
| Migrations changed by this work | **none** — `git diff --name-only origin/main...HEAD -- migrations/` is empty |
| Deployed API / app SHAs | **NOT READ — see gate 3** |

## Proof totals, all re-run at closure

```
server    90 / 36 / 58 / 62      0 failed   real Postgres
browser   96 / 0                            real HTTP · desktop 1180px · 390px
app       18 harnesses · 779 / 0            no regression
publish   19 globals measured · 19 stubbed · 0 divergent
states     7 of 7 currently reachable evidence/result states rendered
          17 of 17 position states rendered
reserved  EVIDENCE_STATE.untrackable · EVIDENCE_STATE.unavailable
          RESULT_STATE.UNAVAILABLE — declared, defensively consumed, not producible
```

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
| 4 | PR #36 guards proven live | owner, after 5 | leasing entitlement + strict `as_of`, proven locally 62/0; never against production |
| 5 | Render app suspension verified in a private window | owner | manual |
| 6 | Both repositories private | owner | manual |
| 7 | Public forks checked | owner | manual |
| 8 | Allowlisted artifact is the only deployed artifact | owner | requires the §7 reactivation gate |

**Do not** revert PR #36. **Do not** merge Slice 10 into a known non-booting
release path to call the source landed. **Do not** reactivate the app before
gates 5–8.

## Release order, once the gates clear

```
 1  release migration 129 through its own lane
 2  prove API main boots
 3  integrate the Slice 10 API PR onto current main
 4  rerun API, HTTP, scale and regression proofs
 5  merge and deploy the API
 6  prove PR #36 entitlement and date guards in production
 7  prove Forward Rent Roll against an authenticated real property
 8  integrate the app PR onto current app main
 9  rerun publish-boundary and browser proofs
10  merge and deploy ONLY the allowlisted artifact
11  run production desktop and 390px acceptance
12  record exact deployed API and app SHAs
```

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
